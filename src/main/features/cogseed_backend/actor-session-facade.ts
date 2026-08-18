import { safeId } from '../../storage';
import type {
  CogSeedActorRole,
  CogSeedMemberSession,
  CogSeedSessionKind,
  CogSeedSessionLineage,
  CogSeedSessionRecord,
} from './types';

export interface CogSeedSessionIdentity {
  externalSessionId: string;
  canonicalSessionId: string;
  sessionKind: CogSeedSessionKind;
  actorRole: CogSeedActorRole;
  actorId?: string;
  conversationId?: string;
}

function assertSafePart(value: string, label: string): string {
  if (!safeId(value)) throw new Error(`invalid CogSeed ${label}`);
  return value;
}

export function buildCogSeedCommanderSessionId(conversationId: string): string {
  return `cogseed-session-gconv-${assertSafePart(conversationId, 'conversation id')}`;
}

export function buildCogSeedMemberSessionId(conversationId: string, actorId: string): string {
  return `cogseed-session-gmember-${assertSafePart(conversationId, 'conversation id')}-${assertSafePart(actorId, 'actor id')}`;
}

export function buildCogSeedCommanderCompatibilityId(conversationId: string): string {
  return `gconv-${assertSafePart(conversationId, 'conversation id')}`;
}

export function buildCogSeedMemberCompatibilityId(conversationId: string, actorId: string): string {
  return `gmember-${assertSafePart(conversationId, 'conversation id')}-${assertSafePart(actorId, 'actor id')}`;
}

function parseMemberAlias(sessionId: string): { conversationId: string; actorId: string } {
  const tail = sessionId.slice('gmember-'.length);
  const separator = tail.lastIndexOf('-');
  if (separator <= 0 || separator === tail.length - 1) throw new Error('invalid CogSeed gmember session id');
  const conversationId = tail.slice(0, separator);
  const actorId = tail.slice(separator + 1);
  assertSafePart(conversationId, 'conversation id');
  assertSafePart(actorId, 'actor id');
  return { conversationId, actorId };
}

function parseCanonicalMember(sessionId: string): { conversationId: string; actorId: string } {
  const alias = `gmember-${sessionId.slice('cogseed-session-gmember-'.length)}`;
  return parseMemberAlias(alias);
}

export function resolveCogSeedSessionIdentity(sessionId: string): CogSeedSessionIdentity {
  const externalSessionId = assertSafePart(String(sessionId || ''), 'session id');
  if (externalSessionId.startsWith('gconv-')) {
    const conversationId = assertSafePart(externalSessionId.slice('gconv-'.length), 'conversation id');
    if (!conversationId) throw new Error('invalid CogSeed gconv session id');
    return {
      externalSessionId,
      canonicalSessionId: buildCogSeedCommanderSessionId(conversationId),
      sessionKind: 'commander',
      actorRole: 'commander',
      actorId: 'commander',
      conversationId,
    };
  }
  if (externalSessionId.startsWith('gmember-')) {
    const { conversationId, actorId } = parseMemberAlias(externalSessionId);
    return {
      externalSessionId,
      canonicalSessionId: buildCogSeedMemberSessionId(conversationId, actorId),
      sessionKind: 'member',
      actorRole: 'member',
      actorId,
      conversationId,
    };
  }
  if (externalSessionId.startsWith('cogseed-session-gconv-')) {
    const conversationId = assertSafePart(externalSessionId.slice('cogseed-session-gconv-'.length), 'conversation id');
    if (!conversationId) throw new Error('invalid CogSeed commander session id');
    return {
      externalSessionId,
      canonicalSessionId: externalSessionId,
      sessionKind: 'commander',
      actorRole: 'commander',
      actorId: 'commander',
      conversationId,
    };
  }
  if (externalSessionId.startsWith('cogseed-session-gmember-')) {
    const { conversationId, actorId } = parseCanonicalMember(externalSessionId);
    return {
      externalSessionId,
      canonicalSessionId: externalSessionId,
      sessionKind: 'member',
      actorRole: 'member',
      actorId,
      conversationId,
    };
  }
  if (externalSessionId.startsWith('cogseed-session-')) {
    return {
      externalSessionId,
      canonicalSessionId: externalSessionId,
      sessionKind: 'generic',
      actorRole: 'commander',
    };
  }
  throw new Error('invalid CogSeed session id');
}

export function hydrateCogSeedSessionRecord(
  row: Partial<CogSeedSessionRecord> & Pick<CogSeedSessionRecord, 'sessionId' | 'runtimeSessionId' | 'ownerId' | 'createdAt' | 'updatedAt'>,
): CogSeedSessionRecord {
  const identity = resolveCogSeedSessionIdentity(row.compatibilitySessionId || row.sessionId);
  return {
    ...row,
    sessionId: row.sessionId || identity.canonicalSessionId,
    sessionKind: row.sessionKind || identity.sessionKind,
    actorRole: row.actorRole || identity.actorRole,
    ...(row.actorId || identity.actorId ? { actorId: row.actorId || identity.actorId } : {}),
    ...(row.conversationId || identity.conversationId ? { conversationId: row.conversationId || identity.conversationId } : {}),
    ...(row.agentId || (identity.sessionKind === 'member' ? row.actorId || identity.actorId : undefined)
      ? { agentId: row.agentId || row.actorId || identity.actorId }
      : {}),
    ...(row.compatibilitySessionId || identity.externalSessionId !== identity.canonicalSessionId
      ? { compatibilitySessionId: row.compatibilitySessionId || identity.externalSessionId }
      : {}),
    lifecycleState: row.lifecycleState || 'active',
    ...(row.roster ? { roster: row.roster } : identity.sessionKind === 'commander' ? { roster: [] } : {}),
  } as CogSeedSessionRecord;
}

export function taskLineageFromSession(
  session: Pick<CogSeedSessionRecord, 'sessionId' | 'lineage'>,
): CogSeedSessionLineage & { sessionId: string } {
  return { sessionId: session.sessionId, ...(session.lineage || {}) };
}

export function isCogSeedMemberSession(session: CogSeedSessionRecord): session is CogSeedMemberSession {
  return session.sessionKind === 'member' && typeof session.actorId === 'string' && typeof session.commanderSessionId === 'string';
}
