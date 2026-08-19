import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as path from 'node:path';

type KillableChild = Pick<ChildProcessWithoutNullStreams, 'kill' | 'pid'>;
type SpawnFn = typeof spawn;

function windowsSystem32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** Terminate the complete child process tree without invoking a shell. */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  opts: { platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {},
): void {
  const pid = child.pid;
  const platform = opts.platform ?? process.platform;
  if (pid && platform === 'win32') {
    try {
      const killer = (opts.spawnFn ?? spawn)(
        windowsSystem32Tool('taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      const fallback = () => {
        try { child.kill(signal); } catch { /* already gone */ }
      };
      killer.once('error', fallback);
      killer.once('exit', (code) => {
        if (code !== 0) fallback();
      });
      if (typeof killer.unref === 'function') killer.unref();
      return;
    } catch {
      // Fall through to a best-effort direct child kill.
    }
  }
  if (pid && platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}
