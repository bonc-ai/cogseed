// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { maskId } from '../../util/log-redact';
import { appendCogSeedTaskEvent } from './event-store';
import { transitionCogSeedTask } from './lifecycle';
import {
  createCogSeedTask,
  readCogSeedTask,
  setCogSeedSessionDisplayName,
  updateCogSeedTask,
  type CreateCogSeedTaskInput,
} from './task-store';
import type { CogSeedTaskEventType, CogSeedTaskRecord, CogSeedTaskStatus } from './types';
import type { WorkflowRun } from '../collaboration_control/types';

const log = createLogger('cogseed-backend:group-chat-bridge');
const TERMINAL = new Set<CogSeedTaskStatus>(['completed', 'cancelled']);

export interface GroupChatRunStartInput {
  userId: string;
  conversationId: string;
  runId: string;
  sourceMessageId: string;
  /**
   * The failed task this run is a retry of, when the run was started by the
   * Run Center's retry action. Threaded through so the new parent task and the
   * old failed one are linked (RC-P1-09) — without it the attention column
   * shows two unrelated cards for what the user experienced as one job.
   */
  retryOfTaskId?: string;
  /** Legacy caller field. Deliberately ignored so conversation text is never
   * copied into the CogSeed task store. */
  displayTitle?: string;
}

export interface GroupChatTurnStartInput {
  userId: string;
  conversationId: string;
  runId: string;
  turnId: string;
  sourceMessageId: string;
  parentTaskId: string;
  actorId: string;
  actorName?: string;
  actorKind: 'commander' | 'agent' | 'worker';
  workflowStepId?: string;
}

export interface GroupChatTaskFinishInput {
  userId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'waiting_input';
  messageId?: string;
  errorCode?: string;
  process?: unknown;
}

export interface GroupChatTaskBridge {
  startRun(input: GroupChatRunStartInput): Promise<CogSeedTaskRecord | null>;
  startTurn(input: GroupChatTurnStartInput): Promise<CogSeedTaskRecord | null>;
  finishTask(input: GroupChatTaskFinishInput): Promise<CogSeedTaskRecord | null>;
}

export interface GroupChatTaskBridgeDeps {
  createTask?: typeof createCogSeedTask;
  readTask?: typeof readCogSeedTask;
  updateTask?: typeof updateCogSeedTask;
  transitionTask?: typeof transitionCogSeedTask;
  appendEvent?: typeof appendCogSeedTaskEvent;
  setSessionDisplayName?: typeof setCogSeedSessionDisplayName;
  readActiveGroupChatWorkflow?: (userId: string, conversationId: string) => Promise<WorkflowRun | null>;
}

function safeCorrelationId(value: unknown): string | undefined {
  const id = String(typeof value === 'string' ? value : '').trim();
  return id && safeId(id) ? id : undefined;
}

function safeToolName(value: unknown): string | undefined {
  const name = String(typeof value === 'string' ? value : '').trim().slice(0, 120);
  return name && /^[A-Za-z0-9_.:-]+$/.test(name) ? name : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  const code = String(typeof value === 'string' ? value : '').trim().slice(0, 120);
  return code && /^[A-Za-z0-9_.:-]+$/.test(code) ? code : undefined;
}

type SafeToolEvent = {
  type: Extract<CogSeedTaskEventType, 'tool.started' | 'tool.finished'>;
  payload: { toolName: string; isError?: boolean; errorCode?: string };
};

export function safeToolEventsFromGroupChatProcess(process: unknown): SafeToolEvent[] {
  if (!Array.isArray(process)) return [];
  const result: SafeToolEvent[] = [];
  const seen = new Set<string>();
  for (const raw of process.slice(0, 300)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const event = (raw as { event?: unknown }).event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const stream = String((event as { stream?: unknown }).stream || '');
    const dataValue = (event as { data?: unknown }).data;
    const data = dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue)
      ? dataValue as Record<string, unknown>
      : {};
    const isCliTool = stream === 'cli' && String(data.type || '').toLowerCase() === 'tool-event';
    if (stream !== 'tool' && !isCliTool) continue;
    const toolName = safeToolName(isCliTool ? data.tool : data.name || data.toolName);
    if (!toolName) continue;
    const phase = String(data.phase || data.status || '').toLowerCase();
    const isError = data.ok === false || data.isError === true || /(?:error|fail)/.test(phase);
    const isStart = /^(?:start|starting|running|request|call|begin|use)$/.test(phase);
    const isFinish = isError || /^(?:end|ended|result|finish|finished|complete|completed|success|done)$/.test(phase);
    if (!isStart && !isFinish) continue;
    const type: SafeToolEvent['type'] = isStart && !isFinish ? 'tool.started' : 'tool.finished';
    const errorCode = isError ? safeErrorCode(data.errorCode || data.error_code || data.code) : undefined;
    const key = `${type}\0${toolName}\0${isError ? '1' : '0'}\0${errorCode || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      type,
      payload: {
        toolName,
        ...(type === 'tool.finished' ? { isError } : {}),
        ...(errorCode ? { errorCode } : {}),
      },
    });
    if (result.length >= 100) break;
  }
  return result;
}

function targetStatus(status: GroupChatTaskFinishInput['status']): CogSeedTaskStatus {
  if (status === 'waiting_input') return 'waiting_user';
  return status;
}

export function createGroupChatTaskBridge(deps: GroupChatTaskBridgeDeps = {}): GroupChatTaskBridge {
  const createTask = deps.createTask ?? createCogSeedTask;
  const readTask = deps.readTask ?? readCogSeedTask;
  const updateTask = deps.updateTask ?? updateCogSeedTask;
  const transitionTask = deps.transitionTask ?? transitionCogSeedTask;
  const appendEvent = deps.appendEvent ?? appendCogSeedTaskEvent;
  const setSessionDisplayName = deps.setSessionDisplayName ?? setCogSeedSessionDisplayName;
  const readActiveGroupChatWorkflow = deps.readActiveGroupChatWorkflow
    ?? (async (userId, conversationId) => (await import('../group_chat/collaboration')).readActiveWorkflowRun(userId, conversationId));

  const advanceToRunning = async (userId: string, initial: CogSeedTaskRecord): Promise<CogSeedTaskRecord> => {
    let task = initial;
    if (task.status === 'created') task = await transitionTask(userId, task.taskId, 'queued', { source: 'group-chat' });
    if (task.status === 'queued') task = await transitionTask(userId, task.taskId, 'running', { source: 'group-chat' });
    return task;
  };

  const createObservedTask = async (
    userId: string,
    input: CreateCogSeedTaskInput,
    actorId?: string,
  ): Promise<CogSeedTaskRecord> => {
    const created = await createTask(userId, input);
    let task = created.task;
    if (actorId && task.agentId !== actorId) {
      task = await updateTask(userId, task.taskId, (current) => ({ ...current, agentId: actorId, updatedAt: nowIso() }));
    }
    return advanceToRunning(userId, task);
  };

  return {
    async startRun(input) {
      try {
        const runId = safeCorrelationId(input.runId);
        const sourceMessageId = safeCorrelationId(input.sourceMessageId);
        if (!runId || !sourceMessageId) return null;
        const title = 'Conversation task';
        const task = await createObservedTask(input.userId, {
          requestId: `req-groupchat-run-${runId}`,
          task: title,
          sessionId: `gconv-${input.conversationId}`,
          conversationId: input.conversationId,
          executionKind: 'group-chat',
          groupChatRunId: runId,
          groupChatSourceMessageId: sourceMessageId,
          ...(safeCorrelationId(input.retryOfTaskId) ? { retryOfTaskId: safeCorrelationId(input.retryOfTaskId) } : {}),
        });
        await setSessionDisplayName(input.userId, task.sessionId, title);
        return task;
      } catch {
        log.warn('Group Chat run projection failed', { run_id: maskId(input.runId) });
        return null;
      }
    },

    async startTurn(input) {
      try {
        const runId = safeCorrelationId(input.runId);
        const turnId = safeCorrelationId(input.turnId);
        const sourceMessageId = safeCorrelationId(input.sourceMessageId);
        const actorId = safeCorrelationId(input.actorId);
        if (!runId || !turnId || !sourceMessageId || !actorId) return null;
        const actorLabel = input.actorKind === 'commander'
          ? 'Commander'
          : input.actorKind === 'worker'
            ? 'Worker'
            : 'Agent';
        const workflowStepId = safeCorrelationId(input.workflowStepId);
        const workflowRun = workflowStepId
          ? await readActiveGroupChatWorkflow(input.userId, input.conversationId)
          : null;
        const linkedWorkflow = workflowRun?.steps.some((step) => step.id === workflowStepId)
          ? workflowRun
          : null;
        return createObservedTask(input.userId, {
          requestId: `req-groupchat-turn-${turnId}`,
          task: `${actorLabel} turn`,
          sessionId: `gconv-${input.conversationId}`,
          conversationId: input.conversationId,
          executionKind: 'group-chat',
          groupChatRunId: runId,
          groupChatTurnId: turnId,
          groupChatSourceMessageId: sourceMessageId,
          groupChatActorKind: input.actorKind,
          parentTaskId: input.parentTaskId,
          coordinationDepth: 1,
          ...(linkedWorkflow ? { groupChatWorkflowRunId: linkedWorkflow.id, groupChatWorkflowStepId: workflowStepId } : {}),
        }, input.actorKind === 'commander' ? undefined : actorId);
      } catch {
        log.warn('Group Chat turn projection failed', { turn_id: maskId(input.turnId) });
        return null;
      }
    },

    async finishTask(input) {
      try {
        let task = await readTask(input.userId, input.taskId);
        if (!task || TERMINAL.has(task.status)) return task;
        const messageId = safeCorrelationId(input.messageId);
        const errorCode = safeErrorCode(input.errorCode);
        if (messageId || errorCode) {
          task = await updateTask(input.userId, input.taskId, (current) => ({
            ...current,
            ...(messageId ? { groupChatMessageId: messageId } : {}),
            ...(errorCode ? { errorCode } : {}),
            updatedAt: nowIso(),
          }));
        }
        for (const event of safeToolEventsFromGroupChatProcess(input.process)) {
          await appendEvent(input.userId, task.taskId, task.sessionId, event.type, event.payload);
        }
        const nextStatus = targetStatus(input.status);
        if (task.status === nextStatus || TERMINAL.has(task.status)) return task;
        return transitionTask(input.userId, task.taskId, nextStatus, {
          source: 'group-chat',
          ...(errorCode ? { errorCode } : {}),
        });
      } catch {
        log.warn('Group Chat terminal projection failed', { task_id: maskId(input.taskId) });
        return null;
      }
    },
  };
}

export const groupChatTaskBridge = createGroupChatTaskBridge();
