import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import type { SaveRecallCandidateInput } from '../../../../src/main/features/recall/candidate-service';
const run = vi.hoisted(() => vi.fn());
const schedule = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: run }));
function supportedBody(input: { message: string }) {
  const payload = JSON.parse(input.message);
  const source = payload.approvedUserSources[0];
  return { supported: true, noUnsupportedClaims: true, scopePreserved: true,
    finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label: source.label, quote: source.approvedQuotes[0] }] };
}
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {}, scheduleBootBackground: schedule }));
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({ suggestAbilityAssetTitle: async () => ({ title: '回答结构偏好' }) }));
vi.mock('../../../../src/main/features/kb_embed', () => ({ closeEmbedder: vi.fn(), embedQuery: async () => { throw new Error('optional embedding unavailable'); } }));
let root: string, previous: string | undefined;
beforeEach(() => {
  vi.resetModules();
  schedule.mockReset().mockImplementation(() => ({ cancel: vi.fn(), promise: Promise.resolve() }));
  run.mockReset().mockImplementation(async (_userId: string, input: { message: string }) => ({
    result: { text: JSON.stringify(supportedBody(input)), meta: {} },
  }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-auto-policy-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(async () => { await drainMainRuntimeForTest('alice'); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function fixture(input: Partial<SaveRecallCandidateInput> = {}, enabled = true) {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const store = await import('../../../../src/main/features/recall/store');
  const policy = await import('../../../../src/main/features/recall/nightly-automatic-approval');
  if (enabled) await settings.updateRecallCaptureSettings('alice', { autoApproval: true });
  const candidate = await createNightlyCandidateFixture('alice', { judgment: '以后回答时先给出结论，再说明关键理由和依据。', value: '长期沿用这个表达偏好可以提高沟通效率。', summary: '回答结构偏好', suggestedType: 'personal', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [], rawStatement: true, ...input });
  const { invalidateConversationCaches } = await import('../../../../src/main/features/chats');
  invalidateConversationCaches('alice'); // Fixtures write source bytes directly rather than through chat creation.
  const authorization = settings.captureAutoApprovalAuthorization(await settings.readRecallCaptureSettings('alice'));
  await store.updateRecallJsonRecord('alice', 'captures', candidate.captureProvenance!.captureId, current => ({ ...current!, ...authorization }));
  return { settings, store, policy, candidate };
}
describe('explicit nightly automatic confirmation', () => {
  it('keeps a concurrent user edit free of an older held review and clears a previous observation on edit', async () => {
    const f = await fixture({ risk: 'medium' });
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const held = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(held.candidate.autoReview?.eligible).toBe(false);
    const originalUpdate = f.store.updateRecallJsonRecord;
    let injectEdit = true;
    const intercepted = vi.spyOn(f.store, 'updateRecallJsonRecord').mockImplementation(async (...args) => {
      if (injectEdit && args[1] === 'candidates' && args[2] === f.candidate.id) {
        injectEdit = false;
        await candidates.updateRecallCandidate('alice', f.candidate.id, {
          ...held.candidate, judgment: '以后技术解释先列观察证据，再说明结论。',
        });
      }
      return originalUpdate(...args);
    });
    try {
      const saved = await candidates.recordRecallCandidateAutomaticHold('alice', held.candidate, held.candidate.autoReview!);
      expect(saved.judgment).toBe('以后技术解释先列观察证据，再说明结论。');
      expect(saved.userModifiedAt).toBeTruthy();
      expect(saved.autoReview).toBeUndefined();
      expect((await candidates.readRecallCandidate('alice', f.candidate.id)).autoReview).toBeUndefined();
    } finally { intercepted.mockRestore(); }
  });
  it.each([false, true])('stops an active sweep during automatic support (model honors cancellation: %s)', async honorsCancellation => {
    const f = await fixture();
    const capture = await import('../../../../src/main/features/recall/capture-service');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let modelSignal: AbortSignal | undefined;
    run.mockImplementation(async (_uid: string, input: { message: string; signal?: AbortSignal }) => {
      modelSignal = input.signal; entered(); await waiting;
      if (honorsCancellation) input.signal?.throwIfAborted();
      return { result: { text: JSON.stringify(supportedBody(input)), meta: {} } };
    });
    schedule.mockImplementation((_label: string, work: (signal: AbortSignal) => Promise<void>) => {
      const controller = new AbortController();
      return { cancel: () => controller.abort(), promise: Promise.resolve().then(() => work(controller.signal)) };
    });
    await f.store.updateRecallJsonRecord('alice', 'captures', f.candidate.captureProvenance!.captureId, current => ({ ...current!, terminalRunId: 'fixture-manual-run' }));
    const pending = capture.runManualCaptureSweep('alice');
    await Promise.race([started, pending.then(() => { throw new Error('sweep ended before automatic support'); })]);
    expect(await capture.stopRecallCaptureSweep('alice')).toEqual({ stopped: true });
    expect(modelSignal?.aborted).toBe(true);
    release(); await pending;
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(await assets.listAbilityAssets('alice')).toHaveLength(0);
    expect(await candidates.readRecallCandidate('alice', f.candidate.id)).toMatchObject({ status: 'pending_review' });
    expect((await candidates.readRecallCandidate('alice', f.candidate.id)).autoReview).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    await capture.recoverRecallCaptures('alice');
    expect(run).toHaveBeenCalledTimes(1);
    expect(await assets.listAbilityAssets('alice')).toHaveLength(0);
  });
  it.each(['transition', 'asset-record', 'store'] as const)('cancels approval waiting for the %s lock after support was persisted', async lockKind => {
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    await bridge.replaceCognitionSources('alice', { mode: 'unified', revision: 1,
      records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
    const f = await fixture({ suggestedType: 'cognition' });
    expect((await f.policy.evaluateNightlyAutomaticApproval('alice', f.candidate)).eligible).toBe(true);
    const { fileEditLock } = await import('../../../../src/main/util/locks');
    const { userCognitionDir } = await import('../../../../src/main/paths');
    const { cognitionStorePath } = await import('../../../../src/main/features/cognition_kernel/store');
    const controller = new AbortController();
    let intercepted = false;
    const original = fileEditLock;
    const locks = await import('../../../../src/main/util/locks');
    const spy = vi.spyOn(locks, 'fileEditLock').mockImplementation((file: string) => {
      const lock = original(file);
      const target = lockKind === 'store' ? file === cognitionStorePath('alice')
        : lockKind === 'transition' ? file === path.join(userCognitionDir('alice'), 'cognition-transition')
          : file.includes(`${path.sep}ability-assets${path.sep}`) && file.endsWith('.json');
      if (target && !intercepted) {
        intercepted = true;
        const runExclusive = lock.runExclusive.bind(lock);
        vi.spyOn(lock, 'runExclusive').mockImplementation(async (...args) => {
          const release = await lock.acquire();
          const pending = runExclusive(...args);
          controller.abort(); release();
          return pending;
        });
      }
      return lock;
    });
    try {
      await expect(f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id, { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(intercepted).toBe(true);
      const assets = await import('../../../../src/main/features/recall/asset-service');
      const candidates = await import('../../../../src/main/features/recall/candidate-service');
      expect(await assets.listAbilityAssets('alice')).toHaveLength(0);
      expect(await candidates.readRecallCandidate('alice', f.candidate.id)).toMatchObject({ status: 'pending_review' });
      expect(run).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); vi.restoreAllMocks(); }
  });
  it('finishes the durable joint commit after cancellation and recovers without new approval', async () => {
    run.mockImplementation(async (_uid: string, input: { message: string }) => {
      const checks = supportedBody(input);
      return { result: { text: JSON.stringify({ ...checks, sourceRuleConclusions: [{ recordId: 'answer-rule', status: 'resolved',
        expectedContract: { strength: 'default', condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' },
        topicEvidence: checks.evidence, fieldEvidence: { strength: checks.evidence, condition: checks.evidence, effect: [], exception: [] } }] }), meta: {} } };
    });
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    await bridge.replaceCognitionSources('alice', { mode: 'unified', revision: 1,
      records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
    const ontology = await import('../../../../src/main/features/cognition/ontology/service');
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    await ontology.commitOntologyCommand('alice', { commandId: 'seed-personal', expectedRevision: 0,
      actions: [{ intent: 'create', recordId: 'personal', sourceLabel: 'Synthetic structure', record: { kind: 'module', name: 'Personal', description: '', scope: { kind: 'personal' } } }] });
    const judgment = '以后回答时先给出结论，再说明关键理由和依据。';
    const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument('alice'), 'initial', {
      reason: 'Preserve the answer preference as a shared rule.', evidence: ['m1'],
      refs: [{ moduleId: 'personal', recordId: 'answer-rule', versionPolicy: 'current', sharedBody: true }],
      actions: [{ intent: 'create', recordId: 'answer-rule', sourceLabel: 'Synthetic preference',
        record: { kind: 'rule', moduleId: 'personal', name: 'Answer preference', requirement: judgment, strength: 'default',
          condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' } }] }, judgment);
    const f = await fixture({ ontologyFormation: plan });
    const persist = bridge.persistCognitionSource;
    const controller = new AbortController();
    const spy = vi.spyOn(bridge, 'persistCognitionSource').mockImplementation(async (...args) => {
      await persist(...args);
      if (args[1] === 'ability-assets') controller.abort();
    });
    try {
      const result = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id, { signal: controller.signal });
      expect(controller.signal.aborted).toBe(true);
      expect(result).toMatchObject({ approved: true, candidate: { status: 'confirmed', promotedAssetId: result.asset!.id } });
      expect(ontology.readOntologyDocument('alice').records['answer-rule']).toMatchObject({ status: 'active', requirement: result.asset!.statement });
      const { readRecallAssetHandoffReceipt } = await import('../../../../src/main/features/recall/candidate-service');
      expect(await readRecallAssetHandoffReceipt('alice', f.candidate.id, result.candidate.reviewDecisionId!))
        .toMatchObject({ assetId: result.asset!.id, version: result.asset!.version, reviewDecisionId: result.candidate.reviewDecisionId });
      expect(Object.values(ontology.readOntologyDocument('alice').receipts).some(receipt => receipt.changedIds.includes('answer-rule'))).toBe(true);
      const capture = await import('../../../../src/main/features/recall/capture-service');
      const { captureBudgetWindowKey } = await import('../../../../src/main/features/recall/capture-model-budget');
      const settings = await f.settings.readRecallCaptureSettings('alice');
      await f.store.updateRecallJsonRecord('alice', 'capture-sweep', 'nightly', () => ({ schemaVersion: 1, ownerId: 'alice', id: 'nightly',
        baselineAt: new Date().toISOString(), cursors: {}, heldWindow: captureBudgetWindowKey(new Date(), settings.nightlyStart) }));
      await capture.recoverRecallCaptures('alice');
      expect((await capture.readRecallCapture('alice', f.candidate.captureProvenance!.captureId)).status).toBe('completed');
      expect(run).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
  it('keeps boot recovery model-free even when a pending candidate is eligible', async () => {
    const f = await fixture();
    const capture = await import('../../../../src/main/features/recall/capture-service');
    await capture.recoverRecallCaptures('alice');
    expect(run).not.toHaveBeenCalled();
    const { readRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    expect((await readRecallCandidate('alice', f.candidate.id)).status).toBe('pending_review');
  });
  it('retains a supported preference with system audit and unverified effectiveness, and remains idempotent', async () => {
    const f = await fixture();
    const result = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ approved: true, candidate: { status: 'confirmed', autoReview: { eligible: true } }, asset: { lifecycleStatus: 'automatically_extracted_unverified', maturity: 'bud', version: '1' } });
    expect(result.candidate.validationCount || 0).toBe(0);
    const { readReviewDecision } = await import('../../../../src/main/features/cognition/review-decision');
    expect(await readReviewDecision('alice', `recall_candidate:${f.candidate.id}`, result.candidate.reviewDecisionId)).toMatchObject({ actor: 'system', decision: 'automatic low-risk approval' });
    expect((await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).approved).toBe(false);
    const { listAbilityAssets, revokeAbilityAsset } = await import('../../../../src/main/features/recall/asset-service');
    expect(await listAbilityAssets('alice')).toHaveLength(1);
    await revokeAbilityAsset('alice', result.asset!.id, { actor: 'user', reason: '撤销自动确认测试认知' });
    expect((await listAbilityAssets('alice'))[0].status).toBe('revoked');
  });
  it('does not approve when disabled or retroactively grant an older extraction', async () => {
    const f = await fixture({}, false);
    expect((await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('automatic_confirmation_disabled');
    await f.settings.updateRecallCaptureSettings('alice', { autoApproval: true });
    expect((await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('automatic_confirmation_grant_expired');
  });
  it('revokes old candidates when disabled and enabled again', async () => {
    const f = await fixture();
    const first = await f.settings.readRecallCaptureSettings('alice');
    await f.settings.updateRecallCaptureSettings('alice', { autoApproval: false });
    const next = await f.settings.updateRecallCaptureSettings('alice', { autoApproval: true });
    expect(next.autoApprovalEpoch).not.toBe(first.autoApprovalEpoch);
    expect((await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('automatic_confirmation_grant_expired');
  });
  it.each([{ uncertainty: '长期偏好尚未明确' }, { risk: 'medium' as const }, { suggestedType: 'template' as const }])('holds incomplete, risky or structure candidates for review: %o', async input => {
    const f = await fixture(input);
    const result = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(result.approved).toBe(false); expect(result.candidate.status).toBe('pending_review'); expect(result.asset).toBeUndefined();
    expect(result.candidate.autoReview).toMatchObject({ eligible: false, reasons: result.reasons });
    const { readRecallCandidate } = await import('../../../../src/main/features/recall/candidate-service');
    expect((await readRecallCandidate('alice', f.candidate.id)).autoReview).toEqual(result.candidate.autoReview);
  });
  it('holds a conversation with unresolved questions', async () => {
    const f = await fixture();
    await f.store.updateRecallJsonRecord('alice', 'captures', f.candidate.captureProvenance!.captureId, current => {
      const summary = current!.contextSummary as any;
      return { ...current!, contextSummary: { ...summary, topics: summary.topics.map((topic: any) => ({ ...topic, unresolved: ['尚待确认范围'] })) } };
    });
    expect((await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('conversation_has_unresolved_questions');
  });
  it('fails closed when similarity infrastructure cannot compare another cognition', async () => {
    const f = await fixture();
    await createNightlyCandidateFixture('alice', { judgment: '后续报告应详细列出全部相关数据。', value: '便于报告核验。', summary: '报告信息完整度', suggestedType: 'personal', suggestedScope: 'general', sourceRefs: [], rawStatement: true });
    const result = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(result.reasons).toContain('semantic_conflict_check_unavailable'); expect(result.candidate.status).toBe('pending_review');
  });
  it('holds joint A/R changes when existing rules cannot be compared, just like independent ontology changes', async () => {
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    await bridge.replaceCognitionSources('alice', { mode: 'unified', revision: 1,
      records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
    const ontology = await import('../../../../src/main/features/cognition/ontology/service');
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    const body = '以后回答时先给出结论，再说明关键理由和依据。';
    const rule = { kind: 'rule', moduleId: 'personal', name: '回答偏好', requirement: body, strength: 'default',
      condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' };
    await ontology.commitOntologyCommand('alice', { commandId: 'seed-comparison', expectedRevision: 0, actions: [
      { intent: 'create', recordId: 'personal', sourceLabel: 'Existing structure', record: { kind: 'module', name: '我的本体', description: '', scope: { kind: 'personal' } } },
      { intent: 'create', recordId: 'old-answer-rule', sourceLabel: 'Existing approved preference', record: rule },
    ] });
    const plan = formation.parseOntologyFormationProposal(ontology.readOntologyDocument('alice'), 'proposed-joint', {
      reason: 'A duplicate rule must be compared even when jointly proposed.', evidence: ['m1'],
      refs: [{ moduleId: 'personal', recordId: 'new-answer-rule', versionPolicy: 'current', sharedBody: true }],
      actions: [{ intent: 'create', recordId: 'new-answer-rule', sourceLabel: 'Approved preference', record: rule }],
    }, body);
    const f = await fixture({ proposalTarget: 'joint', ontologyFormation: plan });
    const result = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain('ontology_semantic_comparison_unavailable');
    expect(ontology.readOntologyDocument('alice').records['new-answer-rule']).toBeUndefined();
  });
  it('holds revoked sources without creating an asset or marking the candidate failed', async () => {
    const f = await fixture();
    const { pauseCognitionSource } = await import('../../../../src/main/features/recall/source-control');
    await pauseCognitionSource('alice', f.candidate.sourceRefs[0]);
    const result = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(result.reasons).toContain('nightly_formation_or_sources_unavailable');
    expect(result.candidate.status).toBe('pending_review');
  });
  it('updates against a current baseline with version history, holding later stale proposals', async () => {
    const f = await fixture();
    const first = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(first.approved).toBe(true);
    const update = await fixture({ judgment: '以后回答时先给出结论，再说明关键理由和依据，并标出尚未验证的部分。',
      suggestedAction: 'update', targetAssetId: first.asset!.id, targetVersionUsed: '1' });
    const result = await update.policy.tryAutomaticallyApproveRecallCandidate('alice', update.candidate.id);
    expect(result.reasons).toEqual([]);
    expect(result).toMatchObject({ approved: true, asset: { id: first.asset!.id, version: '2' } });
    const { listAbilityAssetVersions } = await import('../../../../src/main/features/recall/asset-service');
    expect(await listAbilityAssetVersions('alice', first.asset!.id)).toHaveLength(2);
    const stale = await fixture({ judgment: '以后回答时先给出结论，再列出关键理由，保留全部推理细节。',
      suggestedAction: 'update', targetAssetId: first.asset!.id, targetVersionUsed: '1' });
    const held = await stale.policy.tryAutomaticallyApproveRecallCandidate('alice', stale.candidate.id);
    expect(held.reasons).toContain('update_baseline_conflict');
    expect(held.candidate.status).toBe('pending_review');
  });
  it.each([false, true])('restores the prior version after an automatic update as one reviewed inverse (joint: %s)', async joint => {
    if (joint) run.mockImplementation(async (_userId: string, input: { message: string }) => {
      const payload = JSON.parse(input.message);
      expect(payload.ruleSourceRequests).toEqual([expect.objectContaining({ recordId: 'answer-rule' })]);
      const checks = supportedBody(input);
      // Independent fixture conclusion, not a copy of proposed rule metadata.
      const sourceRuleConclusions = [{ recordId: 'answer-rule', status: 'resolved',
        expectedContract: { strength: 'default', condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' },
        topicEvidence: checks.evidence, fieldEvidence: { strength: checks.evidence, condition: checks.evidence, effect: [], exception: [] } }];
      return { result: { text: JSON.stringify({ ...checks, sourceRuleConclusions }), meta: {} } };
    });
    const bridge = await import('../../../../src/main/features/cognition_bridge');
    await bridge.replaceCognitionSources('alice', { mode: 'unified', revision: 1,
      records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
    const ontology = await import('../../../../src/main/features/cognition/ontology/service');
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    await ontology.commitOntologyCommand('alice', { commandId: 'seed-personal', expectedRevision: 0,
      actions: [{ intent: 'create', recordId: 'personal', sourceLabel: 'Existing structure', record: { kind: 'module', name: '我的本体', description: '', scope: { kind: 'personal' } } }] });
    const original = '以后回答时先给出结论，再说明关键理由和依据。';
    const revised = '以后回答时先给出结论，再说明关键理由和依据，并标出尚未验证的部分。';
    const refs = [{ moduleId: 'personal', recordId: 'answer-rule', versionPolicy: 'current', sharedBody: true }];
    const initialPlan = joint ? formation.parseOntologyFormationProposal(ontology.readOntologyDocument('alice'), 'initial', {
      reason: 'Preserve the approved answer preference as its shared rule.', evidence: ['m1'], refs, actions: [{ intent: 'create', recordId: 'answer-rule', sourceLabel: 'Approved preference',
        record: { kind: 'rule', moduleId: 'personal', name: '回答结构偏好', requirement: original, strength: 'default', condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' } }] }, original) : undefined;
    const f = await fixture(initialPlan ? { ontologyFormation: initialPlan } : {});
    const first = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(first.approved).toBe(true);
    const current = ontology.readOntologyDocument('alice');
    const updatePlan = joint ? formation.parseOntologyFormationProposal(current, 'revision', {
      reason: 'The user has refined the same answer preference.', evidence: ['m1'], refs, actions: [{ intent: 'update', recordId: 'answer-rule', expectedVersion: current.records['answer-rule'].version,
        patch: { requirement: revised }, sourceLabel: 'Approved refinement' }] }, revised) : undefined;
    const update = await fixture({ judgment: revised, suggestedAction: 'update', targetAssetId: first.asset!.id, targetVersionUsed: '1',
      ...(updatePlan ? { ontologyFormation: updatePlan } : {}) });
    const result = await update.policy.tryAutomaticallyApproveRecallCandidate('alice', update.candidate.id);
    expect(result).toMatchObject({ approved: true, asset: { version: '2' } });
    const undo = await import('../../../../src/main/features/recall/automatic-formation-undo');
    const preview = await undo.previewAutomaticFormationUndo('alice', update.candidate.id);
    expect(preview.assetChange).toMatchObject({ action: 'rollback', toVersion: '1', after: first.asset!.statement });
    await undo.undoAutomaticFormation('alice', update.candidate.id, preview.token);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    expect(await assets.readAbilityAsset('alice', first.asset!.id)).toMatchObject({ version: '3', statement: first.asset!.statement });
    if (joint) expect(ontology.readOntologyDocument('alice').records['answer-rule']).toMatchObject({ status: 'active', requirement: first.asset!.statement });
    expect(await assets.listAbilityAssetVersions('alice', first.asset!.id)).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('keeps a concurrent version conflict reviewable and gives a user rebase its own human audit', async () => {
    const f = await fixture();
    const first = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    const update = await fixture({ judgment: '以后回答时先给出结论，再说明关键理由和依据，并标出尚未验证的部分。',
      suggestedAction: 'update', targetAssetId: first.asset!.id, targetVersionUsed: '1' });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const actualUpdate = assets.updateAbilityAsset;
    const race = vi.spyOn(assets, 'updateAbilityAsset').mockImplementationOnce(async (uid, id, input) => {
      await actualUpdate(uid, id, { statement: '回答先给结论，并说明关键理由和来源。', expectedVersion: '1', actor: 'user', reason: 'concurrent user edit' });
      return actualUpdate(uid, id, input);
    });
    const held = await update.policy.tryAutomaticallyApproveRecallCandidate('alice', update.candidate.id);
    race.mockRestore();
    expect(held).toMatchObject({ approved: false, candidate: { status: 'pending_review' } });
    expect(held.reasons).toContain('recall_candidate_version_conflict');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const confirmed = await candidates.promoteRecallCandidate('alice', update.candidate.id, { actor: 'user', confirmBaselineVersion: '2' });
    expect(confirmed).toMatchObject({ decision: { actor: 'user' }, asset: { version: '3' }, rebasedFrom: '1' });
    const journal = await import('../../../../src/main/features/cognition/review-decision');
    const decisions = await journal.listReviewDecisions('alice', `recall_candidate:${update.candidate.id}`);
    expect(decisions.map(decision => decision.actor)).toContain('system');
    expect(decisions.map(decision => decision.actor)).toContain('user');
  });
  it('protects and recovers a committed automatic asset after its candidate commit was interrupted', async () => {
    const f = await fixture();
    const first = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(first.approved).toBe(true);
    await f.store.updateRecallJsonRecord('alice', 'candidates', f.candidate.id, () => f.candidate);
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(candidates.updateRecallCandidate('alice', f.candidate.id, {
      judgment: '用户尝试修改尚未补齐状态的已提交认知。', value: f.candidate.value,
      summary: f.candidate.summary, suggestedType: f.candidate.suggestedType, suggestedScope: f.candidate.suggestedScope,
      sourceRefs: f.candidate.sourceRefs, evidenceRefs: f.candidate.evidenceRefs,
    })).rejects.toMatchObject({ code: 'recall_candidate_handoff_incomplete' });
    await f.settings.updateRecallCaptureSettings('alice', { autoApproval: false });
    const recovered = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    expect(recovered).toMatchObject({ approved: false, candidate: { status: 'confirmed', reviewDecisionId: first.candidate.reviewDecisionId }, asset: { id: first.asset!.id, version: '1' } });
    expect(recovered.reasons).toEqual(['existing_commit_recovered']);
  });
  it('records a fresh human confirmation after a failed automatic asset write', async () => {
    const f = await fixture();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const failedWrite = vi.spyOn(assets, 'createAbilityAsset').mockRejectedValueOnce(new Error('injected asset IO failure'));
    const attempted = await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id);
    failedWrite.mockRestore();
    expect(attempted.candidate.status).toBe('failed');
    await f.settings.updateRecallCaptureSettings('alice', { autoApproval: false });
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const confirmed = await candidates.promoteRecallCandidate('alice', f.candidate.id, { actor: 'user' });
    expect(confirmed).toMatchObject({ decision: { actor: 'user' }, asset: { lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1' } });
    expect(confirmed.decision.decision_id).not.toBe(attempted.candidate.reviewDecisionId);
  });
  it('requires an explicit current baseline for an automatic update', async () => {
    const f = await fixture({ suggestedAction: 'update', targetAssetId: 'aa-missing' });
    expect((await f.policy.tryAutomaticallyApproveRecallCandidate('alice', f.candidate.id)).reasons).toContain('update_baseline_missing');
  });
});
