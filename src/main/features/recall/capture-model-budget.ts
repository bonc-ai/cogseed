/** Usage accounting and a persistent model-failure circuit; no workload quota. */
import { fileEditLock } from '../../util/locks';
import { recallJsonRecordPath } from './paths';
import { readRecallCaptureSettings } from './capture-settings';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

export type CaptureModelStage = 'summary' | 'value' | 'extraction' | 'grounding' | 'uncertainty' | 'automatic_support' | 'ontology_conflict';
export interface CaptureModelBudgetContext { jobId: string; stage: CaptureModelStage; source?: 'stock_organization' }
export const CAPTURE_MODEL_FAILURE_LIMIT = 3;
export type CaptureModelFailureReason = 'connection' | 'model_error' | 'empty_output';
interface FailureGuard {
  consecutiveFailures: number;
  held: boolean;
  reason?: CaptureModelFailureReason;
  jobId?: string;
  stage?: CaptureModelStage;
}
interface BudgetRecord extends RecallJsonRecord {
  failureGuard?: FailureGuard;
  stockCalls?: number;
  calls: number; inputChars: number; reportedTokens: number; unknownUsageCalls: number;
  stages: Partial<Record<CaptureModelStage, { calls: number; inputChars: number; reportedTokens: number }>>;
  updatedAt: string; billingStatus: 'unavailable';
}
export function captureBudgetWindowKey(now: Date, nightlyStart: string): string {
  const [hour, minute] = nightlyStart.split(':').map(Number);
  const start = new Date(now); start.setHours(hour, minute, 0, 0);
  if (now < start) start.setDate(start.getDate() - 1);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
}
function held(): never {
  throw Object.assign(new Error('capture paused after consecutive model failures; keep checkpoint for explicit retry or the next night'),
    { code: 'ABORT_ERR', reason: 'capture_model_failure_hold' });
}
function emptyRecord(userId: string, id: string): BudgetRecord {
  return { schemaVersion: 1, ownerId: userId, id, calls: 0, inputChars: 0, reportedTokens: 0,
    unknownUsageCalls: 0, stages: {}, updatedAt: new Date().toISOString(), billingStatus: 'unavailable' };
}
function assertFailureGuard(guard: FailureGuard | undefined): void {
  if (guard && (!Number.isSafeInteger(guard.consecutiveFailures) || guard.consecutiveFailures < 0
    || guard.held !== (guard.consecutiveFailures >= CAPTURE_MODEL_FAILURE_LIMIT))) throw new Error('capture failure guard unreadable');
}
function assertCounters(current: BudgetRecord): void {
  if (![current.calls, current.inputChars, current.reportedTokens, current.unknownUsageCalls].every(value => Number.isSafeInteger(value) && value >= 0)
    || (current.stockCalls !== undefined && (!Number.isSafeInteger(current.stockCalls) || current.stockCalls < 0 || current.stockCalls > current.calls))
    || !current.stages || typeof current.stages !== 'object' || Array.isArray(current.stages)
    || current.unknownUsageCalls > current.calls) throw new Error('capture model budget unreadable');
  const totals = { calls: 0, inputChars: 0, reportedTokens: 0 };
  for (const stage of Object.values(current.stages)) {
    if (!stage || ![stage.calls, stage.inputChars, stage.reportedTokens].every(value => Number.isSafeInteger(value) && value >= 0))
      throw new Error('capture stage budget unreadable');
    for (const key of ['calls', 'inputChars', 'reportedTokens'] as const) totals[key] += stage[key];
  }
  if (Object.entries(totals).some(([key, count]) => current[key] !== count)) throw new Error('capture model budget inconsistent');
  assertFailureGuard(current.failureGuard);
}

/** Admission reads only circuit state. The dispatch boundary owns usage-ledger
 * validation so existing stage diagnostics retain their failure handling. */
export async function isCaptureModelFailureHeld(userId: string): Promise<boolean> {
  const settings = await readRecallCaptureSettings(userId);
  const id = 'night-' + captureBudgetWindowKey(new Date(), settings.nightlyStart);
  const current = await readRecallJsonRecord(userId, 'capture-model-budgets', id) as BudgetRecord | undefined;
  assertFailureGuard(current?.failureGuard);
  return current?.failureGuard?.held === true;
}
/** Reserve before dispatch. A crash retains unknown usage rather than hiding it.
 * The optional dispatch callback meters provider retries and key rotation before
 * each request; callers without that hook retain logical-call accounting.
 * Accounting locks cover only the reserve/settle writes: holding them across the
 * model call serialized every capture stage on the slowest network request. */
export async function withCaptureModelBudget<T>(userId: string, context: CaptureModelBudgetContext,
  inputChars: number, run: (beforeDispatch?: () => Promise<void>) => Promise<T>, usage: (result: T) => { totalTokens?: number } | undefined = () => undefined,
  options: { dispatchMode?: 'logical' | 'physical' } = {}): Promise<T> {
  if (!Number.isSafeInteger(inputChars) || inputChars < 0) throw new Error('invalid capture input size');
  const accounting = <R>(work: () => Promise<R>): Promise<R> =>
    fileEditLock(recallJsonRecordPath(userId, 'capture-model-budgets', 'dispatch')).runExclusive(work);
  const reserve = () => accounting(async () => {
    const settings = await readRecallCaptureSettings(userId);
    const id = 'night-' + captureBudgetWindowKey(new Date(), settings.nightlyStart);
    const now = new Date().toISOString();
    await updateRecallJsonRecord(userId, 'capture-model-budgets', id, raw => {
      const row = raw as BudgetRecord | undefined;
      const current = row || emptyRecord(userId, id);
      // Keep old usage ledgers readable, including counts beyond former quotas.
      assertCounters(current);
      const stage = current.stages[context.stage] || { calls: 0, inputChars: 0, reportedTokens: 0 };
      if (![stage.calls, stage.inputChars, stage.reportedTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('capture stage budget unreadable');
      if (current.failureGuard?.held) held();
      return { ...current, ...(context.source === 'stock_organization' ? { stockCalls: (current.stockCalls || 0) + 1 } : {}), calls: current.calls + 1, inputChars: current.inputChars + inputChars,
        unknownUsageCalls: current.unknownUsageCalls + 1, updatedAt: now,
        stages: { ...current.stages, [context.stage]: { ...stage, calls: stage.calls + 1, inputChars: stage.inputChars + inputChars } } };
    });
    return id;
  });
  // The returned usage belongs to the last dispatched attempt, even when its
  // response arrives in another window or the configured start time changes.
  let reservationId = options.dispatchMode === 'physical' ? undefined : await reserve();
  let firstLogicalHook = true;
  const result = await run(async () => {
    if (options.dispatchMode !== 'physical' && firstLogicalHook) { firstLogicalHook = false; return; }
    reservationId = await reserve();
  });
  const tokens = usage(result)?.totalTokens;
  if (reservationId && Number.isSafeInteger(tokens) && Number(tokens) > 0) await accounting(async () => {
    await updateRecallJsonRecord(userId, 'capture-model-budgets', reservationId!, raw => {
      if (!raw) throw new Error('capture model reservation missing');
      const current = raw as BudgetRecord;
      assertCounters(current);
      const stage = current.stages[context.stage];
      if (!stage || current.unknownUsageCalls < 1) throw new Error('capture model reservation inconsistent');
      return { ...current, reportedTokens: current.reportedTokens + Number(tokens), unknownUsageCalls: current.unknownUsageCalls - 1,
        updatedAt: new Date().toISOString(), stages: { ...current.stages, [context.stage]: { ...stage, reportedTokens: stage.reportedTokens + Number(tokens) } } };
    });
  });
  return result;
}

/** Called once after the entire configured model route, not for each transport
 * retry or unavailable primary. A valid response is progress even if it proposes
 * no content change. Cancellation is excluded by the routing boundary. */
export async function recordCaptureModelOutcome(userId: string, context: CaptureModelBudgetContext, failure?: CaptureModelFailureReason): Promise<void> {
  const settings = await readRecallCaptureSettings(userId);
  const id = 'night-' + captureBudgetWindowKey(new Date(), settings.nightlyStart);
  const next = await updateRecallJsonRecord(userId, 'capture-model-budgets', id, raw => {
    const current = raw as BudgetRecord || emptyRecord(userId, id);
    assertCounters(current);
    // An in-flight success cannot reopen a circuit tripped by another task.
    if (current.failureGuard?.held) return current;
    const count = failure ? (current.failureGuard?.consecutiveFailures || 0) + 1 : 0;
    return { ...current, updatedAt: new Date().toISOString(), failureGuard: {
      consecutiveFailures: count, held: count >= CAPTURE_MODEL_FAILURE_LIMIT,
      ...(failure ? { reason: failure, jobId: context.jobId, stage: context.stage } : {}),
    } };
  }) as BudgetRecord;
  if (next.failureGuard?.held) held();
}

/** Explicit scan retry clears failure state, never usage or saved checkpoints. */
export async function resetCaptureModelFailureGuard(userId: string): Promise<void> {
  const settings = await readRecallCaptureSettings(userId);
  const id = 'night-' + captureBudgetWindowKey(new Date(), settings.nightlyStart);
  if (!(await readRecallJsonRecord(userId, 'capture-model-budgets', id))?.failureGuard) return;
  await updateRecallJsonRecord(userId, 'capture-model-budgets', id, raw => {
    const current = raw as BudgetRecord;
    assertCounters(current);
    return { ...current, failureGuard: { consecutiveFailures: 0, held: false }, updatedAt: new Date().toISOString() };
  });
}

export async function readCaptureModelBudget(userId: string) {
  const settings = await readRecallCaptureSettings(userId);
  const windowKey = captureBudgetWindowKey(new Date(), settings.nightlyStart);
  const record = await readRecallJsonRecord(userId, 'capture-model-budgets', 'night-' + windowKey) as BudgetRecord | undefined;
  if (record) assertCounters(record);
  return { windowKey, recorded: !!record, calls: record?.calls || 0, inputChars: record?.inputChars || 0,
    reportedTokens: record?.reportedTokens || 0, unknownUsageCalls: record?.unknownUsageCalls || 0,
    billingStatus: 'unavailable', stock: { calls: record?.stockCalls || 0 }, stages: record?.stages || {},
    failureGuard: { consecutiveFailures: 0, held: false, ...record?.failureGuard, limit: CAPTURE_MODEL_FAILURE_LIMIT } };
}
