import { describe, expect, it } from 'vitest';
import type { RecallAbilityAssetRecord } from '../../../../src/main/features/recall/candidate-service';
import type { FormationOldContentPlan } from '../../../../src/main/features/recall/formation-old-content';
import {
  applyOldContentPlanOps,
  effectiveOldContentAction,
  normalizeOldContentPlan,
  oldContentPlanDigest,
  oldContentUnresolvedItemId,
  planFromFormation,
} from '../../../../src/main/features/recall/old-content-plan-contract';
import { planOldContentChanges } from '../../../../src/main/features/recall/old-content-plan-planner';

const at = '2026-10-28T00:00:00.000Z';
function asset(id: string, statement: string, version = '1'): RecallAbilityAssetRecord {
  return { schemaVersion: 1, ownerId: 'user-a', id, candidateId: 'seed', reviewDecisionId: 'rd_seed',
    type: 'rule', title: id, statement, evidenceRefs: [], scope: 'report', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version, activeVersion: version,
    createdAt: at, updatedAt: at } as RecallAbilityAssetRecord;
}
function legacyPlan(over: Partial<FormationOldContentPlan> = {}): FormationOldContentPlan {
  return {
    schemaVersion: 1, status: 'ready', assetIds: ['asset-a', 'asset-b'],
    baselineVersions: { 'asset-a': '1', 'asset-b': '1' },
    items: [{ itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '两条共同约束报告。',
      assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
      expectedVersions: { 'asset-a': '1', 'asset-b': '1' },
      merged: { statement: '报告提交前核对来源并写结论。', evidenceAssetIds: ['asset-a', 'asset-b'] } }],
    unresolved: [], ...over,
  };
}
const assets = [asset('asset-a', '报告提交前核对来源。'), asset('asset-b', '报告提交前写结论。')];

describe('independent old-content plan', () => {
  it('migrates a formation plan into one deterministic group document', () => {
    const first = planFromFormation(legacyPlan(), { ownerId: 'user-a', candidateId: 'cand-a', now: at });
    const second = planFromFormation(legacyPlan(), { ownerId: 'user-a', candidateId: 'cand-b', now: at });
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ schemaVersion: 2, revision: 1, status: 'ready', origin: 'formation',
      assetIds: ['asset-a', 'asset-b'], candidateIds: ['cand-a'] });
    expect(first.digest).toBe(oldContentPlanDigest(first));
    expect(first.items[0]).toMatchObject({ modelAction: 'merge', action: 'merge', state: 'included' });
    expect(first.items[0].merged?.bodySource).toBe('model');
  });

  it('downgrades an item to an effective keep without changing group coverage', () => {
    const plan = planFromFormation(legacyPlan(), { ownerId: 'user-a', now: at });
    const revised = applyOldContentPlanOps(plan, [{ op: 'keep_item', itemId: 'old-1' }]);
    expect(revised.revision).toBe(2);
    expect(revised.status).toBe('ready');
    expect(revised.items[0].state).toBe('excluded');
    expect(effectiveOldContentAction(revised.items[0])).toBe('keep');
    expect(revised.digest).not.toBe(plan.digest);
    expect(revised.assetIds).toEqual(['asset-a', 'asset-b']);
  });

  it('resolves every uncertain group to keep and makes the plan executable', () => {
    const legacy = legacyPlan({ status: 'needs_review', items: [], unresolved: [{
      reasonCode: 'needs_user_arbitration', reason: '两条结论冲突。', assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1' } }] });
    const plan = planFromFormation(legacy, { ownerId: 'user-a', now: at });
    expect(plan.status).toBe('needs_review');
    const revised = applyOldContentPlanOps(plan, [{ op: 'keep_unresolved' }]);
    expect(revised.status).toBe('ready');
    expect(revised.unresolved[0].resolution).toBe('keep');
    expect(planOldContentChanges(revised, assets).receiptItems).toEqual([{
      itemId: revised.unresolved[0].itemId, action: 'keep', status: 'kept', assetIds: ['asset-a', 'asset-b'],
    }]);
  });

  it('builds one atomic merge plan and one receipt without touching excluded items', () => {
    const plan = planFromFormation(legacyPlan(), { ownerId: 'user-a', now: at });
    const prepared = planOldContentChanges(plan, assets, at);
    expect(prepared.blockers).toEqual([]);
    expect(prepared.executionId).toMatch(/^oce-[a-f0-9]{32}$/);
    expect(prepared.changes.get('asset-a')?.statement).toBe('报告提交前核对来源并写结论。');
    expect(prepared.changes.get('asset-a')?.version).toBe('2');
    expect(prepared.changes.get('asset-b')).toMatchObject({ status: 'archived', mergedIntoAssetId: 'asset-a' });
    expect(prepared.receiptItems[0]).toMatchObject({ action: 'merge', targetAssetId: 'asset-a', targetVersion: '2',
      archivedIds: ['asset-b'] });
  });

  it('fails closed on a changed baseline and never invents a write', () => {
    const plan = planFromFormation(legacyPlan(), { ownerId: 'user-a', now: at });
    const prepared = planOldContentChanges(plan, [assets[0], { ...assets[1], version: '2', activeVersion: '2' }]);
    expect(prepared.blockers).toContain('baseline_changed:old-1:asset-b');
    expect(prepared.changes.size).toBe(0);
    expect(prepared.receiptItems).toEqual([]);
  });

  it('derives stable unresolved ids and resolves them one by one', () => {
    const legacy = legacyPlan({ status: 'needs_review', items: [], unresolved: [{
      reasonCode: 'needs_user_arbitration', reason: '两条结论冲突。', assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1' } }] });
    const plan = planFromFormation(legacy, { ownerId: 'user-a', now: at });
    const itemId = plan.unresolved[0].itemId!;
    expect(itemId).toBe(oldContentUnresolvedItemId(plan.unresolved[0]));
    const kept = applyOldContentPlanOps(plan, [{ op: 'resolve_unresolved', itemId, resolution: 'keep' }]);
    expect(kept.status).toBe('ready');
    expect(kept.unresolved[0].resolution).toBe('keep');
    const merged = applyOldContentPlanOps(plan, [{ op: 'resolve_unresolved', itemId,
      resolution: { kind: 'merge', targetAssetId: 'asset-a' } }]);
    expect(merged.status).toBe('ready');
    expect(merged.unresolved[0].resolution).toEqual({ kind: 'merge', targetAssetId: 'asset-a' });
    expect(() => applyOldContentPlanOps(plan, [{ op: 'resolve_unresolved', itemId,
      resolution: { kind: 'archive' } }])).toThrow('single asset');
    expect(() => applyOldContentPlanOps(plan, [{ op: 'resolve_unresolved', itemId,
      resolution: { kind: 'merge', targetAssetId: 'outside' } }])).toThrow('belong to the unresolved group');
  });

  it('fills unresolved ids on legacy records without rewriting their digest', () => {
    const plan = planFromFormation(legacyPlan({ status: 'needs_review', items: [], unresolved: [{
      reasonCode: 'evidence_insufficient', reason: '来源读不全。', assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1' } }] }), { ownerId: 'user-a', now: at });
    const raw = { ...plan, unresolved: plan.unresolved.map(item => ({ ...item, itemId: undefined })) };
    const normalized = normalizeOldContentPlan(raw as typeof plan);
    expect(normalized.unresolved[0].itemId).toMatch(/^unresolved-[a-f0-9]{12}$/);
    expect(normalized.digest).toBe(raw.digest);
  });

  it('only accepts merge target changes inside the item group', () => {
    const plan = planFromFormation(legacyPlan(), { ownerId: 'user-a', now: at });
    const revised = applyOldContentPlanOps(plan, [{ op: 'set_merge_target', itemId: 'old-1', targetAssetId: 'asset-a' }]);
    expect(revised.items[0].targetAssetId).toBe('asset-a');
    expect(() => applyOldContentPlanOps(plan, [{ op: 'set_merge_target', itemId: 'old-1', targetAssetId: 'outside' }]))
      .toThrow('merge target must belong');
  });
});
