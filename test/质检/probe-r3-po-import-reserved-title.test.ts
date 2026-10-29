/**
 * 保留标题分组的导出、再导入与相邻分组隔离：叫
 * 「字段区」/「流水区」的组在导出再导入时整组保留，不被吞并、不消失。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-r3-roundtrip';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r3-rt-'));
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

async function loadApi() {
  return import('../../src/main/features/po/api');
}

describe('导入 round-trip 保留词组保全', () => {
  it('唯一组叫「字段区」：导出再导入整组保留且可回灌；「流水区」组跟在别组后不吞并', async () => {
    const api = await loadApi();

    // 场景 1：保留词组是唯一组。
    const g1 = await api.poCreateGroup(UID, '字段区');
    expect(g1.ok).toBe(true);
    const gid1 = g1.group!.group_id;
    const f1 = await api.poCreateField(UID, gid1, '工具');
    await api.poAddValue(UID, gid1, f1.field!.id, { text: 'ZCode' });

    const exported1 = api.poExportMarkdown(UID);
    expect(exported1).toContain('## 字段区');

    // 模拟换机：清掉文档再预览导入。
    fs.rmSync(poDocFile(), { force: true });
    const preview1 = api.poImportPreview(UID, exported1);
    expect(preview1.items.length).toBe(1);
    expect(preview1.items[0].title).toBe('字段区');
    expect(preview1.items[0].fields.map((f) => f.name)).toContain('工具');
    expect(JSON.stringify(preview1.items[0])).toContain('ZCode');

    // 回灌可用：apply 后快照里组与值都在。
    const applied1 = await api.poImportApply(UID, preview1.items);
    expect(applied1.ok).toBe(true);
    const snap1 = api.getPoSnapshot(UID);
    expect(snap1.groups.some((g: any) => g.title === '字段区' && g.values.some((v: any) => v.text === 'ZCode'))).toBe(true);

    // 场景 2：保留词组跟在正常组后。
    fs.rmSync(poDocFile(), { force: true });
    const normal = await api.poCreateGroup(UID, '正常组');
    const gidN = normal.group!.group_id;
    const fN = await api.poCreateField(UID, gidN, '字段N');
    await api.poAddValue(UID, gidN, fN.field!.id, { text: '值N' });
    const g2 = await api.poCreateGroup(UID, '流水区');
    const gid2 = g2.group!.group_id;
    const f2 = await api.poCreateField(UID, gid2, '字段F');
    await api.poAddValue(UID, gid2, f2.field!.id, { text: '值F' });

    const exported2 = api.poExportMarkdown(UID);
    fs.rmSync(poDocFile(), { force: true });
    const preview2 = api.poImportPreview(UID, exported2);
    // 「流水区」作为独立组出现，不再被前组吞并。
    expect(preview2.items.map((i) => i.title)).toEqual(['正常组', '流水区']);
    const flowItem = preview2.items.find((i) => i.title === '流水区')!;
    expect(flowItem.fields.map((f) => f.name)).toContain('字段F');
    expect(JSON.stringify(flowItem)).toContain('值F');
    // 正常组里不出现流水区组的内容。
    expect(JSON.stringify(preview2.items[0])).not.toContain('值F');
  });
});
