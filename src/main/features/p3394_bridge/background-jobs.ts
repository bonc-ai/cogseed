/**
 * p3394 background jobs — the two-phase protocol for a run that outlives its turn.
 *
 * When the execution layer promotes a long CLI run instead of killing it (see the
 * B line / `promoteOnDeadline`), the original request no longer has a reply to
 * wait for. The gateway then answers in two phases:
 *
 *   1. immediately:    { phase: 'accepted', job_id, eta_seconds? }
 *   2. when it ends:   { phase: 'finished', job_id, outcome, summary?, ... }
 *
 * The second phase must NOT ride the reply waiter: `sendAndWait` gives up after
 * `replyTimeoutMs` (default 5 min), which is exactly the window a promoted run
 * exceeds. It is delivered as its own outbound message instead.
 *
 * Both phases travel in `extensions.background` so the envelope schema and its
 * validation stay untouched — the same place `reply_endpoint` / `reply_token`
 * already live.
 */

/** Shape carried in `envelope.extensions.background` for phase 1. */
export interface P3394BackgroundAccepted {
  phase: 'accepted';
  /** Deterministic per (peer, task): the same run can never mint a second job. */
  job_id: string;
  /** Optional rough estimate, so the initiator can say "可能在 15 分钟内". */
  eta_seconds?: number;
  note?: string;
}

/** Terminal outcomes a background job can reach. */
export const P3394_BACKGROUND_OUTCOMES = ['completed', 'failed', 'timeout'] as const;
export type P3394BackgroundOutcome = (typeof P3394_BACKGROUND_OUTCOMES)[number];

/** Shape carried in `envelope.extensions.background` for phase 2. */
export interface P3394BackgroundFinished {
  phase: 'finished';
  job_id: string;
  outcome: P3394BackgroundOutcome;
  summary?: string;
  artifacts?: string[];
  /** Truncated tail, never the full log — the receiver is a chat surface. */
  log_tail?: string;
  error?: { code?: string; message: string };
}

export type P3394BackgroundPhase = P3394BackgroundAccepted | P3394BackgroundFinished;

/** Hard ceiling for a promoted run before it is reported as `timeout`. */
export const P3394_BACKGROUND_JOB_DEADLINE_MS = 60 * 60 * 1000;
/** Tail kept from the job log; enough to explain a failure, not to replay it. */
export const P3394_BACKGROUND_LOG_TAIL_CHARS = 2000;

const JOB_ID_RE = /^bg-[A-Za-z0-9._:-]{1,120}$/;

/**
 * Deterministic job id. Derived (never random) so a retried promotion resolves to
 * the same job and phase 2 stays idempotent end to end.
 */
export function backgroundJobId(peerId: string, taskId: string): string {
  const clean = (value: string): string => String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return `bg-${clean(peerId) || 'peer'}-${clean(taskId) || 'task'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Validate phase 1. Returns null when the shape is not a background ack. */
export function parseBackgroundAccepted(value: unknown): P3394BackgroundAccepted | null {
  if (!isRecord(value) || value.phase !== 'accepted') return null;
  const jobId = optionalString(value.job_id, 160);
  if (!jobId || !JOB_ID_RE.test(jobId)) return null;
  const eta = value.eta_seconds;
  const etaSeconds = typeof eta === 'number' && Number.isFinite(eta) && eta > 0 && eta <= 24 * 60 * 60
    ? Math.round(eta)
    : undefined;
  const note = optionalString(value.note, 200);
  return {
    phase: 'accepted',
    job_id: jobId,
    ...(etaSeconds ? { eta_seconds: etaSeconds } : {}),
    ...(note ? { note } : {}),
  };
}

/** Validate phase 2. Returns null when the shape is not a background result. */
export function parseBackgroundFinished(value: unknown): P3394BackgroundFinished | null {
  if (!isRecord(value) || value.phase !== 'finished') return null;
  const jobId = optionalString(value.job_id, 160);
  if (!jobId || !JOB_ID_RE.test(jobId)) return null;
  const outcome = P3394_BACKGROUND_OUTCOMES.find((candidate) => candidate === value.outcome);
  if (!outcome) return null;
  const summary = optionalString(value.summary, 2000);
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts
      .map((entry) => optionalString(entry, 500))
      .filter((entry): entry is string => !!entry)
      .slice(0, 50)
    : undefined;
  const logTail = optionalString(value.log_tail, P3394_BACKGROUND_LOG_TAIL_CHARS);
  const error = isRecord(value.error) && typeof value.error.message === 'string'
    ? {
      ...(optionalString(value.error.code, 80) ? { code: optionalString(value.error.code, 80) } : {}),
      message: value.error.message.slice(0, 1000),
    }
    : undefined;
  return {
    phase: 'finished',
    job_id: jobId,
    outcome,
    ...(summary ? { summary } : {}),
    ...(artifacts && artifacts.length ? { artifacts } : {}),
    ...(logTail ? { log_tail: logTail } : {}),
    ...(error ? { error } : {}),
  };
}

/** Either phase, or null. */
export function parseBackgroundPhase(value: unknown): P3394BackgroundPhase | null {
  return parseBackgroundAccepted(value) ?? parseBackgroundFinished(value);
}

/** True when a finished job carries enough to be shown to a human. */
export function backgroundResultIsInformative(result: P3394BackgroundFinished): boolean {
  if (result.outcome === 'completed') return !!(result.summary || (result.artifacts && result.artifacts.length));
  return !!(result.error || result.summary || result.log_tail);
}
