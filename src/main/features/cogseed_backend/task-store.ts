import * as fs from 'node:fs/promises';

import { genId12, nowIso, writeJson } from '../../storage';
import { appendMateTaskEvent } from './event-store';
import { fileEditLock } from '../../util/locks';
import {
  assertMateRequestId,
  assertMateAgentId,
  assertMateConversationId,
  assertMateCoordinationId,
  assertMateTaskId,
  assertMateUserId,
  mateRequestClaimFile,
  mateTaskFile,
  mateTasksDirectory,
} from './paths';
import {
  getOrCreateMateAgentSession,
  getOrCreateMateSession,
  readMateSession,
  listMateSessions,
  setMateSessionActiveTask,
} from './session-store';
import { resolveMateSessionIdentity } from './actor-session-facade';
import {
  MATE_AGENT_BACKEND_SCHEMA_VERSION,
  type MateRequestClaim,
  type MateSessionRecord,
  type MateTaskRecord,
  type MateLocalCliConfig,
  type MateTaskSkillVersionPin,
} from './types';
import { listSkillVersions } from '../skills/version-store';
import { ensureSkillRuntimeSnapshot } from '../skills/runtime-snapshot-service';

export {
  getOrCreateMateAgentSession,
  getOrCreateMateSession,
  readMateSession,
  listMateSessions,
  setMateSessionActiveTask,
} from './session-store';

export interface CreateMateTaskInput {
  requestId: string;
  task: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  executionKind?: 'cogseed-native' | 'local-cli';
  allowedSkillIds?: string[];
  skillVersionPins?: MateTaskSkillVersionPin[];
  skillVersionPinStatus?: 'pinned' | 'unpinned';
  /** Internal retry path: preserve the already-persisted reference even when
   * a legacy version envelope cannot be re-read during migration. */
  preserveSkillVersionPins?: boolean;
  localCli?: MateLocalCliConfig;
  profileId?: string;
  retryOfTaskId?: string;
  coordinationId?: string;
  parentTaskId?: string;
  coordinationDepth?: number;
}

export interface CreateMateTaskResult {
  task: MateTaskRecord;
  created: boolean;
}

async function resolveSkillVersionPins(
  userId: string,
  allowedSkillIds: string[] | undefined,
  requested: MateTaskSkillVersionPin[] | undefined,
  preserveRequested: boolean,
): Promise<MateTaskSkillVersionPin[] | undefined> {
  if (!allowedSkillIds?.length && requested === undefined) return undefined;
  const allowed = new Set(allowedSkillIds || []);
  if (requested && requested.length > 128) throw new Error('too many Skill version pins');
  const skillIds = requested !== undefined
    ? requested.map((pin) => assertMateAgentId(String(pin.skillId)))
    : allowedSkillIds || [];
  if (new Set(skillIds).size !== skillIds.length) throw new Error('duplicate Skill version pin');
  if (requested !== undefined && skillIds.some((skillId) => !allowed.has(skillId))) {
    throw new Error('skill version pin is outside the persisted Skill allowlist');
  }
  const resolved: Array<MateTaskSkillVersionPin | undefined> = await Promise.all(skillIds.map(async (skillId, index): Promise<MateTaskSkillVersionPin | undefined> => {
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
    } satisfies MateTaskSkillVersionPin;
  }));
  return resolved.filter((pin): pin is MateTaskSkillVersionPin => !!pin);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function validateTask(userId: string, value: unknown, expectedTaskId?: string): MateTaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed task');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION) throw new Error('unsupported CogSeed task schema');
  if (row.ownerId !== userId) throw new Error('CogSeed task owner mismatch');
  if (typeof row.taskId !== 'string') throw new Error('malformed CogSeed task');
  assertMateTaskId(row.taskId);
  if (expectedTaskId && row.taskId !== expectedTaskId) throw new Error('CogSeed task id mismatch');
  if (typeof row.sessionId !== 'string' || typeof row.runtimeSessionId !== 'string' || typeof row.requestId !== 'string') {
    throw new Error('malformed CogSeed task');
  }
  if (!row.runtimeSessionId.startsWith('mruntime-')) throw new Error('malformed CogSeed task');
  if (row.executionId !== undefined && (typeof row.executionId !== 'string' || !row.executionId.startsWith('mate-exec-'))) throw new Error('malformed CogSeed task');
  if (row.runtimeRunId !== undefined && (typeof row.runtimeRunId !== 'string' || !row.runtimeRunId.startsWith('run_'))) throw new Error('malformed CogSeed task');
  if (row.runtimeWorkerId !== undefined && (typeof row.runtimeWorkerId !== 'string' || !row.runtimeWorkerId.startsWith('mate-worker-'))) throw new Error('malformed CogSeed task');
  if (row.coordinationId !== undefined && (typeof row.coordinationId !== 'string' || !row.coordinationId.startsWith('mate-coord-'))) throw new Error('malformed CogSeed task');
  if (row.parentTaskId !== undefined && (typeof row.parentTaskId !== 'string' || !row.parentTaskId.startsWith('mate-task-'))) throw new Error('malformed CogSeed task');
  if (row.coordinationDepth !== undefined && (!Number.isInteger(row.coordinationDepth) || Number(row.coordinationDepth) < 1)) throw new Error('malformed CogSeed task');
  if (row.conversationId !== undefined) assertMateConversationId(String(row.conversationId));
  if (row.agentId !== undefined) assertMateAgentId(String(row.agentId));
  if (row.executionKind !== undefined && row.executionKind !== 'cogseed-native' && row.executionKind !== 'local-cli') {
    throw new Error('malformed CogSeed task');
  }
  if (row.allowedSkillIds !== undefined) {
    if (!Array.isArray(row.allowedSkillIds) || row.allowedSkillIds.length > 128) throw new Error('malformed CogSeed task');
    for (const skillId of row.allowedSkillIds) assertMateAgentId(String(skillId));
  }
  if (row.skillVersionPins !== undefined) {
    if (!Array.isArray(row.skillVersionPins) || row.skillVersionPins.length > 128) throw new Error('malformed CogSeed task');
    const seen = new Set<string>();
    for (const raw of row.skillVersionPins) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('malformed CogSeed task');
      const pin = raw as Record<string, unknown>;
      const skillId = String(pin.skillId || '');
      assertMateAgentId(skillId);
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
  assertMateRequestId(row.requestId);
  if (row.lastResumeRequestId !== undefined) assertMateRequestId(String(row.lastResumeRequestId));
  if (typeof row.task !== 'string' || typeof row.status !== 'string' || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') {
    throw new Error('malformed CogSeed task');
  }
  return row as unknown as MateTaskRecord;
}

function validateClaim(userId: string, requestId: string, value: unknown): MateRequestClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed request claim');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION || row.ownerId !== userId || row.requestId !== requestId) {
    throw new Error('malformed CogSeed request claim');
  }
  if (typeof row.taskId !== 'string' || typeof row.createdAt !== 'string') throw new Error('malformed CogSeed request claim');
  assertMateTaskId(row.taskId);
  return row as unknown as MateRequestClaim;
}

export async function readMateTask(userId: string, taskId: string): Promise<MateTaskRecord | null> {
  assertMateUserId(userId);
  assertMateTaskId(taskId);
  try {
    const text = await fs.readFile(mateTaskFile(userId, taskId), 'utf8');
    return validateTask(userId, JSON.parse(text), taskId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed task');
    throw error;
  }
}

export async function updateMateTask(
  userId: string,
  taskId: string,
  mutate: (current: MateTaskRecord) => MateTaskRecord | Promise<MateTaskRecord>,
): Promise<MateTaskRecord> {
  assertMateUserId(userId);
  assertMateTaskId(taskId);
  const file = mateTaskFile(userId, taskId);
  return fileEditLock(file).runExclusive(async () => {
    const current = await readMateTask(userId, taskId);
    if (!current) throw new Error('CogSeed task not found');
    const next = await mutate(current);
    const validated = validateTask(userId, next, taskId);
    await writeJson(file, validated);
    return validated;
  });
}


export async function readMateTaskByRequestId(userId: string, requestId: string): Promise<MateTaskRecord | null> {
  assertMateUserId(userId);
  const claimFile = mateRequestClaimFile(userId, assertMateRequestId(requestId));
  try {
    const claim = validateClaim(userId, requestId, JSON.parse(await fs.readFile(claimFile, 'utf8')));
    return readMateTask(userId, claim.taskId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed request claim');
    throw error;
  }
}

export async function listMateTasks(userId: string): Promise<MateTaskRecord[]> {
  assertMateUserId(userId);
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(mateTasksDirectory(userId), { withFileTypes: true }); }
  catch (error) { if (isEnoent(error)) return []; throw error; }
  const tasks: MateTaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const taskId = entry.name.slice(0, -'.json'.length);
    tasks.push(await readMateTask(userId, taskId).then((task) => { if (!task) throw new Error('CogSeed task disappeared during recovery'); return task; }));
  }
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readLatestMateTaskForAgent(
  userId: string,
  conversationId: string,
  agentId: string,
): Promise<MateTaskRecord | null> {
  const safeConversationId = assertMateConversationId(conversationId);
  const safeAgentId = assertMateAgentId(agentId);
  const session = await getOrCreateMateAgentSession(userId, safeConversationId, safeAgentId);
  if (session.activeTaskId) {
    const active = await readMateTask(userId, session.activeTaskId);
    if (active && active.conversationId === safeConversationId && active.agentId === safeAgentId) return active;
  }
  return (await listMateTasks(userId)).find((task) => (
    task.conversationId === safeConversationId && task.agentId === safeAgentId
  )) ?? null;
}

export async function createMateTask(userId: string, input: CreateMateTaskInput): Promise<CreateMateTaskResult> {
  assertMateUserId(userId);
  const requestId = assertMateRequestId(String(input.requestId || ''));
  const task = String(input.task || '').trim();
  if (!task) throw new Error('CogSeed task is required');
  if (input.executionKind === 'local-cli' && !String(input.localCli?.cli || '').trim()) {
    throw new Error('CogSeed local CLI configuration is required');
  }
  const claimFile = mateRequestClaimFile(userId, requestId);

  return fileEditLock(claimFile).runExclusive(async () => {
    try {
      const claimText = await fs.readFile(claimFile, 'utf8');
      const claim = validateClaim(userId, requestId, JSON.parse(claimText));
      const existing = await readMateTask(userId, claim.taskId);
      if (!existing) throw new Error('CogSeed request claim references a missing task');
      return { task: existing, created: false };
    } catch (error) {
      if (!isEnoent(error)) {
        if (error instanceof SyntaxError) throw new Error('malformed CogSeed request claim');
        throw error;
      }
    }

    const requestedAgentId = input.agentId ? assertMateAgentId(String(input.agentId)) : undefined;
    let requestedConversationId = input.conversationId
      ? assertMateConversationId(String(input.conversationId))
      : undefined;
    if (input.sessionId) {
      const identity = resolveMateSessionIdentity(input.sessionId);
      if (requestedConversationId && identity.conversationId && requestedConversationId !== identity.conversationId) {
        throw new Error('CogSeed task conversation/session mismatch');
      }
      if (!requestedConversationId) requestedConversationId = identity.conversationId;
      if (requestedAgentId && identity.sessionKind === 'member' && identity.actorId !== requestedAgentId) {
        throw new Error('CogSeed task Agent/session mismatch');
      }
    }
    const session: MateSessionRecord = requestedAgentId && requestedConversationId
      ? await getOrCreateMateAgentSession(userId, requestedConversationId, requestedAgentId)
      : await getOrCreateMateSession(userId, input.sessionId);
    const createdAt = nowIso();
    const allowedSkillIds = input.allowedSkillIds !== undefined
      ? Array.from(new Set(input.allowedSkillIds.map((item) => assertMateAgentId(String(item)))))
      : undefined;
    const skillVersionPins = await resolveSkillVersionPins(
      userId,
      allowedSkillIds,
      input.skillVersionPins,
      input.preserveSkillVersionPins === true,
    );
    const taskRecord: MateTaskRecord = {
      schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
      taskId: `mate-task-${genId12()}`,
      sessionId: session.sessionId,
      runtimeSessionId: session.runtimeSessionId,
      executionId: 'mate-exec-' + genId12(),
      requestId,
      ownerId: userId,
      status: 'created',
      task,
      ...(requestedConversationId ? { conversationId: requestedConversationId } : {}),
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      ...(input.executionKind ? { executionKind: input.executionKind } : {}),
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
      ...(input.retryOfTaskId ? { retryOfTaskId: assertMateTaskId(String(input.retryOfTaskId)) } : {}),
      ...(input.coordinationId ? { coordinationId: assertMateCoordinationId(String(input.coordinationId)) } : {}),
      ...(input.parentTaskId ? { parentTaskId: assertMateTaskId(String(input.parentTaskId)) } : {}),
      ...(input.coordinationDepth !== undefined ? { coordinationDepth: (() => { const depth = Number(input.coordinationDepth); if (!Number.isInteger(depth) || depth < 1) throw new Error('invalid CogSeed coordination depth'); return depth; })() } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    const claim: MateRequestClaim = {
      schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
      requestId,
      taskId: taskRecord.taskId,
      ownerId: userId,
      createdAt,
    };
    await writeJson(mateTaskFile(userId, taskRecord.taskId), taskRecord);
    await writeJson(claimFile, claim);
    await setMateSessionActiveTask(userId, session.sessionId, taskRecord.taskId);
    await appendMateTaskEvent(userId, taskRecord.taskId, taskRecord.sessionId, 'task.created', { requestId });
    return { task: taskRecord, created: true };
  });
}
