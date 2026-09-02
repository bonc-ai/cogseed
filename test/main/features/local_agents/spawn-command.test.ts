import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildCliSpawnEnv,
  hasNodeOnPath,
  isNodeShebangScript,
  resolveCliCommand,
} from '../../../../src/main/features/local_agents/spawn-command';

const TEST_NODE = process.env.COGSEED_TEST_NODE || process.execPath;

describe('local_agents/spawn-command', () => {
  it('leaves native executables unchanged', () => {
    expect(resolveCliCommand('/usr/local/bin/claude', ['--version'], 'darwin')).toEqual({
      command: '/usr/local/bin/claude',
      args: ['--version'],
    });
    expect(resolveCliCommand('C:\\Tools\\codex.exe', ['run'], 'win32')).toEqual({
      command: 'C:\\Tools\\codex.exe',
      args: ['run'],
    });
  });

  it('routes Windows command shims through ComSpec with shell metacharacters escaped', () => {
    const resolved = resolveCliCommand(
      'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd',
      ['--model', 'value & echo unsafe', '100%'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    );

    expect(resolved.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(resolved.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(resolved.args[3]).toContain('claude.cmd');
    expect(resolved.args[3]).toContain('^^^&');
    expect(resolved.args[3]).toContain('^^^%');
    expect(resolved.windowsVerbatimArguments).toBe(true);
  });

  it('recognizes case-insensitive .bat shims and falls back to cmd.exe', () => {
    const resolved = resolveCliCommand('C:\\Tools\\RUN.BAT', ['one'], 'win32', {});

    expect(resolved.command).toBe('cmd.exe');
    expect(resolved.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(resolved.windowsVerbatimArguments).toBe(true);
  });

  it.runIf(process.platform === 'win32')('round-trips hostile arguments through a real npm-style .cmd shim', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cmd-shim-'));
    try {
      const capture = path.join(tmpDir, 'capture.cjs');
      const shim = path.join(tmpDir, 'node_modules', '.bin', 'capture.cmd');
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      fs.writeFileSync(shim, [
        '@echo off',
        `"%COGSEED_TEST_NODE%" "${capture}" %*`,
        '',
      ].join('\r\n'));
      const args = ['plain', 'space value', 'value & echo unsafe', '100%', 'quote"value', 'C:\\tail\\'];
      const env = {
        ...process.env,
        COGSEED_TEST_NODE: TEST_NODE,
        ComSpec: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      };
      const resolved = resolveCliCommand(shim, args, 'win32', env);
      const result = spawnSync(resolved.command, resolved.args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('augments a minimal macOS GUI PATH for npm-installed CLIs', () => {
    const env = buildCliSpawnEnv(
      '/Users/user/.npm-global/bin/codex',
      { PATH: '/usr/bin:/bin' },
      'darwin',
      '/Users/user',
    );
    const entries = env.PATH!.split(':');

    expect(entries).toEqual(expect.arrayContaining([
      '/Users/user/.npm-global/bin',
      '/Users/user/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]));
    expect(entries.filter(entry => entry === '/usr/bin')).toHaveLength(1);
  });

  it('builds a case-insensitive, semicolon-delimited Windows PATH', () => {
    const env = buildCliSpawnEnv(
      'C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd',
      {
        Path: 'C:\\Windows\\System32;C:\\Tools;c:\\tools',
        APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
        VOLTA_HOME: 'C:\\Users\\Alice\\.volta',
        PNPM_HOME: 'D:\\pnpm',
      },
      'win32',
      'C:\\Users\\Alice',
    );
    const entries = env.PATH!.split(';');

    expect(entries.slice(0, 2)).toEqual(['C:\\Windows\\System32', 'C:\\Tools']);
    expect(entries.filter(entry => entry.toLowerCase() === 'c:\\tools')).toHaveLength(1);
    expect(entries).toEqual(expect.arrayContaining([
      'C:\\Users\\Alice\\AppData\\Roaming\\npm',
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\nodejs',
      'C:\\Users\\Alice\\.volta\\bin',
      'D:\\pnpm',
    ]));
  });

  it('expands node version-manager dirs (nvm/fnm/asdf) into the spawn PATH', () => {
    // This version-manager layout is a POSIX-only home layout; the win32
    // branch of buildCliSpawnEnv is covered by the dedicated Windows tests.
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-env-test-'));
    try {
      const dirs = [
        path.join(root, '.nvm', 'versions', 'node', 'v20.11.0', 'bin'),
        path.join(root, '.local', 'share', 'fnm', 'node-versions', 'v18.20.0', 'installation', 'bin'),
        path.join(root, '.asdf', 'installs', 'nodejs', '22.3.0', 'bin'),
        path.join(root, '.asdf', 'shims'),
      ];
      for (const d of dirs) fs.mkdirSync(d, { recursive: true });
      const env = buildCliSpawnEnv('/usr/local/bin/codex', { PATH: '/usr/bin:/bin' }, 'darwin', root);
      const entries = env.PATH!.split(':');
      expect(entries).toEqual(expect.arrayContaining(dirs));
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('spawn-command · node fallback (WorkBuddy codebuddy without system node)', () => {
  function makeTempScript(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-command-test-'));
    const file = path.join(dir, 'cli-script');
    fs.writeFileSync(file, contents);
    fs.chmodSync(file, 0o755);
    return file;
  }

  it('detects a node shebang script', () => {
    const script = makeTempScript('#!/usr/bin/env node\nconsole.log("hi");\n');
    expect(isNodeShebangScript(script)).toBe(true);
    const native = makeTempScript('\u007fELF native binary');
    expect(isNodeShebangScript(native)).toBe(false);
  });

  it('detects node presence on the spawn PATH', () => {
    // The sanctioned test runner executes under Electron-as-Node, so
    // dirname(process.execPath) contains no `node` file — point PATH at a
    // real node binary instead of assuming the runtime's own directory.
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-node-path-'));
    try {
      const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
      fs.writeFileSync(path.join(nodeDir, nodeName), '');
      const envWithNode = { PATH: nodeDir };
      expect(hasNodeOnPath(envWithNode, process.platform)).toBe(true);
    } finally {
      fs.rmSync(nodeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    const envWithoutNode = { PATH: ['/nonexistent-a', '/nonexistent-b'].join(path.delimiter) };
    expect(hasNodeOnPath(envWithoutNode, process.platform)).toBe(false);
  });

  it('falls back to Electron node when the script needs node but PATH has none', () => {
    const script = makeTempScript('#!/usr/bin/env node\nconsole.log("1.2.3");\n');
    const noNodeEnv = { PATH: '/nonexistent-a:/nonexistent-b' };
    const resolved = resolveCliCommand(script, ['--version'], 'darwin', noNodeEnv);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([script, '--version']);
    expect(resolved.envPatch).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('runs a node-shebang script directly when node is on the spawn PATH', () => {
    // On Windows there is no kernel shebang support: node-shebang scripts are
    // intentionally routed through Electron's Node runtime (see
    // resolveCliCommand); the direct-exec behavior is POSIX-only.
    if (process.platform === 'win32') return;
    const script = makeTempScript('#!/usr/bin/env node\nconsole.log("x");\n');
    // Same Electron-as-Node caveat as above: provide an explicit node binary
    // so the "node present" branch is deterministic on every runner.
    const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-node-dir-'));
    try {
      fs.writeFileSync(path.join(nodeDir, 'node'), '');
      const envWithNode = buildCliSpawnEnv(script, { PATH: nodeDir });
      const resolved = resolveCliCommand(script, ['--version'], 'darwin', envWithNode);
      expect(resolved.command).toBe(script);
      expect(resolved.envPatch).toBeUndefined();
    } finally {
      fs.rmSync(nodeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('leaves native executables unchanged even without node on PATH', () => {
    const native = '/usr/bin/true';
    const resolved = resolveCliCommand(native, [], 'darwin', { PATH: '/nonexistent' });
    expect(resolved.command).toBe(native);
    expect(resolved.envPatch).toBeUndefined();
  });
});
