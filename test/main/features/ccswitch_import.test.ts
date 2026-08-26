import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

const UID = 'ccswitch-user';
let root: string;
let home: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccswitch-test-'));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.cc-switch'), { recursive: true });
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

function createDb(rows: Array<Record<string, unknown>>): void {
  const db = new Database(path.join(home, '.cc-switch', 'cc-switch.db'));
  db.exec(`CREATE TABLE providers (
    id TEXT, app_type TEXT, name TEXT, settings_config TEXT,
    website_url TEXT, category TEXT, notes TEXT
  )`);
  const insert = db.prepare(`INSERT INTO providers
    (id, app_type, name, settings_config, website_url, category, notes)
    VALUES (@id, @app_type, @name, @settings_config, @website_url, @category, @notes)`);
  for (const row of rows) insert.run({ website_url: null, category: null, notes: null, ...row });
  db.close();
}

describe('CC Switch importer', () => {
  it('maps Claude, Codex, Gemini and Hermes rows while skipping official providers', async () => {
    createDb([
      {
        id: 'claude-relay', app_type: 'claude', name: 'Claude Relay',
        settings_config: JSON.stringify({
          models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
          env: { ANTHROPIC_BASE_URL: 'https://claude.example', ANTHROPIC_AUTH_TOKEN: 'ak', ANTHROPIC_MODEL: 'claude-sonnet-4-6' },
        }),
      },
      {
        id: 'codex-relay', app_type: 'codex', name: 'Codex Relay',
        settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'ok' }, config: 'base_url = "https://openai.example/v1"' }),
      },
      {
        id: 'gemini-relay', app_type: 'gemini', name: 'Gemini Relay',
        settings_config: JSON.stringify({ env: { GEMINI_BASE_URL: 'https://gemini.example', GEMINI_API_KEY: 'gk' } }),
      },
      {
        id: 'codex-env-key', app_type: 'codex', name: 'Env Key Only',
        settings_config: JSON.stringify({ config: `base_url = "https://env.example/v1"
env_key = "OPENAI_API_KEY"` }),
      },
      {
        // Real-world shape (e.g. command): prefix-path base whose /models the
        // live probe can reach, plus [{id, name}] model hints.
        id: 'hermes-command', app_type: 'hermes', name: 'command',
        settings_config: JSON.stringify({
          base_url: 'https://api.commandcode.ai/provider',
          api_key: 'ck',
          api_mode: 'chat_completions',
          models: [{ id: 'gpt-5.6-luna', name: '' }, { id: 'zai-org/GLM-5.3', name: '' }],
        }),
      },
      {
        id: 'hermes-nokey', app_type: 'hermes', name: 'No Key Hermes',
        settings_config: JSON.stringify({ base_url: 'https://relay.example/v1' }),
      },
      {
        id: 'official', app_type: 'claude', name: 'Official', category: 'official',
        settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'skip' } }),
      },
      {
        id: 'unsupported-other', app_type: 'some-future-app', name: 'DeepSeek', category: null,
        settings_config: JSON.stringify({ env: { API_KEY: 'hidden' } }),
      },
    ]);

    const importer = await import('../../../src/main/features/ccswitch_import');
    const result = importer.readCcSwitchImportItems(home);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        externalId: 'claude:claude-relay', protocol: 'anthropic', apiKey: 'ak',
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      }),
      expect.objectContaining({ externalId: 'codex:codex-relay', protocol: 'openai', apiKey: 'ok' }),
      expect.objectContaining({ externalId: 'gemini:gemini-relay', protocol: 'gemini', apiKey: 'gk' }),
      // Env-key-only rows are importable with needsKey so the user can fill
      // the key after the preview instead of losing the endpoint entirely.
      expect.objectContaining({ externalId: 'codex:codex-env-key', protocol: 'openai', apiKey: '', needsKey: true }),
      expect.objectContaining({
        externalId: 'hermes:hermes-command', protocol: 'openai',
        baseUrl: 'https://api.commandcode.ai/provider', apiKey: 'ck',
        models: ['gpt-5.6-luna', 'zai-org/GLM-5.3'],
      }),
      expect.objectContaining({ externalId: 'hermes:hermes-nokey', protocol: 'openai', apiKey: '', needsKey: true }),
    ]));
    expect(result.items).toHaveLength(6);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: 'claude:official', reason: 'official' }),
      expect.objectContaining({ externalId: 'some-future-app:unsupported-other', reason: 'unsupported_protocol' }),
    ]));
  });

  it('returns structured failures for missing and incompatible databases', async () => {
    const importer = await import('../../../src/main/features/ccswitch_import');
    expect(importer.readCcSwitchImportItems(path.join(root, 'missing'))).toEqual({ ok: false, reason: 'not_installed' });

    const db = new Database(path.join(home, '.cc-switch', 'cc-switch.db'));
    db.exec('CREATE TABLE providers (id TEXT)');
    db.close();
    expect(importer.readCcSwitchImportItems(home)).toEqual({ ok: false, reason: 'bad_schema' });
  });

  it('syncs only selected rows and updates them idempotently', async () => {
    createDb([
      {
        id: 'one', app_type: 'codex', name: 'One',
        settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'key-1' }, env: { OPENAI_BASE_URL: 'https://one.example/v1' }, model: 'gpt-5' }),
      },
      {
        id: 'two', app_type: 'codex', name: 'Two',
        settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'key-2' }, env: { OPENAI_BASE_URL: 'https://two.example/v1' }, model: 'gpt-5' }),
      },
    ]);
    const providers = await import('../../../src/main/features/custom_providers');
    await expect(providers.syncFromCcSwitch(UID, ['codex:one'], home)).resolves.toMatchObject({ ok: true, added: 1, updated: 0 });
    expect(providers.listCustomProviders(UID)).toHaveLength(1);
    await expect(providers.syncFromCcSwitch(UID, ['codex:one'], home)).resolves.toMatchObject({ ok: true, added: 0, updated: 1 });
    expect(providers.listCustomProviders(UID)).toHaveLength(1);

    // A synced provider with a declared model must be AUTO-BOUND to an entry
    // (pickChatEntry only walks entries) — otherwise "connected" chat would
    // still report no usable model.
    const auth = await import('../../../src/main/features/auth');
    const { entries } = await auth.listEntries();
    const providerId = `cp:${providers.listCustomProviders(UID)[0].id}`;
    expect(entries.some((e) => e.provider === providerId && e.model === 'gpt-5')).toBe(true);
  });

  it('preserves configured model limits when re-syncing the same model id', async () => {
    createDb([{
      id: 'limits', app_type: 'codex', name: 'Limits',
      settings_config: JSON.stringify({
        auth: { OPENAI_API_KEY: 'key-limits' },
        env: { OPENAI_BASE_URL: 'https://limits.example/v1' },
        model: 'model-a',
      }),
    }]);
    const providers = await import('../../../src/main/features/custom_providers');
    await providers.syncFromCcSwitch(UID, ['codex:limits'], home);
    const provider = providers.listCustomProviders(UID)[0];
    expect(providers.updateCustomProviderModel(UID, provider.id, 'model-a', {
      id: 'model-a', contextWindow: 524288, maxTokens: 32768,
    })).toMatchObject({ ok: true });

    await providers.syncFromCcSwitch(UID, ['codex:limits'], home);

    expect(providers.listCustomProviders(UID)[0].models).toEqual([
      { id: 'model-a', contextWindow: 524288, maxTokens: 32768 },
    ]);
  });
});
