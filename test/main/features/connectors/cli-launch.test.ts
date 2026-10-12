import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

// Resolve from THIS file, never `process.cwd()`: another suite sharing the worker may chdir, which
// makes cwd-relative paths pass in isolation and fail only in a full run.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

type Launch = {
  command: string;
  args: string[];
  envPatch?: Record<string, string>;
  windowsVerbatimArguments?: boolean;
};

const launchModule = requireCjs(path.join(REPO_ROOT, 'bin', 'cli-launch.cjs')) as {
  resolveCliLaunch: (bin: string, args: string[], options?: Record<string, unknown>) => Launch;
  parseShimTarget: (
    source: string,
    shimDir: string,
    options?: Record<string, unknown>,
  ) => { kind: 'node' | 'exe'; target: string } | null;
  isWindowsCommandScript: (bin: string) => boolean;
  escapeCmdArgument: (value: string, doubleEscape: boolean) => string;
};

const adapter = requireCjs(path.join(REPO_ROOT, 'bin', 'tencent-meeting-mcp-server.cjs')) as {
  _pickBin: (candidates: string[], isExecutable: (c: string) => boolean) => string;
};

/** A real npm-global `.cmd` shim, which is what `npm install -g @tencentcloud/tmeet` drops on
 *  Windows. Reproduced verbatim in shape because the parser keys off the `%~dp0`-relative quoted
 *  tokens npm emits — a simplified fixture would test a shim that does not exist. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
    '"%dp0%\\node_modules\\@tencentcloud\\tmeet\\bin\\tmeet.js" %*',
].join('\r\n');

const SHIM_PATH = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\tmeet.cmd';
/** A `.cmd` outside the npm directories. npm shims re-parse their `%*` payload, so they take a
 *  second escaping pass; cases that are not about that depth use this path instead. */
const PLAIN_SHIM_PATH = 'C:\\tools\\tmeet.cmd';
const SCRIPT_PATH = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@tencentcloud\\tmeet\\bin\\tmeet.js';

/** Windows seams. `readFileSync`/`statSync` are stubbed so the Windows branches are reachable from
 *  a non-Windows runner — otherwise only Windows CI exercises them, which is how the gap this
 *  module closes went unnoticed in the first place. */
function windowsOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: 'win32',
    execPath: 'C:\\electron\\electron.exe',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    readFileSync: () => NPM_SHIM,
    statSync: (target: string) => {
      if (target === SCRIPT_PATH) return { isFile: () => true };
      throw new Error('ENOENT');
    },
    ...overrides,
  };
}

describe('bin/cli-launch — Windows-aware CLI launch resolution', () => {
  it('recognizes only .cmd/.bat as command scripts', () => {
    expect(launchModule.isWindowsCommandScript('tmeet.cmd')).toBe(true);
    expect(launchModule.isWindowsCommandScript('TMEET.CMD')).toBe(true);
    expect(launchModule.isWindowsCommandScript('tmeet.bat')).toBe(true);
    // A native binary is executable directly and must not be routed through a shell.
    expect(launchModule.isWindowsCommandScript('tmeet.exe')).toBe(false);
    expect(launchModule.isWindowsCommandScript('/opt/homebrew/bin/tmeet')).toBe(false);
  });

  it('is the identity off Windows, so the POSIX path gains no shell indirection', () => {
    const launch = launchModule.resolveCliLaunch('/opt/homebrew/bin/tmeet', ['record', 'list'], {
      platform: 'darwin',
    });
    expect(launch.command).toBe('/opt/homebrew/bin/tmeet');
    expect(launch.args).toEqual(['record', 'list']);
    // No env patch: the CLI owns its own account and must keep inheriting the real environment.
    expect(launch.envPatch).toBeUndefined();
    expect(launch.windowsVerbatimArguments).toBeUndefined();
  });

  it('leaves a native Windows executable alone', () => {
    const launch = launchModule.resolveCliLaunch('C:\\npm\\tmeet.exe', ['auth', 'status'], windowsOptions());
    expect(launch.command).toBe('C:\\npm\\tmeet.exe');
    expect(launch.args).toEqual(['auth', 'status']);
  });

  it('runs an npm .cmd shim through our own Node runtime instead of a shell', () => {
    const launch = launchModule.resolveCliLaunch(SHIM_PATH, ['record', 'list', '--format', 'json'], windowsOptions());

    // The whole point: no cmd.exe, so no shell metacharacters can ever be interpreted.
    expect(launch.command).toBe('C:\\electron\\electron.exe');
    expect(launch.args).toEqual([SCRIPT_PATH, 'record', 'list', '--format', 'json']);
    // The adapter child already runs as Node; the shim target is plain JS, so it needs the same
    // headless-Node mode the adapter itself is spawned with.
    expect(launch.envPatch).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
    expect(launch.windowsVerbatimArguments).toBeUndefined();
  });

  it('falls back to ComSpec with escaped arguments when the shim cannot be parsed', () => {
    const launch = launchModule.resolveCliLaunch(
      SHIM_PATH,
      ['record', 'list'],
      windowsOptions({ readFileSync: () => '@ECHO off\r\nrem nothing useful here\r\n' }),
    );

    expect(launch.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launch.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // `windowsVerbatimArguments` is required: Node must not re-quote the payload we escaped.
    expect(launch.windowsVerbatimArguments).toBe(true);
  });

  it('falls back to ComSpec when the shim file is missing rather than failing to launch', () => {
    const launch = launchModule.resolveCliLaunch(SHIM_PATH, ['auth', 'status'], windowsOptions({
      readFileSync: () => { throw new Error('ENOENT'); },
    }));
    expect(launch.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launch.windowsVerbatimArguments).toBe(true);
  });

  it('prefers ComSpec from the environment and defaults to cmd.exe', () => {
    const unparsable = { readFileSync: () => 'rem nope', statSync: () => { throw new Error('ENOENT'); } };
    expect(launchModule.resolveCliLaunch('tmeet.cmd', [], windowsOptions(unparsable)).command)
      .toBe('C:\\Windows\\System32\\cmd.exe');
    expect(launchModule.resolveCliLaunch('tmeet.cmd', [], windowsOptions({
      ...unparsable,
      env: { COMSPEC: 'D:\\cmd.exe' },
    })).command).toBe('D:\\cmd.exe');
    expect(launchModule.resolveCliLaunch('tmeet.cmd', [], windowsOptions({
      ...unparsable,
      env: {},
    })).command).toBe('cmd.exe');
  });

  // The security-relevant case: arguments reaching the adapter include model-supplied values such
  // as a meeting id or a search term. Through a shell, `&` would end the command and start another.
  it('escapes shell metacharacters in model-supplied arguments on the ComSpec path', () => {
    const injected = 'abc&calc.exe';
    const launch = launchModule.resolveCliLaunch(SHIM_PATH, ['record', 'get', injected], windowsOptions({
      readFileSync: () => 'rem nope',
      statSync: () => { throw new Error('ENOENT'); },
    }));

    const payload = launch.args[3];
    expect(payload).toContain('^&');
    // No unescaped ampersand may survive anywhere in the payload.
    expect(payload.replace(/\^&/g, '')).not.toContain('&');
    // And the escaped form must still carry the literal value, not drop it.
    expect(payload).toContain('abc');
    expect(payload).toContain('calc.exe');
  });

  it('flattens CR/LF in arguments, because cmd.exe treats them as command separators', () => {
    // A non-npm path on purpose: an `AppData\Roaming\npm\…` shim gets a second escaping pass, and
    // this case is about the CR/LF flattening, not about the escape depth.
    const launch = launchModule.resolveCliLaunch(PLAIN_SHIM_PATH, ['record', 'search', 'a\r\nwhoami'], windowsOptions({
      readFileSync: () => 'rem nope',
      statSync: () => { throw new Error('ENOENT'); },
    }));
    const payload = launch.args[3];
    expect(payload).not.toContain('\n');
    expect(payload).not.toContain('\r');
    // The newline became a space, and that space is itself escaped (cmd.exe treats space as a
    // separator too) — so both fragments stay inside one inert argv value rather than the second
    // half becoming a second command.
    expect(payload).toMatch(/a\^ whoami/);
  });

  it('double-escapes metacharacters for npm shims, which re-parse their own payload', () => {
    // npm-generated shims are the reason `spawn-command.ts` carries a second escaping pass; without
    // it a `%` or `&` survives the first parse and executes on the second. The comparison case must
    // NOT be an npm-global path — `AppData\Roaming\npm\…` is itself in the double-escape set.
    const npmPath = 'C:\\proj\\node_modules\\.bin\\tmeet.cmd';
    const plainPath = 'C:\\tools\\tmeet.cmd';
    const unparsable = {
      readFileSync: () => 'rem nope',
      statSync: () => { throw new Error('ENOENT'); },
    };
    const single = launchModule.resolveCliLaunch(plainPath, ['a&b'], windowsOptions(unparsable)).args[3];
    const double = launchModule.resolveCliLaunch(npmPath, ['a&b'], windowsOptions(unparsable)).args[3];

    const caretRuns = (value: string) => (value.match(/\^+&/g) || []).reduce((n, run) => n + run.length, 0);
    expect(caretRuns(double)).toBeGreaterThan(caretRuns(single));
  });

  it('parses a shim only when the target it names actually exists', () => {
    const present = launchModule.parseShimTarget(NPM_SHIM, path.win32.dirname(SHIM_PATH), {
      statSync: (target: string) => {
        if (target === SCRIPT_PATH) return { isFile: () => true };
        throw new Error('ENOENT');
      },
    });
    expect(present).toEqual({ kind: 'node', target: SCRIPT_PATH });

    // A shim pointing at a script that is not installed must not be trusted — the caller has to
    // fall back rather than spawn a nonexistent target.
    const missing = launchModule.parseShimTarget(NPM_SHIM, path.win32.dirname(SHIM_PATH), {
      statSync: () => { throw new Error('ENOENT'); },
    });
    expect(missing).toBeNull();
  });

  it('refuses to expand a shim target that still contains an unresolved environment variable', () => {
    // `%~dp0` is resolvable from the shim's own location; an unrelated `%SDK%` is not, so expanding
    // it would fabricate a path that was never on disk.
    const source = '"%dp0%\\%SDK%\\tmeet.js"';
    const parsed = launchModule.parseShimTarget(source, 'C:\\npm', {
      statSync: () => ({ isFile: () => true }),
    });
    expect(parsed).toBeNull();
  });
});

describe('bin/tencent-meeting-mcp-server — CLI candidate ordering', () => {
  it('prefers an absolute executable over a bare name', () => {
    const picked = adapter._pickBin(
      ['tmeet', '/opt/homebrew/bin/tmeet', '/usr/local/bin/tmeet'],
      (c) => c === '/usr/local/bin/tmeet',
    );
    // The regression this guards: testing the bare name first always won, so the absolute
    // fallbacks — the whole point of the candidate list — were never probed.
    expect(picked).toBe('/usr/local/bin/tmeet');
  });

  it('takes the first absolute candidate that exists, in list order', () => {
    expect(adapter._pickBin(['/a/tmeet', '/b/tmeet', 'tmeet'], () => true)).toBe('/a/tmeet');
    expect(adapter._pickBin(['/a/tmeet', '/b/tmeet', 'tmeet'], (c) => c === '/b/tmeet')).toBe('/b/tmeet');
  });

  it('falls back to a bare name for PATH to resolve when no absolute candidate exists', () => {
    expect(adapter._pickBin(['tmeet', '/opt/homebrew/bin/tmeet'], () => false)).toBe('tmeet');
  });

  it('keeps the Windows PATH names ordered ahead of the POSIX bare name', () => {
    expect(adapter._pickBin(['tmeet.cmd', 'tmeet.exe', 'tmeet'], () => false)).toBe('tmeet.cmd');
  });

  it('never returns an empty command, even for an empty candidate list', () => {
    expect(adapter._pickBin([], () => false)).toBe('tmeet');
  });
});

describe('bin/tencent-meeting-mcp-server — every tmeet invocation goes through the resolver', () => {
  // A source-level guard, because on POSIX the resolver is the identity and a regression back to a
  // bare `execFile(<bin>, …)` would be invisible to the behavioural tests above while failing only
  // on Windows, which is exactly how the original gap survived.
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'tencent-meeting-mcp-server.cjs'), 'utf8');
  // Strip comments before matching: the prose in this file explains the very call shape being
  // forbidden, so a naive match on the raw source fails against its own documentation. Also
  // normalize CRLF, so a checkout that ignores `.gitattributes`' `eol=lf` cannot fail a
  // line-continuation assertion for a reason that has nothing to do with the code.
  const source = raw
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('has no raw invocation left with the unresolved binary', () => {
    expect(source).not.toMatch(/execFile\(bin\s*,/);
    expect(source).not.toMatch(/spawn\)\(\s*bin\s*,/);
    expect(source).not.toMatch(/^\s*bin,\s*$/m);
  });

  it('routes all three invocation sites through _launchFor', () => {
    const callSites = source.match(/const launch = _launchFor\(/g) || [];
    expect(callSites).toHaveLength(3);
    expect(source).toContain('execFile(launch.command, launch.args');
    expect(source).toContain('launch.command,\n    launch.args,');
  });

  it('requires the helper as a sibling, so the packaged layout resolves it', () => {
    expect(source).toContain("require('./cli-launch.cjs')");
  });
});
