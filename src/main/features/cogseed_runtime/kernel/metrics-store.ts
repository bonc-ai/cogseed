/**
 * Per-round Runtime metrics (machine-private, local domain).
 *
 * The kernel had no per-round timing at all, so latency work could only be
 * inferred from tool-record timestamps. One compact JSONL line per model round
 * makes prompt size, tool count, model latency and token usage measurable
 * without touching the model-visible prompt or the protocol frames.
 *
 * No prompt or tool content is recorded: ids, counts, durations and usage only.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { cogseedRuntimeRoot } from '../../../paths';
import { appendJsonl } from '../../../storage';
import { createLogger } from '../../../logger';

const log = createLogger('cogseed-runtime:metrics');

export interface RuntimeRoundMetric {
  kind: 'round';
  request_id: string;
  runtime_session_id: string;
  trace_id?: string;
  round: number;
  prompt_chars: number;
  tool_calls: number;
  model_ms: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  agent_id?: string;
  created_at: string;
}

export function runtimeMetricsFile(uid: string): string {
  return path.join(cogseedRuntimeRoot(uid), 'metrics.jsonl');
}

export interface RuntimeToolMetric {
  kind: 'tool';
  request_id: string;
  runtime_session_id: string;
  trace_id?: string;
  round: number;
  name: string;
  tool_ms: number;
  is_error: boolean;
  created_at: string;
}

/** Best-effort: metrics must never fail a run. */
export async function appendRuntimeRoundMetric(uid: string, metric: RuntimeRoundMetric): Promise<void> {
  try {
    const file = runtimeMetricsFile(uid);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await appendJsonl(file, metric);
  } catch (error) {
    log.warn('runtime metric append failed', { error: (error as Error)?.message });
  }
}

/** One tool span per executed call, appended to the same metrics file. */
export async function appendRuntimeToolMetric(uid: string, metric: RuntimeToolMetric): Promise<void> {
  await appendRuntimeRoundMetric(uid, metric as unknown as RuntimeRoundMetric);
}
