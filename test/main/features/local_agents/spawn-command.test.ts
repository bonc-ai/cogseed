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
  selectWindowsShimScriptToken,
  windowsShimTokens,
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

  it.runIf(process.platform === 'win32')('round-trips hostile arguments and preserves text after line breaks through a real npm-style .cmd shim', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cmd-shim-'));
    try {
      const shim = path.join(tmpDir, 'node_modules', '.bin', 'capture.cmd');
      const capture = path.join(path.dirname(shim), 'capture.cjs');
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      fs.writeFileSync(shim, [
        '@echo off',
        '"%COGSEED_TEST_NODE%" "%dp0%\\capture.cjs" %*',
        '',
      ].join('\r\n'));
      const args = [
        'plain',
        'space value',
        'value & pipe | in < out > caret ^ (group)',
        '100% !delayed!',
        'quote"value',
        'C:\\tail\\',
        '第一行\r\n第二行 & "quoted" %value%\n第三行 ^ (done)',
      ];
      const env = {
        ...process.env,
        COGSEED_TEST_NODE: TEST_NODE,
        ComSpec: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      };
      const resolved = resolveCliCommand(shim, args, 'win32', env);
      const result = spawnSync(resolved.command, resolved.args, {
        encoding: 'utf8',
        env: { ...env, ...resolved.envPatch },
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it.runIf(process.platform === 'win32')('round-trips a multiline prompt through a real .bat Node shim', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-bat-shim-'));
    try {
      const shim = path.join(tmpDir, 'capture.BAT');
      const capture = path.join(tmpDir, 'capture.cjs');
      fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      fs.writeFileSync(shim, '@echo off\r\n"%COGSEED_TEST_NODE%" "%~dp0\\capture.cjs" %*\r\n');
      const args = ['第一行\n第二行 & "quoted" %value% | < > ^ (third)'];
      const env = { ...process.env, COGSEED_TEST_NODE: TEST_NODE };
      const resolved = resolveCliCommand(shim, args, 'win32', env);
      const result = spawnSync(resolved.command, resolved.args, {
        encoding: 'utf8',
        env: { ...env, ...resolved.envPatch },
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

// 对照 Orkas 的事故记录（2026-10-08 审计 P0）：Electron 的进程控制变量是「我们的」，
// 不是 CLI 的。CLI agent 会跑任意用户命令，从它启动的 Electron 应用若继承
// ELECTRON_RUN_AS_NODE，会以纯 Node 启动然后「秒退」——agent 把这假失败当真去 debug。
describe('buildCliSpawnEnv › Electron 进程控制变量不得泄漏给 CLI', () => {
  it('strips ELECTRON_RUN_AS_NODE / ELECTRON_NO_ASAR and keeps the user env', async () => {
    const { buildCliSpawnEnv } = await import('../../../../src/main/features/local_agents/spawn-command');
    const out = buildCliSpawnEnv('/usr/local/bin/claude', {
      PATH: '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      HOME: '/Users/someone',
      ANTHROPIC_API_KEY: 'sk-test',
    } as NodeJS.ProcessEnv, 'darwin', '/Users/someone');

    expect(out.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(out.ELECTRON_NO_ASAR).toBeUndefined();
    // 用户环境原样保留（我们只摘掉自己的变量）
    expect(out.HOME).toBe('/Users/someone');
    expect(out.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(out.PATH).toContain('/usr/bin');
    // PATH 仍按平台补齐 CLI 自身目录
    expect(out.PATH).toContain('/usr/local/bin');
  });
});

// B1：登录 shell PATH 必须真正进入 CLI 子进程环境（顺序：继承环境 → 登录 shell → 约定目录）
describe('buildCliSpawnEnv › 登录 shell PATH', () => {
  it('appends cached login-shell dirs and keeps user order first', async () => {
    const { buildCliSpawnEnv } = await import('../../../../src/main/features/local_agents/spawn-command');
    const shellEnv = await import('../../../../src/main/util/login-shell-env');
    shellEnv._setLoginShellPathDirsForTest(['/Users/x/company-bin']);
    try {
      const out = buildCliSpawnEnv('/usr/local/bin/claude', {
        PATH: '/usr/bin:/bin',
      } as NodeJS.ProcessEnv, 'darwin', '/Users/x');
      const dirs = String(out.PATH).split(':');
      expect(dirs).toContain('/Users/x/company-bin');
      // 用户/继承顺序在前，登录 shell 目录在约定目录（/opt/homebrew/bin 等）之前
      expect(dirs.indexOf('/usr/bin')).toBeLessThan(dirs.indexOf('/Users/x/company-bin'));
      expect(dirs.indexOf('/Users/x/company-bin')).toBeLessThan(dirs.indexOf('/opt/homebrew/bin'));
    } finally {
      shellEnv._setLoginShellPathDirsForTest(null);
    }
  });

  it('does not consult the login shell on Windows', async () => {
    const { buildCliSpawnEnv } = await import('../../../../src/main/features/local_agents/spawn-command');
    const shellEnv = await import('../../../../src/main/util/login-shell-env');
    shellEnv._setLoginShellPathDirsForTest(['/Users/x/company-bin']);
    try {
      const out = buildCliSpawnEnv('C:\\npm\\claude.cmd', {
        PATH: 'C:\\Windows;C:\\Windows\\System32',
      } as NodeJS.ProcessEnv, 'win32', 'C:\\Users\\x');
      expect(String(out.PATH)).not.toContain('/Users/x/company-bin');
    } finally {
      shellEnv._setLoginShellPathDirsForTest(null);
    }
  });
});

// 例外：目标是我们自己这个可执行文件时，必须把 ELECTRON_RUN_AS_NODE 放回去。
// 打包版里我们自己拉起的 bridge/worker、以及 Electron-as-Node 测试宿主都靠它
// 才有 Node 语义；剥离会让子进程以 GUI 形态启动然后一直不说话（MCP 那条测试
// 就是被这个坑卡了 30s 超时）。
describe('buildCliSpawnEnv › 自身可执行文件例外', () => {
  it('restores the marker only for our own executable under an Electron host', async () => {
    const { shouldRestoreRunAsNode } = await import('../../../../src/main/features/local_agents/spawn-command');
    const execPath = '/Applications/CogSeed.app/Contents/MacOS/CogSeed';

    expect(shouldRestoreRunAsNode(execPath, { execPath, isElectron: true })).toBe(true);
    // 同一个路径但在纯 Node 宿主里：没有 Electron 语义可依赖，保持剥离
    expect(shouldRestoreRunAsNode(execPath, { execPath, isElectron: false })).toBe(false);
    // Electron 宿主里的**用户 CLI**：标记不得泄漏
    expect(shouldRestoreRunAsNode('/usr/local/bin/claude', { execPath, isElectron: true })).toBe(false);
    // 无法解析的路径：按剥离处理
    expect(shouldRestoreRunAsNode('', { execPath, isElectron: true })).toBe(false);
  });

  it('keeps the marker stripped for a user CLI through the full env builder', async () => {
    const { buildCliSpawnEnv } = await import('../../../../src/main/features/local_agents/spawn-command');
    const out = buildCliSpawnEnv('/usr/local/bin/claude', {
      PATH: '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
    } as NodeJS.ProcessEnv, 'darwin', '/Users/x');
    expect(out.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(out.ELECTRON_NO_ASAR).toBeUndefined();
  });
});

describe('spawn-command · Windows 真机：npm 模板 shim 必须走直连 node', () => {
  // 与上一条同源：真机上 npm 家族 shim 是 `SET "VAR=%~dp0\…"` 形式，
  // 修复前永远解析失败 → 落 cmd.exe。这条用例把"修复后真的走直连"钉在真机上。
  it.runIf(process.platform === 'win32')('runs a SET-style npm shim through the process Node instead of cmd.exe', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-npm-shim-'));
    try {
      const binDir = path.join(tmpDir, 'node_modules', '.bin');
      const cli = path.join(tmpDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const shim = path.join(binDir, 'npm.cmd');
      fs.writeFileSync(shim, [
        '@ECHO OFF',
        'SETLOCAL',
        'SET "NODE_EXE=%~dp0\\node.exe"',
        'SET "NPM_CLI_JS=%~dp0\\..\\npm\\bin\\npm-cli.js"',
        '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
        '',
      ].join('\r\n'));

      const args = ['install', 'a&b', '第一行\r\n第二行 & "q" %v%', 'trailing\\'];
      const resolved = resolveCliCommand(shim, args, 'win32', process.env);
      // 直连 node：命令是进程自身、带 ELECTRON_RUN_AS_NODE，且 args 第一个是 JS 入口
      expect(resolved.command).not.toMatch(/cmd\.exe$/i);
      expect(resolved.envPatch?.ELECTRON_RUN_AS_NODE).toBe('1');
      expect(resolved.args[0]).toBe(cli);

      const result = spawnSync(resolved.command, resolved.args, { encoding: 'utf8', env: { ...process.env, ...resolved.envPatch } });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('spawn-command · Windows shim token parsing (fixtures from a real Windows npm.cmd)', () => {
  // 模板取自 Windows 真机验收报告里的 `npm.cmd`（Node 24 自带 npm 的 shim）。
  const NPM_SHIM = [
    ':: Created by npm, please don\'t edit manually.',
    '@ECHO OFF',
    '',
    'SETLOCAL',
    '',
    'SET "NODE_EXE=%~dp0\\node.exe"',
    'IF NOT EXIST "%NODE_EXE%" (',
    '  SET "NODE_EXE=node"',
    ')',
    '',
    'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
    'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
    'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
    '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
    ')',
    'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
    '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
    ')',
    '',
    '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
    '',
  ].join('\r\n');

  it('strips the SET "VAR=" prefix so the real npm shim resolves to its JS entry', () => {
    // 缺陷形态：不剥前缀会得到 `<dir>\NPM_CLI_JS=%~dp0\node_modules\...`，
    // 该路径必然不存在 → 解析失败 → 每次 npm 启动都回落 cmd.exe 二次解析。
    expect(windowsShimTokens(NPM_SHIM)).toContain('%~dp0\\node_modules\\npm\\bin\\npm-cli.js');
    expect(selectWindowsShimScriptToken(NPM_SHIM)).toBe('%~dp0\\node_modules\\npm\\bin\\npm-cli.js');
    // 变量间接赋值（%NPM_CLI_JS%）不是字面路径 → 不可选
    expect(selectWindowsShimScriptToken(NPM_SHIM)).not.toContain('=');
  });

  it('keeps resolving bare-path shims (pnpm / yarn / older npm templates)', () => {
    const bare = '@ECHO OFF\r\n"node" "%~dp0\\cli.js" %*\r\n';
    expect(selectWindowsShimScriptToken(bare)).toBe('%~dp0\\cli.js');
    const pnpm = '@ECHO OFF\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\n"%NODE_EXE%" "%~dp0\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n';
    expect(selectWindowsShimScriptToken(pnpm)).toBe('%~dp0\\node_modules\\pnpm\\bin\\pnpm.cjs');
    const yarn = '@ECHO OFF\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\n"%NODE_EXE%" "%~dp0\\node_modules\\yarn\\bin\\yarn.js" %*\r\n';
    expect(selectWindowsShimScriptToken(yarn)).toBe('%~dp0\\node_modules\\yarn\\bin\\yarn.js');
  });

  it('returns null when the shim only ever references variables (no literal JS path)', () => {
    expect(selectWindowsShimScriptToken('@ECHO OFF\r\n"%SOMEWHERE%\\cli.js" %*\r\n')).toBeNull();
    expect(selectWindowsShimScriptToken('')).toBeNull();
  });
});
