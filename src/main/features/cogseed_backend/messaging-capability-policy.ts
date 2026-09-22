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
import { readCogSeedCoordination } from './coordinator';
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
  const capabilities: string[] = [];
  if (session.sessionKind === 'commander'
    && session.actorRole === 'commander'
    && session.actorId === 'commander') {
    for (const capability of RUNTIME_CAPABILITIES) {
      if (capability !== 'cogseed.workflow') capabilities.push(capability);
    }
  }
  // cogseed.workflow 与「是不是 Commander」无关：只有**协调者本身**才拿得到它。
  // 协调 id 由调用方自己的 task id 推导（而不是 task.coordinationId）——被委派的
  // 子任务虽然带着父级 coordinationId，但宿主路由按调用任务推导，子任务驱动不了
  // 那个 run，所以也不该拿到工具。否则 cogseed_workflow 等四个宿主工具在没有
  // workflow 的任务里必然报 “CogSeed workflow not found” 让整轮失败（真机复现）。
  const coordinationId = `cogseed-coord-${task.taskId.slice('cogseed-task-'.length)}`;
  const coordination = await readCogSeedCoordination(userId, coordinationId).catch(() => null);
  if (coordination?.workflowRunId) capabilities.push('cogseed.workflow');
  return capabilities;
}
