/** 资产清除级联覆盖模板卸载归档面：`_backup_<ts>/` 归档 md 里指向已清
 * 资产的投影值行（正文+@asset 标记）随级联一并清除，重装恢复无残留可复活；
 * 恢复侧对带 assetId 标记的值重新判断可投影性，是第二道防线。
 * 无资产所有权标记的用户内容与模板组本身仍按原恢复契约保留。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let CATALOG: any[] = [];

vi.mock('../../src/main/features/role_templates', () => ({
  listRoleTemplates: () => JSON.parse(JSON.stringify(CATALOG)),
  getRoleTemplate: (id: string) => {
    const found = CATALOG.find((t) => t.template_id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  },
  listScenarios: () => [],
  getScenario: () => undefined,
}));
vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-user-arch-r1';
const ASSET = 'ast_probe_arch';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-arch-r1-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{ id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readDoc(): any {
  return JSON.parse(fs.readFileSync(
    path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json'), 'utf8'));
}

async function loadTemplates() {
  return import('../../src/main/features/personal_ontology_template_files');
}

describe('模板卸载归档：已清资产投影借重装复活（复活族第三面）', () => {
  it('卸载归档→资产投影级联清（含卸载归档）→重装恢复→无投影残留可复活', async () => {
    const t = await loadTemplates();

    // ① 装模板，经生产投影通道写入带资产所有权标记的模板值。
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    let group = readDoc().groups.find((g: any) => g.kind === 'template');
    const groupId = group.id;
    const ref = t.buildContentRef(groupId, '学习背景');
    expect((await t.appendExistingTemplateFieldValueToRef(
      UID, ref, '专业', '资产维护的原文-探针归档面', '手动', undefined, ASSET)).ok).toBe(true);
    group = readDoc().groups.find((g: any) => g.id === groupId);
    expect(group.values.some((v: any) => v.assetId === ASSET)).toBe(true);

    // ② 卸载：整组方言 md 归档进 _backup_<ts>/，组从 doc.groups 移除。
    const un = await t.uninstallTemplateFile(UID, 'probe');
    expect(un.ok).toBe(true);
    expect(readDoc().groups.some((g: any) => g.id === groupId)).toBe(false);
    expect(String(un.archive_dir || '')).toContain('_backup_');
    const archivedMd = fs.readFileSync(
      path.join(un.archive_dir!, 'probe.md'), 'utf8');
    // 归档 md 携带正文与资产标记（renderTemplateGroupMarkdown :112）。
    expect(archivedMd).toContain('资产维护的原文-探针归档面');
    expect(archivedMd).toContain(`@asset:${ASSET}`);

    // ③ 资产侧投影级联：活组零命中（removed=0，组已卸载），
    // 但归档面被同清——归档 md 里该资产的投影值行（正文+@asset 标记）删除，
    // 模板结构与用户内容（分节/空坑/元信息）保留。
    const purge = await t.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(true);
    expect(purge.removed).toBe(0); // 活组零命中（对照组口径：removed 只计活组值）
    expect(purge.archivedScrubbed ?? 0).toBeGreaterThanOrEqual(1); // 归档面命中
    const scrubbedMd = fs.readFileSync(path.join(un.archive_dir!, 'probe.md'), 'utf8');
    expect(scrubbedMd).not.toContain('资产维护的原文-探针归档面');
    expect(scrubbedMd).not.toContain(`@asset:${ASSET}`);
    expect(scrubbedMd).toContain('> 模板: probe@1.0.0'); // 结构保留，可重装恢复

    // ④ 重装 + 恢复原数据（po.install 通道 restoreData 语义）。
    const re = await t.installTemplateFile(UID, 'probe', true);
    expect(re.ok).toBe(true);

    // ⑤ 恢复侧第二道防线：ASSET 的记录不在 ability-assets
    // （从未存在=purge/物理删除同构），恢复侧过滤兜底——投影值不随重装回到
    // 文档；模板组本身正常恢复（③已清归档 + ⑤恢复过滤双保险）。
    const doc = readDoc();
    const restored = doc.groups.find((g: any) => g.kind === 'template');
    expect(restored).toBeTruthy();
    expect(restored!.values.some((v: any) => v.assetId === ASSET)).toBe(false);
    expect(restored!.values.some((v: any) => v.text === '资产维护的原文-探针归档面')).toBe(false);
    // 无所有权标记的手写值不受过滤影响（本用例没有手写值，断言组恢复即可）。
  });

  it('对照组：活模板组的投影值在级联范围内（removed=1，级联本身有效）', async () => {
    const t = await loadTemplates();
    expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
    const group = readDoc().groups.find((g: any) => g.kind === 'template');
    const ref = t.buildContentRef(group.id, '学习背景');
    expect((await t.appendExistingTemplateFieldValueToRef(
      UID, ref, '专业', '活组投影原文', '手动', undefined, ASSET)).ok).toBe(true);

    const purge = await t.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(true);
    expect(purge.removed).toBe(1);
    const after = readDoc().groups.find((g: any) => g.kind === 'template');
    expect(after.values.some((v: any) => v.assetId === ASSET)).toBe(false);
  });
});

it('reports archive cleanup failure instead of claiming purge success', async () => {
  const t = await loadTemplates();
  expect((await t.installTemplateFile(UID, 'probe')).ok).toBe(true);
  const group = readDoc().groups.find((g: any) => g.kind === 'template');
  const ref = t.buildContentRef(group.id, '学习背景');
  expect((await t.appendExistingTemplateFieldValueToRef(
    UID, ref, '专业', '资产原文失败探针', '手动', undefined, ASSET)).ok).toBe(true);
  const un = await t.uninstallTemplateFile(UID, 'probe');
  expect(un.ok).toBe(true);
  const archiveDir = String(un.archive_dir);
  const archiveMd = path.join(archiveDir, 'probe.md');
  // 注入「归档清理写失败」必须按平台选载体：归档 md 走 writeTextAtomicSync
  // （storage.ts:177，先写同目录临时文件再 rename 覆盖目标）。
  //   POSIX：目录去掉写位后临时文件建不出来/rename 不了。
  //   Windows：chmod 对目录基本无效（权限走 ACL，Node 只把写位映射成文件的
  //   FILE_ATTRIBUTE_READONLY 属性），所以改为把归档 md 本身置只读——
  //   MoveFileEx(REPLACE_EXISTING) 覆盖只读目标返回 ACCESS_DENIED，
  //   rename 抛 EACCES/EPERM（storage.ts:70 的可重试错误）后重试耗尽抛出，
  //   与 POSIX 落在同一个 scrub 失败分支（archiveErrors++）。
  const windows = process.platform === 'win32';
  if (windows) fs.chmodSync(archiveMd, 0o444);
  else fs.chmodSync(archiveDir, 0o555);
  try {
    const purge = await t.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(false);
    expect(purge.archiveErrors || 0).toBeGreaterThan(0);
  } finally {
    if (windows) fs.chmodSync(archiveMd, 0o644);
    else fs.chmodSync(archiveDir, 0o755);
  }
  const retry = await t.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
  expect(retry.ok).toBe(true);
  expect(retry.archivedScrubbed || 0).toBeGreaterThan(0);
});
