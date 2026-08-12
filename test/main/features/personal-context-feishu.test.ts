import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FeishuApiClient } from '../../../src/main/features/personal_context/feishu/api-client';
import type { FeishuCalendar, FeishuCalendarEvent, FeishuChat, FeishuDriveFile, FeishuWikiNode } from '../../../src/main/features/personal_context/feishu/types';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pc-feishu-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UID = 'test-user-1';
const TENANT = 'tenant-1';
const UNION_ID = 'on_me';

const cal: FeishuCalendar = { calendar_id: 'cal_001', summary: '主日历', visibility: 'private', updated_at: '2026-08-01T00:00:00.000Z' };
const event1: FeishuCalendarEvent = {
  event_id: 'evt_001',
  summary: '数据结构课',
  start_time: 1785000000000,
  end_time: 1785003600000,
  visibility: 'private',
  updated_at: '2026-08-01T08:00:00.000Z',
};
const event2: FeishuCalendarEvent = {
  event_id: 'evt_002',
  summary: '组会',
  visibility: 'default',
  updated_at: '2026-08-02T08:00:00.000Z',
};
const folder: FeishuDriveFile = { file_token: 'fld_001', name: '课程资料', type: 'folder', updated_at: '2026-08-01T00:00:00.000Z' };
const docx: FeishuDriveFile = { file_token: 'doc_001', name: '实验指导书', type: 'docx', parent_token: 'fld_001', updated_at: '2026-08-01T00:00:00.000Z' };
const wikiNode: FeishuWikiNode = { node_token: 'nd_001', obj_token: 'wk_doc_001', obj_type: 'docx', title: '学期计划', space_id: 'sp_001', updated_at: '2026-08-01T00:00:00.000Z' };
const chat: FeishuChat = { chat_id: 'oc_001', name: '课程讨论组', updated_at: '2026-08-01T00:00:00.000Z' };

function mockClient(overrides: Partial<FeishuApiClient> = {}): FeishuApiClient & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    calendars: [], events: [], drive: [], wiki: [], chats: [], health: [],
  };
  return {
    calls,
    async listCalendars() {
      calls.calendars.push([]);
      return [cal];
    },
    async listCalendarEvents(calendarId: string, range: { start: string; end: string }, updatedAfter?: string) {
      calls.events.push([calendarId, range, updatedAfter]);
      const all = [event1, event2];
      if (!updatedAfter) return all;
      return all.filter((e) => e.updated_at && e.updated_at > updatedAfter);
    },
    async listDriveFiles() {
      calls.drive.push([]);
      return [folder, docx];
    },
    async listWikiNodes() {
      calls.wiki.push([]);
      return [wikiNode];
    },
    async listChats() {
      calls.chats.push([]);
      return [chat];
    },
    async healthCheck() {
      calls.health.push([]);
      return { ok: true };
    },
    ...overrides,
  };
}

describe('normalize 标准化与幂等键', () => {
  it('日历事件：幂等键含 tenant/类型/event_id，sourceVersion=updated_at', async () => {
    const { normalizeCalendarEvent } = await import('../../../src/main/features/personal_context/feishu/normalize');
    const r = normalizeCalendarEvent(TENANT, UNION_ID, event1, { observedAt: '2026-08-01T09:00:00.000Z' });
    expect(r.resourceId).toBe('feishu:tenant-1:calendar_event:evt_001');
    expect(r.resourceType).toBe('calendar_event');
    expect(r.sourceVersion).toBe('2026-08-01T08:00:00.000Z');
    expect(r.ownerRef).toBe('feishu:union_id:on_me');
    expect(r.accessLabel).toBe('personal');
    expect(r.bodyLoaded).toBe(true);
    expect(r.calendarEvent).toEqual({
      startAt: new Date(event1.start_time!).toISOString(),
      endAt: new Date(event1.end_time!).toISOString(),
    });
  });

  it('visibility → accessLabel 映射：private→personal、public→public、default→shared', async () => {
    const { accessLabelFromVisibility } = await import('../../../src/main/features/personal_context/feishu/normalize');
    expect(accessLabelFromVisibility('private')).toBe('personal');
    expect(accessLabelFromVisibility('only_me')).toBe('personal');
    expect(accessLabelFromVisibility('public')).toBe('public');
    expect(accessLabelFromVisibility('default')).toBe('shared');
    expect(accessLabelFromVisibility(undefined)).toBe('shared');
  });

  it('云空间：folder→folder、docx→document，containerRef=parent_token', async () => {
    const { normalizeDriveFile } = await import('../../../src/main/features/personal_context/feishu/normalize');
    const f = normalizeDriveFile(TENANT, UNION_ID, folder);
    expect(f.resourceId).toBe('feishu:tenant-1:folder:fld_001');
    const d = normalizeDriveFile(TENANT, UNION_ID, docx);
    expect(d.resourceId).toBe('feishu:tenant-1:document:doc_001');
    expect(d.containerRef).toBe('fld_001');
  });

  it('知识库节点 token 分离：用 obj_token 幂等，节点自身不注册', async () => {
    const { normalizeWikiNode } = await import('../../../src/main/features/personal_context/feishu/normalize');
    const r = normalizeWikiNode(TENANT, UNION_ID, wikiNode);
    expect(r.resourceId).toBe('feishu:tenant-1:document:wk_doc_001');
    expect(r.resourceId).not.toContain('nd_001');
    expect(r.containerRef).toBe('sp_001');
  });

  it('不同租户/类型/id 产出不同幂等键', async () => {
    const { normalizeCalendarEvent } = await import('../../../src/main/features/personal_context/feishu/normalize');
    const a = normalizeCalendarEvent('tenant-1', UNION_ID, event1);
    const b = normalizeCalendarEvent('tenant-2', UNION_ID, event1);
    const c = normalizeCalendarEvent(TENANT, UNION_ID, event2);
    expect(a.resourceId).not.toBe(b.resourceId);
    expect(a.resourceId).not.toBe(c.resourceId);
  });
});

describe('discovery 资源发现（mock）', () => {
  it('发现全部类型：日历/文件夹/文档/知识库文档/聊天', async () => {
    const { discoverResources } = await import('../../../src/main/features/personal_context/feishu/discovery');
    const client = mockClient();
    const resources = await discoverResources(client, { tenant: TENANT, unionId: UNION_ID });
    const ids = resources.map((r) => r.resourceId).sort();
    expect(ids).toEqual([
      'feishu:tenant-1:calendar:cal_001',
      'feishu:tenant-1:chat:oc_001',
      'feishu:tenant-1:document:doc_001',
      'feishu:tenant-1:document:wk_doc_001',
      'feishu:tenant-1:folder:fld_001',
    ]);
  });

  it('types 过滤只发现指定类型', async () => {
    const { discoverResources } = await import('../../../src/main/features/personal_context/feishu/discovery');
    const resources = await discoverResources(mockClient(), { tenant: TENANT, unionId: UNION_ID, types: ['calendar', 'chat'] });
    expect(resources.map((r) => r.resourceType).sort()).toEqual(['calendar', 'chat']);
  });
});

describe('sync 增量同步（mock）', () => {
  it('首次同步（无游标）做有限回填：范围近 30 天/未来 90 天', async () => {
    const { syncResources, BACKFILL_DAYS_PAST, BACKFILL_DAYS_FUTURE } = await import('../../../src/main/features/personal_context/feishu/sync');
    const client = mockClient();
    const applied: string[] = [];
    const now = new Date('2026-08-10T00:00:00.000Z');

    const result = await syncResources(client, {
      tenant: TENANT,
      unionId: UNION_ID,
      selected: [{ type: 'calendar', stableId: 'cal_001' }],
      cursor: null,
      applyResource: async (r) => {
        applied.push(r.resourceId);
        return { change: 'new', resource: r };
      },
      now: () => now,
    });

    expect(result.added).toBe(2);
    expect(applied).toEqual([
      'feishu:tenant-1:calendar_event:evt_001',
      'feishu:tenant-1:calendar_event:evt_002',
    ]);
    // 回填范围：近 30 天 / 未来 90 天
    const [, range] = client.calls.events[0] as [string, { start: string; end: string }, string | undefined];
    expect(range.start).toBe(new Date(now.getTime() - BACKFILL_DAYS_PAST * 86400000).toISOString());
    expect(range.end).toBe(new Date(now.getTime() + BACKFILL_DAYS_FUTURE * 86400000).toISOString());
    // 新水位 = 本次最大 updated_at
    expect(result.nextCursor.watermarks.calendar_event).toBe('2026-08-02T08:00:00.000Z');
  });

  it('增量同步：水位之后的事件才处理', async () => {
    const { syncResources } = await import('../../../src/main/features/personal_context/feishu/sync');
    const client = mockClient();
    const applied: string[] = [];
    const result = await syncResources(client, {
      tenant: TENANT,
      unionId: UNION_ID,
      selected: [{ type: 'calendar', stableId: 'cal_001' }],
      cursor: {
        watermarks: { calendar_event: '2026-08-02T00:00:00.000Z' },
        eventIdempotency: [],
        updatedAt: '2026-08-02T00:00:00.000Z',
      },
      applyResource: async (r) => {
        applied.push(r.resourceId);
        return { change: 'new', resource: r };
      },
    });
    // evt_001(08-01) 已过水位，evt_002(08-02 08:00) 在水位后
    expect(applied).toEqual(['feishu:tenant-1:calendar_event:evt_002']);
    expect(result.added).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it('applyResourceMany 批量通道：全部资源一批提交，统计与逐条一致', async () => {
    const { syncResources } = await import('../../../src/main/features/personal_context/feishu/sync');
    const client = mockClient();
    const batches: string[][] = [];
    const result = await syncResources(client, {
      tenant: TENANT,
      unionId: UNION_ID,
      selected: [
        { type: 'calendar', stableId: 'cal_001' },
        { type: 'chat', stableId: 'oc_001' },
        { type: 'document', stableId: 'doc_001' },
        { type: 'document', stableId: 'wk_doc_001' },
      ],
      cursor: null,
      // 提供批量通道后逐条 applyResource 不应被调用
      applyResource: async () => { throw new Error('applyResource must not be called when applyResourceMany is provided'); },
      applyResourceMany: async (resources) => {
        batches.push(resources.map((r) => r.resourceId));
        return resources.map((r) => ({ change: 'new', resource: r }));
      },
    });
    // 日历事件 2 + 聊天 1 + 文档 2（drive doc_001 + wiki wk_doc_001）= 5 条，一次批量提交
    expect(batches).toEqual([[
      'feishu:tenant-1:calendar_event:evt_001',
      'feishu:tenant-1:calendar_event:evt_002',
      'feishu:tenant-1:chat:oc_001',
      'feishu:tenant-1:document:doc_001',
      'feishu:tenant-1:document:wk_doc_001',
    ]]);
    expect(result.added).toBe(5);
    // 水位计算与逐条路径一致（与「首次同步做有限回填」测试相同的期望）
    expect(result.nextCursor.watermarks.calendar_event).toBe('2026-08-02T08:00:00.000Z');
  });

  it('applyEvents 幂等：重复 event_id 只处理一次', async () => {
    const { applyEvents } = await import('../../../src/main/features/personal_context/feishu/sync');
    const client = mockClient();
    const applied: string[] = [];
    // 模拟注册表幂等：同 resourceId 同 sourceVersion → unchanged
    const seenVersions = new Map<string, string>();
    const mkEvent = (eventId: string) => ({
      event_id: eventId,
      event_type: 'calendar.event.updated',
      tenant_key: 't-1',
      payload: { event: event1 },
      received_at: '2026-08-01T09:00:00.000Z',
    });

    const first = await applyEvents(client, {
      tenant: TENANT,
      unionId: UNION_ID,
      selected: [],
      events: [mkEvent('evt_dup_1'), mkEvent('evt_dup_1'), mkEvent('evt_dup_2')],
      cursor: { watermarks: {}, eventIdempotency: [], updatedAt: '2026-08-01T00:00:00.000Z' },
      applyResource: async (r) => {
        const prev = seenVersions.get(r.resourceId);
        if (prev === r.sourceVersion) return { change: 'unchanged', resource: r };
        seenVersions.set(r.resourceId, r.sourceVersion);
        applied.push(r.resourceId);
        return { change: 'new', resource: r };
      },
    });
    // 事件去重层：重复投递的 evt_dup_1 跳过；两个不同事件引用同一资源时，
    // 注册表幂等层吸收第二次（unchanged），资源只应用一次
    expect(applied).toEqual(['feishu:tenant-1:calendar_event:evt_001']);
    expect(first.processedEventIds).toEqual(['evt_dup_1', 'evt_dup_2']);
    expect(first.unchanged).toBe(2); // 事件层跳过 1 + 注册表幂等吸收 1

    // 窗口内再次投递 → 全部跳过
    const second = await applyEvents(client, {
      tenant: TENANT,
      unionId: UNION_ID,
      selected: [],
      events: [mkEvent('evt_dup_1')],
      cursor: {
        watermarks: {},
        eventIdempotency: first.processedEventIds,
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
      applyResource: async () => ({ change: 'unchanged', resource: event1 as unknown as import('../../../src/main/features/personal_context/contract').ExternalResource }),
    });
    expect(second.processedEventIds).toEqual([]);
    expect(second.unchanged).toBe(1);
  });

  it('无法解释的事件跳过，不进幂等窗口', async () => {
    const { applyEvents } = await import('../../../src/main/features/personal_context/feishu/sync');
    const client = mockClient();
    const result = await applyEvents(client, {
      tenant: TENANT,
      unionId: UNION_ID,
      selected: [],
      events: [{ event_id: 'msg_1', event_type: 'im.message.receive', tenant_key: 't-1', payload: { message: { id: 'm1' } }, received_at: '2026-08-01T09:00:00.000Z' }],
      cursor: { watermarks: {}, eventIdempotency: [], updatedAt: '2026-08-01T00:00:00.000Z' },
      applyResource: async () => ({ change: 'unchanged', resource: event1 as unknown as import('../../../src/main/features/personal_context/contract').ExternalResource }),
    });
    expect(result.processedEventIds).toEqual([]);
    expect(result.added).toBe(0);
  });
});

describe('provider 组装（注册表 + 游标集成）', () => {
  async function setup() {
    const { PersonalContextRegistry, PersonalContextCursorStore } = await import('../../../src/main/features/personal_context/registry');
    const { createFeishuProvider } = await import('../../../src/main/features/personal_context/feishu/provider');
    const registry = new PersonalContextRegistry();
    const cursors = new PersonalContextCursorStore();
    return { registry, cursors, createFeishuProvider };
  }

  it('sync 成功 → 游标落盘；二次 sync 按水位增量，无新数据', async () => {
    const { registry, cursors, createFeishuProvider } = await setup();
    const client = mockClient();
    const provider = createFeishuProvider(client, { tenant: TENANT, unionId: UNION_ID, registry, cursors });

    // 发现 → 选择日历接入
    const discovered = await provider.discoverResources({ uid: UID, providerId: 'feishu' });
    const calendar = discovered.find((r) => r.resourceType === 'calendar')!;
    await registry.upsert(UID, calendar);
    await registry.setSelection(UID, calendar.resourceId, true);

    const ctx = { uid: UID, providerId: 'feishu' };
    const first = await provider.sync(ctx);
    expect(first.added).toBe(2);
    const cursor = await cursors.get(UID, 'feishu');
    expect(cursor?.watermarks.calendar_event).toBe('2026-08-02T08:00:00.000Z');

    // 二次同步：水位已推进，mock client 过滤后无新事件
    const second = await provider.sync(ctx);
    expect(second.added).toBe(0);
    expect(await registry.count(UID, { providerId: 'feishu', selectedOnly: true })).toBe(1);
  });

  it('同步失败 → 游标不落盘', async () => {
    const { registry, cursors, createFeishuProvider } = await setup();
    const client = mockClient({
      async listCalendarEvents() {
        throw new Error('feishu api 500');
      },
    });
    const provider = createFeishuProvider(client, { tenant: TENANT, unionId: UNION_ID, registry, cursors });
    await registry.upsert(UID, { ...cal, resourceId: 'feishu:tenant-1:calendar:cal_001', ownerRef: 'feishu:union_id:on_me', observedAt: '2026-08-01T00:00:00.000Z', accessLabel: 'personal', retentionPolicy: 'source-linked', resourceType: 'calendar' });
    await registry.setSelection(UID, 'feishu:tenant-1:calendar:cal_001', true);

    await expect(provider.sync({ uid: UID, providerId: 'feishu' })).rejects.toThrow();
    expect(await cursors.get(UID, 'feishu')).toBeNull();
    // 注册表也不应有半途写入
    expect(await registry.count(UID, { providerId: 'feishu', types: ['calendar_event'] })).toBe(0);
  });

  it('revoke → 级联失效全部 feishu 资源（资源保留、来源失效）', async () => {
    const { registry, cursors, createFeishuProvider } = await setup();
    const provider = createFeishuProvider(mockClient(), { tenant: TENANT, unionId: UNION_ID, registry, cursors });
    const ctx = { uid: UID, providerId: 'feishu' };

    const discovered = await provider.discoverResources(ctx);
    for (const r of discovered) await registry.upsert(UID, r);
    expect(await registry.count(UID, { providerId: 'feishu' })).toBe(5);

    await provider.revoke(ctx);
    expect(await registry.count(UID, { providerId: 'feishu' })).toBe(0);
    expect(await registry.count(UID, { providerId: 'feishu', includeInvalid: true })).toBe(5);
    const entry = await registry.get(UID, 'feishu:tenant-1:calendar:cal_001');
    expect(entry?.invalidatedAt).toBeTruthy();
    expect(entry?.invalidateReason).toBe('oauth revoked');
  });

  it('status 健康检查：正常 → connected，异常 → error', async () => {
    const { registry, cursors, createFeishuProvider } = await setup();
    const ctx = { uid: UID, providerId: 'feishu' };

    const ok = createFeishuProvider(mockClient(), { tenant: TENANT, unionId: UNION_ID, registry, cursors });
    expect((await ok.status(ctx)).kind).toBe('connected');

    const bad = createFeishuProvider(mockClient({ async healthCheck() { return { ok: false, error: '令牌失效' }; } }), { tenant: TENANT, unionId: UNION_ID, registry, cursors });
    const status = await bad.status(ctx);
    expect(status.kind).toBe('error');
    expect(status.error).toBe('令牌失效');
  });
});
