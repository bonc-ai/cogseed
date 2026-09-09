// PR209 评审 M6 复核返工回归：sscli-shim 的 cancel 必须真正 kill「目标
// 在跑任务」且绝不误杀其他任务。首版修复比对 activeTurn.requestId（网关
// 内部 req-N）与 cancel 帧 task_id（外部取消键）——两个命名空间永不相等，
// 取消静默失效。断言 kill 的真实效果（failed 帧），非走读。
//
// 进程驱动在 fixtures/shim-cancel-driver.cjs（直接驱动 shim 的
// p3394-sscli/1.0 JSONL 协议，假 CLI 为 fixtures/shim-sleep-cli.cjs），
// 本文件以固定场景调驱动器并断言其 JSON 结果（cwd 为仓库根，与 vitest
// 其余用例的运行前提一致）。
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

interface DriverResult { ok: boolean; killed: boolean; misfire: boolean; error: string }

function parseResult(stdout: string): DriverResult {
  const line = stdout.trim().split('\n').pop() || '{}';
  return JSON.parse(line) as DriverResult;
}

describe('sscli-shim cancel 精确命中（PR209 评审 M6 返工回归）', () => {
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
});

