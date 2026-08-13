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
import { assertMateAgentId, assertMateConversationId, assertMateSessionId, assertMateTaskId, assertMateUserId, mateTaskProjectionFile } from './paths';
import { MATE_AGENT_BACKEND_SCHEMA_VERSION, type MateTaskEventType } from './types';
import { extractHandbackFromFinal } from '../group_chat/router';
import {
  COMMANDER_ID,
  readState as readGroupChatState,
  setActiveRecipient,
  takeOrchestrationLedgerForAgent,
} from '../group_chat/state';

const log = createLogger('mate-backend:group-chat-projection');

export interface MateProjectionEvent {
  eventId: string;
  type: MateTaskEventType;
  payload: Record<string, unknown>;
}

export interface MateGroupChatProjectionInput {
  userId: string;
  conversationId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
  event: MateProjectionEvent;
}

export interface MateGroupChatProjectionDeps {
  conversationExists(input: { userId: string; conversationId: string }): Promise<boolean>;
  appendProcessEvent(input: {
    userId: string;
    conversationId: string;
    agentId: string;
    turnId: string;
    kind: MateTaskEventType;
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
  }): Promise<void>;
}

type ProjectionProcessItem =
  | { type: 'progress'; text: string }
  | { type: 'event'; event: { stream: string; data?: unknown } };

interface ProjectionState {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
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
    schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
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
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION || row.ownerId !== userId || row.taskId !== taskId
    || !Array.isArray(row.processedEventIds) || !Array.isArray(row.process)
    || typeof row.terminalProjected !== 'boolean' || typeof row.stopped !== 'boolean'
    || typeof row.updatedAt !== 'string') {
    throw new Error('malformed CogSeed projection state');
  }
  return row as unknown as ProjectionState;
}

async function readState(userId: string, taskId: string): Promise<ProjectionState> {
  try {
    return validateState(userId, taskId, JSON.parse(await fs.readFile(mateTaskProjectionFile(userId, taskId), 'utf8')));
  } catch (error) {
    if (isEnoent(error)) return freshState(userId, taskId);
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed projection state');
    throw error;
  }
}

function processItem(event: MateProjectionEvent): ProjectionProcessItem | null {
  if (event.type === 'model.delta') {
    const text = typeof event.payload.text === 'string' ? event.payload.text : '';
    return text ? { type: 'progress', text } : null;
  }
  if (event.type === 'tool.started' || event.type === 'tool.finished'
    || event.type === 'task.started' || event.type === 'task.failed'
    || event.type === 'task.cancelled' || event.type === 'task.recoverable') {
    return { type: 'event', event: { stream: event.type, ...(Object.keys(event.payload).length ? { data: event.payload } : {}) } };
  }
  return null;
}

export function groupChatProcessDataForProjection(
  kind: MateTaskEventType,
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

function isTerminal(type: MateTaskEventType): boolean {
  return type === 'task.completed' || type === 'task.failed' || type === 'task.cancelled';
}

function terminalText(event: MateProjectionEvent): { text: string; failureKind?: 'runtime'; failureCode?: string } | null {
  if (event.type === 'task.completed') {
    const text = typeof event.payload.text === 'string' ? event.payload.text.trim() : '';
    return text ? { text } : null;
  }
  if (event.type === 'task.failed') {
    return { text: t('cogseed.runtime_failed'), failureKind: 'runtime', failureCode: 'runtime_failed' };
  }
  return null;
}

export async function applyMateProjectedHandback(
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

const defaultDeps: MateGroupChatProjectionDeps = {
  conversationExists: defaultConversationExists,
  async appendProcessEvent(input) {
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
    const handback = await applyMateProjectedHandback(
      input.userId,
      input.conversationId,
      input.agentId,
      input.text,
    );
    await appendProjectedAgentMessage({
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
  },
};

export function createMateGroupChatProjection(
  overrides: Partial<MateGroupChatProjectionDeps> = {},
): { project(input: MateGroupChatProjectionInput): Promise<'projected' | 'duplicate' | 'dropped'> } {
  const deps = { ...defaultDeps, ...overrides };
  return {
    async project(input) {
      assertMateUserId(input.userId);
      assertMateConversationId(input.conversationId);
      assertMateAgentId(input.agentId);
      assertMateTaskId(input.taskId);
      assertMateSessionId(input.sessionId);
      if (!safeId(input.event.eventId)) throw new Error('invalid CogSeed projection event id');
      if (!(await deps.conversationExists({ userId: input.userId, conversationId: input.conversationId }))) {
        return 'dropped';
      }
      const stateFile = mateTaskProjectionFile(input.userId, input.taskId);
      return fileEditLock(stateFile).runExclusive(async () => {
        const state = await readState(input.userId, input.taskId);
        if (state.processedEventIds.includes(input.event.eventId)) return 'duplicate';
        if ((state.terminalProjected || state.stopped) && input.event.type !== 'task.cancelled') return 'dropped';

        state.processedEventIds.push(input.event.eventId);
        state.updatedAt = nowIso();
        await writeJson(stateFile, state);
        try {
          const item = processItem(input.event);
          if (item) {
            await deps.appendProcessEvent({
              userId: input.userId,
              conversationId: input.conversationId,
              agentId: input.agentId,
              turnId: input.taskId,
              kind: input.event.type,
              data: input.event.payload,
            });
            state.process.push(item);
          }
          if (isTerminal(input.event.type)) {
            const terminal = terminalText(input.event);
            if (terminal || input.event.type === 'task.completed') {
              await deps.appendTerminalMessage({
                userId: input.userId,
                conversationId: input.conversationId,
                agentId: input.agentId,
                turnId: input.taskId,
                text: terminal?.text || '',
                process: state.process,
                ...(terminal?.failureKind ? { failureKind: terminal.failureKind } : {}),
                ...(terminal?.failureCode ? { failureCode: terminal.failureCode } : {}),
                terminalStatus: input.event.type === 'task.failed' ? 'failed' : 'completed',
              });
              state.terminalProjected = true;
            }
            if (input.event.type === 'task.failed' || input.event.type === 'task.cancelled') state.stopped = true;
          }
          state.updatedAt = nowIso();
          await writeJson(stateFile, state);
          return 'projected';
        } catch (error) {
          state.processedEventIds = state.processedEventIds.filter((eventId) => eventId !== input.event.eventId);
          state.updatedAt = nowIso();
          await writeJson(stateFile, state);
          log.warn('CogSeed Group Chat projection failed', { error: logErrorRef(error) });
          throw error;
        }
      });
    },
  };
}

export const mateGroupChatProjection = createMateGroupChatProjection();
