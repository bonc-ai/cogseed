import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as path from 'node:path';

/** `taskkill` is a bounded utility, not a daemon: if it has not exited by then it never will. */
const TASKKILL_TIMEOUT_MS = 10_000;

type KillableChild = Pick<ChildProcessWithoutNullStreams, 'kill' | 'pid'>;
type SpawnFn = typeof spawn;

/** 为什么树终止失败——调用方据此记日志（本文件禁止依赖 logger，见 boundary 测试）。 */
export type TreeKillFailureReason = 'tree_command_failed' | 'tree_command_nonzero_exit';

function windowsSystem32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** Terminate the complete child process tree without invoking a shell. */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  opts: { platform?: NodeJS.Platform; spawnFn?: SpawnFn; onFailure?: (reason: TreeKillFailureReason) => void } = {},
): void {
  const pid = child.pid;
  const platform = opts.platform ?? process.platform;
  if (pid && platform === 'win32') {
    try {
      const killer = (opts.spawnFn ?? spawn)(
        windowsSystem32Tool('taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      );
      // 直接 kill 子进程 ≠ 证明整棵树已停：孙进程可能仍然活着并持有继承来的管道，
      // 于是 close 永不触发、abort/timeout 看起来「挂死」。失败必须**让调用方能留痕**，
      // 否则只剩静默降级。本文件属于"依赖极轻"边界（不许 import logger），
      // 因此把原因交给 onFailure 回调，由 features 侧决定怎么记。
      const fallback = (reason: TreeKillFailureReason) => {
        try { opts.onFailure?.(reason); } catch { /* 记录失败本身不能再抛 */ }
        try { child.kill(signal); } catch { /* already gone */ }
      };
      killer.once('error', () => fallback('tree_command_failed'));
      killer.once('exit', (code) => {
        if (code !== 0) fallback('tree_command_nonzero_exit');
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
