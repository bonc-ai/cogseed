/**
 * personal-ontology.json schemaVersion 前向保护回归：未来版本写的
 * 文档（schemaVersion 更高）在当前版本读写不降级——未知键透传保留，一次
 * 常规写入不再单向抹除新版扩展数据。
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
const UID = 'probe-r4-schemav';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r4-sv-'));
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

describe('回归 r4 › schemaVersion 前向保护', () => {
  it('v3 文档被 v2 打开：读写透传保留 v3 扩展字段，schemaVersion 不降级', async () => {
    // 模拟新版应用写的 v3 文档：v2 兼容基线 + v3-only 扩展字段
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    const v3Doc = {
      schemaVersion: 3,
      groups: [{
        id: 'grpV3',
        title: 'v3组',
        kind: 'user',
        fields: [
          { id: 'f1', name: 'F', origin: 'user', createdAt: '2026-09-01T00:00:00Z' },
          { id: 'f2', name: 'F2', origin: 'user', createdAt: '2026-09-01T00:00:00Z', vectorHint: { dim: 768, model: 'future-embed' } },
        ],
        values: [{
          id: 'v1', fieldId: 'f1', text: 'v2认识的值', source: '手动',
          createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
          embedding: [0.1, 0.2, 0.3],
        }],
        entries: [{ id: 'e1', text: '流水', createdAt: '2026-09-01T00:00:00Z', provenance: 'v3-only' }],
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        v3Section: { autoRules: true },
      }],
      trash: [],
      v3GlobalIndex: { builtAt: '2026-10-01T00:00:00Z' },
    };
    fs.writeFileSync(poDocFile(), JSON.stringify(v3Doc, null, 2), 'utf8');

    // 当前版本（v2 代码）打开：读侧透传——组与 v3 扩展数据可见（快照视图的
    // 值/流水是展开透传，字段级未知键在视图重建中剥除、以落盘保全为准）。
    const api = await loadApi();
    const snap1 = api.getPoSnapshot(UID);
    expect(snap1.groups.length).toBe(1);
    expect(JSON.stringify(snap1)).toContain('embedding');

    // 一次常规写（记一笔）。
    const added = await api.poAddEntry(UID, 'grpV3', '当前版本写入的流水');
    expect(added.ok).toBe(true);

    // 落盘后：schemaVersion 保持 3，v3 扩展字段全部保留。
    const persisted = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(persisted.schemaVersion).toBe(3);
    expect(JSON.stringify(persisted)).toContain('vectorHint');
    expect(JSON.stringify(persisted)).toContain('embedding');
    expect(JSON.stringify(persisted)).toContain('v3Section');
    expect(JSON.stringify(persisted)).toContain('v3GlobalIndex');
    // v2 认识的基线数据也在，新写的流水也在。
    expect(persisted.groups[0].values[0].text).toBe('v2认识的值');
    expect(persisted.groups[0].fields.some((f: any) => f.id === 'f2')).toBe(true);
    expect(persisted.groups[0].entries.some((e: any) => e.text === '当前版本写入的流水')).toBe(true);
  });
});
