/** Host-owned execution → persisted reply → produced-content binding.
 * Old executions remain text-only; new unbound or changed results fail closed. */
import { isDeepStrictEqual } from 'node:util';
import { readJsonl, safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import * as executions from '../execution-records';
import { readPersistedResultContent, type PersistedResultContent } from './persisted-result-content';

interface ResultMessage { id: string; text?: string; from?: string; turn_id?: string; turn_end?: boolean; produced?: unknown[]; deleted_at?: string; failure_kind?: string }

function refsMatch(current: PersistedResultContent['refs'], expected: PersistedResultContent['refs']): boolean {
  // Existing plain-text bindings predate raw-byte integrity. Preserve their
  // original text-hash contract rather than invalidating history on upgrade.
  return isDeepStrictEqual(current.map((ref, index) => {
    const result = { ...ref };
    if (expected[index]?.sourceHash === undefined) delete result.sourceHash;
    return result;
  }), expected);
}

export async function bindExecutionResultMessage(userId: string, executionId: string, cid: string, message: ResultMessage): Promise<void> {
  const record = await executions.read(userId, executionId);
  if (record.resultMessage !== 'pending') return;
  if (record.status !== 'completed' || record.conversationId !== cid || !message.turn_end
    || executionId !== `turn-${message.turn_id}` || (record.agentId && record.agentId !== message.from)) {
    throw new Error('execution reply identity mismatch');
  }
  const content = await readPersistedResultContent(userId, cid, message);
  await executions.bindCompletedResultMessage(userId, executionId, cid, { id: message.id, refs: content.refs });
}

/** Anonymous workers have no UI message. The bus supplies its settled text
 * and trusted produced list; they survive deletion of the throwaway session. */
export async function bindExecutionResultOutput(userId: string, executionId: string, cid: string, actorId: string,
  text: string, produced: string[]): Promise<void> {
  const record = await executions.read(userId, executionId);
  if (record.resultOutput !== 'pending') return;
  if (record.status !== 'completed' || record.conversationId !== cid || record.agentId !== actorId || !record.resultRef)
    throw new Error('execution output identity mismatch');
  const content = await readPersistedResultContent(userId, cid, { id: executionId, text, produced, sourceKind: 'execution_output' });
  await executions.bindCompletedResultOutput(userId, executionId, { schemaVersion: 1, executionId,
    conversationId: cid, agentId: actorId, resultRef: record.resultRef, text, produced, refs: content.refs });
}

export async function readExecutionResultContent(userId: string, record: executions.ExecutionRecord): Promise<PersistedResultContent> {
  if (record.resultOutput) {
    const recovered = await executions.readCompletedResultOutput(userId, record.executionId);
    const content = await readPersistedResultContent(userId, recovered.manifest.conversationId, {
      id: record.executionId, text: recovered.manifest.text, produced: recovered.manifest.produced, sourceKind: 'execution_output',
    });
    if (!content.coverage.complete || recovered.record.resultOutput === 'pending'
      || !refsMatch(content.refs, recovered.record.resultOutput?.refs || [])) throw new Error('persisted execution output changed or incomplete');
    return content;
  }
  if (!record.resultMessage) {
    const text = await executions.readResult(userId, record.executionId, record.resultRef!);
    return { text, refs: [], coverage: { complete: true, totalFiles: 0, readableFiles: 0 } };
  }
  if (!record.conversationId) throw new Error('execution reply not bound');
  const rows = [...new Map((await readJsonl<ResultMessage>(conversationMessageReadFile(userId, record.conversationId), 0))
    .map(row => [row.id, row])).values()];
  if (record.resultMessage === 'pending') {
    // A crash after transcript persistence but before the binding needs no
    // agent rerun. Only one official, successful host reply can repair it.
    const eligible = rows.filter(row => !row.deleted_at && !row.failure_kind && row.turn_end
      && record.executionId === `turn-${row.turn_id}` && (!record.agentId || record.agentId === row.from));
    if (eligible.length !== 1) throw new Error('execution reply not bound');
    await bindExecutionResultMessage(userId, record.executionId, record.conversationId, eligible[0]);
    record = await executions.read(userId, record.executionId);
  }
  const message = rows.find(row => row.id === (record.resultMessage as { id: string }).id && !row.deleted_at && !row.failure_kind);
  if (!message || record.executionId !== `turn-${message.turn_id}` || !message.turn_end
    || (record.agentId && record.agentId !== message.from)) throw new Error('persisted execution reply unavailable');
  const content = await readPersistedResultContent(userId, record.conversationId, message);
  if (!content.coverage.complete || record.resultMessage === 'pending' || !refsMatch(content.refs, record.resultMessage?.refs || [])) {
    throw new Error('persisted execution result changed or incomplete');
  }
  return content;
}


export interface GroupExecutionResultSource {
  kind: 'group_execution'; executionId: string; conversationId: string; actorId: string;
}
export type CognitionResultSource = import('./runtime-result-content').RuntimeResultSource | GroupExecutionResultSource;
export interface DispatchBinding {
  executionId: string; conversationId: string; actorId: string; runId?: string; sourceMessageId?: string;
  scope: { projectId?: string; workspaceId?: string; conversationKind?: string; agentId?: string; fileKinds?: string[] };
}
export function validGroupExecutionSource(source: GroupExecutionResultSource): boolean {
  return source?.kind === 'group_execution' && [source.executionId, source.conversationId, source.actorId].every(safeId);
}
export function validDispatchBinding(value: unknown, taskRunId: string): value is DispatchBinding {
  if (!value || typeof value !== 'object') return false;
  const binding = value as DispatchBinding;
  return binding.executionId === `turn-${taskRunId}` && [binding.executionId, binding.conversationId, binding.actorId].every(safeId)
    && (binding.runId === undefined || safeId(binding.runId)) && (binding.sourceMessageId === undefined || safeId(binding.sourceMessageId))
    && !!binding.scope && typeof binding.scope === 'object'
    && [binding.scope.projectId, binding.scope.workspaceId, binding.scope.agentId].every(id => id === undefined || safeId(id))
    && (binding.scope.conversationKind === undefined || typeof binding.scope.conversationKind === 'string')
    && (binding.scope.fileKinds === undefined || Array.isArray(binding.scope.fileKinds) && binding.scope.fileKinds.every(kind => typeof kind === 'string'));
}
export const executionResultAnchor = (executionId: string) => `execution-result-${executionId}`;

/** Reads the host-bound output manifest or official reply, never caller-named files. */
export async function readGroupExecutionResult(userId: string, source: GroupExecutionResultSource) {
  if (!safeId(userId) || !validGroupExecutionSource(source)) throw new Error('invalid group execution result');
  const record = await executions.read(userId, source.executionId);
  if (record.status !== 'completed' || record.boundary !== 'real' || record.conversationId !== source.conversationId
    || record.agentId !== source.actorId || !(record.resultOutput || record.resultMessage) || !source.executionId.startsWith('turn-')) throw new Error('group execution result not bound');
  const content = await readExecutionResultContent(userId, record);
  const settled = await executions.read(userId, source.executionId);
  const anchorId = settled.resultOutput ? executionResultAnchor(source.executionId)
    : settled.resultMessage && settled.resultMessage !== 'pending' ? settled.resultMessage.id : undefined;
  if (!anchorId) throw new Error('group execution result not bound');
  return { content, source, taskRunId: source.executionId.slice(5), anchorId,
    fingerprint: JSON.stringify([source, record.resultRef, content]) };
}

/** The original submitted message is an anchor, not a synthetic worker reply. */
export async function readDispatchSourceMessage(userId: string, cid: string, runId?: string, sourceMessageId?: string) {
  if (!runId || !safeId(runId)) return undefined;
  const rows = await readJsonl<{id:string; from:string; run_id?:string; action_request_id?:string; deleted_at?:string; text?:string}>(conversationMessageReadFile(userId, cid), 100_000);
  const candidates = [...new Map(rows.map(row => [row.id, row])).values()].filter(row => row.from === 'user' && !row.deleted_at
    && row.run_id === runId && (!sourceMessageId || row.id === sourceMessageId) && row.action_request_id && safeId(row.action_request_id));
  if (candidates.length !== 1) return undefined;
  const source = candidates[0];
  const { _readSubmitClaim } = await import('../group_chat');
  const claim = await _readSubmitClaim(userId, cid, source.action_request_id!);
  return claim?.state === 'accepted' && claim.message_id === source.id && claim.run_id === runId ? source : undefined;
}

/** Current conversation scope and the settled execution must still match the
 * host's dispatch. Historical unbound receipts remain statistics only. */
export async function readDispatchBindingContext(userId: string, injection: import('./injection-receipt').InjectionReceipt,
  input: { cid: string; taskRunId: string; messageId: string }) {
  const binding = injection.dispatchBinding;
  if (injection.status !== 'dispatched' || injection.boundary !== 'real' || !validDispatchBinding(binding, input.taskRunId)
    || binding.conversationId !== input.cid || injection.messageId !== input.messageId) return undefined;
  const record = await executions.read(userId, binding.executionId);
  if (record.status !== 'completed' || record.boundary !== 'real' || record.conversationId !== input.cid || record.agentId !== binding.actorId) return undefined;
  if (record.resultOutput) {
    if (input.messageId !== executionResultAnchor(record.executionId)) return undefined;
    await executions.readCompletedResultOutput(userId, record.executionId);
  } else {
    if (record.resultMessage === 'pending') await readExecutionResultContent(userId, record);
    const fresh = await executions.read(userId, record.executionId);
    if (!fresh.resultMessage || fresh.resultMessage === 'pending' || fresh.resultMessage.id !== input.messageId) return undefined;
  }
  const { getConversation } = await import('../chats');
  const conversation = await getConversation(userId, input.cid);
  if (!conversation || conversation.deleted_at || (conversation.project_id || undefined) !== binding.scope.projectId
    || (conversation.space_id || undefined) !== binding.scope.workspaceId || (conversation.kind || undefined) !== binding.scope.conversationKind) return undefined;
  return binding.scope;
}
