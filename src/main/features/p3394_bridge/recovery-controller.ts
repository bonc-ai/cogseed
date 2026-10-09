/**
 * P3394 自动恢复控制器（C-03 / R-06 / S-05 的最后一环）。
 *
 * 断线 → executor 把任务标记 recoverable → 本控制器按持久化游标调用
 * resumeForward 续读事件流，任务不重新 deliver、不重复执行：
 *
 *   sweep() 扫描 executor.tasks.listRecoverable()，逐个 recoverTask()；
 *   每次尝试按 maxAttempts 封顶，失败的任务留在 pending 等待下一轮。
 */

import type { P3394BridgeExecutor } from './executor';

export interface P3394RecoveryControllerOptions {
  /** 每个任务最后确认送达的事件序列（持久化游标）；缺省 0（全量重放）。 */
  cursorFor?: (taskId: string) => number;
  /** 每个任务自动恢复尝试上限（默认 3）。 */
  maxAttempts?: number;
  /** 每次尝试的观察回调（日志/遥测）。 */
  onAttempt?: (taskId: string, ok: boolean, error?: string) => void;
}

export interface P3394RecoverySweepResult {
  recovered: string[];
  pending: string[];
}

export class P3394RecoveryController {
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly executor: P3394BridgeExecutor,
    private readonly options: P3394RecoveryControllerOptions = {},
  ) {}

  private cursorFor(taskId: string): number {
    const cursor = this.options.cursorFor?.(taskId);
    return Math.max(0, Math.floor(Number(cursor) || 0));
  }

  private maxAttempts(): number {
    return Math.max(1, Math.floor(Number(this.options.maxAttempts) || 3));
  }

  /** 恢复单个任务：仅对 recoverable 状态生效，成功返回 true。 */
  async recoverTask(taskId: string): Promise<boolean> {
    const task = this.executor.tasks.get(taskId);
    if (!task) return false;
    if (task.state !== 'recoverable') return true;
    const tried = this.attempts.get(taskId) ?? 0;
    if (tried >= this.maxAttempts()) return false;
    this.attempts.set(taskId, tried + 1);
    try {
      await this.executor.resumeForward(taskId, task.session_id, this.cursorFor(taskId));
      this.options.onAttempt?.(taskId, true);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.onAttempt?.(taskId, false, message);
      return false;
    }
  }

  /** 扫描并恢复所有 recoverable 任务；返回已恢复与仍待恢复的任务 id。 */
  async sweep(): Promise<P3394RecoverySweepResult> {
    const recovered: string[] = [];
    const pending: string[] = [];
    for (const task of this.executor.tasks.listRecoverable()) {
      const ok = await this.recoverTask(task.task_id);
      (ok ? recovered : pending).push(task.task_id);
    }
    return { recovered, pending };
  }
}
