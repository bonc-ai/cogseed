import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
let root: string, previous: string | undefined;
beforeEach(() => { vi.resetModules(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-proof-version-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const candidate = await createNightlyCandidateFixture('user-a', { judgment: '先保存问题证据，再给出尚待验证的诊断。', value: '用于复核诊断依据。', summary: '诊断依据保存方法', suggestedType: 'cognition', contentCategory: 'method', suggestedScope: 'general' });
  const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
  const projections = await import('../../../../src/main/features/recall/context-projection');
  const projection = await projections.previewContextProjection('user-a', { taskRunId: 'proof-task', taskText: '根据证据诊断', purpose: 'general', authorization: 'user_confirmed', confirm: true, explicitAssetIds: [asset.id] });
  const proofs = await import('../../../../src/main/features/recall/proof-service');
  const prepared = await proofs.prepareTransferProof('user-a', { projectionId: projection.id, executionId: 'proof-execution', expectedResultSnapshot: '留下诊断依据' });
  const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
  const receipt = await receipts.prepareReceipt('user-a', { executionId: 'proof-receipt', targetSessionId: 'isolated-proof-session', reusedRefs: [`asset:${asset.id}@v1`], omittedRefs: [], permissionMode: 'read-only', allowedScopes: ['cognition:inherited'], boundary: 'real' }, { sessionId: 'isolated-proof-session' });
  const complete = () => proofs.completeTransferProofWithReceipt('user-a', prepared.id, { status: 'succeeded', receiptExecutionId: receipt.executionId, observedTransfer: '本轮真实加载v1' });
  const update = () => assets.updateAbilityAsset('user-a', asset.id, { statement: '先列出候选原因，再保存能区分原因的证据。', expectedVersion: '1', expectedActiveVersion: '1', actor: 'user', reason: '用户实际修改认识' });
  return { assets, candidates, candidate, asset, projection, proofs, prepared, receipts, complete, update };
}

describe('版本绑定的迁移与效果生命周期', () => {
  it('v1真实回执迟到仍保历史，不给已经v2的认识升迁移档', async () => {
    const f = await fixture(); await f.update();
    expect((await f.complete()).status).toBe('succeeded');
    expect(await f.assets.readAbilityAsset('user-a', f.asset.id)).toMatchObject({ version: '2', maturity: 'bud' });
    expect((await f.proofs.listTransferProofs('user-a'))[0].assetVersions).toEqual([{ assetId: f.asset.id, version: '1' }]);
  });

  it.each(['better', 'worse'] as const)('v1的%s效果历史不更新v2成熟度或成败计数', async outcome => {
    const f = await fixture(); await f.update(); await f.complete();
    const before = await f.assets.readAbilityAsset('user-a', f.asset.id);
    const record = await f.proofs.evaluateEffectivenessProof('user-a', { transferProofId: f.prepared.id, outcome, observedResult: '对v1的可追溯结果评价', evidenceRefs: [{ kind: 'artifact', id: 'comparison-artifact' }] });
    // Positive feedback without a traceable baseline comparison is recorded as
    // insufficient evidence instead of claiming effectiveness; other outcomes
    // keep their explicit value.
    expect(record.outcome).toBe(outcome === 'better' ? 'insufficient_evidence' : outcome);
    expect(record.reportedOutcome).toBe(outcome === 'better' ? 'better' : undefined);
    const after = await f.assets.readAbilityAsset('user-a', f.asset.id);
    expect(after).toMatchObject({ version: '2', maturity: 'bud', status: 'active' });
    expect(after.validationCount || 0).toBe(before.validationCount || 0);
    expect(after.consecutiveFailures || 0).toBe(before.consecutiveFailures || 0);
  });

  it('准备迟到迁移证明仍绑定投影实际冻结v1，不改贴当前v2标签', async () => {
    const f = await fixture(); await f.update();
    const prepared = await f.proofs.prepareTransferProof('user-a', { projectionId: f.projection.id, executionId: 'late-preparation', expectedResultSnapshot: '读取冻结投影的v1' });
    expect(prepared.assetVersions).toEqual([{ assetId: f.asset.id, version: '1' }]);
  });

  it('三个独立旧v1负结果及启动重放不暂停v2、不增加当前成败计数', async () => {
    const f = await fixture(); await f.update();
    const validation = await import('../../../../src/main/features/recall/validation-service');
    for (const taskRunId of ['old-negative-1', 'old-negative-2', 'old-negative-3']) {
      expect(await validation.recordValidation('user-a', { assetId: f.asset.id, candidateId: f.candidate.id, assetVersion: '1', taskRunId, outcome: 'failure', evidenceRefs: [] })).toMatchObject({ assetVersion: '1', outcome: 'failure' });
    }
    await validation.recoverValidationApplications('user-a');
    expect(await validation.listValidationRecords('user-a')).toHaveLength(3);
    const current = await f.assets.readAbilityAsset('user-a', f.asset.id);
    expect(current).toMatchObject({ version: '2', status: 'active', maturity: 'bud' });
    expect(current.consecutiveFailures || 0).toBe(0); expect(current.validationCount || 0).toBe(0);
    expect(current.appliedValidationIds || []).toEqual([]);
    expect((await f.candidates.readRecallCandidate('user-a', f.candidate.id)).consecutiveFailures || 0).toBe(0);
  });

  it.each(['maturity', 'counter', 'ledger'] as const)('真实owner写锁排队期间发生正文换版，%s在锁内读新head并拒旧版作用', async kind => {
    const f = await fixture();
    const { withCognitionTransition } = await import('../../../../src/main/features/cognition_bridge');
    let held!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const updating = withCognitionTransition('user-a', async () => { held(); await proceed; await f.update(); });
    await ready;
    const validation = await import('../../../../src/main/features/recall/validation-service');
    const pending = kind === 'maturity' ? f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '1')
      : kind === 'counter' ? f.assets.recordAbilityAssetValidation('user-a', f.asset.id, 'failure', 'old-race-validation', '1')
      : validation.recordValidation('user-a', { assetId: f.asset.id, candidateId: f.candidate.id, assetVersion: '1', taskRunId: 'race-task', outcome: 'success', evidenceRefs: [] });
    release(); await updating; await pending;
    const current = await f.assets.readAbilityAsset('user-a', f.asset.id);
    expect(current).toMatchObject({ version: '2', maturity: 'bud', status: 'active' });
    expect(current.validationCount || 0).toBe(0); expect(current.consecutiveFailures || 0).toBe(0);
    expect(current.appliedValidationIds || []).toEqual([]);
  });

  it('历史未知版本validation可以读但不得在恢复时冒认current版本', async () => {
    const f = await fixture();
    const store = await import('../../../../src/main/features/recall/store');
    await store.writeRecallJsonRecord('user-a', 'validation-records', 'legacy-unbound-observation', { schemaVersion: 1, ownerId: 'user-a', id: 'legacy-unbound-observation', assetId: f.asset.id, candidateId: f.candidate.id, taskRunId: 'legacy-task', outcome: 'failure', evidenceRefs: [], createdAt: new Date().toISOString() });
    const validation = await import('../../../../src/main/features/recall/validation-service');
    await validation.recoverValidationApplications('user-a');
    expect(await validation.listValidationRecords('user-a')).toHaveLength(1);
    expect((await f.assets.readAbilityAsset('user-a', f.asset.id)).consecutiveFailures || 0).toBe(0);
  });


  it.each(['body', 'applicable', 'forbidden', 'scope', 'permissions'] as const)('已有v1效果证明后实质%s变化，新版清为未证明且旧账不删', async change => {
    const f = await fixture(); await f.complete();
    // Simulate a v1 effectiveness proof's persisted outcome: maturity is bumped
    // and the validation ledger records one applied v1 validation.
    await f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '1');
    await f.assets.recordAbilityAssetValidation('user-a', f.asset.id, 'success', 'old-v1-proof', '1');
    // Keep the persisted v1 effectiveness ledger; content edits must not delete it.
    const store = await import('../../../../src/main/features/recall/store');
    await store.writeRecallJsonRecord('user-a', 'effectiveness-proofs', 'ep-old-v1', {
      schemaVersion: 1, ownerId: 'user-a', id: 'ep-old-v1', transferProofId: f.prepared.id,
      outcome: 'better', status: 'valid', observedResult: 'v1 的可比结果更好', evidenceRefs: [],
      createdAt: new Date().toISOString(),
    });
    expect(await f.assets.readAbilityAsset('user-a', f.asset.id)).toMatchObject({ maturity: 'effectiveness_validated', validationCount: 1 });
    const oldSnapshot = await f.assets.readAbilityAssetVersionSnapshot('user-a', f.asset.id, '1');
    const patch = change === 'body' ? { statement: '先比较候选原因，再记录区分证据。' } : change === 'applicable' ? { applicableWhen: ['生产故障'] }
      : change === 'forbidden' ? { forbiddenWhen: ['无来源数据'] } : change === 'scope' ? { scope: 'review' }
      : { scopePolicy: { projectIds: ['project-a'] } };
    const updated = await f.assets.updateAbilityAsset('user-a', f.asset.id, { ...patch, actor: 'user', reason: '明确修改完整认识', expectedVersion: '1', expectedActiveVersion: '1' });
    expect(updated).toMatchObject({ version: '2', maturity: 'bud', validationCount: 0, consecutiveFailures: 0, lifecycleStatus: 'user_confirmed_unverified' });
    expect(updated.lastValidatedAt).toBeUndefined(); expect(updated.appliedValidationIds).toHaveLength(1);
    expect(await f.assets.readAbilityAssetVersionSnapshot('user-a', f.asset.id, '1')).toEqual(oldSnapshot);
    expect(await f.proofs.listEffectivenessProofs('user-a')).toEqual([expect.objectContaining({ outcome: 'better' })]);
  });

  it.each(['title', 'tags', 'category'] as const)('纯%s调整保留同一完整认识的已有成熟度', async kind => {
    const f = await fixture(); await f.complete();
    await f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '1');
    await f.assets.recordAbilityAssetValidation('user-a', f.asset.id, 'success', 'old-v1-proof', '1');
    const patch = kind === 'title' ? { title: '诊断证据记录的新标题' } : kind === 'tags' ? { tags: ['故障诊断'] } : { contentCategory: 'rule' as const };
    expect(await f.assets.updateAbilityAsset('user-a', f.asset.id, { ...patch, actor: 'user', reason: '仅整理可见元数据', expectedVersion: '1', expectedActiveVersion: '1' })).toMatchObject({ maturity: 'effectiveness_validated', validationCount: 1 });
  });

  it('候选联合提交改新正文也重置版本成败和成熟度', async () => {
    const f = await fixture(); await f.complete();
    await f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '1');
    await f.assets.recordAbilityAssetValidation('user-a', f.asset.id, 'success', 'old-v1-proof', '1');
    const next = await createNightlyCandidateFixture('user-a', { judgment: '诊断时先列候选原因，再寻找低成本区分证据。', value: '帮助分清原因。', summary: '故障原因区分方法', suggestedType: 'cognition', contentCategory: 'method', suggestedScope: 'general', suggestedAction: 'update', targetAssetId: f.asset.id, targetVersionUsed: '1' });
    const promoted = await f.candidates.promoteRecallCandidate('user-a', next.id, { actor: 'user' });
    expect(promoted.asset).toMatchObject({ id: f.asset.id, version: '2', maturity: 'bud', validationCount: 0, consecutiveFailures: 0 });
  });

  it('回滚与历史选用改变实际正文时不沿用另一个版本的效果', async () => {
    const f = await fixture(); await f.update();
    await f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '2');
    const selected = await f.assets.selectAbilityAssetVersion('user-a', f.asset.id, '1', { actor: 'user', reason: '明确选用旧正文' });
    expect(selected).toMatchObject({ version: '2', activeVersion: '1', maturity: 'bud', validationCount: 0 });
    await f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '2');
    expect((await f.assets.readAbilityAsset('user-a', f.asset.id)).maturity).toBe('bud');
    await f.assets.updateAbilityAsset('user-a', f.asset.id, { statement: '第三版：对假设分别设计一个可以否证的检查。', actor: 'user', reason: '实际保存第三版内容', expectedVersion: '2', expectedActiveVersion: '1' });
    await f.assets.setAbilityAssetMaturity('user-a', f.asset.id, 'effectiveness_validated', '3');
    const reverted = await f.assets.rollbackAbilityAsset('user-a', f.asset.id, '1', { actor: 'user', reason: '生成新的回滚内容版本' });
    expect(reverted).toMatchObject({ version: '4', activeVersion: '4', maturity: 'bud', validationCount: 0, consecutiveFailures: 0 });
  });


  it('自动来源的seed改正文仍是seed，不借新内容伪称人工确认', async () => {
    const f = await fixture();
    const { seedStoredAbilityAsset } = await import('../../../helpers/stored-ability-asset');
    const seeded = await seedStoredAbilityAsset('user-a', { ...f.asset, id: 'automatic-seed-source', lifecycleStatus: 'automatically_extracted_unverified', maturity: 'seed' }, '明确隔离自动来源seed结构fixture');
    const changed = await f.assets.updateAbilityAsset('user-a', seeded.id, { statement: '修改自动来源的待验证方法正文。', actor: 'ai', reason: '合法AI编辑自动来源seed，内容仍待验证', expectedVersion: '1', expectedActiveVersion: '1' });
    expect(changed).toMatchObject({ version: '2', maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified', validationCount: 0, consecutiveFailures: 0 });
  });


  it.each(['negative', 'rework'] as const)('生产%s反馈入口保留旧v1效果历史，不给v2写建议或建议审计', async feedbackKind => {
    const f = await fixture(); await f.update(); await f.complete();
    const beforeAudit = await f.assets.listAbilityAssetAudit('user-a', f.asset.id);
    const feedback = await import('../../../../src/main/features/recall/effectiveness-feedback');
    const record = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: f.prepared.id, feedback: feedbackKind, note: '这是对已经加载的旧v1的负面评价' });
    expect(record.outcome).toBe(feedbackKind === 'negative' ? 'worse' : 'rework');
    const current = await f.assets.readAbilityAsset('user-a', f.asset.id);
    expect(current.version).toBe('2'); expect(current.recommendedAction).toBeUndefined();
    expect(current.recommendationReason).toBeUndefined(); expect(current.recommendationAt).toBeUndefined();
    expect(await f.assets.listAbilityAssetAudit('user-a', f.asset.id)).toEqual(beforeAudit);
  });


  it('同版负面建议有效，实质换正文清当前建议但不删除v1反馈和审计', async () => {
    const f = await fixture(); await f.complete();
    const feedback = await import('../../../../src/main/features/recall/effectiveness-feedback');
    const record = await feedback.recordEffectivenessFeedback('user-a', { transferProofId: f.prepared.id, feedback: 'negative', note: 'v1实际结果更差，建议暂停' });
    expect(await f.assets.readAbilityAsset('user-a', f.asset.id)).toMatchObject({ version: '1', recommendedAction: 'pause', recommendationReason: 'v1实际结果更差，建议暂停' });
    const audit = await f.assets.listAbilityAssetAudit('user-a', f.asset.id);
    expect(audit).toContainEqual(expect.objectContaining({ action: 'pause_recommended' }));
    const updated = await f.update();
    expect(updated).toMatchObject({ version: '2', maturity: 'bud' });
    expect(updated.recommendedAction).toBeUndefined(); expect(updated.recommendationReason).toBeUndefined(); expect(updated.recommendationAt).toBeUndefined();
    expect(await f.proofs.listEffectivenessProofs('user-a')).toContainEqual(expect.objectContaining({ id: record.id, outcome: 'worse' }));
    expect(await f.assets.listAbilityAssetAudit('user-a', f.asset.id)).toContainEqual(expect.objectContaining({ action: 'pause_recommended' }));
  });

  it('建议ownerlock排队时先发生v2正文更新，不写旧v1推荐或审计', async () => {
    const f = await fixture();
    const { withCognitionTransition } = await import('../../../../src/main/features/cognition_bridge');
    let held!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { held = resolve; }); const proceed = new Promise<void>(resolve => { release = resolve; });
    const updating = withCognitionTransition('user-a', async () => { held(); await proceed; await f.update(); });
    await ready;
    const pending = f.assets.recommendAbilityAssetAction('user-a', f.asset.id, { actor: 'system', action: 'pause', reason: '旧v1迟到建议', expectedVersion: '1' });
    release(); await updating; await pending;
    expect((await f.assets.readAbilityAsset('user-a', f.asset.id)).recommendedAction).toBeUndefined();
    expect((await f.assets.listAbilityAssetAudit('user-a', f.asset.id)).some(row => row.action === 'pause_recommended')).toBe(false);
  });

});
