/**
 * 飞书增量同步（设计稿 §5.3 sync.ts）。
 *
 * - 有限回填：首次（无游标）拉近 30 天事件 + 未来 90 天日历；
 * - 增量：游标水位（updated_at）+ 事件幂等窗口（至少一次投递 → 去重）；
 * - 纯函数设计：applyResource 由调用方注入（provider 接注册表），本模块不落盘，
 *   同步结果显式返回 nextCursor，由调用方 advance——失败绝不落水位。
 */
import { nowIso } from '../../../storage';
import type { ExternalResource, ResourceType, SyncCursor, SyncResult } from '../contract';
import type { UpsertResult } from '../registry';
import type { FeishuApiClient } from './api-client';
import {
  normalizeCalendarEvent,
  normalizeChat as normalizeChatOf,
  normalizeDriveFile as normalizeDriveFileOf,
  normalizeWikiNode as normalizeWikiNodeOf,
} from './normalize';
import type { FeishuCalendarEvent, FeishuEvent } from './types';

/** 有限回填窗口（设计稿 §1.3：近 30 天事件、未来 90 天日历） */
export const BACKFILL_DAYS_PAST = 30;
export const BACKFILL_DAYS_FUTURE = 90;

export interface SelectedRef {
  type: ResourceType;
  /** 已选资源的稳定 id（注册表幂等键中的 stableId 段） */
  stableId: string;
}

export type ApplyResource = (resource: ExternalResource) => Promise<UpsertResult> | UpsertResult;

/** 批量落盘通道（provider 接 registry.upsertMany）：一次同步的 N 条资源
 *  收敛为一次注册表读写，避免回填时逐条全量读写 registry.json */
export type ApplyResourceMany = (resources: ExternalResource[]) => Promise<UpsertResult[]> | UpsertResult[];

export interface SyncResourcesOptions {
  tenant: string;
  unionId: string;
  selected: SelectedRef[];
  cursor?: SyncCursor | null;
  applyResource: ApplyResource;
  /** 可选：提供时本类型资源收集为一批统一提交（性能优化，语义与 applyResource 一致） */
  applyResourceMany?: ApplyResourceMany;
  /** 测试注入时间（默认真实时钟） */
  now?: () => Date;
  observedAt?: string;
}

function isoDaysFrom(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function applyOne(resource: ExternalResource, applyResource: ApplyResource, counts: { added: number; updated: number; unchanged: number }): Promise<void> {
  const result = await applyResource(resource);
  countOne(result, counts);
}

function countOne(result: UpsertResult, counts: { added: number; updated: number; unchanged: number }): void {
  if (result.change === 'new') counts.added += 1;
  else if (result.change === 'updated') counts.updated += 1;
  else counts.unchanged += 1;
}

/** 取一组资源该类型的最大 updated_at 作为新水位；
 * 只认可解析为日期时间的版本（无 updated_at 的资源 sourceVersion 回退为稳定 id，
 * 不能当水位，否则会把 id 字符串写进 watermark 导致后续全量误过滤） */
function maxWatermark(resources: ExternalResource[], type: ResourceType, current: string | undefined): string | undefined {
  let best = current;
  for (const resource of resources) {
    const version = resource.sourceVersion;
    if (!version || Number.isNaN(Date.parse(version))) continue;
    if (!best || version > best) best = version;
  }
  return best;
}

/**
 * 列表式增量同步：日历事件（回填/水位）+ 已选资源类型的水位增量。
 * 返回 nextCursor（watermarks 只含本次观察值，合并/截断由 cursor store 负责）。
 *
 * 性能：各类型拉取并行进行；落盘优先走 applyResourceMany（批量一次写），
 * 未提供时逐条 applyResource（语义完全一致，供测试注入）。
 */
export async function syncResources(client: FeishuApiClient, opts: SyncResourcesOptions): Promise<SyncResult> {
  const { tenant, unionId, selected, cursor, applyResource, applyResourceMany, now = () => new Date(), observedAt } = opts;
  const counts = { added: 0, updated: 0, unchanged: 0 };
  const newWatermarks: Record<string, string> = {};

  // 全部待落盘资源收集到同一批次，最后统一提交（批量一次写 or 逐条）
  const batch: ExternalResource[] = [];

  const calendarRefs = selected.filter((ref) => ref.type === 'calendar');
  if (calendarRefs.length > 0) {
    const rangeStart = isoDaysFrom(now(), -BACKFILL_DAYS_PAST);
    const rangeEnd = isoDaysFrom(now(), BACKFILL_DAYS_FUTURE);
    const updatedAfter = cursor?.watermarks['calendar_event'];
    // 多个已选日历并行拉取（飞书 QPS 限制宽松，并发数 = 已选日历数）
    const calendarBatches = await Promise.all(calendarRefs.map(async (ref) => {
      const rawEvents = await client.listCalendarEvents(ref.stableId, { start: rangeStart, end: rangeEnd }, updatedAfter);
      const resources = rawEvents.map((raw) => normalizeCalendarEvent(tenant, unionId, raw, { observedAt }));
      const watermark = maxWatermark(resources, 'calendar_event', updatedAfter);
      return { resources, watermark };
    }));
    for (const { resources, watermark } of calendarBatches) {
      batch.push(...resources);
      if (watermark) newWatermarks['calendar_event'] = watermark;
    }
  }

  const otherTypes = selected.filter((ref) => ref.type !== 'calendar');
  // 去重类型（同类型多 stableId 共享一个水位）
  const byType = new Map<ResourceType, string[]>();
  for (const ref of otherTypes) {
    const ids = byType.get(ref.type) ?? [];
    ids.push(ref.stableId);
    byType.set(ref.type, ids);
  }
  for (const [type, stableIds] of byType) {
    const current = cursor?.watermarks[type];
    let resources: ExternalResource[] = [];
    if (type === 'chat') {
      resources = (await client.listChats())
        .filter((chat) => stableIds.includes(chat.chat_id))
        .map((chat) => normalizeChatOf(tenant, unionId, chat, { observedAt }));
    } else if (type === 'document' || type === 'file' || type === 'folder') {
      const files = await client.listDriveFiles();
      resources = files
        .filter((file) => stableIds.includes(file.file_token))
        .map((file) => normalizeDriveFileOf(tenant, unionId, file, { observedAt }));
      if (type === 'document' || type === 'file') {
        const nodes = await client.listWikiNodes();
        resources = resources.concat(
          nodes
            .filter((node) => stableIds.includes(node.obj_token))
            .map((node) => normalizeWikiNodeOf(tenant, unionId, node, { observedAt })),
        );
      }
    }
    if (current) {
      resources = resources.filter((resource) => resource.sourceVersion && resource.sourceVersion > current);
    }
    batch.push(...resources);
    const watermark = maxWatermark(resources, type, current);
    if (watermark) newWatermarks[type] = watermark;
  }

  if (applyResourceMany && batch.length > 0) {
    const results = await applyResourceMany(batch);
    for (const result of results) countOne(result, counts);
  } else {
    for (const resource of batch) {
      await applyOne(resource, applyResource, counts);
    }
  }

  const nextCursor: SyncCursor = {
    watermarks: newWatermarks,
    eventIdempotency: [],
    updatedAt: nowIso(),
  };
  return {
    providerId: 'feishu',
    ...counts,
    processedEventIds: [],
    nextCursor,
    at: nowIso(),
  };
}

/**
 * 事件流幂等处理：飞书事件视为至少一次投递，cursor.eventIdempotency 窗口内
 * 的 event_id 重复即跳过。事件不推进水位（水位只由列表同步推进）。
 */
export async function applyEvents(client: FeishuApiClient, opts: SyncResourcesOptions & { events: FeishuEvent[] }): Promise<SyncResult> {
  const { tenant, unionId, events, cursor, applyResource, observedAt } = opts;
  const counts = { added: 0, updated: 0, unchanged: 0 };
  const processedEventIds: string[] = [];
  const seen = new Set<string>(cursor?.eventIdempotency ?? []);

  for (const event of events) {
    if (seen.has(event.event_id)) {
      counts.unchanged += 1;
      continue;
    }
    const resource = eventPayloadToResource(tenant, unionId, event, observedAt);
    if (!resource) {
      // 无法解释的事件（如非日历事件）：跳过，不进入幂等窗口
      continue;
    }
    await applyOne(resource, applyResource, counts);
    // 立即入窗口：同一批事件流内的重复投递也需去重
    seen.add(event.event_id);
    processedEventIds.push(event.event_id);
  }

  return {
    providerId: 'feishu',
    ...counts,
    processedEventIds,
    nextCursor: {
      watermarks: {},
      eventIdempotency: [],
      updatedAt: nowIso(),
    },
    at: nowIso(),
  };
}

/** 事件 payload → ExternalResource；只认日历事件形状（骨架），其余返回 null */
function eventPayloadToResource(tenant: string, unionId: string, event: FeishuEvent, observedAt?: string): ExternalResource | null {
  const payload = event.payload as { event?: FeishuCalendarEvent } | FeishuCalendarEvent | null;
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? ((payload as { event?: FeishuCalendarEvent }).event ?? (payload as FeishuCalendarEvent))
    : null;
  if (!raw || typeof raw.event_id !== 'string') return null;
  return normalizeCalendarEvent(tenant, unionId, raw, { observedAt });
}
