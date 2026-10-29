/** Exercises the actual nightly summary/value/extraction/save sequence. Only
 * provider calls and conversation catalogs use isolated synthetic doubles. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureSummaryModelResponse } from '../../../helpers/capture-summary-model';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
const mocks = vi.hoisted(() => ({ summary: vi.fn(), value: vi.fn(), extract: vi.fn(), formation: vi.fn(), buildRunner: vi.fn(),
  getMessages: vi.fn(), getMessagesPage: vi.fn(), getConversation: vi.fn(), listConversations: vi.fn() }));
vi.mock('../../../../src/main/features/auth', () => ({
  listEntriesForUser: async () => ({ entries: [{ provider: 'synthetic-configured-provider', model: 'synthetic-configured-model' }] }),
  hasConfiguredModelForUser: () => ({ configured: true }),
  getConfiguredModelOAuthExpiredMessageForUser: () => null,
 hasConfiguredModel: () => ({ configured: true }), getConfiguredModelOAuthExpiredMessage: () => null }));
vi.mock('../../../../src/main/features/chats', () => ({ getMessages: mocks.getMessages, getMessagesPage: mocks.getMessagesPage,
  getConversation: mocks.getConversation, listConversations: mocks.listConversations }));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: mocks.buildRunner }));
vi.mock('../../../../src/main/features/kb_embed', () => ({ closeEmbedder: vi.fn(), embedQuery: async () => { throw new Error('no optional embedding needed for isolated formation'); } }));
// The nightly sweep's finally block awaits its admitted capture tasks
// (Promise.allSettled over control.tasks). A never-resolving scheduled
// promise therefore hangs every fixture() sweep; resolve like the sweep
// harness does — this file never starts the rescheduling sweep loop, whose
// anti-spin guard is the one place an unresolved promise is required.
vi.mock('../../../../src/main/util/boot_init', () => ({ registerDeferred: () => {}, scheduleBootBackground: () => ({ cancel: vi.fn(), promise: Promise.resolve() }) }));
const userId = 'repair-user';
const source = '请在后续项目会议反复复用以下会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。';
const valid = { judgment: '会议准备模板：会议目标、背景事实、三个待决策问题、负责人和下一步行动。',
  value: '供后续项目会议复用，减少重复准备并使决策责任清晰。', summary: '项目会议准备模板', contentCategory: 'template',
  suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'] };
const missingScope = () => { const { suggestedScope: _scope, ...missing } = valid; return missing; };
const response = (candidates: unknown[], usage?: Record<string, unknown>) => ({ text: JSON.stringify({ candidates }), meta: { ...(usage ? { usage } : {}) } });
let root: string, previous: string | undefined;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  mocks.summary.mockReset().mockImplementation(captureSummaryModelResponse);
  mocks.value.mockReset().mockResolvedValue({ text: JSON.stringify({ eligible: true, reason: '明确需要长期复用会议准备结构', evidence: [{ messageId: 'message-user', quote: source }] }), meta: {} });
  mocks.extract.mockReset().mockResolvedValue(response([valid]));
  mocks.formation.mockReset().mockImplementation((input: { message: string }) => {
    const { candidates } = JSON.parse(input.message);
    return { text: JSON.stringify({ assessments: candidates.map((item: { index: number; candidate: { uncertainty?: string }; sources: Array<{ label: string; approvedQuotes: string[] }> }) => ({
      index: item.index, checks: supportedChecks(item.sources[0].approvedQuotes[0], item.sources[0].label),
      uncertaintyDisposition: item.candidate.uncertainty ? 'effect_unverified' : 'none',
      comparison: { relation: 'new', reason: 'The source supports a new cognition proposal.' },
    })) }), meta: {} };
  });
  mocks.buildRunner.mockReset().mockImplementation(async (options: { sessionId: string }) => {
    const run = options.sessionId.startsWith('memory-summary-') ? mocks.summary : options.sessionId.startsWith('memory-value-') ? mocks.value
      : options.sessionId.startsWith('memory-formation-recall-') ? mocks.formation
        : options.sessionId.startsWith('memory-extract-') ? mocks.extract : undefined;
    if (!run) throw new Error(`Unexpected capture model session: ${options.sessionId}`);
    return { runner: { run } };
  });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 12, 3));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-extraction-repair-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  mocks.getConversation.mockResolvedValue({ conversation_id: 'conv-repair', title: 'Synthetic meeting preparation' });
  mocks.getMessages.mockResolvedValue([
    { id: 'message-user', ts: '2026-10-11T00:01:00.000Z', from: 'user', to: ['commander'], text: source },
    { id: 'message-assistant', ts: '2026-10-11T00:02:00.000Z', from: 'commander', to: ['user'], text: '可在后续会议使用这份包含目标、背景、决策问题、负责人和下一步行动的模板。' },
  ]);
  mocks.getMessagesPage.mockImplementation(async () => ({ history: await mocks.getMessages(), nextCursor: null }));
  mocks.listConversations.mockResolvedValue([{ conversation_id: 'conv-repair', title: 'Synthetic meeting preparation', updated_at: '2026-10-11T00:02:00.000Z' }]);
});
afterEach(async () => { vi.useRealTimers(); await drainMainRuntimeForTest(userId); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const paths = await import('../../../../src/main/features/recall/paths');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  for (const message of await mocks.getMessages()) await appendJsonlAtomic(conversationMessageFile(userId, 'conv-repair'), message);
  await settings.updateRecallCaptureSettings(userId, { autoApproval: false });
  const stop = capture.startRecallCaptureOrchestrator();
  await capture.runNightlyCaptureSweep(userId, new Date(2026, 9, 12, 3).toISOString(), await settings.readRecallCaptureSettings(userId));
  const directory = path.dirname(paths.recallJsonRecordPath(userId, 'captures', 'placeholder'));
  const [name] = fs.readdirSync(directory);
  return { capture, candidates, assets, settings, id: name.replace(/\.json$/, ''), stop };
}
function extractionOptions() { return mocks.buildRunner.mock.calls.map(call => call[0]).filter(options => options.sessionId.startsWith('memory-extract-')); }

it('regenerates an unowned top-level ontology plan once from the identical source, target, ontology and configured route', async () => {
  const f = await fixture();
  try {
    const { createNightlyCandidateFixture } = await import('../../../helpers/nightly-formation-fixture');
    const previousBody = '会议准备模板：会议目标、背景事实、两个待决策问题、负责人和下一步行动。';
    const previous = await createNightlyCandidateFixture(userId, { judgment: previousBody,
      value: valid.value, summary: valid.summary, contentCategory: 'template', suggestedType: 'cognition',
      suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [], rawStatement: true });
    const target = (await f.candidates.promoteRecallCandidate(userId, previous.id, { actor: 'user' })).asset;
    const ontology = await import('../../../../src/main/features/cognition/ontology/service');
    await ontology.commitOntologyCommand(userId, { commandId: 'repair-synthetic-structure', expectedRevision: 0, actions: [
      { intent: 'create', recordId: 'meeting-module', sourceLabel: 'Synthetic existing meeting structure',
        record: { kind: 'module', name: '隔离会议模板', description: '', scope: { kind: 'personal' } } },
      { intent: 'create', recordId: 'meeting-rule', sourceLabel: 'Synthetic earlier meeting template',
        record: { kind: 'rule', moduleId: 'meeting-module', name: '会议准备结构', requirement: previousBody,
          strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } },
    ] });
    const route = [{ provider: 'synthetic-configured-provider', model: 'synthetic-configured-model' }];
    await f.settings.updateRecallCaptureSettings(userId, { modelCandidates: route });
    const update = { ...valid, suggestedAction: 'update', targetAssetId: target.id };
    const plan = { reason: '用户明确增加为三个待决策问题', evidence: ['m1'],
      actions: [{ intent: 'update', recordId: 'meeting-rule', expectedVersion: 1, sourceLabel: '用户完整新模板',
        patch: { requirementSource: 'cognition_body' } }],
      refs: [{ moduleId: 'meeting-module', recordId: 'meeting-rule', versionPolicy: 'current', sharedBody: true }] };
    mocks.extract.mockResolvedValueOnce({ text: JSON.stringify({ candidates: [update], ontologyChanges: plan }), meta: {} })
      .mockResolvedValueOnce(response([{ ...update, ontologyChanges: plan }]));
    mocks.formation.mockResolvedValueOnce({ text: JSON.stringify({ assessments: [{ index: 0, checks: supportedChecks(source),
      uncertaintyDisposition: 'none', comparison: { relation: 'changed', targetAssetId: target.id, targetVersion: target.version,
        targetQuote: previousBody, reason: '用户明确把同一会议模板的待决策问题更新为三个。' },
      revision: { judgment: valid.judgment },
      sourceRuleConclusions: [{ recordId: 'meeting-rule', status: 'resolved',
        expectedContract: { strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' },
        topicEvidence: [{ label: 'm1', quote: source }],
        fieldEvidence: { strength: [{ label: 'm1', quote: source }], condition: [], effect: [], exception: [] } }],
    }] }), meta: {} });
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'review_ready', extractionRepairAttempted: true });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(mocks.formation).toHaveBeenCalledTimes(1);
    const [first, repair] = extractionOptions();
    expect(first.modelCandidates).toEqual(route); expect(repair.modelCandidates).toEqual(route);
    expect(repair.systemPrompt).toContain('Each group owns its complete cognition or ontology explanation and its evidence.');
    expect(repair.systemPrompt).toContain('Never borrow an unowned top-level plan');
    expect(mocks.extract.mock.calls[1][0].message).toBe(mocks.extract.mock.calls[0][0].message);
    const input = JSON.parse(mocks.extract.mock.calls[1][0].message);
    expect(input.approvedEvidence).toEqual([expect.objectContaining({ quote: source, messageId: 'message-user' })]);
    expect(input.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: source })]));
    // 提取阶段只产出源提案；已有资产只在形成判断里出现。
    expect(input.existingAssets).toBeUndefined();
    const formationInput = JSON.parse(mocks.formation.mock.calls[0][0].message);
    expect(formationInput.existingAssets).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id, version: target.version, statement: previousBody })]));
    expect(formationInput.ontology.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'meeting-rule', requirement: previousBody, version: 1 })]));
    const pending = (await f.candidates.listRecallCandidates(userId)).filter(row => row.status === 'pending_review');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ judgment: valid.judgment, targetAssetId: target.id, targetVersionUsed: target.version,
      ontologyFormation: { blockedReasons: [], actions: [{ intent: 'update', patch: { requirement: valid.judgment } }] } });
    expect(await f.assets.readAbilityAsset(userId, target.id)).toMatchObject({ statement: previousBody, version: target.version });
    expect(ontology.readOntologyDocument(userId).records['meeting-rule']).toMatchObject({ requirement: previousBody, version: 1 });
  } finally { f.stop(); }
});

it('fails after a second unowned top-level plan without saving candidates or silently accepting an empty result', async () => {
  const unowned = { reason: '未所属的计划', evidence: ['m1'], actions: [], refs: [] };
  mocks.extract.mockResolvedValueOnce({ text: JSON.stringify({ candidates: [valid], ontologyChanges: unowned }), meta: {} })
    .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [], ontologyChanges: unowned, reason: '模型重发仍没有所属' }), meta: {} });
  const f = await fixture();
  try {
    expect(await f.capture.runRecallCapture(userId, f.id)).toMatchObject({ status: 'failed',
      errorCode: 'invalid_model_output', extractionRepairAttempted: true, candidateIds: [] });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('repairs missing scope once from the same complete source and aggregates only actual numeric usage', async () => {
  mocks.extract.mockResolvedValueOnce(response([missingScope()], { inputTokens: 10, outputTokens: 3, totalTokens: 13 }))
    .mockResolvedValueOnce(response([valid], { inputTokens: 7, outputTokens: 2, totalTokens: 9 }));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'review_ready', extractionRepairAttempted: true, modelUsage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 } });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    const [first, repair] = extractionOptions();
    expect(first.sessionId).toMatch(/^memory-extract-recall-/); expect(repair.sessionId).toMatch(/^memory-extract-repair-/);
    expect(mocks.extract.mock.calls[1][0].message).toBe(mocks.extract.mock.calls[0][0].message);
    expect(repair.systemPrompt).toContain('Do not guess a missing scope');
    expect(JSON.parse(mocks.extract.mock.calls[1][0].message)).toEqual(JSON.parse(mocks.extract.mock.calls[0][0].message));
    const [candidate] = await f.candidates.listRecallCandidates(userId);
    expect(candidate).toMatchObject({ judgment: valid.judgment, suggestedScope: 'general', status: 'pending_review' });
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it.each(['not JSON', '{"candidates":[', JSON.stringify({ candidates: [missingScope()] })])('does not weakly accept or infinitely retry two invalid extractions beginning with %s', async initial => {
  mocks.extract.mockResolvedValueOnce({ text: initial, meta: {} }).mockResolvedValueOnce(response([missingScope()]));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ extractionRepairAttempted: true, status: 'no_candidate', filterReason: 'candidate_unparsable' });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('keeps a valid partial batch without retrying or replacing its original proposal', async () => {
  mocks.extract.mockResolvedValueOnce(response([missingScope(), valid]));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('review_ready');
    expect(result.extractionRepairAttempted).toBeUndefined();
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    const candidates = await f.candidates.listRecallCandidates(userId);
    expect(candidates).toHaveLength(1); expect(candidates[0].judgment).toBe(valid.judgment);
  } finally { f.stop(); }
});

it('keeps a valid partial versioned batch without retrying and reports the model-emitted count', async () => {
  // One proposal violates its own schema (missing suggestedScope); its valid
  // sibling must survive without paying the bounded format repair.
  mocks.extract.mockResolvedValueOnce({ text: JSON.stringify({ proposalVersion: 2, proposals: [
    { id: 'incomplete', target: 'cognition', cognition: missingScope() },
    { id: 'complete', target: 'cognition', cognition: valid },
  ] }), meta: {} });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('review_ready');
    expect(result.extractionRepairAttempted).toBeUndefined();
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(result.formationCheckpoint).toMatchObject({ parsedCount: 1, emittedCount: 2 });
    const candidates = await f.candidates.listRecallCandidates(userId);
    expect(candidates).toHaveLength(1); expect(candidates[0].judgment).toBe(valid.judgment);
  } finally { f.stop(); }
});

it('repairs once when every versioned proposal violates the contract, then settles unparsable', async () => {
  const allInvalid = { text: JSON.stringify({ proposalVersion: 2, proposals: [
    { id: 'incomplete', target: 'cognition', cognition: missingScope() }] }), meta: {} };
  mocks.extract.mockResolvedValueOnce(allInvalid).mockResolvedValueOnce(allInvalid);
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'no_candidate', extractionRepairAttempted: true, filterReason: 'candidate_unparsable' });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('does not repair a legitimate explicit empty result', async () => {
  mocks.extract.mockResolvedValueOnce({ text: JSON.stringify({ candidates: [], reason: 'source does not justify a new proposal' }), meta: {} });
  const f = await fixture();
  try {
    expect(await f.capture.runRecallCapture(userId, f.id)).toMatchObject({ status: 'no_candidate', filterReason: 'model_no_candidate' });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('strictly rejects a fabricated evidence label in the repaired output', async () => {
  mocks.extract.mockResolvedValueOnce(response([missingScope()])).mockResolvedValueOnce(response([{ ...valid, evidence: ['fabricated-source'] }]));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'no_candidate', extractionRepairAttempted: true, filterReason: 'candidate_unparsable' });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('does not allow a repaired assistant-only citation to establish durable user intent', async () => {
  mocks.extract.mockResolvedValueOnce(response([missingScope()])).mockResolvedValueOnce(response([{ ...valid, evidence: ['m2'] }]));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'no_candidate', extractionRepairAttempted: true, filterReason: 'candidate_quality' });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it.each(['before_repair', 'during_repair'])('keeps the frozen capture retryable and saves nothing when the window closes %s', async timing => {
  mocks.extract.mockImplementationOnce(async () => {
    if (timing === 'before_repair') vi.setSystemTime(new Date(2026, 9, 12, 6));
    return response([missingScope()]);
  }).mockImplementationOnce(async () => { vi.setSystemTime(new Date(2026, 9, 12, 6)); return response([valid]); });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('queued');
    expect(result.candidateIds).toEqual([]);
    expect(mocks.extract).toHaveBeenCalledTimes(timing === 'before_repair' ? 1 : 2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('preserves interruption during repair rather than saving a complete-looking late output', async () => {
  const controller = new AbortController();
  mocks.extract.mockResolvedValueOnce(response([missingScope()])).mockImplementationOnce(async () => { controller.abort(); return response([valid]); });
  const f = await fixture();
  try {
    expect(await f.capture.runRecallCapture(userId, f.id, controller.signal)).toMatchObject({ status: 'queued', candidateIds: [] });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

function replaceSource(text: string, assistant = '已保留这项明确陈述及其条件，后续仍应核对实际证据。') {
  mocks.getMessages.mockResolvedValue([
    { id: 'message-user', ts: '2026-10-11T00:01:00.000Z', from: 'user', to: ['commander'], text },
    { id: 'message-assistant', ts: '2026-10-11T00:02:00.000Z', from: 'commander', to: ['user'], text: assistant },
  ]);
  mocks.value.mockResolvedValue({ text: JSON.stringify({ eligible: true, reason: '明确的长期复用内容及真实用户陈述', evidence: [{ messageId: 'message-user', quote: text }] }), meta: {} });
}
const methodBody = '排查方法：记录请求时间线，先核对超时起止边界，再比较同一请求的重试和依赖耗时；分别验证网络与服务端假设，证据不足时停止归因并保留未验证状态。';
const methodSource = `请在后续故障排查中反复复用这套${methodBody}`;
const method = { ...valid, judgment: methodBody, summary: '超时故障排查方法', contentCategory: 'method',
  value: '供后续类似超时故障排查复用完整步骤，减少没有证据的归因。',
  applicableWhen: ['处理有请求时间线的超时故障'], forbiddenWhen: ['证据不足时直接判断原因'],
  uncertainty: '该方法尚未在任何具体故障案例中使用或验证效果。' };
function supportedChecks(quote: string, label = 'm1') { return { supported: true, noUnsupportedClaims: true,
  scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label, quote }] }; }
const formationResponse = (checks: ReturnType<typeof supportedChecks>, uncertaintyDisposition = 'none') => ({
  text: JSON.stringify({ assessments: [{ index: 0, checks, uncertaintyDisposition,
    comparison: { relation: 'new', reason: 'The source supports a new cognition proposal.' } }] }), meta: {} });
const supportedUncertainty = (disposition: string, quote: string) => formationResponse(supportedChecks(quote), disposition);

it('forms an untested complete method through independent uncertainty checking while preserving exact body and boundaries for human review', async () => {
  replaceSource(methodSource);
  mocks.extract.mockResolvedValueOnce(response([method]));
  mocks.formation.mockResolvedValueOnce(supportedUncertainty('effect_unverified', methodBody));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('review_ready');
    expect(mocks.extract).toHaveBeenCalledTimes(1); expect(mocks.formation).toHaveBeenCalledTimes(1);
    const [candidate] = await f.candidates.listRecallCandidates(userId);
    expect(candidate).toMatchObject({ status: 'pending_review', judgment: method.judgment, suggestedScope: method.suggestedScope,
      applicableWhen: method.applicableWhen, forbiddenWhen: method.forbiddenWhen });
    expect(candidate.uncertainty).toBeUndefined(); expect(candidate.reviewDecisionId).toBeUndefined();
    expect(candidate.autoReview).toBeUndefined(); expect(candidate.promotedAssetId).toBeUndefined();
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
    const payload = JSON.parse(mocks.formation.mock.calls[0][0].message);
    expect(payload.candidates[0].candidate.uncertainty).toBe(method.uncertainty);
    expect(payload.candidates[0].candidate.judgment).toBe(method.judgment);
    expect(payload.completeConversationContext).toEqual([
      expect.objectContaining({ role: 'user', text: methodSource }), expect.objectContaining({ role: 'assistant' }),
    ]);
    expect(result.uncertaintyAssessments).toEqual([expect.objectContaining({ candidateIndex: 0, nonBlocking: true,
      modelCompleted: true, uncertaintyDisposition: 'effect_unverified', method: 'model_assisted',
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      inputHash: expect.stringMatching(/^[a-f0-9]{64}$/), evidence: [{ label: 'm1', messageId: 'message-user',
        start: methodSource.indexOf(methodBody), end: methodSource.indexOf(methodBody) + methodBody.length,
        quoteHash: expect.stringMatching(/^[a-f0-9]{64}$/) }] })]);
    const audit = JSON.stringify(result.uncertaintyAssessments);
    expect(audit).not.toContain(methodBody); expect(audit).not.toContain(method.uncertainty);
    expect(audit).not.toContain(methodSource);
  } finally { f.stop(); }
});

it('retains mixed substantive scope uncertainty instead of blanking it because effects are also unverified', async () => {
  replaceSource(methodSource);
  const uncertain = { ...method, uncertainty: '该方法效果尚未验证；适用的具体项目和故障范围也尚未确定。' };
  mocks.extract.mockResolvedValueOnce(response([uncertain]));
  mocks.formation.mockResolvedValueOnce(supportedUncertainty('content_unresolved', methodBody));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'no_candidate', filterReason: 'candidate_quality' });
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(result.uncertaintyAssessments).toEqual([expect.objectContaining({ nonBlocking: false, uncertaintyDisposition: 'content_unresolved' })]);
    expect(JSON.parse(mocks.formation.mock.calls[0][0].message).candidates[0].candidate.uncertainty).toBe(uncertain.uncertainty);
    expect(mocks.extract).toHaveBeenCalledTimes(1); expect(mocks.formation).toHaveBeenCalledTimes(1);
  } finally { f.stop(); }
});

it.each(['unresolved', 'not_supported'])('keeps a supported body with %s rule semantics for human review without a model retry', async status => {
  mocks.extract.mockResolvedValueOnce(response([{ ...valid, ontologyChanges: { reason: 'Synthetic meeting rule', evidence: ['m1'],
    actions: [{ intent: 'create', recordId: 'meeting-module', sourceLabel: 'Synthetic meeting source', record: { kind: 'module', name: 'Meeting preparation' } },
      { intent: 'create', recordId: 'meeting-rule', sourceLabel: 'Synthetic meeting source',
        record: { kind: 'rule', moduleId: 'meeting-module', name: 'Meeting preparation', requirementSource: 'cognition_body',
          strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }],
    refs: [{ moduleId: 'meeting-module', recordId: 'meeting-rule', versionPolicy: 'current', sharedBody: true }],
  } }]));
  mocks.formation.mockResolvedValueOnce({ text: JSON.stringify({ assessments: [{ index: 0, checks: supportedChecks(source),
    uncertaintyDisposition: 'none', sourceRuleConclusions: [{ recordId: 'meeting-rule', status, reason: 'Rule force needs human confirmation.' }] }] }), meta: {} });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('review_ready');
    expect(result.formationCheckpoint?.pendingCandidates).toEqual([]);
    const [candidate] = await f.candidates.listRecallCandidates(userId);
    expect(candidate).toMatchObject({ status: 'pending_review', judgment: valid.judgment,
      ontologyFormation: { blockedReasons: expect.arrayContaining(['rule_source_assessment_required']) } });
    expect(candidate.uncertainty).toContain('人工核对');
    expect(candidate.promotedAssetId).toBeUndefined();
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    await f.capture.runNightlyCaptureSweep(userId, new Date().toISOString(), await f.settings.readRecallCaptureSettings(userId));
    expect((await f.capture.readRecallCapture(userId, f.id)).status).toBe('review_ready');
    expect(mocks.formation).toHaveBeenCalledTimes(1);
  } finally { f.stop(); }
});

it('assesses every ambiguous proposal together once and retains separate source-bound uncertainty audits', async () => {
  const secondBody = '复盘方法：先核对事件发生顺序，再对照变更记录，最后列出仍缺少证据的因果假设；没有对照证据时不把先后关系当作因果结论。';
  const second = { ...method, judgment: secondBody, summary: '变更复盘方法', value: '供后续变更复盘复用，减少将事件先后顺序误当成因果证据。' };
  replaceSource(`${methodSource}\n后续变更复盘反复复用这套${secondBody}`);
  mocks.extract.mockResolvedValueOnce(response([method, second]));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('review_ready');
    expect(mocks.extract).toHaveBeenCalledTimes(1); expect(mocks.formation).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.formation.mock.calls[0][0].message).candidates.map((item: { index: number }) => item.index)).toEqual([0, 1]);
    expect(result.uncertaintyAssessments).toEqual([0, 1].map(candidateIndex => expect.objectContaining({ candidateIndex, modelCompleted: true, nonBlocking: true })));
    expect((await f.candidates.listRecallCandidates(userId)).map(row => row.judgment).sort()).toEqual([methodBody, secondBody].sort());
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it.each(['none', 'ambiguous_evidence'])('keeps an incomplete uncertainty audit %s retryable without accepting or caching its otherwise positive verdict', async kind => {
  replaceSource(kind === 'ambiguous_evidence' ? `${methodSource}\n${methodSource}` : methodSource);
  mocks.extract.mockResolvedValueOnce(response([method]));
  mocks.formation.mockResolvedValueOnce(supportedUncertainty(kind === 'none' ? 'none' : 'effect_unverified', methodBody));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'candidate_support_unavailable',
      candidateSupportUnavailable: [{ candidateIndex: 0, stage: 'uncertainty', reason: 'uncertainty_assessment_invalid', candidateHash: expect.any(String) }],
      uncertaintyAssessments: [expect.objectContaining({ modelCompleted: false, nonBlocking: false, reason: 'uncertainty_assessment_invalid' })] });
    expect(result.formationBatchAssessment).toBeUndefined();
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(mocks.formation).toHaveBeenCalledTimes(1);
  } finally { f.stop(); }
});

it.each([
  ['outside_claim_scope', '9月22日之前的职责来源未说明，本条仅记录2026年9月22日起。'],
  ['source_attribution_only', '未见独立原始材料佐证用户本人关于这个职责的陈述。'],
])('forms a dated user statement classified %s without guessing earlier dates or changing the reviewed scope', async (disposition, uncertainty) => {
  const datedSource = '我的职业是项目技术负责人：自2026年9月22日起，我负责示例项目的技术工作；此前的职责不在本条陈述范围内。';
  const datedBody = '根据用户本人陈述，自2026年9月22日起，其担任示例项目的技术负责人；本条仅记录该日期之后的职责。';
  replaceSource(datedSource);
  const proposal = { ...valid, judgment: datedBody, summary: '项目技术职责起始', contentCategory: 'unclassified',
    value: '在后续沟通和分工中保留用户明确陈述的职责及起始边界。', suggestedScope: '项目职责沟通', uncertainty };
  mocks.extract.mockResolvedValueOnce(response([proposal]));
  mocks.formation.mockResolvedValueOnce(supportedUncertainty(disposition, datedSource));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result.status).toBe('review_ready');
    const [candidate] = await f.candidates.listRecallCandidates(userId);
    expect(candidate).toMatchObject({ judgment: datedBody, suggestedScope: proposal.suggestedScope, status: 'pending_review' });
    expect(candidate.uncertainty).toBeUndefined();
    expect(candidate.judgment).not.toContain('2026年9月21');
    expect(result.uncertaintyAssessments).toEqual([expect.objectContaining({ nonBlocking: true, uncertaintyDisposition: disposition })]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
    expect(mocks.formation).toHaveBeenCalledTimes(1);
  } finally { f.stop(); }
});

it('stops after a second malformed JSON response and exposes parse failure without saving weak content', async () => {
  mocks.extract.mockResolvedValueOnce({ text: 'not JSON', meta: {} }).mockResolvedValueOnce({ text: '{"candidates":[', meta: {} });
  const f = await fixture();
  try {
    expect(await f.capture.runRecallCapture(userId, f.id)).toMatchObject({ status: 'failed', errorCode: 'invalid_model_output', extractionRepairAttempted: true });
    expect(mocks.extract).toHaveBeenCalledTimes(2);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('ignores malformed usage counters instead of converting metadata strings into invented token charges', async () => {
  mocks.extract.mockResolvedValueOnce(response([missingScope()], { inputTokens: '999', outputTokens: -2, totalTokens: '1001' }))
    .mockResolvedValueOnce(response([valid], { inputTokens: 5, outputTokens: '3', totalTokens: 8 }));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'review_ready', modelUsage: { inputTokens: 5, totalTokens: 8 } });
    expect(result.modelUsage?.outputTokens).toBeUndefined();
    expect(mocks.extract).toHaveBeenCalledTimes(2);
  } finally { f.stop(); }
});

it('requeues a first valid extraction returned after the night window closes without saving any candidate', async () => {
  mocks.extract.mockImplementationOnce(async () => { vi.setSystemTime(new Date(2026, 9, 12, 6)); return response([valid]); });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'queued', candidateIds: [] });
    expect(result.extractionCompletedAt).toBeUndefined(); expect(result.extractionRepairAttempted).toBeUndefined();
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('preserves cancellation during the first invalid extraction without issuing a second model call', async () => {
  const f = await fixture();
  mocks.extract.mockImplementationOnce(async () => {
    const { updateRecallJsonRecord } = await import('../../../../src/main/features/recall/store');
    await updateRecallJsonRecord(userId, 'captures', f.id, current => ({ ...current!, status: 'cancelled',
      finishedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    return response([missingScope()]);
  });
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'cancelled', candidateIds: [] });
    expect(result.extractionRepairAttempted).toBeUndefined(); expect(result.extractionCompletedAt).toBeUndefined();
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('requeues a runner-aborted initial extraction instead of recording a failure or repairing its partial output', async () => {
  mocks.extract.mockResolvedValueOnce({ text: '{"candidates":[', meta: { aborted: true } });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'queued', candidateIds: [] });
    expect(result.errorCode).toBeUndefined(); expect(result.extractionRepairAttempted).toBeUndefined();
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

const semanticSource = '以后处理我的复杂技术问题时，我希望先给结论，再解释关键理由；不要先铺很长的背景，但必须保留必要证据。';
const semanticProposal = { ...valid, contentCategory: 'preference', judgment: '处理用户复杂技术问题时，必须先给结论，再解释关键理由；保留必要证据，避免过长背景。',
  summary: '技术问题结论与证据', value: '为以后处理用户的复杂技术问题保留表达顺序及必要证据。' };
const semanticAssessment = { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true,
  priorContentPreserved: true, evidence: [{ label: 'm1', quote: semanticSource }] };
function semanticFixture() { replaceSource(semanticSource); mocks.extract.mockResolvedValue(response([semanticProposal])); }

it.each(['assessment_invalid', 'model_unavailable'])('distinguishes completed unsupported from %s and leaves unassessed source retryable without weak content', async reason => {
  semanticFixture();
  // Malformed output gets one format-repair attempt; keep both responses invalid
  // so the item still ends as a retryable support failure.
  mocks.formation.mockResolvedValue(reason === 'assessment_invalid' ? { text: 'not a valid assessment', meta: {} }
    : { text: '', meta: { error: { kind: 'network', message: 'private provider details' } } });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'candidate_support_unavailable', screeningStatus: 'qualified',
      candidateIds: [], candidateSupportUnavailableCount: 1, candidateSupportUnavailable: [{ candidateIndex: 0, stage: 'grounding', reason, candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(result.filterReason).toBeUndefined();
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
    expect(mocks.formation).toHaveBeenCalledTimes(reason === 'assessment_invalid' ? 2 : 1);
    const audit = JSON.stringify(result.candidateSupportUnavailable);
    expect(audit).not.toContain(semanticProposal.judgment); expect(audit).not.toContain('private provider details');
  } finally { f.stop(); }
});

it('keeps a complete explicit negative semantic verdict terminal rather than retrying it as a service failure', async () => {
  semanticFixture(); mocks.formation.mockResolvedValueOnce(formationResponse({ ...semanticAssessment, supported: false, noUnsupportedClaims: false }));
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'no_candidate', filterReason: 'candidate_quality', candidateIds: [] });
    expect(result.errorCode).toBeUndefined(); expect(result.candidateSupportUnavailable).toBeUndefined();
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('retries a source-support outage only in the next admitted night and preserves disabled and daytime gates', async () => {
  semanticFixture(); mocks.formation.mockResolvedValueOnce({ text: 'invalid independent response', meta: {} })
    .mockResolvedValueOnce({ text: 'invalid independent response', meta: {} })
    .mockResolvedValueOnce(formationResponse(semanticAssessment));
  const f = await fixture();
  try {
    expect(await f.capture.runRecallCapture(userId, f.id)).toMatchObject({ status: 'failed', errorCode: 'candidate_support_unavailable', attempt: 1 });
    await f.settings.updateRecallCaptureSettings(userId, { enabled: false });
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    expect(await f.capture.runNightlyCaptureSweep(userId, new Date().toISOString(), await f.settings.readRecallCaptureSettings(userId)))
      .toMatchObject({ ran: false, reason: 'disabled' });
    await f.settings.updateRecallCaptureSettings(userId, { enabled: true });
    vi.setSystemTime(new Date(2026, 9, 13, 12));
    expect(await f.capture.runNightlyCaptureSweep(userId, new Date().toISOString(), await f.settings.readRecallCaptureSettings(userId)))
      .toMatchObject({ ran: false, reason: 'outside_nightly_window' });
    expect(mocks.formation).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    expect(await f.capture.runNightlyCaptureSweep(userId, new Date().toISOString(), await f.settings.readRecallCaptureSettings(userId)))
      .toMatchObject({ ran: true, retried: 1 });
    const retried = await f.capture.runRecallCapture(userId, f.id);
    expect(retried).toMatchObject({ status: 'review_ready', attempt: 2 });
    expect(retried.errorCode).toBeUndefined(); expect(retried.candidateSupportUnavailable).toBeUndefined();
    expect(retried.autoApprovalEpoch).toBeUndefined();
    const [candidate] = await f.candidates.listRecallCandidates(userId);
    expect(candidate).toMatchObject({ judgment: semanticProposal.judgment, status: 'pending_review' });
    expect(mocks.formation).toHaveBeenCalledTimes(3);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it.each(['versioned-null-action', 'legacy-nonarray-actions'])('isolates %s before rule reading and resumes without re-extraction or duplicate saves', async shape => {
  const ontologyChanges = { reason: 'Synthetic malformed action', evidence: ['m1'], actions: shape === 'versioned-null-action' ? [null] : {} };
  mocks.extract.mockResolvedValueOnce(shape === 'versioned-null-action'
    ? { text: JSON.stringify({ proposalVersion: 2, proposals: [
      { id: 'independent', target: 'cognition', cognition: valid },
      { id: 'malformed', target: 'joint', cognition: valid, ontologyChanges },
    ] }), meta: {} }
    : response([valid, { ...valid, ontologyChanges }]));
  const f = await fixture();
  try {
    const first = await f.capture.runRecallCapture(userId, f.id);
    expect(first).toMatchObject({ status: 'review_ready', candidateSupportUnavailableCount: 1,
      candidateSupportUnavailable: [{ candidateIndex: 1, stage: 'grounding', reason: 'assessment_invalid' }] });
    expect(first.formationCheckpoint?.pendingCandidates?.map(item => item.index)).toEqual([1]);
    const saved = await f.candidates.listRecallCandidates(userId);
    expect(saved).toHaveLength(1);
    const assessments = mocks.formation.mock.calls.length;
    for (const [request] of mocks.formation.mock.calls) expect(JSON.parse(request.message).candidates.some((item: { index: number }) => item.index === 1)).toBe(false);
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    expect(await f.capture.runNightlyCaptureSweep(userId, new Date().toISOString(), await f.settings.readRecallCaptureSettings(userId)))
      .toMatchObject({ ran: true, retried: 1 });
    const resumed = await f.capture.runRecallCapture(userId, f.id);
    expect(resumed).toMatchObject({ status: 'review_ready', candidateSupportUnavailableCount: 1 });
    expect((await f.candidates.listRecallCandidates(userId)).map(row => row.id)).toEqual([saved[0].id]);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.formation).toHaveBeenCalledTimes(assessments);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
  } finally { f.stop(); }
});

it('keeps an already saved complete candidate when another item cannot finish its support assessment', async () => {
  semanticFixture();
  const first = { ...semanticProposal, judgment: '以后处理我的复杂技术问题时，我希望先给结论，再解释关键理由。', summary: '技术解释顺序' };
  mocks.extract.mockResolvedValueOnce(response([first, semanticProposal]));
  mocks.formation.mockResolvedValueOnce({ text: 'invalid assessment for the later item', meta: {} })
    .mockResolvedValueOnce({ text: 'invalid assessment for the later item', meta: {} });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'review_ready', candidateSupportUnavailableCount: 1,
      candidateSupportUnavailable: [{ candidateIndex: 1, stage: 'grounding', reason: 'assessment_invalid', candidateHash: expect.any(String) }] });
    expect(result.errorCode).toBeUndefined();
    const rows = await f.candidates.listRecallCandidates(userId);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ judgment: first.judgment, status: 'pending_review' });
    expect(mocks.formation).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.formation.mock.calls[0][0].message).candidates.map((item: { index: number }) => item.index)).toEqual([1]);
    expect(await f.assets.listAbilityAssets(userId)).toEqual([]);
    expect(result.formationCheckpoint?.pendingCandidates?.map(item => item.index)).toEqual([1]);
    const savedId = rows[0].id;
    vi.setSystemTime(new Date(2026, 9, 13, 3));
    expect(await f.capture.runNightlyCaptureSweep(userId, new Date().toISOString(), await f.settings.readRecallCaptureSettings(userId)))
      .toMatchObject({ ran: true, retried: 1 });
    const resumed = await f.capture.runRecallCapture(userId, f.id);
    expect(resumed).toMatchObject({ status: 'review_ready', attempt: 2 });
    expect(resumed.formationCheckpoint?.pendingCandidates).toEqual([]);
    expect(resumed.candidateSupportUnavailable).toBeUndefined();
    expect(resumed.candidateIds).toContain(savedId); expect(resumed.candidateIds).toHaveLength(2);
    expect(await f.candidates.listRecallCandidates(userId)).toHaveLength(2);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    expect(mocks.summary).toHaveBeenCalledTimes(1); expect(mocks.value).toHaveBeenCalledTimes(1);
    expect(mocks.formation).toHaveBeenCalledTimes(3);
    expect(JSON.parse(mocks.formation.mock.calls[2][0].message).candidates.map((item: { index: number }) => item.index)).toEqual([1]);
  } finally { f.stop(); }
});

it('preserves a model-aborted grounding check as queued rather than unsupported or failed', async () => {
  semanticFixture(); mocks.formation.mockResolvedValueOnce({ text: '', meta: { aborted: true } });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'queued', candidateIds: [] });
    expect(result.errorCode).toBeUndefined(); expect(result.candidateSupportUnavailable).toBeUndefined();
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it.each(['uncertainty_assessment_invalid', 'uncertainty_model_unavailable'])('retains uncertainty evaluation %s as retryable failure distinct from true content_unresolved', async reason => {
  replaceSource(methodSource); mocks.extract.mockResolvedValueOnce(response([method]));
  mocks.formation.mockResolvedValue(reason === 'uncertainty_assessment_invalid' ? { text: 'invalid independent classification', meta: {} }
    : { text: '', meta: { error: { kind: 'network', message: 'private uncertainty details' } } });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'failed', errorCode: 'candidate_support_unavailable',
      candidateSupportUnavailableCount: 1, candidateSupportUnavailable: [{ candidateIndex: 0, stage: 'uncertainty', reason, candidateHash: expect.any(String) }] });
    expect(result.uncertaintyAssessments).toEqual([expect.objectContaining({ modelCompleted: false, nonBlocking: false, reason })]);
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
    expect(JSON.stringify(result.candidateSupportUnavailable)).not.toContain(method.uncertainty);
  } finally { f.stop(); }
});

it('requeues host-interrupted uncertainty evaluation without clearing its original content uncertainty', async () => {
  replaceSource(methodSource); mocks.extract.mockResolvedValueOnce(response([method]));
  mocks.formation.mockResolvedValueOnce({ text: '', meta: { aborted: true } });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'queued', candidateIds: [] });
    expect(result.errorCode).toBeUndefined(); expect(result.candidateSupportUnavailable).toBeUndefined();
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});

it.each(['completed', 'unavailable'])('requeues %s grounding when the window closes during the model call instead of settling a daytime result', async outcome => {
  semanticFixture(); mocks.formation.mockImplementationOnce(async () => { vi.setSystemTime(new Date(2026, 9, 12, 6));
    return outcome === 'completed' ? formationResponse(semanticAssessment) : { text: '', meta: { error: { kind: 'network' } } }; });
  const f = await fixture();
  try {
    const result = await f.capture.runRecallCapture(userId, f.id);
    expect(result).toMatchObject({ status: 'queued', candidateIds: [] });
    expect(result.errorCode).toBeUndefined(); expect(result.candidateSupportUnavailable).toBeUndefined();
    expect(await f.candidates.listRecallCandidates(userId)).toEqual([]);
  } finally { f.stop(); }
});
