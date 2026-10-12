/**
 * 个人本体 v2 存储层测试（2026-09-29 重构）。
 *
 * 覆盖：v1 markdown → JSON 一次性迁移（组/值/元数据/历史快照/回收站）、
 * 新 CRUD（id 寻址）、规则分类一等列、资产投影只读、历史快照与恢复、
 * 渲染副本同步（方言 round-trip）、模板安装/卸载/归档重装、导出导入回灌。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-po2-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userRoot(): string {
  return path.join(tmpDir, UID);
}
function poDocFile(): string {
  return path.join(userRoot(), 'cloud', 'cognition', 'personal-ontology.json');
}
function v1Dir(): string {
  return path.join(userRoot(), 'cloud', 'contexts', '.personal_ontology_groups');
}

async function loadStore() {
  return import('../../../../src/main/features/po/store');
}
async function loadMigrate() {
  return import('../../../../src/main/features/po/migrate');
}
async function loadGroups() {
  return import('../../../../src/main/features/personal_ontology_groups');
}
async function loadTemplates() {
  return import('../../../../src/main/features/personal_ontology_template_files');
}
async function loadApi() {
  return import('../../../../src/main/features/po/api');
}
async function loadModel() {
  return import('../../../../src/main/features/po/model');
}

/** 造一个 v1 目录：一个普通组（带字段值/流水/历史）+ 一个模板文件 + 一个已删除组。 */
function seedV1(): void {
  const dir = v1Dir();
  fs.mkdirSync(path.join(dir, '.history', 'grp001'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.history', 'grp999'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'groups.md'), [
    '# 记忆分组',
    '',
    '### grp001',
    '- 标题: 工作偏好',
    '- 文件: .personal_ontology_groups/grp001.md',
    '- 创建时间: 2026-09-01T10:00:00',
    '- 更新时间: 2026-09-02T10:00:00',
    '',
    '### grpT',
    '- 标题: 学生',
    '- 文件: .personal_ontology_groups/student.md',
    '- 创建时间: 2026-09-01T10:00:00',
    '- 更新时间: 2026-09-02T10:00:00',
    '- 模板: student@0.2.0-review.1',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'grp001.md'), [
    '## 字段区',
    '',
    '### 常用工具',
    '- ZCode [手动] @asof:2026-09',
    '- Vim [候选]',
    '',
    '### 团队成员',
    '- 张三 → 项目A [手动] @kind:operation',
    '',
    '---',
    '',
    '## 流水区',
    '',
    '周五提交周报',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'student.md'), [
    '# 学生（模板）',
    '> 模板: student@0.2.0-review.1 | 已安装: 2026-09-01T10:00:00',
    '',
    '## 基本信息',
    '',
    '### 姓名',
    '',
    '### 年级',
    '- 大二 [手动]',
    '',
    '### 流水',
    '',
    '开学第一周',
  ].join('\n'));
  // 活组历史：一版旧快照 + 台账
  fs.writeFileSync(path.join(dir, '.history', 'grp001', '2026-09-01T10-05-00-000Z-00.md'), [
    '## 字段区',
    '',
    '### 常用工具',
    '- ZCode [手动]',
    '',
    '---',
    '',
    '## 流水区',
    '',
    '旧快照条目',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.history', 'grp001', 'audit.jsonl'), JSON.stringify({
    at: '2026-09-01T10:05:01.000Z', actor: 'user', action: 'value_add', groupId: 'grp001', field: '常用工具', afterSummary: 'ZCode',
  }) + '\n');
  // 孤儿历史（台账无行）= 已删除分组
  fs.writeFileSync(path.join(dir, '.history', 'grp999', '2026-08-30T09-00-00-000Z-00.md'), [
    '## 字段区',
    '',
    '### 旧组字段',
    '- 旧值 [手动]',
    '',
    '---',
    '',
    '## 流水区',
    '',
    '旧组流水',
  ].join('\n'));
}

describe('po v2 store › v1 迁移', () => {
  it('全量导入：组 id/值元数据/模板分节/历史快照/回收站都保全', async () => {
    seedV1();
    const migrate = await loadMigrate();
    const doc = migrate.importFromV1Sync(UID);
    expect(doc).not.toBeNull();
    expect(doc!.groups.length).toBe(2);

    const work = doc!.groups.find((g) => g.id === 'grp001')!;
    expect(work.title).toBe('工作偏好');
    expect(work.kind).toBe('user');
    const tools = work.fields.find((f) => f.name === '常用工具')!;
    const toolValues = work.values.filter((v) => v.fieldId === tools.id);
    expect(toolValues.length).toBe(2);
    const zcode = toolValues.find((v) => v.text === 'ZCode')!;
    expect(zcode.asOf).toBe('2026-09');
    expect(zcode.source).toBe('手动');
    const team = work.fields.find((f) => f.name === '团队成员')!;
    const rel = work.values.find((v) => v.fieldId === team.id)!;
    expect(rel.ruleKind).toBe('operation');
    expect(work.entries.map((e) => e.text)).toContain('周五提交周报');

    const student = doc!.groups.find((g) => g.id === 'grpT')!;
    expect(student.kind).toBe('template');
    expect(student.templateId).toBe('student');
    expect(student.templateVersion).toBe('0.2.0-review.1');
    const grade = student.fields.find((f) => f.name === '年级')!;
    expect(grade.section).toBe('基本信息');
    expect(grade.origin).toBe('schema');
    expect(student.values.some((v) => v.fieldId === grade.id && v.text === '大二')).toBe(true);
    expect(student.entries.some((e) => e.text === '开学第一周' && e.section === '基本信息')).toBe(true);
    // 空坑保全
    expect(student.fields.some((f) => f.name === '姓名' && f.section === '基本信息')).toBe(true);

    // 回收站：孤儿历史组复活
    expect(doc!.trash.length).toBe(1);
    expect(doc!.trash[0].group.id).toBe('grp999');

    // 历史快照转换成 JSON 且 audit 保留
    const store = await loadStore();
    const hist = store.listPoGroupHistory(UID, 'grp001');
    expect(hist.length).toBe(1);
    expect(hist[0].audit?.action).toBe('value_add');

    // 备份 + 台账移除由 ensurePoDoc 完成
    await store.ensurePoDoc(UID);
    expect(fs.existsSync(poDocFile())).toBe(true);
    expect(fs.existsSync(path.join(v1Dir(), 'groups.md'))).toBe(false);
    const backups = fs.readdirSync(path.join(userRoot(), 'local')).filter((n) => n.startsWith('ontology-v1-backup-'));
    expect(backups.length).toBe(1);
    expect(fs.existsSync(path.join(userRoot(), 'local', backups[0], 'groups.md'))).toBe(true);
  });

  it('无 v1 目录 = 新用户，返回空文档不落盘', async () => {
    const migrate = await loadMigrate();
    expect(migrate.importFromV1Sync(UID)).toBeNull();
    const store = await loadStore();
    expect(store.loadPoDocSync(UID).groups.length).toBe(0);
    expect(fs.existsSync(poDocFile())).toBe(false);
  });

  it('F-r1-8：v1 目录存在但无可导入内容 → ensurePoDoc 落盘空 JSON 结清，不再重扫', async () => {
    // 空 v1 目录（无 groups.md、无组文件、无 .history）：importFromV1Sync
    // 返回空文档而非 null——修复前这一分支不落盘，下次读照旧全量重扫。
    fs.mkdirSync(v1Dir(), { recursive: true });
    const store = await loadStore();
    const doc = await store.ensurePoDoc(UID);
    expect(doc.groups.length).toBe(0);
    // 空 JSON 即「v1 已结清」marker：此后 loadPoDocSync 直接读 JSON，
    // 不再重跑导入（读 groups.md、扫 .history、孤儿复活计算）。
    expect(fs.existsSync(poDocFile())).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(poDocFile(), 'utf8')) as { migratedFromV1At?: string };
    expect(persisted.migratedFromV1At).toBeTruthy();
    // v1 目录备份结清，恰好一份。
    const backups = fs.readdirSync(path.join(userRoot(), 'local')).filter((n) => n.startsWith('ontology-v1-backup-'));
    expect(backups.length).toBe(1);
    // 二次调用：JSON 已存在直接读回，不再产生第二份备份。
    expect((await store.ensurePoDoc(UID)).groups.length).toBe(0);
    const backupsAgain = fs.readdirSync(path.join(userRoot(), 'local')).filter((n) => n.startsWith('ontology-v1-backup-'));
    expect(backupsAgain.length).toBe(1);
    // 读路径走 JSON 分支，返回同一份空文档。
    expect(store.loadPoDocSync(UID).groups.length).toBe(0);
  });
});

describe('po v2 store › CRUD 与规则分类', () => {
  it('组删改进回收站、可恢复；改名/删除模板组被拒', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '测试组');
    expect(created.ok).toBe(true);
    const gid = created.group!.group_id;

    expect((await groups.renameGroup(UID, gid, '改名组')).ok).toBe(true);
    expect(groups.readGroups(UID).find((g) => g.group_id === gid)?.title).toBe('改名组');

    expect((await groups.deleteGroup(UID, gid)).ok).toBe(true);
    expect(groups.readGroups(UID).length).toBe(0);
    const deleted = groups.listDeletedGroups(UID);
    expect(deleted.length).toBe(1);
    expect(deleted[0].title).toBe('改名组');

    expect((await groups.restoreDeletedGroup(UID, gid)).ok).toBe(true);
    expect(groups.readGroups(UID).length).toBe(1);
  });

  it('值编辑：规则分类直接设档（修「筛选全空」病根）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '工作流');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '部署规则', { isRelation: true });
    expect(f.ok).toBe(true);
    const v = await api.poAddValue(UID, gid, f.field!.id, { text: 'develop → 先跑测试' });
    expect(v.ok).toBe(true);
    const vid = v.value!.id;

    // 未分类
    let snap = api.getPoSnapshot(UID);
    expect(snap.counts.rules).toBe(1); // 关系字段计入规则
    expect(snap.groups[0].values[0].ruleKind).toBeUndefined();

    // 直接设为偏好（不是循环 toggle）
    expect((await api.poUpdateValue(UID, gid, vid, { ruleKind: 'preference' })).ok).toBe(true);
    snap = api.getPoSnapshot(UID);
    expect(snap.groups[0].values[0].ruleKind).toBe('preference');
    // 换档 + 清除
    expect((await api.poUpdateValue(UID, gid, vid, { ruleKind: 'constraint' })).ok).toBe(true);
    expect((await api.poUpdateValue(UID, gid, vid, { ruleKind: null })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].ruleKind).toBeUndefined();

    // 编辑文本 / 时间锚三态 / 敏感性 / 核实
    expect((await api.poUpdateValue(UID, gid, vid, { text: 'main → 直接部署', asOf: '2026-09' })).ok).toBe(true);
    expect((await api.poUpdateValue(UID, gid, vid, { clearAsOf: true })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].asOf).toBeUndefined();
    expect((await api.poUpdateValue(UID, gid, vid, { sensitivity: 'restricted' })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].restricted).toBe(true);
    expect((await api.poUpdateValue(UID, gid, vid, { verified: 'independent' })).ok).toBe(true);

    // 删除
    expect((await api.poDeleteValue(UID, gid, vid)).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values.length).toBe(0);
  });

  it('值写入校验（r2）：poAddValue 拒绝枚举外 ruleKind、poUpdateValue 拒绝三态外 verified（无幽灵写）', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '校验组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段');
    expect(f.ok).toBe(true);

    // F-r2-1：poAddValue 的 ruleKind 枚举门（与 poUpdateValue 同口径）。
    const bad = await api.poAddValue(UID, gid, f.field!.id, { text: 'v1', ruleKind: 'bogus' as never });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('invalid rule kind');
    // 拒绝后不落盘（磁盘 JSON 里没有这条值）
    expect(api.getPoSnapshot(UID).groups[0].values.length).toBe(0);
    // 合法枚举 + null/undefined 放行
    expect((await api.poAddValue(UID, gid, f.field!.id, { text: 'v2', ruleKind: 'operation' })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].ruleKind).toBe('operation');

    // F-r2-2：poUpdateValue 的 verified 三态门（true/'independent'/false）。
    const vid = api.getPoSnapshot(UID).groups[0].values[0].id;
    const badVerified = await api.poUpdateValue(UID, gid, vid, { verified: 'yes' as never });
    expect(badVerified.ok).toBe(false);
    expect(badVerified.error).toBe('invalid verified');
    expect(api.getPoSnapshot(UID).groups[0].values[0].verified).toBeUndefined();
    // 合法三态照常：设 true → 升 independent → false 清除
    expect((await api.poUpdateValue(UID, gid, vid, { verified: true })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].verified).toBe(true);
    expect((await api.poUpdateValue(UID, gid, vid, { verified: 'independent' })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].verified).toBe('independent');
    expect((await api.poUpdateValue(UID, gid, vid, { verified: false })).ok).toBe(true);
    expect(api.getPoSnapshot(UID).groups[0].values[0].verified).toBeUndefined();
  });

  it('流水：记一笔 / 升格为字段值 / 删除', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '随记');
    const gid = g.group!.group_id;
    const added = await api.poAddEntry(UID, gid, '每周三例会');
    expect(added.ok).toBe(true);
    const entryId = api.getPoSnapshot(UID).groups[0].entries[0].id;
    const promoted = await api.poPromoteEntry(UID, gid, entryId, '例会');
    expect(promoted.ok).toBe(true);
    const snap = api.getPoSnapshot(UID);
    expect(snap.groups[0].entries.length).toBe(0);
    expect(snap.groups[0].values[0].text).toBe('每周三例会');
    expect(snap.groups[0].values[0].source).toBe('手动');
  });
});

describe('po v2 store › 渲染副本与兼容读', () => {
  it('写路径同步刷新方言副本，parseGroupContent 能读回', async () => {
    const groups = await loadGroups();
    const store = await loadStore();
    const created = await groups.createGroup(UID, '渲染组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '工具', 'ZCode', '手动', undefined, '2026-09');
    await groups.appendToGroup(UID, gid, '一条流水');

    const rel = groups.readGroups(UID)[0].rel_path;
    const abs = path.join(v1Dir(), rel.replace('.personal_ontology_groups/', ''));
    expect(fs.existsSync(abs)).toBe(true);
    const text = fs.readFileSync(abs, 'utf8');
    const parsed = groups.parseGroupContent(text);
    expect(parsed.fields['工具'][0].value).toBe('ZCode');
    expect(parsed.fields['工具'][0].asOf).toBe('2026-09');
    expect(parsed.entries).toContain('一条流水');

    // readGroupContent 走 JSON 现渲染（删掉副本后依然可读）
    fs.rmSync(abs);
    const content = await groups.readGroupContent(UID, gid);
    expect(content.ok).toBe(true);
    expect(groups.parseGroupContent(content.content!).fields['工具'][0].value).toBe('ZCode');
    void store;
  });

  it('v1 文本寻址兼容层仍可用（appendFieldValue/setFieldValue/verified/kind/sensitivity）', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '兼容组');
    const gid = created.group!.group_id;
    expect((await groups.appendFieldValue(UID, gid, '字段A', '值1', '手动')).ok).toBe(true);
    // 同值同源去重
    await groups.appendFieldValue(UID, gid, '字段A', '值1', '手动');
    const fields = (await groups.listGroupFields(UID, gid)).fields!;
    expect(fields[0].values.length).toBe(1);
    expect((await groups.setFieldValue(UID, gid, '字段A', '值1', '值2')).ok).toBe(true);
    expect((await groups.setFieldValueVerified(UID, gid, '字段A', '值2', 'independent')).ok).toBe(true);
    expect((await groups.cycleFieldValueRuleKind(UID, gid, '字段A', '值2')).ok).toBe(true);
    expect((await groups.setFieldValueSensitivity(UID, gid, '字段A', '值2', true)).ok).toBe(true);
    const after = (await groups.listGroupFields(UID, gid)).fields![0].values[0];
    expect(after.value).toBe('值2');
    expect(after.verified).toBe('independent');
    expect(after.ruleKind).toBe('operation');
    expect(after.sensitivity).toBe('restricted');
    expect((await groups.removeFieldValue(UID, gid, '字段A', '值2')).ok).toBe(true);
    // 字段空了连字段一起消失（普通组语义）
    expect((await groups.listGroupFields(UID, gid)).fields!.length).toBe(0);
  });
});

describe('po v2 store › 历史与恢复', () => {
  it('改前快照 → 列表 → 恢复', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '历史组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '字段', '第一版', '手动');
    await groups.setFieldValue(UID, gid, '字段', '第一版', '第二版');

    const hist = groups.listGroupHistory(UID, gid);
    expect(hist.length).toBeGreaterThanOrEqual(1);
    // 恢复到最新一版快照（= 第二次修改之前，「第一版」还在的状态）
    const target = hist[0];
    expect((await groups.restoreGroupSnapshot(UID, gid, target.id)).ok).toBe(true);
    const fields = (await groups.listGroupFields(UID, gid)).fields!;
    expect(fields[0].values.some((v) => v.value === '第一版')).toBe(true);
  });
});

describe('po v2 store › 快照写入口 safeId 门（F-r1-9）', () => {
  it('writePoGroupSnapshot 拒绝非白名单 uid/groupId：不建目录不落盘；合法调用照常留档', async () => {
    const store = await loadStore();
    const before = {
      id: 'grpX', title: '穿越组', kind: 'user' as const,
      fields: [], values: [], entries: [],
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    };
    // groupId 含 ../：path.join 正规化后逃出 po-history（修复前会在
    // <uid>/cloud/escape/ 落快照文件）。
    store.writePoGroupSnapshot(UID, '../../escape', before);
    // groupId 含 /：非白名单格式（修复前会在 po-history/ 下建嵌套目录 a/b/c）。
    store.writePoGroupSnapshot(UID, 'a/b/c', before);
    // groupId 空串 / uid 空串：uid='' 时 userRoot('') = WS_ROOT，
    // 修复前快照会写到 <WS_ROOT>/cloud/cognition/po-history/。
    store.writePoGroupSnapshot(UID, '', before);
    store.writePoGroupSnapshot('', 'grp-ok', before);
    // 四次非法调用全部被静默拦截：无越界产物、无垃圾目录。
    expect(fs.existsSync(path.join(userRoot(), 'cloud', 'escape'))).toBe(false);
    expect(fs.existsSync(path.join(userRoot(), 'cloud', 'cognition'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'cloud'))).toBe(false);
    // 合法调用照常留档（正常路径不回归）。
    store.writePoGroupSnapshot(UID, 'grp-ok', before);
    expect(store.listPoGroupHistory(UID, 'grp-ok').length).toBe(1);
    expect(fs.existsSync(path.join(userRoot(), 'cloud', 'cognition', 'po-history', 'grp-ok'))).toBe(true);
  });
});

describe('po v2 store › 模板生命周期', () => {
  it('安装 → 填值 → 卸载归档 → 重装恢复原数据', async () => {
    const templates = await loadTemplates();
    const groups = await loadGroups();
    const installed = await templates.installTemplateFile(UID, 'student');
    expect(installed.ok).toBe(true);
    const gid = installed.created![0].group_id;

    // 字段空坑全量
    const fields = (await templates.listFieldsByRef(UID, `${gid}::学习背景`)).fields!;
    expect(fields.map((f) => f.name)).toContain('教育阶段');

    // 经复合 id 写值（候选确认的路径）
    expect((await templates.appendFieldValueToRef(UID, `${gid}::学习背景`, '教育阶段', '大二在读', '手动')).ok).toBe(true);
    expect((await templates.readContentById(UID, `${gid}::学习背景`)).content).toContain('大二在读');

    // 渲染副本在且是模板方言
    const rendered = fs.readFileSync(path.join(v1Dir(), 'student.md'), 'utf8');
    expect(templates.isTemplateFileText(rendered)).toBe(true);

    // 卸载归档
    const uninstalled = await templates.uninstallTemplateFile(UID, 'student');
    expect(uninstalled.ok).toBe(true);
    expect(groups.readGroups(UID).length).toBe(0);
    expect(templates.templateHasArchive(UID, 'student')).toBe(true);
    expect(fs.existsSync(path.join(v1Dir(), 'student.md'))).toBe(false);

    // 重装恢复
    const reinstalled = await templates.installTemplateFile(UID, 'student', true);
    expect(reinstalled.ok).toBe(true);
    expect(reinstalled.restored_from_archive).toBe(true);
    const gid2 = reinstalled.created![0].group_id;
    const fields2 = (await templates.listFieldsByRef(UID, `${gid2}::学习背景`)).fields!;
    expect(fields2.find((f) => f.name === '教育阶段')!.values.map((v) => v.value)).toContain('大二在读');
    // 归档清掉
    expect(templates.templateHasArchive(UID, 'student')).toBe(false);
  });
});

describe('po v2 store › 导出导入', () => {
  it('导出 → 清空 → 导入回灌，值与规则分类无损', async () => {
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '回灌组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '规则字段', { isRelation: true });
    await api.poAddValue(UID, gid, f.field!.id, { text: 'A → B', ruleKind: 'constraint', asOf: '2026-09' });
    await api.poAddEntry(UID, gid, '一条流水');

    const exported = api.poExportMarkdown(UID);
    expect(exported).toContain('## 回灌组');
    expect(exported).toContain('@kind:constraint');

    // 模拟换机：删掉文档重新预览导入
    fs.rmSync(poDocFile(), { force: true });
    const preview = api.poImportPreview(UID, exported);
    expect(preview.items.length).toBe(1);
    expect(preview.items[0].title).toBe('回灌组');
    expect(preview.items[0].fields[0].values.map((v) => v.value)).toContain('A → B');
    expect(preview.items[0].fields[0].values[0].ruleKind).toBe('constraint');
    const applied = await api.poImportApply(UID, preview.items);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBeGreaterThanOrEqual(2);

    const snap = api.getPoSnapshot(UID);
    const reg = snap.groups.find((x) => x.title === '回灌组')!;
    expect(reg.values[0].text).toBe('A → B');
    expect(reg.values[0].ruleKind).toBe('constraint');
    expect(reg.values[0].asOf).toBe('2026-09');
    expect(reg.entries.map((e) => e.text)).toContain('一条流水');
  });

  it('导入 meta 与手写通道同口径：非法 asOf/ruleKind/verified 剥离，合法部分照常落盘', async () => {
    const api = await loadApi();
    // 模拟外部直接构造 items 调 poImportApply（绕过 preview 解析），
    // 塞入红队探针同款非法结构：撕裂方言 md 副本、写读不对称的入口。
    const items: Array<{ title: string; mergeIntoExisting: boolean; fields: Array<{ name: string; values: any[] }>; entries: string[] }> = [
      {
        title: '注入组',
        mergeIntoExisting: false,
        fields: [
          {
            name: '字段',
            values: [
              { value: '合法 meta', asOf: '2026-09', ruleKind: 'constraint', verified: 'independent', restricted: true },
              { value: '非法 meta', asOf: '2026-09\nBOGUS', ruleKind: 'evil_kind', verified: 'yes-please' },
            ],
          },
        ],
        entries: [],
      },
    ];
    const applied = await api.poImportApply(UID, items as any);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(2);

    const snap = api.getPoSnapshot(UID);
    const group = snap.groups.find((g) => g.title === '注入组')!;
    const good = group.values.find((v) => v.text === '合法 meta')!;
    expect(good.asOf).toBe('2026-09');
    expect(good.ruleKind).toBe('constraint');
    expect(good.verified).toBe('independent');
    expect(good.restricted).toBe(true);

    // 非法三项全部剥离（text 本身照常落盘，批量导入不因单条坏 meta 中止）
    const bad = group.values.find((v) => v.text === '非法 meta')!;
    expect(bad.asOf).toBeUndefined();
    expect(bad.ruleKind).toBeUndefined();
    expect(bad.verified).toBeUndefined();

    // 方言 md 副本 round-trip 无损：多行 asOf 若落盘会把值行撕成两行
    const md = path.join(v1Dir(), `${group.id}.md`);
    expect(fs.existsSync(md)).toBe(true);
    const groupsMod = await loadGroups();
    const parsed = groupsMod.parseGroupContent(fs.readFileSync(md, 'utf8'));
    const badLine = parsed.fields['字段'].find((v) => v.value === '非法 meta')!;
    expect(badLine.asOf).toBeUndefined();
    expect(badLine.ruleKind).toBeUndefined();
  });

  it('超长文本截断不劈开代理对：末尾无孤立高代理，UTF-8 往返无损', async () => {
    const { sanitizePoText } = await loadModel();
    // 红队探针同款输入：1997 个 ASCII + 10 个 emoji，截断点正好落在代理对中间
    const long = 'x'.repeat(1997) + '😀'.repeat(10);
    const stored = sanitizePoText(long, 2000);
    // 1997 ASCII + 完整保留 1 个 emoji（2 码元）= 1999；被劈开的高代理已剔除
    expect(stored.length).toBe(1999);
    const last = stored.charCodeAt(stored.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // 末位不是孤立高代理
    // 磁盘 JSON 往返（UTF-8 序列化）不产生 U+FFFD、不变形
    const roundTripped = JSON.parse(JSON.stringify(stored)) as string;
    expect(roundTripped).toBe(stored);
    expect(roundTripped.includes('\uFFFD')).toBe(false);
    // 正常 emoji 不受影响
    expect(sanitizePoText('心情 😀 不错', 2000)).toBe('心情 😀 不错');
    // 截断点不在代理对上时长度保持
    expect(sanitizePoText('ab😀cd', 3)).toBe('ab');

    // 全链路：poAddValue 落盘读回同样干净
    const api = await loadApi();
    const g = await api.poCreateGroup(UID, '长文本组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '长文本', {});
    const v = await api.poAddValue(UID, gid, f.field!.id, { text: long });
    expect(v.ok).toBe(true);
    const saved = api.getPoSnapshot(UID).groups[0].values[0].text;
    const savedLast = saved.charCodeAt(saved.length - 1);
    expect(savedLast >= 0xd800 && savedLast <= 0xdbff).toBe(false);
    expect(JSON.parse(fs.readFileSync(poDocFile(), 'utf8')).groups[0].values[0].text).toBe(saved);
  });
});
