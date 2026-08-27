import { readJson, writeJson, genId12, nowIso } from '../../storage';
import { userAuthorizationFile } from '../../paths';
import type { AuthorizationGrant, AuthorizationPermission, AuthorizationResourceType, AuthorizationSubjectType } from './authorization-types';

interface AuthorizationDocument { schemaVersion: 1; grants: AuthorizationGrant[]; }

function validPermission(value: unknown): value is AuthorizationPermission {
  return value === 'metadata.read' || value === 'body.read' || value === 'search.read' || value === 'execute';
}

function normalizeGrant(value: unknown): AuthorizationGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.resourceId !== 'string' || typeof row.subjectId !== 'string'
    || !['agent', 'project', 'session'].includes(String(row.resourceType))
    || !['user', 'agent', 'session'].includes(String(row.subjectType))
    || !['active', 'revoked'].includes(String(row.status))
    || !Array.isArray(row.permissions) || !row.permissions.every(validPermission)
    || !Number.isSafeInteger(row.version) || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string') return null;
  return { ...row, permissions: [...new Set(row.permissions)] } as unknown as AuthorizationGrant;
}

export async function readGrants(userId: string): Promise<AuthorizationGrant[]> {
  try {
    const doc = await readJson<Partial<AuthorizationDocument>>(userAuthorizationFile(userId));
    if (!Array.isArray(doc.grants)) return [];
    return doc.grants.map(normalizeGrant).filter((grant): grant is AuthorizationGrant => !!grant);
  } catch { return []; }
}

export async function writeGrants(userId: string, grants: AuthorizationGrant[]): Promise<void> {
  await writeJson(userAuthorizationFile(userId), { schemaVersion: 1, grants });
}

export function createGrant(input: {
  resourceType: AuthorizationResourceType;
  resourceId: string;
  subjectType: AuthorizationSubjectType;
  subjectId: string;
  permissions: AuthorizationPermission[];
}): AuthorizationGrant {
  const timestamp = nowIso();
  return {
    id: `grant-${genId12()}`,
    ...input,
    permissions: [...new Set(input.permissions)],
    status: 'active',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
