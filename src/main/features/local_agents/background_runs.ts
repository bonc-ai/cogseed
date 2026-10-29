/**
 * Background runs — records for external-CLI dispatches that outlived the turn
 * that started them.
 *
 * Why: a CLI dispatch has a wall-clock cap and an idle-kill watchdog (see
 * `armKillWatchdog`). Killing a run that is demonstrably still working throws
 * away real work, so a run that reaches a deadline may instead be *promoted*:
 * the child keeps running, the turn returns a handle, and the record below is
 * what later reads (`background_list` / `background_output`) and the cleanup
 * rules operate on.
 *
 * Boundaries:
 *   - Machine-private (`paths.userBackgroundRunsDir` → `local/`): a promoted run
 *     is bound to the machine holding its child process, so it never syncs.
 *   - uid-scoped paths are resolved per call, never cached in a module constant.
 *   - One file per run, written atomically (tmp + rename) so a reader never sees
 *     a half-written record. Records are plain JSON for readability.
 *   - This module owns **no** process lifetime: it records what the runner did.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger';
import { userBackgroundRunFile, userBackgroundRunsDir } from '../../paths';

const log = createLogger('local-agents:background-runs');

export type BackgroundRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface BackgroundRunRecord {
  runId: string;
  /** What kind of work this is. Only external CLI dispatches today. */
  kind: 'local-cli';
  cli: string;
  uid: string;
  cwd: string;
  /** Command line as spawned (binary + args), for display and re-running. */
  argv: string[];
  pid: number | null;
  startedAt: string;
  /** Why the run was promoted rather than killed. */
  promotedBy: 'wall' | 'idle';
  /** Where the live/complete output lives (spool or persisted result), if known. */
  outputPath?: string;
  /** Tool-result reference for `outputPath`, when the runner has one. */
  resultRef?: string;
  status: BackgroundRunStatus;
  updatedAt: string;
  /** Exit code once the child settles; null while running or when signalled. */
  exitCode?: number | null;
  error?: string;
}

function ensureDir(uid: string): string {
  const dir = userBackgroundRunsDir(uid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Atomic write: a reader must never observe a truncated record. */
function writeRecord(uid: string, record: BackgroundRunRecord): void {
  const dir = ensureDir(uid);
  const target = userBackgroundRunFile(uid, record.runId);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

export function createBackgroundRun(record: BackgroundRunRecord): void {
  writeRecord(record.uid, record);
}

export function updateBackgroundRun(
  uid: string,
  runId: string,
  patch: Partial<Omit<BackgroundRunRecord, 'runId' | 'uid' | 'kind'>>,
): BackgroundRunRecord | null {
  const current = readBackgroundRun(uid, runId);
  if (!current) return null;
  const next: BackgroundRunRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeRecord(uid, next);
  return next;
}

export function readBackgroundRun(uid: string, runId: string): BackgroundRunRecord | null {
  try {
    const raw = fs.readFileSync(userBackgroundRunFile(uid, runId), 'utf8');
    const parsed = JSON.parse(raw) as BackgroundRunRecord;
    return parsed && typeof parsed.runId === 'string' ? parsed : null;
  } catch {
    return null;   // absent or unreadable is the same answer for callers
  }
}

/** Newest first. A malformed record is skipped rather than failing the listing. */
export function listBackgroundRuns(uid: string): BackgroundRunRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(userBackgroundRunsDir(uid));
  } catch {
    return [];
  }
  const out: BackgroundRunRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = readBackgroundRun(uid, name.slice(0, -'.json'.length));
    if (record) out.push(record);
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return out;
}

/** Remove a settled record. Refuses while the run is still `running` so a live
 *  child never loses the record that cleanup rules depend on. */
export function removeBackgroundRun(uid: string, runId: string): boolean {
  const record = readBackgroundRun(uid, runId);
  if (!record) return false;
  if (record.status === 'running') return false;
  try {
    fs.unlinkSync(userBackgroundRunFile(uid, runId));
    return true;
  } catch (err) {
    log.warn('background run unlink failed', { runId, error: String(err) });
    return false;
  }
}
