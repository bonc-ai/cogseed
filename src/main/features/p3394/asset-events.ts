/**
 * Asset Event Ledger — append-only audit trail for formal asset state changes.
 *
 * PRD §9.4 最小事件表 + 原则 14（先事件后视图）：
 *   资产状态变化 → 持久化 AssetEvent（append-only）→ 生成 AuditReceipt
 *   → 更新 AssetViewProjection（派生视图，可重建）→ 更新 UI。
 *
 * 本模块是账本的唯一写入口（appendAssetEvent）与读入口（listAssetEvents）。
 * 幂等语义：同 event_id 已存在时 appendAssetEvent 幂等返回（appended=false），
 * 调用方可在重试路径依赖该语义，不会产生重复事件。
 *
 * 存储：`<uid>/cloud/cogseed/asset-events/<asset_id>.jsonl`（append-only，
 * 每资产一个文件；appendJsonlAtomic 提供每文件 Mutex + 单调 msgIndex）。
 * 机器私有数据不得写入（cloud 可同步——资产事件本身是用户可同步事实）。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { appendJsonlAtomic, readJsonl, nowIso } from '../../storage';
import { cogseedAgentAssetEventsDir } from '../../paths';
import { maskId } from '../../util/log-redact';

const log = createLogger('asset-events');

/** 最小资产事件类型（PRD §9.4 子集；扩展必须走产品治理，不得自由文本绕开）。 */
export type AssetEventType =
  | 'asset_created'
  | 'asset_user_confirmed'
  | 'asset_transfer_verified'
  | 'asset_effectiveness_validated'
  | 'asset_scope_changed'
  | 'asset_source_revoked'
  | 'asset_paused'
  | 'asset_revoked'
  | 'asset_rolled_back'
  | 'workspace_asset_update_suggested'
  | 'workspace_asset_update_accepted'
  | 'workspace_asset_update_deferred'
  | 'workspace_asset_update_pinned';

export interface AssetEvent {
  event_id: string;
  asset_ref: { asset_id: string; version: string };
  event_type: AssetEventType;
  from_state?: string;
  to_state?: string;
  actor: 'user' | 'system';
  source_refs: string[];
  permission_ref?: string;
  committed_at: string;
  content_hash: string;
  receipt_ref?: string;
}

export interface AppendAssetEventInput {
  assetId: string;
  version: string;
  eventType: AssetEventType;
  fromState?: string;
  toState?: string;
  actor?: 'user' | 'system';
  sourceRefs?: string[];
  permissionRef?: string;
  contentHash?: string;
  eventId?: string;
  committedAt?: string;
}

function assertEventType(v: unknown): asserts v is AssetEventType {
  const allowed: readonly string[] = [
    'asset_created', 'asset_user_confirmed', 'asset_transfer_verified',
    'asset_effectiveness_validated', 'asset_scope_changed', 'asset_source_revoked',
    'asset_paused', 'asset_revoked', 'asset_rolled_back',
    'workspace_asset_update_suggested', 'workspace_asset_update_accepted',
    'workspace_asset_update_deferred', 'workspace_asset_update_pinned',
  ];
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error('invalid asset event type');
}

/** 单事件负载哈希：事件正文的确定性摘要（不含 event_id/时间戳，保证同内容同哈希）。 */
function hashEventPayload(input: AppendAssetEventInput): string {
  // 与 util/marketplace-tree-hash 的 sha256 输出格式一致（64 位 hex）
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const payload = JSON.stringify({
    asset_id: input.assetId,
    version: input.version,
    event_type: input.eventType,
    from_state: input.fromState,
    to_state: input.toState,
    actor: input.actor ?? 'system',
    source_refs: input.sourceRefs ?? [],
    permission_ref: input.permissionRef,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function assetEventLogPath(uid: string, assetId: string): string {
  return path.join(cogseedAgentAssetEventsDir(uid), `${assetId}.jsonl`);
}

/** 事件是否已存在（幂等检查；事件文件按资产分区、量小，读一次可接受）。 */
export async function assetEventExists(uid: string, eventId: string, assetId: string): Promise<boolean> {
  const events = await readJsonl<AssetEvent>(assetEventLogPath(uid, assetId), 10000);
  return events.some((e) => e.event_id === eventId);
}

/**
 * 追加一条资产事件（append-only，原子）。幂等：同 event_id 已存在时
 * 不重复追加并返回 appended=false。
 */
export async function appendAssetEvent(
  uid: string,
  input: AppendAssetEventInput,
): Promise<{ ok: true; event: AssetEvent; appended: boolean } | { ok: false; reason: 'write_failed' }> {
  if (!input.assetId || !input.version) throw new Error('invalid asset ref');
  assertEventType(input.eventType);

  const eventId = input.eventId ?? `evt_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const committedAt = input.committedAt ?? nowIso();
  const event: AssetEvent = {
    event_id: eventId,
    asset_ref: { asset_id: input.assetId, version: input.version },
    event_type: input.eventType,
    ...(input.fromState !== undefined ? { from_state: input.fromState } : {}),
    ...(input.toState !== undefined ? { to_state: input.toState } : {}),
    actor: input.actor ?? 'system',
    source_refs: input.sourceRefs ?? [],
    ...(input.permissionRef ? { permission_ref: input.permissionRef } : {}),
    committed_at: committedAt,
    content_hash: input.contentHash ?? hashEventPayload(input),
  };

  try {
    const file = assetEventLogPath(uid, input.assetId);
    // 幂等：重复 event_id 不追加（重试路径安全）
    if (await assetEventExists(uid, eventId, input.assetId)) {
      return { ok: true, event, appended: false };
    }
    await appendJsonlAtomic<AssetEvent>(file, event);
    return { ok: true, event, appended: true };
  } catch (err) {
    log.error(`append asset event failed user=${maskId(uid)} asset=${maskId(input.assetId)}: ${(err as Error).message}`);
    return { ok: false, reason: 'write_failed' };
  }
}

/** 读某资产的全部事件（按追加顺序）。 */
export async function listAssetEvents(uid: string, assetId: string): Promise<AssetEvent[]> {
  return readJsonl<AssetEvent>(assetEventLogPath(uid, assetId), 10000);
}

/** 事件影响的是哪条状态轴（PRD 3.6 三轴正交）。事件账本里的一条事件只会
 *  推动其中一条：确认动作动来源轴，证明动成熟度轴，暂停/撤销动治理轴。 */
export type AssetEventAxis = 'lifecycle' | 'maturity' | 'status' | 'none';

export interface AssetEventStateChange {
  axis: AssetEventAxis;
  /** 取值与 formal-assets 的规范词汇一致，不另立一套。 */
  state: string;
}

/** 事件类型 → 它推动了哪条轴上的哪个取值。
 *
 *  这里过去把三条轴压成一个扁平字符串返回，还把成熟度档位拼成
 *  `transfer_verified`（规范词汇是 `transfer_validated`），于是同一个概念在
 *  账本、资产记录和策略层各有一种写法。现在取值统一到 formal-assets 的词汇。 */
export function eventTypeToStateChange(eventType: AssetEventType): AssetEventStateChange {
  switch (eventType) {
    case 'asset_created':
    case 'asset_user_confirmed':
      return { axis: 'lifecycle', state: 'user_confirmed_unverified' };
    case 'asset_transfer_verified':
      return { axis: 'maturity', state: 'transfer_validated' };
    case 'asset_effectiveness_validated':
      return { axis: 'maturity', state: 'effectiveness_validated' };
    case 'asset_paused':
      return { axis: 'status', state: 'paused' };
    case 'asset_revoked':
      return { axis: 'status', state: 'revoked' };
    case 'asset_rolled_back':
      return { axis: 'status', state: 'rolled_back' };
    default:
      return { axis: 'none', state: 'unchanged' };
  }
}

/** 兼容出口：仍然只回一个字符串。调用方要区分轴时改用
 *  `eventTypeToStateChange`。 */
export function eventTypeToState(eventType: AssetEventType): string {
  return eventTypeToStateChange(eventType).state;
}
