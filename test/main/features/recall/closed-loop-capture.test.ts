import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureSummaryModelResponse } from '../../../helpers/capture-summary-model';

const mocks = vi.hoisted(() => ({
  configured: true,
  oauthExpired: null as string | null,
  getMessages: vi.fn(), getMessagesPage: vi.fn(), listConversations: vi.fn(),
  getConversation: vi.fn(),
  buildRunner: vi.fn(),
  runModel: vi.fn(), runSummary: vi.fn(),
  scheduleBootBackground: vi.fn(), prepareSkillDraft: vi.fn(),
}));

vi.mock('../../../../src/main/features/auth', () => ({
  listEntriesForUser: async () => ({ entries: [] }),
  hasConfiguredModelForUser: () => ({ configured: mocks.configured }),
  getConfiguredModelOAuthExpiredMessageForUser: () => mocks.oauthExpired,

  hasConfiguredModel: () => ({ configured: mocks.configured }),
  getConfiguredModelOAuthExpiredMessage: () => mocks.oauthExpired,
}));
vi.mock('../../../../src/main/features/chats', () => ({
  getMessages: mocks.getMessages, getMessagesPage: mocks.getMessagesPage,
  getConversation: mocks.getConversation,
  listConversations: mocks.listConversations,
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: mocks.buildRunner,
}));
vi.mock('../../../../src/main/features/group_chat/bus', () => ({
  isQuiescent: () => true,
  subscribeTaskTerminals: () => () => {},
}));
vi.mock('../../../../src/main/features/recall/skill-draft-service', () => ({
  prepareRecallSkillDraft: mocks.prepareSkillDraft,
}));
vi.mock('../../../../src/main/util/boot_init', () => ({
  scheduleBootBackground: mocks.scheduleBootBackground,
  registerDeferred: () => {},
}));

const USER_ID = 'closed-loop-user';
const CONVERSATION_ID = 'closed-loop-conversation';
const messages = [
  {
    id: 'message-user',
    ts: '2026-08-14T08:00:00.000Z',
    from: 'user',
    to: ['commander'],
    text: 'For every schema migration, always prepare and test a rollback plan before deployment.',
  },
  {
    id: 'message-assistant',
    ts: '2026-08-14T08:01:00.000Z',
    from: 'commander',
    to: ['user'],
    text: 'I will make the rollback plan a required release checklist item and verify it before deployment.',
  },
] as const;

let temporaryRoot: string;
let previousRoot: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 7, 15, 3));
  vi.clearAllMocks();
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-closed-loop-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = temporaryRoot;

  mocks.configured = true;
  mocks.oauthExpired = null;
  mocks.getMessages.mockResolvedValue(messages);
  mocks.getMessagesPage.mockResolvedValue({ history: messages, nextCursor: null });
  mocks.listConversations.mockResolvedValue([{ conversation_id: CONVERSATION_ID, title: 'Migration', updated_at: messages[1].ts }]);
  mocks.getConversation.mockResolvedValue({
    conversation_id: CONVERSATION_ID,
    title: 'Synthetic migration discussion',
    space_id: 'workspace-closed-loop',
  });
  mocks.buildRunner.mockImplementation(async (options) => ({ runner: { run: options.sessionId.startsWith('memory-summary-') ? mocks.runSummary : mocks.runModel } }));
  mocks.runSummary.mockReset().mockImplementation(captureSummaryModelResponse);
  mocks.runModel.mockResolvedValue({
    text: JSON.stringify({
      candidates: [{
        judgment: 'Always prepare and test a rollback plan before deploying a schema migration.',
        value: 'A tested rollback plan makes migration failures recoverable and reduces release risk.',
        summary: 'Require migration rollback plans',
        contentCategory: 'method',
        suggestedScope: 'project',
        // Boundaries remain evidence-backed even when extraction has no category.
        applicableWhen: ['schema migration'],
        forbiddenWhen: ['read-only query changes'],
        suggestedAction: 'create',
        evidence: ['m1', 'm2'],
      }],
    }),
    content: [],
    meta: { aborted: false },
  });
  // The sweep settles only after admitted capture tasks settle. This test runs
  // captures explicitly, so the scheduler handle must resolve immediately
  // instead of holding the sweep pending forever.
  mocks.scheduleBootBackground.mockImplementation(() => ({
    cancel: vi.fn(),
    promise: Promise.resolve(),
  }));
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function modules() {
  const [capture, candidates, assets, promptInjection, settings] = await Promise.all([
    import('../../../../src/main/features/recall/capture-service'),
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/asset-service'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/features/recall/capture-settings'),
  ]);
  return { capture, candidates, assets, promptInjection, settings };
}

const semanticOptions = {
  embedTexts: async (texts: string[]) => texts.map((text) => {
    const normalized = text.toLowerCase();
    if (normalized.includes('schema') || normalized.includes('migration') || normalized.includes('rollback')) return [1, 0];
    if (normalized.includes('calendar') || normalized.includes('meeting')) return [0, 1];
    return [0, 0];
  }),
  // Free-text applicability is adjudicated by the host. The fixture returns a
  // complete, quote-backed verdict for exactly the candidates it was asked about.
  assessApplicability: async (message: string) => {
    const payload = JSON.parse(message) as { currentTask: string; candidates: Array<{ assetId: string; version: string; statement: string }> };
    return JSON.stringify({ decisions: payload.candidates.map((row) => ({
      assetId: row.assetId, version: row.version, verdict: 'applicable',
      reason: 'The task explicitly names the migration rollback condition.',
      taskQuote: payload.currentTask, assetQuote: row.statement, rank: 1,
    })) });
  },
};

async function runNightlyProposal() {
  const { capture, candidates, assets, settings } = await modules();
  await settings.updateRecallCaptureSettings(USER_ID, { reviewPolicy: 'manual' });
  const stop = capture.startRecallCaptureOrchestrator();
  try {
    await capture.runNightlyCaptureSweep(USER_ID, new Date(2026, 7, 15, 3).toISOString(), await settings.readRecallCaptureSettings(USER_ID));
    const paths = await import('../../../../src/main/features/recall/paths');
    const directory = path.dirname(paths.recallJsonRecordPath(USER_ID, 'captures', 'placeholder'));
    const [name] = await fs.readdir(directory);
    const extracted = await capture.runRecallCapture(USER_ID, name.replace(/\.json$/, ''));
    return { capture, candidates, assets, extracted };
  } finally { stop(); }
}
const positiveValue = { eligible: true, reason: 'A reusable migration release understanding',
  evidence: [{ messageId: 'message-user', quote: messages[0].text }] };
const completeCognition = { judgment: 'Always prepare and test a rollback plan before deploying a schema migration.',
  value: 'A tested rollback plan makes future migration failures recoverable.', summary: 'Migration rollback checks',
  suggestedScope: 'general', suggestedAction: 'create', evidence: ['m1'], risk: 'low' };

describe('Recall nightly summary/value/extraction closed loop', () => {
  it('semantically checks a faithful full preference when a short approved quote omits its standing intent and bounds', async () => {
    const original = '自2026年8月14日起，以后请回答复杂问题时先直接给出结论，再解释关键原因，避免一开头先铺很长背景。这个要求只针对以后类似复杂问题，不要求省略必要证据。';
    const quote = '回答复杂问题时先直接给出结论，再解释关键原因';
    const source = { ...messages[0], text: original };
    mocks.getMessages.mockResolvedValue([source]);
    mocks.getMessagesPage.mockResolvedValue({ history: [source], nextCursor: null });
    mocks.runModel.mockReset()
      .mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: '可指导以后复杂问题表达', evidence: [{ messageId: source.id, quote }] }), meta: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ judgment: '用户自2026年8月14日起声明一个长期表达偏好：回答其复杂问题时，先直接给出结论，再解释关键原因，避免开头先铺很长背景。适用于以后类似复杂问题，不要求省略必要证据。',
        value: '指导以后复杂问题的回答结构并保留必要证据。', summary: '复杂问题表达偏好', contentCategory: 'preference', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', evidence: ['m1'] }] }), meta: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ assessments: [{ index: 0, uncertaintyDisposition: 'none',
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true,
          finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label: 'm1', quote }] } }] }), meta: {} });
    const { extracted, candidates } = await runNightlyProposal();
    expect(extracted.status).toBe('review_ready');
    const [candidate] = await candidates.listRecallCandidates(USER_ID);
    expect(candidate.judgment).toContain('不要求省略必要证据');
    expect(mocks.buildRunner.mock.calls.map(call => call[0].sessionId)).toContainEqual(expect.stringMatching(/^memory-formation-recall-/));
    expect(mocks.runModel).toHaveBeenCalledTimes(3);
    const batch = JSON.parse(mocks.runModel.mock.calls[2][0].message);
    expect(batch.candidates).toEqual([expect.objectContaining({ index: 0,
      sources: [expect.objectContaining({ label: 'm1', text: original, approvedQuotes: [quote] })] })]);
  });

  it.each(['rule', 'preference', 'template', 'method', 'lesson', 'unclassified'])('the same supported cognition has identical admission regardless of browsing label (%s)', async contentCategory => {
    mocks.runModel.mockResolvedValueOnce({ text: JSON.stringify(positiveValue), meta: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ ...completeCognition, contentCategory }] }), meta: {} });
    const { candidates, extracted } = await runNightlyProposal();
    expect(extracted).toMatchObject({ status: 'review_ready', candidateIds: [expect.any(String)] });
    expect(await candidates.readRecallCandidate(USER_ID, extracted.candidateIds[0])).toMatchObject({ status: 'pending_review',
      suggestedType: 'cognition', contentCategory, judgment: completeCognition.judgment });
    expect(mocks.prepareSkillDraft).not.toHaveBeenCalled();
  });
  it.each(['a template without any learned understanding or future use', 'an ordinary operation receipt without a lesson'])('a negative value judgment never enters attention or extraction (%s)', async reason => {
    mocks.runModel.mockResolvedValueOnce({ text: JSON.stringify({ eligible: false, reason, evidence: [] }), meta: {} });
    const { candidates, assets, extracted } = await runNightlyProposal();
    expect(extracted).toMatchObject({ status: 'no_candidate', visibility: 'internal', candidateIds: [] });
    expect(await candidates.listRecallCandidates(USER_ID)).toEqual([]);
    expect(await assets.listAbilityAssets(USER_ID)).toEqual([]);
    expect(mocks.runModel).toHaveBeenCalledTimes(1);
  });
  it('filters a pure operation receipt even if extraction adds a reusable-template label and future-value wording', async () => {
    mocks.runModel.mockResolvedValueOnce({ text: JSON.stringify(positiveValue), meta: {} })
      .mockResolvedValueOnce({ text: JSON.stringify({ candidates: [{ ...completeCognition,
        judgment: '成功使用模板完成任务。', contentCategory: 'template' }] }), meta: {} });
    const { candidates, extracted } = await runNightlyProposal();
    expect(extracted).toMatchObject({ status: 'no_candidate', visibility: 'internal', candidateIds: [] });
    expect(await candidates.listRecallCandidates(USER_ID)).toEqual([]);
  });

  it.each([false, true])('preserves nightly classification through review and formation (user edits: %s)', async (editCategory) => {
    vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '8');
    const { capture, candidates, assets, promptInjection, settings } = await modules();
    const { appendJsonlAtomic } = await import('../../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
    for (const message of messages) await appendJsonlAtomic(conversationMessageFile(USER_ID, CONVERSATION_ID), message);
    await settings.updateRecallCaptureSettings(USER_ID, { reviewPolicy: 'manual' });

    const stop = capture.startRecallCaptureOrchestrator();
    const window = new Date(2026, 7, 15, 3).toISOString();
    await capture.runNightlyCaptureSweep(USER_ID, window, await settings.readRecallCaptureSettings(USER_ID));
    const store = await import('../../../../src/main/features/recall/store');
    const paths = await import('../../../../src/main/features/recall/paths');
    const directory = path.dirname(paths.recallJsonRecordPath(USER_ID, 'captures', 'placeholder'));
    const [name] = await fs.readdir(directory);
    const first = await capture.readRecallCapture(USER_ID, name.replace(/\.json$/, ''));
    expect(first).toMatchObject({ status: 'queued', executionPolicy: 'nightly', visibility: 'internal' });
    expect(mocks.runModel).not.toHaveBeenCalled();
    mocks.runModel.mockResolvedValueOnce({ text: JSON.stringify({ eligible: true, reason: 'A reusable migration release rule',
      evidence: [{ messageId: 'message-user', quote: messages[0].text }] }), meta: {} });
    const extracted = await capture.runRecallCapture(USER_ID, first.id);
    expect(extracted).toMatchObject({
      status: 'review_ready',
      candidateIds: [expect.any(String)],
    });
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);

    const [candidateId] = extracted.candidateIds;
    const candidate = await candidates.readRecallCandidate(USER_ID, candidateId);
    expect(candidate).toMatchObject({
      status: 'pending_review',
      suggestedType: 'cognition',
      contentCategory: 'method',
      suggestedAction: 'create',
    });
    expect(await assets.listAbilityAssets(USER_ID)).toHaveLength(0);
    expect(candidate.captureProvenance?.pipeline).toBe('nightly_conversation');
    expect(extracted.contextSummary).toMatchObject({ completedAt: expect.any(String), coverage: { messageCount: 2 } });
    expect(mocks.buildRunner.mock.calls.map(call => call[0].sessionId)).toEqual([
      expect.stringMatching(/memory-summary/), expect.stringMatching(/memory-value/), expect.stringMatching(/memory-extract/),
    ]);
    if (editCategory) {
      await candidates.updateRecallCandidate(USER_ID, candidateId, { ...candidate, contentCategory: 'rule' });
    }
    const expectedCategory = editCategory ? 'rule' : 'method';
    const promoted = await capture.promoteRecallCaptureCandidate(USER_ID, candidateId);
    expect(mocks.prepareSkillDraft).not.toHaveBeenCalled();
    expect(mocks.buildRunner.mock.calls.every(([options]) => options.disableTools === true && options.skillList.length === 0)).toBe(true);
    expect(promoted).toMatchObject({
      candidate: {
        status: 'confirmed',
        promotedAssetId: expect.stringMatching(/^aa-/),
      },
      decision: { decision_id: expect.stringMatching(/^rd_/) },
      receipt: {
        assetId: expect.stringMatching(/^aa-/),
        assetType: 'cognition',
        lifecycleStatus: 'user_confirmed_unverified',
      },
    });
    const [asset] = await assets.listAbilityAssets(USER_ID);
    expect(asset).toMatchObject({
      id: promoted.candidate.promotedAssetId,
      type: 'cognition',
      contentCategory: expectedCategory,
      version: '1',
      lifecycleStatus: 'user_confirmed_unverified',
    });

    expect((await assets.listAbilityAssetVersions(USER_ID, asset.id))[0].snapshot.contentCategory).toBe(expectedCategory);
    const changedCategory = expectedCategory === 'rule' ? 'method' : 'rule';
    await expect(assets.updateAbilityAsset(USER_ID, asset.id, { contentCategory: changedCategory,
      actor: 'user', reason: 'Classify', expectedVersion: '0' })).rejects.toThrow('version conflict');
    const reclassified = await assets.updateAbilityAsset(USER_ID, asset.id, { contentCategory: changedCategory,
      actor: 'user', reason: 'Classify', expectedVersion: '1' });
    expect(reclassified).toMatchObject({ contentCategory: changedCategory, version: '2' });
    expect((await assets.listAbilityAssetVersions(USER_ID, asset.id)).find(row => row.version === '2')?.snapshot.contentCategory).toBe(changedCategory);
    expect(await capture.runNightlyCaptureSweep(USER_ID, window, await settings.readRecallCaptureSettings(USER_ID))).toMatchObject({ queued: 0 });
    stop();
    expect((await assets.listAbilityAssets(USER_ID)).map((item) => item.id)).toEqual([asset.id]);
    expect(mocks.runSummary).toHaveBeenCalledTimes(1);
    expect(mocks.runModel).toHaveBeenCalledTimes(2);

    const workflow = await capture.readRecallCaptureWorkflow(USER_ID, first.id);
    expect(workflow).toMatchObject({
      workflowStatus: 'completed',
      linkedAssetIds: [asset.id],
      nextAction: 'view_assets',
      confirmedAssetReceipts: [{
        assetId: asset.id,
        assetType: 'cognition',
        version: '1',
        scope: 'project',
        sourceRefCount: 3,
        reviewDecisionId: expect.stringMatching(/^rd_/),
      }],
    });

    // 一键提取写入的资产是 seed 档（系统写入、无人确认）。按默认注入的成熟度要求，
    // 它还没有"被正确带入过"的证明，所以**不进静默默认注入**——用户主动带入
    // 查原文／明确选用与默认带入分开；尚未验证的系统内容不能默认进入。
    const beforeProof = await promptInjection.buildRecallTurnPromptContext(USER_ID, {
      cid: 'new-conversation-relevant',
      taskRunId: 'new-turn-relevant',
      taskText: 'How should we validate a schema migration rollback before deployment?',
      workspaceId: 'workspace-closed-loop',
    }, semanticOptions);
    expect(beforeProof.promptBlock).not.toContain('Always prepare and test a rollback plan');

    // 真实使用一次：手动投影 → 落回执 → 终态 → TransferProof 带 receiptId。
    const assetsSvc = await import('../../../../src/main/features/recall/asset-service');
    await assetsSvc.setAbilityAssetMaturity(USER_ID, asset.id, 'transfer_validated');

    const relevant = await promptInjection.buildRecallTurnPromptContext(USER_ID, {
      cid: 'new-conversation-relevant-2',
      taskRunId: 'new-turn-relevant-2',
      taskText: 'How should we validate a schema migration rollback before deployment?',
      workspaceId: 'workspace-closed-loop',
    }, semanticOptions);
    expect(relevant.promptBlock).toContain('Always prepare and test a rollback plan');
    expect(relevant.citations).toEqual([expect.objectContaining({
      assetId: asset.id,
      type: 'cognition',
      matchMethod: 'semantic',
    })]);

    await expect(promptInjection.buildRecallTurnPromptContext(USER_ID, {
      cid: 'new-conversation-irrelevant',
      taskRunId: 'new-turn-irrelevant',
      taskText: 'Schedule a team calendar meeting for next Tuesday.',
      workspaceId: 'workspace-closed-loop',
    }, semanticOptions)).resolves.toEqual({ promptBlock: '', citations: [] });
  });
});
