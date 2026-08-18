import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExternalResource } from '../../../src/main/features/personal_context/contract';

// 只包装 writeJson 记录写盘次数（验证批量写收敛为一次），其余保持真实实现
vi.mock('../../../src/main/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/storage')>();
  return { ...actual, writeJson: vi.fn(actual.writeJson) };
});

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-pc-registry-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'test-user-1';

function resource(overrides: Partial<ExternalResource> = {}): ExternalResource {
  return {
    resourceId: 'feishu:tenant-1:calendar:cal_001',
    resourceType: 'calendar',
    sourceVersion: '2026-08-01T00:00:00.000Z',
    title: '主日历',
    ownerRef: 'feishu:union_id:on_owner',
    observedAt: '2026-08-01T00:00:00.000Z',
    accessLabel: 'personal',
    retentionPolicy: 'source-linked',
    bodyLoaded: false,
    ...overrides,
  };
}

async function loadRegistry() {
  const { buildResourceKey, parseResourceKey } = await import('../../../src/main/features/personal_context/contract');
  const { PersonalContextRegistry } = await import('../../../src/main/features/personal_context/registry');
  return { buildResourceKey, parseResourceKey, registry: new PersonalContextRegistry() };
}

describe('幂等键（contract）', () => {
  it('buildResourceKey 输出稳定且含 4 段', async () => {
    const { buildResourceKey } = await loadRegistry();
    expect(buildResourceKey('feishu', 'tenant-1', 'calendar', 'cal_001'))
      .toBe('feishu:tenant-1:calendar:cal_001');
    // 相同输入 → 相同输出（幂等键稳定）
    expect(buildResourceKey('feishu', 'tenant-1', 'calendar', 'cal_001'))
      .toBe(buildResourceKey('feishu', 'tenant-1', 'calendar', 'cal_001'));
    // 不同租户/类型/id → 不同键
    expect(buildResourceKey('feishu', 'tenant-2', 'calendar', 'cal_001')).not
      .toBe(buildResourceKey('feishu', 'tenant-1', 'calendar', 'cal_001'));
  });

  it('buildResourceKey 拒绝空段与含分隔符的脏数据', async () => {
    const { buildResourceKey } = await loadRegistry();
    expect(() => buildResourceKey('', 't', 'calendar', 'id')).toThrow();
    expect(() => buildResourceKey('feishu', 't', 'calendar', '')).toThrow();
    expect(() => buildResourceKey('feishu', 't', 'calendar', 'a:b')).toThrow();
  });

  it('parseResourceKey 与 buildResourceKey 互逆，脏数据返回 null', async () => {
    const { buildResourceKey, parseResourceKey } = await loadRegistry();
    const key = buildResourceKey('feishu', 'tenant-1', 'calendar_event', 'evt_001');
    expect(parseResourceKey(key)).toEqual({
      provider: 'feishu',
      tenant: 'tenant-1',
      type: 'calendar_event',
      stableId: 'evt_001',
    });
    expect(parseResourceKey('feishu:tenant-1:calendar')).toBeNull();
    expect(parseResourceKey('feishu::calendar:cal_1')).toBeNull();
    expect(parseResourceKey('')).toBeNull();
    expect(parseResourceKey('a:b:c:d:e')).toBeNull();
  });
});

describe('资源注册表幂等 upsert', () => {
  it('同键同版本重复 upsert 为 unchanged，不产生重复条目', async () => {
    const { registry } = await loadRegistry();
    expect((await registry.upsert(UID, resource())).change).toBe('new');
    expect((await registry.upsert(UID, resource())).change).toBe('unchanged');
    expect((await registry.upsert(UID, resource())).change).toBe('unchanged');
    expect(await registry.count(UID)).toBe(1);
  });

  it('同键新版本 → updated，保留选择状态与 firstSeenAt', async () => {
    const { registry } = await loadRegistry();
    await registry.upsert(UID, resource());
    await registry.setSelection(UID, 'feishu:tenant-1:calendar:cal_001', true);
    const before = await registry.get(UID, 'feishu:tenant-1:calendar:cal_001');

    const updated = await registry.upsert(UID, resource({ sourceVersion: '2026-08-02T00:00:00.000Z', title: '主日历 v2' }));
    expect(updated.change).toBe('updated');
    const after = await registry.get(UID, 'feishu:tenant-1:calendar:cal_001');
    expect(after?.resource.title).toBe('主日历 v2');
    expect(after?.selected).toBe(true);
    expect(after?.firstSeenAt).toBe(before?.firstSeenAt);
  });

  it('不可解析的 resourceId 拒绝写入', async () => {
    const { registry } = await loadRegistry();
    await expect(registry.upsert(UID, resource({ resourceId: 'bad:key' }))).rejects.toThrow();
    expect(await registry.count(UID)).toBe(0);
  });

  it('upsertMany 批量写入：混合 new/updated/unchanged，整批一次写盘', async () => {
    const { writeJson } = await import('../../../src/main/storage');
    const { registry } = await loadRegistry();
    // 预置一条已存在资源并选中（验证 updated 保留选择状态）
    await registry.upsert(UID, resource());
    await registry.setSelection(UID, 'feishu:tenant-1:calendar:cal_001', true);
    // 预置写入完成后清零计数：只统计 upsertMany 自己的写盘次数
    vi.mocked(writeJson).mockClear();

    const results = await registry.upsertMany(UID, [
      resource(), // 同版本 → unchanged
      resource({ sourceVersion: '2026-08-02T00:00:00.000Z', title: '主日历 v2' }), // 新版本 → updated
      resource({ resourceId: 'feishu:tenant-1:document:doc_001', resourceType: 'document', title: '文档' }), // 不存在 → new
    ]);
    expect(results.map((r) => r.change)).toEqual(['unchanged', 'updated', 'new']);
    // 性能关键：整批一次写盘（首次回填 N 条资源不再逐条全量读写 registry.json）
    expect(vi.mocked(writeJson)).toHaveBeenCalledTimes(1);
    // 状态与逐条 upsert 等价：updated 保留选择状态与 firstSeenAt
    const entry = await registry.get(UID, 'feishu:tenant-1:calendar:cal_001');
    expect(entry?.resource.title).toBe('主日历 v2');
    expect(entry?.selected).toBe(true);
    expect(await registry.count(UID)).toBe(2);
  });

  it('upsertMany 空数组：直接返回，不写盘', async () => {
    const { writeJson } = await import('../../../src/main/storage');
    vi.mocked(writeJson).mockClear();
    const { registry } = await loadRegistry();
    expect(await registry.upsertMany(UID, [])).toEqual([]);
    expect(vi.mocked(writeJson)).not.toHaveBeenCalled();
  });

  it('upsertMany 含不可解析 resourceId：整批抛错，全部不落盘（原子）', async () => {
    const { registry } = await loadRegistry();
    await expect(registry.upsertMany(UID, [
      resource(),
      resource({ resourceId: 'bad:key' }),
    ])).rejects.toThrow();
    expect(await registry.count(UID)).toBe(0);
  });
});

describe('注册表选择/失效/删除', () => {
  it('setSelection 幂等，list 按 selectedOnly 过滤', async () => {
    const { registry } = await loadRegistry();
    const r1 = resource();
    const r2 = resource({ resourceId: 'feishu:tenant-1:document:doc_001', resourceType: 'document', title: '课程大纲' });
    await registry.upsert(UID, r1);
    await registry.upsert(UID, r2);

    expect(await registry.setSelection(UID, r1.resourceId, true)).toBe(true);
    expect(await registry.setSelection(UID, r1.resourceId, true)).toBe(true); // 幂等
    expect((await registry.list(UID, { selectedOnly: true })).map((e) => e.resource.resourceId))
      .toEqual([r1.resourceId]);
    expect((await registry.list(UID, { providerId: 'feishu', types: ['document'] })).map((e) => e.resource.resourceId))
      .toEqual([r2.resourceId]);
    expect(await registry.setSelection(UID, 'feishu:tenant-1:calendar:nope', true)).toBe(false);
  });

  it('markInvalid 后默认不可见，includeInvalid 可见；再次 markInvalid 幂等', async () => {
    const { registry } = await loadRegistry();
    const r1 = resource();
    await registry.upsert(UID, r1);
    expect(await registry.markInvalid(UID, r1.resourceId, 'revoked')).toBe(true);
    expect(await registry.markInvalid(UID, r1.resourceId, 'revoked')).toBe(true); // 幂等
    expect(await registry.count(UID)).toBe(0);
    expect(await registry.count(UID, { includeInvalid: true })).toBe(1);
    const entry = await registry.get(UID, r1.resourceId);
    expect(entry?.invalidatedAt).toBeTruthy();
    expect(entry?.invalidateReason).toBe('revoked');
  });

  it('invalidateProvider 级联失效整 provider', async () => {
    const { registry } = await loadRegistry();
    await registry.upsert(UID, resource());
    await registry.upsert(UID, resource({ resourceId: 'feishu:tenant-1:document:doc_001', resourceType: 'document' }));
    await registry.upsert(UID, resource({ resourceId: 'other:tenant-1:chat:chat_001', resourceType: 'chat' }));
    const count = await registry.invalidateProvider(UID, 'feishu', 'oauth revoked');
    expect(count).toBe(2);
    expect(await registry.count(UID, { providerId: 'feishu', includeInvalid: true })).toBe(2);
    // 其他 provider 不受影响
    expect(await registry.count(UID, { providerId: 'other', includeInvalid: true })).toBe(1);
  });

  it('remove 物理删除', async () => {
    const { registry } = await loadRegistry();
    const r1 = resource();
    await registry.upsert(UID, r1);
    expect(await registry.remove(UID, r1.resourceId)).toBe(true);
    expect(await registry.remove(UID, r1.resourceId)).toBe(false);
    expect(await registry.count(UID)).toBe(0);
  });
});

describe('游标推进与回退', () => {
  it('advance 合并水位（只升不降）并维护事件幂等窗口', async () => {
    const { PersonalContextCursorStore } = await import('../../../src/main/features/personal_context/registry');
    const cursors = new PersonalContextCursorStore();

    expect(await cursors.get(UID, 'feishu')).toBeNull();

    const first = await cursors.advance(UID, 'feishu', {
      watermarks: { calendar_event: '2026-08-01T00:00:00.000Z' },
      newEventIds: ['evt_1', 'evt_2', 'evt_1'], // 重复 event id 去重
    });
    expect(first.watermarks.calendar_event).toBe('2026-08-01T00:00:00.000Z');
    expect(first.eventIdempotency).toEqual(['evt_1', 'evt_2']);

    // 水位只升不降：旧值推进不覆盖新值
    const second = await cursors.advance(UID, 'feishu', {
      watermarks: { calendar_event: '2026-07-01T00:00:00.000Z' },
      newEventIds: [],
    });
    expect(second.watermarks.calendar_event).toBe('2026-08-01T00:00:00.000Z');

    // 新水位 + 新事件
    const third = await cursors.advance(UID, 'feishu', {
      watermarks: { calendar_event: '2026-08-02T00:00:00.000Z', document: '2026-08-01T00:00:00.000Z' },
      newEventIds: ['evt_3'],
    });
    expect(third.watermarks.calendar_event).toBe('2026-08-02T00:00:00.000Z');
    expect(third.eventIdempotency).toEqual(['evt_1', 'evt_2', 'evt_3']);

    expect((await cursors.get(UID, 'feishu'))?.watermarks).toEqual(third.watermarks);
  });

  it('事件幂等窗口截断到 EVENT_IDEMPOTENCY_WINDOW', async () => {
    const { PersonalContextCursorStore } = await import('../../../src/main/features/personal_context/registry');
    const { EVENT_IDEMPOTENCY_WINDOW } = await import('../../../src/main/features/personal_context/contract');
    const cursors = new PersonalContextCursorStore();
    const ids = Array.from({ length: EVENT_IDEMPOTENCY_WINDOW + 20 }, (_, i) => `evt_${i}`);
    const next = await cursors.advance(UID, 'feishu', { newEventIds: ids });
    expect(next.eventIdempotency.length).toBe(EVENT_IDEMPOTENCY_WINDOW);
    expect(next.eventIdempotency[0]).toBe(`evt_${20}`);
    expect(next.eventIdempotency.at(-1)).toBe(`evt_${EVENT_IDEMPOTENCY_WINDOW + 19}`);
  });

  it('expectedPrev 不匹配 → CursorConflictError（并发保护）', async () => {
    const { PersonalContextCursorStore, CursorConflictError } = await import('../../../src/main/features/personal_context/registry');
    const cursors = new PersonalContextCursorStore();
    const prev = await cursors.advance(UID, 'feishu', { watermarks: { document: '2026-08-01T00:00:00.000Z' } });

    // 并发方 A 基于 prev 推进成功
    await cursors.advance(UID, 'feishu', { watermarks: { document: '2026-08-02T00:00:00.000Z' } }, { expectedPrev: prev });

    // 并发方 B 仍拿旧 prev 推进 → 冲突
    await expect(cursors.advance(UID, 'feishu', { watermarks: { document: '2026-08-03T00:00:00.000Z' } }, { expectedPrev: prev }))
      .rejects.toBeInstanceOf(CursorConflictError);
  });

  it('regress 显式回退到旧 checkpoint，返回回退前游标', async () => {
    const { PersonalContextCursorStore } = await import('../../../src/main/features/personal_context/registry');
    const cursors = new PersonalContextCursorStore();
    const checkpoint = await cursors.advance(UID, 'feishu', {
      watermarks: { calendar_event: '2026-08-01T00:00:00.000Z' },
      newEventIds: ['evt_1'],
    });
    await cursors.advance(UID, 'feishu', {
      watermarks: { calendar_event: '2026-08-02T00:00:00.000Z' },
      newEventIds: ['evt_2'],
    });

    const { previous } = await cursors.regress(UID, 'feishu', checkpoint);
    expect(previous?.watermarks.calendar_event).toBe('2026-08-02T00:00:00.000Z');

    const after = await cursors.get(UID, 'feishu');
    expect(after?.watermarks.calendar_event).toBe('2026-08-01T00:00:00.000Z');
    expect(after?.eventIdempotency).toEqual(['evt_1']);
  });

  it('regress 后可用 advance 重新推进', async () => {
    const { PersonalContextCursorStore } = await import('../../../src/main/features/personal_context/registry');
    const cursors = new PersonalContextCursorStore();
    const checkpoint = await cursors.advance(UID, 'feishu', { watermarks: { document: '2026-08-01T00:00:00.000Z' } });
    await cursors.regress(UID, 'feishu', checkpoint);
    const next = await cursors.advance(UID, 'feishu', { watermarks: { document: '2026-08-03T00:00:00.000Z' } });
    expect(next.watermarks.document).toBe('2026-08-03T00:00:00.000Z');
  });
});
