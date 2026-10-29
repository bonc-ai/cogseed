/** Source-backed human root + shared R + real updates/review/version records.
 * Only the independent semantic model transport and replacement dispatch are
 * stubbed (actual replacement still tombstones real source bytes); no permission,
 * approval, source, version, ontology or standing-policy decision is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareNightlyCandidateInput, markFixtureCaptureReady } from '../helpers/nightly-formation-fixture';
import { drainMainRuntimeForTest } from '../helpers/drain-main-runtime';
import type { SaveRecallCandidateInput, RecallAbilityAssetRecord } from '../../src/main/features/recall/candidate-service';

const model = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: model }));
const uid = 'standing-continuity-user';
const original = '以后解释复杂技术问题时，先给结论，再说明依据；仅适用于技术说明，日常问候不要套用。';
const revised = '以后解释复杂技术问题时，先给结论，再说明依据；仅适用于技术说明，日常问候不要套用。排查故障时例外，先给证据再给结论。';
const task = '复杂技术问题：说明数据库连接池超时的排查思路。';
let root: string;
let previous: string | undefined;
beforeEach(async () => {
  vi.resetModules();
  model.mockReset().mockImplementation(async (_uid: string, request: { message: string }) => {
    const payload = JSON.parse(request.message);
    const approved = payload.approvedUserSources[0];
    return { result: { text: JSON.stringify({ supported: true, noUnsupportedClaims: true, scopePreserved: true,
      finalDecisionPreserved: true, priorContentPreserved: true,
      ...(Array.isArray(payload.ruleSourceRequests) ? { sourceRuleConclusions: payload.ruleSourceRequests.map((request: { recordId: string }) => ({
        recordId: request.recordId, status: 'resolved',
        // Deterministic fixture meaning: this source expresses an adaptable
        // answer-order preference, not metadata copied from the blind draft.
        expectedContract: { strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' },
        topicEvidence: [{ label: approved.label, quote: approved.approvedQuotes[0] }],
        fieldEvidence: { strength: [{ label: approved.label, quote: approved.approvedQuotes[0] }], condition: [], effect: [], exception: [] } })) } : {}),
      evidence: [{ label: approved.label, quote: approved.approvedQuotes[0] }] }), meta: {} } };
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-standing-continuity-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '0');
  vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '0');
  const { activateUser } = await import('../../src/main/features/users');
  activateUser(uid);
  const { migrateLegacyCognition } = await import('../../src/main/features/cognition_migration');
  expect((await migrateLegacyCognition(uid, { activate: true })).errors).toEqual([]);
  const ontology = await import('../../src/main/features/cognition/ontology/service');
  await ontology.commitOntologyCommand(uid, { commandId: 'continuity-module', expectedRevision: 0,
    actions: [{ intent: 'create', recordId: 'continuity-personal', sourceLabel: '隔离测试结构',
      record: { kind: 'module', name: '隔离表达偏好', description: '', scope: { kind: 'personal' } } }] });
});
afterEach(async () => {
  await drainMainRuntimeForTest(uid);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function nightly(body: string, target?: RecallAbilityAssetRecord, overrides: Partial<SaveRecallCandidateInput> = {}) {
  const ontology = await import('../../src/main/features/cognition/ontology/service');
  const doc = ontology.readOntologyDocument(uid);
  const { parseOntologyFormationProposal } = await import('../../src/main/features/recall/ontology-formation');
  const plan = parseOntologyFormationProposal(doc, 'temporary', { reason: '用户完整偏好及例外原文', evidence: ['m1'],
    refs: [{ moduleId: 'continuity-personal', recordId: 'continuity-rule', versionPolicy: 'current', sharedBody: true }],
    actions: target ? [{ intent: 'update', recordId: 'continuity-rule', expectedVersion: doc.records['continuity-rule']!.version,
      sourceLabel: '用户新偏好完整原文', patch: { requirement: body } }] : [{ intent: 'create', recordId: 'continuity-rule',
      sourceLabel: '用户长期偏好完整原文', record: { kind: 'rule', moduleId: 'continuity-personal', name: '技术说明表达偏好',
        requirement: body, strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }],
  }, body)!;
  const settings = await import('../../src/main/features/recall/capture-settings');
  const prepared = await prepareNightlyCandidateInput(uid, { judgment: body, summary: '技术说明表达偏好',
    value: '后续技术说明使用保存的表达顺序，并保留故障例外与适用范围。',
    suggestedType: 'cognition', contentCategory: 'preference', suggestedScope: 'general',
    suggestedAction: target ? 'update' : 'create', ...(target ? { targetAssetId: target.id, targetVersionUsed: target.version } : {}),
    applicableWhen: ['复杂技术问题'], forbiddenWhen: ['日常问候'],
    risk: 'low', sourceRefs: [], rawStatement: true, ontologyFormation: plan, ...overrides });
  const store = await import('../../src/main/features/recall/store');
  const capture = (await store.readRecallJsonRecord(uid, 'captures', prepared.captureProvenance!.captureId))!;
  const messageId = prepared.captureProvenance!.messageIds[0]!;
  const { conversationMessageFile } = await import('../../src/main/util/project-layout');
  const file = conversationMessageFile(uid, String(capture.conversationId));
  const prior = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  fs.writeFileSync(file, JSON.stringify({ ...prior, text: body }) + '\n');
  const summaryModule = await import('../../src/main/features/recall/capture-context-summary');
  const { captureSummaryDecisionDigest } = await import('../../src/main/features/recall/capture-provenance');
  const messages = [{ id: messageId, role: 'user' as const, text: body, discovery: true }];
  const summary = summaryModule.validateCaptureContextSummary({
    sourceDigest: summaryModule.captureContextSourceDigest(messages), completedAt: prepared.captureProvenance!.extractionCompletedAt,
    topics: [{ title: '隔离用户长期表达偏好', content: body, conditions: ['复杂技术问题'], unresolved: [],
      attribution: 'user_requirement', evidence: [{ messageId, role: 'user', quote: body, start: 0, end: body.length }] }],
    coverage: { messageCount: 1, sourceChars: body.length, segmentCount: 1, processedSegmentIds: ['m0:0'], maxInputChars: 4000 },
  }, messages);
  prepared.captureProvenance!.valueJudgment = { ...prepared.captureProvenance!.valueJudgment,
    evidence: prepared.captureProvenance!.valueJudgment.evidence.map(ref => ({ ...ref, quote: body })),
    summaryDigest: captureSummaryDecisionDigest(summary) };
  for (const refs of [prepared.sourceRefs, prepared.evidenceRefs]) for (const ref of refs || []) if (ref.excerpt) ref.excerpt = body;
  await store.writeRecallJsonRecord(uid, 'captures', capture.id, { ...capture, contextSummary: summary,
    valueJudgment: prepared.captureProvenance!.valueJudgment,
    ...settings.captureAutoApprovalAuthorization(await settings.readRecallCaptureSettings(uid)) });
  // This fixture writes ordinary conversation/index bytes directly; unlike the
  // real chat-create path it must explicitly invalidate the cached inventory.
  const { invalidateConversationCaches } = await import('../../src/main/features/chats');
  invalidateConversationCaches(uid);
  const candidates = await import('../../src/main/features/recall/candidate-service');
  const candidate = await candidates.saveRecallCandidate(uid, prepared);
  await markFixtureCaptureReady(uid, candidate);
  return candidate;
}
async function humanRoot() {
  const candidate = await nightly(original);
  const { promoteRecallCandidate } = await import('../../src/main/features/recall/candidate-service');
  const { asset } = await promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
  const { hasUserAuthorizedStandingPreference } = await import('../../src/main/features/recall/standing-preference');
  expect(await hasUserAuthorizedStandingPreference(uid, asset)).toBe(true);
  return asset;
}
async function ordinary(turn: string, context: Record<string, string> = {}) {
  const { buildRecallTurnPromptContext } = await import('../../src/main/features/recall/prompt-injection');
  return buildRecallTurnPromptContext(uid, { cid: `cid-${turn}`, taskRunId: turn, taskText: task,
    agentId: 'commander', conversationKind: 'normal', ...context });
}
function details(asset: RecallAbilityAssetRecord, patch: Record<string, unknown> = {}) {
  return { statement: revised, applicableWhen: ['复杂技术问题', '技术说明'], forbiddenWhen: ['日常问候'],
    expectedVersion: asset.version, expectedActiveVersion: asset.activeVersion || asset.version,
    reason: '用户完整保存表达偏好与边界', ...patch };
}
async function sharedRule() {
  const ontology = await import('../../src/main/features/cognition/ontology/service');
  return ontology.readOntologyDocument(uid).records['continuity-rule'];
}

describe('standing preference authorization follows an actual approved update', () => {
  it.each(['human_root', 'human_details', 'automatic'] as const)('recovers the actual %s version journal without inventing actor, reason or proof', async stage => {
    const assets = await import('../../src/main/features/recall/asset-service');
    let first: RecallAbilityAssetRecord | undefined;
    let candidateId: string | undefined;
    if (stage !== 'human_root') first = await humanRoot();
    if (stage === 'automatic') {
      const settings = await import('../../src/main/features/recall/capture-settings');
      await settings.updateRecallCaptureSettings(uid, { autoApproval: true });
    }
    const store = await import('../../src/main/features/recall/store');
    const append = store.appendRecallJsonlRecord;
    let interrupted = false;
    const fault = vi.spyOn(store, 'appendRecallJsonlRecord').mockImplementation(async (...args) => {
      if (!interrupted && args[0] === uid && args[1] === 'ability-asset-versions') {
        interrupted = true;
        if (process.env.COGSEED_CONTINUITY_DIAGNOSTICS) fs.writeFileSync(process.env.COGSEED_CONTINUITY_DIAGNOSTICS,
          JSON.stringify({ synthetic: true, stage, appendRecord: args[3],
            raw: await store.readRecallJsonRecord(uid, 'ability-assets', args[2]) }, null, 2));
        throw Object.assign(new Error('synthetic interrupted version append'), { code: 'EIO' });
      }
      return append(...args);
    });
    let saved: RecallAbilityAssetRecord;
    if (stage === 'human_root') saved = await humanRoot();
    else if (stage === 'human_details') saved = await assets.saveUserStandingPreferenceDetails(uid, first!.id, details(first!));
    else {
      const candidate = await nightly(revised, first);
      candidateId = candidate.id;
      const { tryAutomaticallyApproveRecallCandidate } = await import('../../src/main/features/recall/nightly-automatic-approval');
      const result = await tryAutomaticallyApproveRecallCandidate(uid, candidate.id);
      expect(result.approved).toBe(true);
      saved = result.asset!;
    }
    expect(interrupted).toBe(true);
    const { pendingAssetVersions } = await import('../../src/main/features/recall/asset-version-journal');
    const raw = await store.readRecallJsonRecord(uid, 'ability-assets', saved.id);
    const queued = pendingAssetVersions(raw).find(row => row.version === saved.version)!;
    expect(queued).toMatchObject({ actor: stage === 'automatic' ? 'system' : 'user',
      reason: stage === 'human_details' ? details(first!).reason : `review_decision:${saved.reviewDecisionId}`,
      snapshot: { statement: saved.statement, version: saved.version } });
    if (stage !== 'human_root') expect(queued.snapshot).toMatchObject({ standingPreferenceAuthority: saved.standingPreferenceAuthority });
    expect((await ordinary(`pending-${stage}`)).citations).toEqual([
      expect.objectContaining({ assetId: saved.id, version: saved.version }),
    ]);
    fault.mockRestore();
    await assets.recoverAbilityAssetVersionJournals(uid);
    expect(pendingAssetVersions(await store.readRecallJsonRecord(uid, 'ability-assets', saved.id))).toEqual([]);
    const rows = await assets.listAbilityAssetVersions(uid, saved.id);
    const restored = rows.filter(row => row.version === saved.version);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ actor: queued.actor, reason: queued.reason, snapshot: queued.snapshot });
    expect((await ordinary(`recovered-${stage}`)).promptBlock).toContain(saved.statement);
    if (candidateId) {
      const { tryAutomaticallyApproveRecallCandidate } = await import('../../src/main/features/recall/nightly-automatic-approval');
      await tryAutomaticallyApproveRecallCandidate(uid, candidateId);
      expect(model).toHaveBeenCalledTimes(1);
    }
    await assets.recoverAbilityAssetVersionJournals(uid);
    expect((await assets.listAbilityAssetVersions(uid, saved.id)).filter(row => row.version === saved.version)).toHaveLength(1);
    expect((await assets.readAbilityAsset(uid, saved.id)).version).toBe(saved.version);
  });

  it.each(['details', 'automatic'] as const)('uses the latest genuine second-night human root and source set for %s continuity', async mode => {
    const first = await humanRoot();
    const secondCandidate = await nightly(revised, first);
    const { promoteRecallCandidate } = await import('../../src/main/features/recall/candidate-service');
    const second = (await promoteRecallCandidate(uid, secondCandidate.id, { actor: 'user' })).asset;
    const { hasUserAuthorizedStandingPreference } = await import('../../src/main/features/recall/standing-preference');
    expect(await hasUserAuthorizedStandingPreference(uid, second)).toBe(true);
    expect(second.version).toBe('2');
    expect(second.evidenceRefs.length).toBeGreaterThan(first.evidenceRefs.length);
    const thirdBody = revised + '结尾列出待核问题。';
    const assets = await import('../../src/main/features/recall/asset-service');
    let third: RecallAbilityAssetRecord;
    if (mode === 'details') third = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(second, { statement: thirdBody }));
    else {
      const settings = await import('../../src/main/features/recall/capture-settings');
      await settings.updateRecallCaptureSettings(uid, { autoApproval: true });
      const thirdCandidate = await nightly(thirdBody, second);
      const { tryAutomaticallyApproveRecallCandidate } = await import('../../src/main/features/recall/nightly-automatic-approval');
      const result = await tryAutomaticallyApproveRecallCandidate(uid, thirdCandidate.id);
      expect(result.approved).toBe(true);
      third = result.asset!;
    }
    expect(third.version).toBe('3');
    expect(third.standingPreferenceAuthority).toMatchObject({ rootCandidateId: secondCandidate.id,
      rootDecisionId: second.reviewDecisionId, rootVersion: second.version, previousVersion: second.version });
    const next = await ordinary(`latest-human-${mode}`);
    expect(next.citations).toEqual([expect.objectContaining({ assetId: first.id, version: third.version })]);
    expect(next.promptBlock).toContain(thirdBody);
    for (const ref of secondCandidate.evidenceRefs) expect(third.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: ref.kind, id: ref.id }),
    ]));
    expect(await sharedRule()).toMatchObject({ requirement: thirdBody });
  });

  it('verifies the persisted human-detail and two automatic generations recursively without a post-commit model call', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    let current = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(first));
    const settings = await import('../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(uid, { autoApproval: true });
    const { tryAutomaticallyApproveRecallCandidate } = await import('../../src/main/features/recall/nightly-automatic-approval');
    const { hasUserAuthorizedStandingPreference } = await import('../../src/main/features/recall/standing-preference');
    for (const suffix of ['讨论数据库时，结尾列出待核问题。', '讨论网络时，结尾列出待核问题。']) {
      expect(await hasUserAuthorizedStandingPreference(uid, await assets.readAbilityAsset(uid, first.id))).toBe(true);
      const body = current.statement + suffix;
      const candidate = await nightly(body, current, { applicableWhen: current.applicableWhen, forbiddenWhen: current.forbiddenWhen });
      expect(await hasUserAuthorizedStandingPreference(uid, await assets.readAbilityAsset(uid, first.id))).toBe(true);
      const result = await tryAutomaticallyApproveRecallCandidate(uid, candidate.id);
      expect(result.reasons).toEqual([]);
      expect(result.approved).toBe(true);
      expect(result.asset!.standingPreferenceAuthority).toMatchObject({ previousVersion: current.version,
        rootCandidateId: first.candidateId, rootVersion: first.version });
      current = result.asset!;
      expect((await ordinary(`recursive-${current.version}`)).citations).toEqual([expect.objectContaining({ assetId: first.id, version: current.version })]);
    }
    expect(current.version).toBe('4');
    expect(model).toHaveBeenCalledTimes(2);
    await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
    expect((await ordinary('recursive-disabled')).promptBlock).toContain(current.statement);
    expect(model).toHaveBeenCalledTimes(2);
    expect(await sharedRule()).toMatchObject({ requirement: current.statement });
  });

  it('supplies the new complete human-saved version in an ordinary unpinned turn and shares its R body', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const saved = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(first));
    expect(saved).toMatchObject({ statement: revised, applicableWhen: ['复杂技术问题', '技术说明'], forbiddenWhen: ['日常问候'] });
    expect(saved.version).not.toBe(first.version);
    expect(saved.standingPreferenceAuthority).toMatchObject({ method: 'human_details_save', committedVersion: saved.version,
      previousVersion: first.version, rootCandidateId: first.candidateId, rootDecisionId: first.reviewDecisionId });
    const next = await ordinary('human-saved');
    expect(next.citations).toEqual([expect.objectContaining({ assetId: first.id, version: saved.version, matchMethod: 'standing_preference' })]);
    expect(next.promptBlock).toContain(revised);
    expect(next.promptBlock).toContain('技术说明');
    expect(await sharedRule()).toMatchObject({ requirement: revised });
    expect(model).not.toHaveBeenCalled();
    expect(saved.maturity).toBe('bud');
    expect(saved.appliedValidationIds).toEqual([]);
  });

  it('preserves a reviewed body through title/tags changes but never launders generic AI/user body edits', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const renamed = await assets.updateAbilityAsset(uid, first.id, { title: '清晰表达偏好', tags: ['表达'], actor: 'user', reason: '仅整理标签和标题' });
    expect((await ordinary('renamed')).citations).toEqual([expect.objectContaining({ assetId: first.id, version: renamed.version })]);
    const generic = await assets.updateAbilityAsset(uid, first.id, { statement: revised, actor: 'ai', reason: '未经完整确认的 AI 正文编辑' });
    const titleOnly = await assets.updateAbilityAsset(uid, first.id, { title: '故障表达偏好', tags: ['故障'], actor: 'user', reason: '仅修改标题，不确认正文' });
    expect(titleOnly.statement).toBe(generic.statement);
    expect((await ordinary('ai-title-only')).citations).toEqual([]);
    const genericUser = await assets.updateAbilityAsset(uid, first.id, { statement: revised + '结尾列出待核问题。', actor: 'user', reason: '普通正文更新入口' });
    expect((await ordinary('generic-user')).citations).toEqual([]);
    expect(genericUser.statement).toContain('待核问题');
  });

  it('continues the human root after actual supported automatic update, retries once, and survives switching automation off', async () => {
    const first = await humanRoot();
    const settings = await import('../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(uid, { autoApproval: true });
    const candidate = await nightly(revised, first);
    const policy = await import('../../src/main/features/recall/nightly-automatic-approval');
    const result = await policy.tryAutomaticallyApproveRecallCandidate(uid, candidate.id);
    expect(result).toMatchObject({ approved: true, reasons: [], asset: { id: first.id, statement: revised } });
    expect(result.asset!.standingPreferenceAuthority).toMatchObject({ method: 'nightly_supported_update',
      candidateId: candidate.id, committedVersion: result.asset!.version, previousVersion: first.version });
    expect(model).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(model.mock.calls[0][1].message);
    expect(payload.existingTarget).toMatchObject({ id: first.id, version: first.version, statement: original });
    expect(payload.candidate.ontologyFormation.actions[0].patch.requirement).toBe(revised);
    expect(payload.approvedUserSources[0].approvedQuotes).toEqual([revised]);
    const next = await ordinary('auto-updated');
    expect(next.citations).toEqual([expect.objectContaining({ assetId: first.id, version: result.asset!.version })]);
    expect(next.promptBlock).toContain(revised);
    expect(await sharedRule()).toMatchObject({ requirement: revised });
    await policy.tryAutomaticallyApproveRecallCandidate(uid, candidate.id);
    expect(model).toHaveBeenCalledTimes(1);
    const assets = await import('../../src/main/features/recall/asset-service');
    expect((await assets.readAbilityAsset(uid, first.id)).version).toBe(result.asset!.version);
    await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
    expect((await ordinary('automation-disabled')).citations).toEqual([expect.objectContaining({ assetId: first.id, version: result.asset!.version })]);
    expect((await assets.readAbilityAsset(uid, first.id)).appliedValidationIds).toEqual([]);
    // The committed observation remains necessary even after the automation
    // setting is off. Missing audit proof must fail closed, never re-call a
    // model after promotion or borrow an unrelated root to trust the new body.
    const { recallJsonRecordPath } = await import('../../src/main/features/recall/paths');
    const supportId = result.asset!.standingPreferenceAuthority!.support!.id;
    fs.unlinkSync(recallJsonRecordPath(uid, 'automatic-source-support', supportId));
    expect((await ordinary('automatic-proof-missing')).citations).toEqual([]);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('does not give automatically created bud cognition the human standing grant', async () => {
    const settings = await import('../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(uid, { autoApproval: true });
    const candidate = await nightly(original);
    const { tryAutomaticallyApproveRecallCandidate } = await import('../../src/main/features/recall/nightly-automatic-approval');
    const result = await tryAutomaticallyApproveRecallCandidate(uid, candidate.id);
    expect(result).toMatchObject({ approved: true, asset: { maturity: 'bud', lifecycleStatus: 'automatically_extracted_unverified' } });
    expect((await ordinary('automatic-new')).citations).toEqual([]);
    const { updateAbilityAsset } = await import('../../src/main/features/recall/asset-service');
    await updateAbilityAsset(uid, result.asset!.id, { title: '本人表达偏好', actor: 'user', reason: '仅整理标题' });
    expect((await ordinary('automatic-new-title')).citations).toEqual([]);
  });

  it('checks both content/active baselines and resolves parallel complete saves without overwriting a winner', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    await expect(assets.saveUserStandingPreferenceDetails(uid, first.id, details(first, { expectedVersion: '999' }))).rejects.toThrow();
    await expect(assets.saveUserStandingPreferenceDetails(uid, first.id, details(first, { expectedActiveVersion: '999' }))).rejects.toThrow();
    expect((await assets.readAbilityAsset(uid, first.id)).statement).toBe(original);
    const outcomes = await Promise.allSettled([
      assets.saveUserStandingPreferenceDetails(uid, first.id, details(first)),
      assets.saveUserStandingPreferenceDetails(uid, first.id, details(first, { statement: revised + '结尾列出待核问题。' })),
    ]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(row => row.status === 'rejected')).toHaveLength(1);
    const current = await assets.readAbilityAsset(uid, first.id);
    expect(current.version).toBe('2');
    const next = await ordinary('parallel-saved');
    expect(next.citations).toEqual([expect.objectContaining({ assetId: first.id, version: current.version })]);
    expect(await sharedRule()).toMatchObject({ requirement: current.statement });
  });

  it('does not apply the latest grant to a selected historical body or a paused asset', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const saved = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(first));
    await assets.selectAbilityAssetVersion(uid, first.id, first.version, { actor: 'user', reason: '查看历史正文' });
    expect((await ordinary('historical-selected')).citations).toEqual([]);
    await expect(assets.saveUserStandingPreferenceDetails(uid, first.id, details(saved))).rejects.toThrow();
    await assets.selectAbilityAssetVersion(uid, first.id, saved.version, { actor: 'user', reason: '恢复当前已完整确认版本' });
    expect((await ordinary('current-restored')).citations).toEqual([expect.objectContaining({ assetId: first.id, version: saved.version })]);
    await assets.pauseAbilityAsset(uid, first.id, { actor: 'user', reason: '用户暂停使用' });
    expect((await ordinary('paused-after-save')).citations).toEqual([]);
  });

  it('requires the immutable authority version even after a metadata-only advance', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const saved = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(first));
    const renamed = await assets.updateAbilityAsset(uid, first.id, {
      title: '有范围的表达偏好', actor: 'user', reason: '仅整理可读标题',
    });
    expect(Number(renamed.version)).toBeGreaterThan(Number(saved.version));
    expect((await ordinary('metadata-proof-present')).citations).toEqual([
      expect.objectContaining({ assetId: first.id, version: renamed.version }),
    ]);
    await assets.deleteAbilityAssetVersion(uid, first.id, saved.version, { actor: 'user', reason: '用户删除旧授权版本' });
    expect((await assets.listAbilityAssetVersions(uid, first.id)).some(row => row.version === saved.version)).toBe(false);
    expect((await ordinary('immutable-proof-missing')).citations).toEqual([]);
    expect((await assets.readAbilityAsset(uid, first.id)).statement).toBe(revised);
    expect(model).not.toHaveBeenCalled();
  });

  it('rechecks live sources and scope after a complete save rather than borrowing the old permission', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const saved = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(first));
    expect((await ordinary('before-source-pause')).citations).toEqual([expect.objectContaining({ assetId: first.id, version: saved.version })]);
    const control = await import('../../src/main/features/recall/source-control');
    await control.pauseCognitionSource(uid, saved.evidenceRefs[0]!);
    expect((await ordinary('source-paused')).citations).toEqual([]);
    await control.resumeCognitionSource(uid, saved.evidenceRefs[0]!);
    expect((await ordinary('source-resumed')).citations).toEqual([expect.objectContaining({ assetId: first.id, version: saved.version })]);
    const scoped = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(saved, {
      statement: revised + '结尾列出待核问题。', scopePolicy: { workspaceIds: ['workspace-a'] },
    }));
    expect(scoped.scopePolicy).toEqual({ workspaceIds: ['workspace-a'] });
    // Changing the permission boundary alongside prose is not an extension of
    // the earlier scope grant, even if the caller knows all detail fields.
    expect((await ordinary('scope-b', { workspaceId: 'workspace-b' })).citations).toEqual([]);
    expect((await ordinary('scope-a', { workspaceId: 'workspace-a' })).citations).toEqual([]);
  });

  it('requires persisted cached support inside promotion and holds a stale version without writing its R', async () => {
    const first = await humanRoot();
    const settings = await import('../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(uid, { autoApproval: true });
    const candidate = await nightly(revised, first);
    const policy = await import('../../src/main/features/recall/nightly-automatic-approval');
    await expect(policy.requireNightlyAutomaticApproval(uid, candidate)).rejects.toMatchObject({ reasons: ['candidate_semantic_support_unavailable'] });
    expect(model).not.toHaveBeenCalled();
    expect((await policy.evaluateNightlyAutomaticApproval(uid, candidate)).eligible).toBe(true);
    const assets = await import('../../src/main/features/recall/asset-service');
    const changed = await assets.saveUserStandingPreferenceDetails(uid, first.id, details(first, { statement: original + '结尾列出待核问题。' }));
    const result = await policy.tryAutomaticallyApproveRecallCandidate(uid, candidate.id);
    expect(result).toMatchObject({ approved: false, candidate: { status: 'pending_review' } });
    // 资产更新同时推进本体基线；当前比较链先报 ontology_baseline_changed，
    // 不再落到字段级的 update_baseline_conflict。两者都表示“基线已变、本次不写”。
    expect(result.reasons).toContain('ontology_baseline_changed');
    expect((await assets.readAbilityAsset(uid, first.id)).statement).toBe(changed.statement);
    expect(await sharedRule()).toMatchObject({ requirement: changed.statement });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it.each(['original', 'metadata'] as const)('rejects the %s human root after actual user-message replacement without relying on source pause', async stage => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const current = stage === 'metadata' ? await assets.updateAbilityAsset(uid, first.id, { actor: 'user', title: '技术说明偏好', reason: '只改标题' }) : first;
    expect((await ordinary(`source-before-${stage}`)).citations).toEqual([expect.objectContaining({ assetId: first.id, version: current.version })]);
    const candidate = await (await import('../../src/main/features/recall/candidate-service')).readRecallCandidate(uid, first.candidateId!);
    const store = await import('../../src/main/features/recall/store');
    const capture = (await store.readRecallJsonRecord(uid, 'captures', candidate.captureProvenance!.captureId))!;
    const cid = String(capture.conversationId);
    const { conversationMessageFile } = await import('../../src/main/util/project-layout');
    const file = conversationMessageFile(uid, cid);
    // Keep the actual edit/tombstone/reset path. Stub only dispatching a new
    // reply so this regression cannot start an external model call.
    const bus = await import('../../src/main/features/group_chat/bus');
    const { appendJsonlAtomic } = await import('../../src/main/storage');
    const enqueue = vi.spyOn(bus, 'enqueue').mockImplementationOnce(async request => {
      const replacement = { id: `replacement-${stage}`, ts: new Date().toISOString(), from: 'user', to: ['commander'], text: request.text };
      await appendJsonlAtomic(file, replacement);
      return replacement;
    });
    const chats = await import('../../src/main/features/group_chat');
    const replaced = await chats.replaceUserMessage({ userId: uid, cid, messageId: candidate.captureProvenance!.messageIds[0], text: '撤回这项长期顺序；今后按每次实际要求判断。' });
    enqueue.mockRestore();
    expect(replaced.ok).toBe(true);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.find(row => row.id === candidate.captureProvenance!.messageIds[0])).toMatchObject({ text: '', deleted_by_user: true, deleted_at: expect.any(String) });
    const control = await import('../../src/main/features/recall/source-control');
    expect(await control.isCognitionSourceEnabled(uid, first.evidenceRefs.find(ref => ref.subtype === 'message')!)).toBe(true);
    const standing = await import('../../src/main/features/recall/standing-preference');
    expect(await standing.hasUserAuthorizedStandingPreference(uid, await assets.readAbilityAsset(uid, first.id))).toBe(false);
    expect((await ordinary(`source-after-${stage}`)).citations).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it.each(['original', 'metadata'] as const)('rejects changed same-ID source content for the %s root', async stage => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const current = stage === 'metadata' ? await assets.updateAbilityAsset(uid, first.id, { actor: 'user', title: '技术说明偏好', reason: '只改标题' }) : first;
    const candidate = await (await import('../../src/main/features/recall/candidate-service')).readRecallCandidate(uid, first.candidateId!);
    const store = await import('../../src/main/features/recall/store');
    const capture = (await store.readRecallJsonRecord(uid, 'captures', candidate.captureProvenance!.captureId))!;
    const { conversationMessageFile } = await import('../../src/main/util/project-layout');
    const file = conversationMessageFile(uid, String(capture.conversationId));
    const message = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    fs.writeFileSync(file, JSON.stringify({ ...message, text: original + '最终更正：原顺序不再适用。' }) + '\n');
    const standing = await import('../../src/main/features/recall/standing-preference');
    expect(await standing.hasUserAuthorizedStandingPreference(uid, current)).toBe(false);
    expect((await ordinary(`edited-source-${stage}`)).citations).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it.each(['capture_missing', 'immutable_sources_mismatch'] as const)('does not reuse original or metadata human intent when %s', async damage => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const renamed = await assets.updateAbilityAsset(uid, first.id, { actor: 'user', title: '技术说明偏好', reason: '只改标题' });
    const candidate = await (await import('../../src/main/features/recall/candidate-service')).readRecallCandidate(uid, first.candidateId!);
    const paths = await import('../../src/main/features/recall/paths');
    if (damage === 'capture_missing') fs.unlinkSync(paths.recallJsonRecordPath(uid, 'captures', candidate.captureProvenance!.captureId));
    else {
      const file = paths.recallJsonlPath(uid, 'ability-asset-versions', first.id);
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      rows.find(row => row.version === first.version).snapshot.evidenceRefs = [];
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    const standing = await import('../../src/main/features/recall/standing-preference');
    expect(await standing.hasUserAuthorizedStandingPreference(uid, first)).toBe(false);
    expect(await standing.hasUserAuthorizedStandingPreference(uid, renamed)).toBe(false);
    expect((await ordinary(`damaged-root-${damage}`)).citations).toEqual([]);
    expect(model).not.toHaveBeenCalled();
  });

  it('keeps missing handoff checks read-only while the normal explicit recovery accessor still repairs the actual commit', async () => {
    const first = await humanRoot();
    const assets = await import('../../src/main/features/recall/asset-service');
    const renamed = await assets.updateAbilityAsset(uid, first.id, { actor: 'user', title: '技术说明偏好', reason: '只改标题' });
    const candidates = await import('../../src/main/features/recall/candidate-service');
    const paths = await import('../../src/main/features/recall/paths');
    const directory = path.dirname(paths.recallJsonRecordPath(uid, 'asset-handoff-receipts', 'placeholder'));
    const name = fs.readdirSync(directory).find(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).candidateId === first.candidateId)!;
    const file = path.join(directory, name);
    fs.unlinkSync(file);
    const standing = await import('../../src/main/features/recall/standing-preference');
    expect(await standing.hasUserAuthorizedStandingPreference(uid, first)).toBe(false);
    expect(await standing.hasUserAuthorizedStandingPreference(uid, renamed)).toBe(false);
    expect((await ordinary('missing-human-handoff')).citations).toEqual([]);
    expect(await candidates.readRecallAssetHandoffReceipt(uid, first.candidateId!, first.reviewDecisionId!, { recovery: 'none' })).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
    expect(await candidates.readRecallAssetHandoffReceipt(uid, first.candidateId!, first.reviewDecisionId!)).toMatchObject({ assetId: first.id, version: first.version });
    expect(fs.existsSync(file)).toBe(true);
    expect(await standing.hasUserAuthorizedStandingPreference(uid, await assets.readAbilityAsset(uid, first.id))).toBe(true);
    expect(model).not.toHaveBeenCalled();
  });

});
