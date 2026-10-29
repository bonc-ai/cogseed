/**
 * 「这次工作被主动放弃」的共享哨兵（登出、切号时触发）。
 *
 * 为什么单独成模块：取字节链路（`marketplace/source-fetch.ts`）在失败出口统一走
 * `normalizeMarketplaceError`，它会把**任何**非 `MarketplaceError` 的失败包成一个
 * `MarketplaceError`，原错误只留在 `cause` 里。于是上层 `err instanceof XxxCancelled`
 * 的判定会在跨越这一层之后失配——一次「主动放弃」被记成「拉取失败」，界面就会说
 * 「1 项失败，下次启动会自动重试」，而这次 run 其实已经作废、重试没有任何意义。
 *
 * 因此判定必须沿 `cause` 链走（`normalizeMarketplaceError` 只包一层，但为了容忍将来
 * 叠加包装，这里按链遍历）。
 */

/** 取消哨兵基类。各业务层可以继承它来保留自己的语义名，但共享同一个判定。 */
export class MarketplaceCancelled extends Error {
  constructor(message = 'marketplace work cancelled') {
    super(message);
    this.name = 'MarketplaceCancelled';
  }
}

/** 判定一个错误（含其 `cause` 链）是否表示「主动放弃」，而不是失败。 */
export function isMarketplaceCancelled(err: unknown, maxDepth = 8): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < maxDepth; depth += 1) {
    if (current instanceof MarketplaceCancelled) return true;
    const cause = (current as { cause?: unknown }).cause;
    // 自引用或异常形状的 cause 链：到此为止，避免死循环。
    if (!cause || cause === current) return false;
    current = cause;
  }
  return false;
}
