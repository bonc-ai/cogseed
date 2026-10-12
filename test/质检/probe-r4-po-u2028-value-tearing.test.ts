/**
 * 红队探针 r4：U+2028/U+2029（行/段分隔符）穿透 sanitizePoText 落进值文本，
 * 撕裂方言副本并使 round-trip 静默丢值——原文编辑器「原样保存」即丢数据。
 *
 * 推演链：sanitizePoText（po/model.ts:114-126）只压 `[\r\n\t]+`，U+2028/
 * U+2029 不在其中，普通输入（网页复制文本常见）即落进 PoValue.text 与 JSON
 * 单源；渲染副本 serializeFieldValueLine（po/dialect.ts:176）直接拼接。
 * 而 JS 正则的 `.` 与 `\s` 都把 U+2028/2029 当行终止符/空白
 * （parseFieldValueLine 的 `(.+) \[(\S+)\]`，dialect.ts:138）——含 U+2028
 * 的值行在方言 parse 中整行失配返回 null：
 * - parseFieldSections：`if (values.length) fields[name]=values` → **字段整体消失**；
 * - writeGroupContent（组原文视图「原样保存」）：readGroupContent 现渲染的
 *   文本（含 U+2028）不经改动写回 → parse 丢值 → **JSON 单源里的值被静默删除**。
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
const UID = 'probe-r4-u2028';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r4-u2028-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadApi() {
  return import('../../src/main/features/po/api');
}
async function loadGroups() {
  return import('../../src/main/features/personal_ontology_groups');
}

describe('probe r4 › U+2028 撕裂方言副本并致 round-trip 丢值', () => {
  it('值含 U+2028：写入成功落盘，导出导入丢字段，原文视图原样保存丢值', async () => {
    const api = await loadApi();
    const groups = await loadGroups();
    const g = await api.poCreateGroup(UID, 'U2028组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段X');
    const text = `前半${'\u2028'}后半`;
    const added = await api.poAddValue(UID, gid, f.field!.id, { text });
    // 写入被接受（sanitizePoText 不清 U+2028）
    expect(added.ok).toBe(true);
    // JSON 单源里原样存在
    const snap1 = api.getPoSnapshot(UID);
    expect(snap1.groups[0].values[0].text).toBe(text);

    // 导出 → 导入 round-trip：含 U+2028 的值行 parse 失配 → 字段整体消失
    const exported = api.poExportMarkdown(UID);
    expect(exported).toContain('\u2028');
    const preview = api.poImportPreview(UID, exported);
    expect(preview.items.length).toBe(1);
    expect(preview.items[0].fields.length).toBe(0);

    // 更狠的链：原文视图「原样保存」——readGroupContent 现渲染（含 U+2028）
    // 不经用户改动写回，parse 丢值 → JSON 单源里的值被静默删除
    const content = await groups.readGroupContent(UID, gid);
    expect(content.ok).toBe(true);
    expect(content.content).toContain('\u2028');
    const saved = await groups.writeGroupContent(UID, gid, content.content!);
    expect(saved.ok).toBe(true);
    const snap2 = api.getPoSnapshot(UID);
    expect(snap2.groups[0].values.length).toBe(0);
    // 字段也随值一起消失（parseFieldSections 只收非空字段）
    expect(snap2.groups[0].fields.length).toBe(0);
  });
});
