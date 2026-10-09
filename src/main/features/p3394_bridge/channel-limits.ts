/**
 * P3394 统一 Channel/资源限制原语（S-06 / M-05）。
 *
 * 各 Channel 与自动回发路径共享同一套上限语义，避免每个 Adapter 各自发明
 * 背压/速率/总量逻辑：
 *
 * - P3394RateLimiter：token bucket，按窗口补充令牌，超限返回可读的
 *   retry_after 供对端退避；
 * - P3394ByteBudget：累计字节预算，用于 artifact 自动回发等按会话累计的
 *   总量限制。
 */

export const P3394_CHANNEL_LIMITS = {
  /** 每个 HTTP listener 每窗口的入站请求上限（0 = 不限）。 */
  maxInboundRequestsPerMinute: 120,
  /** 每个 session 自动回发的 artifact 累计字节上限（0 = 不限）。 */
  maxArtifactAutoReplyBytes: 8 * 1024 * 1024,
  /** 每个 session 自动回发的 artifact 数量上限（0 = 不限）。 */
  maxArtifactAutoRepliesPerSession: 256,
} as const;

export interface P3394RateLimitResult {
  ok: boolean;
  /** 超限时建议对端等待的毫秒数；ok 时为 0。 */
  retryAfterMs: number;
}

export class P3394RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    nowMs?: number,
    initialTokens = limit,
  ) {
    this.tokens = Math.max(0, initialTokens);
    this.lastRefillMs = nowMs ?? Date.now();
  }

  /** 尝试消费 cost 个令牌；按窗口线性补充，上限为 limit。 */
  tryAcquire(nowMs: number, cost = 1): P3394RateLimitResult {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    const refill = this.limit > 0 ? (elapsed / this.windowMs) * this.limit : 0;
    this.tokens = Math.min(this.limit, this.tokens + refill);
    this.lastRefillMs = nowMs;
    if (this.limit <= 0) return { ok: true, retryAfterMs: 0 };
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { ok: true, retryAfterMs: 0 };
    }
    const missing = cost - this.tokens;
    return { ok: false, retryAfterMs: Math.ceil((missing / this.limit) * this.windowMs) };
  }
}

export class P3394ByteBudget {
  private used = 0;

  constructor(private readonly cap: number) {}

  /** 预占 bytes；超上限返回 false 且不改变状态。0 字节视为通过。 */
  tryReserve(bytes: number): boolean {
    if (bytes < 0) return false;
    if (this.cap <= 0) return true; // 0 = 不限
    if (this.used + bytes > this.cap) return false;
    this.used += bytes;
    return true;
  }

  remaining(): number {
    if (this.cap <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.cap - this.used);
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - Math.max(0, bytes));
  }
}
