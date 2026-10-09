import { describe, expect, it } from 'vitest';
import {
  P3394ByteBudget,
  P3394RateLimiter,
} from '../../../../src/main/features/p3394_bridge/channel-limits';

describe('P3394RateLimiter (S-06)', () => {
  it('allows up to the limit and rejects beyond with retry_after', () => {
    const limiter = new P3394RateLimiter(3, 60_000, 0);
    expect(limiter.tryAcquire(0).ok).toBe(true);
    expect(limiter.tryAcquire(0).ok).toBe(true);
    expect(limiter.tryAcquire(0).ok).toBe(true);
    const rejected = limiter.tryAcquire(0);
    expect(rejected.ok).toBe(false);
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over the window and caps tokens at the limit', () => {
    const limiter = new P3394RateLimiter(2, 60_000, 0);
    limiter.tryAcquire(0);
    limiter.tryAcquire(0);
    expect(limiter.tryAcquire(0).ok).toBe(false);
    // 半窗口补充 1 个令牌。
    expect(limiter.tryAcquire(30_000).ok).toBe(true);
    expect(limiter.tryAcquire(30_000).ok).toBe(false);
    // 完整窗口后补满，仍以 limit 为上限。
    expect(limiter.tryAcquire(120_000).ok).toBe(true);
    expect(limiter.tryAcquire(120_000).ok).toBe(true);
    expect(limiter.tryAcquire(120_000).ok).toBe(false);
  });

  it('disables limiting when limit <= 0', () => {
    const limiter = new P3394RateLimiter(0, 60_000, 0);
    for (let i = 0; i < 100; i += 1) expect(limiter.tryAcquire(0).ok).toBe(true);
  });

  it('cost larger than the limit is never admitted', () => {
    const limiter = new P3394RateLimiter(3, 60_000, 0);
    expect(limiter.tryAcquire(0, 5).ok).toBe(false);
  });
});

describe('P3394ByteBudget (S-06/M-05)', () => {
  it('reserves cumulative bytes up to the cap', () => {
    const budget = new P3394ByteBudget(100);
    expect(budget.tryReserve(60)).toBe(true);
    expect(budget.tryReserve(40)).toBe(true);
    expect(budget.tryReserve(1)).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it('release returns capacity', () => {
    const budget = new P3394ByteBudget(100);
    budget.tryReserve(60);
    budget.release(20);
    expect(budget.remaining()).toBe(60);
    expect(budget.tryReserve(60)).toBe(true);
  });

  it('zero cap disables the budget; negative reserves are rejected; zero is free', () => {
    const unlimited = new P3394ByteBudget(0);
    expect(unlimited.tryReserve(1_000_000)).toBe(true);
    expect(unlimited.remaining()).toBe(Number.POSITIVE_INFINITY);
    const budget = new P3394ByteBudget(10);
    expect(budget.tryReserve(-1)).toBe(false);
    expect(budget.tryReserve(0)).toBe(true);
  });
});
