/**
 * Main-process capability derivation for CogSeed Runtime runs.
 *
 * Capabilities are derived exclusively from persisted CogSeed records — the
 * request claim → task → session chain — never from worker-supplied input or
 * model parameters. Today only `messaging.proactive` exists; it is granted
 * only to a live top-level Commander session whose owner, runtime session and
 * lifecycle all match the pending request. The tool runner filters the model's
 * catalog by this, and the host router re-derives it independently for every
 * call, so a worker that fabricates capabilities or calls a host tool directly
 * is still denied.
 */

import { RUNTIME_CAPABILITIES } from '../cogseed_runtime/protocol';
import { readCogSeedSession } from './session-store';
import { readCogSeedTaskByRequestId } from './task-store';

/** Resolve the capability grants for one pending runtime request. */
export async function resolveRuntimeCapabilities(
  userId: string,
  requestId: string,
  runtimeSessionId: string,
): Promise<string[]> {
  const task = await readCogSeedTaskByRequestId(userId, requestId);
  if (!task || task.runtimeSessionId !== runtimeSessionId) return [];
  const session = await readCogSeedSession(userId, task.sessionId);
  if (!session
    || session.ownerId !== userId
    || session.lifecycleState !== 'active'
    || session.runtimeSessionId !== runtimeSessionId) {
    return [];
  }
  if (session.sessionKind === 'commander'
    && session.actorRole === 'commander'
    && session.actorId === 'commander') {
    return [...RUNTIME_CAPABILITIES];
  }
  return [];
}
