/**
 * 红队探针 r4：personal-ontology.json 无 schemaVersion 前向保护——旧版本
 * 二进制打开未来版本文档，一次常规写入就把 v3 字段静默抹除并把版本号降回 2。
 *
 * 推演链：normalizePoDocument（po/model.ts:226-246）从 emptyPoDocument()
 * （PO_SCHEMA_VERSION=2）出发，**不检查 raw.schemaVersion**，只挑 v2 认识的
 * 字段；editPoDoc（po/store.ts:235）把 normalize 结果原样 writeJson。于是
 * schemaVersion 高于当前版本的文档（回滚升级 / 双版本并存 / 云同步自新版
 * 设备）被 v2 规则"修复"：未知字段全部丢弃、schemaVersion 降级写回——
 * 新版应用写的任何扩展数据在旧版的一次写操作后单向丢失。
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

describe('probe r4 › schemaVersion 无前向保护', () => {
  it('v3 文档被 v2 打开：一次写操作抹除 v3 扩展字段并降级 schemaVersion', async () => {
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

    // 旧版本（当前 v2 代码）打开：读路径静默降级
    const api = await loadApi();
    const snap1 = api.getPoSnapshot(UID);
    expect(snap1.groups.length).toBe(1); // 组还在（v2 兼容基线）
    expect(JSON.stringify(snap1)).not.toContain('vectorHint');

    // 一次常规写（记一笔）
    const added = await api.poAddEntry(UID, 'grpV3', '旧版写入的流水');
    expect(added.ok).toBe(true);

    // 落盘后：schemaVersion 降回 2，v3 扩展字段全部消失
    const persisted = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(persisted.schemaVersion).toBe(2);
    expect(JSON.stringify(persisted)).not.toContain('vectorHint');
    expect(JSON.stringify(persisted)).not.toContain('embedding');
    expect(JSON.stringify(persisted)).not.toContain('v3Section');
    expect(JSON.stringify(persisted)).not.toContain('v3GlobalIndex');
    // v2 认识的基线数据还在（降级不是全删，是静默截断）
    expect(persisted.groups[0].values[0].text).toBe('v2认识的值');
    // f2 字段因 v3-only 属性只是被剥属性，字段本体保留（normalize 只丢未知键）
    expect(persisted.groups[0].fields.some((f: any) => f.id === 'f2')).toBe(true);
  });
});
