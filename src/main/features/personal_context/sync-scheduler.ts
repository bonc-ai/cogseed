/**
 * 个人上下文同步调度器（设计稿 §7 阶段 2：选择性资源入门 + 有限回填 + 游标增量）。
 *
 * 职责：已连接时按间隔（默认 30 分钟，可配置）触发 provider.sync；首次连接后
 * 立即 tick 做有限回填（30 天/90 天，sync.ts 已支持，游标为空即回填）。
 *
 * 语义（与现有游标/注册表契约一致）：
 * - runner 返回 null（未连接/需要重新授权）→ 跳过本轮，定时器继续；
 * - runner 抛错（同步失败）→ 记录 lastError，不抛给定时器，水位不落盘
 *   （provider.sync 的 advance 在成功后才执行，失败即中止）；
 * - 同 uid 防重入：单轮在途时再次 tick → already_running，不并发执行。
 *
 * 纯逻辑实现：runner 由调用方注入（manager.ts 组装 provider），便于单测。
 */
import { createLogger } from '../../logger';
import type { SyncResult } from './contract';

const log = createLogger('personal-context:scheduler');

/** 默认同步间隔：30 分钟 */
export const DEFAULT_SYNC_INTERVAL_MS = 30 * 60 * 1000;

export interface SyncRunner {
  /**
   * 执行一轮同步。返回 null = 未连接/无需同步（跳过）；
   * 抛错 = 同步失败（不落水位，下一轮重试）。
   */
  runSync(uid: string): Promise<SyncResult | null>;
}

export type TickOutcome = 'ran' | 'skipped_not_connected' | 'already_running' | 'failed';

export interface TickResult {
  outcome: TickOutcome;
  /** ran 时的同步统计摘要（供日志/测试断言） */
  summary?: Pick<SyncResult, 'added' | 'updated' | 'unchanged'>;
  error?: string;
}

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  lastRunAt?: string;
  lastError?: string;
}

export interface SyncSchedulerOptions {
  runner: SyncRunner;
  /** 同步间隔；默认 DEFAULT_SYNC_INTERVAL_MS */
  intervalMs?: number;
  /** 测试注入时钟（默认全局 setTimeout/setInterval） */
  schedule?: typeof setInterval;
  unschedule?: typeof clearInterval;
}

export class PersonalContextSyncScheduler {
  private readonly runner: SyncRunner;
  private readonly intervalMs: number;
  private readonly schedule: typeof setInterval;
  private readonly unschedule: typeof clearInterval;
  private readonly states = new Map<string, SchedulerState>();

  constructor(opts: SyncSchedulerOptions) {
    this.runner = opts.runner;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.schedule = opts.schedule ?? setInterval;
    this.unschedule = opts.unschedule ?? clearInterval;
  }

  /** 启动定时同步（幂等：已启动的 uid 不重复建定时器）；不立即 tick */
  start(uid: string): void {
    const state = this.stateFor(uid);
    if (state.timer) return;
    state.timer = this.schedule(() => {
      void this.tick(uid).catch(() => undefined);
    }, this.intervalMs);
    log.info('sync scheduler started', { uid, intervalMs: this.intervalMs });
  }

  /** 停止定时同步（在途 tick 不受影响，自然结束） */
  stop(uid: string): void {
    const state = this.states.get(uid);
    if (state?.timer) {
      this.unschedule(state.timer);
      state.timer = null;
    }
  }

  isRunning(uid: string): boolean {
    return Boolean(this.states.get(uid)?.timer);
  }

  isInFlight(uid: string): boolean {
    return Boolean(this.states.get(uid)?.inFlight);
  }

  lastRunAt(uid: string): string | undefined {
    return this.states.get(uid)?.lastRunAt;
  }

  lastError(uid: string): string | undefined {
    return this.states.get(uid)?.lastError;
  }

  /**
   * 立即执行一轮同步（OAuth 完成回调后触发首次回填 / 手动触发）。
   * 重入保护：同 uid 在途时返回 already_running。
   */
  async tick(uid: string): Promise<TickResult> {
    const state = this.stateFor(uid);
    if (state.inFlight) return { outcome: 'already_running' };

    state.inFlight = true;
    try {
      const result = await this.runner.runSync(uid);
      if (result === null) {
        state.lastError = undefined;
        return { outcome: 'skipped_not_connected' };
      }
      state.lastRunAt = result.at;
      state.lastError = undefined;
      return {
        outcome: 'ran',
        summary: { added: result.added, updated: result.updated, unchanged: result.unchanged },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      log.warn('sync tick failed, watermark not advanced', { uid, error: message });
      return { outcome: 'failed', error: message };
    } finally {
      state.inFlight = false;
    }
  }

  private stateFor(uid: string): SchedulerState {
    let state = this.states.get(uid);
    if (!state) {
      state = { timer: null, inFlight: false };
      this.states.set(uid, state);
    }
    return state;
  }
}
