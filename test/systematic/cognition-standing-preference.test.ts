/** No model transport: real nightly evidence, user promotion, ReviewDecision,
 * ontology R binding, ordinary unpinned prompt selection and persisted audit. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareNightlyCandidateInput, markFixtureCaptureReady } from '../helpers/nightly-formation-fixture';
import type { SaveRecallCandidateInput } from '../../src/main/features/recall/candidate-service';
let root: string, prior: string | undefined;
const uid = 'standing-preference-user';
const body = '以后回答复杂技术问题，先给结论，再说明关键依据；日常问候不要强制套用。';
const task = '复杂技术问题：解释数据库连接池超时的排查思路。';
beforeEach(async () => {
  vi.resetModules(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-standing-preference-'));
  prior = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '0'); vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '0');
  const { activateUser } = await import('../../src/main/features/users'); activateUser(uid);
  const { migrateLegacyCognition } = await import('../../src/main/features/cognition_migration');
  expect((await migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
});
afterEach(async () => {
  const { closeEmbedder } = await import('../../src/main/features/kb_embed'); closeEmbedder();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (prior === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = prior;
  fs.rmSync(root, { recursive: true, force: true });
});
async function promotedPreference(overrides: Partial<SaveRecallCandidateInput> = {}) {
  const statement = overrides.judgment || body;
  const ontology = await import('../../src/main/features/cognition/ontology/service');
  if (!Object.keys(ontology.readOntologyDocument(uid).records).length) await ontology.commitOntologyCommand(uid, {
    commandId: 'synthetic-module', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal-module', sourceLabel: 'Synthetic test structure',
      record: { kind: 'module', name: '隔离偏好模块', description: '', scope: { kind: 'personal' } } }],
  });
  const { parseOntologyFormationProposal } = await import('../../src/main/features/recall/ontology-formation');
  const plan = parseOntologyFormationProposal(ontology.readOntologyDocument(uid), 'temporary', {
    reason: '用户明确长期回答偏好', evidence: ['m1'],
    refs: [{ moduleId: 'personal-module', recordId: 'standing-rule', versionPolicy: 'current', sharedBody: true }],
    actions: overrides.suggestedAction === 'update'
      ? [{ intent: 'update', recordId: 'standing-rule', expectedVersion: ontology.readOntologyDocument(uid).records['standing-rule']!.version,
        sourceLabel: '用户更新长期偏好', patch: { requirement: statement, exception: '日常问候不要强制套用' } }]
      : [{ intent: 'create', recordId: 'standing-rule', sourceLabel: '用户长期偏好原文', record: { kind: 'rule', moduleId: 'personal-module', name: '复杂技术回答顺序',
      requirement: statement, strength: 'default', condition: null, effect: { kind: 'note' }, exception: '日常问候不要强制套用' } }],
  }, statement)!;
  const prepared = await prepareNightlyCandidateInput(uid, { judgment: statement, summary: '复杂技术回答顺序', value: '长期组织复杂技术回答时，保持结论与依据的清晰顺序。',
    suggestedType: 'cognition', contentCategory: 'preference', suggestedScope: 'general', suggestedAction: 'create', sourceRefs: [], rawStatement: true,
    applicableWhen: ['复杂技术问题'], forbiddenWhen: ['日常问候'], ontologyFormation: plan, ...overrides });
  // Replace the generic helper evidence with the exact synthetic preference,
  // preserving the real JSONL source, capture digest and approved quote chain.
  const store = await import('../../src/main/features/recall/store');
  const capture = await store.readRecallJsonRecord(uid, 'captures', prepared.captureProvenance!.captureId);
  const cid = String(capture!.conversationId), messageId = prepared.captureProvenance!.messageIds[0]!;
  const { conversationMessageFile } = await import('../../src/main/util/project-layout');
  const file = conversationMessageFile(uid, cid); const priorMessage = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  fs.writeFileSync(file, JSON.stringify({ ...priorMessage, text: statement }) + '\n');
  const summaryModule = await import('../../src/main/features/recall/capture-context-summary');
  const provenance = await import('../../src/main/features/recall/capture-provenance');
  const messages = [{ id: messageId, role: 'user' as const, text: statement, discovery: true }];
  const summary = summaryModule.validateCaptureContextSummary({ sourceDigest: summaryModule.captureContextSourceDigest(messages), completedAt: prepared.captureProvenance!.extractionCompletedAt,
    topics: [{ title: '用户长期表达偏好', content: statement, conditions: ['复杂技术问题'], unresolved: [], attribution: 'user_requirement', evidence: [{ messageId, quote: statement, role: 'user', start: 0, end: statement.length }] }],
    coverage: { messageCount: 1, sourceChars: statement.length, segmentCount: 1, processedSegmentIds: ['m0:0'], maxInputChars: 4000 } }, messages);
  prepared.captureProvenance!.valueJudgment = { ...prepared.captureProvenance!.valueJudgment, evidence: prepared.captureProvenance!.valueJudgment.evidence.map(item => ({ ...item, quote: statement })), summaryDigest: provenance.captureSummaryDecisionDigest(summary) };
  for (const refs of [prepared.sourceRefs, prepared.evidenceRefs]) for (const ref of refs || []) if (ref.excerpt) ref.excerpt = statement;
  await store.writeRecallJsonRecord(uid, 'captures', capture!.id, { ...capture!, contextSummary: summary, valueJudgment: prepared.captureProvenance!.valueJudgment });
  const candidates = await import('../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(uid, prepared); await markFixtureCaptureReady(uid, candidate);
  const { asset } = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
  return { asset, candidate };
}
describe('standing preference next ordinary turn', () => {
  it('uses genuine user confirmation in an ordinary unpinned turn without effect/maturity inflation', async () => {
    const routing = await import('../../src/main/features/recall/capture-model-routing'); const model = vi.spyOn(routing, 'runRecallCaptureModel');
    const { asset, candidate } = await promotedPreference();
    const { readReviewDecision } = await import('../../src/main/features/cognition/review-decision');
    const decision = await readReviewDecision(uid, `recall_candidate:${candidate.id}`, asset.reviewDecisionId!);
    expect(decision).toMatchObject({ actor: 'user', decision_type: 'accept', asset_id: asset.id, outcome: 'asset_created' });
    expect(asset).toMatchObject({ type: 'cognition', contentCategory: 'preference', maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified' });
    const ontology = await import('../../src/main/features/cognition/ontology/service');
    expect(ontology.readOntologyDocument(uid).records['standing-rule']).toMatchObject({ kind: 'rule', requirement: body });
    const { buildRecallTurnPromptContext, evaluateRecallAssetRuntimeEligibility } = await import('../../src/main/features/recall/prompt-injection');
    const runtime = await evaluateRecallAssetRuntimeEligibility(uid, asset, { operation: 'default_injection', taskText: task });
    const next = await buildRecallTurnPromptContext(uid, { cid: 'ordinary-new-chat', taskRunId: 'ordinary-turn', taskText: task, agentId: 'commander', conversationKind: 'normal' });
    if (process.env.COGSEED_STANDING_PREFERENCE_REPORT) fs.writeFileSync(process.env.COGSEED_STANDING_PREFERENCE_REPORT, JSON.stringify({ synthetic: true, modelCalls: model.mock.calls.length, asset, decision, runtime, next }, null, 2));
    expect(next.citations).toEqual([expect.objectContaining({ assetId: asset.id, version: asset.version, type: 'cognition' })]);
    expect(next.promptBlock).toContain(body); expect(next.profileMemoryEntries || []).toEqual([]);
    const { readContextProjection } = await import('../../src/main/features/recall/context-projection');
    const projection = await readContextProjection(uid, next.citations[0]!.projectionId);
    expect(projection).toMatchObject({ taskRunId: 'ordinary-turn', authorization: 'not_required', status: 'confirmed', assetVersions: { [asset.id]: asset.version } });
    expect(runtime).toMatchObject({ eligible: true, defaultUsePolicy: 'auto' });
    const assets = await import('../../src/main/features/recall/asset-service'); expect(await assets.readAbilityAsset(uid, asset.id)).toMatchObject({ maturity: 'bud', appliedValidationIds: [] });
    expect(model).not.toHaveBeenCalled();
  });
  it('keeps complete conditions for natural task wording and supplements a host committed projection without a manual pin', async () => {
    const projection = await import('../../src/main/features/recall/context-projection');
    const prompt = await import('../../src/main/features/recall/prompt-injection');
    // A host-selected empty task projection predates the user's preference save.
    // Build it with the real API while the isolated pool is genuinely empty.
    const committed = await projection.previewContextProjection(uid, { taskRunId: 'host-turn', purpose: 'general', conversationId: 'host-chat',
      authorization: 'not_required', confirm: true, explicitAssetIds: [] });
    expect(committed.assetIds).toEqual([]);
    const { asset } = await promotedPreference();
    const next = await prompt.buildRecallTurnPromptContext(uid, { cid: 'host-chat', taskRunId: 'host-turn', taskText: '请解释数据库连接池超时的排查思路，这次先列证据再给结论。', committedProjectionId: committed.id });
    expect(next.citations).toEqual([expect.objectContaining({ assetId: asset.id, version: '1', matchMethod: 'standing_preference' })]);
    const records = JSON.parse(next.authorizedAssetsBlock!.split('\n').at(-2)!);
    expect(records[0]).toMatchObject({ statement: body, applicable_when: asset.applicableWhen, forbidden_when: asset.forbiddenWhen, applicability: 'evaluate_complete_conditions_for_current_task' });
    expect(next.promptBlock).toContain('a current explicit user request takes precedence');
  });
  it('uses the second night human review of the same asset and refuses an earlier cached standing version', async () => {
    const first = await promotedPreference();
    const prompt = await import('../../src/main/features/recall/prompt-injection');
    const oldTurn = { cid: 'ordinary-cached-chat', taskRunId: 'ordinary-cached-turn', taskText: task };
    const old = await prompt.buildRecallTurnPromptContext(uid, oldTurn);
    expect(old.citations[0]?.version).toBe('1');
    const changed = '以后回答复杂技术问题，先列关键依据，再给结论；日常问候不要强制套用。';
    const second = await promotedPreference({ judgment: changed, suggestedAction: 'update', targetAssetId: first.asset.id, targetVersionUsed: '1' });
    expect(second.asset).toMatchObject({ id: first.asset.id, candidateId: first.asset.candidateId, version: '2', maturity: 'bud' });
    const next = await prompt.buildRecallTurnPromptContext(uid, { ...oldTurn, cid: 'ordinary-new-chat', taskRunId: 'ordinary-new-turn' });
    expect(next.citations).toEqual([expect.objectContaining({ assetId: first.asset.id, version: '2' })]);
    expect(next.promptBlock).toContain(changed);
    const retry = await prompt.buildRecallTurnPromptContext(uid, oldTurn);
    expect(retry.citations).toEqual([]); expect(retry.promptBlock).not.toContain(body);
    const { listInjectionReceipts } = await import('../../src/main/features/recall/injection-receipt');
    expect(await listInjectionReceipts(uid, oldTurn.taskRunId)).toContainEqual(expect.objectContaining({ assetId: first.asset.id, assetVersion: '1', status: 'omitted', reason: 'version_changed' }));
  });
  it('requires current source, project/workspace/role/agent boundaries and forbidden contexts', async () => {
    const { asset } = await promotedPreference({ ontologyFormation: undefined, scopePolicy: { projectIds: ['proj-a'], workspaceIds: ['space-a'], roleIds: ['role-a'], agentIds: ['commander'] } });
    const prompt = await import('../../src/main/features/recall/prompt-injection');
    const input = { cid: 'scoped-chat', taskRunId: 'scoped-turn', taskText: task, projectId: 'proj-a', workspaceId: 'space-a', roleId: 'role-a', agentId: 'commander' };
    expect((await prompt.buildRecallTurnPromptContext(uid, input)).citations[0]?.assetId).toBe(asset.id);
    for (const [key, value] of [['projectId', 'other-project'], ['workspaceId', 'other-space'], ['roleId', 'other-role'], ['agentId', 'other-agent'], ['taskText', '日常问候']]) {
      expect((await prompt.buildRecallTurnPromptContext(uid, { ...input, taskRunId: `blocked-${key}`, [key]: value })).citations).toEqual([]);
    }
    const { pauseCognitionSource } = await import('../../src/main/features/recall/source-control');
    await pauseCognitionSource(uid, asset.evidenceRefs.find(ref => ref.subtype === 'message')!);
    expect((await prompt.buildRecallTurnPromptContext(uid, { ...input, taskRunId: 'source-revoked-turn' })).citations).toEqual([]);
  });
  it('does not borrow a real earlier preference acceptance for changed fields, automatic seeds or different categories', async () => {
    const { asset } = await promotedPreference();
    const { hasUserAuthorizedStandingPreference } = await import('../../src/main/features/recall/standing-preference');
    for (const patch of [
      { statement: '未经人工确认的新正文' }, { scope: 'report' }, { scopePolicy: { projectIds: ['new-project'] } },
      { applicableWhen: [] }, { forbiddenWhen: [] }, { evidenceRefs: [] }, { ownerId: 'different-owner' },
      { lifecycleStatus: 'automatically_extracted_unverified' as const, maturity: 'seed' as const },
      ...(['method', 'template', 'rule', 'unclassified'] as const).map(contentCategory => ({ contentCategory })),
    ]) expect(await hasUserAuthorizedStandingPreference(uid, { ...asset, ...patch })).toBe(false);
    const assets = await import('../../src/main/features/recall/asset-service');
    const renamed = await assets.updateAbilityAsset(uid, asset.id, { actor: 'user', reason: '只改标题不改获准的正文与范围', title: '技术回答顺序偏好' });
    const prompt = await import('../../src/main/features/recall/prompt-injection');
    expect((await prompt.buildRecallTurnPromptContext(uid, { cid: 'renamed-chat', taskRunId: 'renamed-turn', taskText: task })).citations[0]?.version).toBe(renamed.version);
    await assets.updateAbilityAsset(uid, asset.id, { actor: 'user', reason: '详情直接改动没有新的候选确认', forbiddenWhen: [] });
    expect((await prompt.buildRecallTurnPromptContext(uid, { cid: 'edited-chat', taskRunId: 'edited-turn', taskText: task })).citations).toEqual([]);
  });
  it.each(['asset_pause', 'source_pause', 'scope_change'])('fails closed on real $0 while the human review proof is being read', async change => {
    const { asset } = await promotedPreference({ ontologyFormation: undefined });
    const review = await import('../../src/main/features/cognition/review-decision');
    const real = review.readReviewDecision;
    const assets = await import('../../src/main/features/recall/asset-service');
    let paused = false;
    vi.spyOn(review, 'readReviewDecision').mockImplementation(async (...args) => {
      const decision = await real(...args);
      if (!paused) {
        paused = true;
        if (change === 'asset_pause') await assets.pauseAbilityAsset(uid, asset.id, { actor: 'user', reason: '核查过程中真实暂停' });
        else if (change === 'source_pause') {
          const { pauseCognitionSource } = await import('../../src/main/features/recall/source-control');
          await pauseCognitionSource(uid, asset.evidenceRefs.find(ref => ref.subtype === 'message')!);
        } else await assets.updateAbilityAsset(uid, asset.id, { actor: 'system', reason: '核查过程中真实收紧范围', scopePolicy: { projectIds: ['other-project'] } });
      }
      return decision;
    });
    const prompt = await import('../../src/main/features/recall/prompt-injection');
    expect((await prompt.buildRecallTurnPromptContext(uid, { cid: 'race-chat', taskRunId: 'race-turn', taskText: task })).citations).toEqual([]);
    expect(paused).toBe(true);
    if (change === 'asset_pause') expect(await assets.readAbilityAsset(uid, asset.id)).toMatchObject({ status: 'paused' });
  });
  it('does not use a frozen-only standing snapshot after the live asset is removed', async () => {
    const { asset } = await promotedPreference({ ontologyFormation: undefined });
    const prompt = await import('../../src/main/features/recall/prompt-injection');
    const input = { cid: 'frozen-standing-chat', taskRunId: 'frozen-standing-turn', taskText: task };
    const first = await prompt.buildRecallTurnPromptContext(uid, input);
    const assets = await import('../../src/main/features/recall/asset-service');
    const frozen = await assets.readAbilityAssetVersionSnapshot(uid, asset.id, asset.version);
    const store = await import('../../src/main/features/recall/store');
    await store.updateRecallJsonRecord(uid, 'projections', first.citations[0]!.projectionId, current => ({ ...current!, assetVersionSnapshots: { [asset.id]: { version: asset.version, snapshot: frozen } } }));
    const { cognitionCompatibility, replaceCognitionSources } = await import('../../src/main/features/cognition_bridge');
    const compatibility = cognitionCompatibility(uid)!;
    const remaining = { ...compatibility.records['ability-assets'] }; delete remaining[asset.id];
    await replaceCognitionSources(uid, { ...compatibility, records: { ...compatibility.records, 'ability-assets': remaining } });
    expect((await prompt.buildRecallTurnPromptContext(uid, input)).citations).toEqual([]);
  });
});
