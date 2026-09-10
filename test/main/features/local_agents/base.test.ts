import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  bindAbort,
  killProcessTree,
  levelOrInfo,
  LineSplitter,
  spawnCli,
  StderrTail,
} from '../../../../src/main/features/local_agents/backends/base';

const TMP_DIRS: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  while (TMP_DIRS.length) {
    const dir = TMP_DIRS.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('local_agents/backends/base', () => {
  it('keeps only the bounded stderr tail', () => {
    const tail = new StderrTail(8);

    tail.push('abc');
    tail.push('def');
    tail.push('ghi');

    expect(tail.toString()).toBe('defghi');

    tail.push('0123456789');
    expect(tail.toString()).toBe('23456789');
  });

  it('splits newline-delimited chunks and flushes trailing data', () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];

    splitter.push('one\r\ntwo', line => lines.push(line));
    splitter.push(' continued\nthree\n', line => lines.push(line));
    splitter.push('tail', line => lines.push(line));
    splitter.flush(line => lines.push(line));
    splitter.flush(line => lines.push(line));

    expect(lines).toEqual(['one', 'two continued', 'three', 'tail']);
  });

  it('normalizes CLI log levels to the renderer contract', () => {
    expect(levelOrInfo('TRACE')).toBe('debug');
    expect(levelOrInfo('warning')).toBe('warn');
    expect(levelOrInfo('fatal')).toBe('error');
    expect(levelOrInfo('notice')).toBe('info');
    expect(levelOrInfo(3)).toBe('info');
  });

  it('sends SIGTERM on abort, escalates to SIGKILL, and cleans up listeners', () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const kills: string[] = [];
    const child = {
      kill: (signal: string) => {
        kills.push(signal);
        return true;
      },
    } as any;

    const cleanup = bindAbort(child, ac.signal, 50);
    ac.abort();
    expect(kills).toEqual(['SIGTERM']);

    vi.advanceTimersByTime(50);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);

    cleanup();
    vi.advanceTimersByTime(100);
    expect(kills).toEqual(['SIGTERM', 'SIGKILL']);
    vi.useRealTimers();
  });

  it('waits for taskkill close after a nonzero exit and completes the fallback first', async () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawnFn = vi.fn(() => killer);
    const order: string[] = [];
    const child = {
      pid: 2468,
      kill: vi.fn(() => {
        order.push('fallback');
        return true;
      }),
    };

    const completion = Promise.resolve(killProcessTree(child as any, 'SIGTERM', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    })).then(() => { order.push('resolved'); });

    expect(spawnFn).toHaveBeenCalledWith(
      expect.stringMatching(/taskkill\.exe$/i),
      ['/pid', '2468', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(order).toEqual([]);

    killer.emit('exit', 1);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(order).toEqual(['fallback']);

    killer.emit('close', 1, null);
    await completion;
    expect(order).toEqual(['fallback', 'resolved']);
    expect(killer.listenerCount('error')).toBe(0);
    expect(killer.listenerCount('exit')).toBe(0);
    expect(killer.listenerCount('close')).toBe(0);
  });

  it('waits for taskkill close after a successful exit without falling back', async () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const child = { pid: 2468, kill: vi.fn(() => true) };
    let settled = false;

    const completion = killProcessTree(child as any, 'SIGTERM', {
      platform: 'win32',
      spawnFn: vi.fn(() => killer) as any,
    }).then(() => { settled = true; });

    killer.emit('exit', 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();

    killer.emit('close', 0, null);
    await completion;
    expect(settled).toBe(true);
    expect(killer.listenerCount('error')).toBe(0);
    expect(killer.listenerCount('exit')).toBe(0);
    expect(killer.listenerCount('close')).toBe(0);
  });

  it('waits for taskkill close after an error and does not fall back twice', async () => {
    const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const child = { pid: 2468, kill: vi.fn(() => true) };
    let settled = false;

    const completion = Promise.resolve(killProcessTree(child as any, 'SIGKILL', {
      platform: 'win32',
      spawnFn: vi.fn(() => killer) as any,
    })).then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);

    killer.emit('error', new Error('taskkill failed to spawn'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    killer.emit('exit', 1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    killer.emit('close', 1, null);
    await completion;
    expect(settled).toBe(true);
    expect(killer.listenerCount('error')).toBe(0);
    expect(killer.listenerCount('exit')).toBe(0);
    expect(killer.listenerCount('close')).toBe(0);
  });

  it('falls back to the direct Windows child when taskkill cannot start', async () => {
    const child = { pid: 1357, kill: vi.fn() };
    const spawnFn = vi.fn(() => { throw new Error('spawn failed'); });

    const completion = killProcessTree(child as any, 'SIGKILL', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    });

    expect(completion).toBeInstanceOf(Promise);
    await expect(completion).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('falls back to the direct POSIX child when no matching process group exists', async () => {
    const child = { pid: 9753, kill: vi.fn() };
    const processKill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);

    const completion = killProcessTree(child as any, 'SIGTERM', { platform: 'darwin' });

    expect(completion).toBeInstanceOf(Promise);
    await expect(completion).resolves.toBeUndefined();
    expect(processKill).toHaveBeenCalledWith(-9753, 'SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    processKill.mockRestore();
  });
});

describe('local_agents/backends/base › spawnCli', () => {
  it('creates the cwd directory before spawning when it does not exist', async () => {
    const root = tmpDir('cogseed-spawncli-');
    const missingCwd = path.join(root, 'cloud', 'spaces', 'sp_abc123', 'workspace', '任务甲');
    expect(fs.existsSync(missingCwd)).toBe(false);

    const probe = process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'echo hi'] }
      : { command: '/bin/echo', args: ['hi'] };
    const child = spawnCli(probe.command, probe.args, missingCwd);
    const [code] = await new Promise<[number | null, string]>((resolve) => {
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => { out += c; });
      child.on('close', (c) => resolve([c, out]));
    });

    expect(code).toBe(0);
    // The missing cwd was materialised so the CLI could start in it.
    expect(fs.statSync(missingCwd).isDirectory()).toBe(true);
  });

  it('leaves an already-existing cwd untouched', () => {
    const root = tmpDir('cogseed-spawncli-');
    const cwd = path.join(root, 'existing');
    fs.mkdirSync(cwd, { recursive: true });
    const marker = path.join(cwd, 'marker.txt');
    fs.writeFileSync(marker, 'x');

    const probe = process.platform === 'win32'
      ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'echo hi'] }
      : { command: '/bin/echo', args: ['hi'] };
    spawnCli(probe.command, probe.args, cwd);

    expect(fs.statSync(marker).isFile()).toBe(true);
  });
});
