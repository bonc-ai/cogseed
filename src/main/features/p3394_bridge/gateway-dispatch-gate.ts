/**
 * Dispatch gate for agents reached through a p3394 gateway.
 *
 * The runner path validates every dispatch with `assertAgentChatDispatchable`,
 * but a gateway turn spawns the CLI in ANOTHER process — the runner's gate never
 * runs there. Without this gate a retired/disabled agent (including the migration
 * tombstone `disabled_reason: 'cli-runtime-retired'`) stays reachable through the
 * user-facing path, which is exactly the "失效后仍被调用" failure mode.
 *
 * Deliberately conservative in one direction: `null` policy means "this id is not
 * in the local catalog", NOT "unavailable". External nodes live outside the local
 * catalog, so only a positively-known non-dispatchable agent blocks — otherwise
 * this gate would silently kill every external agent.
 *
 * Kept in its own module so it can be tested without loading `app-wiring`.
 */

import {
  AGENT_CHAT_UNAVAILABLE_ERROR_CODE,
  MANAGEMENT_ONLY_AGENT_ERROR_CODE,
  getAgentDispatchPolicy,
  isAgentChatDispatchable,
} from '../agent-dispatch-policy.js';

export interface GatewayDispatchBlock {
  /** A known-but-not-dispatchable agent is a configuration/state problem, not a
   *  transient runtime one — retrying the same turn would fail identically. */
  failureKind: 'config';
  failureCode: string;
  error: string;
}

/** Returns the terminal failure when this agent must not be dispatched through a
 *  gateway, or `null` when dispatch may proceed. */
export async function gatewayDispatchBlock(
  uid: string,
  agentId: string | null | undefined,
): Promise<GatewayDispatchBlock | null> {
  const id = String(agentId ?? '').trim();
  if (!uid || !id) return null;
  let policy: Awaited<ReturnType<typeof getAgentDispatchPolicy>>;
  try {
    policy = await getAgentDispatchPolicy(uid, id);
  } catch {
    // A policy read must never turn a dispatch into an exception: this path used
    // to be throw-free, and failing open keeps today's behavior (the gateway and
    // the remote peer still enforce their own checks).
    return null;
  }
  if (!policy || isAgentChatDispatchable(policy)) return null;
  const failureCode = policy.interaction_mode === 'management_only'
    ? MANAGEMENT_ONLY_AGENT_ERROR_CODE
    : AGENT_CHAT_UNAVAILABLE_ERROR_CODE;
  return { failureKind: 'config', failureCode, error: 'p3394_agent_unavailable: ' + failureCode };
}
