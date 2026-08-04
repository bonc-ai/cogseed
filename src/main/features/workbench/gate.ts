/**
 * Workspace Gate — readiness judgement for a complex-delivery Workspace.
 *
 * NOT the P3394 Wake Gate. `p3394/wake-service` gates whether an agent may be
 * WOKEN for a turn: it is per-invocation, authorization-shaped, and expires
 * (`approval` / `behavior_scope` / `context_scope` / `expires_at`). This gate
 * answers a different question — has this Workspace been BUILT to the point
 * where showing it is honest? That is a state of engineering completeness, not
 * a grant of permission, and it does not expire. The two are intentionally
 * separate: merging them would overload "approval" to mean both "the user
 * consented" and "the thing is finished", and would put Workspace logic on the
 * agent-wake path that feeds group-chat dispatch.
 *
 * Per T2-S3-02 ("未达Gate不得展示空Workspace") and RG-S3-03 ("不是空壳"), the
 * renderer must not paint the Workspace body unless `status === 'ready'`.
 *
 * Four conditions, all required:
 *   1. a Main Skill baseline is frozen and still matches its skill tree
 *   2. the governing Context Reuse Receipt is `completed`
 *   3. that receipt's boundary is `real` — `degraded` / `test-double` must not
 *      pass, mirroring the Sprint rule that a usable component is not a
 *      shipped integration and that mock boundaries stay declared
 *   4. the main skill's latest validation is not `blocked`
 *
 * This module is a PURE judgement: it reads state and returns a decision. It
 * writes nothing, mutates nothing, and never repairs what it finds — a blocked
 * Workspace is a fact to report, not a condition to auto-fix.
 */

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { maskId } from '../../util/log-redact';
import { readReceipt, type ContextReuseReceipt } from '../p3394/context-reuse-receipt';
import { findLatestSkillValidation } from '../p3394/skill-validation-run';
import { verifyBaseline, readBaseline } from './main-skill-baseline';

const log = createLogger('workspace-gate');

/**
 * Why a Workspace is not ready. Stable machine-readable codes: the renderer
 * maps these to localized copy, so the strings themselves are never displayed.
 */
export type WorkspaceGateReason =
  | 'baseline_missing'
  | 'baseline_drift'
  | 'baseline_unreadable'
  | 'receipt_missing'
  | 'receipt_not_completed'
  | 'receipt_not_real'
  | 'validation_blocked';

export type WorkspaceGateStatus = 'ready' | 'blocked';

export interface WorkspaceGateDecision {
  status: WorkspaceGateStatus;
  /** Every unmet condition, not just the first — the UI shows a full gap list. */
  reasons: WorkspaceGateReason[];
  baselineId?: string;
  receiptExecutionId?: string;
  validationId?: string;
  evaluatedAt: string;
}

export interface EvaluateWorkspaceGateInput {
  /** Frozen baseline governing the Workspace's main skill. */
  baselineId: string;
  /** Skill tree the baseline pinned; re-hashed to detect drift. */
  skillDir: string;
  allowedRoots: readonly string[];
  /** Execution whose Context Reuse Receipt proves the capability was reused. */
  receiptExecutionId: string;
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid ${field}`);
  return value;
}

/**
 * Evaluate all four conditions and report every gap.
 *
 * Conditions are checked independently rather than short-circuiting: a user
 * fixing one blocker should not have to re-run the gate to discover the next
 * one. The only ordering dependency is that a missing baseline makes its own
 * drift check meaningless, so those reasons are mutually exclusive by
 * construction.
 */
export async function evaluateWorkspaceGate(
  userId: string,
  input: EvaluateWorkspaceGateInput,
): Promise<WorkspaceGateDecision> {
  const baselineId = requireId(input.baselineId, 'baseline id');
  const receiptExecutionId = requireId(input.receiptExecutionId, 'receipt execution id');
  const reasons: WorkspaceGateReason[] = [];

  // ── 1 + 2: baseline frozen, and still matching its skill tree ──────────
  const verified = await verifyBaseline(userId, baselineId, input.skillDir, input.allowedRoots);
  if (verified.ok !== true) {
    reasons.push(
      verified.reason === 'not_found' ? 'baseline_missing'
        : verified.reason === 'drift' ? 'baseline_drift'
          : 'baseline_unreadable',
    );
  }

  // ── 3: receipt completed, and produced by a real run ───────────────────
  let receipt: ContextReuseReceipt | null = null;
  try {
    receipt = await readReceipt(userId, receiptExecutionId);
  } catch (err) {
    if ((err as Error).message === 'context reuse receipt not found') {
      reasons.push('receipt_missing');
    } else {
      throw err;
    }
  }
  if (receipt) {
    if (receipt.status !== 'completed') reasons.push('receipt_not_completed');
    // A `degraded` or `test-double` boundary means the evidence came from a
    // fallback or a stand-in. Neither may open the Workspace.
    if (receipt.boundary !== 'real') reasons.push('receipt_not_real');
  }

  // ── 4: main skill not blocked by validation ────────────────────────────
  // The skill identity comes from the baseline's asset ref rather than the
  // caller, so the gate cannot be pointed at a different skill than the one
  // the baseline froze.
  let validationId: string | undefined;
  if (verified.ok === true) {
    const baseline = await readBaseline(userId, baselineId);
    const validation = await findLatestSkillValidation(userId, baseline.skill_ref.asset_id);
    if (validation) {
      validationId = validation.validationId;
      if (validation.status === 'blocked') reasons.push('validation_blocked');
    }
    // No validation on record is NOT a blocker here: scanning is a separate
    // enabler track, and its absence is covered by its own gate. Only an
    // explicit `blocked` verdict stops the Workspace.
  }

  const decision: WorkspaceGateDecision = {
    status: reasons.length ? 'blocked' : 'ready',
    reasons,
    baselineId,
    receiptExecutionId,
    ...(validationId ? { validationId } : {}),
    evaluatedAt: new Date().toISOString(),
  };

  if (decision.status === 'blocked') {
    log.info('workspace gate blocked', {
      user_id: maskId(userId),
      baseline_id: maskId(baselineId),
      receipt_execution_id: maskId(receiptExecutionId),
      reasons: decision.reasons,
    });
  }
  return decision;
}

/**
 * Single predicate the renderer must consult before painting the Workspace
 * body. Kept separate from the decision so no call site has to re-derive
 * "ready" from the reasons array.
 */
export function isWorkspaceViewable(decision: WorkspaceGateDecision): boolean {
  return decision.status === 'ready' && decision.reasons.length === 0;
}
