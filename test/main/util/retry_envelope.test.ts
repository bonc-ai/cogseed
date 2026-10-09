import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWithRetry,
  RetriableHttpStatusError,
  serverErrorEnvelopeOf,
} from '../../../src/main/util/retry';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 服务端错误信封的合成样例；形状取自 A-01 / A-02 的约定。 */
function envelopeResponse(status: number, code: string, retryable: boolean): Response {
  return new Response(
    JSON.stringify({
      code: 50000,
      msg: 'upstream unavailable',
      error: { code, message: 'catalog is temporarily unavailable', retryable },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('retry：重试耗尽后读服务端错误信封（FR-006 / 发现 13）', () => {
  it('耗尽后抛出的错误携带服务端信封，原因码可取（回归：基线不读 body 就抛）', async () => {
    // 每次尝试都要拿到**新的** Response：真实 fetch 如此，而 Response 的 body 只能读一次。
    const fetchMock = vi.fn(async () => envelopeResponse(503, 'CATALOG_UNAVAILABLE', true));
    vi.stubGlobal('fetch', fetchMock);

    const err = await fetchWithRetry('test:envelope', 'https://example.test/api', undefined, {
      retries: 2,
      delaysMs: [0, 0],
    }).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(RetriableHttpStatusError);

    const envelope = serverErrorEnvelopeOf(err);
    expect(envelope, '重试耗尽后应能取到服务端错误信封').not.toBeNull();
    expect(envelope?.error?.code).toBe('CATALOG_UNAVAILABLE');
    expect(envelope?.error?.retryable).toBe(true);
    expect(envelope?.msg).toBe('upstream unavailable');
  });

  it('可重试性仍由 HTTP 状态码驱动：信封说 retryable:false，503 依然重试', async () => {
    const fetchMock = vi.fn(async () => envelopeResponse(503, 'CONTENT_NOT_FOUND', false));
    vi.stubGlobal('fetch', fetchMock);

    const err = await fetchWithRetry('test:status-drives', 'https://example.test/api', undefined, {
      retries: 2,
      delaysMs: [0, 0],
    }).catch((e: unknown) => e);

    // 信封里的 retryable 只用于耗尽后的原因判定，不得反过来决定是否重试。
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(serverErrorEnvelopeOf(err)?.error?.retryable).toBe(false);
  });

  it('body 不是 JSON 时不抛新异常，降级为「无信封」', async () => {
    const fetchMock = vi.fn(async () => new Response('gateway timeout', { status: 504 }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await fetchWithRetry('test:non-json', 'https://example.test/api', undefined, {
      retries: 1,
      delaysMs: [0],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RetriableHttpStatusError);
    expect(serverErrorEnvelopeOf(err)).toBeNull();
  });

  it('非可重试状态码不走本路径：404 直接返回给调用方，不抛错', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('test:404', 'https://example.test/missing', undefined, {
      delaysMs: [0],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });
});
