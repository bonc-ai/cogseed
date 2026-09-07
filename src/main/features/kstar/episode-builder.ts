import * as path from 'node:path';

import { nowIso } from '../../storage';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../cogseed_runtime/protocol';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from '../recall/source-service';
import type { KstarAgentAction, KstarEpisodeRecord, KstarToolCall, KstarTaskStatus } from './types';

const MAX_TEXT = 4_000;
const MAX_SUMMARY = 600;
const MESSAGE_TIME_TOLERANCE_MS = 5_000;

export interface RuntimeKstarEpisodeInput {
  userId: string;
  runId: string;
  request: RuntimeRunRequest;
  events: RuntimeEventEnvelope[];
  createdAt?: string;
}

export interface GroupKstarEpisodeInputRefs {
  /** Execution-evaluation cognition sources consulted during the run. */
  executionEvaluationRefs?: CognitionSourceRef[];
  /** Active user teaching signals bound to this run. */
  userTeachingSignalRefs?: CognitionSourceRef[];
  /** Authorized external-system (connector) sources consulted. */
  authorizedExternalSystemRefs?: CognitionSourceRef[];
}

export interface GroupKstarMessageInput {
  id: string;
  ts: string;
  from: string;
  text: string;
  produced?: string[];
  failure_kind?: string;
  failure_code?: string;
  system_kind?: string;
  artifacts?: Array<{ id: string; title?: string }>;
  created_agents?: Array<{ agent_id: string; name?: string }>;
  created_skills?: Array<{ skill_id: string; name?: string }>;
  plan_announcement?: boolean;
  dispatch?: boolean;
  kstar_dispatch_narration?: { target_agent_id: string; workflow_step_id?: string };
  process?: Array<
    | { type: 'progress'; text: string; event?: { stream: string; data?: unknown } }
    | { type: 'event'; event: { stream: string; data?: unknown } }
  >;
  recall_citations?: Array<{
    asset_id: string;
    version: string;
    projection_id: string;
    forecast_id?: string;
  }>;
}

export interface GroupKstarEpisodeInput extends GroupKstarEpisodeInputRefs {
  userId: string;
  runId: string;
  conversationId: string;
  status: KstarTaskStatus;
  startedAtMs: number;
  finishedAtMs: number;
  messages: GroupKstarMessageInput[];
  projectionId?: string;
  forecastId?: string;
  wakeRequestId?: string;
  logicalRunId?: string;
  executionId?: string;
  createdAt?: string;
}

function compactText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  return compacted.length <= max ? compacted : `${compacted.slice(0, Math.max(1, max - 1))}…`;
}

function safePathSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.basename(value) || undefined;
}

function terminalRuntimeStatus(events: RuntimeEventEnvelope[]): {
  status: KstarTaskStatus;
  finalText?: string;
  failureKind?: string;
  failureCode?: string;
} {
  const terminal = [...events].reverse().find((event) => event.type === 'result' || event.type === 'error');
  if (!terminal) return { status: 'failed', failureKind: 'missing_terminal_event', failureCode: 'missing_terminal_event' };
  if (terminal.type === 'result' && terminal.status === 'completed') {
    return { status: 'completed', ...(compactText(terminal.text) ? { finalText: compactText(terminal.text) } : {}) };
  }
  const metadata = terminal.metadata ?? {};
  const failureKind = typeof metadata.failure_kind === 'string' ? metadata.failure_kind : undefined;
  const failureCode = typeof metadata.code === 'string' ? metadata.code : undefined;
  if (failureKind?.toLowerCase().includes('timeout') || failureCode?.toLowerCase().includes('timeout')) {
    return { status: 'timed_out', failureKind: failureKind || 'timeout', ...(failureCode ? { failureCode } : {}) };
  }
  if (terminal.status === 'cancelled') {
    return { status: 'cancelled', failureKind: 'cancelled', ...(failureCode ? { failureCode } : {}) };
  }
  return {
    status: 'failed',
    ...(failureKind ? { failureKind } : { failureKind: 'runtime' }),
    ...(failureCode ? { failureCode } : {}),
  };
}

function runtimeMeasurements(events: RuntimeEventEnvelope[]): Pick<KstarEpisodeRecord['r'], 'durationMs' | 'toolCallCount' | 'failedToolCount' | 'networkAccess'> {
  const starts = events.map((event) => event.metadata?.started_at_ms).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const finishes = events.map((event) => event.metadata?.finished_at_ms).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const calls = toolCallsFromRuntimeEvents(events);
  return {
    ...(starts.length && finishes.length ? { durationMs: Math.max(0, Math.max(...finishes) - Math.min(...starts)) } : {}),
    toolCallCount: calls.length,
    failedToolCount: calls.filter((call) => call.status === 'error').length,
    ...(events.some((event) => event.metadata?.network_access === true) ? { networkAccess: true } : {}),
  };
}

function toolCallsFromRuntimeEvents(events: RuntimeEventEnvelope[]): KstarToolCall[] {
  const calls: KstarToolCall[] = [];
  for (const event of events) {
    const metadata = event.metadata ?? {};
    const kernelEvent = metadata.kernel_event;
    if (kernelEvent === 'tool_call') {
      const name = compactText(metadata.name, 120) || 'unknown_tool';
      const args = metadata.arguments;
      const argumentsSummary = args && typeof args === 'object' && !Array.isArray(args)
        ? Object.keys(args as Record<string, unknown>).sort().join(',')
        : undefined;
      calls.push({
        ...(typeof metadata.id === 'string' ? { id: metadata.id } : {}),
        sequence: calls.length,
        actor: 'runtime',
        name,
        ...(argumentsSummary ? { argumentsSummary } : {}),
        status: 'unknown',
      });
      continue;
    }
    if (kernelEvent !== 'tool_result') continue;
    const id = typeof metadata.id === 'string' ? metadata.id : undefined;
    const name = compactText(metadata.name, 120);
    const call = calls.find((candidate) => (id && candidate.id === id) || (!candidate.id && name === candidate.name));
    if (!call) continue;
    call.status = metadata.isError === true ? 'error' : 'ok';
  }
  return calls;
}

function runtimeEvidenceRefs(request: RuntimeRunRequest, runId: string): CognitionSourceRef[] {
  return normalizeCognitionSourceRefs([
    { kind: 'execution', id: runId, title: 'CogSeed Runtime run' },
    ...request.context.map((item, index) => item.type === 'text'
      ? { kind: 'context' as const, id: `context-${index}`, excerpt: item.content }
      : { kind: 'context' as const, id: `context-${index}`, title: item.label || path.basename(item.path) }),
  ]);
}

export function buildRuntimeKstarEpisode(input: RuntimeKstarEpisodeInput): KstarEpisodeRecord {
  const createdAt = input.createdAt || nowIso();
  const outcome = terminalRuntimeStatus(input.events);
  const toolCalls = toolCallsFromRuntimeEvents(input.events);
  const producedFiles = input.events.flatMap((event) => {
    const values = event.metadata?.produced_files;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
  });
  const uniqueProducedFiles = [...new Set(producedFiles.map((file) => path.basename(file)))];
  const contextSummary = input.request.context
    .map((item) => item.type === 'text' ? item.content : item.label || path.basename(item.path))
    .map((value) => compactText(value, 180))
    .filter((value): value is string => Boolean(value))
    .join(' | ');

  return {
    schemaVersion: 1,
    ownerId: input.userId,
    id: `kse-${input.runId}`,
    sessionId: input.request.runtime_session_id,
    sessionKind: 'cogseed_runtime',
    taskRunId: input.runId,
    requestId: input.request.request_id,
    runtimeSessionId: input.request.runtime_session_id,
    k: {
      memoryRefs: [],
      contextRefs: input.request.context.map((_item, index) => `context-${index}`),
      abilityAssetRefs: [],
      ...(contextSummary ? { promptContextSummary: compactText(contextSummary, MAX_SUMMARY) } : {}),
    },
    s: {
      ...(input.request.working_dir ? { workingDir: safePathSummary(input.request.working_dir) } : {}),
      ...(input.request.model_profile ? { modelProfile: input.request.model_profile } : {}),
    },
    t: {
      userGoal: compactText(input.request.task, MAX_TEXT) || 'Unspecified task',
      normalizedTask: compactText(input.request.task, MAX_SUMMARY),
      constraints: [],
    },
    a: {
      toolCalls,
      agentActions: toolCalls.map((call) => ({ actor: 'runtime', action: call.name })),
    },
    r: {
      status: outcome.status,
      ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
      producedFiles: uniqueProducedFiles,
      ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
      ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      ...runtimeMeasurements(input.events),
    },
    evidenceRefs: runtimeEvidenceRefs(input.request, input.runId),
    createdAt,
    updatedAt: createdAt,
  };
}

function processEvent(item: NonNullable<GroupKstarMessageInput['process']>[number]): { stream: string; data?: unknown } | undefined {
  return item.type === 'event' ? item.event : item.event;
}

function argumentKeySummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return keys.length ? keys.join(',').slice(0, MAX_SUMMARY) : undefined;
}

function toolCallsFromGroupMessages(messages: GroupKstarMessageInput[]): KstarToolCall[] {
  const calls: KstarToolCall[] = [];
  const byId = new Map<string, KstarToolCall>();
  for (const message of messages) {
    for (const item of message.process || []) {
      const event = processEvent(item);
      if (!event || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) continue;
      const data = event.data as Record<string, unknown>;
      let phase = '';
      let id: string | undefined;
      let name = '';
      let args: unknown;
      let isError = false;
      if (event.stream === 'tool') {
        phase = String(data.phase || '').toLowerCase();
        id = typeof data.id === 'string' ? data.id : undefined;
        name = compactText(data.name, 120) || '';
        args = data.arguments;
        isError = data.isError === true;
      } else if (event.stream === 'cli' && String(data.type || '').toLowerCase() === 'tool-event') {
        phase = String(data.phase || data.status || '').toLowerCase();
        id = typeof data.id === 'string' ? data.id : typeof data.call_id === 'string' ? data.call_id : undefined;
        name = compactText(data.tool, 120) || compactText(data.name, 120) || '';
        args = data.arguments || data.input;
        isError = data.isError === true || phase === 'error' || phase === 'failed';
      } else {
        continue;
      }
      if (!name) continue;
      if (phase === 'start' || phase === 'begin' || phase === 'running') {
        if (id && byId.has(id)) continue;
        const call: KstarToolCall = {
          ...(id ? { id } : {}),
          sequence: calls.length,
          actor: message.from,
          name,
          ...(argumentKeySummary(args) ? { argumentsSummary: argumentKeySummary(args) } : {}),
          status: 'unknown',
        };
        calls.push(call);
        if (id) byId.set(id, call);
        continue;
      }
      if (phase !== 'end' && phase !== 'complete' && phase !== 'completed' && phase !== 'error' && phase !== 'failed') continue;
      const call = (id ? byId.get(id) : undefined)
        || [...calls].reverse().find((candidate) => candidate.name === name && candidate.status === 'unknown');
      if (!call) continue;
      call.status = isError ? 'error' : 'ok';
    }
  }
  return calls;
}

function abilityAssetRefsFromCitations(input: GroupKstarEpisodeInput, messages: GroupKstarMessageInput[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const citation of message.recall_citations || []) {
      if (input.projectionId && citation.projection_id !== input.projectionId) continue;
      if (input.forecastId && citation.forecast_id !== input.forecastId) continue;
      if (!citation.asset_id || seen.has(citation.asset_id)) continue;
      seen.add(citation.asset_id);
      refs.push(citation.asset_id);
    }
  }
  return refs;
}

function messagesInRun(input: GroupKstarEpisodeInput): GroupKstarMessageInput[] {
  return input.messages.filter((message) => {
    const timestamp = Date.parse(message.ts);
    return Number.isFinite(timestamp) &&
      timestamp >= input.startedAtMs - MESSAGE_TIME_TOLERANCE_MS &&
      timestamp <= input.finishedAtMs + MESSAGE_TIME_TOLERANCE_MS;
  });
}

export function buildGroupKstarEpisode(input: GroupKstarEpisodeInput): KstarEpisodeRecord {
  const createdAt = input.createdAt || nowIso();
  const messages = messagesInRun(input);
  const userMessages = messages.filter((message) => message.from === 'user');
  const actionMessages = messages.filter((message) => message.from !== 'user' && !message.system_kind);
  const resultMessages = actionMessages.filter((message) => !message.dispatch && !message.plan_announcement && !message.kstar_dispatch_narration);
  const finalMessage = [...resultMessages].reverse().find((message) => compactText(message.text)) || [...actionMessages].reverse().find((message) => compactText(message.text));
  // Host control messages (kstar_review_request etc.) arrive as from=user
  // with EMPTY text and must never become the episode's user goal — that
  // fallback produced "Conversation <cid>" episodes during the closure
  // deadloop. Take the first user message with real text instead.
  const userGoal = compactText(
    userMessages.find((message) => compactText(message.text))?.text,
    MAX_TEXT,
  ) || `Conversation ${input.conversationId}`;
  const producedFiles = [...new Set(messages.flatMap((message) => message.produced || []).filter((value) => typeof value === 'string').map((file) => path.basename(file)))];
  // Five-source evidence context (PRD v2 taxonomy): the delta-r/delta-a
  // reasoning evolves FROM all five cognition sources, not just the
  // conversation transcript.
  const evidenceRefs = normalizeCognitionSourceRefs([
    // 1. conversation — the session + every message
    { kind: 'conversation', id: input.conversationId, title: 'Group chat conversation' },
    ...messages.slice(0, 100).map((message) => ({ kind: 'conversation' as const, id: message.id, excerpt: message.text })),
    // 2. artifact_file — produced files + attached artifacts (PRD v2 kind)
    ...producedFiles.slice(0, 50).map((file) => ({ kind: 'artifact_file' as const, id: `artifact-${file}`, title: path.basename(file) })),
    ...messages.flatMap((message) => (message.artifacts || []).slice(0, 10).map((artifact) => ({ kind: 'artifact_file' as const, id: artifact.id, title: artifact.title }))),
    // 3. execution_evaluation — the executed tool/intervention chain
    ...(input.executionEvaluationRefs || []),
    // 4. user_teaching_signal — active teaching signals bound to this run
    ...(input.userTeachingSignalRefs || []),
    // 5. authorized_external_system — connector/authorized data consulted
    ...(input.authorizedExternalSystemRefs || []),
  ]);
  const toolCalls = toolCallsFromGroupMessages(actionMessages);
  const abilityAssetRefs = abilityAssetRefsFromCitations(input, actionMessages);
  const summary = resultMessages
    .map((message) => `${message.from}: ${compactText(message.text, 180) || ''}`)
    .filter(Boolean)
    .slice(-5)
    .join(' | ');

  return {
    schemaVersion: 1,
    ownerId: input.userId,
    id: `kse-${input.runId}`,
    sessionId: `gconv-${input.conversationId}`,
    sessionKind: 'group_chat',
    taskRunId: input.runId,
    ...(input.logicalRunId ? { logicalRunId: input.logicalRunId } : {}),
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    ...(input.forecastId ? { forecastId: input.forecastId } : {}),
    ...(input.wakeRequestId ? { wakeRequestId: input.wakeRequestId } : {}),
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs },
    s: { conversationSummary: compactText(summary, MAX_SUMMARY) },
    t: { userGoal, normalizedTask: compactText(userGoal, MAX_SUMMARY), constraints: [] },
    a: {
      toolCalls,
      agentActions: resultMessages.slice(0, 100).flatMap((message, messageIndex) => {
        const actions: KstarAgentAction[] = [{
          sequence: messageIndex,
          actor: message.from,
          action: compactText(message.text, MAX_SUMMARY) || 'completed action',
          status: message.failure_code ? 'error' : 'ok',
          ...(message.failure_code ? { summary: message.failure_code } : {}),
        }];
        for (const agent of message.created_agents || []) actions.push({ actor: message.from, action: `created agent ${agent.name || agent.agent_id}` });
        for (const skill of message.created_skills || []) actions.push({ actor: message.from, action: `created skill ${skill.name || skill.skill_id}` });
        for (const artifact of message.artifacts || []) actions.push({ actor: message.from, action: `created artifact ${artifact.title || artifact.id}` });
        if (message.plan_announcement) actions.push({ actor: message.from, action: 'published plan' });
        return actions;
      }),
    },
    r: {
      status: input.status,
      ...(finalMessage && compactText(finalMessage.text) ? { finalText: compactText(finalMessage.text) } : {}),
      producedFiles,
      ...(finalMessage?.failure_kind ? { failureKind: finalMessage.failure_kind } : {}),
      ...(finalMessage?.failure_code ? { failureCode: finalMessage.failure_code } : {}),
      durationMs: Math.max(0, input.finishedAtMs - input.startedAtMs),
      toolCallCount: toolCalls.length,
      failedToolCount: toolCalls.filter((call) => call.status === 'error').length,
      ...(actionMessages.some((message) => message.process?.some((item) => {
        const event = processEvent(item);
        return Boolean(event?.data && typeof event.data === 'object' && !Array.isArray(event.data)
          && (event.data as Record<string, unknown>).network_access === true);
      })) ? { networkAccess: true } : {}),
    },
    evidenceRefs,
    createdAt,
    updatedAt: createdAt,
  };
}
