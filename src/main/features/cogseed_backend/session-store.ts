import * as fs from 'node:fs/promises';

import { genId12, nowIso, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import {
  assertMateAgentId,
  assertMateConversationId,
  assertMateSessionId,
  assertMateUserId,
  mateAgentSessionMappingFile,
  mateSessionFile,
  mateSessionsDirectory,
} from './paths';
import {
  buildMateCommanderCompatibilityId,
  buildMateCommanderSessionId,
  buildMateMemberCompatibilityId,
  buildMateMemberSessionId,
  hydrateMateSessionRecord,
  resolveMateSessionIdentity,
} from './actor-session-facade';
import {
  MATE_AGENT_BACKEND_SCHEMA_VERSION,
  type MateActorRecord,
  type MateActorRole,
  type MateCommanderSession,
  type MateMemberSession,
  type MateSessionRecord,
} from './types';

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

interface MateAgentSessionMapping {
  schemaVersion: typeof MATE_AGENT_BACKEND_SCHEMA_VERSION;
  ownerId: string;
  conversationId: string;
  agentId: string;
  sessionId: string;
  createdAt: string;
}

function validateAgentSessionMapping(
  userId: string,
  conversationId: string,
  agentId: string,
  value: unknown,
): MateAgentSessionMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed Agent session mapping');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION
    || row.ownerId !== userId
    || row.conversationId !== conversationId
    || row.agentId !== agentId
    || typeof row.sessionId !== 'string'
    || typeof row.createdAt !== 'string') {
    throw new Error('malformed CogSeed Agent session mapping');
  }
  assertMateSessionId(row.sessionId);
  return row as unknown as MateAgentSessionMapping;
}

function validateActor(value: unknown): MateActorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed actor');
  const row = value as Record<string, unknown>;
  if (typeof row.actorId !== 'string' || typeof row.actorRole !== 'string' || typeof row.displayName !== 'string') {
    throw new Error('malformed CogSeed actor');
  }
  if (typeof row.sessionId !== 'string' || typeof row.lifecycleState !== 'string' || typeof row.joinedAt !== 'string') {
    throw new Error('malformed CogSeed actor');
  }
  resolveMateSessionIdentity(row.sessionId);
  return row as unknown as MateActorRecord;
}

function validateSession(userId: string, value: unknown, expectedSessionId?: string): MateSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed session');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== MATE_AGENT_BACKEND_SCHEMA_VERSION) throw new Error('unsupported CogSeed session schema');
  if (row.ownerId !== userId) throw new Error('CogSeed session owner mismatch');
  if (typeof row.sessionId !== 'string') throw new Error('malformed CogSeed session');
  const identity = resolveMateSessionIdentity(row.compatibilitySessionId ? String(row.compatibilitySessionId) : row.sessionId);
  assertMateSessionId(row.sessionId);
  if (row.sessionId !== identity.canonicalSessionId) throw new Error('CogSeed session canonical id mismatch');
  if (expectedSessionId && identity.canonicalSessionId !== resolveMateSessionIdentity(expectedSessionId).canonicalSessionId) {
    throw new Error('CogSeed session id mismatch');
  }
  if (typeof row.runtimeSessionId !== 'string' || !row.runtimeSessionId.startsWith('mruntime-')) {
    throw new Error('malformed CogSeed session');
  }
  if (typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('malformed CogSeed session');
  if (row.conversationId !== undefined) assertMateConversationId(String(row.conversationId));
  if (row.agentId !== undefined) assertMateAgentId(String(row.agentId));
  if (row.activeTaskId !== undefined && (typeof row.activeTaskId !== 'string' || !row.activeTaskId.startsWith('mate-task-'))) {
    throw new Error('malformed CogSeed session');
  }
  const hydrated = hydrateMateSessionRecord(row as unknown as MateSessionRecord);
  if (hydrated.roster) hydrated.roster = hydrated.roster.map(validateActor);
  if (hydrated.sessionKind === 'member') {
    if (!hydrated.actorId || !hydrated.conversationId || !hydrated.commanderSessionId || !hydrated.displayName) {
      throw new Error('malformed CogSeed member session');
    }
    if (hydrated.agentId !== hydrated.actorId) throw new Error('CogSeed member Agent identity mismatch');
  }
  if (hydrated.sessionKind === 'commander' && (!hydrated.conversationId || !hydrated.roster)) {
    throw new Error('malformed CogSeed commander session');
  }
  return hydrated;
}

function normalizeSessionId(sessionId: string): string {
  return resolveMateSessionIdentity(sessionId).canonicalSessionId;
}

function commanderInputToSessionId(conversationOrSessionId: string): string {
  if (conversationOrSessionId.startsWith('gconv-') || conversationOrSessionId.startsWith('mate-session-')) {
    const identity = resolveMateSessionIdentity(conversationOrSessionId);
    if (identity.sessionKind !== 'commander') throw new Error('CogSeed commander session required');
    return identity.canonicalSessionId;
  }
  return buildMateCommanderSessionId(conversationOrSessionId);
}

async function writeSession(userId: string, record: MateSessionRecord): Promise<MateSessionRecord> {
  await writeJson(mateSessionFile(userId, record.sessionId), record);
  return record;
}

async function updateMateSession(
  userId: string,
  sessionId: string,
  mutate: (current: MateSessionRecord) => MateSessionRecord | Promise<MateSessionRecord>,
): Promise<MateSessionRecord> {
  assertMateUserId(userId);
  const canonicalSessionId = normalizeSessionId(sessionId);
  const file = mateSessionFile(userId, canonicalSessionId);
  return fileEditLock(file).runExclusive(async () => {
    const current = await readMateSession(userId, canonicalSessionId);
    if (!current) throw new Error('CogSeed session not found');
    const next = hydrateMateSessionRecord(await mutate(current));
    const validated = validateSession(userId, next, canonicalSessionId);
    return writeSession(userId, { ...validated, updatedAt: nowIso() });
  });
}

export async function readMateSession(userId: string, sessionId: string): Promise<MateSessionRecord | null> {
  assertMateUserId(userId);
  const canonicalSessionId = normalizeSessionId(sessionId);
  try {
    const text = await fs.readFile(mateSessionFile(userId, canonicalSessionId), 'utf8');
    return validateSession(userId, JSON.parse(text), canonicalSessionId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed session');
    throw error;
  }
}

export async function getOrCreateMateSession(userId: string, sessionId?: string): Promise<MateSessionRecord> {
  assertMateUserId(userId);
  const identity = sessionId
    ? resolveMateSessionIdentity(sessionId)
    : {
        externalSessionId: '',
        canonicalSessionId: `mate-session-${genId12()}`,
        sessionKind: 'generic' as const,
        actorRole: 'commander' as const,
      };
  const targetSessionId = assertMateSessionId(identity.canonicalSessionId);
  const file = mateSessionFile(userId, targetSessionId);
  return fileEditLock(file).runExclusive(async () => {
    const existing = await readMateSession(userId, targetSessionId);
    if (existing) return existing;
    if (sessionId) {
      if (sessionId === identity.externalSessionId && identity.externalSessionId === identity.canonicalSessionId) {
        throw new Error('CogSeed session not found');
      }
      if (sessionId === identity.externalSessionId && !identity.externalSessionId.startsWith('gconv-') && !identity.externalSessionId.startsWith('gmember-')) {
        throw new Error('CogSeed session not found');
      }
    }
    const createdAt = nowIso();
    const record: MateSessionRecord = {
      schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
      sessionId: targetSessionId,
      runtimeSessionId: `mruntime-${genId12()}`,
      ownerId: userId,
      createdAt,
      updatedAt: createdAt,
      sessionKind: identity.sessionKind,
      actorRole: identity.actorRole,
      ...(identity.actorId ? { actorId: identity.actorId } : {}),
      ...(identity.conversationId ? { conversationId: identity.conversationId } : {}),
      ...(identity.sessionKind === 'member' && identity.actorId ? { agentId: identity.actorId } : {}),
      ...(identity.externalSessionId ? { compatibilitySessionId: identity.externalSessionId } : {}),
      ...(identity.sessionKind === 'member'
        ? {
            commanderSessionId: buildMateCommanderSessionId(identity.conversationId!),
            displayName: identity.actorId!,
            joinedAt: createdAt,
          }
        : {}),
      lifecycleState: 'active',
      ...(identity.sessionKind === 'commander'
        ? {
            roster: [{
              actorId: 'commander',
              actorRole: 'commander',
              displayName: 'Commander',
              sessionId: targetSessionId,
              lifecycleState: 'active',
              joinedAt: createdAt,
            }],
          }
        : {}),
    };
    return writeSession(userId, record);
  });
}

export async function getOrCreateMateCommanderSession(userId: string, conversationId: string): Promise<MateCommanderSession> {
  const session = await getOrCreateMateSession(userId, buildMateCommanderCompatibilityId(conversationId));
  if (session.sessionKind !== 'commander') throw new Error('CogSeed commander session required');
  return session as MateCommanderSession;
}

export async function getOrCreateMateMemberSession(
  userId: string,
  conversationId: string,
  actorId: string,
  displayName = actorId,
  actorRole: Exclude<MateActorRole, 'commander'> = 'member',
): Promise<MateMemberSession> {
  const externalSessionId = buildMateMemberCompatibilityId(conversationId, actorId);
  const session = await getOrCreateMateSession(userId, externalSessionId);
  const commanderSessionId = buildMateCommanderSessionId(conversationId);
  const updated = await updateMateSession(userId, session.sessionId, (current) => ({
    ...current,
    actorId,
    agentId: actorId,
    conversationId,
    actorRole,
    displayName: displayName.trim() || actorId,
    commanderSessionId,
    lifecycleState: 'active',
    joinedAt: current.joinedAt || nowIso(),
    leftAt: undefined,
  }));
  if (updated.sessionKind !== 'member' || !updated.actorId || !updated.conversationId || !updated.commanderSessionId || !updated.displayName) {
    throw new Error('CogSeed member session invariant failed');
  }
  return updated as MateMemberSession;
}

/** Durable formal-Agent lookup keyed only by the user-scoped conversation and
 * Agent identity. The deterministic member id is the persisted source of
 * truth; no module-level cache participates in session reuse. */
export async function getOrCreateMateAgentSession(
  userId: string,
  conversationId: string,
  agentId: string,
  displayName = agentId,
): Promise<MateMemberSession> {
  assertMateUserId(userId);
  const safeConversationId = assertMateConversationId(conversationId);
  const safeAgentId = assertMateAgentId(agentId);
  const mappingFile = mateAgentSessionMappingFile(userId, safeConversationId, safeAgentId);
  return fileEditLock(mappingFile).runExclusive(async () => {
    try {
      const mapping = validateAgentSessionMapping(
        userId,
        safeConversationId,
        safeAgentId,
        JSON.parse(await fs.readFile(mappingFile, 'utf8')),
      );
      const existing = await readMateSession(userId, mapping.sessionId);
      if (!existing || existing.sessionKind !== 'member'
        || existing.conversationId !== safeConversationId
        || existing.agentId !== safeAgentId
        || existing.actorId !== safeAgentId) {
        throw new Error('CogSeed Agent session mapping references an invalid session');
      }
      return existing as MateMemberSession;
    } catch (error) {
      if (!isEnoent(error)) {
        if (error instanceof SyntaxError) throw new Error('malformed CogSeed Agent session mapping');
        throw error;
      }
    }

    const reusable = (await listMateSessions(userId)).find((session) => (
      session.sessionKind === 'member'
      && session.conversationId === safeConversationId
      && session.agentId === safeAgentId
      && session.actorId === safeAgentId
    ));
    let session: MateMemberSession;
    if (reusable) {
      session = reusable as MateMemberSession;
    } else {
      const createdAt = nowIso();
      session = await writeSession(userId, {
        schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
        sessionId: `mate-session-agent-${genId12()}`,
        runtimeSessionId: `mruntime-${genId12()}`,
        ownerId: userId,
        createdAt,
        updatedAt: createdAt,
        sessionKind: 'member',
        actorRole: 'member',
        actorId: safeAgentId,
        agentId: safeAgentId,
        conversationId: safeConversationId,
        commanderSessionId: buildMateCommanderSessionId(safeConversationId),
        displayName: displayName.trim() || safeAgentId,
        lifecycleState: 'active',
        joinedAt: createdAt,
      }) as MateMemberSession;
    }
    const mapping: MateAgentSessionMapping = {
      schemaVersion: MATE_AGENT_BACKEND_SCHEMA_VERSION,
      ownerId: userId,
      conversationId: safeConversationId,
      agentId: safeAgentId,
      sessionId: session.sessionId,
      createdAt: nowIso(),
    };
    await writeJson(mappingFile, mapping);
    return session;
  });
}

export async function readMateCommanderSession(userId: string, conversationOrSessionId: string): Promise<MateCommanderSession | null> {
  const session = await readMateSession(userId, commanderInputToSessionId(conversationOrSessionId));
  if (!session) return null;
  if (session.sessionKind !== 'commander') throw new Error('CogSeed commander session required');
  return session as MateCommanderSession;
}

export async function readMateRoster(userId: string, conversationOrSessionId: string): Promise<MateActorRecord[]> {
  const session = await readMateCommanderSession(userId, conversationOrSessionId);
  return session?.roster || [];
}

export async function setMateSessionActiveTask(
  userId: string,
  sessionId: string,
  taskId: string,
): Promise<MateSessionRecord> {
  if (!taskId.startsWith('mate-task-')) throw new Error('invalid CogSeed task id');
  return updateMateSession(userId, sessionId, (current) => ({ ...current, activeTaskId: taskId }));
}

export async function joinMateMember(
  userId: string,
  conversationId: string,
  actorId: string,
  displayName = actorId,
  actorRole: Exclude<MateActorRole, 'commander'> = 'member',
): Promise<MateMemberSession> {
  const commander = await getOrCreateMateCommanderSession(userId, conversationId);
  const member = await getOrCreateMateMemberSession(userId, conversationId, actorId, displayName, actorRole);
  const joinedAt = nowIso();
  const actor: MateActorRecord = {
    actorId: member.actorId!,
    actorRole: member.actorRole,
    displayName: member.displayName!,
    sessionId: member.sessionId,
    lifecycleState: 'active',
    joinedAt,
  };
  await updateMateSession(userId, commander.sessionId, (current) => ({
    ...current,
    roster: [
      ...(current.roster || []).filter((entry) => entry.actorId !== actor.actorId),
      actor,
    ],
  }));
  return (await readMateSession(userId, member.sessionId)) as MateMemberSession;
}

export async function leaveMateMember(userId: string, conversationOrSessionId: string, actorId: string): Promise<MateMemberSession> {
  const commander = await readMateCommanderSession(userId, conversationOrSessionId);
  if (!commander?.conversationId) throw new Error('CogSeed commander session not found');
  const member = await readMateSession(userId, buildMateMemberSessionId(commander.conversationId, actorId));
  if (!member || member.sessionKind !== 'member') throw new Error('CogSeed member session not found');
  const leftAt = nowIso();
  const updated = await updateMateSession(userId, member.sessionId, (current) => ({ ...current, lifecycleState: 'left', leftAt }));
  await updateMateSession(userId, commander.sessionId, (current) => ({
    ...current,
    roster: (current.roster || []).filter((entry) => entry.actorId !== actorId),
  }));
  return updated as MateMemberSession;
}

export async function renameMateMember(
  userId: string,
  conversationOrSessionId: string,
  actorId: string,
  displayName: string,
): Promise<MateMemberSession> {
  const trimmed = displayName.trim();
  if (!trimmed) throw new Error('CogSeed member display name is required');
  const commander = await readMateCommanderSession(userId, conversationOrSessionId);
  if (!commander?.conversationId) throw new Error('CogSeed commander session not found');
  const member = await readMateSession(userId, buildMateMemberSessionId(commander.conversationId, actorId));
  if (!member || member.sessionKind !== 'member') throw new Error('CogSeed member session not found');
  const updated = await updateMateSession(userId, member.sessionId, (current) => ({ ...current, displayName: trimmed }));
  await updateMateSession(userId, commander.sessionId, (current) => ({
    ...current,
    roster: (current.roster || []).map((entry) => entry.actorId === actorId ? { ...entry, displayName: trimmed } : entry),
  }));
  return updated as MateMemberSession;
}

export async function listMateSessions(userId: string): Promise<MateSessionRecord[]> {
  assertMateUserId(userId);
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(mateSessionsDirectory(userId), { withFileTypes: true }); }
  catch (error) { if (isEnoent(error)) return []; throw error; }
  const sessions: MateSessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const sessionId = entry.name.slice(0, -'.json'.length);
    try {
      const session = await readMateSession(userId, sessionId);
      if (session) sessions.push(session);
    } catch (error) {
      throw new Error('malformed CogSeed session');
    }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
