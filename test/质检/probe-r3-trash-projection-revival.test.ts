/** 资产清除、普通组及回收站恢复之间的投影引用一致性。 */

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

describe('已删资产投影借分组回收站恢复复活', () => {
  // 清除资产后恢复分组，观察回收站中的投影值是否重新出现。
  it('组删除→资产级联清（trash 不扫，对照组契约）→组恢复：已清资产的投影被过滤，不复活不锁死', async () => {
    const groups = await loadGroups();
    const templates = await loadTemplates();
    const api = await loadApi();

    // 存量数据：普通组里带 v1 迁移来的资产投影值（伪造通道已关，按存量落盘
    // 构造——迁移 toPoValue 原样保留 @asset 标记，生产语义等价）。
    const created = await groups.createGroup(UID, '探针组');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, dialect(['- 普通值占位 [手动]']));
    const doc0 = readDoc();
    const g0 = doc0.groups.find((g: any) => g.id === groupId);
    const field0 = g0.fields.find((f: any) => f.name === '常用工具');
    g0.values.push({
      id: 'v_r3', fieldId: field0.id, text: '资产维护的原文', source: '手动', assetId: ASSET,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    fs.writeFileSync(
      path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json'),
      JSON.stringify(doc0, null, 2), 'utf8');

    // 用户删除分组：投影值随组进 trash（用户意图 = 不再保留这组内容）。
    const del = await groups.deleteGroup(UID, groupId);
    expect(del.ok).toBe(true);
    expect(readDoc().groups).toHaveLength(0);
    expect(readDoc().trash).toHaveLength(1);

    // 资产侧 purge 的投影级联：只扫活组，trash 里的投影值不被清（设计口径，
    // 与本文件对照组「普通活组不被级联清理」同一边界）。
    const purge = await templates.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(true);
    expect(purge.removed).toBe(0); // 级联对 trash 零覆盖
    expect(readDoc().trash[0].group.values.some((v: any) => v.assetId === ASSET)).toBe(true);

    // 用户从回收站恢复分组（po.groups.restore 通道语义）。
    const restore = await groups.restoreDeletedGroup(UID, groupId);
    expect(restore.ok).toBe(true);

    // 应然：ASSET 记录不在 ability-assets（从未创建=purge/物理删除同构）→
    // 恢复侧过滤生效，投影值不复活；普通值与组本身照常恢复。
    const doc = readDoc();
    const revived = doc.groups.find((g: any) => g.id === groupId);
    expect(revived).toBeTruthy();
    expect(revived.values.some((v: any) => v.assetId === ASSET)).toBe(false);
    expect(revived.values.some((v: any) => v.text === '资产维护的原文')).toBe(false);
    expect(revived.values.some((v: any) => v.text === '普通值占位')).toBe(true);
    // 无锁死态：剩下的普通值走单值通道可正常删（投影值已不在，无从锁死）。
    const remaining = revived.values.find((v: any) => v.text === '普通值占位');
    const delValue = await api.poDeleteValue(UID, groupId, remaining.id);
    expect(delValue.ok).toBe(true);
  });

  // 普通活组中的投影值作为对照，区分模板组与普通组的清理范围（正确契约，启用）。
  it('对照组：普通活组中的投影值不被级联清理', async () => {
    const groups = await loadGroups();
    const templates = await loadTemplates();

    const created = await groups.createGroup(UID, '活组');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, dialect(['- 普通值占位 [手动]']));
    // 存量形态构造（与主例同款）：方言写通道已不再接受 @asset 标记，投影值
    // 按迁移遗留形态直接落在文档里（迁移 toPoValue 原样保留 assetId）。
    const doc0 = readDoc();
    const g0 = doc0.groups.find((g: any) => g.id === groupId);
    const field0 = g0.fields.find((f: any) => f.name === '常用工具');
    g0.values.push({
      id: 'v_r3c', fieldId: field0.id, text: '资产维护的原文', source: '手动', assetId: ASSET,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    });
    fs.writeFileSync(
      path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json'),
      JSON.stringify(doc0, null, 2), 'utf8');

    const purge = await templates.removeTemplateFieldValuesForRecallAsset(UID, ASSET);
    expect(purge.ok).toBe(true);
    // 核对普通组中的投影值是否仍保留，不将模板组清理推断为全组清理。
    const after = readDoc().groups.find((g: any) => g.id === groupId);
    expect(after.values.some((v: any) => v.assetId === ASSET)).toBe(true);
    expect(purge.removed).toBe(0);
  });
});
