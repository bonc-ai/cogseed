import { genId12, nowIso } from '../../storage';
import { createGrant, readGrants, writeGrants } from './authorization-store';
import { AuthorizationError, type AuthorizationCheckInput, type AuthorizationDecision, type AuthorizationGrant, type AuthorizationLease, type AuthorizationPermission, type AuthorizationResourceType, type AuthorizationState, type AuthorizationSubjectType } from './authorization-types';

const activeLeases = new Map<string, AuthorizationLease>();
const revokedResources = new Map<string, Set<AbortController>>();
const resourceKey = (userId: string, type: AuthorizationResourceType, id: string) => `${userId}:${type}:${id}`;

function isCurrent(grant: AuthorizationGrant): boolean {
  return grant.status === 'active';
}

function matchingGrant(grants: AuthorizationGrant[], input: AuthorizationCheckInput): AuthorizationGrant | undefined {
  const exact = grants.find((grant) => grant.resourceType === input.resourceType && grant.resourceId === input.resourceId
    && grant.subjectType === input.subjectType && grant.subjectId === input.subjectId && isCurrent(grant));
  if (exact?.permissions.includes(input.permission)) return exact;
  if (input.resourceType === 'session' && input.parentProjectId) {
    const inherited = grants.find((grant) => grant.resourceType === 'project' && grant.resourceId === input.parentProjectId
      && grant.subjectType === input.subjectType && grant.subjectId === input.subjectId && isCurrent(grant));
    if (inherited?.permissions.includes(input.permission)) return inherited;
  }
  if (input.resourceType === 'session' && input.parentAgentId) {
    const inherited = grants.find((grant) => grant.resourceType === 'agent' && grant.resourceId === input.parentAgentId
      && grant.subjectType === input.subjectType && grant.subjectId === input.subjectId && isCurrent(grant));
    if (inherited?.permissions.includes(input.permission)) return inherited;
  }
  return undefined;
}

export async function decide(input: AuthorizationCheckInput): Promise<AuthorizationDecision> {
  if (input.subjectType === 'user' && input.subjectId === input.userId) {
    return { allowed: true, reason: 'user-owner', version: 0 };
  }
  const grants = await readGrants(input.userId);
  const grant = matchingGrant(grants, input);
  if (grant) return { allowed: true, reason: 'grant', grantId: grant.id, version: grant.version };
  const prior = grants.find((item) => item.resourceType === input.resourceType && item.resourceId === input.resourceId
    && item.subjectType === input.subjectType && item.subjectId === input.subjectId);
  if (prior?.status === 'revoked') return { allowed: false, reason: 'revoked', grantId: prior.id, version: prior.version };
  return { allowed: false, reason: 'missing-grant', version: 0 };
}

export async function state(input: AuthorizationCheckInput): Promise<AuthorizationState> {
  const grants = await readGrants(input.userId);
  const decision = await decide(input);
  return {
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    grants: grants.filter((grant) => (grant.resourceType === input.resourceType && grant.resourceId === input.resourceId)
      || (input.resourceType === 'session' && input.parentProjectId && grant.resourceType === 'project' && grant.resourceId === input.parentProjectId)
      || (input.resourceType === 'session' && input.parentAgentId && grant.resourceType === 'agent' && grant.resourceId === input.parentAgentId)),
    subject: { type: input.subjectType, id: input.subjectId },
    decision,
    authorizationState: decision.allowed ? 'authorized' : (decision.reason === 'revoked' ? 'revoked' : 'metadata_only'),
    requiredPermission: input.permission,
  };
}

export async function grant(userId: string, input: Omit<AuthorizationCheckInput, 'userId' | 'permission'> & { permissions: AuthorizationPermission[] }): Promise<AuthorizationGrant> {
  const grants = await readGrants(userId);
  const existing = grants.find((item) => item.resourceType === input.resourceType && item.resourceId === input.resourceId
    && item.subjectType === input.subjectType && item.subjectId === input.subjectId);
  const timestamp = nowIso();
  const next = existing
    ? { ...existing, permissions: [...new Set(input.permissions)], status: 'active' as const, version: existing.version + 1, updatedAt: timestamp, revokedAt: undefined }
    : createGrant(input);
  await writeGrants(userId, [...grants.filter((item) => item.id !== existing?.id), next]);
  return next;
}

export async function revoke(userId: string, input: Omit<AuthorizationCheckInput, 'userId' | 'permission'>): Promise<AuthorizationGrant | null> {
  const grants = await readGrants(userId);
  const existing = grants.find((item) => item.resourceType === input.resourceType && item.resourceId === input.resourceId
    && item.subjectType === input.subjectType && item.subjectId === input.subjectId);
  if (!existing) return null;
  const updated = { ...existing, status: 'revoked' as const, version: existing.version + 1, updatedAt: nowIso(), revokedAt: nowIso() };
  await writeGrants(userId, grants.map((item) => item.id === existing.id ? updated : item));
  revokedResources.get(resourceKey(userId, input.resourceType, input.resourceId))?.forEach((controller) => controller.abort());
  return updated;
}

export async function acquireReadLease(input: AuthorizationCheckInput, controller?: AbortController): Promise<AuthorizationLease> {
  const decision = await decide(input);
  if (!decision.allowed) {
    const code = decision.reason === 'revoked' ? 'AUTHORIZATION_REVOKED' : 'AUTHORIZATION_REQUIRED';
    throw new AuthorizationError({ code, message: `authorization required for ${input.permission}` });
  }
  const lease: AuthorizationLease = { key: `lease-${genId12()}`, ...input, grantId: decision.grantId, version: decision.version };
  activeLeases.set(lease.key, lease);
  if (controller) {
    const key = resourceKey(input.userId, input.resourceType, input.resourceId);
    if (!revokedResources.has(key)) revokedResources.set(key, new Set());
    revokedResources.get(key)!.add(controller);
  }
  return lease;
}

export async function assertLeaseStillValid(lease: AuthorizationLease): Promise<void> {
  const decision = await decide(lease);
  activeLeases.delete(lease.key);
  if (!decision.allowed || decision.version !== lease.version) {
    throw new AuthorizationError({
      code: decision.reason === 'revoked' ? 'AUTHORIZATION_REVOKED' : 'AUTHORIZATION_REQUIRED',
      message: 'authorization changed while reading',
    });
  }
}
