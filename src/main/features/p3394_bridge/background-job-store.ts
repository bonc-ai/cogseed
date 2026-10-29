/**
 * p3394 background-job ledger — the machine-private half of the two-phase
 * protocol (decision 2, steps 3–4).
 *
 * The gateway answers a promoted run immediately (`extensions.background` phase
 * `accepted`) and later pushes the result as its own message (phase `finished`).
 * Between those two frames the app has to remember:
 *
 *   - which job it is waiting for (job_id is the idempotency key),
 *   - the peer's reply endpoint/token that the *gateway* saved from our
 *     request, so a locally-synthesized timeout can name the same target,
 *   - when the job's independent 60-minute ceiling expires,
 *   - whether the result has already entered the conversation.
 *
 * That ledger is user-private (it carries the bridge token), machine-local and
 * therefore lives under `<uid>/local/p3394/background-jobs.json` with mode 0600.
 * The store is deliberately dumb: validation + atomic persistence only.
 * Watchdogs, retries and delivery live in outbound-hub.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { userLocalRoot } from '../../paths';
import { sanitizeLogTextForUpload } from '../../util/log-sanitize';
import {
  P3394_BACKGROUND_JOB_DEADLINE_MS,
  type P3394BackgroundFinished,
} from './background-jobs';

const log = createLogger('p3394-bridge:background-jobs');

export type P3394BackgroundJobState =
  | 'pending'
  | 'finished'
  | 'timeout'
  | 'delivered'
  | 'isolated'
  | 'discarded';

const JOB_STATES: ReadonlySet<string> = new Set([
  'pending', 'finished', 'timeout', 'delivered', 'isolated', 'discarded',
]);

const JOB_ID_RE = /^bg-[A-Za-z0-9._:-]{1,120}$/;

export interface P3394BackgroundJobRecord {
  /** Deterministic `bg-<peer>-<task>` id; also the delivery idempotency key. */
  job_id: string;
  /** Peer (gateway node id) the job belongs to. */
  peer: string;
  /** reply_endpoint/reply_token from our own outbound envelope: the gateway
   *  saves them and pushes phase 2 there. Kept for replay diagnostics and for a
   *  peer-side timeout leg; never logged. */
  reply_endpoint: string;
  reply_token: string;
  /** ISO instant of the independent job ceiling (accepted_at + 60 min). */
  deadline: string;
  state: P3394BackgroundJobState;
  accepted_at: string;
  updated_at: string;
  session_id: string;
  /** Conversation the originating turn belonged to. The P3394 session id maps
   *  to a group-chat cid, but an outbound turn can bind a user-visible cid;
   *  storing it keeps phase-2 delivery on the same conversation after a boot
   *  (the in-memory binding is gone then). */
  conversation_id?: string;
  task_id?: string;
  eta_seconds?: number;
  /** Terminal payload recorded before delivery (write-ahead). */
  result?: P3394BackgroundFinished;
  delivered_at?: string;
  /** Delivery failures since the last requeue; isolates after attempts. */
  attempts?: number;
  last_error?: string;
}

interface BackgroundJobsFile {
  schema_version: 1;
  jobs: P3394BackgroundJobRecord[];
}

function assertUid(uid: string): string {
  const value = String(uid || '');
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('p3394_background_invalid_uid');
  }
  return value;
}

export function backgroundJobsFile(uid: string): string {
  return path.join(userLocalRoot(assertUid(uid)), 'p3394', 'background-jobs.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isoOrNow(value: unknown, fallback: string): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function parseResult(value: unknown): P3394BackgroundFinished | undefined {
  if (!isRecord(value) || value.phase !== 'finished') return undefined;
  const outcome = value.outcome;
  if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'timeout') return undefined;
  const jobId = optionalString(value.job_id, 160);
  if (!jobId || !JOB_ID_RE.test(jobId)) return undefined;
  const summary = optionalString(value.summary, 2000);
  const logTail = optionalString(value.log_tail, 2000);
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.map((entry) => optionalString(entry, 500)).filter((entry): entry is string => !!entry).slice(0, 50)
    : undefined;
  const error = isRecord(value.error) && typeof value.error.message === 'string'
    ? { message: value.error.message.slice(0, 1000), ...(optionalString(value.error.code, 80) ? { code: optionalString(value.error.code, 80) } : {}) }
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

function parseRecord(value: unknown): P3394BackgroundJobRecord | null {
  if (!isRecord(value)) return null;
  const jobId = optionalString(value.job_id, 160);
  if (!jobId || !JOB_ID_RE.test(jobId)) return null;
  const peer = optionalString(value.peer, 160);
  if (!peer) return null;
  const state = optionalString(value.state, 20);
  if (!state || !JOB_STATES.has(state)) return null;
  const now = new Date().toISOString();
  const acceptedAt = isoOrNow(value.accepted_at, now);
  const deadline = isoOrNow(value.deadline, new Date(Date.parse(acceptedAt) + P3394_BACKGROUND_JOB_DEADLINE_MS).toISOString());
  const eta = typeof value.eta_seconds === 'number' && Number.isFinite(value.eta_seconds) && value.eta_seconds > 0
    ? Math.round(value.eta_seconds)
    : undefined;
  const attempts = typeof value.attempts === 'number' && Number.isFinite(value.attempts) && value.attempts >= 0
    ? Math.floor(value.attempts)
    : undefined;
  return {
    job_id: jobId,
    peer,
    reply_endpoint: optionalString(value.reply_endpoint, 2000) || '',
    // The token is stored verbatim (file is 0600); it must never reach logs.
    reply_token: typeof value.reply_token === 'string' ? value.reply_token.slice(0, 2000) : '',
    deadline,
    state: state as P3394BackgroundJobState,
    accepted_at: acceptedAt,
    updated_at: isoOrNow(value.updated_at, acceptedAt),
    session_id: optionalString(value.session_id, 200) || '',
    ...(optionalString(value.conversation_id, 200) ? { conversation_id: optionalString(value.conversation_id, 200) } : {}),
    ...(optionalString(value.task_id, 200) ? { task_id: optionalString(value.task_id, 200) } : {}),
    ...(eta ? { eta_seconds: eta } : {}),
    ...(parseResult(value.result) ? { result: parseResult(value.result) } : {}),
    ...(optionalString(value.delivered_at, 80) ? { delivered_at: isoOrNow(value.delivered_at, now) } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(optionalString(value.last_error, 300) ? { last_error: sanitizeLogTextForUpload(String(value.last_error)).slice(0, 300) } : {}),
  };
}

/** Read the ledger. A corrupt file must never break bridge boot: unreadable
 *  entries are dropped with a warning, not thrown. */
export function loadBackgroundJobs(uid: string): P3394BackgroundJobRecord[] {
  const file = backgroundJobsFile(uid);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    log.warn('P3394 background-job ledger is corrupt; starting empty', { file });
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : (isRecord(parsed) && Array.isArray(parsed.jobs) ? parsed.jobs : []);
  const out: P3394BackgroundJobRecord[] = [];
  for (const row of rows) {
    const record = parseRecord(row);
    if (record) out.push(record);
  }
  return out;
}

/** Atomic 0600 write: temp file in the same directory + rename, so a crash
 *  mid-write can never leave a truncated ledger (the replay set is the only
 *  record that a promoted job exists). */
export function saveBackgroundJobs(uid: string, jobs: P3394BackgroundJobRecord[]): void {
  const file = backgroundJobsFile(uid);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: BackgroundJobsFile = { schema_version: 1, jobs };
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function getBackgroundJob(uid: string, jobId: string): P3394BackgroundJobRecord | undefined {
  return loadBackgroundJobs(uid).find((job) => job.job_id === jobId);
}

/** Insert or replace one job by job_id. Callers write before any network
 *  effect (accepted frame / finished frame / timeout), never after. */
export function putBackgroundJob(uid: string, job: P3394BackgroundJobRecord): P3394BackgroundJobRecord {
  const jobs = loadBackgroundJobs(uid);
  const index = jobs.findIndex((candidate) => candidate.job_id === job.job_id);
  const next = { ...job, updated_at: new Date().toISOString() };
  if (index >= 0) jobs[index] = next;
  else jobs.push(next);
  saveBackgroundJobs(uid, jobs);
  return next;
}

export function patchBackgroundJob(
  uid: string,
  jobId: string,
  patch: Partial<Omit<P3394BackgroundJobRecord, 'job_id'>>,
): P3394BackgroundJobRecord | null {
  const jobs = loadBackgroundJobs(uid);
  const index = jobs.findIndex((candidate) => candidate.job_id === jobId);
  if (index < 0) return null;
  const next: P3394BackgroundJobRecord = {
    ...jobs[index],
    ...patch,
    job_id: jobs[index].job_id,
    updated_at: new Date().toISOString(),
  };
  jobs[index] = next;
  saveBackgroundJobs(uid, jobs);
  return next;
}

/** Jobs whose terminal payload has not yet entered the conversation. */
export function listUndeliveredBackgroundJobs(uid: string): P3394BackgroundJobRecord[] {
  return loadBackgroundJobs(uid).filter((job) => (
    job.state === 'pending' || job.state === 'finished' || job.state === 'timeout'
  ));
}

/** Re-queue an isolated job (operator action / retry after the cause is gone). */
export function requeueBackgroundJob(uid: string, jobId: string): boolean {
  const job = getBackgroundJob(uid, jobId);
  if (!job || job.state !== 'isolated') return false;
  patchBackgroundJob(uid, jobId, { state: job.result ? 'finished' : 'pending', attempts: 0, last_error: undefined });
  return true;
}

/** Build the local timeout result for a job that outlived its ceiling. */
export function backgroundTimeoutResult(jobId: string): P3394BackgroundFinished {
  return {
    phase: 'finished',
    job_id: jobId,
    outcome: 'timeout',
    error: {
      code: 'p3394_background_timeout',
      message: `background job exceeded ${Math.round(P3394_BACKGROUND_JOB_DEADLINE_MS / 60000)} minutes`,
    },
  };
}
