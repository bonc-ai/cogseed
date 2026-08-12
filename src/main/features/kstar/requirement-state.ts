import { nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import {
  createInitialConversationTaskState,
  createKstarRequirementRecord,
  createKstarTaskRecord,
  readConversationTaskState,
  readKstarRequirement,
  readKstarTask,
  replaceConversationTaskState,
  replaceKstarRequirement,
  replaceKstarTask,
  writeConversationTaskState,
  bindKstarRequirementWakeRequestByProjection,
  listKstarRequirementsForTask,
} from './requirement-store';
import { previewContextProjection } from '../recall/context-projection';
import {
  routeRequirementIntent,
  type KstarRequirementRouterOptions,
  type KstarRequirementRouteResult,
} from './requirement-router';
import type {
  KstarConversationTaskStateRecord,
  KstarRequirementRecord,
  KstarTaskRecord,
} from './requirement-types';

const log = createLogger('kstar.requirement-state');

export interface KstarUserMessageContext {
  conversationId: string;
  messageId: string;
  text: string;
  workspaceId?: string;
}

export interface KstarRouteUserMessageResult {
  state: KstarConversationTaskStateRecord;
  task: KstarTaskRecord;
  currentRequirement: KstarRequirementRecord;
  route: KstarRequirementRouteResult;
  projectionPreviewCreated?: { projectionId: string };
}

export interface KstarRequirementStateOptions {
  routerOptions?: KstarRequirementRouterOptions;
}

export async function bindKstarRequirementWakeRequest(
  userId: string,
  input: { conversationId: string; projectionId: string; wakeRequestId: string },
): Promise<KstarRequirementRecord> {
  if (!safeId(userId) || !safeId(input.conversationId) || !safeId(input.projectionId) || !safeId(input.wakeRequestId)) {
    throw new Error('invalid kstar requirement wake binding reference');
  }
  return bindKstarRequirementWakeRequestByProjection(
    userId,
    input.conversationId,
    input.projectionId,
    input.wakeRequestId,
  );
}

function assertMessageContext(userId: string, input: KstarUserMessageContext): void {
  if (!safeId(userId) || !safeId(input.conversationId) || !safeId(input.messageId)) {
    throw new Error('invalid kstar user message reference');
  }
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('missing kstar user message text');
  if (input.workspaceId !== undefined && !safeId(input.workspaceId)) throw new Error('invalid kstar workspace id');
}

function uniqueIds(ids: string[], next: string): string[] {
  return ids.includes(next) ? ids : [...ids, next];
}

function boundedText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd();
}

function routeTitle(route: KstarRequirementRouteResult, fallback: string): string {
  return boundedText(route.requirementText?.trim() || fallback.trim(), 200);
}

function projectionPurpose(title: string): string {
  return boundedText(title, 120);
}

async function persistState(userId: string, state: KstarConversationTaskStateRecord): Promise<KstarConversationTaskStateRecord> {
  state.updatedAt = nowIso();
  const existing = await readConversationTaskState(userId, state.conversationId);
  return existing
    ? replaceConversationTaskState(userId, state)
    : writeConversationTaskState(userId, state);
}

async function createTaskWithRequirement(
  userId: string,
  input: KstarUserMessageContext,
  route: KstarRequirementRouteResult,
): Promise<{ task: KstarTaskRecord; requirement: KstarRequirementRecord; projectionPreviewCreated?: { projectionId: string } }> {
  const title = routeTitle(route, input.text);
  const task = createKstarTaskRecord(userId, {
    conversationId: input.conversationId,
    title,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  const requirement = createKstarRequirementRecord(userId, {
    taskId: task.id,
    conversationId: input.conversationId,
    userMessageIds: [input.messageId],
    title,
    goalText: title,
    ...(route.expectedResult ? { rHat: route.expectedResult } : {}),
  });
  task.requirementIds = [requirement.id];
  task.currentRequirementId = requirement.id;
  const projectionPreview = await previewTaskBoundary(userId, input, task.id, projectionPurpose(title), route.expectedResult);
  if (projectionPreview) requirement.projectionId = projectionPreview.projectionId;
  await replaceKstarRequirement(userId, requirement);
  await replaceKstarTask(userId, task);
  return {
    task,
    requirement,
    ...(projectionPreview?.shouldPostCard ? { projectionPreviewCreated: { projectionId: projectionPreview.projectionId } } : {}),
  };
}

async function previewTaskBoundary(
  userId: string,
  input: KstarUserMessageContext,
  taskRunId: string,
  purpose: string,
  expectedResult?: KstarRequirementRouteResult['expectedResult'],
): Promise<{ projectionId: string; shouldPostCard: boolean } | undefined> {
  try {
    const projection = await previewContextProjection(userId, {
      taskRunId,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      purpose,
      ...(input.text ? { taskText: input.text } : {}),
      ...(expectedResult ? { authorization: expectedResult.source === 'model' ? 'workspace_policy' : 'user_confirmed' } : {}),
    });
    return { projectionId: projection.id, shouldPostCard: true };
  } catch (error) {
    log.warn('kstar requirement preview failed', { conversationId: input.conversationId, taskRunId, error: (error as Error).message });
    return undefined;
  }
}

export async function routeKstarUserMessage(
  userId: string,
  input: KstarUserMessageContext,
  options: KstarRequirementStateOptions = {},
): Promise<KstarRouteUserMessageResult> {
  assertMessageContext(userId, input);
  let state = await readConversationTaskState(userId, input.conversationId);
  if (!state) state = createInitialConversationTaskState(userId, input.conversationId);

  let task = state.currentTaskId ? await readKstarTask(userId, state.currentTaskId) : null;
  let currentRequirement = state.currentRequirementId
    ? await readKstarRequirement(userId, state.currentRequirementId)
    : null;
  const hasOpenTask = Boolean(task && (task.status === 'open' || task.status === 'closing'));
  const hasOpenRequirement = Boolean(currentRequirement && currentRequirement.status === 'open');
  const route = await routeRequirementIntent(userId, {
    text: input.text,
    hasOpenTask,
    hasOpenRequirement,
  }, options.routerOptions);
  let projectionPreviewCreated: { projectionId: string } | undefined;

  if (!task || !currentRequirement || !hasOpenTask) {
    const created = await createTaskWithRequirement(userId, input, route);
    state.currentTaskId = created.task.id;
    state.currentRequirementId = created.requirement.id;
    state.requirementJustClosed = undefined;
    state.taskComplete = false;
    state.pendingTaskStart = undefined;
    state.lastRoutedUserMessageId = input.messageId;
    state = await persistState(userId, state);
    return { state, task: created.task, currentRequirement: created.requirement, route, ...(created.projectionPreviewCreated ? { projectionPreviewCreated: created.projectionPreviewCreated } : {}) };
  }

  if (route.intent === 'topic_switch') {
    currentRequirement.status = 'waiting_review';
    currentRequirement.updatedAt = nowIso();
    task.status = 'closing';
    task.closeReason = 'topic_switch';
    task.updatedAt = nowIso();
    state.requirementJustClosed = currentRequirement.id;
    state.taskComplete = true;
    state.pendingTaskStart = {
      userMessageId: input.messageId,
      text: input.text.replace(/\s+/g, ' ').trim().slice(0, 4_000),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      reason: 'topic_switch',
    };
  } else if (route.intent === 'complete') {
    currentRequirement.userMessageIds = uniqueIds(currentRequirement.userMessageIds, input.messageId);
    currentRequirement.status = 'waiting_review';
    currentRequirement.updatedAt = nowIso();
    task.status = 'closing';
    task.closeReason = 'user_complete';
    task.updatedAt = nowIso();
    state.requirementJustClosed = currentRequirement.id;
    state.taskComplete = true;
    state.pendingTaskStart = undefined;
  } else if (route.intent === 'new') {
    currentRequirement.status = 'waiting_review';
    currentRequirement.updatedAt = nowIso();
    await replaceKstarRequirement(userId, currentRequirement);
    const next = createKstarRequirementRecord(userId, {
      taskId: task.id,
      conversationId: input.conversationId,
      userMessageIds: [input.messageId],
      title: routeTitle(route, input.text),
      goalText: routeTitle(route, input.text),
      ...(route.expectedResult ? { rHat: route.expectedResult } : {}),
    });
    task.requirementIds = uniqueIds(task.requirementIds, next.id);
    task.currentRequirementId = next.id;
    task.status = 'open';
    task.closeReason = undefined;
    task.updatedAt = nowIso();
    state.currentRequirementId = next.id;
    state.requirementJustClosed = currentRequirement.id;
    state.taskComplete = false;
    state.pendingTaskStart = undefined;
    currentRequirement = next;
    const projectionPreview = await previewTaskBoundary(userId, input, task.id, projectionPurpose(next.title), route.expectedResult);
    if (projectionPreview) next.projectionId = projectionPreview.projectionId;
    await replaceKstarRequirement(userId, next);
    if (projectionPreview?.shouldPostCard) projectionPreviewCreated = { projectionId: projectionPreview.projectionId };
  } else {
    currentRequirement.userMessageIds = uniqueIds(currentRequirement.userMessageIds, input.messageId);
    currentRequirement.updatedAt = nowIso();
    if (route.expectedResult && !currentRequirement.rHat) currentRequirement.rHat = route.expectedResult;
    if (route.intent === 'continue') {
      const projectionPreview = await previewTaskBoundary(
        userId,
        input,
        task.id,
        projectionPurpose(routeTitle(route, input.text)),
        route.expectedResult,
      );
      if (projectionPreview) {
        currentRequirement.projectionId = projectionPreview.projectionId;
        if (projectionPreview.shouldPostCard) projectionPreviewCreated = { projectionId: projectionPreview.projectionId };
      }
    }
  }

  await replaceKstarRequirement(userId, route.intent === 'new'
    ? await readKstarRequirement(userId, currentRequirement.id).then((record) => record || currentRequirement)
    : currentRequirement);
  await replaceKstarTask(userId, task);
  state.lastRoutedUserMessageId = input.messageId;
  state = await persistState(userId, state);
  return { state, task, currentRequirement, route, ...(projectionPreviewCreated ? { projectionPreviewCreated } : {}) };
}

export async function attachKstarEpisodeToCurrentRequirement(
  userId: string,
  input: { conversationId: string; episodeId: string; projectionId?: string; wakeRequestId?: string },
): Promise<void> {
  if (!safeId(userId) || !safeId(input.conversationId) || !safeId(input.episodeId)) {
    throw new Error('invalid kstar episode attachment reference');
  }
  if (input.projectionId !== undefined && !safeId(input.projectionId)) throw new Error('invalid kstar episode projection reference');
  if (input.wakeRequestId !== undefined && !safeId(input.wakeRequestId)) throw new Error('invalid kstar episode wake reference');
  const state = await readConversationTaskState(userId, input.conversationId);
  if (!state?.currentTaskId) return;
  const task = await readKstarTask(userId, state.currentTaskId);
  if (!task) return;
  const requirements = await listKstarRequirementsForTask(userId, task.id);
  const provenanceMatches = requirements.filter((requirement) => {
    if (requirement.status === 'closed' || requirement.status === 'abandoned') return false;
    if (input.projectionId && requirement.projectionId === input.projectionId) return true;
    if (input.wakeRequestId && requirement.wakeRequestId === input.wakeRequestId) return true;
    return false;
  });
  let requirement: KstarRequirementRecord | null = null;
  if (provenanceMatches.length === 1) {
    requirement = provenanceMatches[0];
  } else if (provenanceMatches.length > 1) {
    throw new Error('multiple kstar requirements match episode provenance');
  } else if (state.currentRequirementId) {
    requirement = await readKstarRequirement(userId, state.currentRequirementId);
  }
  if (!requirement || requirement.status === 'closed' || requirement.status === 'abandoned') return;
  if ((input.projectionId || input.wakeRequestId) && provenanceMatches.length === 0) {
    const hasMatchingCurrentProvenance = Boolean(
      (input.projectionId && requirement.projectionId === input.projectionId) ||
      (input.wakeRequestId && requirement.wakeRequestId === input.wakeRequestId),
    );
    if (!hasMatchingCurrentProvenance) {
      throw new Error('no kstar requirement matches episode provenance');
    }
  }
  requirement.episodeIds = uniqueIds(requirement.episodeIds, input.episodeId);
  requirement.updatedAt = nowIso();
  await replaceKstarRequirement(userId, requirement);
}
