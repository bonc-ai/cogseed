import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 第一种真正落盘的 migration：**补空坑**。
 *
 * 验收核心不是「新字段出现了」，而是「除了新字段以外什么都没动」：
 * 旧值一字不改、用户自建字段不丢、流水区不丢。整份文件只有一次原子写，
 * 所以磁盘上不存在半迁移状态；台账在文件落盘之后才跟上。
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
const UID = 'test-user-mig-apply';

/** v1：一个分节、一个字段。 */
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

/** v2：同分节多一个字段。 */
function catalogV2AddField() {
  const c = catalogV1();
  c[0].version = '2.0.0';
  c[0].preset_groups[0].fields.push({ id: 'direction', name: '当前研究方向' });
  return c;
}

/** v2：多一个整节。 */
function catalogV2AddSection() {
  const c = catalogV1();
  c[0].version = '2.0.0';
  c[0].preset_groups.push({ id: 'pace', title: '目标与节奏', fields: [{ id: 'goal', name: '学习目标' }] } as any);
  return c;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mig-apply-'));
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

function fileVersion(text: string): string | undefined {
  return /^>\s*模板:\s*probe@([^\s|]+)/m.exec(text)?.[1];
}

async function ledgerVersion(): Promise<string | undefined> {
  const t = await loadFiles();
  return t.readGroups(UID).find((g) => g.template_id === 'probe')?.template_version;
}

/** 装 v1，填一条值，再加一个用户自建字段和一条流水。 */
async function installV1WithUserData() {
  const t = await loadFiles();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
  const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
  const ref = t.buildContentRef(groupId, '学习背景');

  expect((await t.appendExistingTemplateFieldValueToRef(UID, ref, '专业', '软件工程', '手动')).ok).toBe(true);
  expect((await t.appendFlowEntryToRef(UID, ref, '一条流水记录')).ok).toBe(true);
  // 用户升格建的自定义字段（不在 T-box 里）：先落流水，再升格成字段
  expect((await t.appendFlowEntryToRef(UID, ref, '自建内容')).ok).toBe(true);
  const promoted = await t.promoteEntryToRef(UID, ref, '自建内容', '我的自建字段');
  expect(promoted).toMatchObject({ ok: true, isCustom: true });
  return { t, groupId, ref };
}

describe('add-field migration › 补坑且只补坑', () => {
  it('新增字段落成空坑，旧值/自建字段/流水全部原样保留', async () => {
    const { t } = await installV1WithUserData();
    const before = t.readTemplateFileText(UID, 'probe');
    expect(before).toContain('软件工程');
    expect(before).toContain('我的自建字段');
    expect(before).toContain('一条流水记录');

    CATALOG = catalogV2AddField();
    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');

    expect(res).toMatchObject({
      ok: true, outcome: 'migrated', fromVersion: '1.0.0', toVersion: '2.0.0',
      addedFields: 1, addedSections: 0,
    });

    const after = t.readTemplateFileText(UID, 'probe');
    expect(after).toContain('### 当前研究方向');   // 新空坑
    expect(after).toContain('软件工程');            // 旧值
    expect(after).toContain('我的自建字段');        // 自建字段
    expect(after).toContain('自建内容');
    expect(after).toContain('一条流水记录');        // 流水

    // 新字段确实是空坑
    const parsed = t.parseTemplateContent(after);
    const sec = parsed.sections.find((s) => s.title === '学习背景')!;
    expect(sec.fields['当前研究方向']).toEqual([]);
    expect(sec.fields['专业'].map((v: any) => v.value)).toEqual(['软件工程']);
  });

  it('文件与台账的版本都升到 catalog 版本', async () => {
    await installV1WithUserData();
    CATALOG = catalogV2AddField();
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).ok).toBe(true);

    const t = await loadFiles();
    expect(fileVersion(t.readTemplateFileText(UID, 'probe'))).toBe('2.0.0');
    expect(await ledgerVersion()).toBe('2.0.0');
  });

  it('新分节整节补上，字段全是空坑', async () => {
    await installV1WithUserData();
    CATALOG = catalogV2AddSection();
    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({ ok: true, outcome: 'migrated', addedSections: 1, addedFields: 0 });

    const t = await loadFiles();
    const parsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));
    expect(parsed.sections.map((s) => s.title)).toEqual(['学习背景', '目标与节奏']);
    expect(parsed.sections[1].fields['学习目标']).toEqual([]);
    expect(parsed.sections[0].fields['专业'].map((v: any) => v.value)).toEqual(['软件工程']);
  });

  it('已有同名字段不会被覆盖成空坑', async () => {
    const { t } = await installV1WithUserData();
    // 用户先手工建了一个与 catalog 即将新增的字段同名的坑，并填了值
    const groupId = t.readGroups(UID).find((g) => g.template_id === 'probe')!.group_id;
    const ref = t.buildContentRef(groupId, '学习背景');
    expect((await t.appendFlowEntryToRef(UID, ref, '我自己写的方向')).ok).toBe(true);
    expect((await t.promoteEntryToRef(UID, ref, '我自己写的方向', '当前研究方向')).ok).toBe(true);

    CATALOG = catalogV2AddField();
    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');

    // 该字段已经存在 → 不是 addition，本次只是把版本推上去
    expect(res.ok).toBe(true);
    expect(res.addedFields).toBe(0);
    const parsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));
    expect(parsed.sections[0].fields['当前研究方向'].map((v: any) => v.value)).toEqual(['我自己写的方向']);
  });

  it('迁移前留下 _migration_<ts> 备份，内容是迁移前的文件', async () => {
    const { t } = await installV1WithUserData();
    const before = t.readTemplateFileText(UID, 'probe');

    CATALOG = catalogV2AddField();
    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');

    expect(res.backupDir).toBeTruthy();
    expect(path.basename(res.backupDir!)).toMatch(/^_migration_\d+$/);
    expect(fs.readFileSync(path.join(res.backupDir!, 'probe.md'), 'utf8')).toBe(before);
    // 备份不能进 restore 的发现路径
    expect(t.readTemplateArchive(UID, 'probe')).toBeNull();
  });
});

describe('add-field migration › 幂等与拒绝', () => {
  it('重复执行是幂等的：第二次为 noop', async () => {
    await installV1WithUserData();
    CATALOG = catalogV2AddField();
    const { applyRoleTemplateMigration } = await loadMig();

    expect((await applyRoleTemplateMigration(UID, 'probe')).outcome).toBe('migrated');
    const second = await applyRoleTemplateMigration(UID, 'probe');
    expect(second).toMatchObject({ ok: true, outcome: 'noop' });
  });

  it('catalog 有未支持的改名 → refused，版本原地不动，文件一个字节都不改', async () => {
    const { t } = await installV1WithUserData();
    const before = t.readTemplateFileText(UID, 'probe');

    // 声明式改名：专业 → 专业与研究方向
    CATALOG = catalogV1();
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields = [
      { id: 'major', name: '专业与研究方向', previous_names: ['专业'] },
    ];

    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');

    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('refused');
    expect(res.refusal!.unsupportedChanges[0]).toMatchObject({
      kind: 'rename_field',
      status: 'requires_manual_or_future_migration',
    });
    // 不留半迁移状态：文件与台账都还是 v1
    expect(t.readTemplateFileText(UID, 'probe')).toBe(before);
    expect(fileVersion(before)).toBe('1.0.0');
    expect(await ledgerVersion()).toBe('1.0.0');
  });

  it('未安装 / 文件缺失 → failed，不抛异常', async () => {
    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({ ok: false, outcome: 'failed' });
  });
});

describe('add-field migration › 崩溃自愈（文件已 v2、台账仍 v1）', () => {
  it('不重复迁移，只修台账', async () => {
    await installV1WithUserData();
    CATALOG = catalogV2AddField();
    const { applyRoleTemplateMigration } = await loadMig();
    expect((await applyRoleTemplateMigration(UID, 'probe')).outcome).toBe('migrated');

    const t = await loadFiles();
    const migrated = t.readTemplateFileText(UID, 'probe');

    // 模拟「文件已写、台账未更新」就崩溃：把台账版本掰回 v1
    const groups = t.readGroups(UID);
    const row = groups.find((g) => g.template_id === 'probe')!;
    row.template_version = '1.0.0';
    const { writeGroups } = await import('../../../src/main/features/personal_ontology_groups');
    writeGroups(UID, groups);
    expect(await ledgerVersion()).toBe('1.0.0');

    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({ ok: true, outcome: 'ledger_repaired', toVersion: '2.0.0' });
    expect(await ledgerVersion()).toBe('2.0.0');
    // 文件一个字节都没被重写
    expect(t.readTemplateFileText(UID, 'probe')).toBe(migrated);
    // 也没有为此再产生一份备份
    expect(t.listMigrationBackupDirs(UID).length).toBe(1);
  });

  it('结构一致但文件版本落后（纯文案升级）→ 只更新版本行', async () => {
    await installV1WithUserData();
    const t = await loadFiles();
    const beforeParsed = t.parseTemplateContent(t.readTemplateFileText(UID, 'probe'));

    CATALOG = catalogV1();
    CATALOG[0].version = '1.1.0'; // 字段没变，只是版本前进

    const { applyRoleTemplateMigration } = await loadMig();
    const res = await applyRoleTemplateMigration(UID, 'probe');
    expect(res).toMatchObject({ ok: true, outcome: 'migrated', addedFields: 0, addedSections: 0 });

    const after = t.readTemplateFileText(UID, 'probe');
    expect(fileVersion(after)).toBe('1.1.0');
    expect(await ledgerVersion()).toBe('1.1.0');
    // 结构与值不变
    const afterParsed = t.parseTemplateContent(after);
    expect(afterParsed.sections.map((s) => s.title)).toEqual(beforeParsed.sections.map((s) => s.title));
    expect(afterParsed.sections[0].fields['专业']).toEqual(beforeParsed.sections[0].fields['专业']);
  });
});

describe('reconcileInstalledRoleTemplates', () => {
  it('逐模板独立：一个拒绝不影响另一个迁移成功', async () => {
    const t = await loadFiles();
    CATALOG = [
      ...catalogV1(),
      {
        template_id: 'other', name: '另一个', description: '', version: '1.0.0',
        preset_groups: [{ id: 's', title: '节', fields: [{ id: 'f', name: '字段' }] }],
        bundle: { skill_ids: [], agent_ids: [] },
      },
    ];
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    expect((await t.installTemplateFile(UID, 'other')).ok).toBe(true);

    // probe 走纯新增；other 走未支持的改名
    CATALOG[0].version = '2.0.0';
    CATALOG[0].preset_groups[0].fields.push({ id: 'direction', name: '当前研究方向' });
    CATALOG[1].version = '2.0.0';
    CATALOG[1].preset_groups[0].fields = [{ id: 'f', name: '字段新名', previous_names: ['字段'] }];

    const { reconcileInstalledRoleTemplates } = await loadMig();
    const results = await reconcileInstalledRoleTemplates(UID);

    const byId = Object.fromEntries(results.map((r) => [r.templateId, r]));
    expect(byId.probe).toMatchObject({ ok: true, outcome: 'migrated' });
    expect(byId.other).toMatchObject({ ok: false, outcome: 'refused' });
    expect(t.readGroups(UID).find((g) => g.template_id === 'probe')!.template_version).toBe('2.0.0');
    expect(t.readGroups(UID).find((g) => g.template_id === 'other')!.template_version).toBe('1.0.0');
  });
});
