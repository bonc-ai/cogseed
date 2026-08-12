import { safeId } from '../../storage';

export const SCHEDULER_LEASE_SCHEMA_VERSION = 1 as const;

export type SchedulerLeaseStatus = 'active' | 'released' | 'expired';

export interface SchedulerLeaseRecord {
  schemaVersion: typeof SCHEDULER_LEASE_SCHEMA_VERSION;
  userId: string;
  resourceId: string;
  scopeId: string;
  leaseId: string;
  holderId: string;
  generation: number;
  status: SchedulerLeaseStatus;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
  releasedAt?: number;
  expiredAt?: number;
}

export interface SchedulerLeaseState {
  schemaVersion: typeof SCHEDULER_LEASE_SCHEMA_VERSION;
  leases: Record<string, SchedulerLeaseRecord>;
}

export interface SchedulerLeaseAcquireInput {
  userId: string;
  resourceId: string;
  scopeId: string;
  leaseId: string;
  holderId: string;
  generation: number;
  now: number;
  ttlMs: number;
}

export interface SchedulerLeaseRenewInput {
  userId: string;
  resourceId: string;
  leaseId: string;
  holderId: string;
  generation: number;
  now: number;
  ttlMs: number;
}

export interface SchedulerLeaseTokenInput {
  userId: string;
  resourceId: string;
  leaseId: string;
  holderId: string;
  generation: number;
  now: number;
}

export type SchedulerLeaseAcquireResult =
  | { state: SchedulerLeaseState; acquired: true; lease: SchedulerLeaseRecord }
  | { state: SchedulerLeaseState; acquired: false; reason: 'already_held' | 'busy'; lease: SchedulerLeaseRecord };

export type SchedulerLeaseRenewResult =
  | { state: SchedulerLeaseState; renewed: true; lease: SchedulerLeaseRecord }
  | { state: SchedulerLeaseState; renewed: false; reason: 'not_found' | 'expired' | 'not_active'; lease?: SchedulerLeaseRecord };

export type SchedulerLeaseReleaseResult =
  | { state: SchedulerLeaseState; released: true; lease: SchedulerLeaseRecord }
  | { state: SchedulerLeaseState; released: false; reason: 'not_active'; lease: SchedulerLeaseRecord };

function assertSafeId(value: unknown, label: string): string {
  if (!safeId(value)) throw new Error(`invalid scheduler lease ${label}`);
  return value as string;
}

function assertPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`invalid scheduler lease ${label}`);
  return value as number;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid scheduler lease ${label}`);
  return value as number;
}

function assertTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid scheduler lease ${label}`);
  return value as number;
}

function assertTtl(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid scheduler lease ttl');
  return value as number;
}

function cloneLease(lease: SchedulerLeaseRecord): SchedulerLeaseRecord {
  return { ...lease };
}

function assertLease(lease: SchedulerLeaseRecord): void {
  if (!lease || lease.schemaVersion !== SCHEDULER_LEASE_SCHEMA_VERSION) throw new Error('malformed scheduler lease');
  assertSafeId(lease.userId, 'user id');
  assertSafeId(lease.resourceId, 'resource id');
  assertSafeId(lease.scopeId, 'scope id');
  assertSafeId(lease.leaseId, 'lease id');
  assertSafeId(lease.holderId, 'holder id');
  assertPositiveInteger(lease.generation, 'generation');
  if (!['active', 'released', 'expired'].includes(lease.status)) throw new Error('invalid scheduler lease status');
  assertTime(lease.acquiredAt, 'acquired time');
  assertTime(lease.renewedAt, 'renewed time');
  assertTime(lease.expiresAt, 'expiry time');
  if (lease.releasedAt !== undefined) assertTime(lease.releasedAt, 'release time');
  if (lease.expiredAt !== undefined) assertTime(lease.expiredAt, 'expired time');
  if (lease.expiresAt <= lease.acquiredAt) throw new Error('malformed scheduler lease expiry');
}

function assertState(state: SchedulerLeaseState): void {
  if (!state || state.schemaVersion !== SCHEDULER_LEASE_SCHEMA_VERSION) throw new Error('malformed scheduler lease state');
  if (!state.leases || typeof state.leases !== 'object' || Array.isArray(state.leases)) throw new Error('malformed scheduler leases');
  for (const lease of Object.values(state.leases)) assertLease(lease);
}

function cloneState(state: SchedulerLeaseState): SchedulerLeaseState {
  assertState(state);
  const leases: Record<string, SchedulerLeaseRecord> = {};
  for (const [resourceId, lease] of Object.entries(state.leases)) leases[resourceId] = cloneLease(lease);
  return { schemaVersion: state.schemaVersion, leases };
}

function validateAcquireInput(input: SchedulerLeaseAcquireInput): SchedulerLeaseAcquireInput {
  return {
    userId: assertSafeId(input.userId, 'user id'),
    resourceId: assertSafeId(input.resourceId, 'resource id'),
    scopeId: assertSafeId(input.scopeId, 'scope id'),
    leaseId: assertSafeId(input.leaseId, 'lease id'),
    holderId: assertSafeId(input.holderId, 'holder id'),
    generation: assertPositiveInteger(input.generation, 'generation'),
    now: assertTime(input.now, 'time'),
    ttlMs: assertTtl(input.ttlMs),
  };
}

function validateRenewInput(input: SchedulerLeaseRenewInput): SchedulerLeaseRenewInput {
  return {
    userId: assertSafeId(input.userId, 'user id'),
    resourceId: assertSafeId(input.resourceId, 'resource id'),
    leaseId: assertSafeId(input.leaseId, 'lease id'),
    holderId: assertSafeId(input.holderId, 'holder id'),
    generation: assertPositiveInteger(input.generation, 'generation'),
    now: assertTime(input.now, 'time'),
    ttlMs: assertTtl(input.ttlMs),
  };
}

function validateTokenInput(input: SchedulerLeaseTokenInput): SchedulerLeaseTokenInput {
  return {
    userId: assertSafeId(input.userId, 'user id'),
    resourceId: assertSafeId(input.resourceId, 'resource id'),
    leaseId: assertSafeId(input.leaseId, 'lease id'),
    holderId: assertSafeId(input.holderId, 'holder id'),
    generation: assertNonNegativeInteger(input.generation, 'generation'),
    now: assertTime(input.now, 'time'),
  };
}

function assertLeaseIdentity(lease: SchedulerLeaseRecord, input: { userId: string; leaseId: string; holderId: string; generation: number }): void {
  if (lease.userId !== input.userId || lease.leaseId !== input.leaseId || lease.holderId !== input.holderId || lease.generation !== input.generation) {
    throw new Error('stale scheduler lease');
  }
}

export function createSchedulerLeaseState(): SchedulerLeaseState {
  return { schemaVersion: SCHEDULER_LEASE_SCHEMA_VERSION, leases: {} };
}

export function acquireSchedulerLease(state: SchedulerLeaseState, input: SchedulerLeaseAcquireInput): SchedulerLeaseAcquireResult {
  const next = cloneState(state);
  const normalized = validateAcquireInput(input);
  const prior = next.leases[normalized.resourceId];
  if (prior && prior.status === 'active' && normalized.now < prior.expiresAt) {
    if (prior.userId === normalized.userId && prior.scopeId === normalized.scopeId && prior.leaseId === normalized.leaseId && prior.holderId === normalized.holderId && prior.generation === normalized.generation) {
      return { state: next, acquired: false, reason: 'already_held', lease: cloneLease(prior) };
    }
    return { state: next, acquired: false, reason: 'busy', lease: cloneLease(prior) };
  }
  if (prior && prior.status === 'active') {
    prior.status = 'expired';
    prior.expiredAt = normalized.now;
  }
  const lease: SchedulerLeaseRecord = {
    schemaVersion: SCHEDULER_LEASE_SCHEMA_VERSION,
    userId: normalized.userId,
    resourceId: normalized.resourceId,
    scopeId: normalized.scopeId,
    leaseId: normalized.leaseId,
    holderId: normalized.holderId,
    generation: normalized.generation,
    status: 'active',
    acquiredAt: normalized.now,
    renewedAt: normalized.now,
    expiresAt: normalized.now + normalized.ttlMs,
  };
  next.leases[normalized.resourceId] = lease;
  return { state: next, acquired: true, lease: cloneLease(lease) };
}

export function renewSchedulerLease(state: SchedulerLeaseState, input: SchedulerLeaseRenewInput): SchedulerLeaseRenewResult {
  const next = cloneState(state);
  const normalized = validateRenewInput(input);
  const lease = next.leases[normalized.resourceId];
  if (!lease) return { state: next, renewed: false, reason: 'not_found' };
  assertLeaseIdentity(lease, normalized);
  if (lease.status !== 'active') return { state: next, renewed: false, reason: 'not_active', lease: cloneLease(lease) };
  if (normalized.now >= lease.expiresAt) {
    lease.status = 'expired';
    lease.expiredAt = normalized.now;
    return { state: next, renewed: false, reason: 'expired', lease: cloneLease(lease) };
  }
  lease.renewedAt = normalized.now;
  lease.expiresAt = normalized.now + normalized.ttlMs;
  return { state: next, renewed: true, lease: cloneLease(lease) };
}

export function expireSchedulerLeases(state: SchedulerLeaseState, input: { now: number }): { state: SchedulerLeaseState; expired: SchedulerLeaseRecord[] } {
  const next = cloneState(state);
  const now = assertTime(input.now, 'time');
  const expired: SchedulerLeaseRecord[] = [];
  for (const lease of Object.values(next.leases)) {
    if (lease.status === 'active' && now >= lease.expiresAt) {
      lease.status = 'expired';
      lease.expiredAt = now;
      expired.push(cloneLease(lease));
    }
  }
  expired.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  return { state: next, expired };
}

export function releaseSchedulerLease(state: SchedulerLeaseState, input: SchedulerLeaseTokenInput): SchedulerLeaseReleaseResult {
  const next = cloneState(state);
  const normalized = validateTokenInput(input);
  const lease = next.leases[normalized.resourceId];
  if (!lease) throw new Error('scheduler lease not found');
  assertLeaseIdentity(lease, normalized);
  if (lease.status !== 'active') return { state: next, released: false, reason: 'not_active', lease: cloneLease(lease) };
  lease.status = 'released';
  lease.releasedAt = normalized.now;
  return { state: next, released: true, lease: cloneLease(lease) };
}
