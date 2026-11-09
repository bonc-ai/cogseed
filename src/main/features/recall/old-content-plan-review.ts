/** Read-only review projection for an old-content plan. It never writes and
 * never persists excerpts; the renderer shows them inside expandable blocks. */
import { listAbilityAssets, readAbilityAssetVersionSnapshot } from './asset-service';
import { collectOldContentReferences, readOldContentPlan, reconcileOldContentExecution,
  type OldContentReference } from './old-content-plan-service';
import { planOldContentUnits } from './old-content-plan-planner';
import type { OldContentExecutionItem, OldContentPlanRecord, OldContentPlanStatus } from './old-content-plan-contract';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { assetVersionSnapshot } from './asset-version-journal';
import { diffAssetSnapshots, type AssetFieldChange } from './formal-assets/version-diff';
import { readReviewEvidence } from './review-evidence';
import { createLogger } from '../../logger';

const log = createLogger('recall.old-content-plan-review');

export interface OldContentReviewExcerpt {
  state: string;
  title?: string;
  excerpt?: string;
}
export interface OldContentReviewAsset {
  id: string;
  title: string;
  version: string;
  status: string;
  before?: { statement: string; applicableWhen?: string[]; forbiddenWhen?: string[] };
  after?: { statement: string; applicableWhen?: string[]; forbiddenWhen?: string[]; status?: string };
  changes: AssetFieldChange[];
  excerpts: OldContentReviewExcerpt[];
  deleteImpact?: OldContentReference[];
}
export interface OldContentReviewUnit {
  unitId: string;
  kind: 'item' | 'unresolved';
  action: 'merge' | 'keep' | 'archive' | 'delete';
  reason: string;
  targetAssetId?: string;
  targetVersion?: string;
  assets: OldContentReviewAsset[];
  blockers: string[];
  receipt?: OldContentExecutionItem;
}
export interface OldContentPlanReview {
  planId: string;
  revision: number;
  status: OldContentPlanStatus;
  generatedAt: string;
  units: OldContentReviewUnit[];
}

const pickContent = (asset: Partial<RecallAbilityAssetRecord>) => ({
  statement: String(asset.statement || ''),
  ...(asset.applicableWhen?.length ? { applicableWhen: [...asset.applicableWhen] } : {}),
  ...(asset.forbiddenWhen?.length ? { forbiddenWhen: [...asset.forbiddenWhen] } : {}),
  ...(asset.status ? { status: String(asset.status) } : {}),
});
const diffSnapshot = (previous: Partial<RecallAbilityAssetRecord>, next: Partial<RecallAbilityAssetRecord>) =>
  diffAssetSnapshots(assetVersionSnapshot(previous as Record<string, unknown>) as never,
    assetVersionSnapshot(next as Record<string, unknown>) as never);

function unitMeta(plan: OldContentPlanRecord, unitId: string): {
  action: OldContentReviewUnit['action'];
  reason: string;
  assetIds: string[];
  targetAssetId?: string;
} {
  const item = plan.items.find(row => row.itemId === unitId);
  if (item) {
    const action = item.state === 'excluded' ? 'keep' : item.action;
    return { action, reason: item.reason, assetIds: [...item.assetIds],
      ...(item.targetAssetId ? { targetAssetId: item.targetAssetId } : {}) };
  }
  const unresolved = plan.unresolved.find(row => row.itemId === unitId);
  if (!unresolved) return { action: 'keep', reason: '', assetIds: [] };
  const resolution = unresolved.resolution;
  const action = resolution === 'keep' ? 'keep' : resolution?.kind === 'archive' ? 'archive'
    : resolution?.kind === 'merge' ? 'merge' : 'keep';
  return { action, reason: unresolved.reason, assetIds: [...unresolved.assetIds],
    ...(resolution && resolution !== 'keep' && resolution.kind === 'merge'
      ? { targetAssetId: resolution.targetAssetId } : {}) };
}

export async function buildOldContentPlanReview(userId: string, planId: string): Promise<OldContentPlanReview> {
  let plan = await readOldContentPlan(userId, planId);
  if (plan.status === 'executing' && plan.prepared) {
    plan = await reconcileOldContentExecution(userId, planId).catch(error => {
      log.warn('old-content execution recovery failed', { planId,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      return plan;
    });
  }
  try {
    const { reconcileOldContentAudit } = await import('./old-content-audit');
    plan = await reconcileOldContentAudit(userId, planId);
  } catch {
    // Audit replay must never block reading the review.
  }
  const assets = await listAbilityAssets(userId);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const planned = planOldContentUnits(plan, assets);
  const receipts = new Map(plan.executions.flatMap(execution => execution.items)
    .map(item => [item.itemId, item]));
  const units: OldContentReviewUnit[] = [];
  for (const unit of planned.units) {
    const meta = unitMeta(plan, unit.unitId);
    const receipt = receipts.get(unit.unitId);
    const reviewAssets: OldContentReviewAsset[] = [];
    for (const assetId of [...new Set(meta.assetIds)]) {
      const head = byId.get(assetId);
      if (!head) {
        reviewAssets.push({ id: assetId, title: '', version: plan.baselineVersions[assetId] || '',
          status: 'missing', changes: [], excerpts: [] });
        continue;
      }
      const baseline = plan.baselineVersions[assetId] || String(head.activeVersion || head.version);
      const snapshot = await readAbilityAssetVersionSnapshot(userId, assetId, baseline).catch(() => null);
      const before = (snapshot || head) as RecallAbilityAssetRecord;
      const after = unit.changes.get(assetId);
      let excerpts: OldContentReviewExcerpt[] = [];
      try {
        excerpts = (await readReviewEvidence(userId, { assetId })).slice(0, 3).map(row => ({
          state: row.state,
          ...(row.title ? { title: row.title } : {}),
          ...(row.excerpt ? { excerpt: row.excerpt.slice(0, 600) } : {}),
        }));
      } catch {
        excerpts = [{ state: 'read_failed' }];
      }
      reviewAssets.push({
        id: assetId, title: head.title, version: baseline, status: head.status,
        before: pickContent(before),
        ...(after ? { after: pickContent(after) } : {}),
        changes: after ? diffSnapshot(before, after) : [],
        excerpts,
        ...(meta.action === 'delete' ? { deleteImpact: await collectOldContentReferences(userId, assetId) } : {}),
      });
    }
    const targetAfter = meta.targetAssetId ? unit.changes.get(meta.targetAssetId) : undefined;
    const targetVersion = receipt?.targetVersion || (targetAfter ? String(targetAfter.version) : '');
    units.push({
      unitId: unit.unitId, kind: unit.kind, action: meta.action, reason: meta.reason,
      ...(meta.targetAssetId ? { targetAssetId: meta.targetAssetId } : {}),
      ...(targetVersion ? { targetVersion } : {}),
      assets: reviewAssets, blockers: [...unit.blockers],
      ...(receipt ? { receipt } : {}),
    });
  }
  return { planId: plan.id, revision: plan.revision, status: plan.status,
    generatedAt: new Date().toISOString(), units };
}
