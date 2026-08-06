import * as path from 'node:path';

import { nowIso } from '../../storage';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../mate_agent_runtime/protocol';
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
}

export interface GroupKstarEpisodeInput {
  userId: string;
  runId: string;
  conversationId: string;
  status: KstarTaskStatus;
  startedAtMs: number;
  finishedAtMs: number;
  messages: GroupKstarMessageInput[];
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
  if (terminal.status === 'cancelled') {
    return { status: 'cancelled', failureKind: 'cancelled', ...(typeof metadata.code === 'string' ? { failureCode: metadata.code } : {}) };
  }
  return {
    status: 'failed',
    ...(typeof metadata.failure_kind === 'string' ? { failureKind: metadata.failure_kind } : { failureKind: 'runtime' }),
    ...(typeof metadata.code === 'string' ? { failureCode: metadata.code } : {}),
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
    { kind: 'execution', id: runId, title: 'Mate Agent Runtime run' },
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
    sessionKind: 'mate_agent_runtime',
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
    },
    evidenceRefs: runtimeEvidenceRefs(input.request, input.runId),
    createdAt,
    updatedAt: createdAt,
  };
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
  const finalMessage = [...actionMessages].reverse().find((message) => compactText(message.text));
  const userGoal = compactText(userMessages[0]?.text, MAX_TEXT) || `Conversation ${input.conversationId}`;
  const producedFiles = [...new Set(messages.flatMap((message) => message.produced || []).filter((value) => typeof value === 'string').map((file) => path.basename(file)))];
  const evidenceRefs = normalizeCognitionSourceRefs([
    { kind: 'conversation', id: input.conversationId, title: 'Group chat conversation' },
    ...messages.slice(0, 100).map((message) => ({ kind: 'conversation' as const, id: message.id, excerpt: message.text })),
    ...producedFiles.slice(0, 50).map((file, index) => ({ kind: 'artifact' as const, id: `artifact-${index}`, title: path.basename(file) })),
    ...messages.flatMap((message) => (message.artifacts || []).slice(0, 10).map((artifact) => ({ kind: 'artifact' as const, id: artifact.id, title: artifact.title }))),
  ]);
  const summary = actionMessages
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
    k: { memoryRefs: [], contextRefs: [], abilityAssetRefs: [] },
    s: { conversationSummary: compactText(summary, MAX_SUMMARY) },
    t: { userGoal, normalizedTask: compactText(userGoal, MAX_SUMMARY), constraints: [] },
    a: {
      toolCalls: [],
      agentActions: actionMessages.slice(0, 100).flatMap((message) => {
        const actions: KstarAgentAction[] = [{
          actor: message.from,
          action: compactText(message.text, MAX_SUMMARY) || 'completed action',
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
    },
    evidenceRefs,
    createdAt,
    updatedAt: createdAt,
  };
}
