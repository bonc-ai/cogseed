/**
 * transcript_metrics — 转写清理的本地埋点（方案 v0.2 §8.2「可选埋点，本地」）
 *
 * 方案把这三项标为**可选**，且明确"本地"：
 *   - 平均确认一次纠错耗时 < 15s；
 *   - 高频词表 ≥20 条后，单文档"来回改错词次数"趋近 0；
 *   - 清理版字符保留率落在 55%–85% 区间（<55% 告警）。
 *
 * 这里只做**能诚实测到的两项**：
 *   1. 确认耗时：面板从"扫描完成"到"生成清理版"的秒数（用户真实操作节奏）；
 *   2. 保留率：每次清理的字符保留率 + 是否触发过度改写告警。
 * "来回改错词的次数"测不了——它发生在**产品之外**（用户改错词的动作不经过本功能），
 * 所以**不编一个假指标**：`SUMMARY` 里如实标注 `notMeasurable`。
 *
 * 存法：`<uid>/local/cogseed/transcript/metrics.jsonl`（机私有、只追加、
 * 一行一个事件），不联网、不上报。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger';
import { userTranscriptMetricsFile } from '../paths';

const log = createLogger('transcript-metrics');

/** 方案 §8.2 的目标值（面板据此判"达标/未达标"，不再是口号）。 */
export const CONFIRM_LATENCY_TARGET_MS = 15_000;
export const RETENTION_RANGE: [number, number] = [0.55, 0.85];
export const GLOSSARY_ENTRY_MILESTONE = 20;

export interface ConfirmLatencyEvent {
  kind: 'confirm_latency';
  ms: number;
  docId: string;
  /** 本次清理涉及的候选行数（看"确认得快"是不是因为根本没几条）。 */
  rows: number;
  accepted: number;
  at: number;
}

export interface RetentionEvent {
  kind: 'retention';
  retention: number;
  charsIn: number;
  charsOut: number;
  overRewrite: boolean;
  docId: string;
  at: number;
}

export type MetricEvent = ConfirmLatencyEvent | RetentionEvent;

export interface MetricsSummary {
  /** 有记录的清理次数。 */
  runs: number;
  /** 确认耗时（毫秒）中位数与平均；无记录时为 null。 */
  confirmLatency: { median: number | null; mean: number | null; samples: number; targetMs: number; withinTarget: boolean | null };
  /** 保留率分布。 */
  retention: { median: number | null; belowRange: number; inRange: number; aboveRange: number; samples: number };
  /** 词表条数是否已达到方案里的"≥20 条"里程碑。 */
  glossary: { entries: number; milestone: number; reached: boolean };
  /** 测不了的指标（如实列出，不编数字）。 */
  notMeasurable: string[];
}

function appendEvent(userId: string, event: MetricEvent): void {
  const file = userTranscriptMetricsFile(userId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

export function recordConfirmLatency(
  userId: string,
  input: { ms: number; docId: string; rows: number; accepted: number },
): void {
  const ms = Math.max(0, Math.floor(Number(input.ms) || 0));
  if (ms === 0) return;
  try {
    appendEvent(userId, {
      kind: 'confirm_latency',
      ms,
      docId: String(input.docId ?? '').slice(0, 300),
      rows: Math.max(0, Math.floor(Number(input.rows) || 0)),
      accepted: Math.max(0, Math.floor(Number(input.accepted) || 0)),
      at: Date.now(),
    });
  } catch (error) {
    log.warn('record confirm latency failed', { error: (error as Error).message });
  }
}

export function recordRetention(
  userId: string,
  input: { retention: number; charsIn: number; charsOut: number; overRewrite: boolean; docId: string },
): void {
  try {
    appendEvent(userId, {
      kind: 'retention',
      retention: Math.max(0, Number(input.retention) || 0),
      charsIn: Math.max(0, Math.floor(Number(input.charsIn) || 0)),
      charsOut: Math.max(0, Math.floor(Number(input.charsOut) || 0)),
      overRewrite: input.overRewrite === true,
      docId: String(input.docId ?? '').slice(0, 300),
      at: Date.now(),
    });
  } catch (error) {
    log.warn('record retention failed', { error: (error as Error).message });
  }
}

/** 读全部事件（坏行跳过：埋点文件被手工改坏不该影响面板）。 */
export function readEvents(userId: string): MetricEvent[] {
  let raw = '';
  try {
    raw = fs.readFileSync(userTranscriptMetricsFile(userId), 'utf8');
  } catch {
    return [];
  }
  const out: MetricEvent[] = [];
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as MetricEvent;
      if (parsed?.kind === 'confirm_latency' || parsed?.kind === 'retention') out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

/** 中位数（偶数个取两数平均，四舍五入）。 */
export function median(values: number[]): number | null {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : Math.round((list[mid - 1] + list[mid]) / 2);
}

/** 汇总（纯函数：给事件与词表条数，算出方案 §8.2 的三项口径）。 */
export function summarizeMetrics(events: MetricEvent[], glossaryEntries: number): MetricsSummary {
  const latencies = events.filter((e): e is ConfirmLatencyEvent => e.kind === 'confirm_latency').map((e) => e.ms);
  const retentions = events.filter((e): e is RetentionEvent => e.kind === 'retention').map((e) => e.retention);
  const med = median(latencies);
  const medRetention = median(retentions);
  const [low, high] = RETENTION_RANGE;
  return {
    runs: retentions.length,
    confirmLatency: {
      median: med,
      mean: latencies.length ? Math.round(latencies.reduce((n, v) => n + v, 0) / latencies.length) : null,
      samples: latencies.length,
      targetMs: CONFIRM_LATENCY_TARGET_MS,
      withinTarget: med === null ? null : med < CONFIRM_LATENCY_TARGET_MS,
    },
    retention: {
      median: medRetention,
      belowRange: retentions.filter((r) => r < low).length,
      inRange: retentions.filter((r) => r >= low && r <= high).length,
      aboveRange: retentions.filter((r) => r > high).length,
      samples: retentions.length,
    },
    glossary: {
      entries: Math.max(0, Math.floor(glossaryEntries) || 0),
      milestone: GLOSSARY_ENTRY_MILESTONE,
      reached: (Math.floor(glossaryEntries) || 0) >= GLOSSARY_ENTRY_MILESTONE,
    },
    notMeasurable: [
      '单文档"来回改错词次数"：该动作发生在产品之外（用户自己改错词），本功能看不到，不编数字',
      '检索命中率提升 ≥10%：需要先有索引基线与对照环境，属自测口径，不宣称因果',
    ],
  };
}
