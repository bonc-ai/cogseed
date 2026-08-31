import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSemver,
  compareSemver,
  checkMinVersion,
  redactSecret,
  localCliSearchDirs,
  whichBin,
  parseClaudeSettings,
  parseCodexAuth,
  parseOpencodeAuth,
  parseShellProfile,
  buildExpectedSnapshot,
  compareExpected,
  inspectCliConfig,
  expandSearchDirs,
  runVersionProbe,
  BIN_NAMES,
  ENV_KEYS,
} from '../../scripts/diagnose-local-agents.mjs';

describe('diagnose-local-agents: semver helpers', () => {
  it('parses the first MAJOR.MINOR.PATCH triple and ignores junk', () => {
    expect(parseSemver('v2.1.223')).toEqual({ major: 2, minor: 1, patch: 223 });
    expect(parseSemver('0.144.5')).toEqual({ major: 0, minor: 144, patch: 5 });
    expect(parseSemver('garbage')).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
  });

  it('compares semvers and enforces the documented minimums', () => {
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 1, minor: 99, patch: 0 })).toBe(1);
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 0 })).toBe(0);
    expect(compareSemver({ major: 2, minor: 0, patch: 0 }, { major: 2, minor: 0, patch: 1 })).toBe(-1);
    expect(checkMinVersion('claude', '1.9.9')).toMatch(/低于要求的最低版本 2\.0\.0/);
    expect(checkMinVersion('claude', '2.0.0')).toBeNull();
    expect(checkMinVersion('codex', '0.99.0')).toMatch(/低于要求的最低版本 0\.100\.0/);
    expect(checkMinVersion('codex', '0.100.0')).toBeNull();
    // No documented minimum → never gate.
    expect(checkMinVersion('opencode', '0.1.0')).toBeNull();
  });
});

describe('diagnose-local-agents: redaction', () => {
  it('never exposes more than 4+4 chars of a secret', () => {
    expect(redactSecret('sk-abcdefghijklmnop')).toContain('(len 19)');
    expect(redactSecret('sk-abcdefghijklmnop')).not.toContain('abcdefgh');
    expect(redactSecret('')).toBe('(empty)');
    expect(redactSecret('12345678')).toBe('***(8)');
  });
});

describe('diagnose-local-agents: search dirs mirror registry.ts', () => {
  it('covers homebrew + user-local dirs on POSIX', () => {
    const dirs = localCliSearchDirs('claude', 'darwin', {}, '/Users/tester');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/Users/tester/.local/bin');
    expect(dirs).toContain('/Users/tester/.npm-global/bin');
    expect(dirs).toContain('/Users/tester/.nvm/versions/node/*/bin');
  });

  it('adds codex standalone and WorkBuddy bundle locations', () => {
    const codexDirs = localCliSearchDirs('codex', 'darwin', {}, '/Users/tester');
    expect(codexDirs).toContain('/Users/tester/.codex/bin');
    expect(codexDirs).toContain('/Applications/Codex.app/Contents/Resources');
    const wbDirs = localCliSearchDirs('workbuddy', 'darwin', {}, '/Users/tester');
    expect(wbDirs.some((d) => d.includes('WorkBuddy.app'))).toBe(true);
    expect(wbDirs.some((d) => d.includes('app.asar.unpacked/cli/bin'))).toBe(true);
  });

  it('covers npm / WindowsApps / Codex on win32', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' };
    const dirs = localCliSearchDirs('codex', 'win32', env, 'C:\\Users\\tester');
    expect(dirs).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm');
    expect(dirs).toContain('C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps');
    expect(dirs.some((d) => d.includes('OpenAI\\Codex\\bin'))).toBe(true);
    expect(dirs).toContain('C:\\Users\\tester\\AppData\\Local\\OpenAI\\Codex\\bin\\*');

    const wbDirs = localCliSearchDirs('workbuddy', 'win32', env, 'C:\\Users\\tester');
    expect(wbDirs.some((d) => d.includes('WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin'))).toBe(true);
  });

  it('expands version-manager wildcard segments only when the tail exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-expand-'));
    const install = path.join(tmp, 'node', 'v20.1.0', 'bin');
    fs.mkdirSync(install, { recursive: true });
    const expanded = await expandSearchDirs([path.join(tmp, 'node', '*', 'bin')]);
    expect(expanded).toContain(install);
    // A matching dir without the tail must not be emitted.
    fs.mkdirSync(path.join(tmp, 'node', 'v22.0.0'), { recursive: true });
    const expanded2 = await expandSearchDirs([path.join(tmp, 'node', '*', 'bin')]);
    expect(expanded2).not.toContain(path.join(tmp, 'node', 'v22.0.0', 'bin'));
  });
});

describe('diagnose-local-agents: binary lookup mirrors which.ts', () => {
  it.runIf(process.platform !== 'win32')('finds an executable via extraDirs and skips non-executables on POSIX', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-which-'));
    const good = path.join(tmp, 'claude');
    const bad = path.join(tmp, 'codex');
    fs.writeFileSync(good, '#!/bin/sh\n');
    fs.writeFileSync(bad, '#!/bin/sh\n');
    fs.chmodSync(good, 0o755);
    fs.chmodSync(bad, 0o644);
    const found = await whichBin('claude', { extraDirs: [tmp], env: { PATH: '' } });
    expect(found).toBe(good);
    const notFound = await whichBin('codex', { extraDirs: [tmp], env: { PATH: '' } });
    expect(notFound).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('honors an absolute override path exactly like COGSEED_<TYPE>_PATH', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-which-abs-'));
    const abs = path.join(tmp, 'my-claude');
    fs.writeFileSync(abs, '#!/bin/sh\n');
    fs.chmodSync(abs, 0o755);
    expect(await whichBin(abs, { env: { PATH: '' } })).toBe(abs);
    expect(await whichBin(path.join(tmp, 'missing'), { env: { PATH: '' } })).toBeNull();
  });

  it('probes an extensionless Windows shim through its .cmd sibling', async () => {
    if (process.platform !== 'win32') return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-win-shim-'));
    const script = path.join(tmp, 'version-agent.cjs');
    const shim = path.join(tmp, 'version-agent');
    fs.writeFileSync(script, "process.stdout.write('version-agent 9.8.7\n');\n");
    fs.writeFileSync(shim, '#!/bin/sh\n');
    fs.writeFileSync(`${shim}.cmd`, '@echo off\r\necho version-agent 9.8.7\r\n');
    await expect(runVersionProbe(shim, ['--version'], { platform: 'win32', env: process.env })).resolves.toBe('9.8.7');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('skips a bare npm bash shim and falls through to the .cmd shim', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-which-win-'));
    const bare = path.join(tmp, 'claude');
    const cmd = path.join(tmp, 'claude.CMD');
    fs.writeFileSync(bare, '#!/bin/sh\necho hi\n');
    fs.writeFileSync(cmd, '@echo off\r\n');
    const found = await whichBin('claude', { extraDirs: [tmp], env: { PATH: '', PATHEXT: '.CMD' } });
    expect(found?.toLowerCase()).toBe(cmd.toLowerCase());
  });
});

describe('diagnose-local-agents: config parsers redact and normalize', () => {
  it('parses claude settings.json api-key / env-key / baseUrl shapes', () => {
    const parsed = parseClaudeSettings({
      env: { ANTHROPIC_AUTH_TOKEN: 'sk-1234567890abcdef' },
      anthropicBaseUrl: 'http://127.0.0.1:8899',
    });
    expect(parsed.apiKeyPresent).toBe(false);
    expect(parsed.envKeyPresent).toBe(true);
    expect(parsed.envKeyNames).toEqual(['ANTHROPIC_AUTH_TOKEN']);
    expect(parsed.baseUrl).toBe('http://127.0.0.1:8899');
    const top = parseClaudeSettings({ apiKey: 'sk-abcdefgh' });
    expect(top.apiKeyPresent).toBe(true);
    expect(top.keyPresent ?? top.apiKeyHint).toBeDefined();
  });

  it('parses codex auth.json oauth and OPENAI_API_KEY shapes', () => {
    const oauth = parseCodexAuth({ access_token: 'tok-1234567890', refresh_token: 'r' });
    expect(oauth).toMatchObject({ mode: 'oauth', keyPresent: true });
    const keyed = parseCodexAuth({ OPENAI_API_KEY: 'sk-1234567890' });
    expect(keyed).toMatchObject({ mode: 'api', keyPresent: true });
    expect(parseCodexAuth({})).toMatchObject({ mode: null, keyPresent: false });
  });

  it('parses opencode multi-provider auth.json and takes the first keyed entry', () => {
    const parsed = parseOpencodeAuth({
      anthropic: { type: 'oauth', key: 'tok-1' },
      local: { type: 'api', key: '', baseURL: 'http://localhost:11434/v1' },
    });
    expect(parsed.mode).toBe('oauth');
    expect(parsed.keyPresent).toBe(true);
    expect(parsed.providers).toEqual(['anthropic', 'local']);
    expect(parsed.baseUrl).toBe('');
  });

  it('inspects claude config files under a fake HOME without leaking keys', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-cfg-'));
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.writeFileSync(path.join(tmp, '.claude', 'settings.json'), JSON.stringify({ apiKey: 'sk-verysecretvalue123' }));
    const cfg = inspectCliConfig('claude', tmp);
    expect(cfg.loggedIn).toBe(true);
    expect(cfg.authMode).toBe('api');
    expect(cfg.keyHint).toContain('(len ');
    expect(cfg.keyHint).not.toContain('verysecret');
    expect(cfg.files.some((f) => f.label === 'settings.json' && f.exists)).toBe(true);
  });
});

describe('diagnose-local-agents: shell profiles', () => {
  it('extracts PATH entries and exported variable names only', () => {
    const parsed = parseShellProfile([
      '# comment',
      'export PATH="$HOME/.local/bin:$PATH"',
      'export ANTHROPIC_API_KEY=sk-1234',
      'FOO=bar',
    ].join('\n'));
    expect(parsed.pathEntries).toContain('$HOME/.local/bin');
    expect(parsed.exportedKeys).toContain('ANTHROPIC_API_KEY');
    expect(parsed.exportedKeys).toContain('FOO');
    expect(parsed.exportedKeys).not.toContain('PATH');
  });
});

describe('diagnose-local-agents: expected-config snapshot comparison', () => {
  function fakeResult(overrides = {}) {
    return {
      type: 'claude',
      binName: 'claude',
      envKey: 'COGSEED_CLAUDE_PATH',
      binary: { found: true, path: '/bin/claude', realPath: null, source: 'path' },
      version: { value: '2.1.0', minRequired: '2.0.0', probeError: null },
      available: true,
      error: null,
      errorDetail: null,
      config: {
        files: [{ label: 'settings.json', path: '/h/.claude/settings.json', exists: true, parseError: null }],
        authMode: 'api', loggedIn: true, keyPresent: true, keyHint: 'sk-1…234 (len 20)',
        baseUrl: 'https://api.example.com', notes: [],
      },
      endpoint: { baseUrl: 'https://api.example.com', isLocalProxy: false, reachable: null },
      verdict: 'ok',
      notes: [],
      ...overrides,
    };
  }

  it('builds a redacted snapshot and flags real differences', () => {
    const snapshot = buildExpectedSnapshot([fakeResult()]);
    expect(JSON.stringify(snapshot)).not.toContain('sk-1…234');
    expect(snapshot.clis.claude.authMode).toBe('api');

    const diffs = compareExpected(snapshot, [
      fakeResult({ config: { ...fakeResult().config, authMode: 'oauth', baseUrl: 'http://127.0.0.1:8899' } }),
    ]);
    expect(diffs.map((d) => d.kind).sort()).toEqual(['auth', 'endpoint']);

    // Snapshot says installed but this machine has nothing.
    const missingDiffs = compareExpected(snapshot, [
      fakeResult({ binary: { found: false, path: null, realPath: null, source: null }, error: 'not_found' }),
    ]);
    expect(missingDiffs.some((d) => d.kind === 'binary')).toBe(true);

    // Broken snapshot reports a snapshot-level diff instead of throwing.
    expect(compareExpected(null, [fakeResult()])[0].kind).toBe('snapshot');
  });
});

describe('diagnose-local-agents: constant registry stays in sync with the app', () => {
  it('knows every CLI, its binary name, and its env override key', () => {
    expect(Object.keys(BIN_NAMES)).toEqual(['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy', 'gemini', 'aider']);
    expect(BIN_NAMES.claude).toBe('claude');
    expect(BIN_NAMES.workbuddy).toBe('codebuddy');
    expect(ENV_KEYS.claude).toBe('COGSEED_CLAUDE_PATH');
    expect(ENV_KEYS.workbuddy).toBe('COGSEED_WORKBUDDY_PATH');
    expect(ENV_KEYS.gemini).toBe('COGSEED_GEMINI_PATH');
    expect(ENV_KEYS.aider).toBe('COGSEED_AIDER_PATH');
  });
});
