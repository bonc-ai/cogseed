import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { maskId } from '../../util/log-redact';
import {
  confirmContextProjection,
  readContextProjection,
  rejectContextProjection,
  type ContextProjectionRecord,
} from '../recall/context-projection';
import { loadCommittedProjectionKnowledge } from '../recall/projection-knowledge';
import { clearPendingProjectionDispatch, readState } from '../group_chat/state';
import {
  createInitialConversationTaskState,
  readConversationTaskState,
  replaceConversationTaskState,
} from './requirement-store';
import type { KstarProjectionDecisionMarker } from './requirement-types';

/**
 * projection-decision-service.ts — Commander-centric Projection decisions.
 *
 * Confirming or rejecting a Recall Projection resumes the SAME Commander
 * session through a bounded internal control message. No Forecast model is
 * ever launched here; the host only persists state, builds the confirmed
 * knowledge snapshot, and enqueues the existing Commander worker.
 */

export interface CommanderProjectionControl {
  type: 'kstar_projection_decision';
  projectionId: string;
  decision: 'approved' | 'rejected';
  confirmedSnapshot?: { assetIds: string[]; ruleRefs: string[] };
  legacy?: { requirementId?: string; taskRunId?: string; forecastId?: string; originalText?: string };
}

export interface EnqueueCommanderControlInput {
  userId: string;
  cid: string;
  displayText: string;
  control: CommanderProjectionControl;
}

export interface ProjectionDecisionDependencies {
  enqueueControl?: (input: EnqueueCommanderControlInput) => Promise<void>;
}

export interface ProjectionResumeResult {
  projection: ContextProjectionRecord;
  resumed: boolean;
}

export type LegacyRecoveryResult = 'none' | 'waiting_confirmation' | 'resumed';

const log = createLogger('kstar.projection-decision');
const MAX_PROJECTION_DECISIONS = 100;
const inFlight = new Set<string>();

async function defaultEnqueueControl(input: EnqueueCommanderControlInput): Promise<void> {
  const bus = await import('../group_chat/bus');
  await bus.enqueueCommanderControlMessage(input);
}

function assertRefs(userId: string, cid: string, projectionId: string): void {
  if (!safeId(userId) || !safeId(cid) || !safeId(projectionId)) {
    throw new Error('invalid projection decision reference');
  }
}

async function confirmedProjection(userId: string, projectionId: string): Promise<ContextProjectionRecord> {
  try {
    return await confirmContextProjection(userId, projectionId);
  } catch (error) {
    if (!/already confirmed/i.test((error as Error).message || '')) throw error;
    const projection = await readContextProjection(userId, projectionId);
    if (projection.status !== 'confirmed') throw error;
    return projection;
  }
}

/**
 * Resumes the Commander exactly once per `projectionId:decision`. A bounded,
 * persisted marker keyed by `projectionId:decision` prevents duplicate
 * enqueue on repeated confirm/reject clicks or concurrent callers.
 */
async function resumeOnce(
  userId: string,
  cid: string,
  displayText: string,
  control: CommanderProjectionControl,
  enqueueControl: (input: EnqueueCommanderControlInput) => Promise<void>,
): Promise<boolean> {
  const markerKey = `${control.projectionId}:${control.decision}`;
  const lockKey = `${cid}:${markerKey}`;
  if (inFlight.has(lockKey)) return false;
  inFlight.add(lockKey);
  try {
    const state = await readConversationTaskState(userId, cid);
    if (state?.projectionDecisions?.some((marker) => marker.key === markerKey && marker.resumed)) {
      return false;
    }
    await enqueueControl({ userId, cid, displayText, control });
    const marker: KstarProjectionDecisionMarker = {
      key: markerKey,
      projectionId: control.projectionId,
      decision: control.decision,
      resumed: true,
      createdAt: nowIso(),
    };
    const base = (await readConversationTaskState(userId, cid)) || state
      || createInitialConversationTaskState(userId, cid);
    await replaceConversationTaskState(userId, {
      ...base,
      projectionDecisions: [...(base.projectionDecisions || []), marker].slice(-MAX_PROJECTION_DECISIONS),
      updatedAt: nowIso(),
    });
    return true;
  } finally {
    inFlight.delete(lockKey);
  }
}

export async function confirmProjectionAndResumeCommander(
  userId: string,
  input: { cid: string; projectionId: string },
  dependencies: ProjectionDecisionDependencies = {},
): Promise<ProjectionResumeResult> {
  assertRefs(userId, input.cid, input.projectionId);
  const projection = await confirmedProjection(userId, input.projectionId);
  const knowledge = await loadCommittedProjectionKnowledge(userId, input.projectionId);
  const resumed = await resumeOnce(
    userId,
    input.cid,
    projection.purpose,
    {
      type: 'kstar_projection_decision',
      projectionId: projection.id,
      decision: 'approved',
      confirmedSnapshot: {
        assetIds: knowledge.abilityAssetRefs,
        ruleRefs: knowledge.rules.map((rule) => rule.id),
      },
    },
    dependencies.enqueueControl || defaultEnqueueControl,
  );
  return { projection, resumed };
}

export async function retryProjectionInCommander(
  userId: string,
  input: { cid: string; projectionId: string },
  dependencies: ProjectionDecisionDependencies = {},
): Promise<ProjectionResumeResult> {
  assertRefs(userId, input.cid, input.projectionId);
  const projection = await readContextProjection(userId, input.projectionId);
  if (projection.status !== 'confirmed') {
    throw Object.assign(new Error('context projection is not confirmed'), { code: 'kstar_projection_not_confirmed' });
  }
  const knowledge = await loadCommittedProjectionKnowledge(userId, input.projectionId);
  const resumed = await resumeOnce(
    userId,
    input.cid,
    projection.purpose,
    {
      type: 'kstar_projection_decision',
      projectionId: projection.id,
      decision: 'approved',
      confirmedSnapshot: {
        assetIds: knowledge.abilityAssetRefs,
        ruleRefs: knowledge.rules.map((rule) => rule.id),
      },
    },
    dependencies.enqueueControl || defaultEnqueueControl,
  );
  return { projection, resumed };
}

export async function rejectProjectionAndResumeCommander(
  userId: string,
  input: { cid: string; projectionId: string; note?: string },
  dependencies: ProjectionDecisionDependencies = {},
): Promise<ProjectionResumeResult> {
  assertRefs(userId, input.cid, input.projectionId);
  const projection = await rejectContextProjection(userId, input.projectionId, input.note);
  const resumed = await resumeOnce(
    userId,
    input.cid,
    projection.purpose,
    {
      type: 'kstar_projection_decision',
      projectionId: projection.id,
      decision: 'rejected',
    },
    dependencies.enqueueControl || defaultEnqueueControl,
  );
  return { projection, resumed };
}

/**
 * Idempotent best-effort recovery of legacy `pending_projection_dispatch`
 * markers (schemaVersion 1 runtime state written by the removed pre-router).
 *
 * - `waiting_confirmation`: left unchanged for the user card;
 * - `forecasting` / `world_model_failed`: resumed into the same Commander
 *   session with the original text and confirmed Projection context;
 * - `ready_to_dispatch`: resumed with the legacy Forecast id and marker
 *   cleared; the Commander continues/synthesizes instead of a hidden replay;
 * - malformed/unknown markers are never executed.
 */
export async function recoverLegacyPendingProjectionDispatch(
  userId: string,
  cid: string,
  dependencies: ProjectionDecisionDependencies = {},
): Promise<LegacyRecoveryResult> {
  if (!safeId(userId) || !safeId(cid)) throw new Error('invalid legacy pending recovery reference');
  const state = await readState(userId, cid);
  const pending = state.pending_projection_dispatch;
  if (!pending) return 'none';
  if (pending.status === 'waiting_confirmation') return 'waiting_confirmation';
  if (
    pending.status !== 'forecasting'
    && pending.status !== 'world_model_failed'
    && pending.status !== 'ready_to_dispatch'
  ) {
    log.warn('kstar.projection-decision', {
      code: 'kstar_legacy_pending_status_unhandled',
      status: pending.status,
      cid: maskId(cid),
    });
    return 'none';
  }
  const resumed = await resumeOnce(
    userId,
    cid,
    pending.userMessageText,
    {
      type: 'kstar_projection_decision',
      projectionId: pending.projectionId,
      decision: 'approved',
      legacy: {
        requirementId: pending.requirementId,
        taskRunId: pending.taskRunId,
        ...(pending.forecastId ? { forecastId: pending.forecastId } : {}),
        originalText: pending.userMessageText,
      },
    },
    dependencies.enqueueControl || defaultEnqueueControl,
  );
  if (!resumed) return 'none';
  await clearPendingProjectionDispatch(userId, cid);
  return 'resumed';
}
