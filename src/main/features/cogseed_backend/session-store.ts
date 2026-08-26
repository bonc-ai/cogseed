import * as fs from 'node:fs/promises';

import { genId12, nowIso, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import {
  assertCogSeedAgentId,
  assertCogSeedConversationId,
  assertCogSeedSessionId,
  assertCogSeedUserId,
  cogseedAgentSessionMappingFile,
  cogseedSessionFile,
  cogseedSessionsDirectory,
} from './paths';
import {
  buildCogSeedCommanderCompatibilityId,
  buildCogSeedCommanderSessionId,
  buildCogSeedMemberCompatibilityId,
  buildCogSeedMemberSessionId,
  hydrateCogSeedSessionRecord,
  resolveCogSeedSessionIdentity,
} from './actor-session-facade';
import {
  COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
  type CogSeedActorRecord,
  type CogSeedActorRole,
  type CogSeedCommanderSession,
  type CogSeedMemberSession,
  type CogSeedSessionRecord,
} from './types';

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

interface CogSeedAgentSessionMapping {
  schemaVersion: typeof COGSEED_AGENT_BACKEND_SCHEMA_VERSION;
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
): CogSeedAgentSessionMapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed Agent session mapping');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION
    || row.ownerId !== userId
    || row.conversationId !== conversationId
    || row.agentId !== agentId
    || typeof row.sessionId !== 'string'
    || typeof row.createdAt !== 'string') {
    throw new Error('malformed CogSeed Agent session mapping');
  }
  assertCogSeedSessionId(row.sessionId);
  return row as unknown as CogSeedAgentSessionMapping;
}

function validateActor(value: unknown): CogSeedActorRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed actor');
  const row = value as Record<string, unknown>;
  if (typeof row.actorId !== 'string' || typeof row.actorRole !== 'string' || typeof row.displayName !== 'string') {
    throw new Error('malformed CogSeed actor');
  }
  if (typeof row.sessionId !== 'string' || typeof row.lifecycleState !== 'string' || typeof row.joinedAt !== 'string') {
    throw new Error('malformed CogSeed actor');
  }
  resolveCogSeedSessionIdentity(row.sessionId);
  return row as unknown as CogSeedActorRecord;
}

function validateSession(userId: string, value: unknown, expectedSessionId?: string): CogSeedSessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed CogSeed session');
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== COGSEED_AGENT_BACKEND_SCHEMA_VERSION) throw new Error('unsupported CogSeed session schema');
  if (row.ownerId !== userId) throw new Error('CogSeed session owner mismatch');
  if (typeof row.sessionId !== 'string') throw new Error('malformed CogSeed session');
  const identity = resolveCogSeedSessionIdentity(row.compatibilitySessionId ? String(row.compatibilitySessionId) : row.sessionId);
  assertCogSeedSessionId(row.sessionId);
  if (row.sessionId !== identity.canonicalSessionId) throw new Error('CogSeed session canonical id mismatch');
  if (expectedSessionId && identity.canonicalSessionId !== resolveCogSeedSessionIdentity(expectedSessionId).canonicalSessionId) {
    throw new Error('CogSeed session id mismatch');
  }
  if (typeof row.runtimeSessionId !== 'string' || !row.runtimeSessionId.startsWith('mruntime-')) {
    throw new Error('malformed CogSeed session');
  }
  if (typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') throw new Error('malformed CogSeed session');
  if (row.conversationId !== undefined) assertCogSeedConversationId(String(row.conversationId));
  if (row.agentId !== undefined) assertCogSeedAgentId(String(row.agentId));
  if (row.activeTaskId !== undefined && (typeof row.activeTaskId !== 'string' || !row.activeTaskId.startsWith('cogseed-task-'))) {
    throw new Error('malformed CogSeed session');
  }
  const hydrated = hydrateCogSeedSessionRecord(row as unknown as CogSeedSessionRecord);
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
  return resolveCogSeedSessionIdentity(sessionId).canonicalSessionId;
}

function commanderInputToSessionId(conversationOrSessionId: string): string {
  if (conversationOrSessionId.startsWith('gconv-') || conversationOrSessionId.startsWith('cogseed-session-')) {
    const identity = resolveCogSeedSessionIdentity(conversationOrSessionId);
    if (identity.sessionKind !== 'commander') throw new Error('CogSeed commander session required');
    return identity.canonicalSessionId;
  }
  return buildCogSeedCommanderSessionId(conversationOrSessionId);
}

async function writeSession(userId: string, record: CogSeedSessionRecord): Promise<CogSeedSessionRecord> {
  await writeJson(cogseedSessionFile(userId, record.sessionId), record);
  return record;
}

async function updateCogSeedSession(
  userId: string,
  sessionId: string,
  mutate: (current: CogSeedSessionRecord) => CogSeedSessionRecord | Promise<CogSeedSessionRecord>,
): Promise<CogSeedSessionRecord> {
  assertCogSeedUserId(userId);
  const canonicalSessionId = normalizeSessionId(sessionId);
  const file = cogseedSessionFile(userId, canonicalSessionId);
  return fileEditLock(file).runExclusive(async () => {
    const current = await readCogSeedSession(userId, canonicalSessionId);
    if (!current) throw new Error('CogSeed session not found');
    const next = hydrateCogSeedSessionRecord(await mutate(current));
    const validated = validateSession(userId, next, canonicalSessionId);
    return writeSession(userId, { ...validated, updatedAt: nowIso() });
  });
}

export async function readCogSeedSession(userId: string, sessionId: string): Promise<CogSeedSessionRecord | null> {
  assertCogSeedUserId(userId);
  const canonicalSessionId = normalizeSessionId(sessionId);
  try {
    const text = await fs.readFile(cogseedSessionFile(userId, canonicalSessionId), 'utf8');
    return validateSession(userId, JSON.parse(text), canonicalSessionId);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof SyntaxError) throw new Error('malformed CogSeed session');
    throw error;
  }
}

export async function getOrCreateCogSeedSession(userId: string, sessionId?: string): Promise<CogSeedSessionRecord> {
  assertCogSeedUserId(userId);
  const identity = sessionId
    ? resolveCogSeedSessionIdentity(sessionId)
    : {
        externalSessionId: '',
        canonicalSessionId: `cogseed-session-${genId12()}`,
        sessionKind: 'generic' as const,
        actorRole: 'commander' as const,
      };
  const targetSessionId = assertCogSeedSessionId(identity.canonicalSessionId);
  const file = cogseedSessionFile(userId, targetSessionId);
  return fileEditLock(file).runExclusive(async () => {
    const existing = await readCogSeedSession(userId, targetSessionId);
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
    const record: CogSeedSessionRecord = {
      schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
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
            commanderSessionId: buildCogSeedCommanderSessionId(identity.conversationId!),
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

export async function getOrCreateCogSeedCommanderSession(userId: string, conversationId: string): Promise<CogSeedCommanderSession> {
  const session = await getOrCreateCogSeedSession(userId, buildCogSeedCommanderCompatibilityId(conversationId));
  if (session.sessionKind !== 'commander') throw new Error('CogSeed commander session required');
  return session as CogSeedCommanderSession;
}

export async function getOrCreateCogSeedMemberSession(
  userId: string,
  conversationId: string,
  actorId: string,
  displayName = actorId,
  actorRole: Exclude<CogSeedActorRole, 'commander'> = 'member',
): Promise<CogSeedMemberSession> {
  const externalSessionId = buildCogSeedMemberCompatibilityId(conversationId, actorId);
  const session = await getOrCreateCogSeedSession(userId, externalSessionId);
  const commanderSessionId = buildCogSeedCommanderSessionId(conversationId);
  const updated = await updateCogSeedSession(userId, session.sessionId, (current) => ({
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
  return updated as CogSeedMemberSession;
}

/** Durable formal-Agent lookup keyed only by the user-scoped conversation and
 * Agent identity. The deterministic member id is the persisted source of
 * truth; no module-level cache participates in session reuse. */
export async function getOrCreateCogSeedAgentSession(
  userId: string,
  conversationId: string,
  agentId: string,
  displayName = agentId,
): Promise<CogSeedMemberSession> {
  assertCogSeedUserId(userId);
  const safeConversationId = assertCogSeedConversationId(conversationId);
  const safeAgentId = assertCogSeedAgentId(agentId);
  const mappingFile = cogseedAgentSessionMappingFile(userId, safeConversationId, safeAgentId);
  return fileEditLock(mappingFile).runExclusive(async () => {
    try {
      const mapping = validateAgentSessionMapping(
        userId,
        safeConversationId,
        safeAgentId,
        JSON.parse(await fs.readFile(mappingFile, 'utf8')),
      );
      const existing = await readCogSeedSession(userId, mapping.sessionId);
      if (!existing || existing.sessionKind !== 'member'
        || existing.conversationId !== safeConversationId
        || existing.agentId !== safeAgentId
        || existing.actorId !== safeAgentId) {
        throw new Error('CogSeed Agent session mapping references an invalid session');
      }
      return existing as CogSeedMemberSession;
    } catch (error) {
      if (!isEnoent(error)) {
        if (error instanceof SyntaxError) throw new Error('malformed CogSeed Agent session mapping');
        throw error;
      }
    }

    const reusable = (await listCogSeedSessions(userId)).find((session) => (
      session.sessionKind === 'member'
      && session.conversationId === safeConversationId
      && session.agentId === safeAgentId
      && session.actorId === safeAgentId
    ));
    let session: CogSeedMemberSession;
    if (reusable) {
      session = reusable as CogSeedMemberSession;
    } else {
      const createdAt = nowIso();
      session = await writeSession(userId, {
        schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
        sessionId: `cogseed-session-agent-${genId12()}`,
        runtimeSessionId: `mruntime-${genId12()}`,
        ownerId: userId,
        createdAt,
        updatedAt: createdAt,
        sessionKind: 'member',
        actorRole: 'member',
        actorId: safeAgentId,
        agentId: safeAgentId,
        conversationId: safeConversationId,
        commanderSessionId: buildCogSeedCommanderSessionId(safeConversationId),
        displayName: displayName.trim() || safeAgentId,
        lifecycleState: 'active',
        joinedAt: createdAt,
      }) as CogSeedMemberSession;
    }
    const mapping: CogSeedAgentSessionMapping = {
      schemaVersion: COGSEED_AGENT_BACKEND_SCHEMA_VERSION,
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

export async function readCogSeedCommanderSession(userId: string, conversationOrSessionId: string): Promise<CogSeedCommanderSession | null> {
  const session = await readCogSeedSession(userId, commanderInputToSessionId(conversationOrSessionId));
  if (!session) return null;
  if (session.sessionKind !== 'commander') throw new Error('CogSeed commander session required');
  return session as CogSeedCommanderSession;
}

export async function readCogSeedRoster(userId: string, conversationOrSessionId: string): Promise<CogSeedActorRecord[]> {
  const session = await readCogSeedCommanderSession(userId, conversationOrSessionId);
  return session?.roster || [];
}

export async function setCogSeedSessionActiveTask(
  userId: string,
  sessionId: string,
  taskId: string,
): Promise<CogSeedSessionRecord> {
  if (!taskId.startsWith('cogseed-task-')) throw new Error('invalid CogSeed task id');
  return updateCogSeedSession(userId, sessionId, (current) => ({ ...current, activeTaskId: taskId }));
}

export async function setCogSeedSessionDisplayName(
  userId: string,
  sessionId: string,
  displayName: string,
): Promise<CogSeedSessionRecord> {
  const normalized = String(displayName || '').trim().slice(0, 160);
  const current = await readCogSeedSession(userId, sessionId);
  if (!current) throw new Error('CogSeed session not found');
  if (!normalized || current.displayName === normalized) return current;
  return updateCogSeedSession(userId, sessionId, (session) => ({ ...session, displayName: normalized }));
}

export async function joinCogSeedMember(
  userId: string,
  conversationId: string,
  actorId: string,
  displayName = actorId,
  actorRole: Exclude<CogSeedActorRole, 'commander'> = 'member',
): Promise<CogSeedMemberSession> {
  const commander = await getOrCreateCogSeedCommanderSession(userId, conversationId);
  const member = await getOrCreateCogSeedMemberSession(userId, conversationId, actorId, displayName, actorRole);
  const joinedAt = nowIso();
  const actor: CogSeedActorRecord = {
    actorId: member.actorId!,
    actorRole: member.actorRole,
    displayName: member.displayName!,
    sessionId: member.sessionId,
    lifecycleState: 'active',
    joinedAt,
  };
  await updateCogSeedSession(userId, commander.sessionId, (current) => ({
    ...current,
    roster: [
      ...(current.roster || []).filter((entry) => entry.actorId !== actor.actorId),
      actor,
    ],
  }));
  return (await readCogSeedSession(userId, member.sessionId)) as CogSeedMemberSession;
}

export async function leaveCogSeedMember(userId: string, conversationOrSessionId: string, actorId: string): Promise<CogSeedMemberSession> {
  const commander = await readCogSeedCommanderSession(userId, conversationOrSessionId);
  if (!commander?.conversationId) throw new Error('CogSeed commander session not found');
  const member = await readCogSeedSession(userId, buildCogSeedMemberSessionId(commander.conversationId, actorId));
  if (!member || member.sessionKind !== 'member') throw new Error('CogSeed member session not found');
  const leftAt = nowIso();
  const updated = await updateCogSeedSession(userId, member.sessionId, (current) => ({ ...current, lifecycleState: 'left', leftAt }));
  await updateCogSeedSession(userId, commander.sessionId, (current) => ({
    ...current,
    roster: (current.roster || []).filter((entry) => entry.actorId !== actorId),
  }));
  return updated as CogSeedMemberSession;
}

export async function renameCogSeedMember(
  userId: string,
  conversationOrSessionId: string,
  actorId: string,
  displayName: string,
): Promise<CogSeedMemberSession> {
  const trimmed = displayName.trim();
  if (!trimmed) throw new Error('CogSeed member display name is required');
  const commander = await readCogSeedCommanderSession(userId, conversationOrSessionId);
  if (!commander?.conversationId) throw new Error('CogSeed commander session not found');
  const member = await readCogSeedSession(userId, buildCogSeedMemberSessionId(commander.conversationId, actorId));
  if (!member || member.sessionKind !== 'member') throw new Error('CogSeed member session not found');
  const updated = await updateCogSeedSession(userId, member.sessionId, (current) => ({ ...current, displayName: trimmed }));
  await updateCogSeedSession(userId, commander.sessionId, (current) => ({
    ...current,
    roster: (current.roster || []).map((entry) => entry.actorId === actorId ? { ...entry, displayName: trimmed } : entry),
  }));
  return updated as CogSeedMemberSession;
}

export async function listCogSeedSessions(userId: string): Promise<CogSeedSessionRecord[]> {
  assertCogSeedUserId(userId);
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(cogseedSessionsDirectory(userId), { withFileTypes: true }); }
  catch (error) { if (isEnoent(error)) return []; throw error; }
  const sessions: CogSeedSessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const sessionId = entry.name.slice(0, -'.json'.length);
    try {
      const session = await readCogSeedSession(userId, sessionId);
      if (session) sessions.push(session);
    } catch (error) {
      throw new Error('malformed CogSeed session');
    }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
