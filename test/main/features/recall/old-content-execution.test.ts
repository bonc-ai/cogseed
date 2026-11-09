import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import type { FormationOldContentPlan } from '../../../../src/main/features/recall/formation-old-content';

const uid = 'synthetic-old-content-user';
let root: string, previous: string | undefined;
beforeEach(async () => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'old-content-execution-'));
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
async function seed(id: string, patch: Record<string, unknown> = {}) {
  const store = await import('../../../../src/main/features/recall/store');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const at = new Date().toISOString();
  const record = { schemaVersion: 1, ownerId: uid, id, candidateId: 'seed-candidate', reviewDecisionId: 'rd_syntheticseed',
    type: 'rule', title: id === 'source-a' ? '报告来源要求' : '报告结论要求',
    statement: id === 'source-a' ? '提交报告前核对来源。' : '提交报告前写结论与下一步。',
    evidenceRefs: [], origin: 'manual', scope: 'report', status: 'active',
    lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1',
    createdAt: at, updatedAt: at, ...patch } as any;
  await store.writeRecallJsonRecord(uid, 'ability-assets', id, record);
  await assets.initializeAbilityAsset(uid, record, { actor: 'user', reason: 'Synthetic seed' });
  return record;
}
function plan(overrides: Partial<FormationOldContentPlan> = {}): FormationOldContentPlan {
  return {
    schemaVersion: 1, status: 'ready', assetIds: ['source-a', 'source-b'],
    baselineVersions: { 'source-a': '1', 'source-b': '1' },
    items: [{ itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '两条要求共同约束报告提交。',
      assetIds: ['source-a', 'source-b'], targetAssetId: 'source-a', expectedVersions: { 'source-a': '1', 'source-b': '1' },
      merged: { statement: '提交报告前核对来源，并写结论与下一步。', applicableWhen: ['正式报告'],
        evidenceAssetIds: ['source-a', 'source-b'] } }],
    unresolved: [], ...overrides,
  };
}
async function candidate(planValue = plan()) {
  return createNightlyCandidateFixture(uid, {
    judgment: '提交报告前核对来源，并写结论与下一步。', value: '避免报告遗漏来源和后续行动。', summary: '报告提交要求',
    suggestedType: 'rule', suggestedScope: 'report', suggestedAction: 'create', risk: 'medium',
    sourceRefs: [], rawStatement: true, oldContentPlan: planValue,
  });
}

describe('old-content plan execution', () => {
  it('merges the target in place, archives sources, keeps independent entries and records one receipt', async () => {
    await seed('source-a'); await seed('source-b'); await seed('source-c', {
      type: 'cognition', title: '离线草稿规则', statement: '离线草稿不进入正式流程。', scope: 'report' });
    const withKeep = plan();
    withKeep.assetIds.push('source-c');
    withKeep.baselineVersions['source-c'] = '1';
    withKeep.items.push({ itemId: 'old-2', action: 'keep', reasonCode: 'keep_independent',
      reason: '离线草稿用于另一场景。', assetIds: ['source-c'], expectedVersions: { 'source-c': '1' } });
    const row = await candidate(withKeep);
    const execution = await import('../../../../src/main/features/recall/old-content-execution');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const result = await execution.confirmOldContentPlan(uid, row.id);
    expect(result.receipt).toMatchObject({ planDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      items: [{ itemId: 'old-1', status: 'applied', targetAssetId: 'source-a', targetVersion: '2',
        archivedIds: ['source-b'] }, { itemId: 'old-2', status: 'kept', assetIds: ['source-c'] }] });
    expect(await assets.readAbilityAsset(uid, 'source-a')).toMatchObject({
      statement: '提交报告前核对来源，并写结论与下一步。', version: '2', activeVersion: '2', status: 'active' });
    expect(await assets.readAbilityAsset(uid, 'source-b')).toMatchObject({
      status: 'archived', mergedIntoAssetId: 'source-a', statement: '提交报告前写结论与下一步。' });
    expect(await assets.readAbilityAsset(uid, 'source-c')).toMatchObject({ status: 'active', version: '1' });
    const repeated = await execution.confirmOldContentPlan(uid, row.id);
    expect(repeated.duplicate).toBe(true);
    expect((await assets.readAbilityAsset(uid, 'source-a')).version).toBe('2');
  });

  it('refuses a delete with a live reference and leaves every asset unchanged', async () => {
    await seed('source-a', { relations: [{ kind: 'related_to', assetId: 'source-b' }] });
    await seed('source-b');
    const deletePlan = plan({ items: [
      { itemId: 'old-1', action: 'keep', reasonCode: 'keep_independent', reason: '保留来源规则。',
        assetIds: ['source-a'], expectedVersions: { 'source-a': '1' } },
      { itemId: 'old-2', action: 'delete', reasonCode: 'delete_unsuitable', reason: '无效测试内容。',
        assetIds: ['source-b'], expectedVersions: { 'source-b': '1' } },
    ] });
    const row = await candidate(deletePlan);
    const execution = await import('../../../../src/main/features/recall/old-content-execution');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await expect(execution.confirmOldContentPlan(uid, row.id)).rejects.toThrow('referenced');
    expect((await assets.readAbilityAsset(uid, 'source-a')).status).toBe('active');
    expect((await assets.readAbilityAsset(uid, 'source-b')).status).toBe('active');
  });

  it('keeps the ready plan ahead of new-content promotion and blocks the legacy related merge path', async () => {
    await seed('source-a'); await seed('source-b');
    const row = await candidate();
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(candidates.promoteRecallCandidate(uid, row.id, { actor: 'user' }))
      .rejects.toThrow('old-content plan must be committed');
    await expect(candidates.resolveRelatedFormationCandidate(uid, row.id, { action: 'keep' }))
      .rejects.toMatchObject({ code: 'recall_candidate_old_content_plan' });
    expect((await candidates.readRecallCandidate(uid, row.id)).status).toBe('pending_review');
  });

  it('rejects a changed baseline before writing and does not mint a partial receipt', async () => {
    await seed('source-a'); await seed('source-b');
    const row = await candidate();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.updateAbilityAsset(uid, 'source-b', { statement: '提交报告前写结论、下一步与负责人。',
      actor: 'user', reason: 'Synthetic concurrent edit' });
    const execution = await import('../../../../src/main/features/recall/old-content-execution');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(execution.confirmOldContentPlan(uid, row.id)).rejects.toThrow('baseline_changed');
    expect((await assets.readAbilityAsset(uid, 'source-a')).status).toBe('active');
    expect((await assets.readAbilityAsset(uid, 'source-b')).status).toBe('active');
    expect((await candidates.readRecallCandidate(uid, row.id)).oldContentReceipt).toBeUndefined();
  });
});
