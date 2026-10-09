import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'test-user-ct';
const MOD = '../../../../src/main/features/p3394/cost-telemetry';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-cost-telemetry-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules(); // paths.ts WS_ROOT 模块加载时求值
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import(MOD);
}

describe('cost-telemetry › 记录与月汇总', () => {
  it('记录成功：字段完整、按月分区', async () => {
    const m = await loadMod();
    const rec = await m.recordCostTelemetry(UID, {
      provider: 'custom', model: 'deepseek-v4-flash',
      operation: 'extract', inputTokens: 12000, outputTokens: 1500, durationMs: 8000,
    });
    expect(rec.record_id).toMatch(/^ct_/);
    expect(rec.operation).toBe('extract');

    const file = m.costTelemetryPath(UID, m.currentMonth());
    expect(fs.existsSync(file)).toBe(true);
  });

  it('月汇总：计数/token/估算成本/按操作分布', async () => {
    const m = await loadMod();
    await m.recordCostTelemetry(UID, { provider: 'p', model: 'm', operation: 'extract', inputTokens: 1000000, outputTokens: 0 });
    await m.recordCostTelemetry(UID, { provider: 'p', model: 'm', operation: 'extract', inputTokens: 1000000, outputTokens: 0 });
    await m.recordCostTelemetry(UID, { provider: 'p', model: 'm', operation: 'action_plan', inputTokens: 0, outputTokens: 125000 });

    const s = await m.monthCostSummary(UID, m.currentMonth());
    expect(s.call_count).toBe(3);
    expect(s.total_input_tokens).toBe(2000000);
    expect(s.total_output_tokens).toBe(125000);
    // 估算：2M input * $1/M + 125K output * $8/M = 2 + 1 = $3
    expect(s.est_cost_usd).toBeCloseTo(3, 5);
    expect(s.by_operation.extract.calls).toBe(2);
    expect(s.by_operation.action_plan.calls).toBe(1);
  });

  it('非法 token / 非法 operation 抛错', async () => {
    const m = await loadMod();
    await expect(m.recordCostTelemetry(UID, { provider: 'p', model: 'm', operation: 'extract', inputTokens: -1, outputTokens: 0 }))
      .rejects.toThrow('invalid input tokens');
    await expect(m.recordCostTelemetry(UID, { provider: 'p', model: 'm', operation: 'nope' as never, inputTokens: 1, outputTokens: 0 }))
      .rejects.toThrow('invalid cost operation');
  });

  it('无记录月份：空汇总不炸', async () => {
    const m = await loadMod();
    const s = await m.monthCostSummary(UID, '2020-01');
    expect(s.call_count).toBe(0);
    expect(s.est_cost_usd).toBe(0);
  });
});
