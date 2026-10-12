/**
 * 红队探针 r1：个人本体「原文覆写」与「历史恢复」能否绕过资产投影只读守卫。
 *
 * 靶点（读码推演）：
 * - po.values.update / po.values.delete 对 assetId 值返回 asset_projection_read_only（api.ts:347/375）；
 * - 模板组原文覆写 writeTemplateFileContent 用 assetProjectionSignatures 比对守卫（template_files.ts:571-577）；
 * - 但普通组原文覆写 writeGroupContent（personal_ontology_groups.ts:209）没有任何投影守卫，
 *   且 poLineToValue 会把方言 `@asset:<id>` 标记解析回 assetId（personal_ontology_groups.ts:270）；
 * - restoreGroupSnapshot（personal_ontology_groups.ts:786）用快照 values 整体覆盖，也无投影守卫。
 *
 * 预言（若代码确有漏洞，以下全部成立）：
 * 1. writeGroupContent 能凭空创建带 @asset: 标记的"投影值"（伪造所有权）；
 * 2. writeGroupContent 能改写/删除既有投影值的文本（绕过 asset_projection_read_only）；
 * 3. 对照组：po.values.update 对同一值被拒（守卫确实存在，只是被覆写路径绕过）；
 * 4. restoreGroupSnapshot 能把已被覆写更新的投影值回滚成旧文本（旧投影复活）。
 *
 * 2026-09-30 r1 收尾（记账员）：用例 1/3 对应待议 P-r1-11、用例 4 对应
 * P-r1-12、用例 5 对应 P-r1-13，全部 it.skip（修法 MULTI 待拍板，见
 * round-1-甄别.md toPending）。用例 2（对照组）保留 active：它锁定
 * asset_projection_read_only 守卫本身存在，不对应待议项——但其 seed 依赖
 * writeGroupContent 伪造路径造投影值，P-r1-11 修复后需改造 seed（改用真实
 * 资产投影），届时本条会先红，属已知耦合。
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
const UID = 'probe-user-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

function readDoc(): any {
  return JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
}

async function loadGroups() {
  return import('../../src/main/features/personal_ontology_groups');
}
async function loadApi() {
  return import('../../src/main/features/po/api');
}

function dialect(lines: string[]): string {
  return ['## 字段区', '', '### 常用工具', ...lines, '', '---', '', '## 流水区', ''].join('\n');
}

describe('probe r1: 普通组原文覆写绕过资产投影只读（待议项已 skip）', () => {
  // 待议 P-r1-11：普通组原文覆写无投影守卫（伪造/篡改/删除投影值）。
  // 签名不变式 vs 丢弃 assetId vs restore 同款守卫（建议 1+3 组合）待拍板。
  it.skip('writeGroupContent 能伪造 @asset: 投影值（正常 add 通道造不出来）', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '探针组');
    expect(created.ok).toBe(true);
    const groupId = created.group!.group_id;

    // 攻击面：提交文本里直接带 @asset:<id> 标记。
    const r = await groups.writeGroupContent(UID, groupId, dialect([
      '- 伪装成资产投影的值 [手动] @asset:ast_probe_1',
    ]));
    expect(r.ok).toBe(true);

    const doc = readDoc();
    const group = doc.groups.find((g: any) => g.id === groupId);
    expect(group.values).toHaveLength(1);
    // 若守卫存在，这里应当失败或 assetId 不落盘；实际断言它落了盘：
    expect(group.values[0].assetId).toBe('ast_probe_1');
  });

  // 保留 active（对照组）：锁定单值通道的 asset_projection_read_only 守卫存在。
  // 注意 seed 依赖 P-r1-11 漏洞路径伪造投影值，P-r1-11 修复后需改造（见文件头）。
  it('对照组：po.values.update / po.values.delete 对投影值拒绝（守卫本身在）', async () => {
    const groups = await loadGroups();
    const api = await loadApi();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;

    // 先经伪造路径造出投影值。
    await groups.writeGroupContent(UID, groupId, dialect([
      '- 资产维护的原文 [手动] @asset:ast_probe_1',
    ]));
    const valueId = readDoc().groups.find((g: any) => g.id === groupId).values[0].id;

    const upd = await api.poUpdateValue(UID, groupId, valueId, { text: '直接改' });
    expect(upd.ok).toBe(false);
    expect(upd.error).toBe('asset_projection_read_only');

    const del = await api.poDeleteValue(UID, groupId, valueId);
    expect(del.ok).toBe(false);
    expect(del.error).toBe('asset_projection_read_only');
  });

  // 待议 P-r1-11（同上）：篡改与删除既有投影值，覆写通道绕过只读守卫。
  it.skip('writeGroupContent 能篡改投影值文本（assetId 保留）与删除投影值', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;

    await groups.writeGroupContent(UID, groupId, dialect([
      '- 资产维护的原文 [手动] @asset:ast_probe_1',
    ]));

    // 篡改：换文本但保留 @asset 标记 → 投影内容与来源资产脱钩。
    const tamper = await groups.writeGroupContent(UID, groupId, dialect([
      '- 被篡改的投影文本 [手动] @asset:ast_probe_1',
    ]));
    expect(tamper.ok).toBe(true);
    let value = readDoc().groups.find((g: any) => g.id === groupId).values[0];
    expect(value.text).toBe('被篡改的投影文本');
    expect(value.assetId).toBe('ast_probe_1');

    // 删除：直接不提交该行 → 投影值消失，无任何拒绝。
    const wipe = await groups.writeGroupContent(UID, groupId, dialect([]));
    expect(wipe.ok).toBe(true);
    const after = readDoc().groups.find((g: any) => g.id === groupId);
    expect(after.values).toHaveLength(0);
  });

  // 待议 P-r1-12：历史快照恢复无投影守卫（旧投影复活成只读孤儿）。与 P-r1-11
  // 同根但独立入口；复核警告不能套模板签名比对（会让含投影组永远无法恢复）。
  it.skip('restoreGroupSnapshot 能把投影值回滚成旧文本（旧投影复活，无守卫）', async () => {
    const groups = await loadGroups();
    const api = await loadApi();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;

    // 第一版：投影值文本 A（改前组为空 → 不留快照）。
    await groups.writeGroupContent(UID, groupId, dialect([
      '- 投影旧文本 [手动] @asset:ast_probe_1',
    ]));
    // 第二版：模拟资产侧把投影更新成文本 B（改前非空 → 留下 A 的快照）。
    await groups.writeGroupContent(UID, groupId, dialect([
      '- 投影新文本 [手动] @asset:ast_probe_1',
    ]));

    const history = await api.poListHistory(UID, groupId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const snapId = history[0].id; // 最新一版快照 = 旧文本 A 的改前状态

    const restored = await groups.restoreGroupSnapshot(UID, groupId, snapId);
    expect(restored.ok).toBe(true);

    const value = readDoc().groups.find((g: any) => g.id === groupId).values[0];
    // 旧投影文本复活，且仍顶着资产所有权标记：
    expect(value.text).toBe('投影旧文本');
    expect(value.assetId).toBe('ast_probe_1');
  });

  // 待议 P-r1-13：writeGroupContent 值 id 保全逻辑是死代码（同文本覆写 id 必换）。
  // 方案 1（接上已算的 id）为推荐最小修，拍板后反转断言为 idAfter === idBefore。
  it.skip('附带观察：writeGroupContent 的值 id 保全逻辑是死代码（每次覆写 id 全换）', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;

    await groups.writeGroupContent(UID, groupId, dialect(['- 同文本值 [手动]']));
    const idBefore = readDoc().groups.find((g: any) => g.id === groupId).values[0].id;
    // 同文本再覆写一次：源码里算了 prior id 却没把它接到 poLineToValue 的产物上。
    await groups.writeGroupContent(UID, groupId, dialect(['- 同文本值 [手动]']));
    const idAfter = readDoc().groups.find((g: any) => g.id === groupId).values[0].id;
    // 断言 id 变了（保全失效）；若将来修好，此断言翻绿即为修复证据。
    expect(idAfter).not.toBe(idBefore);
  });
});
