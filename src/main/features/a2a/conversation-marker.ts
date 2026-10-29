/**
 * A2A marker on a local conversation.
 *
 * One contact relation may own multiple conversation instances. A single instance
 * is shared bidirectionally by both clients, while its marker independently tracks
 * inbound and outgoing directions.
 *
 * The marker records who the counterpart is plus *which directions the instance has seen*:
 * `inbound` = the peer has asked me here (that is what needs my confirmation),
 * `outgoing` = I have asked the peer here. An instance may carry both; these flags
 * are authoritative, while `role` remains read compatibility for legacy markers.
 *
 * The state machine follows PRD §8 minus the retired terminal states: there is no
 * 「结束」 while the relationship holds (D-19), so `ended` only appears when a
 * contact is removed (D-19/H-13). `state` describes the *inbound* visit; an instance
 * with only outgoing questions stays `active`.
 */

export const A2A_CONVERSATION_ROLES = ['initiator', 'receiver'] as const;
export type A2AConversationRole = typeof A2A_CONVERSATION_ROLES[number];

export const A2A_CONVERSATION_STATES = ['waiting', 'active', 'confirming', 'refused', 'expired', 'ended'] as const;
export type A2AConversationState = typeof A2A_CONVERSATION_STATES[number];

export interface A2AConversationMarker {
  /** 对方在这条会话里问过我（来访，需要本人确认）。 */
  inbound?: boolean;
  /** 我在这条会话里问过对方（提问，不需要确认）。 */
  outgoing?: boolean;
  /**
   * 旧数据的字段：`receiver`/`initiator`。只读兼容——解析时折算成 inbound/outgoing，
   * 新写入不再产生它。
   */
  role?: A2AConversationRole;
  /** The other account (`cs_...`). */
  peer_user_id: string;
  /** Display name captured at accept time; renamed peers refresh from the roster. */
  peer_name?: string;
  /** The assistant that answers on the receiving side (D-01). */
  assistant_agent_id?: string;
  /** Reception scope chosen by the receiver (FR-22): workspace path. */
  workspace?: string;
  state: A2AConversationState;
  /** Current conversation-instance id, including legacy deterministic fallback ids. */
  exchange_id?: string;
  /** Set when the 5-minute confirmation window passed on this exchange (D-23). */
  nudged?: boolean;
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function bounded(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Normalise a stored/incoming marker. Returns null for anything that is not a
 * well-formed marker, so a corrupt field can never make a conversation look like
 * an A2A one by accident.
 */
export function parseA2AConversationMarker(raw: unknown): A2AConversationMarker | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;

  const legacyRole = bounded(value.role, 20) as A2AConversationRole;
  const legacyOk = A2A_CONVERSATION_ROLES.includes(legacyRole);
  // 新数据用 inbound/outgoing；旧数据只有 role，折算成同样的两个方向位。
  const inbound = value.inbound === true || (legacyOk && legacyRole === 'receiver');
  const outgoing = value.outgoing === true || (legacyOk && legacyRole === 'initiator');
  if (!inbound && !outgoing && !legacyOk) return null;

  const peer = bounded(value.peer_user_id, 128);
  if (!peer || !ACCOUNT_ID.test(peer)) return null;

  const state = bounded(value.state, 20) as A2AConversationState;
  if (!A2A_CONVERSATION_STATES.includes(state)) return null;

  const assistant = bounded(value.assistant_agent_id, 128);
  const workspace = bounded(value.workspace, 1024);
  const peerName = bounded(value.peer_name, 120);
  const exchangeId = bounded(value.exchange_id, 120);

  return {
    ...(inbound ? { inbound: true } : {}),
    ...(outgoing ? { outgoing: true } : {}),
    // 旧字段继续带出去，读它的渲染层/测试不需要同时改。
    ...(legacyOk ? { role: legacyRole } : {}),
    peer_user_id: peer,
    state,
    ...(value.nudged === true ? { nudged: true } : {}),
    ...(peerName ? { peer_name: peerName } : {}),
    ...(assistant ? { assistant_agent_id: assistant } : {}),
    ...(workspace ? { workspace } : {}),
    ...(exchangeId && exchangeId.startsWith('a2a-') ? { exchange_id: exchangeId } : {}),
  };
}

/**
 * 方向判定必须同时认旧字段：测试和运行中的临时对象常常直接构造 marker，
 * 不走 parse 的折算，所以 `role` 还在时也要读出来。
 */
export function isInboundMarker(marker: A2AConversationMarker | null | undefined): boolean {
  return !!marker && (marker.inbound === true || marker.role === 'receiver');
}

export function isOutboundMarker(marker: A2AConversationMarker | null | undefined): boolean {
  return !!marker && (marker.outgoing === true || marker.role === 'initiator');
}

/** Whether this conversation should be labelled「A2A」in the sidebar. */
export function isA2AConversation(marker: A2AConversationMarker | null | undefined): boolean {
  return !!marker && marker.state !== 'ended';
}

/** Sidebar/A2A label key for the current state. */
export function a2aConversationLabelKey(marker: A2AConversationMarker): string {
  // 来访等的是**本人**确认（D-04），读成「等待对方接受」会让用户以为在等对面。
  // 过期同理：来访方要读成「我方未及时接待」，不能复用提问方视角的 expired。
  if (isInboundMarker(marker)) {
    if (marker.state === 'waiting') return 'chat.a2a.incoming_waiting';
    if (marker.state === 'expired') return 'chat.a2a.incoming_expired';
    return 'chat.a2a.incoming';
  }
  // 确认中过了 5 分钟（D-23）就不再是「正在确认」，而是「需要本人确认，稍后回复」。
  if (marker.state === 'confirming') {
    return marker.nudged ? 'chat.a2a.confirming_nudged' : 'chat.a2a.confirming';
  }
  return `chat.a2a.${marker.state}`;
}

/** Allowed transitions; anything else is a routing bug rather than a UI state. */
const TRANSITIONS: Record<A2AConversationState, readonly A2AConversationState[]> = {
  waiting: ['active', 'refused', 'expired', 'ended'],
  // 「确认中」是进行中的子状态：助理在等本人拍板，拍完就回到进行中（PRD §8）。
  active: ['confirming', 'ended'],
  confirming: ['active', 'ended'],
  refused: ['ended'],
  expired: ['waiting', 'active', 'ended'],
  ended: [],
};

export function canTransitionA2AState(from: A2AConversationState, to: A2AConversationState): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

export function transitionA2AConversation(
  marker: A2AConversationMarker,
  next: A2AConversationState,
): A2AConversationMarker {
  if (!canTransitionA2AState(marker.state, next)) {
    throw new Error(`invalid a2a transition ${marker.state} -> ${next}`);
  }
  return { ...marker, state: next };
}
