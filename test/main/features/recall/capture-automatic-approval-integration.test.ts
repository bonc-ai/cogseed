import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { captureSummaryModelResponse, captureSummaryModelResponseWithEvidence } from '../../../helpers/capture-summary-model';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
const mocks = vi.hoisted(() => ({ run: vi.fn(), runSummary: vi.fn(), buildRunner: vi.fn(), getMessages: vi.fn(), getMessagesPage: vi.fn(), getConversation: vi.fn(), listConversations: vi.fn() }));
vi.mock('../../../../src/main/features/auth', () => ({
  listEntriesForUser: async () => ({ entries: [] }),
  hasConfiguredModelForUser: () => ({ configured: true }),
  getConfiguredModelOAuthExpiredMessageForUser: () => null,
 hasConfiguredModel: () => ({ configured: true }), getConfiguredModelOAuthExpiredMessage: () => null }));
vi.mock('../../../../src/main/features/chats', () => ({ getMessages: mocks.getMessages, getMessagesPage: mocks.getMessagesPage, getConversation: mocks.getConversation, listConversations: mocks.listConversations }));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: mocks.buildRunner }));
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({ suggestAbilityAssetTitle: async () => ({ title: '项目会议议程' }) }));
vi.mock('../../../../src/main/features/kb_embed', () => ({ closeEmbedder: vi.fn(), embedQuery: async (text: string) => { const digest = createHash('sha256').update(text).digest(); return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2); } }));
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {}, scheduleBootBackground: () => ({ cancel: vi.fn(), promise: Promise.resolve() }) }));
let root: string, previousRoot: string | undefined;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.buildRunner.mockImplementation(async (options) => ({ runner: { run: options.sessionId.startsWith('memory-summary-') ? mocks.runSummary : mocks.run } }));
  mocks.runSummary.mockReset().mockImplementation(captureSummaryModelResponse);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 12, 3));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-auto-night-integration-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  mocks.getConversation.mockResolvedValue({ conversation_id: 'conv-night', title: '项目会议准备', space_id: 'space-night' });
  mocks.getMessages.mockResolvedValue([
    { id: 'message-user', ts: '2026-10-11T00:01:00.000Z', from: 'user', to: ['commander'], text: '请在后续项目会议反复复用以下会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。' },
    { id: 'message-assistant', ts: '2026-10-11T00:02:00.000Z', from: 'commander', to: ['user'], text: '这是一份适用于后续项目会议的可复用模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。' },
  ]);
  mocks.getMessagesPage.mockImplementation(async () => ({ history: await mocks.getMessages(), nextCursor: null }));
  mocks.listConversations.mockResolvedValue([{ conversation_id: 'conv-night', title: 'Project meeting', updated_at: '2026-10-11T00:02:00.000Z' }]);
  mocks.run.mockResolvedValue({ text: JSON.stringify({ candidates: [{ judgment: '会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。', value: '供后续项目会议复用，减少重复准备并使决策责任清晰。', summary: '项目会议议程', suggestedType: 'template', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }), meta: { aborted: false } });
});
afterEach(async () => { vi.useRealTimers(); await drainMainRuntimeForTest('capture-user'); if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });

it('reforms against the version approved during formation and persists an update anchored to that version', async () => {
  const uid = 'capture-user';
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const paths = await import('../../../../src/main/features/recall/paths');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
  const baseText = '项目会议准备模板包括会议目标、背景事实和待决策问题。';
  const initial = await createNightlyCandidateFixture(uid, { rawStatement: true, judgment: baseText,
    value: '帮助后续项目会议复用准备结构。', summary: '项目会议准备模板', suggestedType: 'template',
    suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [] });
  const created = (await candidates.promoteRecallCandidate(uid, initial.id, { actor: 'user' })).asset;
  let v6 = created;
  for (let version = 2; version <= 6; version++) v6 = await assets.updateAbilityAsset(uid, created.id, {
    statement: `${baseText}会前准备步骤记录至第${version}项。`, actor: 'user', reason: '完善会议准备模板', expectedVersion: String(version - 1),
  });
  expect(v6.version).toBe('6');
  const approvedText = `${v6.statement}会前检查每项背景事实的证据来源。`;
  const approval = await createNightlyCandidateFixture(uid, { rawStatement: true, judgment: approvedText,
    value: '会议准备保留证据来源，便于复核。', summary: '会议准备证据来源', suggestedType: 'template',
    suggestedScope: 'general', suggestedAction: 'update', targetAssetId: v6.id, targetVersionUsed: '6', risk: 'low', sourceRefs: [] });
  const sourceText = '项目存在部署风险时，会议准备模板应另列风险与回退条件；其他项目继续沿用原结构。';
  const messages = [
    { id: 'race-user', ts: '2026-10-11T00:01:00.000Z', from: 'user', to: ['commander'], text: sourceText },
    { id: 'race-assistant', ts: '2026-10-11T00:02:00.000Z', from: 'commander', to: ['user'], text: '项目会议准备保留原结构，并记录部署风险的例外。' },
  ];
  mocks.getMessages.mockResolvedValue(messages);
  for (const message of messages) await appendJsonlAtomic(conversationMessageFile(uid, 'conv-night'), message);
  mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [sourceText]));
  let releaseFirstBatch: (() => void) | undefined;
  let batchStarted!: () => void;
  const firstBatchStarted = new Promise<void>(resolve => { batchStarted = resolve; });
  const assessment = (version: string, targetText: string) => ({ text: JSON.stringify({ assessments: [{ index: 0,
    checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
      priorContentPreserved: true, evidence: [{ label: 'm1', quote: sourceText }] },
    uncertaintyDisposition: 'none', comparison: { relation: 'exception', reason: 'Explicit deployment-risk exception.',
      targetAssetId: v6.id, targetVersion: version, targetQuote: targetText },
    revision: { judgment: `${targetText}项目存在部署风险时，另列风险与回退条件；其他项目继续沿用原结构。` },
  }] }), meta: {} });
  mocks.run.mockReset()
    .mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: 'Reusable meeting exception',
      evidence: [{ messageId: 'race-user', quote: sourceText }] }), meta: {} })
    .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ judgment: sourceText,
      value: '会议准备覆盖部署风险和回退条件。', summary: '部署风险会议准备', suggestedType: 'template',
      suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }), meta: {} })
    .mockImplementationOnce(async input => {
      const request = JSON.parse(input.message);
      expect(request.existingAssets).toContainEqual(expect.objectContaining({ id: v6.id, version: '6', statement: v6.statement }));
      batchStarted();
      await new Promise<void>(resolve => { releaseFirstBatch = resolve; });
      return assessment('6', v6.statement);
    })
    .mockImplementationOnce(async input => {
      const request = JSON.parse(input.message);
      expect(request.existingAssets).toContainEqual(expect.objectContaining({ id: v6.id, version: '7', statement: approvedText }));
      return assessment('7', approvedText);
    });
  const stop = capture.startRecallCaptureOrchestrator();
  try {
    await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
    const directory = path.dirname(paths.recallJsonRecordPath(uid, 'captures', 'placeholder'));
    const rows = await Promise.all(fs.readdirSync(directory).filter(name => name.endsWith('.json'))
      .map(name => capture.readRecallCapture(uid, name.slice(0, -5))));
    const queued = rows.find(row => row.conversationId === 'conv-night' && row.status === 'queued');
    expect(queued).toBeDefined();
    const running = capture.runRecallCapture(uid, queued!.id);
    await Promise.race([firstBatchStarted, running.then(() => { throw new Error('capture settled before the formation gate'); })]);
    const promoted = await candidates.promoteRecallCandidate(uid, approval.id, { actor: 'user' });
    expect(promoted.asset).toMatchObject({ id: v6.id, version: '7', statement: approvedText });
    releaseFirstBatch!();
    const result = await running;
    expect(result).toMatchObject({ status: 'review_ready', formationCheckpoint: { assetBaselineRefreshes: 1 } });
    expect(result.candidateIds).toHaveLength(1);
    const saved = await candidates.readRecallCandidate(uid, result.candidateIds[0]);
    expect(saved).toMatchObject({ status: 'pending_review', targetAssetId: v6.id, targetVersionUsed: '7',
      judgment: `${approvedText}项目存在部署风险时，另列风险与回退条件；其他项目继续沿用原结构。` });
    expect((await candidates.listRecallCandidates(uid)).filter(candidate => candidate.captureProvenance?.captureId === queued!.id)).toHaveLength(1);
    expect((await assets.readAbilityAsset(uid, v6.id))).toMatchObject({ version: '7', statement: approvedText });
    expect(await assets.readAbilityAssetVersionSnapshot(uid, v6.id, '6')).toMatchObject({ statement: v6.statement });
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
  } finally { releaseFirstBatch?.(); stop(); }
});

it('rejects an unnormalized singleton related asset at the candidate write entry', async () => {
  await expect(createNightlyCandidateFixture('capture-user', { rawStatement: true,
    judgment: 'Retain the newly stated reporting requirement for later decisions.',
    value: 'Later reviews can identify the source of decisions.', summary: 'Reporting requirement',
    suggestedType: 'rule', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [],
    formationComparison: { relation: 'ambiguous', reason: 'An unrelated target is not a joint review.', relatedAssets: [
      { assetId: 'related-a', version: '1', quote: 'Synthetic historical body.' },
    ] } })).rejects.toThrow('related asset group requires two to six reviewed targets');
});

it('never persists related-asset quotes supplied to the candidate write entry', async () => {
  const sensitiveQuote = 'Synthetic historical body held only in the source asset.';
  const saved = await createNightlyCandidateFixture('capture-user', { rawStatement: true,
    judgment: 'Retain the newly stated reporting requirement for later decisions.',
    value: 'Later reviews can identify the source of decisions.', summary: 'Reporting requirement',
    suggestedType: 'rule', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [],
    formationComparison: { relation: 'ambiguous', reason: 'Multiple related assets need review.', relatedAssets: [
      { assetId: 'related-a', version: '1', quote: sensitiveQuote },
      { assetId: 'related-b', version: '2', quote: sensitiveQuote },
    ] } });
  expect(saved.formationComparison?.relatedAssets).toEqual([
    { assetId: 'related-a', version: '1' }, { assetId: 'related-b', version: '2' },
  ]);
  expect(JSON.stringify(saved.formationComparison)).not.toContain(sensitiveQuote);
});

it('holds a multi-asset review and refuses confirmation when a related version changes', async () => {
  const uid = 'capture-user';
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const store = await import('../../../../src/main/features/recall/store');
  const paths = await import('../../../../src/main/features/recall/paths');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
  const oldStatement = '项目会议准备须记录背景事实和待决策问题。';
  const now = new Date().toISOString();
  for (const [id, type] of [['related-integration-a', 'template'], ['related-integration-b', 'rule']] as const) {
    const asset = { schemaVersion: 1, ownerId: uid, id, candidateId: `seed-${id}`, reviewDecisionId: 'rd_integrationseed',
      type, title: '项目会议准备', statement: oldStatement, origin: 'manual', evidenceRefs: [], scope: 'general',
      status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', version: '1', createdAt: now, updatedAt: now } as any;
    await store.writeRecallJsonRecord(uid, 'ability-assets', id, asset);
    await assets.initializeAbilityAsset(uid, asset, { actor: 'user', reason: 'Synthetic existing fixture' });
  }
  const sourceText = '项目会议准备须记录背景事实和待决策问题，存在部署风险时另列回退条件。';
  const messages = [{ id: 'related-user', ts: '2026-10-11T00:01:00.000Z', from: 'user', to: ['commander'], text: sourceText }];
  mocks.getMessages.mockResolvedValue(messages);
  for (const message of messages) await appendJsonlAtomic(conversationMessageFile(uid, 'conv-night'), message);
  mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [sourceText]));
  mocks.run.mockReset()
    .mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: 'Reusable meeting boundary',
      evidence: [{ messageId: 'related-user', quote: sourceText }] }), meta: {} })
    .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ judgment: sourceText,
      value: '让会议准备保留部署风险的例外。', summary: '会议准备风险例外', suggestedType: 'template',
      suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }), meta: {} })
    .mockResolvedValueOnce({ text: JSON.stringify({ assessments: [{ index: 0,
      checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
        priorContentPreserved: true, evidence: [{ label: 'm1', quote: sourceText }] }, uncertaintyDisposition: 'none',
      comparison: { relation: 'duplicate', reason: '已有相近内容', targetAssetId: 'related-integration-a',
        targetVersion: '1', targetQuote: oldStatement } }] }), meta: {} });
  const stop = capture.startRecallCaptureOrchestrator();
  try {
    await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
    const directory = path.dirname(paths.recallJsonRecordPath(uid, 'captures', 'placeholder'));
    const rows = await Promise.all(fs.readdirSync(directory).filter(name => name.endsWith('.json'))
      .map(name => capture.readRecallCapture(uid, name.slice(0, -5))));
    const queued = rows.find(row => row.conversationId === 'conv-night' && row.status === 'queued')!;
    const result = await capture.runRecallCapture(uid, queued.id);
    expect(result).toMatchObject({ status: 'review_ready' });
    expect(result.candidateIds).toHaveLength(1);
    const saved = await candidates.readRecallCandidate(uid, result.candidateIds[0]);
    expect(saved).toMatchObject({ uncertainty: expect.any(String), formationComparison: { relation: 'ambiguous',
      relatedAssets: expect.arrayContaining([
        { assetId: 'related-integration-a', version: '1' },
        { assetId: 'related-integration-b', version: '1' },
      ]) } });
    expect(JSON.stringify(saved.formationComparison)).not.toContain(oldStatement);
    expect(JSON.stringify(result.formationBatchAssessment?.assessments[0].comparison)).not.toContain(oldStatement);
    const provenance = await import('../../../../src/main/features/recall/capture-provenance');
    await expect(provenance.verifyCaptureProvenanceForPromotion(uid, saved)).resolves.toBeDefined();
    await assets.updateAbilityAsset(uid, 'related-integration-b', { statement: `${oldStatement}新版本补充复核人。`,
      actor: 'user', reason: 'Synthetic concurrent change', expectedVersion: '1' });
    await expect(candidates.promoteRecallCandidate(uid, saved.id, { actor: 'user' })).rejects.toMatchObject({ code: 'baseline_changed' });
    expect((await candidates.readRecallCandidate(uid, saved.id)).status).toBe('pending_review');
  } finally { stop(); }
});

it('six-node closure: carries one nightly proposal through review, ordinary retrieval, feedback and a saved next-night correction', async () => {
  const uid = 'capture-user';
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const paths = await import('../../../../src/main/features/recall/paths');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const projection = await import('../../../../src/main/features/recall/context-projection');
  const storage = await import('../../../../src/main/storage');
  const layout = await import('../../../../src/main/util/project-layout');
  const originalMessages = await mocks.getMessages();
  for (const message of originalMessages) await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, 'conv-night'), message);
  await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
  const stop = capture.startRecallCaptureOrchestrator();
  try {
    await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
    const directory = path.dirname(paths.recallJsonRecordPath(uid, 'captures', 'placeholder'));
    const queued = await capture.readRecallCapture(uid, fs.readdirSync(directory)[0].replace(/\.json$/, ''));
    mocks.run.mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: 'Reusable meeting structure',
      evidence: [{ messageId: 'message-user', quote: originalMessages[0].text }] }), meta: {} });
    expect((await capture.runRecallCapture(uid, queued.id)).status).toBe('review_ready');
    const candidate = (await candidates.listRecallCandidates(uid))[0];
    const saved = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user' });
    const existing = await (await import('../../../../src/main/features/recall/capture-existing-assets')).selectCaptureExistingAssets(uid,
      { approvedEvidence: [{ quote: '下一次议事应事先明确议题及责任分工' }], sourceScope: { workspaceId: 'space-night' } });
    expect(existing.assets).toEqual([expect.objectContaining({ id: saved.asset.id, statement: saved.asset.statement })]);
    await assets.setAbilityAssetMaturity(uid, saved.asset.id, 'transfer_validated');
    vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '1');
    const taskText = '本轮背景资料。'.repeat(400) + '请准备项目会议，明确待决策问题、负责人和下一步行动。';
    const selected = await projection.createAutomaticContextProjection(uid, { taskRunId: 'closure-task', taskText,
      conversationId: 'conv-night', workspaceId: 'space-night' }, { embedTexts: async texts => texts.map(() => [1, 0]) });
    expect(selected?.assetIds).toEqual([saved.asset.id]);
    const executions = await import('../../../../src/main/features/execution-records');
    const receipts = await import('../../../../src/main/features/p3394/context-reuse-receipt');
    const output = '# 会议目标\n作出部署决定。\n# 背景事实\n需求尚待核对。\n# 待决策问题\n预算、日期、风险。\n# 负责人\n验收角色甲。\n# 下一步行动\n确认需求。';
    for (const [id, body, reusedRefs] of [['closure-result', output, [`asset:${saved.asset.id}@v1`]]] as const) {
      await executions.create(uid, { executionId: id, kind: 'core-agent', sessionId: `session-${id}`, boundary: 'real', permissionMode: 'read-only', conversationId: 'conv-night' });
      await receipts.prepareReceipt(uid, { executionId: id, targetSessionId: `session-${id}`, reusedRefs: [...reusedRefs], omittedRefs: [],
        permissionMode: 'read-only', allowedScopes: ['cognition:inherited'], boundary: 'real' }, { sessionId: `session-${id}` });
      await executions.complete(uid, id, { status: 'completed', output: body });
    }
    const proofs = await import('../../../../src/main/features/recall/proof-service');
    const transfer = await proofs.prepareTransferProof(uid, { projectionId: selected!.id, executionId: 'closure-result', expectedResultSnapshot: '项目会议准备须包含背景事实、待决策问题、负责人和下一步行动。' });
    await proofs.completeTransferProofWithReceipt(uid, transfer.id, { status: 'succeeded', receiptExecutionId: 'closure-result', observedTransfer: 'Template used in persisted result.' });
    const answer = { id: 'closure-answer', ts: new Date().toISOString(), from: 'commander', to: ['user'], turn_id: 'closure-task', text: output };
    await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, 'conv-night'), answer);
    mocks.getMessages.mockResolvedValue([...originalMessages, answer]);
    const feedback = await import('../../../../src/main/features/recall/effectiveness-feedback');
    const assessed = await feedback.recordEffectivenessFeedback(uid, { transferProofId: transfer.id, feedback: 'positive', note: '模板帮助补齐背景事实。' });
    // Positive feedback records an evaluation, but it does not claim a verified
    // effect without a traceable result comparison.
    expect(assessed).toMatchObject({ outcome: 'insufficient_evidence' });
    expect(assessed).not.toHaveProperty('comparison');
    expect((await assets.readAbilityAsset(uid, saved.asset.id)).maturity).toBe('transfer_validated');
    const nightly = await import('../../../../src/main/features/recall/nightly-feedback');
    expect(await nightly.queuedNightlyFeedback(uid)).toEqual([expect.objectContaining({ assetId: saved.asset.id, assetVersion: '1', messageId: answer.id })]);
    const correctedBody = `${saved.asset.statement}项目有部署风险时，另列风险与回退条件；没有部署风险时继续沿用原来的会议准备结构。`;
    const correction = { id: 'closure-correction', ts: '2026-10-12T04:00:00.000Z', from: 'user', to: ['commander'],
      text: `此前的会议准备结构继续保留。请以后按下面完整版本准备：${correctedBody}` };
    await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, 'conv-night'), correction);
    mocks.getMessages.mockResolvedValue([...originalMessages, answer, correction]);
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
    expect(await nightly.queuedNightlyFeedback(uid)).toEqual([]);
    const all = await Promise.all(fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => capture.readRecallCapture(uid, name.slice(0, -5))));
    expect(all).toContainEqual(expect.objectContaining({ feedbackObservations: [expect.objectContaining({ messageId: answer.id, assetId: saved.asset.id })] }));
    const nextNight = all.find(row => row.feedbackObservations?.some(item => item.messageId === answer.id))!;
    mocks.runSummary.mockImplementation(input => captureSummaryModelResponseWithEvidence(input, [correction.text]));
    mocks.run.mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: '用户明确补充原模板的部署风险例外。',
      evidence: [{ messageId: correction.id, quote: correction.text }] }), meta: {} });
    let correctionLabel = '';
    mocks.run.mockImplementationOnce(async input => {
      const request = JSON.parse(input.message);
      expect(request.existingAssets).toBeUndefined();
      expect(request.messages).toContainEqual(expect.objectContaining({ id: answer.id,
        observations: [expect.objectContaining({ assetId: saved.asset.id, assetVersion: '1', feedback: 'positive' })] }));
      const evidence = request.approvedEvidence.find((item: any) => item.messageId === correction.id);
      expect(evidence).toBeDefined();
      const source = request.messages.find((item: any) => item.id === evidence.messageId);
      correctionLabel = source.label;
      return { text: JSON.stringify({ candidates: [{ judgment: correctedBody, value: '保留原模板并补足部署风险场景的准备边界。',
        summary: '项目会议准备风险例外', suggestedType: 'template', suggestedScope: 'general', suggestedAction: 'create',
        risk: 'low', evidence: [source.label] }] }), meta: {} };
    }).mockImplementationOnce(async input => {
      const request = JSON.parse(input.message);
      expect(request.existingAssets).toContainEqual(expect.objectContaining({ id: saved.asset.id, version: '1', statement: saved.asset.statement }));
      expect(request.candidates).toHaveLength(1);
      expect(request.candidates[0]).toMatchObject({ sourceProposal: true });
      return { text: JSON.stringify({ assessments: [{ index: request.candidates[0].index,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
          priorContentPreserved: true, evidence: [{ label: correctionLabel, quote: correction.text }] },
        uncertaintyDisposition: 'none',
        comparison: { relation: 'exception', reason: 'The deployment-risk exception preserves the prior meeting structure.',
          targetAssetId: saved.asset.id, targetVersion: '1', targetQuote: saved.asset.statement },
        revision: { judgment: correctedBody },
      }] }), meta: {} };
    });
    expect((await capture.runRecallCapture(uid, nextNight.id)).status).toBe('review_ready');
    const update = (await candidates.listRecallCandidates(uid)).find(row => row.status === 'pending_review' && row.targetAssetId === saved.asset.id)!;
    expect(update).toMatchObject({ targetVersionUsed: '1', judgment: correctedBody });
    await candidates.promoteRecallCandidate(uid, update.id, { actor: 'user' });
    const revised = await assets.readAbilityAsset(uid, saved.asset.id);
    expect(revised.statement).toBe(correctedBody);
    expect(revised.version).toBe('2');
    expect(await assets.readAbilityAssetVersionSnapshot(uid, saved.asset.id, '1')).toMatchObject({ statement: saved.asset.statement });
  } finally { stop(); vi.unstubAllEnvs(); }
});
it('uses real candidate persistence after context summary, value judgment and extraction while formal assets await user confirmation', async () => {
  mocks.getConversation.mockResolvedValue({ conversation_id: 'conv-night', title: 'Project meeting', space_id: 'space-night', project_id: 'project-night' });
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const paths = await import('../../../../src/main/features/recall/paths');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  // The default manual policy preserves the complete nightly proposal for review.
  await settings.updateRecallCaptureSettings('capture-user', { autoApproval: false });
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  for (const message of await mocks.getMessages()) await appendJsonlAtomic(conversationMessageFile('capture-user', 'conv-night'), message);
  const stop = capture.startRecallCaptureOrchestrator();
  const window = new Date(2026, 9, 12, 3).toISOString();
  await capture.runNightlyCaptureSweep('capture-user', window, await settings.readRecallCaptureSettings('capture-user'));
  const directory = path.dirname(paths.recallJsonRecordPath('capture-user', 'captures', 'placeholder'));
  const [name] = fs.readdirSync(directory);
  const queued = await capture.readRecallCapture('capture-user', name.replace(/\.json$/, ''));
  const original = (await mocks.getMessages())[0].text;
  mocks.run.mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: 'Reusable user-supplied meeting structure',
    evidence: [{ messageId: 'message-user', quote: original }] }), meta: {} });
  const result = await capture.runRecallCapture('capture-user', queued.id);
  stop();
  const saved = await candidates.listRecallCandidates('capture-user');
  expect(saved).toHaveLength(1);
  expect(mocks.runSummary).toHaveBeenCalledTimes(1);
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(mocks.buildRunner.mock.calls.map(call => call[0].sessionId)).toEqual([
    expect.stringMatching(/memory-summary/), expect.stringMatching(/memory-value/), expect.stringMatching(/memory-extract/),
  ]);
  expect(result.contextSummary?.coverage).toMatchObject({ messageCount: 2 });
  expect(result.status).toBe('review_ready');
  expect(saved[0]).toMatchObject({ status: 'pending_review', scopePolicy: { workspaceIds: ['space-night'], projectIds: ['project-night'] },
    captureProvenance: { pipeline: 'nightly_conversation', valueJudgment: { eligible: true }, extractionCompletedAt: expect.any(String) } });
  expect(saved[0].sourceRefs.find(ref => ref.subtype === 'message')).toMatchObject({
    locator: { conversationId: 'conv-night', messageId: 'message-user' }, sourceVersion: expect.stringMatching(/^sha256:/),
  });
  expect(saved[0].promotedAssetId).toBeUndefined();
  expect(await assets.listAbilityAssets('capture-user')).toHaveLength(0);
  expect(candidates).not.toHaveProperty('approveNewNightlyRecallCandidate');
});

it.each([false, true])('automatically completes and reverses a supported preference while an independent topic remains unresolved (joint: %s)', async joint => {
  const quote = '我以后希望回答先给结论，再列出关键依据，并明确标注尚未验证的内容。';
  const question = '另外，部署窗口具体安排在哪一天？这个问题还没有确定。';
  mocks.getConversation.mockResolvedValue({ conversation_id: 'conv-night', title: '回答偏好和部署讨论' });
  mocks.getMessages.mockResolvedValue([
    { id: 'message-user', ts: '2026-10-11T00:01:00.000Z', from: 'user', to: ['commander'], text: quote },
    { id: 'message-unresolved', ts: '2026-10-11T00:02:00.000Z', from: 'user', to: ['commander'], text: question },
    { id: 'message-assistant', ts: '2026-10-11T00:03:00.000Z', from: 'commander', to: ['user'], text: '回答偏好已明确；部署窗口需要另外核对。' },
  ]);
  mocks.runSummary.mockImplementation(async (input: { message: string }) => {
    const request = JSON.parse(input.message);
    if (request.stage === 'chunk') return { text: JSON.stringify({
      coveredIds: request.segments.map((entry: any) => entry.id),
      topics: request.segments.filter((entry: any) => entry.role === 'user').map((entry: any) => ({
        title: entry.messageId === 'message-user' ? '长期回答偏好' : '部署时间待定', content: entry.text,
        conditions: [], unresolved: entry.messageId === 'message-user' ? [] : ['部署时间仍待核对'],
        attribution: entry.messageId === 'message-user' ? 'user_requirement' : 'source_observation',
        evidence: [{ messageId: entry.messageId, quote: entry.text }],
      })),
    }), meta: {} };
    return { text: JSON.stringify({ coveredIds: request.inputs.map((entry: any) => entry.id),
      topics: request.inputs.flatMap((entry: any) => entry.topics.map((topic: any) => ({ ...topic, id: undefined, inputIds: [topic.id] }))) }), meta: {} };
  });
  mocks.run.mockReset()
    .mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: '明确的长期回答偏好可以用于后续沟通', evidence: [{ messageId: 'message-user', quote }] }), meta: {} })
    .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ ...(joint ? { ontologyChanges: { reason: 'Preserve the approved answer preference as its shared rule.', evidence: ['m1'], actions: [{ intent: 'create', recordId: 'answer-rule', sourceLabel: 'Approved user preference', record: { kind: 'rule', moduleId: 'personal', name: '回答结构偏好', requirement: quote, strength: 'default', condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' } }], refs: [{ moduleId: 'personal', recordId: 'answer-rule', versionPolicy: 'current', sharedBody: true }] } } : {}), judgment: quote, value: '长期保持清晰表达和证据边界，提升后续沟通效率。', summary: '回答结构偏好', suggestedType: 'personal', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }), meta: {} });
  const checks = { supported: true, noUnsupportedClaims: true, scopePreserved: true,
    finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label: 'm1', quote }] };
  const sourceRuleConclusions = [{ recordId: 'answer-rule', status: 'resolved',
    expectedContract: { strength: 'default', condition: { kind: 'task', field: 'purpose', equals: 'answer' }, effect: { kind: 'note' }, exception: '' },
    topicEvidence: [{ label: 'm1', quote }], fieldEvidence: {
      strength: [{ label: 'm1', quote }], condition: [{ label: 'm1', quote }], effect: [], exception: [] } }];
  // Formation and persisted automatic support are separate protocol boundaries.
  if (joint) mocks.run.mockResolvedValueOnce({ text: JSON.stringify({ assessments: [{ index: 0, checks,
    uncertaintyDisposition: 'none', sourceRuleConclusions }] }), meta: {} });
  mocks.run.mockResolvedValueOnce({ text: JSON.stringify({ ...checks,
    ...(joint ? { sourceRuleConclusions } : {}) }), meta: {} });
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const paths = await import('../../../../src/main/features/recall/paths');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const journal = await import('../../../../src/main/features/cognition/review-decision');
  await settings.updateRecallCaptureSettings('capture-user', { autoApproval: true });
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  for (const message of await mocks.getMessages()) await appendJsonlAtomic(conversationMessageFile('capture-user', 'conv-night'), message);
  const stop = capture.startRecallCaptureOrchestrator();
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  await bridge.replaceCognitionSources('capture-user', { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
  await ontology.commitOntologyCommand('capture-user', { commandId: 'seed-personal', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal', sourceLabel: 'Existing structure', record: { kind: 'module', name: '我的本体', description: '', scope: { kind: 'personal' } } }] });
  try {
    await capture.runNightlyCaptureSweep('capture-user', new Date(2026, 9, 12, 3).toISOString(), await settings.readRecallCaptureSettings('capture-user'));
    const directory = path.dirname(paths.recallJsonRecordPath('capture-user', 'captures', 'placeholder'));
    const [file] = fs.readdirSync(directory);
    const result = await capture.runRecallCapture('capture-user', file.replace(/\.json$/, ''));
    expect(result.status).toBe('completed');
    expect(mocks.buildRunner.mock.calls.map(call => call[0].sessionId)).toEqual([
      expect.stringMatching(/^memory-summary-/), expect.stringMatching(/^memory-value-/), expect.stringMatching(/^memory-extract-/),
      ...(joint ? [expect.stringMatching(/^memory-formation-recall-/)] : []),
      expect.stringMatching(/^one-shot-automatic-support-/),
    ]);
    expect(result.contextSummary?.topics.some(topic => topic.unresolved.length > 0)).toBe(true);
    const [candidate] = await candidates.listRecallCandidates('capture-user');
    expect(candidate).toMatchObject({ status: 'confirmed', autoReview: { eligible: true } });
    expect(await journal.readReviewDecision('capture-user', `recall_candidate:${candidate.id}`, candidate.reviewDecisionId)).toMatchObject({ actor: 'system', decision: 'automatic low-risk approval' });
    const undo = await import('../../../../src/main/features/recall/automatic-formation-undo');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const preview = await undo.previewAutomaticFormationUndo('capture-user', candidate.id);
    expect(preview.assetChange).toMatchObject({ action: 'delete', assetId: candidate.promotedAssetId });
    expect(preview.ontologyChanges.length).toBe(joint ? 1 : 0);
    await undo.undoAutomaticFormation('capture-user', candidate.id, preview.token);
    expect((await assets.readAbilityAsset('capture-user', candidate.promotedAssetId!)).status).toBe('deleted');
    expect((await candidates.readRecallCandidate('capture-user', candidate.id)).automaticUndo).toBeDefined();
    if (joint) expect(ontology.readOntologyDocument('capture-user').records['answer-rule']).toMatchObject({ status: 'archived', requirement: quote });
    expect(await undo.undoAutomaticFormation('capture-user', candidate.id, preview.token)).toMatchObject({ alreadyUndone: true });

  } finally { stop(); }
});

it('preserves complete supported boundaries instead of silently slicing later exceptions', async () => {
  const { parseRecallCaptureOutput } = await import('../../../../src/main/features/recall/capture-service');
  const conditions = Array.from({ length: 12 }, (_, index) => `条件${index}：` + '完整条件文字。'.repeat(45) + '末尾保留仅限项目甲。');
  const raw = { candidates: [{ judgment: '项目甲会议使用完整结构，并保留每一项适用条件和例外。', value: '让末尾的限制在保存和使用时仍然生效。', summary: '完整条件保留', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'], applicableWhen: conditions }] };
  expect(parseRecallCaptureOutput(JSON.stringify(raw), new Set(['m1']))[0].applicableWhen).toEqual(conditions);
  const oversized = { ...raw.candidates[0], applicableWhen: ['完整条件。'.repeat(110)] };
  expect(parseRecallCaptureOutput(JSON.stringify({ candidates: [oversized] }), new Set(['m1']))).toEqual([]);
});
