/**
 * Hub Skill 失败原因的**唯一**归一化点。
 *
 * ⚠️ FR-014 的定案：归一化依据是**服务端错误信封**，**不是**异常捕获处的推断。
 * 捕获处只提供「这一步在做什么」的兜底语义（`fallback`），不得反推原因码。
 *
 * 信封由 `util/retry.ts` 在重试耗尽前捕获（FR-006），因此原因码在重试耗尽后仍然可取。
 */

import { serverErrorEnvelopeOf, type ServerErrorEnvelope } from '../../util/retry';

/** 归一化后的原因码集合。除此之外不产生新码。 */
export type MarketplaceErrorCode =
  | 'CONTENT_NOT_FOUND'
  | 'CATALOG_UNAVAILABLE'
  | 'DIGEST_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'UNEXPECTED_CONTENT_TYPE';

const KNOWN_CODES: ReadonlySet<string> = new Set<MarketplaceErrorCode>([
  'CONTENT_NOT_FOUND',
  'CATALOG_UNAVAILABLE',
  'DIGEST_MISMATCH',
  'SIZE_MISMATCH',
  'UNEXPECTED_CONTENT_TYPE',
]);

export class MarketplaceError extends Error {
  code: MarketplaceErrorCode;

  /** 服务端原话，仅用于日志与展示，不参与判定。 */
  serverMessage?: string;

  constructor(code: MarketplaceErrorCode, message: string, options: { cause?: unknown; serverMessage?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MarketplaceError';
    this.code = code;
    this.serverMessage = options.serverMessage;
  }
}

/** 从信封取原因码；信封没给或给了未知码则返回 null，**不做推断**。 */
export function codeFromEnvelope(envelope: ServerErrorEnvelope | null | undefined): MarketplaceErrorCode | null {
  const raw = envelope?.error?.code;
  if (typeof raw !== 'string') return null;
  const upper = raw.toUpperCase();
  return KNOWN_CODES.has(upper) ? (upper as MarketplaceErrorCode) : null;
}

/**
 * 把任意失败归一化为 `MarketplaceError`。
 *
 * @param fallback 捕获处声明的兜底语义 —— 「这一步失败时，在信封没给原因码的情况下算什么」。
 *                 由调用方显式给出，不由本函数猜。
 */
export function normalizeMarketplaceError(
  err: unknown,
  fallback: MarketplaceErrorCode,
): MarketplaceError {
  if (err instanceof MarketplaceError) return err;

  const envelope = serverErrorEnvelopeOf(err);
  const code = codeFromEnvelope(envelope) ?? fallback;
  const serverMessage = envelope?.error?.message || envelope?.msg;
  const detail = serverMessage || (err instanceof Error ? err.message : String(err));

  return new MarketplaceError(code, `${code}: ${detail}`, { cause: err, serverMessage });
}

/** 客户端本地判定的失败 —— 这三项不经服务端信封，由校验点直接产生。 */
export function digestMismatch(expected: string, actual: string): MarketplaceError {
  return new MarketplaceError('DIGEST_MISMATCH', `DIGEST_MISMATCH: expected ${expected}, got ${actual}`);
}

export function sizeMismatch(expected: number, actual: number): MarketplaceError {
  return new MarketplaceError('SIZE_MISMATCH', `SIZE_MISMATCH: expected ${expected} bytes, got ${actual}`);
}

export function unexpectedContentType(actual: string): MarketplaceError {
  return new MarketplaceError('UNEXPECTED_CONTENT_TYPE', `UNEXPECTED_CONTENT_TYPE: ${actual || '(absent)'}`);
}
