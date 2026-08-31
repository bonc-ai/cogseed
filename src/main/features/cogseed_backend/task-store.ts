import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { genId12, nowIso, safeId, writeJson } from '../../storage';
import { appendCogSeedTaskEvent, readCogSeedTaskEvents } from './event-store';
import { fileEditLock } from '../../util/locks';
import {
  assertCogSeedRequestId,
  assertCogSeedAgentId,
  assertCogSeedConversationId,
  assertCogSeedCoordinationId,
  assertCogSeedTaskId,
  assertCogSeedUserId,
  cogseedRequestClaimFile,
  cogseedTaskFile,
  cogseedTasksDirectory,
} from './paths';
import {
  getOrCreateCogSeedAgentSession,
  getOrCreateCogSeedSession,
  readCogSeedSession,
  setCogSeedSessionActiveTask,
} from './session-store';
import { resolveCogSeedSessionIdentity } from './actor-session-facade';
import {
  COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
  type CogSeedRequestClaim,
  type CogSeedSessionRecord,
  type CogSeedTaskEventType,
  type CogSeedTaskRecord,
  type CogSeedLocalCliConfig,
  type CogSeedTaskSkillVersionPin,
} from './types';
import { listSkillVersions } from '../skills/version-store';
import { ensureSkillRuntimeSnapshot } from '../skills/runtime-snapshot-service';
import { cogSeedRequestFingerprint } from './request-fingerprint';

const COGSEED_TASK_STATUSES = new Set<string>([
  'created',
  'queued',
  'running',
  'waiting_user',
  'completed',
  'failed',
  'cancelled',
  'recoverable',
]);

export {
  getOrCreateCogSeedAgentSession,
  getOrCreateCogSeedSession,
  readCogSeedSession,
  listCogSeedSessions,
  setCogSeedSessionActiveTask,
  setCogSeedSessionDisplayName,
} from './session-store';

export interface CreateCogSeedTaskInput {
  requestId: string;
  task: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  executionKind?: 'cogseed-native' | 'local-cli' | 'group-chat';
  groupChatRunId?: string;
  groupChatTurnId?: string;
  groupChatSourceMessageId?: string;
  groupChatMessageId?: string;
  groupChatActorKind?: 'commander' | 'agent' | 'worker';
  groupChatWorkflowRunId?: string;
  groupChatWorkflowStepId?: string;
  allowedSkillIds?: string[];
  skillVersionPins?: CogSeedTaskSkillVersionPin[];
  skillVersionPinStatus?: 'pinned' | 'unpinned';
  /** Internal retry path: preserve the already-persisted reference even when
   * a legacy version envelope cannot be re-read during migration. */
  preserveSkillVersionPins?: boolean;
  localCli?: CogSeedLocalCliConfig;
  profileId?: string;
  abilityAssetIds?: string[];
  workingDir?: string;
  retryOfTaskId?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
}

export interface CreateCogSeedTaskResult {
  task: CogSeedTaskRecord;
  created: boolean;
}

async function resolveSkillVersionPins(
  userId: string,
  allowedSkillIds: string[] | undefined,
  requested: CogSeedTaskSkillVersionPin[] | undefined,
  preserveRequested: boolean,
): Promise<CogSeedTaskSkillVersionPin[] | undefined> {
  if (!allowedSkillIds?.length && requested === undefined) return undefined;
  const allowed = new Set(allowedSkillIds || []);
  if (requested && requested.length > 128) throw new Error('too many Skill version pins');
  const skillIds = requested !== undefined
    ? requested.map((pin) => assertCogSeedAgentId(String(pin.skillId)))
    : allowedSkillIds || [];
  if (new Set(skillIds).size !== skillIds.length) throw new Error('duplicate Skill version pin');
  if (requested !== undefined && skillIds.some((skillId) => !allowed.has(skillId))) {
    throw new Error('skill version pin is outside the persisted Skill allowlist');
  }
  const resolved: Array<CogSeedTaskSkillVersionPin | undefined> = await Promise.all(skillIds.map(async (skillId, index): Promise<CogSeedTaskSkillVersionPin | undefined> => {
    const versions = await listSkillVersions(userId, skillId);
    const requestedPin = requested?.[index];
    const current = requestedPin
      ? versions.find((record) => record.revisionId === requestedPin.revisionId
        || (record.version === requestedPin.version && record.manifestHash === requestedPin.manifestHash))
      : versions[0];
    if (!current?.manifestHash || !current.revisionId || !current.files
      || current.manifestHash !== (requestedPin?.manifestHash || current.manifestHash)) {
      if (requestedPin && preserveRequested) return requestedPin;
      if (requestedPin) throw new Error(`skill version pin is stale: ${skillId}`);
      return undefined;
    }
    await ensureSkillRuntimeSnapshot(userId, skillId, current);
    return {
      skillId,
      version: current.version,
      manifestHash: current.manifestHash,
      revisionId: current.revisionId,
    } satisfies CogSeedTaskSkillVersionPin;
  }));
  return resolved.filter((pin): pin is CogSeedTaskSkillVersionPin => !!pin);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function normalizeAbilityAssetIds(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 24) throw new Error('invalid CogSeed ability asset ids');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    if (!safeId(id)) throw new Error('invalid CogSeed ability asset id');
    seen.add(id);
    ids.push(id);
  }
  return ids.length ? ids : undefined;
}

function validateTask(userId: string, value: unknown, expectedTaskId?: string): CogSeedTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed task');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION) throw new Error('unsupported CogSeed task schema');
  if (row.ownerId !== userId) throw new Error('CogSeed task owner mismatch');
  if (typeof row.taskId !== 'string') throw new Error('malformed CogSeed task');
  assertCogSeedTaskId(row.taskId);
  if (expectedTaskId && row.taskId !== expectedTaskId) throw new Error('CogSeed task id mismatch');
  if (typeof row.sessionId !== 'string' || typeof row.runtimeSessionId !== 'string' || typeof row.requestId !== 'string') {
    throw new Error('malformed CogSeed task');
  }
  if (!row.runtimeSessionId.startsWith('mruntime-')) throw new Error('malformed CogSeed task');
  if (row.executionId !== undefined && (typeof row.executionId !== 'string' || !row.executionId.startsWith('cogseed-exec-'))) throw new Error('malformed CogSeed task');
  if (row.runtimeRunId !== undefined && (typeof row.runtimeRunId !== 'string' || !row.runtimeRunId.startsWith('run_'))) throw new Error('malformed CogSeed task');
  if (row.runtimeWorkerId !== undefined && (typeof row.runtimeWorkerId !== 'string' || !row.runtimeWorkerId.startsWith('cogseed-worker-'))) throw new Error('malformed CogSeed task');
  if (row.coordinationId !== undefined && (typeof row.coordinationId !== 'string' || !row.coordinationId.startsWith('cogseed-coord-'))) throw new Error('malformed CogSeed task');
  if (row.parentTaskId !== undefined && (typeof row.parentTaskId !== 'string' || !row.parentTaskId.startsWith('cogseed-task-'))) throw new Error('malformed CogSeed task');
  if (row.coordinationDepth !== undefined && (!Number.isInteger(row.coordinationDepth) || Number(row.coordinationDepth) < 1)) throw new Error('malformed CogSeed task');
  if (row.conversationId !== undefined) assertCogSeedConversationId(String(row.conversationId));
  if (row.agentId !== undefined) assertCogSeedAgentId(String(row.agentId));
  if (row.abilityAssetIds !== undefined) {
    if (!Array.isArray(row.abilityAssetIds) || row.abilityAssetIds.length > 24) throw new Error('malformed CogSeed task');
    const seen = new Set<string>();
    for (const raw of row.abilityAssetIds) {
      const id = String(raw || '');
      if (!safeId(id) || seen.has(id)) throw new Error('malformed CogSeed task');
      seen.add(id);
    }
  }
  if (row.workingDir !== undefined && (typeof row.workingDir !== 'string' || !path.isAbsolute(row.workingDir))) {
    throw new Error('malformed CogSeed task');
  }
  if (row.executionKind !== undefined && row.executionKind !== 'cogseed-native' && row.executionKind !== 'local-cli' && row.executionKind !== 'group-chat') {
    throw new Error('malformed CogSeed task');
  }
  if (row.resultDeliveryState !== undefined
    && row.resultDeliveryState !== 'not-applicable'
    && row.resultDeliveryState !== 'pending'
    && row.resultDeliveryState !== 'delivered'
    && row.resultDeliveryState !== 'pending-recovery') {
    throw new Error('malformed CogSeed task');
  }
  for (const key of ['groupChatRunId', 'groupChatTurnId', 'groupChatSourceMessageId', 'groupChatMessageId', 'groupChatWorkflowRunId', 'groupChatWorkflowStepId'] as const) {
    if (row[key] !== undefined && (typeof row[key] !== 'string' || !safeId(row[key]))) {
      throw new Error('malformed CogSeed task');
    }
  }
  if (row.groupChatActorKind !== undefined
    && row.groupChatActorKind !== 'commander'
    && row.groupChatActorKind !== 'agent'
    && row.groupChatActorKind !== 'worker') {
    throw new Error('malformed CogSeed task');
  }
  if (row.executionKind === 'group-chat' && row.groupChatRunId === undefined) throw new Error('malformed CogSeed task');
  if (row.allowedSkillIds !== undefined) {
    if (!Array.isArray(row.allowedSkillIds) || row.allowedSkillIds.length > 128) throw new Error('malformed CogSeed task');
    for (const skillId of row.allowedSkillIds) assertCogSeedAgentId(String(skillId));
  }
  if (row.skillVersionPins !== undefined) {
    if (!Array.isArray(row.skillVersionPins) || row.skillVersionPins.length > 128) throw new Error('malformed CogSeed task');
    const seen = new Set<string>();
    for (const raw of row.skillVersionPins) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed CogSeed task');
      const pin = raw as Record<string, unknown>;
      const skillId = String(pin.skillId || '');
      assertCogSeedAgentId(skillId);
      if (seen.has(skillId) || typeof pin.version !== 'string' || !pin.version.trim()
        || typeof pin.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(pin.manifestHash)
        || (pin.revisionId !== undefined && typeof pin.revisionId !== 'string')) throw new Error('malformed CogSeed task');
      seen.add(skillId);
    }
  }
  if (row.skillVersionPinStatus !== undefined && row.skillVersionPinStatus !== 'pinned' && row.skillVersionPinStatus !== 'unpinned') {
    throw new Error('malformed CogSeed task');
  }
  if (row.localCli !== undefined) {
    const localCli = row.localCli as Record<string, unknown>;
    if (!localCli || typeof localCli !== 'object' || Array.isArray(localCli)
      || typeof localCli.cli !== 'string' || !localCli.cli.trim()
      || (localCli.agentName !== undefined && typeof localCli.agentName !== 'string')
      || (localCli.model !== undefined && typeof localCli.model !== 'string')
      || (localCli.cliProviderId !== undefined && typeof localCli.cliProviderId !== 'string')
      || (localCli.viaP3394Gateway !== undefined && typeof localCli.viaP3394Gateway !== 'boolean')
      || (localCli.customArgs !== undefined && (!Array.isArray(localCli.customArgs)
        || localCli.customArgs.some((item) => typeof item !== 'string')))) {
      throw new Error('malformed CogSeed task');
    }
  }
  if (row.executionKind === 'local-cli' && row.localCli === undefined) throw new Error('malformed CogSeed task');
  assertCogSeedRequestId(row.requestId);
  if (row.requestFingerprint !== undefined
    && (typeof row.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestFingerprint))) {
    throw new Error('malformed CogSeed task');
  }
  if (row.lastResumeRequestId !== undefined) assertCogSeedRequestId(String(row.lastResumeRequestId));
  if (row.lastResumeRequestFingerprint !== undefined
    && (typeof row.lastResumeRequestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.lastResumeRequestFingerprint))) {
    throw new Error('malformed CogSeed task');
  }
  if (typeof row.task !== 'string' || typeof row.status !== 'string' || !COGSEED_TASK_STATUSES.has(row.status)
    || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
    throw new Error('malformed CogSeed task');
  }
  return row as unknown as CogSeedTaskRecord;
}

function validateClaim(userId: string, requestId: string, value: unknown): CogSeedRequestClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed request claim');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION || row.ownerId !== userId || row.requestId !== requestId) {
    throw new Error('malformed CogSeed request claim');
  }
  if (typeof row.taskId !== 'string' || typeof row.createdAt !== 'string') throw new Error('malformed CogSeed request claim');
  assertCogSeedTaskId(row.taskId);
  if (row.requestFingerprint !== undefined
    && (typeof row.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestFingerprint))) {
    throw new Error('malformed CogSeed request claim');
  }
  return row as unknown as CogSeedRequestClaim;
}

function createRequestFingerprint(input: CreateCogSeedTaskInput, normalizedTask: string): string {
  return cogSeedRequestFingerprint('create', {
    task: normalizedTask,
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    agentId: input.agentId,
    executionKind: input.executionKind,
    groupChatRunId: input.groupChatRunId,
    groupChatTurnId: input.groupChatTurnId,
    groupChatSourceMessageId: input.groupChatSourceMessageId,
    groupChatMessageId: input.groupChatMessageId,
    groupChatActorKind: input.groupChatActorKind,
    groupChatWorkflowRunId: input.groupChatWorkflowRunId,
    groupChatWorkflowStepId: input.groupChatWorkflowStepId,
    allowedSkillIds: input.allowedSkillIds ? [...input.allowedSkillIds].sort() : undefined,
    skillVersionPins: input.skillVersionPins
      ? [...input.skillVersionPins].sort((left, right) => left.skillId.localeCompare(right.skillId))
      : undefined,
    localCli: input.localCli,
    profileId: input.profileId,
    abilityAssetIds: input.abilityAssetIds ? [...input.abilityAssetIds].sort() : undefined,
    workingDir: input.workingDir?.trim(),
    retryOfTaskId: input.retryOfTaskId,
    coordinationId: input.coordinationId,
    parentTaskId: input.parentTaskId,
    coordinationDepth: input.coordinationDepth,
  });
}

function requestClaimForTask(
  userId: string,
  task: CogSeedTaskRecord,
  requestFingerprint: string,
): CogSeedRequestClaim {
  return {
    schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
    requestId: task.requestId,
    taskId: task.taskId,
    ownerId: userId,
    createdAt: task.createdAt,
    requestFingerprint,
  };
}

async function repairTaskCreationArtifacts(
  userId: string,
  task: CogSeedTaskRecord,
  newlyCreated = false,
): Promise<void> {
  const firstEvents = await readCogSeedTaskEvents(userId, task.taskId, 0, 1);
  const firstEvent = firstEvents[0];
  if (firstEvent?.type === 'task.created'
    && firstEvent.payload.requestId !== undefined
    && firstEvent.payload.requestId !== task.requestId) {
    throw new Error('CogSeed task creation event is inconsistent');
  }
  if (firstEvent && firstEvent.type !== 'task.created' && task.status === 'created') {
    throw new Error('CogSeed task creation event is inconsistent');
  }

  const session = await readCogSeedSession(userId, task.sessionId);
  if (!session) throw new Error('CogSeed task references a missing session');
  if (session.activeTaskId !== task.taskId) {
    const currentActive = session.activeTaskId
      ? await readCogSeedTask(userId, session.activeTaskId)
      : null;
    const shouldRepairPointer = newlyCreated
      || !currentActive
      || (!firstEvent && currentActive.createdAt < task.createdAt);
    if (shouldRepairPointer) {
      await setCogSeedSessionActiveTask(userId, task.sessionId, task.taskId);
    }
  }

  if (!firstEvent) {
    await appendCogSeedTaskEvent(userId, task.taskId, task.sessionId, 'task.created', {
      requestId: task.requestId,
    });
  }
}

/** Repair the artifacts that make an admitted task safe to recover. This is
 * intentionally idempotent so boot recovery can call it before changing a
 * freshly-created task's lifecycle state. */
export async function ensureCogSeedTaskCreationArtifacts(
  userId: string,
  task: CogSeedTaskRecord,
): Promise<void> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(task.taskId);
  await repairTaskCreationArtifacts(userId, task);
}

const STATUS_EVENT: Readonly<Partial<Record<CogSeedTaskRecord['status'], CogSeedTaskEventType>>> = {
  queued: 'task.queued',
  running: 'task.started',
  waiting_user: 'task.waiting_user',
  completed: 'task.completed',
  failed: 'task.failed',
  cancelled: 'task.cancelled',
  recoverable: 'task.recoverable',
};

const EVENT_STATUS = new Map<CogSeedTaskEventType, CogSeedTaskRecord['status']>([
  ['task.created', 'created'],
  ['task.queued', 'queued'],
  ['task.started', 'running'],
  ['task.waiting_user', 'waiting_user'],
  ['task.completed', 'completed'],
  ['task.failed', 'failed'],
  ['task.cancelled', 'cancelled'],
  ['task.recoverable', 'recoverable'],
]);

function repairPayloadForTask(
  task: CogSeedTaskRecord,
  override: Record<string, unknown>,
): Record<string, unknown> {
  if ((task.status === 'failed' || task.status === 'recoverable') && task.errorCode) {
    return { errorCode: task.errorCode, ...override };
  }
  return override;
}

/**
 * Reconcile the process-crash window between the atomic task JSON rename and
 * the matching JSONL append. This never invents intermediate states: it only
 * appends the event that describes the already-durable current task status.
 */
export async function ensureCogSeedTaskLifecycleArtifact(
  userId: string,
  taskId: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const file = cogseedTaskFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => {
    const task = await readCogSeedTask(userId, taskId);
    if (!task) throw new Error('CogSeed task not found');
    const expectedType = STATUS_EVENT[task.status];
    if (!expectedType) return false;

    let afterSequence = 0;
    let last: import('./types').CogSeedTaskEvent | undefined;
    for (;;) {
      const batch = await readCogSeedTaskEvents(userId, taskId, afterSequence, 500);
      for (const event of batch) {
        if (EVENT_STATUS.has(event.type)) last = event;
      }
      if (batch.length < 500) break;
      afterSequence = batch[batch.length - 1].sequence;
    }
    if (last?.type === expectedType) return false;

    const lastStatus = last ? EVENT_STATUS.get(last.type) : undefined;
    if (lastStatus === 'completed' || lastStatus === 'failed' || lastStatus === 'cancelled') {
      throw new Error(`CogSeed task/event terminal state conflict: ${lastStatus} -> ${task.status}`);
    }
    await appendCogSeedTaskEvent(
      userId,
      task.taskId,
      task.sessionId,
      expectedType,
      repairPayloadForTask(task, payload),
    );
    return true;
  });
}

export async function readCogSeedTask(userId: string, taskId: string): Promise<CogSeedTaskRecord | null> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  try {
    const text = await fs.readFile(cogseedTaskFile(userId, taskId), 'utf8');
    return validateTask(userId, JSON.parse(text), taskId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed task');
    throw error;
  }
}

export async function updateCogSeedTask(
  userId: string,
  taskId: string,
  mutate: (current: CogSeedTaskRecord) => CogSeedTaskRecord | Promise<CogSeedTaskRecord>,
): Promise<CogSeedTaskRecord> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const file = cogseedTaskFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => {
    const current = await readCogSeedTask(userId, taskId);
    if (!current) throw new Error('CogSeed task not found');
    const next = await mutate(current);
    const validated = validateTask(userId, next, taskId);
    await writeJson(file, validated);
    return validated;
  });
}

/** Persist one task mutation and its lifecycle event as one recoverable local
 * operation. A normal append failure restores the prior task record while the
 * task-file lock still excludes competing transitions. */
export async function updateCogSeedTaskWithEvent(
  userId: string,
  taskId: string,
  mutate: (current: CogSeedTaskRecord) => CogSeedTaskRecord | Promise<CogSeedTaskRecord>,
  event: { type: CogSeedTaskEventType; payload: Record<string, unknown> },
): Promise<CogSeedTaskRecord> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const file = cogseedTaskFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => {
    const current = await readCogSeedTask(userId, taskId);
    if (!current) throw new Error('CogSeed task not found');
    const next = await mutate(current);
    if (next === current) return current;
    const validated = validateTask(userId, next, taskId);
    await writeJson(file, validated);
    try {
      await appendCogSeedTaskEvent(userId, taskId, validated.sessionId, event.type, event.payload);
      return validated;
    } catch (error) {
      await writeJson(file, current);
      throw error;
    }
  });
}

/** Append an execution-progress event only while the task is still active.
 * Taking the task lock before the event lock matches lifecycle transitions and
 * prevents a late Runtime callback from being written after a terminal event. */
export async function appendCogSeedTaskEventIfActive(
  userId: string,
  taskId: string,
  type: CogSeedTaskEventType,
  payload: Record<string, unknown>,
): Promise<import('./types').CogSeedTaskEvent | null> {
  assertCogSeedUserId(userId);
  assertCogSeedTaskId(taskId);
  const file = cogseedTaskFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => {
    const task = await readCogSeedTask(userId, taskId);
    if (!task) throw new Error('CogSeed task not found');
    // Runtime progress belongs only to an execution that still owns an active
    // state. Lifecycle events for created/queued/recoverable use the separate
    // atomic task+event transition path and must not be appended here.
    if (task.status !== 'running' && task.status !== 'waiting_user') return null;
    return appendCogSeedTaskEvent(userId, taskId, task.sessionId, type, payload);
  });
}


export async function readCogSeedTaskByRequestId(userId: string, requestId: string): Promise<CogSeedTaskRecord | null> {
  assertCogSeedUserId(userId);
  const claimFile = cogseedRequestClaimFile(userId, assertCogSeedRequestId(requestId));
  try {
    const claim = validateClaim(userId, requestId, JSON.parse(await fs.readFile(claimFile, 'utf8')));
    const task = await readCogSeedTask(userId, claim.taskId);
    if (!task) throw new Error('CogSeed request claim references a missing task');
    return task;
  } catch (error) {
    if (isEnoent(error)) {
      const orphaned = (await listCogSeedTasks(userId)).filter((task) => task.requestId === requestId);
      if (orphaned.length > 1) throw new Error('multiple CogSeed tasks found for request ID');
      return orphaned[0] ?? null;
    }
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed request claim');
    throw error;
  }
}

export async function listCogSeedTasks(userId: string): Promise<CogSeedTaskRecord[]> {
  assertCogSeedUserId(userId);
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(cogseedTasksDirectory(userId), { withFileTypes: true }); }
  catch (error) { if (isEnoent(error)) return []; throw error; }
  const tasks: CogSeedTaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const taskId = entry.name.slice(0, -'.json'.length);
    tasks.push(await readCogSeedTask(userId, taskId).then((task) => { if (!task) throw new Error('CogSeed task disappeared during recovery'); return task; }));
  }
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readLatestCogSeedTaskForAgent(
  userId: string,
  conversationId: string,
  agentId: string,
): Promise<CogSeedTaskRecord | null> {
  const safeConversationId = assertCogSeedConversationId(conversationId);
  const safeAgentId = assertCogSeedAgentId(agentId);
  const session = await getOrCreateCogSeedAgentSession(userId, safeConversationId, safeAgentId);
  if (session.activeTaskId) {
    const active = await readCogSeedTask(userId, session.activeTaskId);
    if (active && active.conversationId === safeConversationId && active.agentId === safeAgentId) return active;
  }
  return (await listCogSeedTasks(userId)).find((task) => (
    task.conversationId === safeConversationId && task.agentId === safeAgentId
  )) ?? null;
}

export async function createCogSeedTask(userId: string, input: CreateCogSeedTaskInput): Promise<CreateCogSeedTaskResult> {
  assertCogSeedUserId(userId);
  const requestId = assertCogSeedRequestId(String(input.requestId || ''));
  const task = String(input.task || '').trim();
  if (!task) throw new Error('CogSeed task is required');
  if (input.executionKind === 'local-cli' && !String(input.localCli?.cli || '').trim()) {
    throw new Error('CogSeed local CLI configuration is required');
  }
  for (const value of [input.groupChatRunId, input.groupChatTurnId, input.groupChatSourceMessageId, input.groupChatMessageId, input.groupChatWorkflowRunId, input.groupChatWorkflowStepId]) {
    if (value !== undefined && !safeId(value)) throw new Error('invalid CogSeed Group Chat correlation id');
  }
  if (input.executionKind === 'group-chat' && !input.groupChatRunId) {
    throw new Error('CogSeed Group Chat run id is required');
  }
  const requestFingerprint = createRequestFingerprint(input, task);
  const claimFile = cogseedRequestClaimFile(userId, requestId);

  return fileEditLock(claimFile).runExclusive(async () => {
    try {
      const claimText = await fs.readFile(claimFile, 'utf8');
      const claim = validateClaim(userId, requestId, JSON.parse(claimText));
      if (claim.requestFingerprint && claim.requestFingerprint !== requestFingerprint) {
        throw new Error('CogSeed request ID payload conflict');
      }
      let existing = await readCogSeedTask(userId, claim.taskId);
      if (!existing) throw new Error('CogSeed request claim references a missing task');
      if (existing.requestId !== requestId) throw new Error('CogSeed request claim references a mismatched task');
      if (claim.requestFingerprint && existing.requestFingerprint
        && claim.requestFingerprint !== existing.requestFingerprint) {
        throw new Error('CogSeed request fingerprint mismatch');
      }
      const persistedFingerprint = claim.requestFingerprint ?? existing.requestFingerprint;
      if (persistedFingerprint && persistedFingerprint !== requestFingerprint) {
        throw new Error('CogSeed request ID payload conflict');
      }
      if (!existing.requestFingerprint && claim.requestFingerprint) {
        existing = await updateCogSeedTask(userId, existing.taskId, (current) => ({
          ...current,
          requestFingerprint: claim.requestFingerprint,
        }));
      }
      if (!claim.requestFingerprint && existing.requestFingerprint) {
        await writeJson(claimFile, requestClaimForTask(userId, existing, existing.requestFingerprint));
      }
      await repairTaskCreationArtifacts(userId, existing);
      return { task: existing, created: false };
    } catch (error) {
      if (!isEnoent(error)) {
        if (error instanceof SyntaxError) throw new Error('malformed CogSeed request claim');
        throw error;
      }
    }

    const orphaned = (await listCogSeedTasks(userId)).filter((candidate) => candidate.requestId === requestId);
    if (orphaned.length > 1) {
      throw new Error('multiple CogSeed tasks found for request ID; refusing automatic claim repair');
    }
    if (orphaned.length === 1) {
      const existing = orphaned[0];
      if (!existing.requestFingerprint) {
        throw new Error('CogSeed orphan task request fingerprint is unavailable');
      }
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error('CogSeed request ID payload conflict');
      }
      await writeJson(claimFile, requestClaimForTask(userId, existing, existing.requestFingerprint));
      await repairTaskCreationArtifacts(userId, existing);
      return { task: existing, created: false };
    }

    const requestedAgentId = input.agentId ? assertCogSeedAgentId(String(input.agentId)) : undefined;
    let requestedConversationId = input.conversationId
      ? assertCogSeedConversationId(String(input.conversationId))
      : undefined;
    if (input.sessionId) {
      const identity = resolveCogSeedSessionIdentity(input.sessionId);
      if (requestedConversationId && identity.conversationId && requestedConversationId !== identity.conversationId) {
        throw new Error('CogSeed task conversation/session mismatch');
      }
      if (!requestedConversationId) requestedConversationId = identity.conversationId;
      if (requestedAgentId && identity.sessionKind === 'member' && identity.actorId !== requestedAgentId) {
        throw new Error('CogSeed task Agent/session mismatch');
      }
    }
    const session: CogSeedSessionRecord = requestedAgentId && requestedConversationId
      ? await getOrCreateCogSeedAgentSession(userId, requestedConversationId, requestedAgentId)
      : await getOrCreateCogSeedSession(userId, input.sessionId);
    const createdAt = nowIso();
    const allowedSkillIds = input.allowedSkillIds !== undefined
      ? Array.from(new Set(input.allowedSkillIds.map((item) => assertCogSeedAgentId(String(item)))))
      : undefined;
    const skillVersionPins = await resolveSkillVersionPins(
      userId,
      allowedSkillIds,
      input.skillVersionPins,
      input.preserveSkillVersionPins === true,
    );
    const abilityAssetIds = normalizeAbilityAssetIds(input.abilityAssetIds);
    const workingDir = typeof input.workingDir === 'string' ? input.workingDir.trim() : undefined;
    if (workingDir && !path.isAbsolute(workingDir)) throw new Error('CogSeed working directory must be absolute');
    const taskRecord: CogSeedTaskRecord = {
      schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
      taskId: `cogseed-task-${genId12()}`,
      sessionId: session.sessionId,
      runtimeSessionId: session.runtimeSessionId,
      executionId: 'cogseed-exec-' + genId12(),
      requestId,
      requestFingerprint,
      ownerId: userId,
      status: 'created',
      task,
      ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      ...(input.executionKind ? { executionKind: input.executionKind } : {}),
      ...(requestedConversationId && requestedAgentId && input.executionKind !== 'group-chat'
        ? { resultDeliveryState: 'pending' as const }
        : {}),
      ...(input.groupChatRunId ? { groupChatRunId: input.groupChatRunId } : {}),
      ...(input.groupChatTurnId ? { groupChatTurnId: input.groupChatTurnId } : {}),
      ...(input.groupChatSourceMessageId ? { groupChatSourceMessageId: input.groupChatSourceMessageId } : {}),
      ...(input.groupChatMessageId ? { groupChatMessageId: input.groupChatMessageId } : {}),
      ...(input.groupChatActorKind ? { groupChatActorKind: input.groupChatActorKind } : {}),
      ...(input.groupChatWorkflowRunId ? { groupChatWorkflowRunId: input.groupChatWorkflowRunId } : {}),
      ...(input.groupChatWorkflowStepId ? { groupChatWorkflowStepId: input.groupChatWorkflowStepId } : {}),
      ...(allowedSkillIds !== undefined ? { allowedSkillIds } : {}),
      ...(skillVersionPins?.length ? { skillVersionPins } : {}),
      ...(allowedSkillIds?.length ? { skillVersionPinStatus: skillVersionPins?.length === allowedSkillIds.length ? 'pinned' : 'unpinned' } : {}),
      ...(input.localCli ? {
        localCli: {
          cli: String(input.localCli.cli || '').trim(),
          ...(input.localCli.agentName ? { agentName: String(input.localCli.agentName) } : {}),
          ...(input.localCli.model ? { model: String(input.localCli.model) } : {}),
          ...(input.localCli.customArgs?.length ? { customArgs: input.localCli.customArgs.map(String) } : {}),
          ...(input.localCli.cliProviderId ? { cliProviderId: String(input.localCli.cliProviderId) } : {}),
          // 关键：外接智能体（runtime.kind='p3394-gateway'）执行必须保留
          // viaP3394Gateway 标记，否则 consumeRuntime 读回时退化成本机
          // CLI 直连（runCli），绕过 P3394 网关协作路径。
          ...(input.localCli.viaP3394Gateway ? { viaP3394Gateway: true } : {}),
        },
      } : {}),
      ...(input.profileId ? { profileId: String(input.profileId) } : {}),
      ...(abilityAssetIds?.length ? { abilityAssetIds } : {}),
      ...(workingDir ? { workingDir } : {}),
      ...(input.retryOfTaskId ? { retryOfTaskId: assertCogSeedTaskId(String(input.retryOfTaskId)) } : {}),
      ...(input.coordinationId ? { coordinationId: assertCogSeedCoordinationId(String(input.coordinationId)) } : {}),
      ...(input.parentTaskId ? { parentTaskId: assertCogSeedTaskId(String(input.parentTaskId)) } : {}),
      ...(input.coordinationDepth !== undefined ? { coordinationDepth: (() => { const depth = Number(input.coordinationDepth); if (!Number.isInteger(depth) || depth < 1) throw new Error('invalid CogSeed coordination depth'); return depth; })() } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    const claim = requestClaimForTask(userId, taskRecord, requestFingerprint);
    await writeJson(cogseedTaskFile(userId, taskRecord.taskId), taskRecord);
    await repairTaskCreationArtifacts(userId, taskRecord, true);
    await writeJson(claimFile, claim);
    return { task: taskRecord, created: true };
  });
}
