import { defineConfig } from 'vitest/config';
import { cpus } from 'node:os';

const logicalCpus = cpus().length || 1;
// Windows files exercise real Electron workers, PowerShell/cmd shims, Git,
// SQLite and other native integrations. Even two concurrent forks can exhaust the
// desktop process/commit budget late in the full suite (`spawn UNKNOWN` /
// `ENOMEM`) and push real-shell cases past their native startup budget. Keep
// Windows serialized; other hosts retain bounded parallelism.
const testWorkers = Math.max(1, Math.min(process.platform === 'win32' ? 1 : 4, logicalCpus));

export default defineConfig({
  test: {
    globals: false,
    include: ['test/**/*.test.ts', 'src/core-agent/test/**/*.test.ts'],
    // Each test file gets a fresh module graph — important because several of
    // our modules cache state (storage line counts, prompts cache, paths
    // mkdir on load). Without isolation, test order would leak state.
    isolate: true,
    // Runs before any test module (or its transitive imports) is loaded.
    // Critical safety net: pins `COGSEED_WORKSPACE_ROOT` to a throwaway tmp
    // dir so `paths.ts`'s module-level `WS_ROOT` constant never freezes to
    // the developer's real `PC/data/`. See ./test/setup-env.ts for the
    // full rationale.
    setupFiles: ['./test/setup-env.ts'],
    // Default reporter is a per-file dot list — keep CI output compact.
    reporters: ['default'],
    // The desktop suite exercises native modules, file IO, child processes,
    // and sqlite-backed features. Leaving Vitest at the host default can
    // oversubscribe local dev machines and make otherwise healthy tests trip
    // the 5s default timeout in full-suite runs.
    maxWorkers: testWorkers,
    // CI 全套件并发负载下 30s 会偶发误伤（本地通过、CI 超时）；给足余量。
    // Windows runner 上真实 shell/进程用例在满载时会超过 60s，CI 统一放宽
    // 到 120s；本地保持 60s，避免掩盖真正的挂死。
    testTimeout: process.env.CI ? 150_000 : 60_000,
    hookTimeout: process.env.CI ? 150_000 : 60_000,
    // Windows hosted runners intermittently hang one timing-sensitive test
    // (different file each run) while the same test passes immediately on a
    // retry. Allow two CI retries so a one-off runner stall does not fail the
    // release gate; deterministic failures still fail after both retries.
    retry: process.env.CI ? 2 : 0,
    // CI 单机满载时 worker 会持续刷 console 日志（electron-log、agent-runner
    // 等），Vitest 在 worker 收尾关闭 rpc 时会撞上 "Closing rpc while
    // onUserConsoleLog was pending" 的未处理错误，让全绿套件退出码变 1。
    // CI 下静默测试 console 消除该竞态；本地保留输出便于调试。
    silent: !!process.env.CI,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/main/**/*.{ts,js}',
        'src/core-agent/src/**/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        'src/main/index.ts',
        'src/main/smoke.ts',
        'src/core-agent/src/demo.ts',
        'src/core-agent/src/main.ts',
      ],
      thresholds: {
        lines: 61,
        functions: 62,
        statements: 58,
        branches: 52,
      },
    },
  },
});
