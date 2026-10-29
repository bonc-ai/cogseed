/**
 * Boot-time closure of group-chat run actors that no live worker owns.
 *
 * Why: a worker's card state lives in the run record (`actors[].terminal`,
 * written by `recordRunActorTerminal`). If the main process dies mid-turn — or a
 * turn simply never reaches its terminal path — the actor stays `'pending'`
 * forever, so the UI keeps showing a worker as running with no way to see that
 * nothing is executing it. The 2026-10-12 evidence shows exactly this shape:
 * `gworker` sessions are ephemeral, the run produced no terminal, and boot
 * recovery only reconciled *tasks* (`recoveredCount` / `workflowStepsReconciled`
 * / `retainedResults*`) — it had no notion of a run actor at all.
 *
 * Invariant this module relies on: during a fresh boot **no run actor can still
 * be legitimately pending**, because pending means "dispatched and never
 * terminated" and the dispatch belongs to a previous process. Anything pending
 * at boot is therefore closed as `blocked` with the same `worker_restart` reason
 * the task path already uses, so task and card tell the same story.
 *
 * Turn/lifecycle semantics only: no timers, no wall-clock thresholds.
 */
import { createLogger } from '../../logger';
import { logErrorRef } from '../../util/log-redact';
import { listConversations } from '../chats';
import { listRunIds, readRun, recordRunActorTerminal } from './run_store';

const log = createLogger('group-chat:run-recovery');

/** Reason recorded on every actor closed by boot recovery. Kept identical to the
 *  task-level `errorCode` so both surfaces describe the same event. */
export const RUN_ACTOR_RESTART_REASON = 'worker_restart';

/** Bound the work a single boot performs. Recovery is best-effort: leftovers are
 *  closed on the next boot rather than making startup proportional to history. */
const MAX_CLOSURES_PER_BOOT = 200;

export interface StaleRunActorClosureReport {
  scannedConversations: number;
  scannedRuns: number;
  closedActors: number;
}

/** Actor ids still awaiting a terminal in this run record, in file order. */
export function pendingRunActorIds(run: {
  actors?: Array<{ agent_id?: string; terminal?: string }>;
} | null | undefined): string[] {
  const actors = Array.isArray(run?.actors) ? run!.actors! : [];
  return actors
    .filter((actor) => actor?.terminal === 'pending')
    .map((actor) => String(actor?.agent_id || ''))
    .filter(Boolean);
}

/**
 * Close every actor left pending by a previous process. Never throws: a single
 * unreadable conversation or run must not abort startup.
 */
export async function closeStaleRunActorsAtBoot(uid: string): Promise<StaleRunActorClosureReport> {
  const report: StaleRunActorClosureReport = {
    scannedConversations: 0,
    scannedRuns: 0,
    closedActors: 0,
  };

  let conversationIds: string[] = [];
  try {
    const conversations = await listConversations(uid);
    conversationIds = conversations
      .map((conversation) => String((conversation as { cid?: string; id?: string })?.cid
        || (conversation as { id?: string })?.id
        || ''))
      .filter(Boolean);
  } catch (err) {
    log.warn('run actor recovery: conversation listing failed', { uid, error: logErrorRef(err as Error) });
    return report;
  }

  for (const cid of conversationIds) {
    if (report.closedActors >= MAX_CLOSURES_PER_BOOT) break;
    report.scannedConversations += 1;

    let runIds: string[] = [];
    try {
      runIds = await listRunIds(uid, cid);
    } catch {
      continue; // no runs directory for this conversation
    }

    for (const runId of runIds) {
      if (report.closedActors >= MAX_CLOSURES_PER_BOOT) break;
      report.scannedRuns += 1;

      let run: Awaited<ReturnType<typeof readRun>> = null;
      try {
        run = await readRun(uid, cid, runId);
      } catch (err) {
        log.warn('run actor recovery: run read failed', { uid, cid, runId, error: logErrorRef(err as Error) });
        continue;
      }

      const pending = pendingRunActorIds(run as never);
      for (const agentId of pending) {
        if (report.closedActors >= MAX_CLOSURES_PER_BOOT) break;
        try {
          await recordRunActorTerminal(uid, cid, runId, agentId, {
            terminal: 'blocked',
            reason: RUN_ACTOR_RESTART_REASON,
          });
          report.closedActors += 1;
          log.warn('closed run actor left pending by a previous process', {
            uid,
            cid,
            runId,
            agentId,
            reason: RUN_ACTOR_RESTART_REASON,
          });
        } catch (err) {
          log.warn('run actor recovery: closure failed', {
            uid, cid, runId, agentId, error: logErrorRef(err as Error),
          });
        }
      }
    }
  }

  if (report.closedActors > 0) {
    log.warn('run actor recovery completed', { uid, ...report });
  }
  return report;
}
