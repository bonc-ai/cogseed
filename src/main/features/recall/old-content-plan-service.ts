/** Persistent old-content plans and their asset-anchored execution. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withCognitionSourceDependency, withCognitionTransition } from '../cognition_bridge';
import { prepareCognitionAssetEdit } from '../cognition/edit-service';
import { writeReviewDecision } from '../cognition/review-decision';
import { readOntologyDocument } from '../cognition/ontology/service';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { createLogger } from '../../logger';
import { listAbilityAssets, readAbilityAsset, readAbilityAssetVersionSnapshot,
  reconcilePersonalProfileProjection } from './asset-service';
import { withAssetVersionMetadata, withPendingAssetVersion } from './asset-version-journal';
import { type RecallAbilityAssetRecord } from './candidate-service';
import { type FormationOldContentPlan, type OldContentReceipt } from './formation-old-content';
import { type OldContentAssetFingerprint, type OldContentExecution, type OldContentPlanOp, type OldContentPlanRecord,
  type OldContentPlanStatus, applyOldContentPlanOps, normalizeOldContentPlan, oldContentPlanSchema,
  oldContentUnresolvedItemId, planFromFormation } from './old-content-plan-contract';
import { oldContentCoverageProof, sameOldContentBoundary } from './old-content-coverage';
import { planOldContentUnits, type PlannedOldContent } from './old-content-plan-planner';
import { createRecallCollectionReader, readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import { notifyCognitionWrite } from './store-events';
import { recallJsonRecordPath } from './paths';
import type { RecallJsonRecord } from './types';

const COLLECTION = 'old-content-plans';
const log = createLogger('recall.old-content-plan');
const clean = (row: Record<string, unknown>) => {
  const { pendingVersionSnapshots: _pending, ...rest } = row;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function oldContentAssetFingerprint(asset: RecallAbilityAssetRecord): OldContentAssetFingerprint {
  return { version: asset.version, activeVersion: String(asset.activeVersion || asset.version),
    status: asset.status, digest: hash(clean(asset as unknown as Record<string, unknown>)) };
}
const fingerprint = oldContentAssetFingerprint;
/** Profile projections are derived state outside the atomic source commit.
 * A failed projection write is logged and retried by the asset's own repair
 * paths; it must never hide an already committed cleanup. */
async function reconcilePersonalProfiles(userId: string, assetIds: Iterable<string>): Promise<void> {
  for (const assetId of new Set(assetIds)) {
    try {
      const asset = await readAbilityAsset(userId, assetId);
      if (asset.type === 'personal') await reconcilePersonalProfileProjection(userId, asset);
    } catch (error) {
      log.warn('old-content profile projection degraded', { assetId,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    }
  }
}
async function writePlan(userId: string, plan: OldContentPlanRecord): Promise<OldContentPlanRecord> {
  const parsed = oldContentPlanSchema.parse(plan);
  await withCognitionTransition(userId, () => writeRecallJsonRecord(userId, COLLECTION, parsed.id, parsed as unknown as RecallJsonRecord));
  return parsed;
}
export async function saveOldContentPlan(userId: string, plan: OldContentPlanRecord): Promise<OldContentPlanRecord> {
  return writePlan(userId, plan);
}
/** Read-time candidate projection. It is not persisted; the plan document
 * remains the only editable source. */
export function oldContentPlanProjection(plan: OldContentPlanRecord): {
  oldContentPlan: FormationOldContentPlan;
  oldContentPlanState: OldContentPlanRecord['status'];
  oldContentPlanRevision: number;
  oldContentPlanRecord: OldContentPlanRecord;
  oldContentReceipt?: OldContentReceipt;
  oldContentFinalization?: OldContentPlanRecord['finalizations'][number];
} {
  const legacyStatus: FormationOldContentPlan['status'] = plan.status === 'needs_review' ? 'needs_review'
    : ['ready', 'executing', 'applied', 'undone'].includes(plan.status) ? 'ready' : 'unavailable';
  const latest = plan.executions[plan.executions.length - 1];
  const activeExecutions = plan.executions.filter(execution => !execution.undoneAt);
  const receipt: OldContentReceipt | undefined = latest ? {
    schemaVersion: 1, planDigest: plan.digest, decisionId: latest.decisionId, committedAt: latest.committedAt,
    // Units commit independently; the plan receipt aggregates every unit.
    items: activeExecutions.flatMap(execution => execution.items),
  } : undefined;
  return {
    oldContentPlan: {
      schemaVersion: 1, status: legacyStatus, assetIds: [...plan.assetIds],
      baselineVersions: { ...plan.baselineVersions },
      items: plan.items.map(item => ({
        itemId: item.itemId, action: item.state === 'excluded' ? 'keep' : item.action,
        reasonCode: item.reasonCode === 'keep_user_choice' ? 'keep_independent' : item.reasonCode,
        reason: item.state === 'excluded' ? '用户选择保留，不执行原整理动作。' : item.reason,
        assetIds: [...item.assetIds],
        ...(item.targetAssetId ? { targetAssetId: item.targetAssetId } : {}),
        expectedVersions: { ...item.expectedVersions },
        ...(item.merged ? { merged: { statement: item.merged.statement,
          ...(item.merged.applicableWhen ? { applicableWhen: item.merged.applicableWhen } : {}),
          ...(item.merged.forbiddenWhen ? { forbiddenWhen: item.merged.forbiddenWhen } : {}),
          evidenceAssetIds: [...item.merged.evidenceAssetIds] } } : {}),
      })),
      unresolved: plan.unresolved.map(item => ({ reasonCode: item.reasonCode, reason: item.reason,
        assetIds: [...item.assetIds], baselineVersions: { ...item.baselineVersions } })),
    },
    oldContentPlanState: plan.status,
    oldContentPlanRevision: plan.revision,
    oldContentPlanRecord: plan,
    ...(receipt ? { oldContentReceipt: receipt } : {}),
    ...(plan.finalizations.length ? { oldContentFinalization: plan.finalizations[plan.finalizations.length - 1] } : {}),
  };
}
export async function readOldContentPlan(userId: string, planId: string): Promise<OldContentPlanRecord> {
  const raw = await readRecallJsonRecord(userId, COLLECTION, planId);
  if (!raw) throw new Error('old-content plan not found');
  return normalizeOldContentPlan(oldContentPlanSchema.parse(raw));
}
export async function listOldContentPlans(userId: string): Promise<OldContentPlanRecord[]> {
  const reader = createRecallCollectionReader(userId, COLLECTION);
  let ids = reader.ids;
  if (!ids) {
    try {
      ids = (await fs.readdir(path.dirname(recallJsonRecordPath(userId, COLLECTION, 'snapshot'))))
        .filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  const rows: OldContentPlanRecord[] = [];
  for (const planId of ids) {
    try {
      const row = await reader.read(planId);
      if (row) rows.push(oldContentPlanSchema.parse(row as unknown as Record<string, unknown>));
    } catch { /* one malformed plan must not hide the rest */ }
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function listOldContentPlansForAssets(userId: string, assetIds: readonly string[]): Promise<OldContentPlanRecord[]> {
  const wanted = new Set(assetIds);
  return (await listOldContentPlans(userId)).filter(plan => plan.assetIds.some(id => wanted.has(id)));
}

export interface OldContentPlanSummary {
  id: string;
  status: OldContentPlanStatus;
  revision: number;
  assetIds: string[];
  assets: Array<{ id: string; title: string; version: string }>;
  candidateIds: string[];
  itemCount: number;
  unresolvedCount: number;
  pendingCount: number;
  executedCount: number;
  updatedAt: string;
  lastExecutionAt?: string;
}

const ACTIONABLE_PLAN_STATUSES: ReadonlySet<OldContentPlanStatus> =
  new Set(['ready', 'needs_review', 'blocked', 'applied']);

/** Actionable plans stay visible after their candidate is rejected: the plan
 * record is the source of truth, not the candidate that first proposed it. */
export async function listActionableOldContentPlans(userId: string): Promise<OldContentPlanSummary[]> {
  const [stored, assets] = await Promise.all([listOldContentPlans(userId), listAbilityAssets(userId)]);
  // A crash between the prepared checkpoint and the receipt leaves a plan in
  // `executing`; recover from its own fingerprints before deciding what the
  // list may hide, otherwise the plan and its candidate are stuck forever.
  const plans: OldContentPlanRecord[] = [];
  for (const plan of stored) {
    if (plan.status !== 'executing' || !plan.prepared) { plans.push(plan); continue; }
    try { plans.push(await reconcileOldContentExecution(userId, plan.id)); }
    catch (error) {
      log.warn('old-content execution recovery failed', { planId: plan.id,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      plans.push(plan);
    }
  }
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  return plans
    .filter(plan => !plan.contentPurgedAt && ACTIONABLE_PLAN_STATUSES.has(plan.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(plan => {
      const latest = plan.executions[plan.executions.length - 1];
      const executed = new Set(plan.executions.filter(execution => !execution.undoneAt)
        .flatMap(execution => execution.items.map(item => item.itemId)));
      return {
        id: plan.id,
        status: plan.status,
        revision: plan.revision,
        assetIds: [...plan.assetIds],
        assets: plan.assetIds.map(assetId => {
          const asset = byId.get(assetId);
          return { id: assetId, title: asset?.title || '',
            version: String(asset?.activeVersion || asset?.version || plan.baselineVersions[assetId] || '') };
        }),
        candidateIds: [...(plan.candidateIds || [])],
        itemCount: plan.items.length,
        unresolvedCount: plan.unresolved.filter(item => !item.resolution).length,
        pendingCount: plan.items.filter(item => item.state === 'included').length + plan.unresolved.length,
        executedCount: executed.size,
        updatedAt: plan.updatedAt,
        ...(latest ? { lastExecutionAt: latest.committedAt } : {}),
      };
    });
}
/** Bind one candidate to the deterministic plan for its asset group. Existing
 * plans are never overwritten; the candidate only gains a reference. */
export async function bindOldContentPlan(userId: string, candidateId: string,
  formationPlan: FormationOldContentPlan): Promise<OldContentPlanRecord> {
  return withCognitionTransition(userId, async () => {
    const next = planFromFormation(formationPlan, { ownerId: userId, candidateId });
    const existing = await readRecallJsonRecord(userId, COLLECTION, next.id);
    if (existing) {
      const current = oldContentPlanSchema.parse(existing);
      if (current.contentPurgedAt) throw new Error('old-content plan is purged');
      if (!current.candidateIds?.includes(candidateId))
        return writePlan(userId, { ...current, candidateIds: [...(current.candidateIds || []), candidateId],
          updatedAt: new Date().toISOString() });
      return current;
    }
    return writePlan(userId, next);
  });
}
export async function updateOldContentPlan(userId: string, planId: string,
  expectedRevision: number, ops: readonly OldContentPlanOp[]): Promise<OldContentPlanRecord> {
  return withCognitionTransition(userId, async () => {
    const plan = await readOldContentPlan(userId, planId);
    if (plan.revision !== expectedRevision) throw new Error('old-content plan changed; refresh before editing');
    return writePlan(userId, applyOldContentPlanOps(plan, ops));
  });
}
export async function dismissOldContentPlan(userId: string, planId: string, expectedRevision: number): Promise<OldContentPlanRecord> {
  return updateOldContentPlan(userId, planId, expectedRevision, [{ op: 'dismiss' }]);
}

/** User-chosen resolutions are host-validated: a merge is stored only when the
 * target provably contains every source and shares its boundary/conditions. */
export async function resolveOldContentUnresolved(userId: string, planId: string, expectedRevision: number,
  ops: readonly OldContentPlanOp[]): Promise<OldContentPlanRecord> {
  return withCognitionTransition(userId, async () => {
    const plan = await readOldContentPlan(userId, planId);
    if (plan.revision !== expectedRevision) throw new Error('old-content plan changed; refresh before editing');
    const resolutions = ops.filter((op): op is Extract<OldContentPlanOp, { op: 'resolve_unresolved' }> =>
      op.op === 'resolve_unresolved');
    if (!resolutions.length || resolutions.length !== ops.length)
      throw new Error('invalid old-content resolution ops');
    const byId = new Map((await listAbilityAssets(userId)).map(asset => [asset.id, asset]));
    for (const op of resolutions) {
      const unresolved = plan.unresolved.find(item => item.itemId === op.itemId);
      if (!unresolved) throw new Error('unknown old-content unresolved item');
      if (op.resolution === 'keep') continue;
      if (op.resolution.kind === 'archive' && unresolved.assetIds.length !== 1)
        throw new Error('archive resolution requires a single asset');
      const group = unresolved.assetIds.map(assetId => {
        const asset = byId.get(assetId);
        if (!asset) throw new Error('old-content unresolved asset missing');
        if (!['active', 'paused'].includes(asset.status)) throw new Error('old-content unresolved asset not editable');
        if (String(asset.activeVersion || asset.version) !== unresolved.baselineVersions[assetId])
          throw new Error('old-content unresolved baseline changed');
        return asset;
      });
      if (op.resolution.kind === 'merge') {
        const target = byId.get(op.resolution.targetAssetId);
        if (!target || !unresolved.assetIds.includes(target.id))
          throw new Error('merge target must belong to the unresolved group');
        const sources = group.filter(asset => asset.id !== target.id);
        if (!sources.length) throw new Error('merge requires a source asset');
        if (group.some(asset => !sameOldContentBoundary(target, asset)))
          throw new Error('old-content merge boundary mismatch');
        const proof = oldContentCoverageProof(target, sources);
        if (!proof.ok) throw new Error(proof.code === 'merge_body_not_contained'
          ? 'old-content merge body not contained' : 'old-content merge condition mismatch');
      }
    }
    return writePlan(userId, applyOldContentPlanOps(plan, ops));
  });
}

async function readPlanAsset(userId: string, assetId: string, expectedVersion: string) {
  const head = await prepareCognitionAssetEdit(userId, assetId);
  const active = String(head.activeVersion || head.version);
  if (active !== expectedVersion) throw new Error('old-content asset version changed');
  if (!['active', 'paused'].includes(head.status)) throw new Error('old-content asset is not editable');
  const snapshot = active === head.version ? head : await readAbilityAssetVersionSnapshot(userId, assetId, active);
  if (!snapshot) throw new Error('old-content active version unavailable');
  const content = { ...head, ...snapshot, version: head.version, activeVersion: active, status: head.status,
    scope: head.scope, scopePolicy: head.scopePolicy } as RecallAbilityAssetRecord;
  const rawHead = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!rawHead) throw new Error('old-content asset unavailable');
  return { head, content, rawHead };
}
export interface OldContentReference {
  id: string;
  title: string;
  kind: 'asset' | 'ontology';
  /** Asset relation kind when the reference came from `relations`. */
  relationKind?: string;
}
/** Who still points at this asset: other live assets and ontology records. */
export async function collectOldContentReferences(userId: string, assetId: string): Promise<OldContentReference[]> {
  const references: OldContentReference[] = [];
  for (const asset of await listAbilityAssets(userId)) {
    if (asset.id === assetId || !['active', 'paused'].includes(asset.status)) continue;
    const relation = asset.relations?.find(ref => ref.assetId === assetId);
    if (relation) references.push({ id: asset.id, title: asset.title, kind: 'asset',
      ...(relation.kind ? { relationKind: String(relation.kind) } : {}) });
    else if (asset.derivedFrom?.includes(assetId)) references.push({ id: asset.id, title: asset.title, kind: 'asset' });
  }
  const doc = readOntologyDocument(userId);
  for (const record of Object.values(doc.records)) {
    if (record.status !== 'active') continue;
    if (record.source?.refs?.some(ref => ref.kind === 'asset' && ref.id === assetId))
      references.push({ id: record.id, title: 'name' in record ? record.name : record.id, kind: 'ontology' });
  }
  return references;
}
async function assertUnreferencedForDelete(userId: string, assetId: string): Promise<void> {
  if ((await collectOldContentReferences(userId, assetId)).length)
    throw new Error('old-content delete target is referenced');
}
async function commitAssetChanges(userId: string, prepared: PlannedOldContent,
  rawHeads: Map<string, RecallJsonRecord>): Promise<void> {
  const anchorId = prepared.anchorId;
  if (!anchorId) return;
  const anchorAfter = prepared.changes.get(anchorId);
  if (!anchorAfter) throw new Error('old-content execution has no anchor');
  const anchorRaw = rawHeads.get(anchorId);
  await withAssetVersionMetadata({ actor: 'user', reason: '旧内容整理方案确认' }, () =>
    withCognitionSourceDependency(userId, 'ability-assets', (store) => {
      const records = store.compatibility!.records['ability-assets'];
      for (const [assetId, raw] of rawHeads) {
        if (!isDeepStrictEqual(clean(records[assetId] || {}), clean(raw))) throw new Error('old-content asset changed at commit');
      }
      for (const [assetId, after] of prepared.changes) {
        records[assetId] = withPendingAssetVersion(records[assetId] as RecallJsonRecord | undefined,
          after as unknown as RecallJsonRecord);
      }
      return { records: { 'ability-assets': [...prepared.changes.keys()] } };
    }, () => updateRecallJsonRecord(userId, 'ability-assets', anchorId, current => {
      if (!current || !isDeepStrictEqual(clean(current), clean(anchorRaw!))) throw new Error('old-content asset changed at commit');
      return anchorAfter as unknown as RecallJsonRecord;
    })));
}
function planUnitIds(plan: OldContentPlanRecord): string[] {
  return [...plan.items.map(item => item.itemId),
    ...plan.unresolved.map(item => item.itemId || oldContentUnresolvedItemId(item))];
}
function executedUnitIds(plan: OldContentPlanRecord): Set<string> {
  return new Set(plan.executions.filter(execution => !execution.undoneAt)
    .flatMap(execution => execution.items.map(item => item.itemId)));
}
function planStatusAfter(plan: OldContentPlanRecord): OldContentPlanStatus {
  const executed = executedUnitIds(plan);
  if (planUnitIds(plan).every(unitId => executed.has(unitId))) return 'applied';
  return plan.unresolved.some(item => !item.resolution) ? 'needs_review' : 'ready';
}
function executionErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error)
    return String((error as { code?: unknown }).code || 'old_content_execute_failed');
  return error instanceof Error ? error.message.slice(0, 160) : 'old_content_execute_failed';
}

export async function reconcileOldContentExecution(userId: string, planId: string): Promise<OldContentPlanRecord> {
  return withCognitionTransition(userId, async () => {
    const plan = await readOldContentPlan(userId, planId);
    if (plan.status !== 'executing' || !plan.prepared) return plan;
    const current: Record<string, ReturnType<typeof fingerprint>> = {};
    try {
      for (const assetId of plan.assetIds) current[assetId] = fingerprint(await readAbilityAsset(userId, assetId));
    } catch {
      return writePlan(userId, { ...plan, status: 'blocked', blockedReason: 'asset_missing_during_recovery' });
    }
    const allAfter = plan.assetIds.every(assetId =>
      isDeepStrictEqual(current[assetId], plan.prepared!.after[assetId]));
    const allBefore = plan.assetIds.every(assetId =>
      isDeepStrictEqual(current[assetId], plan.prepared!.before[assetId]));
    if (allAfter) {
      const prepared = plan.prepared;
      const execution: OldContentExecution = { executionId: prepared.executionId, digest: prepared.digest,
        decisionId: prepared.decisionId, candidateId: prepared.candidateId, revision: plan.revision,
        committedAt: new Date().toISOString(), items: prepared.receiptItems };
      const executions = [...plan.executions, execution];
      const saved = await writePlan(userId, { ...plan, status: planStatusAfter({ ...plan, executions }),
        prepared: undefined, blockedReason: undefined, executions, updatedAt: new Date().toISOString() });
      // The commit landed before the crash; projection repair still belongs to
      // the same recovered execution.
      await reconcilePersonalProfiles(userId, Object.keys(prepared.after));
      return saved;
    }
    if (allBefore) return writePlan(userId, { ...plan, status: planStatusAfter(plan), prepared: undefined,
      blockedReason: undefined, updatedAt: new Date().toISOString() });
    return writePlan(userId, { ...plan, status: 'blocked', blockedReason: 'mixed_execution_state' });
  });
}

export interface OldContentUnitResult {
  unitId: string;
  status: 'applied' | 'kept' | 'failed' | 'already_applied';
  code?: string;
}
export interface OldContentExecuteResult {
  plan: OldContentPlanRecord;
  execution?: OldContentExecution;
  executions: OldContentExecution[];
  results: OldContentUnitResult[];
  duplicate?: true;
}

/** Selected units are independent: each commits atomically and reports its own
 * failure, so one bad unit never suppresses the others. */
export async function executeOldContentPlan(userId: string, planId: string, input: {
  expectedRevision?: number; candidateId?: string; itemIds?: readonly string[];
} = {}): Promise<OldContentExecuteResult> {
  return withCognitionTransition(userId, async () => {
    await reconcileOldContentExecution(userId, planId);
    let plan = await readOldContentPlan(userId, planId);
    if (plan.executions.some(execution => execution.snapshot && execution.audit?.state !== 'complete')) {
      try {
        const { reconcileOldContentAudit } = await import('./old-content-audit');
        plan = await reconcileOldContentAudit(userId, planId);
      } catch {
        // Audit replay never blocks execution; it retries on the next read.
      }
    }
    if (['dismissed', 'purged', 'superseded', 'undone'].includes(plan.status))
      throw new Error(`old-content plan is not executable: ${plan.status}`);
    if (input.expectedRevision !== undefined && plan.revision !== input.expectedRevision)
      throw new Error('old-content plan changed; refresh before executing');
    if (plan.status === 'applied' && plan.executions.length && !input.itemIds) {
      const execution = plan.executions[plan.executions.length - 1];
      return { plan, execution, executions: plan.executions, results: [], duplicate: true as const };
    }
    const assets = await listAbilityAssets(userId);
    const planned = planOldContentUnits(plan, assets, input.itemIds);
    if (planned.blockers.length && !planned.units.length)
      throw new Error(`old-content plan blocked: ${planned.blockers.join(',')}`);
    const already = executedUnitIds(plan);
    const results: OldContentUnitResult[] = [];
    let lastExecution: OldContentExecution | undefined;
    for (const unit of planned.units) {
      if (already.has(unit.unitId)) {
        results.push({ unitId: unit.unitId, status: 'already_applied' });
        continue;
      }
      if (unit.blockers.length) {
        results.push({ unitId: unit.unitId, status: 'failed', code: unit.blockers[0] });
        continue;
      }
      try {
        for (const receipt of unit.receiptItems) {
          if (receipt.action !== 'delete') continue;
          for (const assetId of receipt.assetIds) await assertUnreferencedForDelete(userId, assetId);
        }
        const decision = await writeReviewDecision(userId, {
          targetRef: `old_content_plan:${plan.id}`, decisionType: 'modify', decision: 'apply_old_content_plan',
          actor: 'user', reason: '用户确认旧内容整理方案。',
          idempotencyKey: `old-content-${plan.id}-${unit.executionId}`,
        });
        const now = new Date().toISOString();
        let before: Record<string, OldContentAssetFingerprint> | undefined;
        let after: Record<string, OldContentAssetFingerprint> | undefined;
        if (unit.changes.size) {
          const plannedAssets = [];
          const rawHeads = new Map<string, RecallJsonRecord>();
          for (const assetId of [...new Set(unit.receiptItems.flatMap(item => item.assetIds))]) {
            const expected = plan.baselineVersions[assetId];
            if (!expected) throw new Error(`old-content baseline is incomplete: ${assetId}`);
            const row = await readPlanAsset(userId, assetId, expected);
            plannedAssets.push(row);
            rawHeads.set(row.content.id, row.rawHead as unknown as RecallJsonRecord);
          }
          before = Object.fromEntries(plannedAssets.map(row => [row.content.id, fingerprint(row.content)]));
          after = Object.fromEntries(plannedAssets.map(row => [row.content.id,
            unit.changes.get(row.content.id) ? fingerprint(unit.changes.get(row.content.id)!) : before![row.content.id]]));
          const preparedRecord = { executionId: unit.executionId, digest: unit.digest, decisionId: decision.decision_id,
            ...(input.candidateId ? { candidateId: input.candidateId } : {}), before, after,
            receiptItems: unit.receiptItems, ...(unit.anchorId ? { anchorId: unit.anchorId } : {}), preparedAt: now };
          plan = await writePlan(userId, { ...plan, status: 'executing', prepared: preparedRecord, updatedAt: now });
          try {
            await commitAssetChanges(userId, unit, rawHeads);
          } catch (error) {
            plan = await writePlan(userId, { ...plan, status: planStatusAfter(plan), prepared: undefined,
              updatedAt: new Date().toISOString() });
            results.push({ unitId: unit.unitId, status: 'failed', code: executionErrorCode(error) });
            continue;
          }
        }
        let referencedBy: Record<string, string[]> | undefined;
        if (before && after) {
          referencedBy = {};
          for (const assetId of Object.keys(after))
            referencedBy[assetId] = (await collectOldContentReferences(userId, assetId))
              .map(reference => `${reference.kind}:${reference.id}`).sort();
        }
        const execution: OldContentExecution = { executionId: unit.executionId, digest: unit.digest,
          decisionId: decision.decision_id, ...(input.candidateId ? { candidateId: input.candidateId } : {}),
          revision: plan.revision, committedAt: new Date().toISOString(), items: unit.receiptItems,
          ...(before && after && referencedBy ? { snapshot: { before, after, referencedBy } } : {}) };
        try {
          const { applyOldContentExecutionAudit } = await import('./old-content-audit');
          execution.audit = await applyOldContentExecutionAudit(userId, plan.id, execution);
        } catch {
          execution.audit = { state: 'pending', attempts: 1 };
        }
        const executions = [...plan.executions, execution];
        plan = await writePlan(userId, { ...plan, status: planStatusAfter({ ...plan, executions }),
          prepared: undefined, blockedReason: undefined, executions, updatedAt: execution.committedAt });
        lastExecution = execution;
        for (const assetId of unit.changes.keys()) notifyCognitionWrite(userId, 'ability-assets', 'update', assetId);
        await reconcilePersonalProfiles(userId, unit.changes.keys());
        results.push({ unitId: unit.unitId,
          status: unit.receiptItems.every(item => item.status === 'kept') ? 'kept' : 'applied' });
      } catch (error) {
        results.push({ unitId: unit.unitId, status: 'failed', code: executionErrorCode(error) });
      }
    }
    const execution = lastExecution || plan.executions[plan.executions.length - 1];
    const allAlready = results.length > 0 && results.every(result => result.status === 'already_applied');
    return { plan, executions: plan.executions, results,
      ...(execution ? { execution } : {}), ...(allAlready ? { duplicate: true as const } : {}) };
  });
}
export async function recordOldContentFinalization(userId: string, planId: string, candidateId: string,
  phase: 'idle' | 'old_committed' | 'new_saved' | 'old_failed' | 'new_failed' | 'abandoned',
  extra: { executionId?: string; newDecisionId?: string; errorCode?: string } = {}): Promise<OldContentPlanRecord> {
  const plan = await readOldContentPlan(userId, planId);
  const now = new Date().toISOString();
  const next = plan.finalizations.filter(row => row.candidateId !== candidateId);
  return writePlan(userId, { ...plan, updatedAt: now, finalizations: [...next, { candidateId, phase, updatedAt: now,
    ...(extra.executionId ? { executionId: extra.executionId } : {}),
    ...(extra.newDecisionId ? { newDecisionId: extra.newDecisionId } : {}),
    ...(extra.errorCode ? { errorCode: extra.errorCode } : {}) }] });
}

export async function addOldContentPlanCandidate(userId: string, planId: string, candidateId: string): Promise<void> {
  const plan = await readOldContentPlan(userId, planId);
  if (plan.candidateIds?.includes(candidateId)) return;
  await writePlan(userId, { ...plan, candidateIds: [...(plan.candidateIds || []), candidateId], updatedAt: new Date().toISOString() });
}
export function oldContentPlanExecutionDigest(plan: OldContentPlanRecord): string {
  return plan.digest;
}
