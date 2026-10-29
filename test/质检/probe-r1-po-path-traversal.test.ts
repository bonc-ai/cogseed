/** 同步输入中的恶意组 id 不应使渲染副本或写前快照逃出授权根。 */
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
const UID = 'probe-r1-trav';
/** 逃出 WS_ROOT（tmpDir）落到 os.tmpdir() 根：渲染副本起点是
 * …/cloud/contexts/.personal_ontology_groups（5 级 `..` 到 tmpDir 之外）；
 * 快照起点是 …/cloud/cognition/po-history（4 级 `..` 即到 tmpDir，
 * 同一 id 串对两处都越界）。 */
const ESCAPE_NAME = `po-probe-r1-escape-${Date.now()}`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r1-trav-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // 清理越界产物（os.tmpdir() 下的探针文件）
  fs.rmSync(path.join(os.tmpdir(), `${ESCAPE_NAME}.md`), { force: true });
  fs.rmSync(path.join(os.tmpdir(), `${ESCAPE_NAME}.json`), { force: true });
});

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

async function loadStore() {
  return import('../../src/main/features/po/store');
}

describe('恶意 id 路径穿越', () => {
  it('组 id 含 ../ 时，渲染副本与写前快照都不越界：非法 id 丢弃并按 corrupt-guard 口径登记', async () => {
    const maliciousId = `../../../../../${ESCAPE_NAME}`;
    // 直接落一个被篡改/恶意同步的文档（normalizeGroup 不拒绝该 id）
    fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
    fs.writeFileSync(poDocFile(), JSON.stringify({
      schemaVersion: 2,
      groups: [{
        id: maliciousId,
        title: '逃逸组',
        kind: 'user',
        fields: [{ id: 'f1', name: 'F', origin: 'user', createdAt: '2026-09-01T00:00:00Z' }],
        values: [{ id: 'v1', fieldId: 'f1', text: 'x', source: '手动', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }],
        entries: [],
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      }],
      trash: [],
    }, null, 2), 'utf8');

    const store = await loadStore();
    // 常规成功写：touch 该组并改内容（走 editPoDoc → snapshotPoGroup + syncGroupRender）
    const result = await store.editPoDoc(UID, (ctx) => {
      const group = ctx.touch(maliciousId);
      if (!group) return ctx.fail('group not found');
      group.entries.push({ id: 'e1', text: 'probe', createdAt: '2026-09-30T00:00:00Z' });
      group.updatedAt = '2026-09-30T00:00:00Z';
    });
    expect(result.ok).toBe(true);

    // 应然 1：渲染副本未写出沙箱（os.tmpdir() 根没有探针文件——渲染写被丢弃）。
    const escapedMd = path.join(os.tmpdir(), `${ESCAPE_NAME}.md`);
    expect(fs.existsSync(escapedMd)).toBe(false);

    // 应然 2：写前快照同样未越界（快照侧 safeId 守卫既有，本用例一并钉住）。
    const escapedSnapshotDir = path.join(os.tmpdir(), ESCAPE_NAME);
    expect(fs.existsSync(escapedSnapshotDir)).toBe(false);

    // 应然 3：非法 id 不再被静默跳过——按 corrupt-guard 口径登记（domain 'po'，
    // 含 copy 备份 + 渲染层可见记录）。
    const { listCorruptRecords } = await import('../../src/main/util/corrupt-guard');
    expect(listCorruptRecords().some((r) => r.domain === 'po')).toBe(true);

    // 应然 4：latch 生命周期沿用 corrupt-guard 口径「读成功自愈」——po 文档字节
    // 可读，下一次 load 即清记录，因此后续编辑不整档拒写（拒写会让用户无法经
    // 正常 UI 删除毒组，只能整档重置，反成死锁）。编辑放行 = 保留自救通道。
    const again = await store.editPoDoc(UID, (ctx) => {
      const group = ctx.touch(maliciousId);
      if (!group) return ctx.fail('group not found');
      group.entries.push({ id: 'e2', text: 'probe again', createdAt: '2026-09-30T00:00:00Z' });
      group.updatedAt = '2026-09-30T00:00:00Z';
    });
    expect(again.ok).toBe(true);
    // 越界仍然没有发生（第二次写的渲染同样被丢弃）。
    expect(fs.existsSync(path.join(os.tmpdir(), `${ESCAPE_NAME}.md`))).toBe(false);
    // 触碰毒组的写会重新登记（记录 + 备份再次可见，直到毒组被移除）。
    expect(listCorruptRecords().some((r) => r.domain === 'po')).toBe(true);
  });
});
