import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

const UID = 'authorization-discovery-user';
let root: string;
let home: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'authorization-discovery-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.cc-switch'), { recursive: true });
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  try {
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    discovery.__resetAuthorizationDraftsForTests();
  } catch { /* module may not exist yet */ }
  process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function createCcSwitchDb(settings: Record<string, unknown>): void {
  const db = new Database(path.join(home, '.cc-switch', 'cc-switch.db'));
  db.exec(`CREATE TABLE providers (
    id TEXT, app_type TEXT, name TEXT, settings_config TEXT,
    website_url TEXT, category TEXT, notes TEXT
  )`);
  db.prepare(`INSERT INTO providers
    (id, app_type, name, settings_config, website_url, category, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('relay', 'codex', 'Relay', JSON.stringify(settings), null, null, null);
  db.close();
}

describe('model authorization discovery', () => {
  it('discovers OpenAI-compatible models with a bearer key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { data: [
      { id: 'model-a', name: 'Model A' }, { id: 'model-a' }, { id: 'model-b' },
    ] }));
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    const result = await discovery.discoverAuthorizationModels(UID, {
      kind: 'custom_api_key', protocol: 'openai', baseUrl: 'https://relay.example/v1/', apiKey: 'secret-openai',
    }, { fetchImpl });

    expect(result).toEqual({
      ok: true, source: 'live',
      models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'model-b' }],
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://relay.example/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer secret-openai' }),
    }));
  });

  it('uses Anthropic and Gemini model endpoints and headers', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push([String(url), init || {}]);
      if (String(url).includes('anthropic')) return jsonResponse(200, { data: [{ id: 'claude-a', display_name: 'Claude A' }] });
      return jsonResponse(200, { models: [{ name: 'models/gemini-a', displayName: 'Gemini A' }] });
    });
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    expect(await discovery.discoverAuthorizationModels(UID, {
      kind: 'custom_api_key', protocol: 'anthropic', baseUrl: 'https://anthropic.example', apiKey: 'anthropic-secret',
    }, { fetchImpl })).toMatchObject({ ok: true, models: [{ id: 'claude-a', name: 'Claude A' }] });
    expect(await discovery.discoverAuthorizationModels(UID, {
      kind: 'custom_api_key', protocol: 'gemini', baseUrl: 'https://gemini.example', apiKey: 'gemini-secret',
    }, { fetchImpl })).toMatchObject({ ok: true, models: [{ id: 'gemini-a', name: 'Gemini A' }] });

    expect(calls[0][0]).toBe('https://anthropic.example/v1/models');
    expect(calls[0][1].headers).toMatchObject({ 'x-api-key': 'anthropic-secret', 'anthropic-version': expect.any(String) });
    expect(calls[1][0]).toBe('https://gemini.example/v1beta/models');
    expect(calls[1][1].headers).toMatchObject({ 'x-goog-api-key': 'gemini-secret' });
  });

  it('classifies auth, unsupported, network, and provider failures separately', async () => {
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    const input = { kind: 'custom_api_key' as const, protocol: 'openai' as const, baseUrl: 'https://relay.example/v1', apiKey: 'secret' };
    expect(await discovery.discoverAuthorizationModels(UID, input, { fetchImpl: async () => jsonResponse(401, {}) })).toMatchObject({
      ok: false, errorCode: 'auth_failed', retryable: false, manualAllowed: false,
    });
    expect(await discovery.discoverAuthorizationModels(UID, input, { fetchImpl: async () => jsonResponse(404, {}) })).toMatchObject({
      ok: false, errorCode: 'unsupported_discovery', retryable: false, manualAllowed: true,
    });
    expect(await discovery.discoverAuthorizationModels(UID, input, { fetchImpl: async () => { throw new Error('offline'); } })).toMatchObject({
      ok: false, errorCode: 'network_error', retryable: true, manualAllowed: false,
    });
    expect(await discovery.discoverAuthorizationModels(UID, input, { fetchImpl: async () => jsonResponse(503, {}) })).toMatchObject({
      ok: false, errorCode: 'provider_error', retryable: true, manualAllowed: false,
    });
  });

  it('returns the existing curated catalog for built-in providers', async () => {
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    const result = await discovery.discoverAuthorizationModels(UID, { kind: 'builtin', providerId: 'anthropic' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.source).toBe('catalog');
    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validates draft connection inputs without persisting credentials', async () => {
    const auth = await import('../../../src/main/features/auth');
    expect(await auth.testAuthorizationDraft(UID, {
      kind: 'builtin_api_key', providerId: 'anthropic', apiKey: '', model: 'claude-opus-4-8',
    })).toEqual({ ok: false, error: 'apiKey required' });
    expect(await auth.testAuthorizationDraft(UID, {
      kind: 'custom_api_key', protocol: 'openai', baseUrl: 'not-a-url', apiKey: 'secret', model: 'model-a',
    })).toMatchObject({ ok: false, error: expect.stringContaining('baseUrl') });
    expect(auth.listAuthorizationSummaries(UID).authorizations).toEqual([]);
  });

  it('prepares an opaque CC Switch draft without exposing the raw key and can discover with it', async () => {
    createCcSwitchDb({
      auth: { OPENAI_API_KEY: 'cc-secret-key' },
      env: { OPENAI_BASE_URL: 'https://cc.example/v1', OPENAI_MODEL: 'declared-a' },
      models: ['declared-a', 'declared-b'],
    });
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    const prepared = discovery.prepareCcSwitchAuthorization(UID, 'codex:relay', { home, randomId: () => 'draft-safe' });
    expect(prepared).toEqual({
      ok: true,
      draft: {
        draftId: 'draft-safe', externalId: 'codex:relay', name: 'Relay', protocol: 'openai',
        baseUrl: 'https://cc.example/v1', declaredModels: ['declared-a', 'declared-b'],
      },
    });
    expect(JSON.stringify(prepared)).not.toContain('cc-secret-key');

    const result = await discovery.discoverAuthorizationModels(UID, { kind: 'ccswitch_draft', draftId: 'draft-safe' }, {
      fetchImpl: async () => jsonResponse(200, { data: [{ id: 'live-a' }] }),
    });
    expect(result).toMatchObject({ ok: true, models: [{ id: 'live-a', name: 'live-a' }] });
  });

  it('rejects missing keys and expires or consumes drafts', async () => {
    createCcSwitchDb({ env: { OPENAI_BASE_URL: 'https://cc.example/v1' } });
    const discovery = await import('../../../src/main/features/model_authorization_discovery');
    expect(discovery.prepareCcSwitchAuthorization(UID, 'codex:relay', { home })).toEqual({ ok: false, errorCode: 'not_found' });

    fs.rmSync(path.join(home, '.cc-switch', 'cc-switch.db'));
    createCcSwitchDb({ auth: { OPENAI_API_KEY: 'cc-secret' }, env: { OPENAI_BASE_URL: 'https://cc.example/v1' } });
    const prepared = discovery.prepareCcSwitchAuthorization(UID, 'codex:relay', { home, now: () => 1000, randomId: () => 'expiring' });
    expect(prepared.ok).toBe(true);
    expect(discovery.resolveCcSwitchAuthorizationDraft(UID, 'expiring', { now: () => 1000 + 10 * 60_000 + 1 })).toEqual({ ok: false, errorCode: 'draft_expired' });

    discovery.prepareCcSwitchAuthorization(UID, 'codex:relay', { home, now: () => 2000, randomId: () => 'one-use' });
    const consumed = discovery.resolveCcSwitchAuthorizationDraft(UID, 'one-use', { now: () => 2001, consume: true });
    expect(consumed.ok).toBe(true);
    expect(discovery.resolveCcSwitchAuthorizationDraft(UID, 'one-use', { now: () => 2002 })).toEqual({ ok: false, errorCode: 'draft_not_found' });
  });
});
