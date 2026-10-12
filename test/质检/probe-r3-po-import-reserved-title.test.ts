/**
 * 红队探针 r3：导出→导入 round-trip 丢组——组标题恰为方言保留标题
 * 「字段区」/「流水区」时，该组在导入解析中整体消失或内容并入别组。
 *
 * 推演链：poExportMarkdown（po/api.ts:462-473）按组输出 `## ${group.title}`，
 * 对标题无保留词检查；poImportPreview（po/api.ts:503-517）扫到
 * `## 字段区` / `## 流水区` 时按「组内保留标题」豁免——不切组、该行并入
 * 上一个 current 的正文。于是：
 * - 保留词组是**第一个组**：current=null，标题行被丢弃，该组及全部内容
 *   从导入结果中消失（数据丢失）；
 * - 保留词组在**其他组之后**：它的标题行与全部字段/值并入前一个组的
 *   正文，被前一组吃掉（数据串组）。
 * createGroup/createEntry 对标题无保留词校验，用户随手就能建出这种组。
 *
 * 2026-09-30 r3 收尾（记账员）：对应待议 P-r3-4（入口校验拒保留词 /
 * 导入端豁免状态机 / 导出端格式隔离，推荐 1+2 组合待拍板）→ it.skip。
 * 断言锁定的是「现状 round-trip 丢组」，拍板修复后反转。复核另发现的
 * 模板组 `## 分节` 同族碎裂疑点在拍板时一并排查。见 round-3-甄别.md。
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

describe('probe r3 › 导入 round-trip 保留词丢组（待议 P-r3-4，拍板前 skip）', () => {
  it.skip('唯一组叫「字段区」时，导出再导入整组消失；跟在别组后则被前组吞并', async () => {
    const api = await loadApi();

    // 场景 1：保留词组是唯一组
    const g1 = await api.poCreateGroup(UID, '字段区');
    expect(g1.ok).toBe(true);
    const gid1 = g1.group!.group_id;
    const f1 = await api.poCreateField(UID, gid1, '工具');
    await api.poAddValue(UID, gid1, f1.field!.id, { text: 'ZCode' });

    const exported1 = api.poExportMarkdown(UID);
    expect(exported1).toContain('## 字段区');

    // 模拟换机：清掉文档再预览导入
    fs.rmSync(poDocFile(), { force: true });
    const preview1 = api.poImportPreview(UID, exported1);
    // 唯一组整体消失（数据丢失实锤）
    expect(preview1.items.length).toBe(0);

    // 场景 2：保留词组跟在正常组后
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
    // 「流水区」组不再作为独立组出现
    expect(preview2.items.map((i) => i.title)).toEqual(['正常组']);
    // 它的内容被并入「正常组」的解析（串组实锤——preview 第一组的字段里
    // 出现本属于「流水区」的字段F/值F，或进了流水条目）
    const normalItem = preview2.items[0];
    const flattened = JSON.stringify(normalItem);
    expect(flattened).toContain('值F');
  });
});
