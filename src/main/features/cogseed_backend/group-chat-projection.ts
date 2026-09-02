import * as fs from 'node:fs/promises';

import { createLogger } from '../../logger';
import { nowIso, safeId, writeJson } from '../../storage';
import { t } from '../../i18n';
import { fileEditLock } from '../../util/locks';
import { logErrorRef } from '../../util/log-redact';
import {
  appendProjectedAgentMessage,
  appendProjectedProcessEvent,
} from '../group_chat/bus';
import { assertCogSeedAgentId, assertCogSeedConversationId, assertCogSeedSessionId, assertCogSeedTaskId, assertCogSeedUserId, cogseedTaskProjectionFile } from './paths';
import { COGSEED_AGENT_BACKEND_SCHEMA_VERSION, type CogSeedTaskEventType } from './types';
import {
  isCogSeedConversationUnavailableError,
  withCogSeedConversationProjectionEffect,
} from './conversation-operation-guard';
import { extractHandbackFromFinal } from '../group_chat/router';
import {
  COMMANDER_ID,
  readState as readGroupChatState,
  setActiveRecipient,
  takeOrchestrationLedgerForAgent,
} from '../group_chat/state';

const log = createLogger('cogseed-backend:group-chat-projection');

export interface CogSeedProjectionEvent {
  eventId: string;
  type: CogSeedTaskEventType;
  payload: Record<string, unknown>;
}

export interface CogSeedGroupChatProjectionInput {
  userId: string;
  conversationId: string;
  agentId: string;
  taskId: string;
  /** Stable per-attempt id used for idempotent conversation writeback. */
  executionId?: string;
  sessionId: string;
  event: CogSeedProjectionEvent;
}

export interface CogSeedGroupChatProjectionDeps {
  conversationExists(input: { userId: string; conversationId: string }): Promise<boolean>;
  appendProcessEvent(input: {
    userId: string;
    conversationId: string;
    agentId: string;
    turnId: string;
    kind: CogSeedTaskEventType;
    data: Record<string, unknown>;
  }): Promise<void>;
  appendTerminalMessage(input: {
    userId: string;
    conversationId: string;
    agentId: string;
    turnId: string;
    text: string;
    process: ProjectionProcessItem[];
    failureKind?: 'runtime';
    failureCode?: string;
    terminalStatus?: 'completed' | 'failed';
  }): Promise<void | boolean>;
}

type ProjectionProcessItem =
  | { type: 'progress'; text: string }
  | { type: 'event'; event: { stream: string; data?: unknown } };

interface ProjectionState {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
  ownerId: string;
  taskId: string;
  processedEventIds: string[];
  process: ProjectionProcessItem[];
  terminalProjected: boolean;
  stopped: boolean;
  updatedAt: string;
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function freshState(userId: string, taskId: string): ProjectionState {
  return {
    schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
    ownerId: userId,
    taskId,
    processedEventIds: [],
    process: [],
    terminalProjected: false,
    stopped: false,
    updatedAt: nowIso(),
  };
}

function validateState(userId: string, taskId: string, value: unknown): ProjectionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed projection state');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION || row.ownerId !== userId || row.taskId !== taskId
    || !Array.isArray(row.processedEventIds) || !Array.isArray(row.process)
    || typeof row.terminalProjected !== 'boolean' || typeof row.stopped !== 'boolean'
    || typeof row.updatedAt !== 'string') {
    throw new Error('malformed CogSeed projection state');
  }
  return row as unknown as ProjectionState;
}

async function readState(userId: string, taskId: string): Promise<ProjectionState> {
  try {
    return validateState(userId, taskId, JSON.parse(await fs.readFile(cogseedTaskProjectionFile(userId, taskId), 'utf8')));
  } catch (error) {
    if (isEnoent(error)) return freshState(userId, taskId);
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed projection state');
    throw error;
  }
}

function processItem(event: CogSeedProjectionEvent): ProjectionProcessItem | null {
  if (event.type === 'model.delta') {
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    return text ? { type: 'progress', text } : null;
  }
  if (event.type === 'tool.started' || event.type === 'tool.finished'
    || event.type === 'task.started' || event.type === 'task.failed'
    || event.type === 'task.cancelled' || event.type === 'task.recoverable'
    || event.type === 'artifact') {
    return { type: 'event', event: { stream: event.type, ...(Object.keys(event.payload).length ? { data: event.payload } : {}) } };
  }
  return null;
}

export function groupChatProcessDataForProjection(
  kind: CogSeedTaskEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'model.delta') {
    return { type: 'delta', text: typeof payload.text === 'string' ? payload.text : '' };
  }
  if (kind === 'tool.started' || kind === 'tool.finished') {
    return {
      type: 'event',
      event: {
        stream: 'tool',
        data: {
          phase: kind === 'tool.started' ? 'start' : 'result',
          ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
          ...(kind === 'tool.finished' && typeof payload.isError === 'boolean' ? { isError: payload.isError } : {}),
          ...(kind === 'tool.finished' && payload.isError === true && typeof payload.error === 'string' && payload.error ? { error: payload.error.slice(0, 500) } : {}),
        },
      },
    };
  }
  return {
    type: 'event',
    event: {
      stream: 'runtime',
      data: { ...payload, kind },
    },
  };
}

function isTerminal(type: CogSeedTaskEventType): boolean {
  return type === 'task.completed' || type === 'task.failed' || type === 'task.cancelled';
}

type ProjectionConversationEffect<T> =
  | { available: true; value: T }
  | { available: false };

/** Keep deletion mutually exclusive only with one bounded local projection
 * side effect. A timed-out/detached projection may wait elsewhere (for
 * example on its per-task state lock) without holding Conversation deletion;
 * every later write must reacquire this boundary and is rejected once the
 * deletion tombstone wins. */
async function withProjectionConversationEffect<T>(
  input: Pick<CogSeedGroupChatProjectionInput, 'userId' | 'conversationId'>,
  deps: Pick<CogSeedGroupChatProjectionDeps, 'conversationExists'>,
  effect: () => Promise<T>,
): Promise<ProjectionConversationEffect<T>> {
  // Existence reads may be slow or detached after the Runtime's projection
  // timeout. Keep them outside the write lease; deletion can finish while the
  // read is pending, and the synchronous lease admission below will then
  // reject the stale writer.
  if (!await deps.conversationExists({
    userId: input.userId,
    conversationId: input.conversationId,
  })) return { available: false };
  try {
    return await withCogSeedConversationProjectionEffect(
      input.userId,
      input.conversationId,
      async () => ({ available: true, value: await effect() } as const),
    );
  } catch (error) {
    if (isCogSeedConversationUnavailableError(error)) return { available: false };
    throw error;
  }
}

function terminalText(event: CogSeedProjectionEvent): { text: string; failureKind?: 'runtime'; failureCode?: string } | null {
  if (event.type === 'task.completed') {
    const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
    return text ? { text } : null;
  }
  if (event.type === 'task.failed') {
    // Append the executor's failure detail (when the adapter recorded one)
    // so the conversation bubble shows the actual cause instead of only the
    // generic retry notice.
    const detail = typeof event.payload.error === 'string' ? event.payload.error.trim().slice(0, 500) : '';
    return {
      text: detail ? `${t('cogseed.runtime_failed')}\n\n${detail}` : t('cogseed.runtime_failed'),
      failureKind: 'runtime',
      failureCode: 'runtime_failed',
    };
  }
  return null;
}

export async function applyCogSeedProjectedHandback(
  userId: string,
  conversationId: string,
  agentId: string,
  text: string,
): Promise<{ text: string; handedBack: boolean }> {
  const parsed = extractHandbackFromFinal(text);
  if (!parsed.handback) return { text, handedBack: false };
  const state = await readGroupChatState(userId, conversationId);
  if (state.active_recipient !== agentId) return { text: parsed.cleanText, handedBack: false };
  await setActiveRecipient(userId, conversationId, COMMANDER_ID);
  await takeOrchestrationLedgerForAgent(userId, conversationId, agentId);
  return { text: parsed.cleanText, handedBack: true };
}

async function defaultConversationExists(input: { userId: string; conversationId: string }): Promise<boolean> {
  const chats = await import('../chats');
  return Boolean(await chats.getConversation(input.userId, input.conversationId));
}

const defaultDeps: CogSeedGroupChatProjectionDeps = {
  conversationExists: defaultConversationExists,
  async appendProcessEvent(input) {
    // Archiving is dashboard-only metadata and must not become a Group Chat
    // process event or alter the already-terminal conversation turn.
    if (input.kind === 'task.archived') return;
    await appendProjectedProcessEvent({
      uid: input.userId,
      cid: input.conversationId,
      agentId: input.agentId,
      turnId: input.turnId,
      kind: input.kind,
      data: groupChatProcessDataForProjection(input.kind, input.data),
    });
  },
  async appendTerminalMessage(input) {
    const handback = await applyCogSeedProjectedHandback(
      input.userId,
      input.conversationId,
      input.agentId,
      input.text,
    );
    const appended = await appendProjectedAgentMessage({
      uid: input.userId,
      cid: input.conversationId,
      agentId: input.agentId,
      turnId: input.turnId,
      text: handback.text,
      process: input.process,
      ...(input.failureKind ? { failureKind: input.failureKind } : {}),
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(input.terminalStatus ? { terminalStatus: input.terminalStatus } : {}),
    });
    if (!appended && input.text.trim()) return false;
    return true;
  },
};

export function createCogSeedGroupChatProjection(
  overrides: Partial<CogSeedGroupChatProjectionDeps> = {},
): { project(input: CogSeedGroupChatProjectionInput): Promise<'projected' | 'duplicate' | 'dropped'> } {
  const deps = { ...defaultDeps, ...overrides };
  return {
    async project(input) {
      assertCogSeedUserId(input.userId);
      assertCogSeedConversationId(input.conversationId);
      assertCogSeedAgentId(input.agentId);
      assertCogSeedTaskId(input.taskId);
      if (input.executionId !== undefined && (!safeId(input.executionId) || !input.executionId.startsWith('cogseed-exec-'))) {
        throw new Error('invalid CogSeed execution id');
      }
      assertCogSeedSessionId(input.sessionId);
      if (!safeId(input.event.eventId)) throw new Error('invalid CogSeed projection event id');
      const admitted = await withProjectionConversationEffect(input, deps, async () => undefined);
      if (!admitted.available) {
        return 'dropped';
      }
      const stateFile = cogseedTaskProjectionFile(input.userId, input.taskId);
      return fileEditLock(stateFile).runExclusive(async () => {
        const state = await readState(input.userId, input.taskId);
        if (state.processedEventIds.includes(input.event.eventId)) return 'duplicate';
        if ((state.terminalProjected || state.stopped) && input.event.type !== 'task.cancelled') return 'dropped';

        const nextState: ProjectionState = {
          ...state,
          processedEventIds: [...state.processedEventIds],
          process: [...state.process],
        };
        try {
          const item = processItem(input.event);
          if (item) {
            const processProjection = await withProjectionConversationEffect(
              input,
              deps,
              async () => deps.appendProcessEvent({
                userId: input.userId,
                conversationId: input.conversationId,
                agentId: input.agentId,
                turnId: input.executionId || input.taskId,
                kind: input.event.type,
                data: input.event.payload,
              }),
            );
            if (!processProjection.available) return 'dropped';
            nextState.process.push(item);
          }
          if (isTerminal(input.event.type)) {
            const terminal = terminalText(input.event);
            if (terminal || input.event.type === 'task.completed') {
              const terminalProjection = await withProjectionConversationEffect(
                input,
                deps,
                async () => deps.appendTerminalMessage({
                  userId: input.userId,
                  conversationId: input.conversationId,
                  agentId: input.agentId,
                  turnId: input.executionId || input.taskId,
                  text: terminal?.text || '',
                  process: nextState.process,
                  ...(terminal?.failureKind ? { failureKind: terminal.failureKind } : {}),
                  ...(terminal?.failureCode ? { failureCode: terminal.failureCode } : {}),
                  terminalStatus: input.event.type === 'task.failed' ? 'failed' : 'completed',
                }),
              );
              if (!terminalProjection.available) return 'dropped';
              if (terminalProjection.value === false) throw new Error('CogSeed projection destination disappeared');
              nextState.terminalProjected = true;
            }
            if (input.event.type === 'task.failed' || input.event.type === 'task.cancelled') nextState.stopped = true;
          }
          // Side effects are keyed by the stable turn id and can be retried.
          // Commit the event marker only after every side effect succeeds.
          nextState.processedEventIds.push(input.event.eventId);
          nextState.updatedAt = nowIso();
          const stateProjection = await withProjectionConversationEffect(
            input,
            deps,
            async () => writeJson(stateFile, nextState),
          );
          if (!stateProjection.available) return 'dropped';
          return 'projected';
        } catch (error) {
          log.warn('CogSeed Group Chat projection failed', { error: logErrorRef(error) });
          throw error;
        }
      });
    },
  };
}

export const cogseedGroupChatProjection = createCogSeedGroupChatProjection();
