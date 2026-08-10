/**
 * 简报场景的飞书推送出口（设计稿 §5.6 场景层接线，方案 A）。
 *
 * - `dispatchToFeishuHome`：把简报文本投递到指定飞书实例的归属人主页会话，
 *   复用 messaging 的幂等键 + 投递账本 + 重试能力（manager.sendProactive）。
 *   不走 proactive.sendToSelf——那条路径面向 Commander/模型发起，强制
 *   renderer 一次确认（requestSendConfirm），定时简报需要无人值守投递，
 *   确认语义不适用；sendProactive 与 sendToSelf 的账本/幂等/重试能力等价。
 * - `assembleBriefingInput`：组装「本体已确认事实 + 授权日历事件」两个
 *   JSON 形状喂给 briefing.ts（纯函数，数据源可注入便于测试/替换）。
 *
 * 已知数据缺口（原型阶段，A 线补齐后自动消除）：
 *   1. 日历事件时间：normalizeCalendarEvent 目前未把 start_time/end_time
 *      写入 ExternalResource，注册表条目无法还原事件时间 → 当前跳过无时间
 *      事件（今日安排为空，简报走降级路径，符合设计稿 §5.6）；
 *   2. 本体已确认事实读取：资源→候选→确认→本体 管线尚未接线，facts 暂为
 *      空（场景只信本体，管线就位后由 loadFacts 注入）。
 */

import * as proactive from '../messaging/proactive';
import * as messagingRegistry from '../messaging/registry';
import { sendProactive } from '../messaging/manager';
import { PersonalContextRegistry } from './registry';
import type { ExternalResource } from './contract';
import { createLogger } from '../../logger';
import {
  buildDailyBriefing,
  type BriefingCalendarEvent,
  type BriefingFact,
  type BriefingInput,
} from './briefing';

export interface DispatchToFeishuHomeOptions {
  instanceId: string;
  text: string;
  /** 幂等键（调用方负责稳定：如 briefing:${taskId}:${日期}） */
  sourceKey: string;
  signal?: AbortSignal | null;
}

export type DispatchResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

const log = createLogger('personal-context:feishu-dispatch');

const registryStore = new PersonalContextRegistry();

/**
 * 投递到飞书实例的归属人主页会话。先做可用性门控（实例存在且可投递、
 * 归属人已配置），再走 ledger 幂等投递；失败返回结构化错误，由调用方
 * （auto_tasks fire 出口）决定降级策略。
 */
export async function dispatchToFeishuHome(
  uid: string,
  opts: DispatchToFeishuHomeOptions,
): Promise<DispatchResult> {
  const text = typeof opts.text === 'string' ? opts.text.trim() : '';
  if (!text) return { ok: false, code: 'empty_text', error: '简报文本为空' };
  const sourceKey = typeof opts.sourceKey === 'string' && opts.sourceKey.trim() ? opts.sourceKey.trim() : '';
  if (!sourceKey) return { ok: false, code: 'missing_source_key', error: '缺少幂等键' };

  // 可用性门控：复用 proactive 的实例状态视图（available / owner_missing / …）
  let targets;
  try {
    targets = await proactive.listTargets(uid);
  } catch (err) {
    return { ok: false, code: 'targets_unavailable', error: `无法读取消息实例状态：${(err as Error).message}` };
  }
  const target = targets.targets.find((t) => t.instance_id === opts.instanceId);
  if (!target) {
    return { ok: false, code: 'instance_unknown', error: '未知消息实例，请检查任务配置的实例 id' };
  }
  if (target.status !== 'available') {
    if (target.status === 'owner_missing') {
      return { ok: false, code: 'owner_missing', error: '该实例未配置归属人（主页会话不可用）' };
    }
    return { ok: false, code: 'instance_unavailable', error: `消息实例不可用（${target.status}）` };
  }

  let ownerExternalUserId = '';
  try {
    const instance = await messagingRegistry.getInstance(uid, opts.instanceId);
    ownerExternalUserId = instance?.ownerExternalUserId || '';
  } catch (err) {
    log.warn('dispatch owner lookup failed', { instanceId: opts.instanceId, error: (err as Error).message });
  }
  if (!ownerExternalUserId) {
    return { ok: false, code: 'owner_missing', error: '该实例未配置归属人（主页会话不可用）' };
  }

  try {
    await sendProactive(uid, {
      instanceId: opts.instanceId,
      recipientId: ownerExternalUserId,
      text,
      sourceKey,
      signal: opts.signal ?? null,
    });
    log.info('briefing dispatched to feishu home', { instanceId: opts.instanceId, textLen: text.length, sourceKey });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('briefing dispatch failed', { instanceId: opts.instanceId, error: message });
    return { ok: false, code: 'delivery_failed', error: message };
  }
}

// ── 简报数据组装 ─────────────────────────────────────────────────────────

export interface BriefingDataSources {
  /** 日历事件加载器；缺省从注册表读 calendar_event */
  loadEvents?: (uid: string) => Promise<BriefingCalendarEvent[]>;
  /** 本体事实加载器；缺省为空（本体管线未接） */
  loadFacts?: (uid: string) => Promise<BriefingFact[]>;
}

/** 从注册表读取已接入且包含时间信息的日历事件。
 * 时间由 Feishu normalize 阶段写入 ExternalResource.calendarEvent，简报层
 * 不重新访问 provider，也不展示缺失时间的伪日程。 */
export async function loadCalendarEvents(uid: string): Promise<BriefingCalendarEvent[]> {
  const entries = await registryStore.list(uid, { types: ['calendar_event'] });
  return entries.flatMap((entry) => {
    const detail = entry.resource.calendarEvent;
    if (!detail?.startAt) return [];
    return [{
      id: entry.resource.resourceId,
      title: entry.resource.title,
      startAt: detail.startAt,
      ...(detail.endAt ? { endAt: detail.endAt } : {}),
      ...(detail.allDay !== undefined ? { allDay: detail.allDay } : {}),
      ...(detail.location ? { location: detail.location } : {}),
      sourceRef: entry.resource.sourceUrl || entry.resource.resourceId,
    }];
  });
}

/** 组装简报输入。facts/events 数据源可注入（测试或本体管线就位后替换）。 */
export async function assembleBriefingInput(
  uid: string,
  sources: BriefingDataSources = {},
): Promise<BriefingInput> {
  const events = sources.loadEvents
    ? await sources.loadEvents(uid)
    : await loadCalendarEvents(uid);
  const facts = sources.loadFacts ? await sources.loadFacts(uid) : [];
  return { facts, events };
}

/** 组装并生成简报文本（无数据时自然降级为通用简报，不抛错）。 */
export async function assembleBriefingText(uid: string, sources?: BriefingDataSources): Promise<string> {
  const input = await assembleBriefingInput(uid, sources);
  return buildDailyBriefing(input).text;
}
