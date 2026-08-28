/**
 * External-agent handback settlement (COGSEED-61).
 *
 * p3394-gateway agents execute OUTSIDE the in-process nested-dispatch
 * lifecycle: the dispatch posts the task to the gateway, and the agent's
 * reply comes back as an external inbound message (p3394_bridge
 * conversation-runtime → bus.enqueue with externalInbound). That inbound
 * turn carries no workflow_step_id, so the prepared dispatch step stayed
 * `pending` forever and the collaboration overview showed a task that never
 * finished.
 *
 * This module closes the loop: on external inbound from an agent that has an
 * open dispatch step in the active workflow run, settle that step
 * (start → finish with the reply as result_summary). Best-effort only —
 * settlement failure never blocks the inbound message.
 */

import { createLogger } from "../../logger";

import {
  finishNestedDispatchStep,
  finishWorkflowStepAttempt,
  readActiveWorkflowRun,
  startPreparedNestedDispatchStep,
} from "./collaboration";

const log = createLogger("group_chat.collab_settle");

const SUMMARY_LIMIT = 200;

function resultHead(text: string): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > SUMMARY_LIMIT ? `${clean.slice(0, SUMMARY_LIMIT - 1)}…` : clean;
}

/**
 * Settle the newest open dispatch step for `actorId` in the conversation's
 * active workflow run. Called from the external-inbound path in bus.enqueue
 * after the agent's own message has been persisted (the reply IS the step
 * result). No-op when the actor has no open step.
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
  }
}
