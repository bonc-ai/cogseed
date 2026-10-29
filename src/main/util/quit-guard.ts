/**
 * Bounded app shutdown primitives.
 *
 * ## Why this module exists
 *
 * `before-quit` is a **vetoable** event: the handler in `index.ts` calls
 * `e.preventDefault()`, runs the shutdown work, then calls `app.quit()` again.
 * That is the correct shape for flushing data, but it makes every awaited
 * promise in the shutdown path a potential **永久挂起**: if one subsystem's
 * promise never settles, the veto is never lifted and the process can only be
 * killed with SIGKILL. Reproduced 2026-10-27 (see the S3/S4 report, CLIENT-1):
 * a source-run instance received SIGTERM, stopped responding to input, and
 * stayed alive indefinitely — `scripts/restart-cogseed.sh` had to force-kill it
 * every time.
 *
 * Two mechanisms, deliberately separate:
 *
 * | 机制 | 作用 | 失败时的结果 |
 * |---|---|---|
 * | `withDeadline` | 单个阶段（搜索 flush / 桥 / 网关）不得超过预算 | 记 `warn`，继续下一阶段 |
 * | `createQuitWatchdog` | 整个退出流程的硬上限 | `app.exit(0)`，进程一定离开 |
 *
 * ## 为什么超时后继续而不是中止退出
 *
 * 退出流程的目的是**尽力保存**，不是「必须成功」。一个阶段超时后中止整个退出，会让本来
 * 能保存的阶段全部丢失；继续执行下一阶段、最后由 watchdog 兜底，是代价最小的一侧。
 *
 * ## 为什么 watchdog 不用 `unref()`
 *
 * watchdog 的职责是"主进程必须死"。`unref()` 让定时器不持住事件循环——一旦其它句柄全部
 * 释放，Node 会在 watchdog 触发前退出，看似没问题；真正需要它的时候（某个阶段仍然持着
 * 句柄、promise 永不 settle）它可能因为实现差异被跳过。退出路径上不值得这种优化。
 *
 * 本模块纯 Node 依赖（不 import electron），便于直接用假时钟/假进程测边界。
 */

/** 单个阶段的默认预算。四段相加仍远小于 watchdog。 */
export const QUIT_PHASE_TIMEOUT_MS = 2_000;

/** 退出流程硬上限：超过即 `app.exit(0)`。`restart-cogseed.sh` 等 10 s 后强杀，留 2 s 余量。 */
export const QUIT_WATCHDOG_MS = 8_000;

/** 结构化日志接缝：只要求三个方法，避免把 logger 变成这里的编译期依赖。 */
export interface QuitLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * 在预算内执行一个退出阶段。
 *
 * - 成功：`info` 记录耗时；
 * - 抛错：`warn` 记录原因，返回 `undefined`（调用方不得因此中止退出）；
 * - 超时：`warn` 记录 `timedOut`，返回 `undefined`（底层 promise 可能仍在跑，交给 watchdog）。
 *
 * 不吞掉底层 promise 的 rejection：`Promise.race` 已经处理了它；这里不再挂 `.catch`，
 * 以免掩盖"race 之后才 reject"的未处理拒绝（那属于调用方的 bug，应当暴露）。
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  work: () => Promise<T> | T,
  log: QuitLogger,
): Promise<T | undefined> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`quit phase timed out after ${ms}ms`)), ms);
    });
    const value = await Promise.race([Promise.resolve().then(work), deadline]);
    log.info('quit phase finished', { label, ms: Date.now() - startedAt });
    return value;
  } catch (error) {
    const timedOut = error instanceof Error && error.message.includes('timed out');
    log.warn('quit phase failed', {
      label,
      ms: Date.now() - startedAt,
      timedOut,
      error: errorMessage(error),
    });
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface QuitWatchdog {
  /** 开始计时；重复调用是 no-op（退出流程只会开始一次）。 */
  arm: () => void;
  /** 退出已正常完成：取消计时。 */
  clear: () => void;
  /** 是否已经因为超时强制退出（供测试与日志断言）。 */
  fired: () => boolean;
}

/**
 * 退出流程的硬上限。触发时调用 `forceExit`（生产实现是 `app.exit(0)`，绕过
 * `before-quit`，所以不会再被任何 handler 拦住）。
 */
export function createQuitWatchdog(options: {
  forceExit: () => void;
  log: QuitLogger;
  ms?: number;
  /** 测试接缝；缺省用全局 setTimeout/clearTimeout。 */
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}): QuitWatchdog {
  const {
    forceExit,
    log,
    ms = QUIT_WATCHDOG_MS,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = (timer) => clearTimeout(timer),
  } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;

  return {
    arm: () => {
      if (timer !== null || fired) return;
      timer = schedule(() => {
        fired = true;
        timer = null;
        try {
          log.error('quit watchdog fired; forcing exit', { ms });
        } finally {
          forceExit();
        }
      }, ms);
    },
    clear: () => {
      if (timer === null) return;
      cancel(timer);
      timer = null;
    },
    fired: () => fired,
  };
}

export interface SignalQuitOptions {
  /** 收到信号时的动作（生产实现：`app.quit()`）。只应被调用一次。 */
  onSignal: (signal: NodeJS.Signals) => void;
  log: QuitLogger;
  /** 测试接缝：缺省用 `process`。 */
  processLike?: Pick<NodeJS.Process, 'on' | 'off'>;
  signals?: readonly NodeJS.Signals[];
}

/** 默认监听的信号：终端 Ctrl+C、`kill`、以及关掉终端窗口时的 SIGHUP。 */
export const QUIT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

/** 已经安装过信号监听的进程（按对象身份去重，避免测试之间互相污染）。 */
const installedOn = new WeakSet<object>();

/**
 * 把 SIGTERM / SIGINT / SIGHUP 变成一次正常的 `app.quit()`。
 *
 * ## 为什么必须显式安装
 *
 * 没有 Node 监听器时，Electron 的浏览器进程会自己处理 SIGTERM（实测：`before-quit`
 * 会触发），但这条路径**不在我们的控制面里**：它不记日志、不接受熔断，也无法在
 * `before-quit` 挂住时给出任何证据。显式安装后，信号 → `app.quit()` → 有界的
 * `before-quit` → watchdog，每一步都可观测。
 *
 * 重复安装是 no-op（返回的清理函数依旧可用）。返回函数用于测试与热重载。
 */
export function installQuitSignalHandlers(options: SignalQuitOptions): () => void {
  const { onSignal, log, processLike = process, signals = QUIT_SIGNALS } = options;
  if (installedOn.has(processLike)) return () => {};
  installedOn.add(processLike);

  let handled = false;
  const listeners = new Map<NodeJS.Signals, () => void>();

  for (const signal of signals) {
    const listener = () => {
      // 第二个信号只记日志：应用已在退出流程里，`app.quit()` 会重复进入
      // `before-quit`（handler 自己做了幂等），重复记录反而放大日志噪声。
      if (handled) {
        log.warn('termination signal received while quitting', { signal });
        return;
      }
      handled = true;
      log.info('termination signal received', { signal });
      try {
        onSignal(signal);
      } catch (error) {
        log.error('termination signal handling failed', { signal, error: errorMessage(error) });
      }
    };
    listeners.set(signal, listener);
    processLike.on(signal, listener);
  }

  return () => {
    for (const [signal, listener] of listeners) processLike.off(signal, listener);
    listeners.clear();
    installedOn.delete(processLike);
  };
}
