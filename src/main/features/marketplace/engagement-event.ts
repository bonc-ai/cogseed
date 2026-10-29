/**
 * 内容「使用次数 / 使用用户数」上报（Hub 契约 `engagement-events`，2026-10-21）。
 *
 * 与 `usage-event.ts`（A-03 `hub_content_used`）刻意分开：
 * - 本模块上报的是**聚合计数**：Skill 安装/启用、Agent 会话启动；不传成功/失败结果；
 * - 不要求登录、不接 `product_analytics` Consent；只上报不可逆的用户摘要（`actor_key`）；
 * - 发送失败**不重试、不补报**，也绝不影响安装/启用/发消息本身。
 *
 * ## 只上报 Hub 官方安装的内容
 *
 * Skill 以 `userMarketplaceSkillDir` 下的 `_install.json` 为事实；Agent 以
 * `userMarketplaceAgentDir` 下的 `_install.json` 为事实。自定义 / 内置 / 随包内容没有
 * 该成功标记，因此不会出现「把随包种子算成安装」这类误计。
 *
 * ## 去重
 *
 * - Skill 安装：`_install.json::engagement_activate_sent_at` 标记；同一安装周期只发一次。
 *   更新版本会重写 `_install.json`，但安装入口只在「安装前不存在」时调用本模块，故不会重发。
 * - Agent 会话：`<uid>/local/engagement/agent-sessions/<cid>.json` 记录已发过的 agent；
 *   同一会话内同一 Agent 只发一次。标记在**发送前**写入，宁可丢一条也不重复计数。
 *
 * ## 隐私
 *
 * `actor_key = SHA-256("cogseed-engagement-user:v1:" + identity)`，identity 为登录态
 * `account_id` 或本地 uid；只发摘要，不发原始 account_id / 手机号 / 设备号。Hub 还会
 * 按内容再做一次域隔离摘要，库内不能跨内容关联。
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { readJson, safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { userLocalRoot, userMarketplaceAgentDir, userMarketplaceSkillDir } from '../../paths';
import { requireCogSeedApiBase } from '../api_base';
import { readHubAccountState } from '../hub_account/state';
import { readInstalledVersion } from './installed-version';

const log = createLogger('marketplace/engagement-event');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REQUEST_TIMEOUT_MS = 5_000;

export type EngagementContentType = 'skill' | 'agent';
export type EngagementEventKind = 'activate' | 'session_start';
export type EngagementActorKind = 'account' | 'local';

/** Hub 契约白名单：恰好 8 项。 */
export interface EngagementEvent {
  actor_key: string;
  actor_kind: EngagementActorKind;
  content_id: string;
  content_type: EngagementContentType;
  event_id: string;
  event_kind: EngagementEventKind;
  occurred_at: string;
  version: string;
}

export const ENGAGEMENT_EVENT_FIELDS = [
  'actor_key', 'actor_kind', 'content_id', 'content_type',
  'event_id', 'event_kind', 'occurred_at', 'version',
] as const;

/** 发送器替身：返回 `true` 表示 Hub 已接收；失败由调用方决定是否保留去重标记。 */
export type EngagementEventSender = (event: EngagementEvent) => Promise<boolean> | boolean;

/** 26 位 Crockford base32 ULID：48-bit 毫秒时间 + 80-bit 随机。 */
export function newEngagementEventId(now = Date.now()): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  randomBytes(10).copy(bytes, 6);
  let value = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, 26);
}

/**
 * 用户身份摘要。登录态优先用 `account_id`（跨设备稳定），否则用本地 uid。
 *
 * 不做任何日志输出；返回值只用于事件体。
 */
export function engagementActorFor(userId: string): { actor_key: string; actor_kind: EngagementActorKind } {
  const state = readHubAccountState(userId);
  const accountId = state.bound && typeof state.account_id === 'string' && state.account_id
    ? state.account_id
    : '';
  const identity = accountId || userId;
  return {
    actor_key: createHash('sha256').update(`cogseed-engagement-user:v1:${identity}`).digest('hex'),
    actor_kind: accountId ? 'account' : 'local',
  };
}

async function postEngagementEvent(event: EngagementEvent): Promise<boolean> {
  try {
    const base = requireCogSeedApiBase().replace(/\/+$/, '');
    const res = await fetch(`${base}/marketplace/hub-content/engagement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 契约要求不重试、不缓存补报；这里只留诊断，不查看/打印 actor_key。
      log.warn('engagement event rejected', {
        content_id: event.content_id,
        content_type: event.content_type,
        status: res.status,
      });
      return false;
    }
    const body = await res.json().catch(() => null) as
      | { accepted?: unknown; code?: unknown; error?: { code?: unknown } }
      | null;
    if (!body || body.code !== 0 || body.accepted !== true) {
      log.warn('engagement event response invalid', {
        content_id: event.content_id,
        content_type: event.content_type,
        code: body && typeof body.error?.code === 'string' ? body.error.code : null,
      });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('engagement event send failed', {
      content_id: event.content_id,
      content_type: event.content_type,
      error: (err as Error).message,
    });
    return false;
  }
}

let sender: EngagementEventSender = postEngagementEvent;

/** 测试替身；产品路径不要调用。 */
export function setEngagementEventSender(next: EngagementEventSender | null): void {
  sender = next ?? postEngagementEvent;
}

function eventFor(input: {
  contentId: string;
  contentType: EngagementContentType;
  eventKind: EngagementEventKind;
  userId: string;
  version: string;
}): EngagementEvent | null {
  if (!input.userId || !input.contentId || !input.version) return null;
  const actor = engagementActorFor(input.userId);
  return {
    actor_key: actor.actor_key,
    actor_kind: actor.actor_kind,
    content_id: input.contentId,
    content_type: input.contentType,
    event_id: newEngagementEventId(),
    event_kind: input.eventKind,
    occurred_at: new Date().toISOString(),
    version: input.version,
  };
}

async function send(event: EngagementEvent | null): Promise<boolean> {
  if (!event) return false;
  try {
    return await sender(event);
  } catch (err) {
    log.warn('engagement event sender threw', {
      content_id: event.content_id,
      content_type: event.content_type,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Skill 安装成功（含自动启用）。只在「安装前不存在」时调用；更新版本不要调用。 */
export async function recordSkillActivated(
  userId: string,
  contentId: string,
  version: string,
): Promise<boolean> {
  try {
    if (!safeId(userId) || !safeId(contentId) || !version) return false;
    const markerPath = path.join(userMarketplaceSkillDir(userId, contentId), '_install.json');
    const marker = await readJson<Record<string, unknown>>(markerPath);
    if (marker.engagement_activate_sent_at) return false;
    if (marker.version !== version) return false;

    const sent = await send(eventFor({
      contentId, contentType: 'skill', eventKind: 'activate', userId, version,
    }));
    if (!sent) return false;

    // 安装/更新可能在这段时间重写了标记；版本对不上就不要把旧版本的标记写回去。
    const current = await readJson<Record<string, unknown>>(markerPath);
    if (current.version !== version) return true;
    await writeJson(markerPath, {
      ...current,
      engagement_activate_sent_at: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    log.warn('skill activation event failed; install is unaffected', {
      content_id: contentId,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * 用户停用后重新启用。每次「false → true」都算一次，不做跨次数去重；
 * 但只对已安装的 Hub 内容生效。
 */
export async function recordSkillEnabled(userId: string, contentId: string): Promise<boolean> {
  try {
    if (!safeId(userId) || !safeId(contentId)) return false;
    const version = readInstalledVersion(userId, contentId).version;
    if (!version) return false;
    return await send(eventFor({
      contentId, contentType: 'skill', eventKind: 'activate', userId, version,
    }));
  } catch (err) {
    log.warn('skill re-enable event failed; toggle is unaffected', {
      content_id: contentId,
      error: (err as Error).message,
    });
    return false;
  }
}

async function agentInstalledVersion(userId: string, agentId: string): Promise<string> {
  try {
    const marker = await readJson<Record<string, unknown>>(
      path.join(userMarketplaceAgentDir(userId, agentId), '_install.json'),
    );
    return typeof marker.version === 'string' ? marker.version : '';
  } catch {
    return '';
  }
}

function sessionMarkerPath(userId: string, cid: string): string {
  return path.join(userLocalRoot(userId), 'engagement', 'agent-sessions', `${cid}.json`);
}

/**
 * Agent 会话启动：用户在当前会话里第一次把某个 Hub Agent 纳入成员/点名/接收者时发一次。
 *
 * 标记在发送前写入：同一会话/同一 Agent 最多一条。发送失败也不补发（契约要求）。
 */
export async function recordAgentSessionStarts(input: {
  agentIds: readonly string[];
  cid: string;
  userId: string;
}): Promise<void> {
  try {
    const { cid, userId } = input;
    if (!safeId(userId) || !safeId(cid)) return;
    const agentIds = Array.from(new Set(
      input.agentIds.filter((id) => typeof id === 'string' && safeId(id) && id !== 'commander' && id !== 'user'),
    ));
    if (!agentIds.length) return;

    const markerPath = sessionMarkerPath(userId, cid);
    const toSend = await fileEditLock(markerPath).runExclusive(async () => {
      const marker = await readJson<{ agents?: Record<string, string> }>(markerPath);
      const agents = { ...(marker.agents || {}) };
      const out: Array<{ id: string; version: string }> = [];
      for (const id of agentIds) {
        if (agents[id]) continue;
        const version = await agentInstalledVersion(userId, id);
        if (!version) continue;
        agents[id] = new Date().toISOString();
        out.push({ id, version });
      }
      if (out.length) await writeJson(markerPath, { agents });
      return out;
    });

    for (const item of toSend) {
      await send(eventFor({
        contentId: item.id,
        contentType: 'agent',
        eventKind: 'session_start',
        userId,
        version: item.version,
      }));
    }
  } catch (err) {
    log.warn('agent session event failed; message is unaffected', {
      cid: input.cid,
      error: (err as Error).message,
    });
  }
}
