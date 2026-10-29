/** 统一候选池：同槽顶替、列表排序、确认落库与精确重放幂等、拒绝、
 * 延后和到期恢复；拒绝非 proposed 变更、坏档写入和已决定条目的重复决定。 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ck-pool-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function poolFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'cognition-pool.json');
}

function storeFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'cognition-store.json');
}

function mods() {
  return Promise.all([
    import('../../../../src/main/features/cognition_kernel/pool'),
    import('../../../../src/main/features/cognition_kernel/delta'),
    import('../../../../src/main/features/cognition_kernel/store'),
  ]).then(([pool, delta, store]) => ({ pool, delta, store }));
}

function proposed(delta: { op: 'add' | 'update' | 'remove' | 'set'; home: string; after: string; fieldName?: string; groupId?: string; origin?: string }) {
  return mods().then(({ delta: d }) =>
    d.buildDelta({
      op: delta.op,
      target: {
        home: delta.home as never,
        ...(delta.fieldName ? { fieldName: delta.fieldName } : {}),
        ...(delta.groupId ? { groupId: delta.groupId } : {}),
      },
      origin: (delta.origin ?? 'gap') as never,
      after: delta.after,
      status: 'proposed',
    }),
  );
}

describe('cognition_kernel/pool — 统一候选池', () => {
  it('提议入池 → pending；confirm → 统一库落地 + 版本流', async () => {
    const { pool, store } = await mods();
    const d = await proposed({ op: 'set', home: 'personal_fact', fieldName: '部门', after: '开源项目组', origin: 'gap' });
    const submit = await pool.submitToPool(UID, d, { sourceKind: 'judge' });
    expect(submit.ok).toBe(true);
    expect(pool.loadPoolSync(UID).items[0].status).toBe('pending');
    expect(fs.existsSync(storeFile())).toBe(false); // 池不动主档

    const decide = await pool.decidePoolItem(UID, submit.itemId as string, 'confirm');
    expect(decide.ok).toBe(true);
    const doc = store.loadCognitionStoreSync(UID);
    const obj = Object.values(doc.objects)[0];
    expect(obj.statement).toBe('开源项目组');
    expect(pool.loadPoolSync(UID).items[0].status).toBe('confirmed');
    const versions = store.listCognitionVersions(UID, obj.id);
    expect(versions).toHaveLength(1);
  });

  it('同槽位顶替：旧 pending → rejected(superseded)，池内每槽只留最新', async () => {
    const { pool } = await mods();
    const d1 = await proposed({ op: 'set', home: 'personal_fact', fieldName: '城市', after: '北京', origin: 'gap' });
    const s1 = await pool.submitToPool(UID, d1);
    const d2 = await proposed({ op: 'set', home: 'personal_fact', fieldName: '城市', after: '上海', origin: 'gap' });
    const s2 = await pool.submitToPool(UID, d2);
    expect(s2.ok).toBe(true);
    expect(s2.supersededId).toBe(s1.itemId);

    const view = pool.listPool(UID, { status: 'pending' });
    expect(view.items).toHaveLength(1);
    expect(view.items[0].delta.after).toBe('上海');
    const old = pool.loadPoolSync(UID).items.find((i) => i.id === s1.itemId);
    expect(old?.status).toBe('rejected');
    expect(old?.supersededBy).toBe(s2.itemId);
  });

  it('confirm 幂等重试：库已落地，重复 confirm 被统一库幂等索引安全拦下', async () => {
    const { pool } = await mods();
    const d = await proposed({ op: 'add', home: 'rule', after: '报价不承诺交期', origin: 'gap' });
    const s = await pool.submitToPool(UID, d);
    const first = await pool.decidePoolItem(UID, s.itemId as string, 'confirm');
    expect(first.ok).toBe(true);
    // 状态已 confirmed，再 confirm 直接拒绝（不会双落地）。
    const second = await pool.decidePoolItem(UID, s.itemId as string, 'confirm');
    expect(second.ok).toBe(false);
    expect(second.error).toContain('confirmed');
  });

  it('reject / defer / 到期回 pending', async () => {
    const { pool } = await mods();
    const d1 = await proposed({ op: 'add', home: 'template', after: '周报三段式', origin: 'user' });
    const s1 = await pool.submitToPool(UID, d1);
    const d2 = await proposed({ op: 'add', home: 'method', after: '整理材料五步法', origin: 'user' });
    const s2 = await pool.submitToPool(UID, d2);

    expect(await pool.decidePoolItem(UID, s1.itemId as string, 'reject', { note: '不要' })).toMatchObject({ ok: true });
    expect((await pool.decidePoolItem(UID, s2.itemId as string, 'defer', { resumeAt: '2026-10-02T00:00:00Z' })).ok).toBe(true);

    const resumed = await pool.resumeDuePoolItems(UID, '2026-10-03T00:00:00Z');
    expect(resumed).toBe(1);
    const item = pool.loadPoolSync(UID).items.find((i) => i.id === s2.itemId);
    expect(item?.status).toBe('pending');
  });

  it('排序：pending 优先于 deferred/confirmed/rejected；同态新→旧', async () => {
    const { pool } = await mods();
    const d1 = await proposed({ op: 'add', home: 'rule', after: 'r1', origin: 'gap' });
    const s1 = await pool.submitToPool(UID, d1);
    const d2 = await proposed({ op: 'add', home: 'rule', after: 'r2', origin: 'gap' });
    const s2 = await pool.submitToPool(UID, d2);
    await pool.decidePoolItem(UID, s2.itemId as string, 'confirm');
    const view = pool.listPool(UID);
    expect(view.items[0].status).toBe('pending');
    expect(view.items[0].id).toBe(s1.itemId);
  });

  it('裸 add 不同内容共存：同家两条不同规则提议互不顶替（范围化槽位才顶替）', async () => {
    const { pool } = await mods();
    const d1 = await proposed({ op: 'add', home: 'rule', after: '报价不承诺交期', origin: 'gap' });
    const s1 = await pool.submitToPool(UID, d1);
    const d2 = await proposed({ op: 'add', home: 'rule', after: '发票抬头必须写全称', origin: 'gap' });
    const s2 = await pool.submitToPool(UID, d2);
    expect(s2.supersededId).toBeUndefined();
    expect(pool.listPool(UID, { status: 'pending' }).items).toHaveLength(2);
    expect(s1.itemId).toBeTruthy();
  });

  it('只收 proposed：applied 直接拒收', async () => {
    const { pool, delta } = await mods();
    const applied = delta.buildDelta({
      op: 'set',
      target: { home: 'personal_fact' as never, fieldName: 'x' },
      origin: 'user' as never,
      after: 'y',
    });
    const r = await pool.submitToPool(UID, applied);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('proposed');
  });

  it('坏档写侧拒绝：池文件坏 JSON → 拒写不覆盖', async () => {
    fs.mkdirSync(path.dirname(poolFile()), { recursive: true });
    fs.writeFileSync(poolFile(), '{broken', 'utf8');
    const { pool } = await mods();
    const d = await proposed({ op: 'add', home: 'rule', after: 'x', origin: 'gap' });
    const r = await pool.submitToPool(UID, d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('corrupt');
    expect(fs.readFileSync(poolFile(), 'utf8')).toBe('{broken');
  });

  it('坏档不整写：schemaVersion 不符 → 空池展示 + 登记坏档 + 写侧拒写不覆盖', async () => {
    fs.mkdirSync(path.dirname(poolFile()), { recursive: true });
    // 合法 JSON 但整档形状不符（未来版本/手改）：此前被当空池，下一次 submit
    // 会以空池整写覆盖——待确认提议静默全丢。
    const legacy = { schemaVersion: 99, items: [{ id: 'pi-pending-1', status: 'pending' }], unrouted: [], updatedAt: '2026-10-01T00:00:00Z' };
    fs.writeFileSync(poolFile(), JSON.stringify(legacy), 'utf8');
    const { pool } = await mods();
    // 读侧降级空池仅供展示；坏档已登记（写侧拒写）。
    expect(pool.loadPoolSync(UID).items).toEqual([]);
    const d = await proposed({ op: 'add', home: 'rule', after: 'x', origin: 'gap' });
    const r = await pool.submitToPool(UID, d);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('corrupt');
    // 盘上原档不被整写覆盖（legacy items 仍在，等人工/迁移处置）。
    expect(JSON.parse(fs.readFileSync(poolFile(), 'utf8'))).toEqual(legacy);
    // resume 同款坏档门：不触碰坏档，返回 0。
    expect(await pool.resumeDuePoolItems(UID, '2026-10-03T00:00:00Z')).toBe(0);
    expect(JSON.parse(fs.readFileSync(poolFile(), 'utf8'))).toEqual(legacy);
  });

  it('resume 走锁与原子写：到期条目回 pending 且坏档门内不落盘', async () => {
    const { pool } = await mods();
    const d = await proposed({ op: 'add', home: 'rule', after: '到期恢复条目', origin: 'gap' });
    const s = await pool.submitToPool(UID, d);
    expect((await pool.decidePoolItem(UID, s.itemId as string, 'defer', { resumeAt: '2026-10-02T00:00:00Z' })).ok).toBe(true);
    // resume 现与 submit/decide 同款 fileEditLock + storage 原子写，且幂等。
    expect(await pool.resumeDuePoolItems(UID, '2026-10-03T00:00:00Z')).toBe(1);
    expect(await pool.resumeDuePoolItems(UID, '2026-10-03T00:00:00Z')).toBe(0);
    const item = pool.loadPoolSync(UID).items.find((i) => i.id === s.itemId);
    expect(item?.status).toBe('pending');
  });
});
