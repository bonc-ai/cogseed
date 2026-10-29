/** Read the isolated Runtime's already-persisted terminal text. No UI message,
 * file manifest or generic execution record is synthesized. */
import { createHash } from 'node:crypto';
import { readCogSeedTask } from '../cogseed_backend/task-store';
import { readRuntimeRunEvents, readRuntimeRunMeta } from '../cogseed_runtime/store';
import { getConversation } from '../chats';
import type { PersistedResultContent } from './persisted-result-content';
export interface RuntimeResultSource {
  kind: 'runtime_terminal'; taskId: string; runId: string; requestId: string; runtimeSessionId: string;
}
export const runtimeResultAnchor = (executionId: string) => `runtime-result-${executionId}`;

export async function readRuntimeResultContent(userId: string, taskId: string) {
  const task = await readCogSeedTask(userId, taskId);
  if (!task || task.ownerId !== userId || task.status !== 'completed'
    || task.executionKind && task.executionKind !== 'cogseed-native'
    || !task.runtimeRunId || !task.executionId || !task.conversationId) throw new Error('runtime result unavailable');
  const [meta, events, conversation] = await Promise.all([readRuntimeRunMeta(userId, task.runtimeRunId),
    readRuntimeRunEvents(userId, task.runtimeRunId), getConversation(userId, task.conversationId)]);
  if (!conversation || !meta || meta.run_id !== task.runtimeRunId || meta.request_id !== task.requestId
    || meta.runtime_session_id !== task.runtimeSessionId || ['failed', 'cancelled'].includes(meta.status)
    || events.some(event => event.request_id !== task.requestId || event.runtime_session_id !== task.runtimeSessionId
      || event.metadata?.runtime_run_id && event.metadata.runtime_run_id !== task.runtimeRunId))
    throw new Error('runtime result identity mismatch');
  const terminals = events.filter(event => event.type === 'result' || event.type === 'error');
  const terminal = terminals[0];
  if (terminals.length !== 1 || terminal.type !== 'result' || terminal.status !== 'completed' || !terminal.text?.trim())
    throw new Error('runtime result is not a unique completed result');
  const source: RuntimeResultSource = { kind: 'runtime_terminal', taskId, runId: task.runtimeRunId,
    requestId: task.requestId, runtimeSessionId: task.runtimeSessionId };
  const content: PersistedResultContent = { text: terminal.text,
    refs: [{ kind: 'execution_output', id: task.runtimeRunId, status: 'readable',
      contentHash: createHash('sha256').update(terminal.text).digest('hex'), contentRange: { start: 0, end: terminal.text.length } }],
    coverage: { complete: true, totalFiles: 0, readableFiles: 0 } };
  const after = await readCogSeedTask(userId, taskId);
  if (JSON.stringify(after) !== JSON.stringify(task)) throw new Error('runtime result task changed');
  const scope = { agentId: task.agentId, projectId: conversation.project_id || undefined,
    workspaceId: conversation.space_id || task.spaceId, conversationKind: conversation.kind };
  return { source, content, taskText: task.task, cid: task.conversationId, taskRunId: taskId,
    anchorId: runtimeResultAnchor(task.executionId), agentId: task.agentId, abilityAssetIds: task.abilityAssetIds || [],
    scope, fingerprint: JSON.stringify([task, source, terminal, scope]) };
}
