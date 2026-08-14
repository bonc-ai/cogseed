import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { maskId } from '../../util/log-redact';
import { previewContextProjection } from '../recall/context-projection';
import { commitCommanderForecast } from './forecast-commit';
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
} from './requirement-store';
import type {
  KstarConversationTaskStateRecord,
  KstarExpectedResult,
  KstarRequirementRecord,
  KstarTaskRecord,
} from './requirement-types';
import type {
  KstarControlErrorCode,
  KstarControlHostContext,
  KstarControlInput,
  KstarControlOperation,
  KstarControlReceipt,
  KstarControlResult,
  KstarForecastProposal,
  KstarProjectionProposal,
  KstarRequirementMutation,
  KstarResultProposal,
  KstarTaskMutation,
} from './control-types';

const log = createLogger('kstar.control');
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,160}$/;
const OPERATIONS = new Set<KstarControlOperation>([
  'upsert_state',
  'request_projection',
  'commit_forecast',
  'finish',
  'abandon',
]);
const MAX_RECEIPTS = 100;


class ControlInputError extends Error {}

function invalid(message: string): Extract<KstarControlResult, { ok: false }> {
  return { ok: false, code: 'kstar_control_invalid_input', message };
}

function publicError(code: KstarControlErrorCode, message: string): Extract<KstarControlResult, { ok: false }> {
  return { ok: false, code, message };
}

function plain(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined) {
    if (required) throw new ControlInputError(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ControlInputError(`${field} must be a string`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (required && !normalized) throw new ControlInputError(`${field} is required`);
  if (normalized.length > max) throw new ControlInputError(`${field} is too long`);
  return normalized || undefined;
}

function id(value: unknown, field: string, required = false): string | undefined {
  const normalized = text(value, field, 160, required);
  if (normalized !== undefined && !safeId(normalized)) throw new ControlInputError(`${field} is invalid`);
  return normalized;
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new ControlInputError(`${field} is invalid`);
  return value.map((item) => {
    const normalized = text(item, field, maxLength, true);
    if (!normalized) throw new ControlInputError(`${field} is invalid`);
    return normalized;
  });
}

function expectedResult(value: unknown): KstarExpectedResult | undefined {
  if (value === undefined) return undefined;
  if (!plain(value)) throw new ControlInputError('expectedResult is invalid');
  const summary = text(value.summary, 'expectedResult.summary', 4_000, true)!;
  const acceptanceSignals = stringList(
    value.acceptanceSignals,
    'expectedResult.acceptanceSignals',
    24,
    1_000,
  );
  if (!acceptanceSignals) throw new ControlInputError('expectedResult.acceptanceSignals is required');
  const source = value.source;
  if (!['user_message', 'router', 'model', 'unknown'].includes(String(source))) {
    throw new ControlInputError('expectedResult.source is invalid');
  }
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ControlInputError('expectedResult.confidence is invalid');
  }
  return {
    summary,
    acceptanceSignals,
    source: source as KstarExpectedResult['source'],
    confidence,
  };
}

function taskMutation(value: unknown): KstarTaskMutation {
  if (!plain(value)) throw new ControlInputError('task mutation is required');
  const operation = value.operation;
  if (!['keep', 'create', 'update', 'close'].includes(String(operation))) {
    throw new ControlInputError('task operation is invalid');
  }
  return {
    operation: operation as KstarTaskMutation['operation'],
    ...(id(value.taskId, 'task.taskId') ? { taskId: id(value.taskId, 'task.taskId') } : {}),
    ...(text(value.title, 'task.title', 200) ? { title: text(value.title, 'task.title', 200) } : {}),
    ...(text(value.closeReason, 'task.closeReason', 1_000) ? { closeReason: text(value.closeReason, 'task.closeReason', 1_000) } : {}),
  };
}

function requirementMutation(value: unknown): KstarRequirementMutation {
  if (!plain(value)) throw new ControlInputError('requirement mutation is required');
  const operation = value.operation;
  if (!['keep', 'create', 'update', 'close'].includes(String(operation))) {
    throw new ControlInputError('requirement operation is invalid');
  }
  const normalizedExpectedResult = expectedResult(value.expectedResult);
  return {
    operation: operation as KstarRequirementMutation['operation'],
    ...(id(value.requirementId, 'requirement.requirementId')
      ? { requirementId: id(value.requirementId, 'requirement.requirementId') }
      : {}),
    ...(text(value.goalText, 'requirement.goalText', 4_000)
      ? { goalText: text(value.goalText, 'requirement.goalText', 4_000) }
      : {}),
    ...(normalizedExpectedResult ? { expectedResult: normalizedExpectedResult } : {}),
  };
}

function projectionProposal(value: unknown): KstarProjectionProposal {
  if (!plain(value)) throw new ControlInputError('projection proposal is required');
  return {
    requirementId: id(value.requirementId, 'projection.requirementId', true)!,
    purpose: text(value.purpose, 'projection.purpose', 120, true)!,
    ...(text(value.taskText, 'projection.taskText', 4_000)
      ? { taskText: text(value.taskText, 'projection.taskText', 4_000) }
      : {}),
  };
}

function forecastProposal(value: unknown): KstarForecastProposal {
  if (!plain(value)) throw new ControlInputError('forecast proposal is required');
  if (!Array.isArray(value.candidates)) throw new ControlInputError('forecast.candidates is invalid');
  return {
    taskRunId: id(value.taskRunId, 'forecast.taskRunId', true)!,
    requirementId: id(value.requirementId, 'forecast.requirementId', true)!,
    projectionId: id(value.projectionId, 'forecast.projectionId', true)!,
    candidates: value.candidates,
    ...(stringList(value.constraints, 'forecast.constraints', 20, 1_000)
      ? { constraints: stringList(value.constraints, 'forecast.constraints', 20, 1_000) }
      : {}),
    ...(stringList(value.acceptanceCriteria, 'forecast.acceptanceCriteria', 20, 1_000)
      ? { acceptanceCriteria: stringList(value.acceptanceCriteria, 'forecast.acceptanceCriteria', 20, 1_000) }
      : {}),
  };
}

function resultProposal(value: unknown): KstarResultProposal | undefined {
  if (value === undefined) return undefined;
  if (!plain(value)) throw new ControlInputError('result proposal is invalid');
  const finalStatus = value.finalStatus;
  if (finalStatus !== undefined && !['completed', 'failed', 'cancelled'].includes(String(finalStatus))) {
    throw new ControlInputError('result.finalStatus is invalid');
  }
  return {
    ...(finalStatus ? { finalStatus: finalStatus as KstarResultProposal['finalStatus'] } : {}),
    ...(text(value.finalText, 'result.finalText', 4_000) ? { finalText: text(value.finalText, 'result.finalText', 4_000) } : {}),
    ...(stringList(value.producedFiles, 'result.producedFiles', 50, 1_000)
      ? { producedFiles: stringList(value.producedFiles, 'result.producedFiles', 50, 1_000) }
      : {}),
    ...(stringList(value.acceptanceEvidence, 'result.acceptanceEvidence', 24, 1_000)
      ? { acceptanceEvidence: stringList(value.acceptanceEvidence, 'result.acceptanceEvidence', 24, 1_000) }
      : {}),
    ...(text(value.closeReason, 'result.closeReason', 1_000) ? { closeReason: text(value.closeReason, 'result.closeReason', 1_000) } : {}),
  };
}

function normalizeInput(value: unknown): KstarControlInput {
  if (!plain(value)) throw new ControlInputError('control input must be an object');
  if (!OPERATIONS.has(value.operation as KstarControlOperation)) {
    throw new ControlInputError('control operation is invalid');
  }
  const idempotencyKey = text(value.idempotencyKey, 'idempotencyKey', 160, true)!;
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new ControlInputError('idempotencyKey is invalid');
  const operation = value.operation as KstarControlOperation;
  if (operation === 'upsert_state') {
    return {
      operation,
      idempotencyKey,
      task: taskMutation(value.task),
      requirement: requirementMutation(value.requirement),
    };
  }
  if (operation === 'request_projection') {
    return { operation, idempotencyKey, projection: projectionProposal(value.projection) };
  }
  if (operation === 'commit_forecast') {
    return { operation, idempotencyKey, forecast: forecastProposal(value.forecast) };
  }
  return {
    operation,
    idempotencyKey,
    ...(resultProposal(value.result) ? { result: resultProposal(value.result) } : {}),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function inputHash(input: KstarControlInput): string {
  return createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

function assertContext(context: KstarControlHostContext): void {
  if (
    !safeId(context.userId)
    || !safeId(context.conversationId)
    || (context.sourceMessageId !== undefined && !safeId(context.sourceMessageId))
    || (context.workspaceId !== undefined && !safeId(context.workspaceId))
    || !context.allowedToolNames
    || typeof context.allowedToolNames[Symbol.iterator] !== 'function'
  ) throw new ControlInputError('host control context is invalid');
}

async function currentRecords(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
): Promise<{ task: KstarTaskRecord | null; requirement: KstarRequirementRecord | null }> {
  const task = state.currentTaskId ? await readKstarTask(context.userId, state.currentTaskId) : null;
  const requirement = state.currentRequirementId
    ? await readKstarRequirement(context.userId, state.currentRequirementId)
    : null;
  if ((state.currentTaskId && !task) || (state.currentRequirementId && !requirement)) {
    throw new ControlInputError('current KStar state is incomplete');
  }
  if (task && task.conversationId !== context.conversationId) throw new ControlInputError('current Task conversation mismatch');
  if (requirement && requirement.conversationId !== context.conversationId) {
    throw new ControlInputError('current Requirement conversation mismatch');
  }
  return { task, requirement };
}

function assertOwnedId(submitted: string | undefined, current: string, field: string): void {
  if (submitted !== undefined && submitted !== current) throw new ControlInputError(`${field} does not match current state`);
}

function unique(values: string[], next?: string): string[] {
  if (!next || values.includes(next)) return values;
  return [...values, next];
}

async function upsertState(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
  input: KstarControlInput & { task: KstarTaskMutation; requirement: KstarRequirementMutation },
): Promise<{ result: KstarControlResult; state: KstarConversationTaskStateRecord }> {
  let { task, requirement } = await currentRecords(context, state);
  const taskMutation = input.task;
  const requirementMutation = input.requirement;
  const now = nowIso();

  if (!task) {
    if (taskMutation.operation !== 'create' || requirementMutation.operation !== 'create') {
      throw new ControlInputError('creating KStar state requires create Task and Requirement operations');
    }
    const title = taskMutation.title || requirementMutation.goalText;
    const goalText = requirementMutation.goalText || taskMutation.title;
    if (!title || !goalText) throw new ControlInputError('Task title and Requirement goal are required');
    task = createKstarTaskRecord(context.userId, {
      conversationId: context.conversationId,
      title,
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    });
    requirement = createKstarRequirementRecord(context.userId, {
      taskId: task.id,
      conversationId: context.conversationId,
      userMessageIds: context.sourceMessageId ? [context.sourceMessageId] : [],
      title: goalText.slice(0, 200),
      goalText,
      ...(requirementMutation.expectedResult ? { rHat: requirementMutation.expectedResult } : {}),
    });
    task.requirementIds = [requirement.id];
    task.currentRequirementId = requirement.id;
    await replaceKstarRequirement(context.userId, requirement);
    await replaceKstarTask(context.userId, task);
    state = {
      ...state,
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
      requirementJustClosed: undefined,
      taskComplete: false,
      pendingTaskStart: undefined,
      updatedAt: now,
    };
    await replaceConversationTaskState(context.userId, state);
    return {
      result: { ok: true, status: 'state_committed', taskId: task.id, requirementId: requirement.id },
      state,
    };
  }

  if (taskMutation.operation === 'create') throw new ControlInputError('an open KStar Task already exists');
  assertOwnedId(taskMutation.taskId, task.id, 'task.taskId');
  if (!requirement) {
    if (requirementMutation.operation !== 'create') throw new ControlInputError('current Requirement is missing');
    const goalText = requirementMutation.goalText;
    if (!goalText) throw new ControlInputError('Requirement goal is required');
    requirement = createKstarRequirementRecord(context.userId, {
      taskId: task.id,
      conversationId: context.conversationId,
      userMessageIds: context.sourceMessageId ? [context.sourceMessageId] : [],
      title: goalText.slice(0, 200),
      goalText,
      ...(requirementMutation.expectedResult ? { rHat: requirementMutation.expectedResult } : {}),
    });
    task = {
      ...task,
      status: 'open',
      closeReason: undefined,
      requirementIds: unique(task.requirementIds, requirement.id),
      currentRequirementId: requirement.id,
      updatedAt: now,
    };
  } else {
    if (requirementMutation.operation === 'create') throw new ControlInputError('an open KStar Requirement already exists');
    assertOwnedId(requirementMutation.requirementId, requirement.id, 'requirement.requirementId');
    requirement = {
      ...requirement,
      userMessageIds: unique(requirement.userMessageIds, context.sourceMessageId),
      ...(requirementMutation.operation === 'update' && requirementMutation.goalText
        ? { goalText: requirementMutation.goalText, title: requirementMutation.goalText.slice(0, 200) }
        : {}),
      ...(requirementMutation.expectedResult ? { rHat: requirementMutation.expectedResult } : {}),
      updatedAt: now,
    };
  }

  if (taskMutation.operation === 'update' && taskMutation.title) {
    task = { ...task, title: taskMutation.title, updatedAt: now };
  }
  const closing = taskMutation.operation === 'close' || requirementMutation.operation === 'close';
  if (closing) {
    task = { ...task, status: 'closing', closeReason: 'user_complete', updatedAt: now };
    requirement = { ...requirement, status: 'waiting_review', updatedAt: now };
    state = {
      ...state,
      requirementJustClosed: requirement.id,
      taskComplete: true,
      updatedAt: now,
    };
  } else {
    state = {
      ...state,
      currentTaskId: task.id,
      currentRequirementId: requirement.id,
      taskComplete: false,
      updatedAt: now,
    };
  }
  await replaceKstarRequirement(context.userId, requirement);
  await replaceKstarTask(context.userId, task);
  await replaceConversationTaskState(context.userId, state);
  return {
    result: { ok: true, status: 'state_committed', taskId: task.id, requirementId: requirement.id },
    state,
  };
}

async function requestProjection(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
  proposal: KstarProjectionProposal,
): Promise<{ result: KstarControlResult; state: KstarConversationTaskStateRecord }> {
  const { task, requirement } = await currentRecords(context, state);
  if (!task || !requirement || task.status !== 'open' || requirement.status !== 'open') {
    throw new ControlInputError('an open Task and Requirement are required');
  }
  assertOwnedId(proposal.requirementId, requirement.id, 'projection.requirementId');
  const projection = await previewContextProjection(context.userId, {
    taskRunId: task.id,
    ...(context.workspaceId || task.workspaceId
      ? { workspaceId: context.workspaceId || task.workspaceId }
      : {}),
    purpose: proposal.purpose,
    taskText: proposal.taskText || requirement.goalText,
    authorization: 'user_confirmed',
  });
  await replaceKstarRequirement(context.userId, {
    ...requirement,
    projectionId: projection.id,
    projectionIds: unique(requirement.projectionIds, projection.id),
    updatedAt: nowIso(),
  });
  await context.postProjectionCard?.(projection.id);
  return {
    result: {
      ok: true,
      status: 'confirmation_required',
      taskId: task.id,
      requirementId: requirement.id,
      projectionId: projection.id,
    },
    state,
  };
}

async function commitForecast(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
  proposal: KstarForecastProposal,
): Promise<{ result: KstarControlResult; state: KstarConversationTaskStateRecord }> {
  const { task, requirement } = await currentRecords(context, state);
  if (!task || !requirement) throw new ControlInputError('an active Task and Requirement are required');
  assertOwnedId(proposal.taskRunId, task.id, 'forecast.taskRunId');
  assertOwnedId(proposal.requirementId, requirement.id, 'forecast.requirementId');
  if (requirement.projectionId !== proposal.projectionId) {
    throw new ControlInputError('forecast.projectionId does not match current state');
  }
  const record = await commitCommanderForecast(context.userId, {
    taskRunId: task.id,
    requirementId: requirement.id,
    projectionId: proposal.projectionId,
    candidates: proposal.candidates,
    allowedToolNames: context.allowedToolNames,
    ...(context.workspaceId || task.workspaceId
      ? { workspaceId: context.workspaceId || task.workspaceId }
      : {}),
    taskText: requirement.goalText,
    constraints: proposal.constraints,
    acceptanceCriteria: proposal.acceptanceCriteria || requirement.rHat?.acceptanceSignals || [],
  });
  const selectedCandidateId = record.forecast.selectedCandidateId;
  if (!selectedCandidateId) throw new ControlInputError('Forecast selected candidate is missing');
  return {
    result: {
      ok: true,
      status: 'forecast_committed',
      taskId: task.id,
      requirementId: requirement.id,
      projectionId: proposal.projectionId,
      forecastId: record.id,
      selectedCandidateId,
    },
    state,
  };
}

async function finish(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
): Promise<{ result: KstarControlResult; state: KstarConversationTaskStateRecord }> {
  const { task, requirement } = await currentRecords(context, state);
  if (!task || !requirement) throw new ControlInputError('an active Task and Requirement are required');
  const now = nowIso();
  await replaceKstarRequirement(context.userId, { ...requirement, status: 'waiting_review', updatedAt: now });
  await replaceKstarTask(context.userId, {
    ...task,
    status: 'closing',
    closeReason: 'user_complete',
    updatedAt: now,
  });
  state = {
    ...state,
    requirementJustClosed: requirement.id,
    taskComplete: true,
    updatedAt: now,
  };
  await replaceConversationTaskState(context.userId, state);
  return {
    result: { ok: true, status: 'finished', taskId: task.id, requirementId: requirement.id },
    state,
  };
}

async function abandon(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
): Promise<{ result: KstarControlResult; state: KstarConversationTaskStateRecord }> {
  const { task, requirement } = await currentRecords(context, state);
  if (!task) throw new ControlInputError('an active Task is required');
  const now = nowIso();
  if (requirement) {
    await replaceKstarRequirement(context.userId, { ...requirement, status: 'abandoned', updatedAt: now });
  }
  await replaceKstarTask(context.userId, {
    ...task,
    status: 'abandoned',
    closeReason: 'aborted',
    currentRequirementId: undefined,
    updatedAt: now,
  });
  state = {
    ...state,
    currentTaskId: undefined,
    currentRequirementId: undefined,
    requirementJustClosed: undefined,
    taskComplete: false,
    pendingTaskStart: undefined,
    updatedAt: now,
  };
  await replaceConversationTaskState(context.userId, state);
  return {
    result: {
      ok: true,
      status: 'abandoned',
      taskId: task.id,
      ...(requirement ? { requirementId: requirement.id } : {}),
    },
    state,
  };
}

async function persistReceipt(
  context: KstarControlHostContext,
  state: KstarConversationTaskStateRecord,
  input: KstarControlInput,
  hash: string,
  result: Exclude<KstarControlResult, { ok: false }>,
): Promise<void> {
  const latest = await readConversationTaskState(context.userId, context.conversationId) || state;
  const receipt: KstarControlReceipt = {
    idempotencyKey: input.idempotencyKey,
    inputHash: hash,
    operation: input.operation,
    actor: 'commander',
    conversationId: context.conversationId,
    ...(result.taskId ? { taskId: result.taskId } : {}),
    ...(result.requirementId ? { requirementId: result.requirementId } : {}),
    ...('projectionId' in result && result.projectionId ? { projectionId: result.projectionId } : {}),
    ...('forecastId' in result && result.forecastId ? { forecastId: result.forecastId } : {}),
    status: 'ok',
    result,
    createdAt: nowIso(),
  };
  await replaceConversationTaskState(context.userId, {
    ...latest,
    controlReceipts: [...(latest.controlReceipts || []), receipt].slice(-MAX_RECEIPTS),
    updatedAt: nowIso(),
  });
}

function replayResult(receipt: KstarControlReceipt, hash: string): KstarControlResult {
  if (receipt.inputHash !== hash) return invalid('idempotencyKey was already used for different input');
  if (!receipt.result.ok) return receipt.result;
  return { ...receipt.result, replayed: true };
}

function mapError(error: unknown): Extract<KstarControlResult, { ok: false }> {
  if (error instanceof ControlInputError) return invalid(error.message);
  const code = (error as { code?: unknown })?.code;
  if (
    code === 'kstar_projection_not_confirmed'
    || code === 'kstar_invalid_candidate'
    || code === 'kstar_unavailable_tool'
    || code === 'kstar_invalid_rule_ref'
    || code === 'kstar_persistence_failed'
  ) {
    return publicError(code, (error as Error)?.message || code);
  }
  return publicError('kstar_persistence_failed', 'KStar control persistence failed');
}

export async function executeKstarControl(
  context: KstarControlHostContext,
  rawInput: unknown,
): Promise<KstarControlResult> {
  let operation: KstarControlOperation | 'invalid' = 'invalid';
  try {
    assertContext(context);
    const input = normalizeInput(rawInput);
    operation = input.operation;
    const hash = inputHash(input);
    let state = await readConversationTaskState(context.userId, context.conversationId);
    if (!state) state = createInitialConversationTaskState(context.userId, context.conversationId);
    const existing = state.controlReceipts?.find((receipt) => receipt.idempotencyKey === input.idempotencyKey);
    if (existing) {
      const replayed = replayResult(existing, hash);
      log.info('kstar.control', {
        operation,
        result: replayed.ok ? 'ok' : 'rejected',
        cid: maskId(context.conversationId),
        task: maskId(existing.taskId),
      });
      return replayed;
    }

    let committed: { result: KstarControlResult; state: KstarConversationTaskStateRecord };
    if (input.operation === 'upsert_state') {
      committed = await upsertState(
        context,
        state,
        input as KstarControlInput & { task: KstarTaskMutation; requirement: KstarRequirementMutation },
      );
    } else if (input.operation === 'request_projection') {
      committed = await requestProjection(context, state, input.projection!);
    } else if (input.operation === 'commit_forecast') {
      committed = await commitForecast(context, state, input.forecast!);
    } else if (input.operation === 'finish') {
      committed = await finish(context, state);
    } else {
      committed = await abandon(context, state);
    }
    if (!committed.result.ok) return committed.result;
    await persistReceipt(context, committed.state, input, hash, committed.result);
    log.info('kstar.control', {
      operation,
      result: 'ok',
      cid: maskId(context.conversationId),
      task: maskId(committed.result.taskId),
    });
    return committed.result;
  } catch (error) {
    const result = mapError(error);
    log.info('kstar.control', {
      operation,
      result: result.code === 'kstar_persistence_failed' ? 'failed' : 'rejected',
      cid: maskId(context?.conversationId),
      task: '',
    });
    return result;
  }
}
