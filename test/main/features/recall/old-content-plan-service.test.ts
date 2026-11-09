import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import type { FormationOldContentPlan } from '../../../../src/main/features/recall/formation-old-content';

const uid = 'synthetic-old-plan-user';
let root: string, previous: string | undefined;
beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'old-content-plan-service-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] },
    pendingProjection: false, migratedAt: new Date().toISOString() });
});
afterEach(async () => {
  await drainMainRuntimeForTest(uid);
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
async function seed(id: string, statement: string, patch: Record<string, unknown> = {}) {
  const store = await import('../../../../src/main/features/recall/store');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const at = new Date().toISOString();
  const record = { schemaVersion: 1, ownerId: uid, id, candidateId: 'seed-candidate', reviewDecisionId: 'rd_syntheticseed',
    type: 'rule', title: id, statement, evidenceRefs: [], origin: 'manual', scope: 'report', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1', createdAt: at, updatedAt: at,
    ...patch } as any;
  await store.writeRecallJsonRecord(uid, 'ability-assets', id, record);
  await assets.initializeAbilityAsset(uid, record, { actor: 'user', reason: 'Synthetic seed' });
}
function legacyPlan(): FormationOldContentPlan {
  return { schemaVersion: 1, status: 'ready', assetIds: ['asset-a', 'asset-b'],
    baselineVersions: { 'asset-a': '1', 'asset-b': '1' },
    items: [{ itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '合并两条报告要求。',
      assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
      expectedVersions: { 'asset-a': '1', 'asset-b': '1' },
      merged: { statement: '报告提交前核对来源并写结论。', evidenceAssetIds: ['asset-a', 'asset-b'] } }],
    unresolved: [] };
}
describe('old-content plan service', () => {
  it('creates one group plan, executes it once and returns the original receipt on repeat', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const first = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    const second = await service.bindOldContentPlan(uid, 'cand-b', legacyPlan());
    expect(first.id).toBe(second.id);
    expect(second.candidateIds).toEqual(['cand-a', 'cand-b']);
    const result = await service.executeOldContentPlan(uid, first.id, { candidateId: 'cand-a' });
    expect(result.plan.status).toBe('applied');
    expect(result.execution.items[0]).toMatchObject({ action: 'merge', targetAssetId: 'asset-a', targetVersion: '2',
      archivedIds: ['asset-b'] });
    expect(await assets.readAbilityAsset(uid, 'asset-a')).toMatchObject({ version: '2', activeVersion: '2',
      statement: '报告提交前核对来源并写结论。' });
    expect(await assets.readAbilityAsset(uid, 'asset-b')).toMatchObject({ status: 'archived', mergedIntoAssetId: 'asset-a' });
    const repeated = await service.executeOldContentPlan(uid, first.id, { candidateId: 'cand-b' });
    expect(repeated.duplicate).toBe(true);
    expect((await assets.readAbilityAsset(uid, 'asset-a')).version).toBe('2');
  });

  it('lists actionable plans independently of the proposing candidate', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const first = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    await service.bindOldContentPlan(uid, 'cand-b', legacyPlan());
    const plans = await service.listActionableOldContentPlans(uid);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: first.id, status: 'ready', candidateIds: ['cand-a', 'cand-b'],
      itemCount: 1, unresolvedCount: 0, executedCount: 0 });
    expect(plans[0].assets.map(asset => asset.title)).toEqual(['asset-a', 'asset-b']);
    expect(plans[0].assets.map(asset => asset.version)).toEqual(['1', '1']);
  });

  it('edits a plan into keep decisions without touching assets', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    const revised = await service.updateOldContentPlan(uid, plan.id, plan.revision,
      [{ op: 'keep_item', itemId: 'old-1' }]);
    expect(revised.status).toBe('ready');
    expect(revised.items[0].state).toBe('excluded');
    const result = await service.executeOldContentPlan(uid, plan.id);
    expect(result.plan.status).toBe('applied');
    expect(result.execution.items[0]).toMatchObject({ action: 'keep', status: 'kept' });
    expect((await assets.readAbilityAsset(uid, 'asset-a')).version).toBe('1');
    expect((await assets.readAbilityAsset(uid, 'asset-b')).status).toBe('active');
  });

  it('lets the user rewrite the merged body before execution', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    const revised = await service.updateOldContentPlan(uid, plan.id, plan.revision,
      [{ op: 'edit_merge_body', itemId: 'old-1', statement: '报告提交前核对来源、写结论并归档。',
        applicableWhen: ['提交正式报告前'] }]);
    expect(revised.revision).toBe(plan.revision + 1);
    expect(revised.items[0].merged).toMatchObject({ statement: '报告提交前核对来源、写结论并归档。',
      bodySource: 'user', applicableWhen: ['提交正式报告前'] });
    const result = await service.executeOldContentPlan(uid, plan.id);
    expect(result.plan.status).toBe('applied');
    expect(await assets.readAbilityAsset(uid, 'asset-a')).toMatchObject({ version: '2',
      statement: '报告提交前核对来源、写结论并归档。' });
  });

  it('finalizes the old plan and the new suggestion in two durable phases', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '每周复盘记录实验结论和下一步。', value: '避免复盘只写感受。', summary: '复盘记录要求',
      suggestedType: 'rule', suggestedScope: 'product', suggestedAction: 'create', risk: 'low',
      sourceRefs: [], rawStatement: true, oldContentPlan: legacyPlan(),
    });
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const finalize = await import('../../../../src/main/features/recall/old-content-finalize');
    const result = await finalize.finalizeCandidate(uid, candidate.id, 'old_then_new');
    expect(result.phase).toBe('new_saved');
    expect(result.candidate.status).toBe('confirmed');
    const plan = await service.readOldContentPlan(uid, candidate.oldContentPlanId!);
    expect(plan.status).toBe('applied');
    expect(plan.finalizations.find(row => row.candidateId === candidate.id)?.phase).toBe('new_saved');
  });

  it('resolves an uncertain group with a provable merge target', async () => {
    await seed('asset-a', '报告提交前核对来源。报告提交前写结论。');
    await seed('asset-b', '报告提交前核对来源。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', {
      schemaVersion: 1, status: 'needs_review', assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1' }, items: [],
      unresolved: [{ reasonCode: 'needs_user_arbitration', reason: '需要确认合并目标。',
        assetIds: ['asset-a', 'asset-b'], baselineVersions: { 'asset-a': '1', 'asset-b': '1' } }],
    });
    const resolved = await service.resolveOldContentUnresolved(uid, plan.id, plan.revision, [{
      op: 'resolve_unresolved', itemId: plan.unresolved[0].itemId!,
      resolution: { kind: 'merge', targetAssetId: 'asset-a' },
    }]);
    expect(resolved.revision).toBe(2);
    expect(resolved.status).toBe('ready');
    expect(resolved.unresolved[0].resolution).toEqual({ kind: 'merge', targetAssetId: 'asset-a' });
  });

  it('refuses a merge the host cannot prove and an over-broad archive', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', {
      schemaVersion: 1, status: 'needs_review', assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1' }, items: [],
      unresolved: [{ reasonCode: 'needs_user_arbitration', reason: '需要确认合并目标。',
        assetIds: ['asset-a', 'asset-b'], baselineVersions: { 'asset-a': '1', 'asset-b': '1' } }],
    });
    const itemId = plan.unresolved[0].itemId!;
    await expect(service.resolveOldContentUnresolved(uid, plan.id, plan.revision, [{
      op: 'resolve_unresolved', itemId, resolution: { kind: 'merge', targetAssetId: 'asset-a' },
    }])).rejects.toThrow('merge body not contained');
    await expect(service.resolveOldContentUnresolved(uid, plan.id, plan.revision, [{
      op: 'resolve_unresolved', itemId, resolution: { kind: 'archive' },
    }])).rejects.toThrow('single asset');
    expect((await service.readOldContentPlan(uid, plan.id)).revision).toBe(1);
  });

  it('executes selected units independently and keeps the remainder actionable', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    await seed('asset-c', '离线草稿不进入正式流程。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', {
      schemaVersion: 1, status: 'ready', assetIds: ['asset-a', 'asset-b', 'asset-c'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1', 'asset-c': '1' },
      items: [
        { itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '合并两条报告要求。',
          assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
          expectedVersions: { 'asset-a': '1', 'asset-b': '1' },
          merged: { statement: '报告提交前核对来源并写结论。', evidenceAssetIds: ['asset-a', 'asset-b'] } },
        { itemId: 'old-2', action: 'archive', reasonCode: 'archive_obsolete', reason: '离线草稿停用。',
          assetIds: ['asset-c'], expectedVersions: { 'asset-c': '1' } },
      ],
      unresolved: [],
    });
    const first = await service.executeOldContentPlan(uid, plan.id, { itemIds: ['old-1'] });
    expect(first.results).toEqual([{ unitId: 'old-1', status: 'applied' }]);
    expect(first.plan.status).toBe('ready');
    expect((await assets.readAbilityAsset(uid, 'asset-b')).status).toBe('archived');
    expect((await assets.readAbilityAsset(uid, 'asset-c')).status).toBe('active');
    const second = await service.executeOldContentPlan(uid, plan.id, { itemIds: ['old-2'] });
    expect(second.plan.status).toBe('applied');
    expect((await assets.readAbilityAsset(uid, 'asset-c')).status).toBe('archived');
    const repeated = await service.executeOldContentPlan(uid, plan.id, { itemIds: ['old-1'] });
    expect(repeated.results).toEqual([{ unitId: 'old-1', status: 'already_applied' }]);
    expect(repeated.duplicate).toBe(true);
  });

  it('keeps a failed unit actionable while other selected units commit', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    await seed('asset-c', '离线草稿不进入正式流程。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', {
      schemaVersion: 1, status: 'ready', assetIds: ['asset-a', 'asset-b', 'asset-c'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1', 'asset-c': '1' },
      items: [
        { itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '合并两条报告要求。',
          assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
          expectedVersions: { 'asset-a': '1', 'asset-b': '1' },
          merged: { statement: '报告提交前核对来源并写结论。', evidenceAssetIds: ['asset-a', 'asset-b'] } },
        { itemId: 'old-2', action: 'archive', reasonCode: 'archive_obsolete', reason: '离线草稿停用。',
          assetIds: ['asset-c'], expectedVersions: { 'asset-c': '1' } },
      ],
      unresolved: [],
    });
    await assets.updateAbilityAsset(uid, 'asset-c', { statement: '离线草稿仍需保留。',
      actor: 'user', reason: 'Synthetic concurrent edit' });
    const result = await service.executeOldContentPlan(uid, plan.id);
    expect(result.results).toEqual([
      { unitId: 'old-1', status: 'applied' },
      { unitId: 'old-2', status: 'failed', code: expect.stringContaining('baseline_changed') },
    ]);
    expect(result.plan.status).toBe('ready');
    expect((await assets.readAbilityAsset(uid, 'asset-a')).version).toBe('2');
    expect((await assets.readAbilityAsset(uid, 'asset-c')).status).toBe('active');
  });

  it('refuses a resolution after a group baseline changed', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', {
      schemaVersion: 1, status: 'needs_review', assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '1', 'asset-b': '1' }, items: [],
      unresolved: [{ reasonCode: 'needs_user_arbitration', reason: '需要确认合并目标。',
        assetIds: ['asset-a', 'asset-b'], baselineVersions: { 'asset-a': '1', 'asset-b': '1' } }],
    });
    await assets.updateAbilityAsset(uid, 'asset-b', { statement: '报告提交前写结论与负责人。',
      actor: 'user', reason: 'Synthetic concurrent edit' });
    await expect(service.resolveOldContentUnresolved(uid, plan.id, plan.revision, [{
      op: 'resolve_unresolved', itemId: plan.unresolved[0].itemId!,
      resolution: { kind: 'merge', targetAssetId: 'asset-a' },
    }])).rejects.toThrow('baseline changed');
  });

  it('commits old content only, then retries just the new suggestion', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '每周复盘记录实验结论和下一步。', value: '避免复盘只写感受。', summary: '复盘记录要求',
      suggestedType: 'rule', suggestedScope: 'product', suggestedAction: 'create', risk: 'low',
      sourceRefs: [], rawStatement: true, oldContentPlan: legacyPlan(),
    });
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const finalize = await import('../../../../src/main/features/recall/old-content-finalize');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const oldOnly = await finalize.finalizeCandidate(uid, candidate.id, 'old_only');
    expect(oldOnly.phase).toBe('old_committed');
    expect((await candidates.readRecallCandidate(uid, candidate.id)).status).toBe('pending_review');
    const applied = await service.readOldContentPlan(uid, candidate.oldContentPlanId!);
    expect(applied.status).toBe('applied');
    const executions = applied.executions.length;
    const retry = await finalize.finalizeCandidate(uid, candidate.id, 'new_only');
    expect(retry.phase).toBe('new_saved');
    expect(retry.candidate.status).toBe('confirmed');
    expect((await service.readOldContentPlan(uid, candidate.oldContentPlanId!)).executions.length).toBe(executions);
  });

  it('refuses to save new content before a ready plan is committed', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const candidate = await createNightlyCandidateFixture(uid, {
      judgment: '每周复盘记录实验结论和下一步。', value: '避免复盘只写感受。', summary: '复盘记录要求',
      suggestedType: 'rule', suggestedScope: 'product', suggestedAction: 'create', risk: 'low',
      sourceRefs: [], rawStatement: true, oldContentPlan: legacyPlan(),
    });
    const finalize = await import('../../../../src/main/features/recall/old-content-finalize');
    await expect(finalize.finalizeCandidate(uid, candidate.id, 'new_only'))
      .rejects.toThrow('must be committed');
  });

  it('builds review details with before/after, target version and delete impact', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    await seed('asset-c', '临时测试内容，不应保留。');
    await seed('asset-d', '依赖临时内容的校验规则。',
      { relations: [{ kind: 'related_to', assetId: 'asset-c' }] });
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const review = await import('../../../../src/main/features/recall/old-content-plan-review');
    const mergePlan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    const mergeReview = await review.buildOldContentPlanReview(uid, mergePlan.id);
    expect(mergeReview.units[0]).toMatchObject({ unitId: 'old-1', action: 'merge',
      targetAssetId: 'asset-a', targetVersion: '2' });
    const target = mergeReview.units[0].assets.find(asset => asset.id === 'asset-a')!;
    expect(target.before?.statement).toBe('报告提交前核对来源。');
    expect(target.after?.statement).toBe('报告提交前核对来源并写结论。');
    expect(target.changes.some(change => change.field === 'statement')).toBe(true);

    const deletePlan = await service.bindOldContentPlan(uid, 'cand-b', {
      schemaVersion: 1, status: 'ready', assetIds: ['asset-c', 'asset-d'],
      baselineVersions: { 'asset-c': '1', 'asset-d': '1' },
      items: [
        { itemId: 'del-1', action: 'delete', reasonCode: 'delete_unsuitable',
          reason: '测试数据不保留。', assetIds: ['asset-c'], expectedVersions: { 'asset-c': '1' } },
        { itemId: 'keep-1', action: 'keep', reasonCode: 'keep_independent',
          reason: '依赖规则保留。', assetIds: ['asset-d'], expectedVersions: { 'asset-d': '1' } },
      ],
      unresolved: [],
    });
    const deleteReview = await review.buildOldContentPlanReview(uid, deletePlan.id);
    expect(deleteReview.units[0].action).toBe('delete');
    expect(deleteReview.units[0].assets[0].deleteImpact).toEqual([{ id: 'asset-d',
      title: 'asset-d', kind: 'asset', relationKind: 'related_to' }]);
  });

  it('undoes an applied plan, keeps history and treats a repeat as a duplicate', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const undo = await import('../../../../src/main/features/recall/old-content-undo');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    await service.executeOldContentPlan(uid, plan.id);
    const preview = await undo.previewOldContentUndo(uid, plan.id);
    expect(preview.blockers).toEqual([]);
    expect(preview.effects.map(effect => effect.assetId).sort()).toEqual(['asset-a', 'asset-b']);
    const result = await undo.undoOldContentPlan(uid, plan.id, preview.token);
    expect(result.undone).toBe(true);
    expect(result.plan.status).toBe('undone');
    expect(await assets.readAbilityAsset(uid, 'asset-a')).toMatchObject({
      version: '3', activeVersion: '3', statement: '报告提交前核对来源。', status: 'active' });
    expect(await assets.readAbilityAsset(uid, 'asset-b')).toMatchObject({ status: 'active' });
    expect((await assets.readAbilityAsset(uid, 'asset-b')).mergedIntoAssetId).toBeUndefined();
    const repeated = await undo.undoOldContentPlan(uid, plan.id, preview.token);
    expect(repeated.duplicate).toBe(true);
  });

  it('blocks undo after a later edit or a new reference', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const undo = await import('../../../../src/main/features/recall/old-content-undo');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const edited = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    await service.executeOldContentPlan(uid, edited.id);
    await assets.updateAbilityAsset(uid, 'asset-a', { statement: '报告提交前核对来源与编号。',
      actor: 'user', reason: 'Synthetic later edit' });
    const changed = await undo.previewOldContentUndo(uid, edited.id);
    expect(changed.blockers).toContain('changed_since:asset-a');

    await seed('asset-c', '报告提交前核对来源。'); await seed('asset-d', '报告提交前写结论。');
    const referenced = await service.bindOldContentPlan(uid, 'cand-b', {
      ...legacyPlan(), assetIds: ['asset-c', 'asset-d'],
      baselineVersions: { 'asset-c': '1', 'asset-d': '1' },
      items: [{ itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary',
        reason: '合并两条报告要求。', assetIds: ['asset-c', 'asset-d'], targetAssetId: 'asset-c',
        expectedVersions: { 'asset-c': '1', 'asset-d': '1' },
        merged: { statement: '报告提交前核对来源并写结论。', evidenceAssetIds: ['asset-c', 'asset-d'] } }],
    });
    await service.executeOldContentPlan(uid, referenced.id);
    await seed('asset-e', '引用来源的规则。', { relations: [{ kind: 'related_to', assetId: 'asset-d' }] });
    const referencedPreview = await undo.previewOldContentUndo(uid, referenced.id);
    expect(referencedPreview.blockers).toContain('referenced_since:asset-d');
  });

  it('writes causal audit events per asset and replays them idempotently', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const undo = await import('../../../../src/main/features/recall/old-content-undo');
    const auditModule = await import('../../../../src/main/features/recall/old-content-audit');
    const timeline = await import('../../../../src/main/features/recall/timeline-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    await service.executeOldContentPlan(uid, plan.id);
    const applied = (await assets.listAbilityAssetAudit(uid, 'asset-a'))
      .filter(row => row.action === 'old_content_applied');
    expect(applied).toHaveLength(1);
    expect(applied[0].refs).toMatchObject({ planId: plan.id });
    expect(applied[0].refs?.executionId).toMatch(/^oce-/);

    const current = await service.readOldContentPlan(uid, plan.id);
    await service.saveOldContentPlan(uid, { ...current,
      executions: current.executions.map(execution => ({ ...execution, audit: { state: 'pending' as const, attempts: 0 } })) });
    await auditModule.reconcileOldContentAudit(uid, plan.id);
    expect((await assets.listAbilityAssetAudit(uid, 'asset-a'))
      .filter(row => row.action === 'old_content_applied')).toHaveLength(1);

    const preview = await undo.previewOldContentUndo(uid, plan.id);
    await undo.undoOldContentPlan(uid, plan.id, preview.token);
    expect((await assets.listAbilityAssetAudit(uid, 'asset-a'))
      .filter(row => row.action === 'old_content_undone')).toHaveLength(1);
    const items = await timeline.listAbilityAssetTimeline(uid, 'asset-a');
    expect(items.some(item => item.kind === 'old_content_applied')).toBe(true);
    expect(items.some(item => item.kind === 'old_content_undone')).toBe(true);
  });

  it('stops execution when an asset baseline changed', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    await assets.updateAbilityAsset(uid, 'asset-b', { statement: '报告提交前写结论与负责人。',
      actor: 'user', reason: 'Synthetic concurrent edit' });
    const result = await service.executeOldContentPlan(uid, plan.id);
    expect(result.results).toEqual([{ unitId: 'old-1', status: 'failed',
      code: expect.stringContaining('baseline_changed') }]);
    expect(result.plan.status).toBe('ready');
    expect((await assets.readAbilityAsset(uid, 'asset-a')).status).toBe('active');
    expect((await assets.readAbilityAsset(uid, 'asset-b')).status).toBe('active');
  });

  it('removes the personal profile projection when cleanup archives a personal asset', async () => {
    await seed('asset-personal', '我偏好先写结论，再补依据。', { type: 'personal' });
    await seed('asset-rule', '报告提交前核对来源。');
    const store = await import('../../../../src/main/features/recall/store');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const { createHash } = await import('node:crypto');
    const projectionId = `profile-${createHash('sha256').update('asset-personal').digest('hex').slice(0, 24)}`;
    const at = new Date().toISOString();
    await store.writeRecallJsonRecord(uid, 'personal-profile-projections', projectionId, {
      schemaVersion: 2, projectionVersion: 2, ownerId: uid, id: projectionId,
      assetId: 'asset-personal', assetVersion: '1', inputFingerprint: 'synthetic',
      catalogFingerprint: 'synthetic', status: 'applied', createdAt: at, updatedAt: at,
    });
    const plan = await service.bindOldContentPlan(uid, 'cand-personal', {
      schemaVersion: 1, status: 'ready', assetIds: ['asset-personal', 'asset-rule'],
      baselineVersions: { 'asset-personal': '1', 'asset-rule': '1' },
      items: [
        { itemId: 'old-1', action: 'archive', reasonCode: 'archive_obsolete',
          reason: '这条个人偏好已被新要求替代。', assetIds: ['asset-personal'],
          expectedVersions: { 'asset-personal': '1' } },
        { itemId: 'old-2', action: 'keep', reasonCode: 'keep_independent',
          reason: '报告规则与本条无关。', assetIds: ['asset-rule'],
          expectedVersions: { 'asset-rule': '1' } },
      ],
      unresolved: [],
    });
    const result = await service.executeOldContentPlan(uid, plan.id);
    expect(result.plan.status).toBe('applied');
    expect((await store.readRecallJsonRecord(uid, 'personal-profile-projections', projectionId))?.status)
      .toBe('removed');
  });

  it('clears the merge target when undo restores a paused source', async () => {
    await seed('asset-a', '报告提交前核对来源。');
    await seed('asset-b', '报告提交前写结论。', { status: 'paused' });
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const undo = await import('../../../../src/main/features/recall/old-content-undo');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    await service.executeOldContentPlan(uid, plan.id);
    expect(await assets.readAbilityAsset(uid, 'asset-b')).toMatchObject({ status: 'archived',
      mergedIntoAssetId: 'asset-a' });
    const preview = await undo.previewOldContentUndo(uid, plan.id);
    await undo.undoOldContentPlan(uid, plan.id, preview.token);
    expect(await assets.readAbilityAsset(uid, 'asset-b')).toMatchObject({ status: 'paused' });
    expect((await assets.readAbilityAsset(uid, 'asset-b')).mergedIntoAssetId).toBeUndefined();
  });

  it('recovers a plan left executing by a crash before the receipt was written', async () => {
    await seed('asset-a', '报告提交前核对来源。'); await seed('asset-b', '报告提交前写结论。');
    const service = await import('../../../../src/main/features/recall/old-content-plan-service');
    const plan = await service.bindOldContentPlan(uid, 'cand-a', legacyPlan());
    const applied = await service.executeOldContentPlan(uid, plan.id);
    const execution = applied.execution!;
    expect(execution.snapshot).toBeDefined();
    const current = await service.readOldContentPlan(uid, plan.id);
    await service.saveOldContentPlan(uid, { ...current, status: 'executing', executions: [],
      prepared: {
        executionId: execution.executionId, digest: execution.digest, decisionId: execution.decisionId,
        ...(execution.candidateId ? { candidateId: execution.candidateId } : {}),
        before: execution.snapshot!.before, after: execution.snapshot!.after,
        receiptItems: execution.items, anchorId: 'asset-a', preparedAt: new Date().toISOString(),
      } });
    const listed = await service.listActionableOldContentPlans(uid);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: plan.id, status: 'applied', executedCount: 1 });
    const recovered = await service.readOldContentPlan(uid, plan.id);
    expect(recovered.status).toBe('applied');
    expect(recovered.executions).toHaveLength(1);
  });
});
