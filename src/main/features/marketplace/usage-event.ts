/**
 * `hub_content_used` 采集 —— 采集 + 来源判定 + 登录/Consent 判定 + `version` 取值。
 *
 * 契约：specs/010 `contracts/usage-event-emitter.md`｜需求：FR-061～FR-066
 *
 * ## 边界：采集与发送分成两半
 *
 * 采集侧 `[FROZEN]`，本模块已完成；发送侧 `[OPEN—HUB Q3]`，收敛在 `sendUsageEvent` 一个函数里。
 * `AUTH-HUB-OPEN1-US3-US6-001` 的 `confirmation_points` 明列：A-03 的 `data` 包装层口径
 * （PRD 附录 A.1 第 450 行已取消、A.4 第 587 行样例仍带）收口前**不得实现端点**。
 * 因此 `sendUsageEvent` 目前**不发起任何网络调用**，请求体 / 响应信封 / 错误码**一个字都不写死**。
 *
 * ## 触发时机：一次**真实使用尝试**的结果
 *
 * ⚠️ 埋点挂在运行时真正尝试执行该 Skill 的地方，**不是** UI 点击、不是查看详情、不是安装动作。
 * 只有「试着用了，成了或没成」才产生事件。
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { isAnonymousLocalId } from '../users';
import { resolveVersionCopy } from './version-store';

const log = createLogger('marketplace/usage-event');

/** 失败原因的封闭集合。 */
export type UsageFailureReason =
  | 'content_unavailable'
  | 'permission_denied'
  | 'content_disabled'
  | 'internal_error';

/**
 * 事件字段白名单，**恰好 6 项**（FR-061）。
 *
 * ⚠️ 多一项即违规。`reason` 只在 `result === 'failure'` 时出现。
 */
export interface HubContentUsedEvent {
  event_id: string;
  content_id: string;
  version: string;
  result: 'success' | 'failure';
  reason?: UsageFailureReason;
  occurred_at: string;
}

/** 白名单的运行期形态，供断言与组装共用，避免两处各写一遍。 */
export const HUB_CONTENT_USED_FIELDS = [
  'event_id', 'content_id', 'version', 'result', 'reason', 'occurred_at',
] as const;

// ── Consent 判定（单一接缝） ──────────────────────────────────────────────

export type ConsentState =
  /** 用户已授予 `product_analytics`。 */
  | 'granted'
  /** 明确拒绝或已撤回。 */
  | 'denied'
  /** 该 scope 在本客户端尚不可用（Consent 前置 Gate 未生效）。 */
  | 'unavailable';

export type ConsentReader = (userId: string) => ConsentState;

/**
 * 默认 Consent 读取：**恒为 `unavailable`**。
 *
 * ⚠️ 这不是占位偷懒。`product_analytics` scope 在本客户端**尚不存在**（实测全仓无该标识符），
 * 它由「Consent 前置」这道 Gate 引入——该 Gate 阻塞的正是 `O2` / `O3` / `O4` 与 US6。
 * 在它生效之前，**保守侧是不采集**：没有有效同意就不产生事件、不缓存补报。
 *
 * Gate 落地后只需 `setConsentReader(...)` 换掉这一处，采集侧 0 行改动。
 */
const defaultConsentReader: ConsentReader = () => 'unavailable';

let consentReader: ConsentReader = defaultConsentReader;

/** 替换 Consent 读取实现。供 Consent 前置落地与测试替身使用。 */
export function setConsentReader(next: ConsentReader | null): void {
  consentReader = next ?? defaultConsentReader;
}

export function readProductAnalyticsConsent(userId: string): ConsentState {
  return consentReader(userId);
}

// ── 发送侧（Q3 隔离边界） ────────────────────────────────────────────────

export type UsageEventSender = (event: HubContentUsedEvent) => void;

/**
 * **全模块唯一与网络接触的函数**。
 *
 * ⛔ Q3 收口前**不实现真实调用**：本实现只记一条本地日志，不构造请求体、不解析响应信封、
 * 不定义错误码。翻转代价 = 只改这一个函数，采集侧 0 行改动（SC-011）。
 *
 * 也不做幂等与重试（FR-066）：不满足条件就不发送、不缓存补报，因此无需幂等约定。
 */
const defaultSender: UsageEventSender = (event) => {
  log.info('hub_content_used collected (transport pending Q3)', {
    event_id: event.event_id, content_id: event.content_id, result: event.result,
  });
};

let sender: UsageEventSender = defaultSender;

/** 替换发送实现。Q3 收口后在此接入真实端点；测试用替身。 */
export function setUsageEventSender(next: UsageEventSender | null): void {
  sender = next ?? defaultSender;
}

export function sendUsageEvent(event: HubContentUsedEvent): void {
  sender(event);
}

// ── 采集入口 ──────────────────────────────────────────────────────────────

export interface RecordUsageInput {
  userId: string;
  contentId: string;
  /**
   * ⭐ **本次使用 pin 固定的版本**（FR-064）。
   *
   * 必须由调用方从本次使用的 pin 传入。本模块**不去读 current install 的版本**——
   * 那是目标/当前版本，与「这次到底用的哪一版」是两件事。
   */
  pinnedVersion: string;
  result: 'success' | 'failure';
  reason?: UsageFailureReason;
}

export type SkipReason =
  /** 不是 Hub 官方副本：派生副本 / 自定义 Skill / 未被 Hub 接管的随包种子。 */
  | 'not-hub-official'
  /** 匿名，未登录。 */
  | 'anonymous'
  /** 没有有效的 `product_analytics` 同意（拒绝、撤回，或该 scope 尚不可用）。 */
  | 'no-consent'
  /** 缺少本次使用的 pin 版本，无从填 `version`。 */
  | 'no-pinned-version';

/**
 * 本次使用的对象是否为 **Hub 官方副本**。
 *
 * **与 pin 解析同源**：判据是「这一版在 Hub 不可变版本存储里有副本」——正是 pin 解析
 * 所依赖的同一个事实（`contracts/pin-dispatch.md`）。因此不存在第二套来源判定标准：
 *
 * - 派生副本 / 自定义 Skill 落在 `cloud/skills/`，没有版本副本 → 不采集；
 * - **未被 Hub 接管**的随包种子没有版本副本 → 不采集；
 * - 被 Hub 接管过的内容才有副本 → 采集。
 */
export function isHubOfficialUse(userId: string, contentId: string, pinnedVersion: string): boolean {
  if (!contentId || !pinnedVersion) return false;
  return resolveVersionCopy(userId, contentId, pinnedVersion) !== null;
}

/**
 * 记录一次对 Hub 官方副本的**真实使用尝试结果**。
 *
 * 三条产生条件全部成立才产生事件（FR-062 / FR-063）：
 *   ① 对象是 Hub 官方副本；② 用户已登录；③ `product_analytics` 同意当前有效。
 *
 * 任一不成立 → **不发送、不缓存补报**，且**不影响安装与使用**——本函数从不抛错。
 *
 * @returns 产生的事件；未产生时返回 `null`。
 */
export function recordHubContentUsage(input: RecordUsageInput): HubContentUsedEvent | null {
  const skip = (reason: SkipReason): null => {
    log.debug('hub_content_used not collected', { reason, content_id: input.contentId });
    return null;
  };

  try {
    if (!input.pinnedVersion) return skip('no-pinned-version');
    // ① 来源：与 pin 解析同源的事实判定。
    if (!isHubOfficialUse(input.userId, input.contentId, input.pinnedVersion)) {
      return skip('not-hub-official');
    }
    // ② 登录态。
    if (!input.userId || isAnonymousLocalId(input.userId)) return skip('anonymous');
    // ③ Consent：只有明确 granted 才采集；denied 与 unavailable 一律不采集。
    if (readProductAnalyticsConsent(input.userId) !== 'granted') return skip('no-consent');

    const event: HubContentUsedEvent = {
      event_id: randomUUID(),
      content_id: input.contentId,
      // 固定为本次使用 pin 的版本，不是 current install 的版本。
      version: input.pinnedVersion,
      result: input.result,
      ...(input.result === 'failure' && input.reason ? { reason: input.reason } : {}),
      occurred_at: new Date().toISOString(),
    };
    sendUsageEvent(event);
    return event;
  } catch (err) {
    // 采集失败绝不影响使用本身（FR-062 末句）。
    log.warn('hub_content_used collection failed; the use itself is unaffected', {
      content_id: input.contentId, error: (err as Error).message,
    });
    return null;
  }
}
