import { describe, expect, it, vi } from 'vitest';

import {
  createJevClient,
  createJevClientFromEnvironment,
  NoopJevClient,
} from '../../../../src/main/features/jev/adapter';
import { type JevEvaluationRequest } from '../../../../src/main/features/jev/types';

const request: JevEvaluationRequest = {
  requestId: 'req-1',
  gate: 'candidate_suitability',
  question: { id: 'q-1', kind: 'choice', text: '选择适合当前任务的候选' },
  query: '查找可复用的认证能力',
  candidates: [{
    id: 'asset-1',
    summary: '认证服务能力资产',
    source: 'ontology',
    evidence: ['认证服务 depends_on API 网关'],
  }],
};

function response(choice = 'candidate_0'): Response {
  return new Response(JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      decision: {
        type: 'choice',
        choice,
        confidence: 0.99,
        probabilities: { candidate_0: 0.99, none: 0.01 },
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Jev adapter', () => {
  it('does not call a provider when the feature is disabled', async () => {
    const fetchImpl = vi.fn();
    const client = createJevClient({ enabled: false, endpoint: 'https://jev.example/evaluate', apiKey: 'secret' }, { fetch: fetchImpl });

    await expect(client.evaluate(request)).resolves.toEqual({ status: 'fallback', reason: 'disabled', attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back when enabled but endpoint or API key is missing', async () => {
    const client = createJevClient({ enabled: true, endpoint: 'https://jev.example/evaluate' });
    await expect(client.evaluate(request)).resolves.toEqual({ status: 'fallback', reason: 'unconfigured', attempts: 0 });
  });

  it('constructs a bounded request and accepts a valid response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response());
    const client = createJevClient({
      enabled: true,
      endpoint: 'https://jev.example/evaluate',
      apiKey: 'secret',
      maxRetries: 0,
    }, { fetch: fetchImpl });

    await expect(client.evaluate(request)).resolves.toMatchObject({ status: 'ok', attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://jev.example/evaluate');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'jev-latest',
      state: expect.stringContaining('candidate_0: source=ontology; summary=认证服务能力资产'),
      questions: {
        decision: {
          type: 'choice',
          criteria: {
            candidate_0: '认证服务能力资产',
            none: expect.any(String),
          },
        },
      },
    });
  });

  it('rejects a response that selects a candidate outside the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response('candidate_not_in_request'));
    const client = createJevClient({ enabled: true, endpoint: 'https://jev.example/evaluate', apiKey: 'secret', maxRetries: 0 }, { fetch: fetchImpl });

    await expect(client.evaluate(request)).resolves.toMatchObject({ status: 'fallback', reason: 'invalid_response', attempts: 1 });
  });

  it('preserves safe HTTP diagnostics without exposing request credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: { error_type: 'authentication_error', message: 'Invalid API key' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }));
    const client = createJevClient({
      enabled: true,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      apiKey: 'secret-that-must-not-leak',
      maxRetries: 0,
    }, { fetch: fetchImpl });

    const result = await client.evaluate(request);
    expect(result).toMatchObject({
      status: 'fallback',
      reason: 'http_rejected',
      httpStatus: 401,
      providerCode: 'authentication_error',
      providerMessage: 'Invalid API key',
    });
    expect(JSON.stringify(result)).not.toContain('secret-that-must-not-leak');
  });

  it('maps TypeSafe noul answers back to bounded candidate scores', async () => {
    const scoreRequest: JevEvaluationRequest = {
      ...request,
      question: { id: 'q-score', kind: 'score', text: '判断每个候选是否适用' },
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: { candidate_0: { type: 'noul', noul: 0.83 } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createJevClient({
      enabled: true,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      apiKey: 'secret',
      maxRetries: 0,
    }, { fetch: fetchImpl });

    await expect(client.evaluate(scoreRequest)).resolves.toMatchObject({
      status: 'ok',
      response: {
        decision: { type: 'score', scores: [{ candidateId: 'asset-1', score: 0.83 }] },
      },
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      questions: {
        candidate_0: {
          type: 'noul',
          instructions: expect.stringContaining('candidate_0: 认证服务能力资产'),
        },
      },
    });
  });

  it('retries a rate-limited request within the configured bound', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(response());
    const client = createJevClient({ enabled: true, endpoint: 'https://jev.example/evaluate', apiKey: 'secret', maxRetries: 1 }, {
      fetch: fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.evaluate(request)).resolves.toMatchObject({ status: 'ok', attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry caller cancellation', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      controller.abort();
      void init;
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const client = createJevClient({ enabled: true, endpoint: 'https://jev.example/evaluate', apiKey: 'secret', maxRetries: 2 }, {
      fetch: fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(client.evaluate(request, { signal: controller.signal })).resolves.toMatchObject({
      status: 'fallback', reason: 'aborted', attempts: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a request after the full decision timeout is consumed', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })) as unknown as typeof fetch;
      const client = createJevClient({
        enabled: true,
        endpoint: 'https://jev.example/evaluate',
        apiKey: 'secret',
        timeoutMs: 100,
        maxRetries: 2,
      }, { fetch: fetchImpl, sleep: vi.fn().mockResolvedValue(undefined) });

      const pending = client.evaluate(request);
      await vi.advanceTimersByTimeAsync(101);
      await expect(pending).resolves.toMatchObject({ status: 'fallback', reason: 'timeout', attempts: 1 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a disabled-by-default environment configuration', async () => {
    const client = createJevClientFromEnvironment({ COGSEED_JEV_ENDPOINT: 'https://jev.example/evaluate', COGSEED_JEV_API_KEY: 'secret' });
    expect(client).toBeInstanceOf(NoopJevClient);
    await expect(client.evaluate(request)).resolves.toEqual({ status: 'fallback', reason: 'disabled', attempts: 0 });
  });
});
