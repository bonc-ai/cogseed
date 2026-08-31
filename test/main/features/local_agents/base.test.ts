import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('uses taskkill tree mode on Windows and falls back when taskkill fails', () => {
    const callbacks = new Map<string, (...args: any[]) => void>();
    const killer = {
      once: vi.fn((event: string, cb: (...args: any[]) => void) => {
        callbacks.set(event, cb);
        return killer;
      }),
      unref: vi.fn(),
    };
    const spawnFn = vi.fn(() => killer);
    const child = { pid: 2468, kill: vi.fn() };

    killProcessTree(child as any, 'SIGTERM', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    });

    expect(spawnFn).toHaveBeenCalledWith(
      expect.stringMatching(/taskkill\.exe$/i),
      ['/pid', '2468', '/t', '/f'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();

    callbacks.get('exit')?.(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to the direct Windows child when taskkill cannot start', () => {
    const child = { pid: 1357, kill: vi.fn() };
    const spawnFn = vi.fn(() => { throw new Error('spawn failed'); });

    killProcessTree(child as any, 'SIGKILL', {
      platform: 'win32',
      spawnFn: spawnFn as any,
    });

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
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
