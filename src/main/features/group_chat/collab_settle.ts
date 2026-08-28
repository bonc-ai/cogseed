/**
 * External-agent handback settlement + run-finalization hooks (COGSEED-61).
 *
 * p3394-gateway agents execute OUTSIDE the in-process nested-dispatch
 * lifecycle: the dispatch posts the task to the gateway, and the agent's
 * reply comes back through the backend task projection
 * (appendProjectedAgentMessage). That projected turn carries no
 * workflow_step_id, so the prepared dispatch step stayed `pending` forever.
 *
 * This module closes the loop end-to-end for the async (wake) dispatch path:
 *
 *   agent reply settles its dispatch step
 *     → when ALL steps are terminal:
 *         last completed step via hand_off_to → the deliverable already
 *           stands: finalize now (generate the collaboration summary).
 *         last completed step via dispatch_to/run_worker → the commander
 *           promised a next action but its turn already ended with the
 *           pending wake: wake it back (internalControl) to synthesise the
 *           final deliverable; the summary finalizes after that turn.
 *
 * Everything here is best-effort: failures are logged and never block the
 * inbound message or the agent's own reply.
 */

import * as path from "node:path";
import * as fsp from "node:fs/promises";

import { nowIso, readJson, writeJson } from "../../storage";
import { createLogger } from "../../logger";

import {
  collaborationPaths,
  finishNestedDispatchStep,
  finishWorkflowStepAttempt,
  readActiveWorkflowRun,
  startPreparedNestedDispatchStep,
  type WorkflowRun,
} from "./collaboration";

const log = createLogger("group_chat.collab_settle");

const SUMMARY_LIMIT = 200;

function resultHead(text: string): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > SUMMARY_LIMIT ? `${clean.slice(0, SUMMARY_LIMIT - 1)}…` : clean;
}

/**
 * Settle the newest open dispatch step for `actorId` in the conversation's
 * active workflow run. Called from the projected-reply path after the
 * agent's own message has persisted (the reply IS the step result). No-op
 * when the actor has no open step.
 */
export async function settleExternalAgentHandback(
  uid: string,
  cid: string,
  actorId: string,
  replyText: string,
  opts?: { failed?: boolean },
): Promise<void> {
  try {
    const run = await readActiveWorkflowRun(uid, cid);
    if (!run) return;
    // Newest open step for the actor: run.steps is append-ordered, so the
    // last open entry is the most recent dispatch (started_at is absent on
    // never-started steps and cannot break the tie).
    const open = run.steps.filter(
      (step) =>
        step.actor_id === actorId &&
        (step.status === "pending" || step.status === "running"),
    );
    const step = open[open.length - 1];
    if (!step) return;

    if (step.status === "pending") {
      // The gateway executed without our lifecycle seeing a start; bring the
      // step through start so the finish transition is state-machine legal.
      await startPreparedNestedDispatchStep(uid, cid, step.id);
    }
    const running = (step.attempts || []).at(-1);
    if (running && running.status === "running") {
      await finishWorkflowStepAttempt(uid, cid, step.id, {
        status: "completed",
      }).catch(() => undefined);
    }
    await finishNestedDispatchStep(uid, cid, step.id, opts?.failed
      ? { error: resultHead(replyText) || "Agent task failed." }
      : { result: resultHead(replyText) });
    log.info(
      `external handback settled uid=${uid} cid=${cid} actor=${actorId} step=${step.id} failed=${!!opts?.failed}`,
    );
  } catch (err) {
    log.warn(
      `external handback settle failed uid=${uid} cid=${cid} actor=${actorId}: ${(err as Error).message}`,
    );
    return;
  }
  await maybeFinalizeRun(uid, cid);
}

// ── Run finalization ──────────────────────────────────────────────────────

interface SynthesisWakeMarker {
  version: 1;
  run_id: string;
  woken_at: string;
}

function synthesisWakeFile(uid: string, cid: string, projectIdHint?: string | null): string {
  return path.join(collaborationPaths(uid, cid, projectIdHint).rootDir, "synthesis-wake.json");
}

async function readSynthesisWakeMarker(
  uid: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<SynthesisWakeMarker | null> {
  const raw = await readJson<unknown>(
    synthesisWakeFile(uid, cid, projectIdHint),
  ).catch(() => null);
  const marker = raw as Partial<SynthesisWakeMarker> | null;
  if (!marker || marker.version !== 1 || typeof marker.run_id !== "string") return null;
  return marker as SynthesisWakeMarker;
}

function allStepsTerminal(run: WorkflowRun): boolean {
  return (
    run.steps.length > 0 &&
    run.steps.every(
      (step) =>
        step.status === "completed" || step.status === "failed" || step.status === "skipped",
    )
  );
}

function lastCompletedStep(run: WorkflowRun) {
  const completed = run.steps.filter((step) => step.completed_at);
  if (!completed.length) return undefined;
  return completed.reduce((latest, step) =>
    String(step.completed_at || "").localeCompare(String(latest.completed_at || "")) >= 0
      ? step
      : latest,
  );
}

const SYNTHESIS_WAKE_MODEL_TEXT = [
  "<collab-synthesis-wake>",
  "All dispatched sub-tasks of your current multi-agent task in this conversation have completed — each agent's full reply is visible above.",
  "Deliver the final consolidated result to the user NOW (the comparison / synthesis they originally asked for).",
  "Rules: do NOT restate or re-bless any single agent's reply; synthesise ACROSS the results. If you were asked for a table/comparison, produce it. This is your one synthesis turn — after your delivery, a collaboration summary record is appended automatically; do not mention that record.",
  "</collab-synthesis-wake>",
].join("\n");

/**
 * After an external-agent reply settles its step: when the whole run has
 * reached its terminal state, either finalize immediately (hand_off_to —
 * the agent's deliverable already stands) or wake the commander back for
 * the synthesis turn it promised when it chose dispatch_to (internalControl
 * so it does not behave like a fresh user message).
 */
async function maybeFinalizeRun(uid: string, cid: string): Promise<void> {
  try {
    const run = await readActiveWorkflowRun(uid, cid);
    if (!run || !allStepsTerminal(run)) return;

    const last = lastCompletedStep(run);
    if (!last) return;
    if (last.source_tool === "hand_off_to") {
      await finalizeCollabRun(uid, cid);
      return;
    }

    const marker = await readSynthesisWakeMarker(uid, cid);
    if (marker && marker.run_id === run.id) return; // already woken
    await writeJson(synthesisWakeFile(uid, cid), {
      version: 1,
      run_id: run.id,
      woken_at: nowIso(),
    } satisfies SynthesisWakeMarker);

    // Dynamic import: bus imports this module for the settle hook; a static
    // back-import would be circular at module-init time.
    const { enqueue } = await import("./bus");
    const { COMMANDER_ID, USER_ID } = await import("./state");
    await enqueue({
      uid,
      cid,
      fromActorId: USER_ID,
      internalControl: true,
      forceTo: [COMMANDER_ID],
      // Terse user-visible cue; the full instruction rides on model_text
      // (system-created messages keep the human line short).
      text: "所有子任务已完成，等待汇总交付。",
      model_text: SYNTHESIS_WAKE_MODEL_TEXT,
    });
    log.info(`synthesis wake sent uid=${uid} cid=${cid} run=${run.id}`);
  } catch (err) {
    log.warn(
      `run finalization check failed uid=${uid} cid=${cid}: ${(err as Error).message}`,
    );
  }
}

/**
 * Called after a commander turn-end message persisted: only acts when a
 * synthesis wake marker is outstanding (cheap no-op otherwise), meaning the
 * just-finished turn was the synthesis the wake asked for — finalize the
 * collaboration summary right after the deliverable.
 */
export async function finalizeCollabRunAfterCommanderTurn(
  uid: string,
  cid: string,
): Promise<void> {
  try {
    const marker = await readSynthesisWakeMarker(uid, cid);
    if (!marker) return;
  } catch {
    return;
  }
  await finalizeCollabRun(uid, cid);
}

/**
 * Generate the collaboration summary for a fully-terminal run (idempotent —
 * ensureCollabSummary skips when summary.json already covers the run) and
 * let the desktop broadcast surface it. Called either directly for
 * hand_off_to endings or after the commander's synthesis turn persisted.
 */
export async function finalizeCollabRun(uid: string, cid: string): Promise<void> {
  try {
    const marker = await readSynthesisWakeMarker(uid, cid);
    if (marker) {
      await fsp.unlink(synthesisWakeFile(uid, cid)).catch(() => undefined);
    }
    const { buildCollabOverview } = await import("./collab_overview");
    await buildCollabOverview(uid, cid);
  } catch (err) {
    log.warn(
      `collab run finalize failed uid=${uid} cid=${cid}: ${(err as Error).message}`,
    );
  }
}
