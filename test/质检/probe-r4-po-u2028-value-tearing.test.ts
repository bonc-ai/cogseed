/**
 * 回归 r4 › U+2028/U+2029 单行值剥除：行/段分隔符写读两侧统一
 * 剥除，方言副本不再被撕裂，导出导入与原文视图「原样保存」round-trip 不丢
 * 值；存量含 U+2028 的值读入时收敛。
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

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

async function loadApi() {
  return import('../../src/main/features/po/api');
}
async function loadGroups() {
  return import('../../src/main/features/personal_ontology_groups');
}

describe('回归 r4 › U+2028 写读剥除与 round-trip 保全', () => {
  it('值含 U+2028：写入即剥除，导出导入与原文视图 round-trip 不丢字段不丢值', async () => {
    const api = await loadApi();
    const groups = await loadGroups();
    const g = await api.poCreateGroup(UID, 'U2028组');
    const gid = g.group!.group_id;
    const f = await api.poCreateField(UID, gid, '字段X');
    const text = `前半${'\u2028'}后半`;
    const added = await api.poAddValue(UID, gid, f.field!.id, { text });
    // 写入被接受，但单行值不携带行分隔符。
    expect(added.ok).toBe(true);
    const snap1 = api.getPoSnapshot(UID);
    expect(snap1.groups[0].values[0].text).toBe('前半后半');

    // 导出不携带 U+2028；round-trip 字段与值都在。
    const exported = api.poExportMarkdown(UID);
    expect(exported).not.toContain('\u2028');
    const preview = api.poImportPreview(UID, exported);
    expect(preview.items.length).toBe(1);
    expect(preview.items[0].fields.length).toBe(1);
    expect(preview.items[0].fields[0].values.some((v) => v.value === '前半后半')).toBe(true);

    // 原文视图「原样保存」：内容干净，写回不丢值不丢字段。
    const content = await groups.readGroupContent(UID, gid);
    expect(content.ok).toBe(true);
    expect(content.content).not.toContain('\u2028');
    const saved = await groups.writeGroupContent(UID, gid, content.content!);
    expect(saved.ok).toBe(true);
    const snap2 = api.getPoSnapshot(UID);
    expect(snap2.groups[0].values.length).toBe(1);
    expect(snap2.groups[0].fields.length).toBe(1);
  });

  it('存量含 U+2028 的值：读入收敛剥除（只读兼容，不改写盘上字节）', async () => {
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify({
      schemaVersion: 2,
      groups: [{
        id: 'g-legacy', title: '存量组', kind: 'user',
        fields: [{ id: 'f1', name: 'F', origin: 'user', createdAt: '2026-09-01T00:00:00Z' }],
        values: [{ id: 'v1', fieldId: 'f1', text: `旧${'\u2028'}值`, source: '手动', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
        entries: [],
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      }],
      trash: [],
    }), 'utf8');
    const api = await loadApi();
    const snap = api.getPoSnapshot(UID);
    expect(snap.groups[0].values[0].text).toBe('旧值');
    // 盘上字节未动（读侧收敛，不主动重写）。
    expect(fs.readFileSync(poDocFile(), 'utf8')).toContain('\u2028');
  });
});
