/**
 * Workbench — the complex-delivery Workspace layer (US-20).
 *
 * Public surface for the IPC boundary. Four cooperating pieces:
 *   - `main-skill-baseline` — freezes the method version a run is judged
 *     against, and detects drift.
 *   - `task-run` — refuses to start work without a verified baseline, and
 *     bridges a project task to a real execution record.
 *   - `gate` — decides whether the Workspace is complete enough to display.
 *   - `action-plan` — read-only projection of tasks + runs.
 *
 * Nothing here owns dispatch. Execution state belongs to
 * `features/execution-records`; reuse evidence to
 * `features/p3394/context-reuse-receipt`; scheduling to the existing
 * group-chat path.
 */

export {
  freezeBaseline,
  readBaseline,
  verifyBaseline,
  listBaselines,
  baselinePath,
  type AssetRef,
  type BaselineSource,
  type MainSkillBaseline,
  type FreezeBaselineInput,
  type VerifyBaselineFailure,
  type VerifyBaselineResult,
} from './main-skill-baseline';

export {
  startTaskRun,
  readRunIds,
  readLatestRunId,
  listTaskRuns,
  decodeRunRefs,
  type TaskRunRole,
  type StartTaskRunInput,
  type StartTaskRunResult,
  type StartedTaskRun,
  type StartTaskRunRefusal,
} from './task-run';

export {
  evaluateWorkspaceGate,
  isWorkspaceViewable,
  type WorkspaceGateDecision,
  type WorkspaceGateReason,
  type WorkspaceGateStatus,
  type EvaluateWorkspaceGateInput,
} from './gate';

export {
  projectActionPlan,
  type ActionPlan,
  type ActionPlanStep,
  type ActionPlanStepState,
} from './action-plan';
