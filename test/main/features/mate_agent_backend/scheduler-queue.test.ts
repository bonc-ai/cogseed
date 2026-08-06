import { describe, expect, it } from 'vitest';

import {
  claimNextSchedulerItem,
  claimSchedulerItemById,
  completeSchedulerClaim,
  createSchedulerQueueState,
  enqueueSchedulerItem,
  listReadySchedulerQueueItems,
  releaseSchedulerClaim,
  type SchedulerQueueState,
} from '../../../../src/main/features/mate_agent_backend/scheduler-queue';

function enqueue(state: SchedulerQueueState, item: Parameters<typeof enqueueSchedulerItem>[1]): SchedulerQueueState {
  return enqueueSchedulerItem(state, item).state;
}

function claimNext(state: SchedulerQueueState, input: Parameters<typeof claimNextSchedulerItem>[1]) {
  const result = claimNextSchedulerItem(state, input);
  expect(result.claimed).toBe(true);
  if (!result.claimed) throw new Error('expected claim');
  return result;
}

describe('Mate scheduler queue primitives', () => {
  it('claims ready items by priority, then stable FIFO insertion order', () => {
    let state = createSchedulerQueueState();
    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-low', scopeId: 'scope-a', priority: 0, enqueuedAt: 10 });
    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-high-1', scopeId: 'scope-a', priority: 5, enqueuedAt: 20 });
    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-high-2', scopeId: 'scope-a', priority: 5, enqueuedAt: 20 });

    let claim = claimNext(state, { userId: 'user-a', claimId: 'claim-1', claimedBy: 'worker-a', now: 100 });
    expect(claim.item.itemId).toBe('sched-item-high-1');
    state = completeSchedulerClaim(claim.state, { userId: 'user-a', itemId: claim.item.itemId, claimId: 'claim-1', generation: claim.item.generation, status: 'completed', now: 110 }).state;

    claim = claimNext(state, { userId: 'user-a', claimId: 'claim-2', claimedBy: 'worker-a', now: 120 });
    expect(claim.item.itemId).toBe('sched-item-high-2');
    state = completeSchedulerClaim(claim.state, { userId: 'user-a', itemId: claim.item.itemId, claimId: 'claim-2', generation: claim.item.generation, status: 'completed', now: 130 }).state;

    claim = claimNext(state, { userId: 'user-a', claimId: 'claim-3', claimedBy: 'worker-a', now: 140 });
    expect(claim.item.itemId).toBe('sched-item-low');
  });

  it('keeps dependency-blocked items out of ready results until dependencies complete', () => {
    let state = createSchedulerQueueState();
    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-parent', scopeId: 'scope-a', priority: 0, enqueuedAt: 1 });
    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-child', scopeId: 'scope-a', priority: 100, enqueuedAt: 2, dependencies: ['sched-item-parent'] });

    expect(listReadySchedulerQueueItems(state, { userId: 'user-a' }).map((item) => item.itemId)).toEqual(['sched-item-parent']);

    const parent = claimNext(state, { userId: 'user-a', claimId: 'claim-parent', claimedBy: 'worker-a', now: 10 });
    state = completeSchedulerClaim(parent.state, { userId: 'user-a', itemId: 'sched-item-parent', claimId: 'claim-parent', generation: parent.item.generation, status: 'completed', now: 20 }).state;

    expect(listReadySchedulerQueueItems(state, { userId: 'user-a' }).map((item) => item.itemId)).toEqual(['sched-item-child']);
    const child = claimNext(state, { userId: 'user-a', claimId: 'claim-child', claimedBy: 'worker-a', now: 30 });
    expect(child.item).toMatchObject({ itemId: 'sched-item-child', generation: 1, status: 'claimed' });
  });

  it('claims by id idempotently and increments generation only after a released claim is reclaimed', () => {
    let state = createSchedulerQueueState();
    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-1', scopeId: 'scope-a', priority: 1, enqueuedAt: 1 });

    let result = claimSchedulerItemById(state, { userId: 'user-a', itemId: 'sched-item-1', claimId: 'claim-a', claimedBy: 'worker-a', now: 10 });
    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('expected claim');
    state = result.state;
    expect(result.item.generation).toBe(1);

    const repeated = claimSchedulerItemById(state, { userId: 'user-a', itemId: 'sched-item-1', claimId: 'claim-a', claimedBy: 'worker-a', now: 11 });
    expect(repeated).toMatchObject({ claimed: false, reason: 'already_claimed' });
    expect(repeated.item?.generation).toBe(1);
    expect(repeated.state).toEqual(state);

    const busy = claimSchedulerItemById(state, { userId: 'user-a', itemId: 'sched-item-1', claimId: 'claim-b', claimedBy: 'worker-b', now: 12 });
    expect(busy).toMatchObject({ claimed: false, reason: 'claimed' });

    state = releaseSchedulerClaim(state, { userId: 'user-a', itemId: 'sched-item-1', claimId: 'claim-a', generation: 1, now: 20 }).state;
    result = claimSchedulerItemById(state, { userId: 'user-a', itemId: 'sched-item-1', claimId: 'claim-b', claimedBy: 'worker-b', now: 30 });
    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('expected claim');
    expect(result.item.generation).toBe(2);
  });

  it('validates ids, user scope, dependencies, and stale state transitions', () => {
    let state = createSchedulerQueueState();
    expect(() => enqueue(state, { userId: '../user', itemId: 'sched-item-a', scopeId: 'scope-a', enqueuedAt: 1 })).toThrow(/invalid/i);
    expect(() => enqueue(state, { userId: 'user-a', itemId: 'sched item bad', scopeId: 'scope-a', enqueuedAt: 1 })).toThrow(/invalid/i);
    expect(() => enqueue(state, { userId: 'user-a', itemId: 'sched-item-a', scopeId: 'scope-a', enqueuedAt: 1, dependencies: ['sched-item-a'] })).toThrow(/depend/i);

    state = enqueue(state, { userId: 'user-a', itemId: 'sched-item-a', scopeId: 'scope-a', enqueuedAt: 1 });
    expect(() => completeSchedulerClaim(state, { userId: 'user-a', itemId: 'sched-item-a', claimId: 'claim-a', generation: 1, status: 'completed', now: 10 })).toThrow(/not claimed/i);

    const claim = claimNext(state, { userId: 'user-a', claimId: 'claim-a', claimedBy: 'worker-a', now: 10 });
    expect(() => releaseSchedulerClaim(claim.state, { userId: 'user-a', itemId: 'sched-item-a', claimId: 'claim-a', generation: 0, now: 20 })).toThrow(/stale/i);
    expect(() => completeSchedulerClaim(claim.state, { userId: 'user-b', itemId: 'sched-item-a', claimId: 'claim-a', generation: 1, status: 'completed', now: 20 })).toThrow(/scope/i);
  });
});
