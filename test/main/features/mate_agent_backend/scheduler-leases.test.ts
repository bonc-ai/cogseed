import { describe, expect, it } from 'vitest';

import {
  acquireSchedulerLease,
  createSchedulerLeaseState,
  expireSchedulerLeases,
  releaseSchedulerLease,
  renewSchedulerLease,
} from '../../../../src/main/features/mate_agent_backend/scheduler-leases';

describe('Mate scheduler lease primitives', () => {
  it('acquires active leases idempotently and rejects competing holders before expiry', () => {
    let state = createSchedulerLeaseState();
    let acquire = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 100, ttlMs: 50 });
    expect(acquire.acquired).toBe(true);
    if (!acquire.acquired) throw new Error('expected lease');
    state = acquire.state;
    expect(acquire.lease).toMatchObject({ status: 'active', expiresAt: 150 });

    const repeated = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 120, ttlMs: 50 });
    expect(repeated).toMatchObject({ acquired: false, reason: 'already_held' });
    expect(repeated.lease?.expiresAt).toBe(150);

    const busy = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-b', holderId: 'worker-b', generation: 1, now: 130, ttlMs: 50 });
    expect(busy).toMatchObject({ acquired: false, reason: 'busy' });
  });

  it('renews, expires using explicit now/ttl, and lets a new generation acquire after expiry', () => {
    let state = createSchedulerLeaseState();
    const first = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 100, ttlMs: 50 });
    if (!first.acquired) throw new Error('expected lease');
    state = first.state;

    const renewed = renewSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 125, ttlMs: 100 });
    expect(renewed.renewed).toBe(true);
    if (!renewed.renewed) throw new Error('expected renew');
    state = renewed.state;
    expect(renewed.lease.expiresAt).toBe(225);

    const expired = expireSchedulerLeases(state, { now: 225 });
    expect(expired.expired.map((lease) => lease.resourceId)).toEqual(['sched-item-a']);
    state = expired.state;

    const second = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-b', holderId: 'worker-b', generation: 2, now: 226, ttlMs: 50 });
    expect(second.acquired).toBe(true);
    if (!second.acquired) throw new Error('expected new lease');
    expect(second.lease).toMatchObject({ leaseId: 'lease-b', holderId: 'worker-b', generation: 2, expiresAt: 276 });
  });

  it('releases only matching active leases and rejects stale tokens', () => {
    let state = createSchedulerLeaseState();
    const acquired = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 100, ttlMs: 50 });
    if (!acquired.acquired) throw new Error('expected lease');
    state = acquired.state;

    expect(() => releaseSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 0, now: 120 })).toThrow(/stale/i);

    const released = releaseSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 120 });
    expect(released.lease).toMatchObject({ status: 'released', releasedAt: 120 });
    state = released.state;

    const reacquired = acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-b', holderId: 'worker-b', generation: 2, now: 121, ttlMs: 50 });
    expect(reacquired.acquired).toBe(true);
  });

  it('validates ids, generation, ttl, and time inputs', () => {
    const state = createSchedulerLeaseState();
    expect(() => acquireSchedulerLease(state, { userId: 'bad/user', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 100, ttlMs: 50 })).toThrow(/invalid/i);
    expect(() => acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched item', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 100, ttlMs: 50 })).toThrow(/invalid/i);
    expect(() => acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 0, now: 100, ttlMs: 50 })).toThrow(/generation/i);
    expect(() => acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: 100, ttlMs: 0 })).toThrow(/ttl/i);
    expect(() => acquireSchedulerLease(state, { userId: 'user-a', resourceId: 'sched-item-a', scopeId: 'scope-a', leaseId: 'lease-a', holderId: 'worker-a', generation: 1, now: Number.NaN, ttlMs: 50 })).toThrow(/time/i);
  });
});
