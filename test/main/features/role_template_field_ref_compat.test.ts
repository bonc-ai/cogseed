import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 持久化 fieldRef 的「写兼容」。
 *
 * profileTarget.fieldRef 是用户配一次、之后长期存在技能绑定里的落点句柄，里面
 * 记的是签发那一刻的分节名与字段名。schema 迁移做过 rename / move 之后，这条
 * 绑定必须仍然命中**同一个 stable identity**，值落到新名字上；否则一条配好的
 * 规则会静默写不进去，而且报的还是「这字段不是模板声明的」这种不会自愈的错。
 *
 * 与 role_template_ref_compat.test.ts（ts token 的读兼容）刻意分开：那边是历史
 * 分节引用的读路径，这边是持久化落点的写路径，风险层级不同，断言不混。
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
const UID = 'test-user-field-ref-compat';

/** v1：学习背景[专业, 年级] + 基本信息[研究方向]。 */
function catalogV1() {
  return [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [
      {
        id: 'background',
        title: '学习背景',
        fields: [{ id: 'major', name: '专业' }, { id: 'grade', name: '年级' }],
      },
      { id: 'basic', title: '基本信息', fields: [{ id: 'research_direction', name: '研究方向' }] },
    ],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-field-ref-compat-'));
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
const loadMig = () => import('../../../src/main/features/personal_ontology_migration');
const loadContract = () => import('../../../src/main/features/personal_ontology_contract');

async function install() {
  const t = await loadFiles();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
}

/** 拿一个「当年」保存进技能绑定的 fieldRef。 */
async function savedFieldRef(section: string, fieldName: string): Promise<string> {
  const contract = await loadContract();
  const ref = await contract.buildRoleTemplateFieldRef(UID, 'probe', section, fieldName);
  expect(ref, `${section} · ${fieldName} 应该签得出句柄`).toBeTruthy();
  return ref!;
}

async function migrate() {
  const { applyRoleTemplateMigration } = await loadMig();
  expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);
}

function bumpTo(version: string) {
  CATALOG[0].version = version;
}

/** 文件里某个分节下某字段的值行。 */
async function valuesOf(section: string, fieldName: string): Promise<string[]> {
  const t = await loadFiles();
  const content = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe')!);
  const sec = content.sections.find((s: any) => s.title === section);
  if (!sec) return [];
  const raw = (sec.fields as any)[fieldName];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((v: any) => (typeof v === 'string' ? v : v.value));
}

describe('持久化 fieldRef › 迁移后仍命中同一个 identity', () => {
  it('仅字段改名：旧 ref 写进新字段名', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业方向', previous_names: ['专业'] };
    await migrate();

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok, res.error).toBe(true);
    expect(res.section).toBe('学习背景');
    expect(res.fieldName).toBe('专业方向');
    expect(await valuesOf('学习背景', '专业方向')).toContain('软件工程');
  });

  it('仅分节改名：旧 ref 写进新分节', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
    await migrate();

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok, res.error).toBe(true);
    expect(res.section).toBe('教育与研究');
    expect(res.fieldName).toBe('专业');
    expect(await valuesOf('教育与研究', '专业')).toContain('软件工程');
  });

  it('字段跨分节移动：旧 ref 跟着 field_id 走到新分节', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields = [{ id: 'grade', name: '年级' }];
    CATALOG[0].preset_groups[1].fields.push({ id: 'major', name: '专业' });
    await migrate();

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok, res.error).toBe(true);
    expect(res.section).toBe('基本信息');
    expect(res.fieldName).toBe('专业');
    expect(await valuesOf('基本信息', '专业')).toContain('软件工程');
    expect(await valuesOf('学习背景', '专业')).toEqual([]);
  });

  it('分节改名 + 字段改名同时发生', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].title = '教育与研究';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业方向', previous_names: ['专业'] };
    await migrate();

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok, res.error).toBe(true);
    expect(res.section).toBe('教育与研究');
    expect(res.fieldName).toBe('专业方向');
    expect(await valuesOf('教育与研究', '专业方向')).toContain('软件工程');
  });

  it('移动 + 改名同时发生', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields = [{ id: 'grade', name: '年级' }];
    CATALOG[0].preset_groups[1].fields.push({ id: 'major', name: '专业方向', previous_names: ['专业'] });
    await migrate();

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok, res.error).toBe(true);
    expect(res.section).toBe('基本信息');
    expect(res.fieldName).toBe('专业方向');
    expect(await valuesOf('基本信息', '专业方向')).toContain('软件工程');
  });

  it('已有值原样保留在换算后的坑里，追加而不是新建旧字段', async () => {
    await install();
    const t = await loadFiles();
    const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
    expect((await t.appendExistingTemplateFieldValueToRef(
      UID, t.buildContentRef(groupId, '学习背景'), '专业', '认知科学', '手动',
    )).ok).toBe(true);
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业方向', previous_names: ['专业'] };
    await migrate();

    const contract = await loadContract();
    expect((await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能')).ok).toBe(true);

    expect(await valuesOf('学习背景', '专业方向')).toEqual(['认知科学', '软件工程']);
    // 旧名字不得被重新创建成第二个坑
    const text = (await loadFiles()).readTemplateFileText(UID, 'probe')!;
    expect(text).not.toContain('- 专业:');
    expect(text).not.toContain('### 专业\n');
  });
});

describe('持久化 fieldRef › 仍然安全拒绝', () => {
  it('字段已明确退役：报不可写，不报「不是模板声明的字段」', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '年级');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields = [{ id: 'major', name: '专业' }];
    CATALOG[0].preset_groups[0].retired_fields = [
      { id: 'grade', previous_names: ['年级'], retired_in: '2.0.0' },
    ];
    await migrate();

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '大三', '智能');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('field is retired and no longer writable');
    expect(res.error).not.toBe('field is not declared by the role template');
  });

  it('字段彻底消失且未声明退役：非法字段', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '年级');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields = [{ id: 'major', name: '专业' }];

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '大三', '智能');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('field is not declared by the role template');
  });

  it('旧名被多个字段认领（歧义）：拒绝，不猜', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields = [
      { id: 'major_a', name: '主修', previous_names: ['专业'] },
      { id: 'major_b', name: '辅修', previous_names: ['专业'] },
    ];

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('field is not declared by the role template');
  });

  it('脏 ref / 非 tf ref 保持既有安全失败', async () => {
    await install();
    const contract = await loadContract();
    expect((await contract.appendRoleTemplateFieldValue(UID, 'not-a-ref', 'x', '智能')).error)
      .toBe('invalid field ref');

    const forged = 'po1' + Buffer.from(JSON.stringify(
      { k: 'tf', t: 'probe', s: '根本没有这个分节', f: '也没有这个字段' },
    )).toString('base64url');
    expect((await contract.appendRoleTemplateFieldValue(UID, forged, 'x', '智能')).error)
      .toBe('field is not declared by the role template');
  });

  it('模板未安装：报未安装，而不是被换算掩盖', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');
    const t = await loadFiles();
    expect((await t.uninstallTemplateFile(UID, 'probe')).ok).toBe(true);

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('role template is not installed');
  });

  it('catalog 已改名但迁移还没跑到：报 template_migration_pending（会自愈）', async () => {
    await install();
    const ref = await savedFieldRef('学习背景', '专业');

    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业方向', previous_names: ['专业'] };

    const contract = await loadContract();
    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('template_migration_pending');
  });
});

describe('持久化 fieldRef › 换算不放宽白名单', () => {
  it('用户自建字段：换算路径不会把它变成可写落点', async () => {
    await install();
    const t = await loadFiles();
    const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
    // 手填可以新建自建字段（appendFieldValueToRef），自动通道不行
    expect((await t.appendFieldValueToRef(
      UID, t.buildContentRef(groupId, '学习背景'), '我的私有字段', '随手记', '手动',
    )).ok).toBe(true);

    const contract = await loadContract();
    // 自建字段签不出句柄
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '我的私有字段')).toBeNull();
    // 手工伪造一个也写不进去
    const forged = 'po1' + Buffer.from(JSON.stringify(
      { k: 'tf', t: 'probe', s: '学习背景', f: '我的私有字段' },
    )).toString('base64url');
    const res = await contract.appendRoleTemplateFieldValue(UID, forged, '别的值', '智能');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('field is not declared by the role template');
    expect(await valuesOf('学习背景', '我的私有字段')).toEqual(['随手记']);
  });

  it('新签发的句柄用当前名字，不再制造历史名 ref', async () => {
    await install();
    CATALOG = catalogV1();
    bumpTo('2.0.0');
    CATALOG[0].preset_groups[0].fields[0] = { id: 'major', name: '专业方向', previous_names: ['专业'] };
    await migrate();

    const contract = await loadContract();
    // 历史名签不出句柄
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '专业')).toBeNull();

    const fresh = await savedFieldRef('学习背景', '专业方向');
    expect(contract.describeRoleTemplateFieldRef(fresh)).toEqual({
      templateId: 'probe', section: '学习背景', fieldName: '专业方向',
    });
    const targets = await contract.listRoleTemplateFieldTargets(UID);
    const labels = targets.map((x) => x.label);
    expect(labels).toContain('探针角色 · 学习背景 · 专业方向');
    expect(labels.some((l) => l.endsWith('· 专业'))).toBe(false);
  });
});
