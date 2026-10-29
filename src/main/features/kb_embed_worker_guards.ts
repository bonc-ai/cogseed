/**
 * embed worker 的进程级护栏（子进程卫生）。
 *
 * 为什么需要：这个 worker 是**短命隔离进程**——父进程（kb_embed_bridge）用
 * `child.kill()`（SIGTERM）收掉它，可能在模型初始化还没结束时就动手；而 ONNX
 * 初始化要数秒，期间父进程可能已经关闭读端。此后 worker 写 `{"type":"ready"}`
 * 或 `{"type":"fatal"}` 会拿到 EPIPE：
 *
 *   - 写失败在 `main()` 的异步体里抛出 → 返回的 Promise 变成 unhandled rejection
 *     （入口原来是 `void main()`，没人接）；
 *   - 或者 `process.stdout` 直接派发 'error' 事件（EPIPE/ERR_STREAM_DESTROYED），
 *     没有监听者就是 uncaught 'error'。
 *
 * Node 默认处理这两种情况都会抛未捕获异常并退出进程；而此刻进程已经加载了
 * onnxruntime/tokenizers，退出阶段的 C++ 析构再抛一次 → `std::terminate` →
 * `abort()` → macOS 每次都留一份「Electron 崩溃」报告（真机 2026-09-24 一天
 * 九份，形态一致：TriggerUncaughtException → Environment::Exit → abort）。
 *
 * 护栏语义：**父进程消失/被要求退出 = 正常谢幕（exit 0）**；真正未预料的错误
 * 仍然失败（stderr 一行 + exit 1），只是不再走 Node 默认的 abort 路径——桥侧
 * 照样能看到 worker 退出并回退，用户侧不再出现崩溃报告。
 *
 * 依赖全部注入，便于单测（不启动模型、不碰真实进程）。
 */

/** 打印一行可诊断信息；默认写 stderr（stdout 是 JSONL 协议通道，不能污染）。 */
function defaultReport(message: string): void {
  try { process.stderr.write(`[embed-worker] ${message}\n`); } catch { /* 通道已断：无处可写 */ }
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

export interface EmbedWorkerGuardOptions {
  /** 退出实现（测试注入）。 */
  exit?: (code: number) => void;
  /** 诊断输出（测试注入）。 */
  report?: (message: string) => void;
  /** 「立即终止」实现（测试注入）：默认给自己发 SIGKILL。 */
  killImmediately?: () => void;
  /** 事件源（测试注入）；默认用真实进程对象。 */
  processLike?: {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    stdout?: { on(event: string, listener: (...args: unknown[]) => void): unknown } | null;
    stdin?: { on(event: string, listener: (...args: unknown[]) => void): unknown } | null;
    exit?: (code?: number) => void;
  };
}

/** 判断是否为「对端已经走了」类错误——这类一律按正常退出处理。 */
function isPeerGone(code: unknown): boolean {
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

/**
 * 装上护栏。幂等（重复调用不会重复注册同名副作用）。
 * 必须在 `main()` **之前**调用：模型初始化期间的父进程退出同样要被接住。
 */
export function installEmbedWorkerGuards(options: EmbedWorkerGuardOptions = {}): void {
  const target = options.processLike
    || (process as unknown as NonNullable<EmbedWorkerGuardOptions['processLike']>);
  const report = options.report || defaultReport;
  const exit = options.exit || ((code: number) => { process.exit(code); });
  // 被要求终止时**不要**走带 C++ 析构的 exit 路径：真机崩溃报告证实的链路是
  // `SIGTERM → Node 默认处理 process.exit() → __cxa_finalize_ranges → std::terminate
  // → abort`（本进程已加载 onnxruntime/tokenizers，析构抛出即 abort）。worker 无
  // 状态需 flush，直接 SIGKILL 最干净，也不再产生假崩溃报告。
  const killImmediately = options.killImmediately
    || (() => { try { process.kill(process.pid, 'SIGKILL'); } catch { process.exit(0); } });

  const stdout = options.processLike ? options.processLike.stdout : process.stdout;
  const stdin = options.processLike ? options.processLike.stdin : process.stdin;

  // 1) stdout 通道断开：这是父进程已经不再听的信号，不是错误。
  stdout?.on('error', (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    if (isPeerGone(code)) return killImmediately();
    report(`stdout error: ${describe(error)}`);
    exit(1);
  });

  // 2) stdin 结束 = 父进程关闭了管道（或已退出）：无活可干，立即终止。
  const onStdinGone = () => killImmediately();
  stdin?.on('end', onStdinGone);
  stdin?.on('close', onStdinGone);

  // 3) 父进程收进程（桥侧 child.kill() = SIGTERM）：立即终止，不走 exit 析构。
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    target.on(signal, () => killImmediately());
  }

  // 4) 未捕获异常/未处理的 rejection：仍然失败，但走可诊断的单行 + exit(1)，
  //    绕开 Node 默认处理（它会以未捕获异常退出，进而在原生模块已加载时 abort）。
  target.on('uncaughtException', (error: unknown) => {
    report(`uncaught exception: ${describe(error)}`);
    exit(1);
  });
  target.on('unhandledRejection', (reason: unknown) => {
    report(`unhandled rejection: ${describe(reason)}`);
    exit(1);
  });
}

/** 入口 main() 的收尾包装：把 main 的 rejection 也归到同一套语义里。 */
export function runEmbedWorkerMain(
  main: () => Promise<void>,
  options: EmbedWorkerGuardOptions = {},
): Promise<void> {
  const report = options.report || defaultReport;
  const exit = options.exit || ((code: number) => { process.exit(code); });
  return main().catch((error: unknown) => {
    report(`worker main failed: ${describe(error)}`);
    exit(1);
  });
}
