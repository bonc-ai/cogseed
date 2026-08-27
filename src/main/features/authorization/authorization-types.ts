export const AUTHORIZATION_PERMISSIONS = ['metadata.read', 'body.read', 'search.read', 'execute'] as const;
export type AuthorizationPermission = (typeof AUTHORIZATION_PERMISSIONS)[number];
export const AUTHORIZATION_RESOURCE_TYPES = ['agent', 'project', 'session'] as const;
export type AuthorizationResourceType = (typeof AUTHORIZATION_RESOURCE_TYPES)[number];
export const AUTHORIZATION_SUBJECT_TYPES = ['user', 'agent', 'session'] as const;
export type AuthorizationSubjectType = (typeof AUTHORIZATION_SUBJECT_TYPES)[number];
export type AuthorizationStatus = 'active' | 'revoked' | 'expired';

export interface AuthorizationGrant {
  id: string;
  resourceType: AuthorizationResourceType;
  resourceId: string;
  subjectType: AuthorizationSubjectType;
  subjectId: string;
  permissions: AuthorizationPermission[];
  status: AuthorizationStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  expiresAt?: string;
}

export interface AuthorizationCheckInput {
  userId: string;
  resourceType: AuthorizationResourceType;
  resourceId: string;
  subjectType: AuthorizationSubjectType;
  subjectId: string;
  permission: AuthorizationPermission;
  parentProjectId?: string | null;
  parentAgentId?: string | null;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: 'user-owner' | 'grant' | 'missing-grant' | 'revoked' | 'expired';
  grantId?: string;
  version: number;
}

export interface AuthorizationState {
  resourceType: AuthorizationResourceType;
  resourceId: string;
  grants: AuthorizationGrant[];
  subject?: { type: AuthorizationSubjectType; id: string };
  decision: AuthorizationDecision;
  authorizationState: 'authorized' | 'metadata_only' | 'revoked';
  requiredPermission: AuthorizationPermission;
}

export interface AuthorizationLease {
  key: string;
  userId: string;
  grantId?: string;
  version: number;
  resourceType: AuthorizationResourceType;
  resourceId: string;
  subjectType: AuthorizationSubjectType;
  subjectId: string;
  permission: AuthorizationPermission;
}

export class AuthorizationError extends Error {
  readonly code: 'AUTHORIZATION_REQUIRED' | 'AUTHORIZATION_REVOKED' | 'AUTHORIZATION_EXPIRED';
  constructor(input: { code: AuthorizationError['code']; message?: string }) {
    super(input.message || input.code);
    this.name = 'AuthorizationError';
    this.code = input.code;
  }
}
