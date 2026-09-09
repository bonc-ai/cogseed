// PR209 评审 M6 复核返工回归：sscli-shim 的 cancel 必须真正 kill「目标
// 在跑任务」且绝不误杀其他任务。首版修复比对 activeTurn.requestId（网关
// 内部 req-N）与 cancel 帧 task_id（外部取消键）——两个命名空间永不相等，
// 取消静默失效。断言 kill 的真实效果（failed 帧），非走读。
//
// 进程驱动在 fixtures/shim-cancel-driver.cjs（直接驱动 shim 的
// p3394-sscli/1.0 JSONL 协议，假 CLI 为 fixtures/shim-sleep-cli.cjs），
// 本文件以固定场景调驱动器并断言其 JSON 结果（cwd 为仓库根，与 vitest
// 其余用例的运行前提一致）。
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';

interface DriverResult { ok: boolean; killed: boolean; misfire: boolean; treeGone?: boolean; pids?: number[]; error: string }

function parseResult(stdout: string): DriverResult {
  const line = stdout.trim().split('\n').pop() || '{}';
  return JSON.parse(line) as DriverResult;
}

function runDriver(scenario: string): DriverResult {
  const result = spawnSync(process.execPath, ['test/main/features/fixtures/shim-cancel-driver.cjs', scenario], { encoding: 'utf8', timeout: 45_000 });
  if (!result.stdout.trim()) throw new Error(result.stderr || result.error?.message || `driver ${scenario} produced no output`);
  return parseResult(result.stdout);
}

function loadRunCliOnce(context: Record<string, unknown>) {
  const source = fs.readFileSync(path.join(process.cwd(), 'p3394-gateway', 'sscli-shim.cjs'), 'utf8');
  const method = /function runCliOnce\([\s\S]*?^}/m.exec(source)?.[0];
  if (!method) throw new Error('runCliOnce not found');
  return vm.runInNewContext(`(${method})`, context) as (
    requestId: string,
    taskId: string,
    prompt: string,
    extraArgs: string[],
    cwd: string | null,
  ) => Promise<string>;
}

describe('sscli-shim cancel 精确命中（PR209 评审 M6 返工回归）', () => {
  it('POSIX timeout waits for the tree-termination barrier before settling', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      let finishTermination: (() => void) | undefined;
      const killProcessTree = vi.fn(() => new Promise<void>((resolve) => { finishTermination = resolve; }));
      let spawnOptions: Record<string, unknown> | undefined;
      const runCliOnce = loadRunCliOnce({
        CLI_ARGS: '{message}', CLI: 'fake-cli', TIMEOUT_MS: 100,
        SLOW_START_HINT_MS: 8_000, MAX_REPLY_BYTES: 1024,
        STREAM_CAP_CHARS: 1024, PROGRESS_MAX_LINES: 10,
        ENVELOPE_CLIS: new Set(), activeTurn: null,
        spawnCli: (_cli: string, _args: string[], options: Record<string, unknown>) => { spawnOptions = options; return child; },
        emitEvent: () => {}, cliLabel: () => 'fake-cli',
        killProcessTree, sanitizeStreamText: String, progressLine: String,
        setTimeout, clearTimeout, process: { platform: 'linux' },
      });

      const result = runCliOnce('req-timeout', 'task-timeout', 'hello', [], null);
      expect(spawnOptions).toMatchObject({ detached: true });
      let settled = false;
      void result.catch(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(100);
      expect(killProcessTree.mock.calls.map((call) => call[1])).toEqual(['SIGTERM']);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(killProcessTree).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      finishTermination?.();
      await expect(result).rejects.toThrow('p3394_agent_timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel 按 deliver 帧的 task_id 命中在跑任务并真 kill', () => {
    const r = parseResult(execFileSync(process.execPath, ['test/main/features/fixtures/shim-cancel-driver.cjs', 'hit'], { encoding: 'utf8', timeout: 45_000 }));
    expect(r.killed).toBe(true);
    expect(r.misfire).toBe(false);
    // 真 kill 的失败应是被信号终结，而非超时兜底（超时=没杀掉）。
    expect(r.error).not.toContain('timeout');
  }, 60_000);

  it('cancel 未命中 task_id 时绝不误杀在跑任务；命中后才 kill', () => {
    const r = parseResult(execFileSync(process.execPath, ['test/main/features/fixtures/shim-cancel-driver.cjs', 'no-kill'], { encoding: 'utf8', timeout: 45_000 }));
    expect(r.misfire).toBe(false);
    expect(r.killed).toBe(true);
  }, 60_000);

  it('cancel 帧带 request_id（无 task_id 的调用方）也能命中', () => {
    const r = parseResult(execFileSync(process.execPath, ['test/main/features/fixtures/shim-cancel-driver.cjs', 'request-id'], { encoding: 'utf8', timeout: 45_000 }));
    expect(r.killed).toBe(true);
  }, 60_000);

  it.runIf(process.platform === 'win32')('cancel terminates the targeted CLI process tree', () => {
    const r = runDriver('tree-cancel');
    expect(r.pids).toHaveLength(2);
    expect(r.treeGone, r.error).toBe(true);
  }, 60_000);

  it.runIf(process.platform === 'win32')('timeout terminates the CLI process tree', () => {
    const r = runDriver('tree-timeout');
    expect(r.pids).toHaveLength(2);
    expect(r.treeGone, r.error).toBe(true);
  }, 60_000);

});

