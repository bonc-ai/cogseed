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
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
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
  it('maps Claude, Codex and Gemini rows while skipping official providers', async () => {
    createDb([
      {
        id: 'claude-relay', app_type: 'claude', name: 'Claude Relay',
        settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://claude.example', ANTHROPIC_AUTH_TOKEN: 'ak' } }),
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
        id: 'official', app_type: 'claude', name: 'Official', category: 'official',
        settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'skip' } }),
      },
    ]);

    const importer = await import('../../../src/main/features/ccswitch_import');
    const result = importer.readCcSwitchImportItems(home);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalId: 'claude:claude-relay', protocol: 'anthropic', apiKey: 'ak' }),
      expect.objectContaining({ externalId: 'codex:codex-relay', protocol: 'openai', apiKey: 'ok' }),
      expect.objectContaining({ externalId: 'gemini:gemini-relay', protocol: 'gemini', apiKey: 'gk' }),
    ]));
    expect(result.items).toHaveLength(3);
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
        settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'key-1' }, env: { OPENAI_BASE_URL: 'https://one.example/v1' } }),
      },
      {
        id: 'two', app_type: 'codex', name: 'Two',
        settings_config: JSON.stringify({ auth: { OPENAI_API_KEY: 'key-2' }, env: { OPENAI_BASE_URL: 'https://two.example/v1' } }),
      },
    ]);
    const providers = await import('../../../src/main/features/custom_providers');
    expect(providers.syncFromCcSwitch(UID, ['codex:one'], home)).toMatchObject({ ok: true, added: 1, updated: 0 });
    expect(providers.listCustomProviders(UID)).toHaveLength(1);
    expect(providers.syncFromCcSwitch(UID, ['codex:one'], home)).toMatchObject({ ok: true, added: 0, updated: 1 });
    expect(providers.listCustomProviders(UID)).toHaveLength(1);
  });
});
