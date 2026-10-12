/**
 * Windows install hand-off: re-verification of the on-disk artifact before the
 * detached helper is spawned, the argv contract the helper depends on, and the
 * quit that lets the installer replace locked files.
 *
 * The runtime is always injected (spawnDetached/quit are doubles), so no test
 * spawns a process or quits Electron. `helperPathForTest` points at a real
 * temporary file, because the hand-off pre-checks that the helper exists; the
 * production default is covered through `resolveApplyUpdateHelperPath`, which is
 * pure and platform-agnostic.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Only `defaultWindowsInstallRuntime.spawnDetached` uses the real `spawn`; every
// install-hand-off case injects a runtime double instead, so this mock only
// affects the spawn-options cases below.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';

import {
  defaultWindowsInstallRuntime,
  installDownloadedUpdate,
  resolveApplyUpdateHelperPath,
} from '../../../../src/main/features/updater/installer';

const spawnMock = vi.mocked(spawn);

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-upd-'));
}

function writeInstallerFile(dir: string, content: Buffer): { file: string; sha256: string } {
  const file = path.join(dir, 'CogSeed-0.0.9-win-x64.exe');
  fs.writeFileSync(file, content);
  return { file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

/**
 * The hand-off refuses to spawn a helper script that does not exist, so the
 * happy paths need a real file. It lives in a `bin/` subdirectory so the log
 * path cannot be confused with the installer's own directory.
 */
function writeHelperFile(dir: string): string {
  const helperDir = path.join(dir, 'bin');
  fs.mkdirSync(helperDir, { recursive: true });
  const helper = path.join(helperDir, 'apply-update.cjs');
  fs.writeFileSync(helper, '// apply-update helper placeholder\n');
  return helper;
}

function windowsRuntime(spawnDetached = vi.fn(() => Promise.resolve(1234))) {
  const quit = vi.fn();
  return {
    spawnDetached,
    quit,
    runtime: {
      platform: 'win32' as const,
      execPath: 'C:\\App\\CogSeed.exe',
      pid: 4242,
      spawnDetached,
      quit,
    },
  };
}

describe('installDownloadedUpdate', () => {
  it('spawns the helper with the app pid, installer path and log path, then quits', async () => {
    const dir = makeTempDir();
    const { file, sha256 } = writeInstallerFile(dir, Buffer.from('installer'));
    const helper = writeHelperFile(dir);
    const { runtime, spawnDetached, quit } = windowsRuntime();

    await installDownloadedUpdate({
      installerPath: file,
      sha256,
      helperPathForTest: helper,
      runtime,
    });

    expect(spawnDetached).toHaveBeenCalledTimes(1);
    const [exe, args, env] = spawnDetached.mock.calls[0] as unknown as [string, string[], Record<string, string>];
    expect(exe).toBe('C:\\App\\CogSeed.exe');
    // The helper path must be absolute: the detached child's cwd is not
    // dependable for a packaged GUI app.
    expect(args[0]).toBe(helper);
    expect(path.isAbsolute(args[0])).toBe(true);
    expect(args[1]).toBe('4242');
    expect(args[2]).toBe(file);
    // The child's stderr is discarded, so the log path is the only durable
    // evidence channel the helper has. It must be absolute and independent of
    // the helper/install location.
    expect(args[3]).toBe(path.join(path.dirname(file), 'apply-update.log'));
    expect(path.isAbsolute(args[3])).toBe(true);
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('does not quit when the spawn itself fails', async () => {
    const dir = makeTempDir();
    const { file, sha256 } = writeInstallerFile(dir, Buffer.from('installer'));
    const helper = writeHelperFile(dir);
    const { runtime, quit } = windowsRuntime(vi.fn(() => Promise.reject(new Error('spawn ENOENT'))));

    await expect(installDownloadedUpdate({
      installerPath: file,
      sha256,
      helperPathForTest: helper,
      runtime,
    })).rejects.toThrow(/ENOENT/);

    expect(quit).not.toHaveBeenCalled();
  });

  it('refuses to hand off when the helper script is missing, without spawning or quitting', async () => {
    const dir = makeTempDir();
    const { file, sha256 } = writeInstallerFile(dir, Buffer.from('installer'));
    const { runtime, spawnDetached, quit } = windowsRuntime();

    await expect(installDownloadedUpdate({
      installerPath: file,
      sha256,
      // Never created: the interpreter (the app binary) would spawn fine and
      // exit 1 with stderr discarded, so absence must be caught up front.
      helperPathForTest: path.join(dir, 'bin', 'apply-update.cjs'),
      runtime,
    })).rejects.toThrow(/helper not found/i);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('refuses to install when the on-disk checksum no longer matches', async () => {
    const dir = makeTempDir();
    const { file } = writeInstallerFile(dir, Buffer.from('tampered'));
    const helper = writeHelperFile(dir);
    const { runtime, spawnDetached, quit } = windowsRuntime();

    await expect(installDownloadedUpdate({
      installerPath: file,
      sha256: 'f'.repeat(64),
      helperPathForTest: helper,
      runtime,
    })).rejects.toThrow(/checksum/i);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('re-reads the bytes on disk: a file swapped after a good checksum is refused', async () => {
    const dir = makeTempDir();
    // The digest recorded at download time is CORRECT for this content; the
    // file is then replaced behind the updater's back. Only a fresh read+hash
    // of the on-disk bytes can catch this.
    const { file, sha256 } = writeInstallerFile(dir, Buffer.from('genuine installer'));
    fs.appendFileSync(file, Buffer.from(' + injected payload'));
    const helper = writeHelperFile(dir);
    const { runtime, spawnDetached, quit } = windowsRuntime();

    await expect(installDownloadedUpdate({
      installerPath: file,
      sha256,
      helperPathForTest: helper,
      runtime,
    })).rejects.toThrow(/checksum/i);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('refuses to install when the installer is missing, without spawning', async () => {
    const dir = makeTempDir();
    const helper = writeHelperFile(dir);
    const { runtime, spawnDetached, quit } = windowsRuntime();

    await expect(installDownloadedUpdate({
      installerPath: path.join(dir, 'absent.exe'),
      sha256: 'a'.repeat(64),
      helperPathForTest: helper,
      runtime,
    })).rejects.toThrow(/unreadable/i);

    expect(spawnDetached).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('reports unsupported on non-Windows platforms', async () => {
    await expect(installDownloadedUpdate({
      installerPath: 'x.exe',
      sha256: 'a'.repeat(64),
      runtime: { platform: 'darwin', execPath: '/App', pid: 1, spawnDetached: vi.fn(), quit: vi.fn() },
    })).rejects.toThrow(/unsupported/i);
  });
});

describe('resolveApplyUpdateHelperPath', () => {
  it('resolves the packed path in the development tree', () => {
    const resolved = resolveApplyUpdateHelperPath('/app', false);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.join('/app', 'bin', 'apply-update.cjs'));
  });

  it('rewrites app.asar to app.asar.unpacked for a packaged app', () => {
    const resolved = resolveApplyUpdateHelperPath('/app/resources/app.asar', true);
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith(path.join('bin', 'apply-update.cjs'))).toBe(true);
    expect(resolved).toBe(path.join('/app/resources/app.asar.unpacked', 'bin', 'apply-update.cjs'));
  });
});

describe('defaultWindowsInstallRuntime.spawnDetached', () => {
  interface FakeChild extends EventEmitter {
    pid?: number;
    unref: ReturnType<typeof vi.fn>;
  }

  function fakeChild(pid?: number): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = pid;
    child.unref = vi.fn();
    return child;
  }

  // Spawned directly: the platform gate belongs to the caller, and this case is
  // about the real child-process options the hand-off depends on.
  it('spawns detached, ignores stdio, hides the window and resolves with the pid', async () => {
    spawnMock.mockClear();
    const child = fakeChild(4321);
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);

    process.env.COGSEED_SPAWN_PROBE = 'probe-value';
    try {
      const promise = defaultWindowsInstallRuntime.spawnDetached('C:\\App\\CogSeed.exe', ['a', 'b'], { EXTRA: '1' });
      child.emit('spawn');

      await expect(promise).resolves.toBe(4321);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [exe, args, options] = spawnMock.mock.calls[0] as unknown as [
        string,
        string[],
        { detached: boolean; stdio: string; windowsHide: boolean; env: Record<string, string> },
      ];
      expect(exe).toBe('C:\\App\\CogSeed.exe');
      expect(args).toEqual(['a', 'b']);
      expect(options.detached).toBe(true);
      expect(options.stdio).toBe('ignore');
      expect(options.windowsHide).toBe(true);
      // The helper needs the parent environment plus the injected
      // ELECTRON_RUN_AS_NODE-style flags, merged rather than replaced.
      expect(options.env.EXTRA).toBe('1');
      expect(options.env.COGSEED_SPAWN_PROBE).toBe('probe-value');
      expect(child.unref).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.COGSEED_SPAWN_PROBE;
    }
  });

  it('rejects when the child process cannot be spawned', async () => {
    spawnMock.mockClear();
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);

    const promise = defaultWindowsInstallRuntime.spawnDetached('missing.exe', [], {});
    child.emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow(/ENOENT/);
  });
});
