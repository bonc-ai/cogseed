import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectCliAuth } from '../../../../src/main/features/local_agents/auth-state';

// Auth state is file-based and read-only: presence/shape of the CLI's own
// credential files decides loggedIn/mode. Claude additionally accepts an
// API-key config (settings.json / env-injected) — that's the fix under test.

describe('local_agents/auth-state › claude', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auth-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('no credential files → not logged in', () => {
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
  });

  it('OAuth credentials.json → logged in as oauth', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', '.credentials.json'), JSON.stringify({ authToken: 'tok' }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: true, mode: 'oauth' });
  });

  it('settings.json top-level apiKey → logged in as api', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ apiKey: 'sk-ant-xxx' }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: true, mode: 'api' });
  });

  it('settings.json anthropicApiKey → logged in as api', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ anthropicApiKey: 'sk-ant-xxx' }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: true, mode: 'api' });
  });

  it('settings.json env-injected ANTHROPIC_AUTH_TOKEN → logged in as api', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080' },
    }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: true, mode: 'api' });
  });

  it('settings.json env-injected ANTHROPIC_API_KEY → logged in as api', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-xxx' } }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: true, mode: 'api' });
  });

  it('empty / key-less settings.json → not logged in', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
  });

  it('malformed settings.json → not logged in (never throws)', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), 'not json{{{');
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
  });

  it('OAuth credentials.json wins over settings.json key', () => {
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude', '.credentials.json'), JSON.stringify({ authToken: 'tok' }));
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ apiKey: 'sk-ant-xxx' }));
    expect(detectCliAuth('claude', tmp)).toEqual({ loggedIn: true, mode: 'oauth' });
  });
});

describe('local_agents/auth-state › other CLIs stay file-existence based', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auth-state-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('codex: ~/.codex/auth.json presence only', () => {
    expect(detectCliAuth('codex', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.codex', 'auth.json'), JSON.stringify({ access_token: 't' }));
    expect(detectCliAuth('codex', tmp)).toEqual({ loggedIn: true, mode: 'oauth' });
  });

  it('workbuddy: sessions.json must carry a userId entry', () => {
    expect(detectCliAuth('workbuddy', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
    fs.mkdirSync(path.join(tmp, '.workbuddy', 'app'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.workbuddy', 'app', 'sessions.json'), JSON.stringify({ sessions: [{ token: 'x' }] }));
    // No userId → not a real sign-in record.
    expect(detectCliAuth('workbuddy', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
    fs.writeFileSync(path.join(tmp, '.workbuddy', 'app', 'sessions.json'), JSON.stringify({ sessions: [{ userId: 'u-1' }] }));
    expect(detectCliAuth('workbuddy', tmp)).toEqual({ loggedIn: true, mode: 'oauth' });
  });

  it('unknown CLI type → not logged in', () => {
    expect(detectCliAuth('openclaw', tmp)).toEqual({ loggedIn: false, mode: 'unknown' });
  });
});
