import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ buildRunner: vi.fn(), run: vi.fn(), cli: vi.fn(), detect: vi.fn(), budget: vi.fn(), outcome: vi.fn(),
  configured: true, thinking: 'auto' as 'auto' | 'high' }));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: mocks.buildRunner }));
vi.mock('../../../../src/main/features/config', () => ({ getThinkingLevel: () => mocks.thinking }));
vi.mock('../../../../src/main/features/auth', () => ({ hasConfiguredModelForUser: () => ({ configured: mocks.configured }) }));
vi.mock('../../../../src/main/features/local_agents/registry', () => ({ detectAll: mocks.detect }));
vi.mock('../../../../src/main/features/local_agents/runner', () => ({
  run: mocks.cli,
  supportsNoTools: (cli: string) => cli === 'claude',
}));
vi.mock('../../../../src/main/features/recall/capture-model-budget', () => ({ withCaptureModelBudget: mocks.budget, recordCaptureModelOutcome: mocks.outcome }));
import { runRecallCaptureModel } from '../../../../src/main/features/recall/capture-model-routing';
const routes = [{ provider: 'openai', model: 'first' }, { provider: 'anthropic', model: 'second' }];
const options = { sessionId: 'memory-test', systemPrompt: 'analyze', message: 'source', modelCandidates: routes };
const success = { text: 'complete response', meta: { aborted: false } };
beforeEach(() => {
  mocks.outcome.mockReset().mockResolvedValue(undefined);
  mocks.thinking = 'auto';
  mocks.configured = true;
  mocks.cli.mockReset().mockResolvedValue({ status: 'completed', output: 'CLI complete' });
  mocks.detect.mockReset().mockResolvedValue([{ type: 'claude', available: true }]);
  mocks.budget.mockReset().mockImplementation(async (_user, _budget, _chars, run) => run());
  mocks.run.mockReset().mockResolvedValue(success);
  mocks.buildRunner.mockReset().mockImplementation(async params => {
    const route = params.modelCandidates?.[0] || { provider: 'global', model: 'actual' };
    params.onCandidateChosen({ providerId: route.provider, modelId: route.model });
    return { runner: { run: mocks.run } };
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('nightly capture model routing', () => {
  it.each(['503 service unavailable', 'connection reset after response began', 'All configured model candidates failed after network retries'])('discards exhausted/partial response and advances once: %s', async message => {
    mocks.run.mockResolvedValueOnce({ text: 'partial uncommitted response', meta: {
      aborted: false, error: { kind: 'provider_error', message, code: message.startsWith('All') ? 'PROVIDER_NETWORK_EXHAUSTED' : undefined },
    } });
    const completed = await runRecallCaptureModel('user', options);
    expect(completed).toEqual({ result: success, chosen: routes[1] });
    expect(mocks.buildRunner.mock.calls.map(([params]) => params.modelCandidates)).toEqual([[routes[0]], [routes[1]]]);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run.mock.calls[0][0]).not.toHaveProperty('thinkingLevel');
  });
  it('skips a removed credential without falling back to the global route', async () => {
    mocks.buildRunner.mockRejectedValueOnce(Object.assign(new Error('configured model unavailable'), { code: 'PROVIDER_AUTH_EXHAUSTED' }));
    expect((await runRecallCaptureModel('user', options)).chosen).toEqual(routes[1]);
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it.each([
    { kind: 'context_overflow', message: 'context too long' },
    { kind: 'provider_error', message: '400 invalid request' },
    { kind: 'provider_error', message: 'content policy violation' },
    { kind: 'provider_error', message: 'content policy violation: fetch failed' },
  ])('keeps deterministic/safety failures terminal: $message', async error => {
    const failed = { text: '', meta: { aborted: false, error } };
    mocks.run.mockResolvedValueOnce(failed);
    expect((await runRecallCaptureModel('user', options)).result).toEqual(failed);
    expect(mocks.buildRunner).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch a successor after user cancellation or runner abort', async () => {
    const controller = new AbortController();
    mocks.run.mockImplementationOnce(async () => {
      controller.abort();
      return { text: 'partial', meta: { aborted: true, error: { kind: 'timeout', message: 'Run aborted' } } };
    });
    await runRecallCaptureModel('user', { ...options, signal: controller.signal });
    expect(mocks.buildRunner).toHaveBeenCalledTimes(1);
    mocks.buildRunner.mockClear();
    await expect(runRecallCaptureModel('user', { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(mocks.buildRunner).not.toHaveBeenCalled();
  });
  it('stops before successor when the nightly window closes', async () => {
    mocks.run.mockResolvedValueOnce({ text: '', meta: { aborted: false, error: { kind: 'timeout', message: 'request timed out' } } });
    const shouldContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(runRecallCaptureModel('user', { ...options, shouldContinue })).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(mocks.buildRunner).toHaveBeenCalledTimes(1);
  });
  it('applies the system reasoning preference to every fallback', async () => {
    mocks.thinking = 'high';
    mocks.run.mockResolvedValueOnce({ text: '', meta: { aborted: false, error: { kind: 'timeout', message: 'request timed out' } } });
    await runRecallCaptureModel('user', options);
    expect(mocks.run.mock.calls.map(([params]) => params.thinkingLevel)).toEqual(['high', 'high']);
  });
  it('uses the normal global route once when no explicit models are selected', async () => {
    expect((await runRecallCaptureModel('user', { ...options, modelCandidates: [] })).chosen).toEqual({ provider: 'global', model: 'actual' });
    expect(mocks.buildRunner.mock.calls[0][0]).not.toHaveProperty('modelCandidates');
  });
  it('passes explicit JSON mode through every existing fallback without changing reasoning or tool/session boundaries', async () => {
    mocks.thinking = 'high';
    mocks.run.mockResolvedValueOnce({ text: '', meta: { error: { kind: 'timeout', message: 'request timed out' } } });
    await runRecallCaptureModel('user', { ...options, responseFormat: 'json_object' });
    expect(mocks.buildRunner.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({ modelCandidates: [routes[0]], responseFormat: 'json_object', disableTools: true, ephemeralSession: true }),
      expect.objectContaining({ modelCandidates: [routes[1]], responseFormat: 'json_object', disableTools: true, ephemeralSession: true }),
    ]);
    expect(mocks.run.mock.calls.map(([params]) => params.thinkingLevel)).toEqual(['high', 'high']);
  });
  it('does not opt other capture stages into JSON mode implicitly', async () => {
    await runRecallCaptureModel('user', options);
    expect(mocks.buildRunner.mock.calls[0][0]).not.toHaveProperty('responseFormat');
  });
  it('uses the same opt-in CLI and budget boundary for formation stages without changing generic empty-route callers', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    mocks.configured = false;
    const budget = { jobId: 'capture-a', stage: 'grounding' as const };
    expect((await runRecallCaptureModel('user', { ...options, modelCandidates: [], budget,
      cliContext: { conversationId: 'conversation-a' } })).result.text).toBe('CLI complete');
    expect(mocks.cli).toHaveBeenCalledWith(expect.objectContaining({ uid: 'user', cid: 'conversation-a', cli: 'claude', prompt: 'analyze\n\nsource' }));
    expect(mocks.cli.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(mocks.budget).toHaveBeenCalledWith('user', budget, 'analyze\n\nsource'.length, expect.any(Function));
    expect(mocks.buildRunner).not.toHaveBeenCalled();
    await runRecallCaptureModel('user', { ...options, modelCandidates: [] });
    expect(mocks.buildRunner).toHaveBeenCalledTimes(1);
  });
  it('refuses a CLI without a zero-tool surface instead of sending source text to it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    mocks.configured = false;
    mocks.detect.mockResolvedValue([{ type: 'codex', available: true }]);
    await expect(runRecallCaptureModel('user', { ...options, modelCandidates: [], cliContext: { conversationId: 'conversation-a' } }))
      .rejects.toMatchObject({ code: 'capture_model_not_configured' });
    expect(mocks.cli).not.toHaveBeenCalled();
  });
  it('prefers claude and forces toolPolicy none when several CLIs are available', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    mocks.configured = false;
    mocks.detect.mockResolvedValue([
      { type: 'codex', available: true },
      { type: 'claude', available: true },
    ]);
    expect((await runRecallCaptureModel('user', { ...options, modelCandidates: [], cliContext: { conversationId: 'conversation-a' } })).result.text).toBe('CLI complete');
    expect(mocks.cli).toHaveBeenCalledWith(expect.objectContaining({
      cli: 'claude', toolPolicy: 'none', prompt: 'analyze\n\nsource',
    }));
  });
  it('passes an explicit output ceiling without changing the default', async () => {
    await runRecallCaptureModel('user', { ...options, maxOutputTokens: 2048 });
    expect(mocks.buildRunner.mock.calls[0][0]).toMatchObject({ maxOutputTokens: 2048 });
  });
});
it('preserves the model failure checkpoint reason when the runner turns a dispatch rejection into an error envelope', async () => {
  const held = Object.assign(new Error('Host failure guard tripped'), { code: 'ABORT_ERR', reason: 'capture_model_failure_hold' });
  mocks.budget.mockImplementation(async (_user, _context, _chars, run) => run(async () => { throw held; }));
  mocks.buildRunner.mockImplementation(async params => ({ runner: { run: async () => {
    try { await params.onModelDispatch(); } catch { return { text: '', meta: { aborted: true } }; }
    throw new Error('Dispatch should not continue');
  } } }));
  await expect(runRecallCaptureModel('user', { ...options, budget: { jobId: 'stock-job', stage: 'grounding', source: 'stock_organization' } }))
    .rejects.toBe(held);
  expect(mocks.buildRunner).toHaveBeenCalledTimes(1);
});

it('counts one task outcome after fallback, not each unavailable route; cancellation is excluded', async () => {
  const budget = { jobId: 'stock-job', stage: 'extraction' as const, source: 'stock_organization' as const };
  mocks.run.mockResolvedValueOnce({ text: '', meta: { error: { kind: 'provider_error', message: 'Connection error.' } } });
  await runRecallCaptureModel('user', { ...options, budget });
  expect(mocks.buildRunner).toHaveBeenCalledTimes(2);
  expect(mocks.outcome).toHaveBeenCalledExactlyOnceWith('user', budget, undefined);
  mocks.outcome.mockClear();
  mocks.run.mockResolvedValue({ text: '', meta: { error: { kind: 'provider_error', message: 'Connection error.' } } });
  await runRecallCaptureModel('user', { ...options, budget });
  expect(mocks.outcome).toHaveBeenCalledExactlyOnceWith('user', budget, 'connection');
  mocks.outcome.mockClear();
  const controller = new AbortController(); controller.abort();
  await expect(runRecallCaptureModel('user', { ...options, budget, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' });
  expect(mocks.outcome).not.toHaveBeenCalled();
});
