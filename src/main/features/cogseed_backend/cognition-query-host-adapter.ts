/**
 * CogSeed Runtime host-tool adapter for read-only cognition queries.
 *
 * Two tools: `ontology_task_query` (Stage 1 `runOntologyTaskQuery` kernel,
 * plus the query read receipt) and `search_ability_assets` (the shared recall
 * tool suite with asset admission and agent-read receipts).
 *
 * Hard rule: the Worker never supplies scope. Every identity/scope field
 * (user, agent, project, workspace, conversation) is re-derived here from the
 * persisted CogSeed task, session and conversation — the same chain
 * `ontologyPreflight` and `runtime-controller.buildTaskExecutionContext` use —
 * and any extra input field is rejected with a stable error code.
 */
import { createLogger } from '../../logger';
import type { CogSeedHostToolResult, CogSeedHostToolScope } from './office-adapter';
import { localCalendarDay } from '../cognition/ontology/calendar-day';
import { isCalendarDate } from '../cognition/ontology/model';
import { inferOntologyTaskKind } from '../cognition/ontology/task-kind';
import type { OntologyTaskQueryLimits, OntologyTaskQueryResult } from '../cognition/ontology/task-query';

const log = createLogger('cogseed-backend:cognition-query');

export type CognitionQueryHostToolName = 'ontology_task_query' | 'search_ability_assets';

/** Strict per-tool input whitelist; anything else is a privilege escalation. */
const ONTOLOGY_TASK_QUERY_FIELDS = new Set(['query', 'queries', 'module_id', 'entity_id', 'purpose', 'task_kind', 'at']);
const SEARCH_ABILITY_ASSETS_FIELDS = new Set(['query', 'assetIds', 'k', 'offset', 'scope', 'spaceId', 'type']);

interface DerivedTaskScope {
  userId: string;
  taskId: string;
  executionId?: string;
  taskText: string;
  childTask: boolean;
  agentId?: string;
  conversationId?: string;
  spaceId?: string;
  projectId?: string;
  workspaceId?: string;
  conversationKind?: string;
}

function scopeError(content: string): { error: CogSeedHostToolResult } {
  return { error: { content, isError: true } };
}

/** Re-derive the read scope from persisted records; never trust call input. */
async function deriveTaskScope(scope: CogSeedHostToolScope): Promise<DerivedTaskScope | { error: CogSeedHostToolResult }> {
  const { readCogSeedTaskByRequestId } = await import('./task-store');
  const { readCogSeedSession } = await import('./session-store');
  const task = await readCogSeedTaskByRequestId(scope.userId, scope.requestId);
  if (!task || task.runtimeSessionId !== scope.runtimeSessionId)
    return scopeError('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE] current task scope unavailable');
  const session = await readCogSeedSession(scope.userId, task.sessionId);
  if (!session || session.ownerId !== scope.userId || session.lifecycleState !== 'active'
    || session.runtimeSessionId !== scope.runtimeSessionId || session.activeTaskId !== task.taskId)
    return scopeError('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE] current session scope unavailable');
  const conversationId = task.conversationId ?? session.conversationId;
  let projectId: string | undefined;
  let workspaceId: string | undefined;
  let conversationKind: string | undefined;
  if (conversationId) {
    const { getConversation } = await import('../chats');
    const conversation = await getConversation(scope.userId, conversationId);
    if (!conversation) return scopeError('[E_COGNITION_QUERY_SCOPE_UNAVAILABLE] current conversation scope unavailable');
    projectId = conversation.project_id || undefined;
    workspaceId = conversation.space_id || task.spaceId || undefined;
    conversationKind = conversation.kind || undefined;
  } else {
    workspaceId = task.spaceId || undefined;
  }
  return {
    userId: scope.userId,
    taskId: task.taskId,
    ...(task.executionId ? { executionId: task.executionId } : {}),
    taskText: task.task,
    childTask: Boolean(task.parentTaskId) || (task.coordinationDepth ?? 0) > 0,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(workspaceId ? { spaceId: workspaceId, workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(conversationKind ? { conversationKind } : {}),
  };
}

function rejectUnknownFields(name: CognitionQueryHostToolName, input: Record<string, unknown>): CogSeedHostToolResult | undefined {
  const allowed = name === 'ontology_task_query' ? ONTOLOGY_TASK_QUERY_FIELDS : SEARCH_ABILITY_ASSETS_FIELDS;
  const extra = Object.keys(input).filter(key => !allowed.has(key));
  if (extra.length) {
    return {
      content: `[E_COGNITION_QUERY_INPUT_REJECTED] ${name} does not accept: ${extra.sort().join(', ')}. Scope is derived by the host.`,
      isError: true,
    };
  }
  return undefined;
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, max)
    : [];
}

const HOST_ONTOLOGY_QUERY_LIMITS: Partial<OntologyTaskQueryLimits> = {
  maxModules: 10,
  maxRecords: 10,
  maxFacts: 40,
  maxUncertainFacts: 20,
  maxRules: 20,
  maxConflicts: 20,
};
export const HOST_ONTOLOGY_QUERY_MAX_CHARS = 20_000;

function rowRefKey(row: { module: { id: string }; source: { recordId: string; version: number } }): string {
  return `${row.module.id}\0${row.source.recordId}\0${row.source.version}`;
}

function filterReadRefs(result: OntologyTaskQueryResult): OntologyTaskQueryResult['readRefs'] {
  const keys = new Set([...result.facts, ...result.uncertainFacts, ...result.rules].map(rowRefKey));
  return result.readRefs.filter(ref => keys.has(`${ref.moduleId}\0${ref.recordId}\0${ref.recordVersion}`));
}

/** The Runtime host transport caps results before they reach the model. Bound
 * the payload here first so the read receipt never cites rows that were cut. */
export function boundCognitionQueryResult(
  result: OntologyTaskQueryResult,
  maxChars = HOST_ONTOLOGY_QUERY_MAX_CHARS,
): OntologyTaskQueryResult {
  const fits = (value: OntologyTaskQueryResult) => JSON.stringify(value).length <= maxChars;
  if (fits(result)) return result;
  const bounded: OntologyTaskQueryResult = { ...result, truncated: { ...result.truncated } };
  if (bounded.records.length) {
    bounded.truncated.records += bounded.records.length;
    bounded.records = [];
  }
  if (!fits(bounded) && bounded.modules.length) {
    bounded.truncated.modules += bounded.modules.length;
    bounded.modules = [];
  }
  const trim = (key: 'rules' | 'facts' | 'uncertainFacts') => {
    while (!fits(bounded) && bounded[key].length > 0) {
      const keep = Math.floor(bounded[key].length / 2);
      bounded.truncated[key] += bounded[key].length - keep;
      if (key === 'rules') bounded.rules = bounded.rules.slice(0, keep);
      else if (key === 'facts') bounded.facts = bounded.facts.slice(0, keep);
      else bounded.uncertainFacts = bounded.uncertainFacts.slice(0, keep);
    }
  };
  if (!fits(bounded)) trim('rules');
  if (!fits(bounded)) trim('facts');
  if (!fits(bounded)) trim('uncertainFacts');
  if (!fits(bounded) && bounded.conflicts.length) {
    bounded.conflicts = [];
    bounded.conflictsComplete = false;
  }
  bounded.readRefs = filterReadRefs(bounded);
  return bounded;
}

async function runOntologyTaskQueryTool(
  input: Record<string, unknown>,
  scope: CogSeedHostToolScope,
  derived: DerivedTaskScope,
): Promise<CogSeedHostToolResult> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query || query.length > 200)
    return { content: '[E_COGNITION_QUERY_INVALID_INPUT] ontology_task_query requires a query of at most 200 characters', isError: true };
  const queries = stringList(input.queries, 5).filter(value => value.length <= 200);
  if (typeof input.at === 'string' && input.at && !isCalendarDate(input.at))
    return { content: '[E_COGNITION_QUERY_INVALID_TIME] at must be a calendar day', isError: true };
  if (typeof input.purpose === 'string' && input.purpose.length > 200)
    return { content: '[E_COGNITION_QUERY_INVALID_INPUT] purpose must be at most 200 characters', isError: true };
  if (typeof input.task_kind === 'string' && input.task_kind.length > 80)
    return { content: '[E_COGNITION_QUERY_INVALID_INPUT] task_kind must be at most 80 characters', isError: true };
  const context = {
    ...(derived.agentId ? { agentId: derived.agentId } : {}),
    taskText: derived.taskText,
    purpose: typeof input.purpose === 'string' && input.purpose ? input.purpose : derived.taskText,
    ...(derived.projectId ? { projectId: derived.projectId } : {}),
    ...(derived.workspaceId ? { workspaceId: derived.workspaceId } : {}),
    ...(derived.conversationKind ? { conversationKind: derived.conversationKind } : {}),
  };
  const taskKind = typeof input.task_kind === 'string' && input.task_kind
    ? input.task_kind
    : inferOntologyTaskKind(typeof input.purpose === 'string' && input.purpose ? input.purpose : derived.taskText);
  const { runOntologyTaskQuery } = await import('../cognition/ontology/task-query');
  const result = await runOntologyTaskQuery({
    userId: derived.userId,
    context,
    query,
    ...(queries.length ? { queries } : {}),
    at: typeof input.at === 'string' && input.at ? input.at : localCalendarDay(),
    limits: HOST_ONTOLOGY_QUERY_LIMITS,
    ...(typeof input.module_id === 'string' && input.module_id ? { moduleId: input.module_id } : {}),
    ...(typeof input.entity_id === 'string' && input.entity_id ? { entityId: input.entity_id } : {}),
    ...(typeof input.purpose === 'string' && input.purpose ? { purpose: input.purpose } : {}),
    ...(taskKind ? { taskKind } : {}),
  });
  const bounded = boundCognitionQueryResult(result);
  let readReceipt: 'recorded' | 'no_refs' | 'unavailable' = bounded.readRefs.length ? 'recorded' : 'no_refs';
  if (bounded.readRefs.length) {
    try {
      const { recordOntologyQueryReadReceipt } = await import('../cognition/ontology/query-receipt');
      const receipt = await recordOntologyQueryReadReceipt(derived.userId, derived.taskId, bounded.readRefs, derived.executionId);
      if (!receipt) readReceipt = 'no_refs';
    } catch (error) {
      readReceipt = 'unavailable';
      log.warn('runtime ontology query read receipt failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { content: JSON.stringify({ ...bounded, readReceipt }) };
}

async function runSearchAbilityAssetsTool(
  input: Record<string, unknown>,
  derived: DerivedTaskScope,
): Promise<CogSeedHostToolResult> {
  const { createSearchAbilityAssetsTool } = await import('../recall/asset-search');
  const tool = createSearchAbilityAssetsTool(derived.userId, {
    turnId: derived.taskId,
    ...(derived.conversationId ? { cid: derived.conversationId } : {}),
    ...(derived.agentId ? { agentId: derived.agentId } : {}),
    ...(derived.spaceId ? { spaceId: derived.spaceId } : {}),
    ...(derived.projectId ? { projectId: derived.projectId } : {}),
    ...(derived.conversationKind ? { conversationKind: derived.conversationKind } : {}),
    taskText: derived.taskText,
  });
  // The shared feature owns admission, catalog ranking, agent-read receipts
  // and usage ledgers; pass only whitelisted fields through. It reads no
  // SDK context state, matching the model adapter's plain-call pattern.
  const result = await tool.execute({
    ...(typeof input.query === 'string' && input.query.trim() ? { query: input.query } : {}),
    ...(Array.isArray(input.assetIds) ? { assetIds: stringList(input.assetIds, 6) } : {}),
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(typeof input.scope === 'string' && input.scope ? { scope: input.scope } : {}),
    ...(typeof input.spaceId === 'string' && input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(typeof input.type === 'string' && input.type ? { type: input.type } : {}),
  }, { state: {} });
  return { content: result.content, ...(result.isError ? { isError: true } : {}) };
}

export async function runCognitionQueryHostTool(
  name: CognitionQueryHostToolName,
  input: Record<string, unknown>,
  scope: CogSeedHostToolScope,
): Promise<CogSeedHostToolResult> {
  try {
    const rejected = rejectUnknownFields(name, input || {});
    if (rejected) return rejected;
    const derived = await deriveTaskScope(scope);
    if ('error' in derived) return derived.error;
    if (derived.childTask) {
      return { content: '[E_COGNITION_QUERY_FORBIDDEN] delegated child tasks cannot read conversation cognition', isError: true };
    }
    const receptionTask = await import('./runtime-tool-policy')
      .then(module => module.isA2AReceptionRequest(scope.userId, scope.requestId, scope.runtimeSessionId))
      .catch(() => true);
    if (receptionTask) {
      return { content: '[E_COGNITION_QUERY_FORBIDDEN] reception tasks cannot read owner cognition', isError: true };
    }
    if (name === 'ontology_task_query') return await runOntologyTaskQueryTool(input, scope, derived);
    return await runSearchAbilityAssetsTool(input, derived);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('cognition query host tool failed', { tool: name, error: message });
    return { content: `[E_COGNITION_QUERY_FAILED] ${message}`, isError: true };
  }
}
