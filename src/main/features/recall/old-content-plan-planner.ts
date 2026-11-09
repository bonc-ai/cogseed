/** Pure planning for an independent old-content plan. It never reads storage or
 * writes assets; the service supplies current records and commits the result. */
import { createHash } from 'node:crypto';
import { validatePromotionByAssetType } from './formal-assets/promotion';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { type OldContentExecutionItem, type OldContentPlanItem, type OldContentPlanRecord,
  effectiveOldContentAction, oldContentPlanDigest, oldContentUnresolvedItemId } from './old-content-plan-contract';
import { oldContentCoverageProof, sameOldContentBoundary } from './old-content-coverage';

export interface PlannedOldContent {
  executionId: string;
  digest: string;
  changes: Map<string, RecallAbilityAssetRecord>;
  receiptItems: OldContentExecutionItem[];
  blockers: string[];
  anchorId?: string;
}
const clean = (value: Record<string, unknown>) => {
  const { pendingVersionSnapshots: _pending, ...rest } = value;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
};
const nextVersion = (version: string): string => {
  const value = Number(version);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid old-content target version');
  return String(value + 1);
};
const activeVersion = (asset: Pick<RecallAbilityAssetRecord, 'activeVersion' | 'version'>): string =>
  String(asset.activeVersion || asset.version);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function mergeTarget(target: RecallAbilityAssetRecord, sources: RecallAbilityAssetRecord[],
  item: OldContentPlanItem, now: string): { record: RecallAbilityAssetRecord; version: string } {
  if (!item.targetAssetId || !item.merged) throw new Error('old-content merge is incomplete');
  const statement = item.merged.statement;
  const applicableWhen = item.merged.applicableWhen;
  const forbiddenWhen = item.merged.forbiddenWhen;
  const content = {
    ...target,
    statement,
    ...(applicableWhen !== undefined ? { applicableWhen } : {}),
    ...(forbiddenWhen !== undefined ? { forbiddenWhen } : {}),
  };
  if (applicableWhen?.length === 0) delete content.applicableWhen;
  if (forbiddenWhen?.length === 0) delete content.forbiddenWhen;
  const validation = validatePromotionByAssetType({
    judgment: content.statement, summary: target.title, value: target.value,
    suggestedType: target.type, suggestedScope: target.scope, suggestedAction: 'create',
    applicableWhen: content.applicableWhen, forbiddenWhen: content.forbiddenWhen,
  }, { actor: 'user' });
  if (!validation.ok) throw new Error('old-content merged body is invalid');
  assertNotForbiddenToPersist([content.statement, ...(content.applicableWhen || []), ...(content.forbiddenWhen || [])]);
  const bodyChanged = content.statement !== target.statement
    || JSON.stringify(content.applicableWhen ?? null) !== JSON.stringify(target.applicableWhen ?? null)
    || JSON.stringify(content.forbiddenWhen ?? null) !== JSON.stringify(target.forbiddenWhen ?? null);
  if (!bodyChanged) return { record: target, version: target.version };
  const evidenceRefs = [...target.evidenceRefs, ...sources.flatMap(source => source.evidenceRefs)];
  const relations = [...(target.relations || []), ...sources.flatMap(source => source.relations || [])];
  const derivedFrom = [...new Set([...(target.derivedFrom || []),
    ...sources.map(source => source.id)])];
  const next: RecallAbilityAssetRecord = {
    ...content,
    evidenceRefs: [...new Map(evidenceRefs.map(ref => [`${ref.kind}:${ref.subtype || ''}:${ref.id}`, ref])).values()],
    relations: [...new Map(relations.filter(ref => !sources.some(source => source.id === ref.assetId))
      .map(ref => [`${ref.kind}:${ref.assetId}`, ref])).values()],
    ...(derivedFrom.length ? { derivedFrom } : {}),
    version: nextVersion(target.version),
    activeVersion: nextVersion(target.version),
    updatedAt: now,
  };
  return { record: next, version: next.version };
}

export type OldContentUnitKind = 'item' | 'unresolved';
export interface OldContentUnitSelection {
  unitId: string;
  kind: OldContentUnitKind;
  executable: boolean;
  reason?: string;
}
export interface PlannedOldContentUnit extends PlannedOldContent {
  unitId: string;
  kind: OldContentUnitKind;
}

/** Every plan item and every resolved uncertain group is one atomic unit. */
export function listOldContentUnits(plan: OldContentPlanRecord): OldContentUnitSelection[] {
  const units: OldContentUnitSelection[] = plan.items.map(item => ({
    unitId: item.itemId, kind: 'item', executable: true,
  }));
  for (const unresolved of plan.unresolved) {
    const unitId = unresolved.itemId || oldContentUnresolvedItemId(unresolved);
    units.push({ unitId, kind: 'unresolved', executable: Boolean(unresolved.resolution),
      ...(unresolved.resolution ? {} : { reason: 'unresolved_open' }) });
  }
  return units;
}

function checkBaseline(plan: OldContentPlanRecord, byId: Map<string, RecallAbilityAssetRecord>,
  assetIds: readonly string[], blockers: string[], unitId: string): RecallAbilityAssetRecord[] {
  const assets: RecallAbilityAssetRecord[] = [];
  for (const assetId of assetIds) {
    const asset = byId.get(assetId);
    if (!asset) { blockers.push(`asset_missing:${unitId}:${assetId}`); continue; }
    if (!['active', 'paused'].includes(asset.status)) blockers.push(`asset_inactive:${unitId}:${assetId}`);
    if (activeVersion(asset) !== plan.baselineVersions[assetId]) blockers.push(`baseline_changed:${unitId}:${assetId}`);
    assets.push(asset);
  }
  return assets;
}

function finishUnit(plan: OldContentPlanRecord, unitId: string, kind: OldContentUnitKind,
  changes: Map<string, RecallAbilityAssetRecord>, receiptItems: OldContentExecutionItem[],
  blockers: string[]): PlannedOldContentUnit {
  if (blockers.length) return { unitId, kind, executionId: '', digest: plan.digest, changes: new Map(),
    receiptItems: [], blockers };
  const digest = oldContentPlanDigest(plan);
  const executionId = `oce-${hash([plan.id, plan.revision, digest, unitId,
    receiptItems.map(item => ({ itemId: item.itemId, action: item.action, assetIds: item.assetIds }))]).slice(0, 32)}`;
  return { unitId, kind, executionId, digest, changes, receiptItems, blockers: [],
    ...(changes.size ? { anchorId: changes.keys().next().value } : {}) };
}

function buildItemUnit(plan: OldContentPlanRecord, byId: Map<string, RecallAbilityAssetRecord>,
  item: OldContentPlanRecord['items'][number], now: string): PlannedOldContentUnit {
  const unitId = item.itemId;
  const action = effectiveOldContentAction(item);
  if (action === 'keep')
    return finishUnit(plan, unitId, 'item', new Map(),
      [{ itemId: unitId, action: 'keep', status: 'kept', assetIds: [...item.assetIds] }], []);
  const blockers: string[] = [];
  const itemAssets = checkBaseline(plan, byId, item.assetIds, blockers, unitId);
  if (itemAssets.length !== item.assetIds.length) return finishUnit(plan, unitId, 'item', new Map(), [], blockers);
  const changes = new Map<string, RecallAbilityAssetRecord>();
  const receiptItems: OldContentExecutionItem[] = [];
  if (action === 'merge') {
    const target = byId.get(item.targetAssetId || '');
    if (!target || !item.merged) return finishUnit(plan, unitId, 'item', new Map(), [], [`merge_target_missing:${unitId}`]);
    if (!item.assetIds.includes(target.id) || itemAssets.some(asset => !sameOldContentBoundary(target, asset)))
      return finishUnit(plan, unitId, 'item', new Map(), [], [`merge_boundary:${unitId}`]);
    const sources = itemAssets.filter(asset => asset.id !== target.id);
    const merged = mergeTarget(target, sources, item, now);
    if (merged.record !== target) changes.set(target.id, merged.record);
    for (const source of sources)
      changes.set(source.id, { ...source, status: 'archived', mergedIntoAssetId: target.id, updatedAt: now });
    receiptItems.push({ itemId: unitId, action: 'merge', status: 'applied', assetIds: [...item.assetIds],
      targetAssetId: target.id, targetVersion: merged.version, archivedIds: sources.map(source => source.id) });
  } else if (action === 'archive' || action === 'delete') {
    if (itemAssets.length !== 1) return finishUnit(plan, unitId, 'item', new Map(), [], [`single_asset_action:${unitId}`]);
    const asset = itemAssets[0];
    changes.set(asset.id, action === 'archive'
      ? { ...asset, status: 'archived' as const, updatedAt: now }
      : { ...asset, status: 'deleted' as const, deletedAt: now, updatedAt: now });
    receiptItems.push({ itemId: unitId, action, status: 'applied', assetIds: [asset.id],
      ...(action === 'archive' ? { archivedIds: [asset.id] } : { deletedIds: [asset.id] }) });
  }
  return finishUnit(plan, unitId, 'item', changes, receiptItems, blockers);
}

function buildUnresolvedUnit(plan: OldContentPlanRecord, byId: Map<string, RecallAbilityAssetRecord>,
  unresolved: OldContentPlanRecord['unresolved'][number], now: string): PlannedOldContentUnit {
  const unitId = unresolved.itemId || oldContentUnresolvedItemId(unresolved);
  if (!unresolved.resolution)
    return finishUnit(plan, unitId, 'unresolved', new Map(), [], [`unresolved_open:${unitId}`]);
  if (unresolved.resolution === 'keep')
    return finishUnit(plan, unitId, 'unresolved', new Map(),
      [{ itemId: unitId, action: 'keep', status: 'kept', assetIds: [...unresolved.assetIds] }], []);
  const blockers: string[] = [];
  const group = checkBaseline(plan, byId, unresolved.assetIds, blockers, unitId);
  if (group.length !== unresolved.assetIds.length) return finishUnit(plan, unitId, 'unresolved', new Map(), [], blockers);
  const changes = new Map<string, RecallAbilityAssetRecord>();
  const receiptItems: OldContentExecutionItem[] = [];
  if (unresolved.resolution.kind === 'archive') {
    if (group.length !== 1) return finishUnit(plan, unitId, 'unresolved', new Map(), [], [`single_asset_action:${unitId}`]);
    const asset = group[0];
    changes.set(asset.id, { ...asset, status: 'archived' as const, updatedAt: now });
    receiptItems.push({ itemId: unitId, action: 'archive', status: 'applied', assetIds: [asset.id],
      archivedIds: [asset.id] });
    return finishUnit(plan, unitId, 'unresolved', changes, receiptItems, blockers);
  }
  const target = byId.get(unresolved.resolution.targetAssetId);
  if (!target || !unresolved.assetIds.includes(target.id))
    return finishUnit(plan, unitId, 'unresolved', new Map(), [], [`merge_target_missing:${unitId}`]);
  const sources = group.filter(asset => asset.id !== target.id);
  if (!sources.length) return finishUnit(plan, unitId, 'unresolved', new Map(), [], [`merge_target_missing:${unitId}`]);
  if (group.some(asset => !sameOldContentBoundary(target, asset)))
    return finishUnit(plan, unitId, 'unresolved', new Map(), [], [`merge_boundary:${unitId}`]);
  const proof = oldContentCoverageProof(target, sources);
  if (!proof.ok) return finishUnit(plan, unitId, 'unresolved', new Map(), [], [`${proof.code}:${unitId}`]);
  const synthetic: OldContentPlanItem = {
    itemId: unitId, modelAction: 'merge', action: 'merge', state: 'included',
    reasonCode: 'merge_coverage', reason: unresolved.reason, assetIds: [...unresolved.assetIds],
    targetAssetId: target.id, expectedVersions: { ...unresolved.baselineVersions },
    merged: { statement: target.statement, ...(target.applicableWhen ? { applicableWhen: [...target.applicableWhen] } : {}),
      ...(target.forbiddenWhen ? { forbiddenWhen: [...target.forbiddenWhen] } : {}),
      evidenceAssetIds: [...unresolved.assetIds], bodySource: 'user' },
  };
  const merged = mergeTarget(target, sources, synthetic, now);
  if (merged.record !== target) changes.set(target.id, merged.record);
  for (const source of sources)
    changes.set(source.id, { ...source, status: 'archived', mergedIntoAssetId: target.id, updatedAt: now });
  receiptItems.push({ itemId: unitId, action: 'merge', status: 'applied', assetIds: [...unresolved.assetIds],
    targetAssetId: target.id, targetVersion: merged.version, archivedIds: sources.map(source => source.id) });
  return finishUnit(plan, unitId, 'unresolved', changes, receiptItems, blockers);
}

/** Units are independent: one unit's blocker never suppresses another unit. */
export function planOldContentUnits(plan: OldContentPlanRecord, assets: readonly RecallAbilityAssetRecord[],
  unitIds?: readonly string[], now = new Date().toISOString()): { units: PlannedOldContentUnit[]; blockers: string[] } {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const selections = listOldContentUnits(plan);
  const byUnit = new Map(selections.map(selection => [selection.unitId, selection]));
  const blockers: string[] = [];
  const wanted = unitIds ? [...new Set(unitIds)] : selections.filter(selection => selection.executable).map(selection => selection.unitId);
  if (unitIds) for (const unitId of wanted) if (!byUnit.has(unitId)) blockers.push(`unit_missing:${unitId}`);
  if (!wanted.length) blockers.push('no_executable_units');
  const units: PlannedOldContentUnit[] = [];
  for (const unitId of wanted) {
    const selection = byUnit.get(unitId);
    if (!selection) continue;
    if (!selection.executable) {
      units.push(finishUnit(plan, unitId, selection.kind, new Map(), [], [selection.reason || `unit_not_executable:${unitId}`]));
      continue;
    }
    if (selection.kind === 'item') {
      const item = plan.items.find(row => row.itemId === unitId)!;
      units.push(buildItemUnit(plan, byId, item, now));
    } else {
      const unresolved = plan.unresolved.find(row => (row.itemId || oldContentUnresolvedItemId(row)) === unitId)!;
      units.push(buildUnresolvedUnit(plan, byId, unresolved, now));
    }
  }
  return { units, blockers };
}

/** Legacy all-or-nothing view used by formation tests and previews. */
export function planOldContentChanges(plan: OldContentPlanRecord,
  assets: readonly RecallAbilityAssetRecord[], now = new Date().toISOString()): PlannedOldContent {
  const planned = planOldContentUnits(plan, assets, undefined, now);
  const blockers = [...planned.blockers, ...planned.units.flatMap(unit => unit.blockers)];
  const changes = new Map<string, RecallAbilityAssetRecord>();
  const receiptItems: OldContentExecutionItem[] = [];
  for (const unit of planned.units) {
    for (const [assetId, asset] of unit.changes) changes.set(assetId, asset);
    receiptItems.push(...unit.receiptItems);
  }
  if (!blockers.length && !receiptItems.length) blockers.push('no_effective_items');
  if (blockers.length) return { executionId: '', digest: plan.digest, changes: new Map(), receiptItems: [], blockers };
  const digest = oldContentPlanDigest(plan);
  const executionId = `oce-${hash([plan.id, plan.revision, digest,
    receiptItems.map(item => ({ itemId: item.itemId, action: item.action, assetIds: item.assetIds }))]).slice(0, 32)}`;
  return {
    executionId, digest, changes, receiptItems, blockers: [],
    ...(changes.size ? { anchorId: changes.keys().next().value } : {}),
  };
}

export { clean };
