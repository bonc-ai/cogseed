import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  configured: true,
  oauthExpired: null as string | null,
  getMessages: vi.fn(),
  getConversation: vi.fn(),
  buildRunner: vi.fn(),
  runModel: vi.fn(),
  scheduleBootBackground: vi.fn(),
}));

vi.mock('../../../../src/main/features/auth', () => ({
  hasConfiguredModel: () => ({ configured: mocks.configured }),
  getConfiguredModelOAuthExpiredMessage: () => mocks.oauthExpired,
}));
vi.mock('../../../../src/main/features/chats', () => ({
  getMessages: mocks.getMessages,
  getConversation: mocks.getConversation,
  listConversations: vi.fn(async () => []),
}));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({
  buildRunner: mocks.buildRunner,
}));
vi.mock('../../../../src/main/features/group_chat/bus', () => ({
  isQuiescent: () => true,
  subscribeTaskTerminals: () => () => {},
}));
vi.mock('../../../../src/main/features/recall/skill-draft-service', () => ({
  prepareRecallSkillDraft: vi.fn(),
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
  vi.clearAllMocks();
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-closed-loop-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = temporaryRoot;

  mocks.configured = true;
  mocks.oauthExpired = null;
  mocks.getMessages.mockResolvedValue(messages);
  mocks.getConversation.mockResolvedValue({
    conversation_id: CONVERSATION_ID,
    title: 'Synthetic migration discussion',
    project_id: 'workspace-closed-loop',
  });
  mocks.buildRunner.mockResolvedValue({ runner: { run: mocks.runModel } });
  mocks.runModel.mockResolvedValue({
    text: JSON.stringify({
      candidates: [{
        judgment: 'Always prepare and test a rollback plan before deploying a schema migration.',
        value: 'A tested rollback plan makes migration failures recoverable and reduces release risk.',
        summary: 'Require migration rollback plans',
        suggestedType: 'rule',
        suggestedScope: 'project',
        // PRD 3.1 把适用/禁止范围列为 RuleAsset 的最低准入门槛，抽取提示词
        // 现在要求规则候选一并给出——没有边界的规则只能停在候选池。
        applicableWhen: ['schema migration'],
        forbiddenWhen: ['read-only query changes'],
        suggestedAction: 'create',
        evidence: ['m1', 'm2'],
      }],
    }),
    content: [],
    meta: { aborted: false },
  });
  mocks.scheduleBootBackground.mockImplementation(() => ({
    cancel: vi.fn(),
    promise: new Promise<void>(() => {}),
  }));
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  await fs.rm(temporaryRoot, { recursive: true, force: true });
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
};

describe('Recall selected-conversation closed loop', () => {
  it('keeps historical selection manual until explicit extraction and confirmation', async () => {
    const { capture, candidates, assets, promptInjection, settings } = await modules();
    await settings.updateRecallCaptureSettings(USER_ID, { reviewPolicy: 'manual' });

    const [first, concurrent] = await Promise.all([
      capture.startHistoricalRecallCapture(USER_ID, CONVERSATION_ID),
      capture.startHistoricalRecallCapture(USER_ID, CONVERSATION_ID),
    ]);
    expect(first).toMatchObject({
      id: concurrent.id,
      conversationId: CONVERSATION_ID,
      status: 'waiting_manual',
      executionPolicy: 'manual',
      visibility: 'visible',
    });
    expect(mocks.runModel).not.toHaveBeenCalled();

    const queued = await capture.runRecallCaptureNow(USER_ID, first.id);
    expect(queued).toMatchObject({ status: 'queued' });
    const extracted = await capture.runRecallCapture(USER_ID, first.id);
    expect(extracted).toMatchObject({
      status: 'review_ready',
      candidateIds: [expect.any(String)],
    });
    expect(mocks.runModel).toHaveBeenCalledTimes(1);

    const [candidateId] = extracted.candidateIds;
    const candidate = await candidates.readRecallCandidate(USER_ID, candidateId);
    expect(candidate).toMatchObject({
      status: 'pending_review',
      suggestedType: 'rule',
      suggestedAction: 'create',
    });
    const promoted = await capture.promoteRecallCaptureCandidate(USER_ID, candidateId);
    expect(promoted).toMatchObject({
      candidate: {
        status: 'confirmed',
        promotedAssetId: expect.stringMatching(/^aa-/),
      },
      decision: { decision_id: expect.stringMatching(/^rd_/) },
      receipt: {
        assetId: expect.stringMatching(/^aa-/),
        assetType: 'rule',
        lifecycleStatus: 'user_confirmed_unverified',
      },
    });
    const [asset] = await assets.listAbilityAssets(USER_ID);
    expect(asset).toMatchObject({
      id: promoted.candidate.promotedAssetId,
      type: 'rule',
      version: '1',
      lifecycleStatus: 'user_confirmed_unverified',
    });

    const duplicate = await capture.startHistoricalRecallCapture(USER_ID, CONVERSATION_ID);
    expect(duplicate).toEqual(await capture.readRecallCapture(USER_ID, first.id));
    expect((await assets.listAbilityAssets(USER_ID)).map((item) => item.id)).toEqual([asset.id]);
    expect(mocks.runModel).toHaveBeenCalledTimes(1);

    const workflow = await capture.readRecallCaptureWorkflow(USER_ID, first.id);
    expect(workflow).toMatchObject({
      workflowStatus: 'completed',
      linkedAssetIds: [asset.id],
      nextAction: 'view_assets',
      confirmedAssetReceipts: [{
        assetId: asset.id,
        assetType: 'rule',
        version: '1',
        scope: 'project',
        sourceRefCount: 3,
        reviewDecisionId: expect.stringMatching(/^rd_/),
      }],
    });

    // 一键提取写入的资产是 seed 档（系统写入、无人确认）。按 PRD 3.6，
    // 它还没有"被正确带入过"的证明，所以**不进静默默认注入**——用户主动带入
    // 一次、拿到 ContextReuseReceipt 升到 transfer_validated 之后才会自动出现。
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
      type: 'rule',
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
