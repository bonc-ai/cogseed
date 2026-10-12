/**
 * 红队探针 r3：已删资产的投影值能否借「分组回收站恢复」复活（终态资产残留）。
 *
 * 靶点（读码推演）：
 * - removeTemplateFieldValuesForRecallAsset（personal_ontology_template_files.ts
 *   :786 起）的 editPoDoc 回调只遍历 ctx.doc.groups 活组——文件内 grep "trash"
 *   零命中，doc.trash 里的投影值不被级联清理；
 * - deleteGroup 把整组（含 assetId 投影值）搬进 trash（personal_ontology_groups.ts
 *   :179-193），restoreDeletedGroup（:769）整状态复活，**无任何投影/资产存活检查**；
 * - 复活的投影值仍带 assetId → po.values.delete 返回 asset_projection_read_only
 *   （po/api.ts:375）——用户被自己删过的资产尸体锁死。
 *
 * 预言：组删除 → 资产投影级联清（removed=0，扫不到 trash）→ 组恢复 →
 * 已删资产的投影值原样复活且只读锁死。
 *
 * 2026-09-30 r3 收尾（记账员）：用例 1 对应待议 P-r3-6（恢复侧净化 / 删除侧
 * 截断 / 级联侧扩围三向分叉，且与 r1 P-r1-14 纠缠需统一权衡）；用例 2 是
 * r1 待议 P-r1-14（普通组孤儿）的运行时实证 → 均 it.skip。断言锁定的均是
 * 待议现状，拍板后随方向反转。见 round-3-甄别.md toPending。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
const UID = 'probe-user-r3';
const ASSET = 'ast_probe_r3';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r3-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
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

async function loadGroups() {
  return import('../../src/main/features/personal_ontology_groups');
}
async function loadTemplates() {
  return import('../../src/main/features/personal_ontology_template_files');
}
async function loadApi() {
  return import('../../src/main/features/po/api');
}

function dialect(lines: string[]): string {
  return ['## 字段区', '', '### 常用工具', ...lines, '', '---', '', '## 流水区', ''].join('\n');
}

describe('probe r3: 已删资产投影借分组回收站恢复复活（待议项已 skip）', () => {
  // 待议 P-r3-6：恢复通道复活已删资产的投影值（restoreDeletedGroup 无投影/
  // 资产存活检查，级联只扫活组不扫 trash）。
  it.skip('组删除→资产级联清（trash 不扫）→组恢复→投影值复活且只读锁死', async () => {
    const groups = await loadGroups();
    const templates = await loadTemplates();
    const api = await loadApi();

    // 存量数据：普通组里带 v1 迁移来的资产投影值（writeGroupContent 伪造通道，
    // r1 已证实；这里只作为数据构造手段）。
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, dialect([
      `- 资产维护的原文 [手动] @asset:${ASSET}`,
    ]));
    expect(readDoc().groups[0].values[0].assetId).toBe(ASSET);

    // 用户删除分组：投影值随组进 trash（用户意图 = 不再保留这组内容）。
    const del = await groups.deleteGroup(UID, groupId);
    expect(del.ok).toBe(true);
    expect(readDoc().groups).toHaveLength(0);
    expect(readDoc().trash).toHaveLength(1);

    // 资产侧 purge 的投影级联：只扫活组，trash 里的投影值不被清。
    const purge = await templates.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(true);
    expect(purge.removed).toBe(0); // 关键断言：级联对 trash 零覆盖
    expect(readDoc().trash[0].group.values[0].assetId).toBe(ASSET);

    // 用户从回收站恢复分组（po.groups.restore 通道语义）。
    const restore = await groups.restoreDeletedGroup(UID, groupId);
    expect(restore.ok).toBe(true);

    // 复活实锤：资产已删，投影值原样回来。
    const doc = readDoc();
    const revived = doc.groups.find((g: any) => g.id === groupId);
    expect(revived.values).toHaveLength(1);
    expect(revived.values[0].assetId).toBe(ASSET);
    expect(revived.values[0].text).toBe('资产维护的原文');

    // 锁死实证：复活的投影值在单值通道被只读守卫拦住，用户删不掉。
    const valueId = revived.values[0].id;
    const delValue = await api.poDeleteValue(UID, groupId, valueId);
    expect(delValue.ok).toBe(false);
    expect(delValue.error).toBe('asset_projection_read_only');
  });

  // 待议 P-r1-14（r1 遗留）：资产删除级联只清模板组，普通组 assetId 值的
  // 运行时实证。拍板扩级联后反转，拍板维持现状则可转为「锁现状」回归启用。
  it.skip('对照组：普通组活组的投影值同样不被级联清（P-r1-14 范围的运行时实证）', async () => {
    const groups = await loadGroups();
    const templates = await loadTemplates();

    const created = await groups.createGroup(UID, '活组');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, dialect([
      `- 资产维护的原文 [手动] @asset:${ASSET}`,
    ]));

    const purge = await templates.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(true);
    // 运行时证实：级联只处理 kind==='template' 的组，普通组（无论活组还是
    // trash）一律不清——待议 P-r1-14 所述"普通组孤儿"的直接证据。
    const after = readDoc().groups.find((g: any) => g.id === groupId);
    expect(after.values.some((v: any) => v.assetId === ASSET)).toBe(true);
    expect(purge.removed).toBe(0);
  });
});
