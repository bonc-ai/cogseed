import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => '') } }));

let root = '';
const uid = 'jev-settings-user';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-jev-settings-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  delete process.env.COGSEED_SEMANTICA_ENABLED;
  delete process.env.COGSEED_JEV_ENABLED;
  delete process.env.COGSEED_JEV_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.COGSEED_WORKSPACE_ROOT;
});

describe('Semantica/Jev settings', () => {
  it('defaults both switches off and keeps the Jev key out of preferences', async () => {
    const settings = await import('../../../../src/main/features/jev/settings');
    const paths = await import('../../../../src/main/paths');
    expect(settings.readSemanticaSettings(uid)).toMatchObject({ semanticaEnabled: false, jevEnabled: false });
    settings.updateSemanticaSettings({ semanticaEnabled: true, jevEnabled: true });
    settings.writeJevApiKey(uid, 'synthetic-secret');
    const preferences = fs.readFileSync(paths.userPreferencesFile(uid), 'utf8');
    const secretFile = fs.readFileSync(paths.userSemanticaSecretsFile(uid), 'utf8');
    expect(preferences).not.toContain('synthetic-secret');
    expect(secretFile).not.toContain('synthetic-secret');
    expect(settings.settingsView(uid)).toMatchObject({ hasApiKey: true, jevStatus: 'configured' });
  });

  it('turning Semantica off disables Jev but preserves its configuration', async () => {
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({ semanticaEnabled: true, jevEnabled: true, model: 'jev-test' });
    settings.updateSemanticaSettings({ semanticaEnabled: false });
    expect(settings.readSemanticaSettings(uid)).toMatchObject({ semanticaEnabled: false, jevEnabled: false, model: 'jev-test' });
    settings.updateSemanticaSettings({ semanticaEnabled: true });
    expect(settings.readSemanticaSettings(uid).jevEnabled).toBe(false);
  });

  it('gives explicit environment values precedence over UI settings', async () => {
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({ semanticaEnabled: false, jevEnabled: false, model: 'ui-model' });
    const runtime = settings.resolveSemanticaRuntime(uid, {
      COGSEED_SEMANTICA_ENABLED: 'true',
      COGSEED_JEV_ENABLED: 'true',
      COGSEED_JEV_MODEL: 'env-model',
      COGSEED_JEV_API_KEY: 'env-key',
    });
    expect(runtime.semanticaEnabled).toBe(true);
    expect(runtime.config).toMatchObject({ enabled: true, model: 'env-model', apiKey: 'env-key' });
  });

  it('inherits saved Jev fields when one environment field overrides the UI', async () => {
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({
      semanticaEnabled: true,
      jevEnabled: true,
      endpoint: 'https://jev.saved.example/evaluate',
      model: 'jev-saved-model',
      gates: ['intent'],
      maxRetries: 0,
    });
    settings.writeJevApiKey(uid, 'apikey_saved-test-key');
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      model: 'jev-test',
      answers: { decision: { type: 'choice', choice: 'candidate_0' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { createJevClientForGateFromEnvironment } = await import('../../../../src/main/features/jev/adapter');
    const client = createJevClientForGateFromEnvironment('intent', uid, {
      COGSEED_JEV_ENABLED: 'true',
    }, { fetch: fetchMock });

    const evaluation = await client.evaluate({
      requestId: 'saved-fields-request',
      gate: 'intent',
      question: { id: 'saved-fields-question', kind: 'choice', text: '选择候选' },
      query: '脱敏测试问题',
      candidates: [{ id: 'candidate-a', summary: '脱敏候选', source: 'semantic' }],
    });
    expect(evaluation).toMatchObject({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://jev.saved.example/evaluate');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer apikey_saved-test-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'jev-saved-model' });
  });

  it('tests connectivity with synthetic data only', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ model: 'jev-test', answers: { decision: { type: 'choice', choice: 'candidate_0' } } }),
      requestBody: init?.body,
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({ semanticaEnabled: true, jevEnabled: true });
    settings.writeJevApiKey(uid, 'apikey_test-only-key');
    expect(settings.settingsView(uid)).toMatchObject({ jevStatus: 'configured' });
    expect(await settings.testJevConnection(uid)).toMatchObject({ ok: true, status: 'connected' });
    expect(settings.settingsView(uid)).toMatchObject({ jevStatus: 'connected' });
    const body = String((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body || '');
    expect(body).toContain('Synthetic connection test');
    expect(body).not.toContain('asset body');
    expect(body).not.toContain('test-only-key');
  });

  it('reports authentication failures clearly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: { error_type: 'authentication_error', message: 'Invalid API key' },
    }), { status: 401, headers: { 'content-type': 'application/json' } })));
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({ semanticaEnabled: true, jevEnabled: true, maxRetries: 0 });
    settings.writeJevApiKey(uid, 'apikey_rejected-test-key');

    await expect(settings.testJevConnection(uid)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      code: 'authentication_failed',
      httpStatus: 401,
      reason: expect.stringContaining('API Key'),
    });
  });

  it('reports provider access restrictions without treating them as an API key failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 451 })));
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({ semanticaEnabled: true, jevEnabled: true, maxRetries: 0 });
    settings.writeJevApiKey(uid, 'apikey_restricted-test-key');

    await expect(settings.testJevConnection(uid)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      code: 'access_restricted',
      httpStatus: 451,
      reason: expect.stringContaining('451'),
    });
  });

  it('rejects a malformed saved API key before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const settings = await import('../../../../src/main/features/jev/settings');
    settings.updateSemanticaSettings({ semanticaEnabled: true, jevEnabled: true });
    settings.writeJevApiKey(uid, '这里不是有效的-key');

    await expect(settings.testJevConnection(uid)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      code: 'invalid_api_key_format',
      reason: expect.stringContaining('apikey_'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
