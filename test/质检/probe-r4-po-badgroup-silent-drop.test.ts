/**
 * 红队探针 r4：po 文档单组坏档被 normalize 静默丢弃，且随下一次任何写入
 * 从盘上永久消失（数据完整性兜底面的另一个极端）。
 *
 * 靶点（读码推演）：
 * - normalizeGroup（po/model.ts:187-190）title 为空 → return null → 该组被
 *   normalizePoDocument 直接丢弃，**无任何日志/告警**（对照 loadPoDocSync 对
 *   整档 JSON 解析失败至少有 log.warn :70-72）；
 * - loadPoDocSync「永不写盘」，但丢弃发生在内存 doc 上——下一次任何
 *   editPoDoc（用户任何一处编辑/后台投影写）load→normalize（丢组）→writeJson，
 *   坏组从盘上**静默永久删除**（连同它的 fields/values/entries 与历史引用）；
 * - 与 cognition readStore 的策略恰成两个极端：cognition 一条坏资产=整库拒绝
 *   （见本轮 probe-r4-cognition-badasset-fullstore），po 一条坏组=静默丢数据。
 *   两边都没有「坏条目可见/可救」的中间态。
 *
 * 预言：两组落盘（一组 title 空）→ 一次无关的小编辑 → 坏组从盘上消失，
 * 全程无错误返回。
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

describe('probe r4: po 单组坏档被静默丢弃并随下一次写入永久删除', () => {
  it('title 空的坏组：读侧丢弃 → 一次无关编辑 → 盘上消失，全程 ok', async () => {
    const groups = await import('../../src/main/features/personal_ontology_groups');

    // 手工落一份"一组好 + 一组坏（title 空）"的档：模拟手改/同步半份/schema 演进。
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
          id: 'g_bad', title: '', kind: 'user', // normalizeGroup :189-190 → null
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

    // 一次与坏组完全无关的小编辑（给好组加一条流水）。
    const r = await groups.appendToGroup(UID, 'g_good', '一次无关的编辑');
    expect(r.ok).toBe(true);

    // 坏组已从盘上消失——连同它的字段/值/流水，无错误、无日志、无回收站。
    const after = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(after.groups.map((g: any) => g.id)).toEqual(['g_good']);
    expect(after.trash).toHaveLength(0);
  });

  it('对照组：坏组只是本轮被丢，此前它的历史快照目录仍留在盘上（无入口可救）', async () => {
    // 历史快照按 groupId 存目录：组被静默删后快照成为孤儿——po.history.list
    // 需要传入 groupId，而组已从快照(snapshot)/回收站双双消失，UI 无路可达。
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

    // 快照视图（po.snapshot）与回收站（po.deleted.list）都看不到它：
    const snap = api.getPoSnapshot(UID);
    expect(snap.groups).toHaveLength(0);
    expect(snap.deleted).toHaveLength(0);
    expect(snap.counts.groups).toBe(0);
    // 但组目录的历史仍占着（若此前有快照）——数据在盘上、界面无门。
    const list = await groups.listGroups(UID);
    expect(list).toHaveLength(0);
  });
});
