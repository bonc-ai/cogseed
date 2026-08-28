import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 一条不变式：**签得出 fieldRef ⟺ 写得进去**。
 *
 * 收归后这两条路曾经判据不同 —— `listRoleTemplateFieldTargets` 遍历实例文件，
 * `buildRoleTemplateFieldRef` 只看 catalog T-box。于是 catalog 新增字段、实例
 * 还没迁移时，后者照样签得出句柄，拿去写却撞 `field not found`：路由说命中了，
 * 落点也「有」，值就是不出现，日志里还没有 error。
 *
 * 这组测试在真实文件上跑完「catalog 升级 → 迁移前 → 迁移后」三态。
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
const UID = 'test-user-writable-consistency';

function catalogV1() {
  return [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{ id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-writable-'));
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
const loadMig = () => import('../../../src/main/features/personal_ontology_migration');

/** 对每个列出来的落点都真写一次，确认没有一个是空头支票。 */
async function everyListedTargetIsWritable() {
  const contract = await loadContract();
  const targets = await contract.listRoleTemplateFieldTargets(UID);
  expect(targets.length).toBeGreaterThan(0);
  for (const target of targets) {
    const res = await contract.appendRoleTemplateFieldValue(UID, target.fieldRef, `值-${target.label}`, '智能');
    expect(res, `落点 ${target.label} 列得出来却写不进去`).toMatchObject({ ok: true });
  }
  return targets;
}

describe('writable target consistency › 列表与签发口径一致', () => {
  it('列出来的每一个落点都真的写得进去', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    await everyListedTargetIsWritable();
  });

  it('catalog 新增字段、迁移未跑时：既不列出，也签不出句柄', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields.push({ id: 'direction', name: '当前研究方向' });

    const contract = await loadContract();
    // T-box 已经声明了它
    expect(contract.isTboxField('probe', '学习背景', '当前研究方向')).toBe(true);
    // 但实例里还没有这个坑 —— 两条路必须同时说「不行」
    const listed = await contract.listRoleTemplateFieldTargets(UID);
    expect(listed.map((x) => x.label)).not.toContain('探针角色 · 学习背景 · 当前研究方向');
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '当前研究方向')).toBeNull();
  });

  it('迁移跑完之后，新字段同时出现在列表里且可写', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields.push({ id: 'direction', name: '当前研究方向' });

    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).outcome).toBe('migrated');

    const contract = await loadContract();
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '当前研究方向')).toBeTruthy();
    const targets = await everyListedTargetIsWritable();
    expect(targets.map((x) => x.label)).toContain('探针角色 · 学习背景 · 当前研究方向');
  });
});

describe('writable target consistency › 拿不到句柄的各种理由', () => {
  it('模板未安装 → 签不出', async () => {
    const contract = await loadContract();
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '专业')).toBeNull();
  });

  it('非 T-box 字段（用户自建）→ 签不出', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
    const ref = t.buildContentRef(groupId, '学习背景');
    expect((await t.appendFlowEntryToRef(UID, ref, '自建内容')).ok).toBe(true);
    expect((await t.promoteEntryToRef(UID, ref, '自建内容', '我的自建字段')).ok).toBe(true);

    const contract = await loadContract();
    // 字段在实例文件里确实存在，但 T-box 没声明它 → 自动通道不许写
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '我的自建字段')).toBeNull();
    const listed = await contract.listRoleTemplateFieldTargets(UID);
    expect(listed.map((x) => x.label)).not.toContain('探针角色 · 学习背景 · 我的自建字段');
  });

  it('分节被 catalog 改名而实例未迁移 → 两条路都关，且不会签出坏 ref', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);

    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].title = '教育背景';
    CATALOG[0].preset_groups[0].previous_names = ['学习背景'];

    const contract = await loadContract();
    // 新名字：实例文件里没有这个分节
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '教育背景', '专业')).toBeNull();
    // 旧名字：T-box 现在不认它
    expect(await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '专业')).toBeNull();
    expect(await contract.listRoleTemplateFieldTargets(UID)).toEqual([]);
  });
});

describe('writable target consistency › 迁移未跑时的写入错误码可区分', () => {
  it('T-box 声明了但实例还没有该坑 → template_migration_pending', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const contract = await loadContract();
    const ref = (await contract.buildRoleTemplateFieldRef(UID, 'probe', '学习背景', '专业'))!;

    // 手工把这个坑从实例里删掉，模拟「catalog 有、实例没有」
    expect((await t.removeFieldToRef(UID, t.buildContentRef(
      t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id, '学习背景',
    ), '专业')).ok).toBe(true);

    const res = await contract.appendRoleTemplateFieldValue(UID, ref, '软件工程', '智能');
    expect(res).toMatchObject({ ok: false, error: 'template_migration_pending' });
  });

  it('T-box 根本没声明的字段 → 仍然是白名单错误，不与迁移待办混淆', async () => {
    const t = await loadFiles();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const contract = await loadContract();
    // 手工伪造一个指向非 T-box 字段的 ref（渲染层不会这么做，但 IPC 是不可信输入）
    const forged = 'po1' + Buffer.from(JSON.stringify(
      { k: 'tf', t: 'probe', s: '学习背景', f: '不存在的字段' },
    )).toString('base64url');
    const res = await contract.appendRoleTemplateFieldValue(UID, forged, 'x', '智能');
    expect(res).toMatchObject({ ok: false, error: 'field is not declared by the role template' });
  });
});
