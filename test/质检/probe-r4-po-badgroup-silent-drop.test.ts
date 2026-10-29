/**
 * po 文档单组坏档处置回归：title 为空的坏组按 corrupt-guard 口径
 * 登记（copy 备份 + 拒写 latch）——读侧仍降级（好组照常展示），下一次写被
 * 拒绝，坏组不再随写入从盘上静默永久删除。
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
const UID = 'probe-user-r4b';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r4b-'));
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

describe('回归 r4 › po 单组坏档：登记 + 拒写，不静默删除', () => {
  it('title 空的坏组：读侧降级展示好组，写被拒，盘上两组原样保留 + 备份在场', async () => {
    const groups = await import('../../src/main/features/personal_ontology_groups');

    // 手工落一份「一组好 + 一组坏（title 空）」的档：模拟手改/同步半份/schema 演进。
    const doc = {
      schemaVersion: 2,
      migratedFromV1At: '2026-09-01T00:00:00',
      groups: [
        {
          id: 'g_good', title: '好组', kind: 'user',
          fields: [{ id: 'f1', name: '常用工具', origin: 'user', createdAt: '2026-09-01T00:00:00' }],
          values: [{ id: 'v1', fieldId: 'f1', text: 'ZCode', source: '手动', createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00' }],
          entries: [],
          createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00',
        },
        {
          id: 'g_bad', title: '', kind: 'user',
          fields: [{ id: 'f2', name: '部署规则', origin: 'user', createdAt: '2026-09-01T00:00:00' }],
          values: [{ id: 'v2', fieldId: 'f2', text: '改完 → 跑测试', source: '手动', createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00' }],
          entries: [{ id: 'e1', text: '周五交周报', createdAt: '2026-09-01T00:00:00' }],
          createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00',
        },
      ],
      trash: [],
    };
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify(doc, null, 2), 'utf8');
    const bytesBefore = fs.readFileSync(poDocFile(), 'utf8');

    // 一次与坏组完全无关的小编辑（给好组加一条流水）：被写侧门拒绝。
    const r = await groups.appendToGroup(UID, 'g_good', '一次无关的编辑');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('corrupt');

    // 盘上字节原样（好组与坏组都在，未被「顺手清理」），坏档已 copy 备份。
    expect(fs.readFileSync(poDocFile(), 'utf8')).toBe(bytesBefore);
    const backups = fs.readdirSync(path.dirname(poDocFile()))
      .filter((n) => n.startsWith(`${path.basename(poDocFile())}.corrupt-`));
    expect(backups.length).toBe(1);
  });

  it('对照组：坏组从视图降级（快照/回收站/列表都不可见），恢复走 corrupt 通道', async () => {
    const groups = await import('../../src/main/features/personal_ontology_groups');
    const api = await import('../../src/main/features/po/api');

    const doc = {
      schemaVersion: 2,
      groups: [{
        id: 'g_bad', title: '', kind: 'user', fields: [], values: [], entries: [],
        createdAt: '2026-09-01T00:00:00', updatedAt: '2026-09-01T00:00:00',
      }],
      trash: [],
    };
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify(doc, null, 2), 'utf8');

    const snap = api.getPoSnapshot(UID);
    expect(snap.groups).toHaveLength(0);
    expect(snap.deleted).toHaveLength(0);
    expect(snap.counts.groups).toBe(0);
    const list = await groups.listGroups(UID);
    expect(list).toHaveLength(0);
  });
});
