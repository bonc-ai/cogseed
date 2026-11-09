/** Host-validated old-content recommendations attached to a formation result.
 * The model may propose only merge/keep/archive/delete. Conflict, insufficient
 * evidence and stale baselines are system states, never model actions. */
import { z } from 'zod';
import type { CaptureExistingAsset } from './capture-existing-assets';
import { RECALL_TEXT_LIMITS } from './content-contract';

const text = (limit: number) => z.string().trim().min(1).max(limit);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const mergedBody = z.object({
  statement: text(RECALL_TEXT_LIMITS.statement),
  applicableWhen: z.array(text(500)).max(32).optional(),
  forbiddenWhen: z.array(text(500)).max(32).optional(),
  /** Quotes prove coverage at validation time and are removed before persistence. */
  excerpts: z.array(z.object({ assetId: id, quote: text(RECALL_TEXT_LIMITS.statement) }).strict()).min(1).max(60),
}).strict();
const modelItem = z.object({
  action: z.enum(['merge', 'keep', 'archive', 'delete']),
  reasonCode: z.enum([
    'merge_coverage', 'merge_complementary',
    'keep_incompatible', 'keep_independent',
    'archive_obsolete', 'archive_duplicate', 'archive_referenced',
    'delete_unsuitable',
  ]),
  reason: text(2_000),
  assetIds: z.array(id).min(1).max(6),
  targetAssetId: id.optional(),
  merged: mergedBody.optional(),
}).strict();
const unresolvedItem = z.object({
  reasonCode: z.enum(['needs_user_arbitration', 'evidence_insufficient']),
  reason: text(2_000),
  assetIds: z.array(id).min(1).max(6),
}).strict();
export const formationOldContentModelSchema = z.object({
  items: z.array(modelItem).max(12),
  unresolved: z.array(unresolvedItem).max(12).optional(),
}).strict().refine(value => value.items.length > 0 || Boolean(value.unresolved?.length),
  'old-content plan requires an item or an unresolved reason');

export type FormationOldContentAction = 'merge' | 'keep' | 'archive' | 'delete';
export type FormationOldContentReasonCode = z.infer<typeof modelItem>['reasonCode'];
export type FormationOldContentUnresolvedReason = 'needs_user_arbitration' | 'evidence_insufficient';
export type FormationOldContentPlanStatus = 'ready' | 'needs_review' | 'insufficient' | 'unavailable';

export interface FormationOldContentPlanItem {
  itemId: string;
  action: FormationOldContentAction;
  reasonCode: FormationOldContentReasonCode;
  reason: string;
  assetIds: string[];
  targetAssetId?: string;
  expectedVersions: Record<string, string>;
  merged?: {
    statement: string;
    applicableWhen?: string[];
    forbiddenWhen?: string[];
    /** Source identities proved during validation; raw quotes are not persisted. */
    evidenceAssetIds: string[];
  };
}
export interface FormationOldContentUnresolvedItem {
  reasonCode: FormationOldContentUnresolvedReason;
  reason: string;
  assetIds: string[];
  baselineVersions: Record<string, string>;
}
export interface FormationOldContentPlan {
  schemaVersion: 1;
  status: FormationOldContentPlanStatus;
  assetIds: string[];
  baselineVersions: Record<string, string>;
  items: FormationOldContentPlanItem[];
  unresolved: FormationOldContentUnresolvedItem[];
}
export interface OldContentReceipt {
  schemaVersion: 1;
  planDigest: string;
  decisionId: string;
  committedAt: string;
  items: Array<{
    itemId: string;
    action: FormationOldContentAction;
    status: 'applied' | 'kept';
    assetIds: string[];
    targetAssetId?: string;
    targetVersion?: string;
    archivedIds?: string[];
    deletedIds?: string[];
  }>;
}

const ACTION_REASONS: Record<FormationOldContentAction, ReadonlySet<FormationOldContentReasonCode>> = {
  merge: new Set(['merge_coverage', 'merge_complementary']),
  keep: new Set(['keep_incompatible', 'keep_independent']),
  archive: new Set(['archive_obsolete', 'archive_duplicate', 'archive_referenced']),
  delete: new Set(['delete_unsuitable']),
};
const storedMergedSchema = z.object({
  statement: text(RECALL_TEXT_LIMITS.statement),
  applicableWhen: z.array(text(500)).max(32).optional(),
  forbiddenWhen: z.array(text(500)).max(32).optional(),
  evidenceAssetIds: z.array(id).min(1).max(6),
}).strict();
const storedItemSchema = z.object({
  itemId: id,
  action: z.enum(['merge', 'keep', 'archive', 'delete']),
  reasonCode: z.enum([
    'merge_coverage', 'merge_complementary',
    'keep_incompatible', 'keep_independent',
    'archive_obsolete', 'archive_duplicate', 'archive_referenced',
    'delete_unsuitable',
  ]),
  reason: text(2_000),
  assetIds: z.array(id).min(1).max(6),
  targetAssetId: id.optional(),
  expectedVersions: z.record(id, z.string().regex(/^\d{1,9}$/)),
  merged: storedMergedSchema.optional(),
}).strict();
export const formationOldContentPlanSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['ready', 'needs_review', 'insufficient', 'unavailable']),
  assetIds: z.array(id).min(1).max(6),
  baselineVersions: z.record(id, z.string().regex(/^\d{1,9}$/)),
  items: z.array(storedItemSchema).max(12),
  unresolved: z.array(z.object({
    reasonCode: z.enum(['needs_user_arbitration', 'evidence_insufficient']),
    reason: text(2_000),
    assetIds: z.array(id).min(1).max(6),
    baselineVersions: z.record(id, z.string().regex(/^\d{1,9}$/)),
  }).strict()).max(12),
}).strict() as z.ZodType<FormationOldContentPlan>;
export const oldContentReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decisionId: z.string().regex(/^rd_[A-Za-z0-9_-]{8,64}$/),
  committedAt: z.string().datetime({ offset: true }),
  items: z.array(z.object({
    itemId: id,
    action: z.enum(['merge', 'keep', 'archive', 'delete']),
    status: z.enum(['applied', 'kept']),
    assetIds: z.array(id).min(1).max(6),
    targetAssetId: id.optional(),
    targetVersion: z.string().regex(/^\d{1,9}$/).optional(),
    archivedIds: z.array(id).max(6).optional(),
    deletedIds: z.array(id).max(6).optional(),
  }).strict()).min(1).max(12),
}).strict() as z.ZodType<OldContentReceipt>;

function uniqueIds(value: readonly string[]): string[] {
  return [...new Set(value)];
}

function versionsFor(ids: readonly string[], assets: readonly CaptureExistingAsset[]): Record<string, string> {
  return Object.fromEntries(ids.map(assetId => {
    const asset = assets.find(row => row.id === assetId);
    if (!asset) throw new Error('old-content asset unavailable');
    return [assetId, asset.version];
  }));
}

/** A host-owned representation for groups the model could not assess. It never
 * contains an executable item, so incomplete evidence cannot turn into a write. */
export function unavailableFormationOldContentPlan(
  relatedAssetIds: readonly string[],
  assets: readonly CaptureExistingAsset[],
  status: 'insufficient' | 'unavailable',
): FormationOldContentPlan {
  const assetIds = uniqueIds(relatedAssetIds);
  if (assetIds.length < 2 || assetIds.length > 6) throw new Error('old-content group outside review bounds');
  const baselineVersions = versionsFor(assetIds, assets);
  // Every group asset must stay claimed, even when no action is available;
  // otherwise binding the plan would reject the whole new-content candidate.
  const unresolved: FormationOldContentUnresolvedItem[] = [{
    reasonCode: 'evidence_insufficient',
    reason: status === 'insufficient'
      ? '旧内容未完整读取，本次不提供可执行整理动作。'
      : '本次没有形成可执行的旧内容整理方案，暂不处理这些旧内容。',
    assetIds, baselineVersions,
  }];
  return { schemaVersion: 1, status, assetIds, baselineVersions, items: [], unresolved };
}

/** Validate a model recommendation against the exact readable asset snapshot.
 * Host fields (versions, item ids, evidence ids) are derived here; the model
 * never copies a version and raw excerpts are not returned for persistence. */
export function validateFormationOldContentPlan(
  raw: unknown,
  input: { relatedAssets: ReadonlyArray<{ assetId: string; version: string }>; assets: readonly CaptureExistingAsset[] },
): FormationOldContentPlan {
  const relatedAssetIds = uniqueIds(input.relatedAssets.map(row => row.assetId));
  if (relatedAssetIds.length < 2 || relatedAssetIds.length > 6)
    throw new Error('old-content group outside review bounds');
  if (relatedAssetIds.some(assetId => {
    const row = input.relatedAssets.find(item => item.assetId === assetId);
    return !row || !input.assets.some(asset => asset.id === assetId && asset.version === row.version);
  })) throw new Error('old-content baseline unavailable');
  const parsed = formationOldContentModelSchema.parse(raw);
  const allowed = new Set(relatedAssetIds);
  const claimed = new Set<string>();
  const reserve = (assetIds: readonly string[]) => {
    for (const assetId of assetIds) {
      if (!allowed.has(assetId) || claimed.has(assetId)) throw new Error('old-content asset outside the reviewed group');
      claimed.add(assetId);
    }
  };
  const items = parsed.items.map((item, index): FormationOldContentPlanItem => {
    const assetIds = uniqueIds(item.assetIds);
    if (assetIds.length !== item.assetIds.length) throw new Error('duplicate old-content asset');
    if (!ACTION_REASONS[item.action].has(item.reasonCode)) throw new Error('old-content reason does not match action');
    reserve(assetIds);
    const expectedVersions = versionsFor(assetIds, input.assets);
    if (item.action !== 'merge') {
      if (assetIds.length !== 1 || item.targetAssetId !== undefined || item.merged !== undefined)
        throw new Error('old-content single-asset action is malformed');
      return { itemId: `old-${index + 1}`, action: item.action, reasonCode: item.reasonCode,
        reason: item.reason, assetIds, expectedVersions };
    }
    if (assetIds.length < 2 || !item.targetAssetId || !assetIds.includes(item.targetAssetId) || !item.merged)
      throw new Error('old-content merge is malformed');
    const boundaries = assetIds.map(assetId => {
      const asset = input.assets.find(row => row.id === assetId);
      if (!asset) throw new Error('old-content baseline unavailable');
      const policy = Object.fromEntries(Object.entries(asset.scopePolicy || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => [key, [...values].sort()]));
      return JSON.stringify([asset.type, asset.scope, policy]);
    });
    if (new Set(boundaries).size !== 1) throw new Error('old-content merge boundaries are incompatible');
    const excerpts = item.merged.excerpts.map(part => {
      const asset = input.assets.find(row => row.id === part.assetId);
      if (!assetIds.includes(part.assetId) || !asset?.statement.includes(part.quote))
        throw new Error('old-content merge excerpt unavailable');
      return part;
    });
    if (assetIds.some(assetId => !excerpts.some(part => part.assetId === assetId)))
      throw new Error('old-content merge requires evidence from every source');
    return {
      itemId: `old-${index + 1}`,
      action: 'merge',
      reasonCode: item.reasonCode,
      reason: item.reason,
      assetIds,
      targetAssetId: item.targetAssetId,
      expectedVersions,
      merged: {
        statement: item.merged.statement,
        ...(item.merged.applicableWhen ? { applicableWhen: item.merged.applicableWhen } : {}),
        ...(item.merged.forbiddenWhen ? { forbiddenWhen: item.merged.forbiddenWhen } : {}),
        evidenceAssetIds: uniqueIds(excerpts.map(part => part.assetId)),
      },
    };
  });
  const unresolved = (parsed.unresolved || []).map((item): FormationOldContentUnresolvedItem => {
    const assetIds = uniqueIds(item.assetIds);
    if (assetIds.length !== item.assetIds.length) throw new Error('duplicate unresolved old-content asset');
    reserve(assetIds);
    return { reasonCode: item.reasonCode, reason: item.reason, assetIds,
      baselineVersions: versionsFor(assetIds, input.assets) };
  });
  // A group decision is complete only when every reviewed asset has a stated
  // destination. Omission would otherwise look like “keep” without a reason.
  if (relatedAssetIds.some(assetId => !claimed.has(assetId)))
    throw new Error('old-content plan does not cover the reviewed group');
  return { schemaVersion: 1, status: unresolved.length ? 'needs_review' : 'ready',
    assetIds: relatedAssetIds, baselineVersions: versionsFor(relatedAssetIds, input.assets), items, unresolved };
}
