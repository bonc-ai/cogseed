/** 分组全文覆写和历史恢复入口的资产投影只读边界；单值入口作为对照。 */

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

function writeDoc(doc: any): void {
  fs.writeFileSync(poDocFile(), JSON.stringify(doc, null, 2), 'utf8');
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

/**
 * 存量投影值构造（夹具）：全文覆写的伪造通道关闭后，普通组里的 @asset 投影
 * 只可能来自历史存量（v1 迁移原样保留 @asset 标记、修复前文档），因此直接
 * 落盘构造——等价于迁移产物，不经过任何写入口。id 固定 v_seed 便于断言身份。
 */
function seedProjectedValue(groupId: string, text: string, assetId: string): void {
  const doc = readDoc();
  const group = doc.groups.find((g: any) => g.id === groupId);
  const field = group.fields.find((f: any) => f.name === '常用工具');
  group.values.push({
    id: 'v_seed', fieldId: field.id, text, source: '手动', assetId,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  });
  writeDoc(doc);
}

/** 模拟宿主侧资产同步把投影文本从 A 换成 B（先清后写，落盘等价操作）。 */
function rewriteProjectedValueText(groupId: string, text: string): void {
  const doc = readDoc();
  const group = doc.groups.find((g: any) => g.id === groupId);
  const value = group.values.find((v: any) => v.assetId);
  value.text = text;
  writeDoc(doc);
}

describe('普通组原文覆写绕过资产投影只读', () => {
  // 全文覆写入口的投影伪造、篡改与删除边界（反转后：一律拒绝）。
  it('writeGroupContent 拒绝伪造 @asset: 投影值（提交现盘不存在的投影标记）', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '探针组');
    expect(created.ok).toBe(true);
    const groupId = created.group!.group_id;

    // 攻击面：提交文本里直接带 @asset:<id> 标记。
    const r = await groups.writeGroupContent(UID, groupId, dialect([
      '- 伪装成资产投影的值 [手动] @asset:ast_probe_1',
    ]));
    // 应然：伪造被拒，标记不落盘。
    expect(r.ok).toBe(false);
    expect(r.error).toBe('asset_projection_read_only');
    const group = readDoc().groups.find((g: any) => g.id === groupId);
    expect(group.values).toHaveLength(0);
  });

  // 对照单值通道的只读守卫；投影值按存量数据构造（伪造通道已关）。
  it('对照组：po.values.update / po.values.delete 对投影值拒绝（守卫本身在）', async () => {
    const groups = await loadGroups();
    const api = await loadApi();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, dialect(['- 普通值占位 [手动]']));

    seedProjectedValue(groupId, '资产维护的原文', 'ast_probe_1');
    const valueId = readDoc().groups.find((g: any) => g.id === groupId).values.find((v: any) => v.assetId).id;

    const upd = await api.poUpdateValue(UID, groupId, valueId, { text: '直接改' });
    expect(upd.ok).toBe(false);
    expect(upd.error).toBe('asset_projection_read_only');

    const del = await api.poDeleteValue(UID, groupId, valueId);
    expect(del.ok).toBe(false);
    expect(del.error).toBe('asset_projection_read_only');
  });

  // 覆写入口对既有投影值的修改与删除（反转后：拒绝；原样回显仍放行）。
  it('writeGroupContent 不能篡改或删除投影值；原文回显保存放行且保全身份', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, dialect(['- 普通值占位 [手动]']));
    seedProjectedValue(groupId, '资产维护的原文', 'ast_probe_1');

    // 篡改：换文本但保留 @asset 标记 → 拒绝，正文不动。
    const tamper = await groups.writeGroupContent(UID, groupId, dialect([
      '- 被篡改的投影文本 [手动] @asset:ast_probe_1',
    ]));
    expect(tamper.ok).toBe(false);
    expect(tamper.error).toBe('asset_projection_read_only');
    let value = readDoc().groups.find((g: any) => g.id === groupId).values.find((v: any) => v.assetId);
    expect(value.text).toBe('资产维护的原文');

    // 删除：提交文本漏掉投影行 → 拒绝，投影不随覆写消失。
    const wipe = await groups.writeGroupContent(UID, groupId, dialect(['- 普通值占位 [手动]']));
    expect(wipe.ok).toBe(false);
    expect(wipe.error).toBe('asset_projection_read_only');
    const after = readDoc().groups.find((g: any) => g.id === groupId);
    expect(after.values.some((v: any) => v.assetId === 'ast_probe_1')).toBe(true);

    // 原样回显：readGroupContent 渲染的原文不经改动保存 → 放行（投影身份保全）。
    const echo = await groups.readGroupContent(UID, groupId);
    expect(echo.ok).toBe(true);
    const save = await groups.writeGroupContent(UID, groupId, echo.content!);
    expect(save.ok).toBe(true);
    const kept = readDoc().groups.find((g: any) => g.id === groupId).values.find((v: any) => v.assetId);
    expect(kept.text).toBe('资产维护的原文');
    expect(kept.id).toBe('v_seed');
  });

  // 历史快照恢复入口也须维持资产投影身份与只读约束（反转后：集合不一致即拒）。
  it('restoreGroupSnapshot 不能把投影值回滚成旧文本（快照与现盘投影集合不一致即拒绝）', async () => {
    const groups = await loadGroups();
    const api = await loadApi();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;

    // 第一版：投影值文本 A（存量构造；首写前组为空 → 不留快照）。
    await groups.writeGroupContent(UID, groupId, dialect(['- 普通值占位 [手动]']));
    seedProjectedValue(groupId, '投影旧文本', 'ast_probe_1');
    // 第二版：触发写前留档（快照含 A），再模拟资产侧把投影更新成文本 B。
    await groups.appendToGroup(UID, groupId, 'snapshot trigger');
    rewriteProjectedValueText(groupId, '投影新文本');

    const history = await api.poListHistory(UID, groupId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    const snapId = history[0].id; // 最新一版快照 = 含 A 的改前状态

    const restored = await groups.restoreGroupSnapshot(UID, groupId, snapId);
    // 应然：回滚被拒（asset_projection_read_only），旧投影文本不复活，现盘保持 B。
    expect(restored.ok).toBe(false);
    expect(restored.error).toBe('asset_projection_read_only');
    const value = readDoc().groups.find((g: any) => g.id === groupId).values.find((v: any) => v.assetId);
    expect(value.text).toBe('投影新文本');
  });

  // 重复覆写相同文本时的值 id 稳定性（保全已修复：同文本沿用旧值 id）。
  it('writeGroupContent 同文本再覆写沿用旧值 id（值身份保全）', async () => {
    const groups = await loadGroups();
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;

    await groups.writeGroupContent(UID, groupId, dialect(['- 同文本值 [手动]']));
    const idBefore = readDoc().groups.find((g: any) => g.id === groupId).values[0].id;
    await groups.writeGroupContent(UID, groupId, dialect(['- 同文本值 [手动]']));
    const idAfter = readDoc().groups.find((g: any) => g.id === groupId).values[0].id;
    // 保全生效：id 不变（po.values.* 按 id 寻址、cognition 对象身份哈希含该 id）。
    expect(idAfter).toBe(idBefore);
  });
});
