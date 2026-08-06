/**
 * Pure visibility primitives for Mate collaboration records.
 *
 * This module intentionally owns small, stable DTOs instead of importing the
 * canonical actor/session model. Phase 1 and later adapters can translate
 * their domain objects into these DTOs without coupling this policy to their
 * storage or lifecycle implementations.
 */

export const VISIBILITY_ROLES = [
  'user',
  'commander',
  'member',
  'agent',
  'worker',
  'system',
] as const;

export type VisibilityRole = (typeof VISIBILITY_ROLES)[number];

export const VISIBILITY_KINDS = [
  'message',
  'state',
  'secret',
  'path',
  'tool',
  'artifact',
  'gate',
  'conflict',
] as const;

export type VisibilityKind = (typeof VISIBILITY_KINDS)[number] | (string & {});

export type VisibilityScope =
  | { kind: 'user'; userId: string }
  | { kind: 'actor'; actorId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'unknown' };

export type VisibilityScopeInput =
  | VisibilityScope
  | { kind: 'user'; userId?: string }
  | { kind: 'actor'; actorId?: string }
  | { kind: 'session'; sessionId?: string }
  | { kind: 'task'; taskId?: string }
  | { kind: 'workflow'; workflowId?: string }
  | null
  | undefined;

export interface VisibilityPrincipal {
  userId: string;
  role?: VisibilityRole;
  actorId?: string;
  sessionId?: string;
  taskId?: string;
  workflowId?: string;
}

export interface VisibilitySubject {
  ownerUserId: string;
  scope: VisibilityScopeInput;
  kind: VisibilityKind;
  allowedRoles?: readonly VisibilityRole[];
  allowedUserIds?: readonly string[];
  allowedActorIds?: readonly string[];
  allowedSessionIds?: readonly string[];
  allowedTaskIds?: readonly string[];
  allowedWorkflowIds?: readonly string[];
}

export type VisibilityDecisionReason =
  | 'allow.user-scope'
  | 'allow.commander-scope'
  | 'allow.actor-scope'
  | 'allow.session-scope'
  | 'allow.task-scope'
  | 'allow.workflow-scope'
  | 'allow.explicit-role'
  | 'allow.explicit-user'
  | 'allow.explicit-actor'
  | 'allow.explicit-session'
  | 'allow.explicit-task'
  | 'allow.explicit-workflow'
  | 'deny.invalid-principal'
  | 'deny.invalid-subject'
  | 'deny.cross-user'
  | 'deny.unknown-scope'
  | 'deny.missing-scope-identity'
  | 'deny.sensitive-default';

export interface VisibilityDecision {
  allowed: boolean;
  reason: VisibilityDecisionReason;
}

export const DEFAULT_DENY_KINDS: ReadonlySet<string> = new Set([
  'secret',
  'path',
  'tool',
  'artifact',
  'gate',
  'conflict',
]);

function isDefaultDeniedKind(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  if (DEFAULT_DENY_KINDS.has(normalized)) return true;
  const category = normalized.split(/[.:/_-]/, 1)[0];
  return DEFAULT_DENY_KINDS.has(category);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function includesValue(values: readonly string[] | undefined, value: string | undefined): boolean {
  return value !== undefined && values?.includes(value) === true;
}

function includesRole(values: readonly VisibilityRole[] | undefined, role: VisibilityRole | undefined): boolean {
  return role !== undefined && values?.includes(role) === true;
}

export function normalizeVisibilityScope(scope: VisibilityScopeInput): VisibilityScope {
  if (!scope || typeof scope !== 'object' || typeof scope.kind !== 'string') {
    return { kind: 'unknown' };
  }

  switch (scope.kind) {
    case 'user':
      return nonEmptyString(scope.userId) ? { kind: 'user', userId: scope.userId } : { kind: 'unknown' };
    case 'actor':
      return nonEmptyString(scope.actorId) ? { kind: 'actor', actorId: scope.actorId } : { kind: 'unknown' };
    case 'session':
      return nonEmptyString(scope.sessionId) ? { kind: 'session', sessionId: scope.sessionId } : { kind: 'unknown' };
    case 'task':
      return nonEmptyString(scope.taskId) ? { kind: 'task', taskId: scope.taskId } : { kind: 'unknown' };
    case 'workflow':
      return nonEmptyString(scope.workflowId) ? { kind: 'workflow', workflowId: scope.workflowId } : { kind: 'unknown' };
    default:
      return { kind: 'unknown' };
  }
}

function explicitDecision(principal: VisibilityPrincipal, subject: VisibilitySubject): VisibilityDecision | null {
  if (includesRole(subject.allowedRoles, principal.role)) {
    return { allowed: true, reason: 'allow.explicit-role' };
  }
  if (includesValue(subject.allowedUserIds, principal.userId)) {
    return { allowed: true, reason: 'allow.explicit-user' };
  }
  if (includesValue(subject.allowedActorIds, principal.actorId)) {
    return { allowed: true, reason: 'allow.explicit-actor' };
  }
  if (includesValue(subject.allowedSessionIds, principal.sessionId)) {
    return { allowed: true, reason: 'allow.explicit-session' };
  }
  if (includesValue(subject.allowedTaskIds, principal.taskId)) {
    return { allowed: true, reason: 'allow.explicit-task' };
  }
  if (includesValue(subject.allowedWorkflowIds, principal.workflowId)) {
    return { allowed: true, reason: 'allow.explicit-workflow' };
  }
  return null;
}

export function decideVisibility(
  principal: VisibilityPrincipal | null | undefined,
  subject: VisibilitySubject | null | undefined,
): VisibilityDecision {
  if (!principal || !nonEmptyString(principal.userId)) {
    return { allowed: false, reason: 'deny.invalid-principal' };
  }
  if (!subject || !nonEmptyString(subject.ownerUserId) || !nonEmptyString(subject.kind)) {
    return { allowed: false, reason: 'deny.invalid-subject' };
  }
  if (principal.userId !== subject.ownerUserId) {
    return { allowed: false, reason: 'deny.cross-user' };
  }

  const explicit = explicitDecision(principal, subject);
  if (explicit) return explicit;

  if (isDefaultDeniedKind(subject.kind)) {
    return { allowed: false, reason: 'deny.sensitive-default' };
  }

  const scope = normalizeVisibilityScope(subject.scope);
  switch (scope.kind) {
    case 'user':
      return scope.userId === principal.userId
        ? { allowed: true, reason: 'allow.user-scope' }
        : { allowed: false, reason: 'deny.cross-user' };
    case 'actor':
      if (principal.role === 'commander') {
        return { allowed: true, reason: 'allow.commander-scope' };
      }
      return principal.actorId === scope.actorId
        ? { allowed: true, reason: 'allow.actor-scope' }
        : { allowed: false, reason: 'deny.unknown-scope' };
    case 'session':
      return principal.sessionId === scope.sessionId
        ? { allowed: true, reason: 'allow.session-scope' }
        : { allowed: false, reason: 'deny.unknown-scope' };
    case 'task':
      if (principal.role === 'commander') {
        return { allowed: true, reason: 'allow.commander-scope' };
      }
      return principal.taskId === scope.taskId
        ? { allowed: true, reason: 'allow.task-scope' }
        : { allowed: false, reason: 'deny.unknown-scope' };
    case 'workflow':
      if (principal.role === 'commander') {
        return { allowed: true, reason: 'allow.commander-scope' };
      }
      return principal.workflowId === scope.workflowId
        ? { allowed: true, reason: 'allow.workflow-scope' }
        : { allowed: false, reason: 'deny.unknown-scope' };
    case 'unknown':
      return { allowed: false, reason: 'deny.unknown-scope' };
  }
}

export function canSeeVisibility(
  principal: VisibilityPrincipal | null | undefined,
  subject: VisibilitySubject | null | undefined,
): boolean {
  return decideVisibility(principal, subject).allowed;
}
