import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 退役字段三态：active / retired / custom。
 *
 * 修的是这条错误行为：catalog 删掉的旧官方字段被重新解释成 `isCustom: true`，
 * 也就是说成「用户自己建的字段」。两者在数据上完全同形（都是 catalog 认不出
 * 的名字），只有 catalog 显式声明 `retired_fields` 才分得开——所以判据必须是
 * 显式声明，而不是「catalog 里找不到」。
 */

let CATALOG: any[] = [];

vi.mock('../../../src/main/features/role_templates', () => ({
  listRoleTemplates: () => JSON.parse(JSON.stringify(CATALOG)),
  getRoleTemplate: (id: string) => {
    const found = CATALOG.find((t) => t.template_id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  },
  listScenarios: () => [],
  getScenario: () => undefined,
}));
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-retired';

/** v1：专业 + 年级 都是官方字段。 */
function catalogV1() {
  return [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{
      id: 'background',
      title: '学习背景',
      fields: [
        { id: 'major', name: '专业' },
        { id: 'grade', name: '年级' },
      ],
    }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
}

/** v2：年级 退役（明确声明），专业 仍在役。 */
function catalogV2Retire() {
  const c = catalogV1();
  c[0].version = '2.0.0';
  c[0].preset_groups[0].fields = [{ id: 'major', name: '专业' }];
  (c[0].preset_groups[0] as any).retired_fields = [
    { id: 'grade', previous_names: ['年级'], retired_in: '2.0.0' },
  ];
  return c;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-retired-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = catalogV1();
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const loadFiles = () => import('../../../src/main/features/personal_ontology_template_files');
const loadContract = () => import('../../../src/main/features/personal_ontology_contract');

/** 装 v1，给 专业 和 年级 各填一条值，再建一个用户自定义字段。 */
async function installWithData() {
  const t = await loadFiles();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
  const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
  const ref = t.buildContentRef(groupId, '学习背景');
  expect((await t.appendExistingTemplateFieldValueToRef(UID, ref, '专业', '软件工程', '手动')).ok).toBe(true);
  expect((await t.appendExistingTemplateFieldValueToRef(UID, ref, '年级', '大三', '手动')).ok).toBe(true);
  expect((await t.appendFlowEntryToRef(UID, ref, '我的私有备注')).ok).toBe(true);
  expect((await t.promoteEntryToRef(UID, ref, '我的私有备注', '私有备注')).ok).toBe(true);
  return { t, groupId, ref };
}

describe('retired vs custom › 三态判定', () => {
  it('官方退役字段判为 retired，不是 custom', async () => {
    await installWithData();
    CATALOG = catalogV2Retire();
    const contract = await loadContract();

    expect(contract.roleTemplateFieldStatus('probe', '学习背景', '专业')).toBe('active');
    expect(contract.roleTemplateFieldStatus('probe', '学习背景', '年级')).toBe('retired');
    expect(contract.roleTemplateFieldStatus('probe', '学习背景', '私有备注')).toBe('custom');
  });

  it('没有 retired 声明时不猜：认不出的名字一律是 custom', async () => {
    await installWithData();
    // v2 只是把「年级」删掉，没有声明 retired_fields
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields = [{ id: 'major', name: '专业' }];

    const contract = await loadContract();
    // 只凭「catalog 里找不到」不能判成官方历史字段
    expect(contract.roleTemplateFieldStatus('probe', '学习背景', '年级')).toBe('custom');
  });

  it('退役字段用历史名解析（可以有多个历史名）', async () => {
    CATALOG = catalogV2Retire();
    CATALOG[0].preset_groups[0].retired_fields = [
      { id: 'grade', previous_names: ['年级', '年级/学年'], retired_in: '2.0.0' },
    ];
    const contract = await loadContract();
    for (const name of ['年级', '年级/学年']) {
      expect(contract.roleTemplateFieldStatus('probe', '学习背景', name), name).toBe('retired');
    }
  });

  it('未知模板 / 认不出的分节 → custom（拿不到官方依据就不许说是官方字段）', async () => {
    CATALOG = catalogV2Retire();
    const contract = await loadContract();
    expect(contract.roleTemplateFieldStatus('nope', '学习背景', '年级')).toBe('custom');
    expect(contract.roleTemplateFieldStatus('probe', '不存在的分节', '年级')).toBe('custom');
  });
});

describe('retired vs custom › 数据与可写性', () => {
  it('退役不删值：旧值仍在文件里、仍读得到', async () => {
    const { t, ref } = await installWithData();
    CATALOG = catalogV2Retire();

    const text = t.readTemplateFileText(UID, 'probe');
    expect(text).toContain('大三');

    const fields = await t.listFieldsByRef(UID, ref);
    const grade = fields.fields!.find((f) => f.name === '年级')!;
    expect(grade.values.map((v: any) => v.value)).toEqual(['大三']);
    expect(grade.status).toBe('retired');
  });

  it('退役字段不进可写落点，也签不出 fieldRef', async () => {
    await installWithData();
    CATALOG = catalogV2Retire();
    const contract = await loadContract();

    const targets = await contract.listRoleTemplateFieldTargets(UID);
    expect(targets.map((x) => x.label)).toContain('探针角色 · 学习背景 · 专业');
    expect(targets.map((x) => x.label)).not.toContain('探针角色 · 学习背景 · 年级');
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '年级')).toBeNull();
  });

  it('自动写入通道拒绝写退役字段', async () => {
    await installWithData();
    const contract = await loadContract();
    // 先在 v1 拿到一个合法句柄，再把 catalog 升到 v2 让它退役
    const ref = (await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '年级'))!;
    expect(ref).toBeTruthy();
    CATALOG = catalogV2Retire();

    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '大四', '智能');
    // 退役与「认不出」分开报：退役字段的值仍然可读，只是不再是可写落点，
    // 说成「不是模板声明的字段」等于把官方历史沉淀说成一次脏数据。
    expect(res).toMatchObject({ ok: false, error: 'field is retired and no longer writable' });
  });

  it('runtime 角色画像行为不变：退役字段的旧值继续注入', async () => {
    await installWithData();
    CATALOG = catalogV2Retire();
    const contract = await loadContract();
    const profile = await contract.getRoleProfileForRuntime(UID, ['probe']);
    // 保持当前行为（遍历文件、不过 T-box 门）——本轮不改产品语义
    expect(profile).toContain('大三');
    expect(profile).toContain('软件工程');
  });

  it('用户自建字段仍然是真 custom，没有被误标成 retired', async () => {
    const { t, ref } = await installWithData();
    CATALOG = catalogV2Retire();
    const fields = await t.listFieldsByRef(UID, ref);
    const own = fields.fields!.find((f) => f.name === '私有备注')!;
    expect(own.status).toBe('custom');
    expect(own.values.map((v: any) => v.value)).toEqual(['我的私有备注']);
  });

  it('listTemplateStatus 把三态一起带给渲染层', async () => {
    await installWithData();
    CATALOG = catalogV2Retire();
    const t = await loadFiles();
    const status = (await t.listTemplateStatus(UID)).find((s) => s.template_id === 'probe')!;
    const byName = Object.fromEntries(status.sections![0].fields.map((f) => [f.name, f.status]));
    expect(byName).toEqual({ 专业: 'active', 年级: 'retired', 私有备注: 'custom' });
  });
});

describe('retired vs custom › catalog 自检', () => {
  it('退役字段 id 不得复用在役 id，历史名不得与在役名撞车', async () => {
    const { validateRoleTemplateCatalog } = await vi.importActual<any>(
      '../../../src/main/features/role_templates',
    );

    const reuseId = [{
      template_id: 'x', name: 'x', description: '', version: '1.0.0',
      preset_groups: [{
        id: 's', title: 'S',
        fields: [{ id: 'dup', name: 'A' }],
        retired_fields: [{ id: 'dup', previous_names: ['B'] }],
      }],
    }];
    expect(validateRoleTemplateCatalog(reuseId).map((i: any) => i.kind)).toContain('duplicate_field_id');

    const clash = [{
      template_id: 'x', name: 'x', description: '', version: '1.0.0',
      preset_groups: [{
        id: 's', title: 'S',
        fields: [{ id: 'active', name: 'A' }],
        retired_fields: [{ id: 'old', previous_names: ['A'] }],
      }],
    }];
    expect(validateRoleTemplateCatalog(clash).map((i: any) => i.kind)).toContain('ambiguous_previous_name');

    const noNames = [{
      template_id: 'x', name: 'x', description: '', version: '1.0.0',
      preset_groups: [{
        id: 's', title: 'S',
        fields: [{ id: 'active', name: 'A' }],
        retired_fields: [{ id: 'old', previous_names: [] }],
      }],
    }];
    expect(validateRoleTemplateCatalog(noNames).map((i: any) => i.kind)).toContain('retired_field_without_names');
  });
});
