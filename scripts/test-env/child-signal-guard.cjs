'use strict';
/**
 * 子进程信号退出护栏（测试进程专用，`--require` 注入）。
 *
 * 真机证据（2026-09-24 Electron .ips，单次全量跑 19 份，栈完全一致）：
 *
 *   uv__signal_event → (JS 信号回调) → node::Environment::Exit → exit()
 *      → __cxa_finalize_ranges → std::terminate → abort()
 *
 * 且 `Parent Process: Electron [82030]` —— 崩的是 **vitest worker**（Electron-as-node
 * 子进程）。链路：vitest 回收 worker 时发 SIGTERM → **无人监听**，Node 默认处理调用
 * `process.exit()` → exit 走 C++ 静态析构，而 worker 里已加载 onnxruntime /
 * tokenizers（KB / embedding 测试）→ 某个析构抛异常 → `std::terminate` → abort。
 *
 * 护栏语义（两条边界都很重要）：
 *   1. **只在没有别的监听者时才接管**：本文件用 `--require` 早于 vitest 加载，
 *      绝不能用 `removeAllListeners` 抢掉 vitest 自己的 SIGINT 优雅退出——否则
 *      Ctrl-C 会从"优雅收尾 + 打印摘要"退化成硬杀。信号到达时若 `listenerCount > 1`
 *      （除了我们还有别人）就直接返回，把决定权让给真正的处理者。
 *   2. 确实无人接管时（worker 被回收的形态），把终止信号升级成 SIGKILL：不可捕获、
 *      立即终止、不跑带析构的 exit 路径 → 不再产生假「Electron 崩溃」报告。
 *
 * 逃生开关：`COGSEED_TEST_SIGNAL_GUARD=0` 时不安装（例如要在 Ctrl-C 后拿 worker 的
 * 覆盖率/诊断数据，或怀疑本护栏影响了退出行为时）。
 */

const IMMEDIATE_SIGNALS = ['SIGTERM', 'SIGINT'];

if (process.env.COGSEED_TEST_SIGNAL_GUARD !== '0') {
  for (const signal of IMMEDIATE_SIGNALS) {
    process.on(signal, () => {
      // 有别的监听者（vitest 自己的优雅退出等）→ 让它处理，我们不抢。
      if (process.listenerCount(signal) > 1) return;
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch {
        process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
      }
    });
  }
}
