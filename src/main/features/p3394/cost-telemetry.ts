/**
 * Cost Telemetry — 模型调用计数与单任务成本（架构文档 §9 / D-5 预算实测）。
 *
 * 设计约束（AGENTS.md 遥测纪律）：匿名、仅计数与量级——record 只含
 * provider/model/操作类型/token 数/耗时，不含内容、会话 id 或用户可识别信息。
 * 机器私有（<uid>/local/），不标脏同步。
 *
 * 估算价：est_cost 使用参考价（$1/M input、$8/M output），最终以实际
 * 模型通道配置校准（D-4）；超过阈值触发 Scope Cut 建议，不自动断服务。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { appendJsonlAtomic, readJsonl, nowIso } from '../../storage';
import { mateAgentCostTelemetryDir } from '../../paths';
import { maskId } from '../../util/log-redact';

const log = createLogger('cost-telemetry');

/** 参考价（USD）；D-4 模型通道确认后校准。 */
export const REFERENCE_PRICE = { input_per_m: 1, output_per_m: 8 } as const;

export type CostOperation = 'extract' | 'capability_pack' | 'action_plan' | 'kstar_eval' | 'other';

export interface CostTelemetryRecord {
  record_id: string;
  provider: string;
  model: string;
  operation: CostOperation;
  input_tokens: number;
  output_tokens: number;
  duration_ms?: number;
  at: string;
}

export interface RecordCostTelemetryInput {
  provider: string;
  model: string;
  operation: CostOperation;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
}

export interface MonthCostSummary {
  month: string;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  est_cost_usd: number;
  by_operation: Record<CostOperation, { calls: number; input_tokens: number; output_tokens: number }>;
}

const OPERATIONS: readonly CostOperation[] = ['extract', 'capability_pack', 'action_plan', 'kstar_eval', 'other'];

function assertOperation(v: unknown): asserts v is CostOperation {
  if (typeof v !== 'string' || !(OPERATIONS as readonly string[]).includes(v)) throw new Error('invalid cost operation');
}

export function costTelemetryPath(uid: string, month: string): string {
  return path.join(mateAgentCostTelemetryDir(uid), `${month}.jsonl`);
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

export async function recordCostTelemetry(uid: string, input: RecordCostTelemetryInput): Promise<CostTelemetryRecord> {
  if (typeof input.inputTokens !== 'number' || !Number.isFinite(input.inputTokens) || input.inputTokens < 0) {
    throw new Error('invalid input tokens');
  }
  if (typeof input.outputTokens !== 'number' || !Number.isFinite(input.outputTokens) || input.outputTokens < 0) {
    throw new Error('invalid output tokens');
  }
  if (!input.provider || !input.model) throw new Error('invalid provider/model');
  assertOperation(input.operation);

  const record: CostTelemetryRecord = {
    record_id: `ct_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    provider: input.provider,
    model: input.model,
    operation: input.operation,
    input_tokens: Math.round(input.inputTokens),
    output_tokens: Math.round(input.outputTokens),
    ...(input.durationMs !== undefined ? { duration_ms: Math.round(input.durationMs) } : {}),
    at: nowIso(),
  };
  try {
    await appendJsonlAtomic<CostTelemetryRecord>(costTelemetryPath(uid, currentMonth()), record);
  } catch (err) {
    // 埋点失败不炸链路（遥测是辅助数据）
    log.warn(`cost telemetry append failed user=${maskId(uid)}: ${(err as Error).message}`);
  }
  return record;
}

/** 月汇总：总数 + 估算成本 + 按操作类型分布。 */
export async function monthCostSummary(uid: string, month = currentMonth()): Promise<MonthCostSummary> {
  const records = await readJsonl<CostTelemetryRecord>(costTelemetryPath(uid, month), 100000);
  const byOperation: MonthCostSummary['by_operation'] = {
    extract: { calls: 0, input_tokens: 0, output_tokens: 0 },
    capability_pack: { calls: 0, input_tokens: 0, output_tokens: 0 },
    action_plan: { calls: 0, input_tokens: 0, output_tokens: 0 },
    kstar_eval: { calls: 0, input_tokens: 0, output_tokens: 0 },
    other: { calls: 0, input_tokens: 0, output_tokens: 0 },
  };
  let totalInput = 0;
  let totalOutput = 0;
  for (const r of records) {
    const op = byOperation[r.operation] ?? byOperation.other;
    op.calls += 1;
    op.input_tokens += r.input_tokens;
    op.output_tokens += r.output_tokens;
    totalInput += r.input_tokens;
    totalOutput += r.output_tokens;
  }
  return {
    month,
    call_count: records.length,
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    est_cost_usd: totalInput / 1_000_000 * REFERENCE_PRICE.input_per_m
      + totalOutput / 1_000_000 * REFERENCE_PRICE.output_per_m,
    by_operation: byOperation,
  };
}
