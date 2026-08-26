/**
 * Model usage event channel.
 *
 * The model layer reports one event per completed model call (tokens, model,
 * duration, terminal status, and the identity context that was already in
 * scope). Persistence and aggregation live in the features layer, which
 * registers itself as the sink — the dependency direction stays
 * features → model; this module imports nothing from features.
 *
 * Contract (see test/main/model/usage-events.test.ts):
 *   - emitting with no sink registered is a safe no-op;
 *   - a throwing sink never propagates into the model call path;
 *   - registering null detaches the previous sink.
 */

export interface ModelUsageEvent {
  /** Epoch ms when the call finished. */
  at: number;
  userId?: string;
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  /** First-token latency in ms relative to turn start; omitted when unrecorded. */
  firstTokenMs?: number;
  durationMs: number;
  status: 'completed' | 'error' | 'aborted' | 'idle_timeout' | 'empty';
}

export type ModelUsageSink = (event: ModelUsageEvent) => void;

let sink: ModelUsageSink | null = null;

export function setModelUsageSink(next: ModelUsageSink | null): void {
  sink = next || null;
}

export function emitModelUsage(event: ModelUsageEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Usage accounting must never break the model call it accounts for.
  }
}
