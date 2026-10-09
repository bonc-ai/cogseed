import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readActiveCliConfig, readAllActiveCliConfigs } from '../../../../src/main/features/local_agents/active_config.js';

let tempHome: string;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'active-config-test-'));
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('readActiveCliConfig - Claude', () => {
  it('reads API key from settings.json with priority over OAuth', () => {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // API key in settings.json
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        apiKey: 'sk-ant-test-api-key',
        baseUrl: 'https://custom-claude.example.com',
      }),
    );

    // OAuth in credentials.json (should be ignored due to priority)
    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({ authToken: 'oauth-token-ignored' }),
    );

    const result = readActiveCliConfig('claude', tempHome);
    expect(result).toEqual({
      cli: 'claude',
      baseUrl: 'https://custom-claude.example.com',
      apiKey: 'sk-ant-test-api-key',
      mode: 'api',
      sourcePath: path.join(claudeDir, 'settings.json'),
    });
  });

  it('reads env-injected token from settings.json env block (ANTHROPIC_AUTH_TOKEN)', () => {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Claude Code commonly stores credentials under settings.env (e.g. a
    // DeepSeek-style gateway): env.ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL.
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'sk-env-auth-token',
          ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        },
      }),
    );

    const result = readActiveCliConfig('claude', tempHome);
    expect(result).toEqual({
      cli: 'claude',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-env-auth-token',
      mode: 'api',
      sourcePath: path.join(claudeDir, 'settings.json'),
    });
  });

  it('reads OAuth token from credentials.json when no API key', () => {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    fs.writeFileSync(
      path.join(claudeDir, '.credentials.json'),
      JSON.stringify({ authToken: 'oauth-token-from-keychain' }),
    );

    const result = readActiveCliConfig('claude', tempHome);
    expect(result).toEqual({
      cli: 'claude',
      baseUrl: '',
      apiKey: 'oauth-token-from-keychain',
      mode: 'oauth',
      sourcePath: path.join(claudeDir, '.credentials.json'),
    });
  });

  it('handles alternative field names (anthropicApiKey, access_token)', () => {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ anthropicApiKey: 'sk-ant-alternative' }),
    );

    const result = readActiveCliConfig('claude', tempHome);
    expect(result?.apiKey).toBe('sk-ant-alternative');
  });

  it('returns null when no config exists', () => {
    const result = readActiveCliConfig('claude', tempHome);
    expect(result).toBeNull();
  });

  it('returns null when config files are malformed', () => {
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), 'invalid json{{{');

    const result = readActiveCliConfig('claude', tempHome);
    expect(result).toBeNull();
  });
});

describe('readActiveCliConfig - Codex', () => {
  it('reads OAuth token from auth.json', () => {
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });

    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      JSON.stringify({
        access_token: 'codex-oauth-token',
        refresh_token: 'codex-refresh-token',
      }),
    );

    const result = readActiveCliConfig('codex', tempHome);
    expect(result).toEqual({
      cli: 'codex',
      baseUrl: '',
      apiKey: 'codex-oauth-token',
      mode: 'oauth',
      sourcePath: path.join(codexDir, 'auth.json'),
    });
  });

  it('returns null when auth.json does not exist', () => {
    const result = readActiveCliConfig('codex', tempHome);
    expect(result).toBeNull();
  });
});

describe('readActiveCliConfig - OpenCode', () => {
  it('reads first provider from auth.json', () => {
    const opencodeDir = path.join(tempHome, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });

    fs.writeFileSync(
      path.join(opencodeDir, 'auth.json'),
      JSON.stringify({
        anthropic: {
          type: 'api',
          key: 'opencode-anthropic-key',
          baseURL: 'https://opencode-anthropic.example.com',
        },
        openai: {
          type: 'oauth',
          key: 'opencode-openai-key',
          baseURL: 'https://opencode-openai.example.com',
        },
      }),
    );

    const result = readActiveCliConfig('opencode', tempHome);
    expect(result).toBeTruthy();
    expect(result?.cli).toBe('opencode');
    expect(result?.apiKey).toMatch(/opencode-/);
  });

  it('returns null when no providers have keys', () => {
    const opencodeDir = path.join(tempHome, '.local', 'share', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });

    fs.writeFileSync(
      path.join(opencodeDir, 'auth.json'),
      JSON.stringify({ provider1: { type: 'api' } }),
    );

    const result = readActiveCliConfig('opencode', tempHome);
    expect(result).toBeNull();
  });
});

describe('readAllActiveCliConfigs', () => {
  it('returns configs for all installed CLIs', () => {
    // Set up Claude
    const claudeDir = path.join(tempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ apiKey: 'claude-key' }),
    );

    // Set up Codex
    const codexDir = path.join(tempHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'auth.json'),
      JSON.stringify({ access_token: 'codex-token' }),
    );

    const results = readAllActiveCliConfigs(tempHome);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.cli)).toEqual(expect.arrayContaining(['claude', 'codex']));
  });

  it('returns empty array when no CLIs are configured', () => {
    const results = readAllActiveCliConfigs(tempHome);
    expect(results).toEqual([]);
  });
});
