import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 标题闸门（设计 3.2）后晋升链对不合规 summary 走 LLM 起标题；本文件的候选
// 由 KStar 抽取/即时直投内生生成（summary＝模板拼接或正文首句），单测无模型，
// mock 出确定性合规标题（与 asset-title-suggestion.test.ts 同一边界口径）。
vi.mock('../../../../src/main/features/recall/asset-title-suggestion', () => ({
  suggestAbilityAssetTitle: async () => ({ title: '模型重起的样本标题' }),
}));


// 晋升链的语义复核（candidate-service autoApply → semantic-review →
// runReflection）是一次真实 LLM 网络调用。单跑时占位 key 快速 403 走
// 「复核失败不阻断」降级分支；全量并发下同一路外网往返会挂起，把本用例
// 拖到 60s 测试超时（vitest.config testTimeout）。mock 成「复核通过、无
// 发现」——对晋升链与 403 降级等价（findings 为空同样继续晋升），只是
// 不再依赖网络，断言语义不变。与上面 asset-title-suggestion 同一口径。
vi.mock('../../../../src/main/features/cognition/semantic-review', () => ({
  reviewCandidateSemantically: async () => ({ ok: true, findings: [] }),
}));

vi.mock('../../../../src/main/features/kb_embed', () => ({
  closeEmbedder: vi.fn(),
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

const USER_ID = 'cross-memory-journey';
let workspaceRoot: string;
let previousWorkspaceRoot: string | undefined;
let previousAnthropicKey: string | undefined;

beforeEach(() => {
  vi.resetModules();
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-memory-journey-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.COGSEED_WORKSPACE_ROOT = workspaceRoot;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

async function buildRunner(userMessage: string, sessionId: string) {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(USER_ID);
  const runnerModule = await import('../../../../src/main/model/core-agent/runner');
  return runnerModule.buildRunner({
    sessionId,
    userId: USER_ID,
    cid: 'conversation-memory-journey',
    sourceMessageFromUser: true,
    userMessage,
    skillList: [],
  });
}

async function invokeMemoryTool(
  userMessage: string,
  sessionId: string,
  input: Record<string, string>,
) {
  const built = await buildRunner(userMessage, sessionId);
  const memoryTool = (built.runner as any).tools.get('cross_session_memory');
  expect(memoryTool).toBeTruthy();
  const result = await memoryTool.execute(input, { state: {} });
  return { prompt: built.resolvedSystemPrompt, result: JSON.parse(result.content) };
}

describe('cross-session memory end-to-end journey', () => {
  it.each([
    ['Japanese', '覚えておいて：簡潔な回答を好みます。', '簡潔な回答を好みます。'],
    ['Portuguese', 'Por favor, lembre-se: Prefiro respostas concisas.', 'Prefiro respostas concisas.'],
  ])('rejects the retired write action for an exact %s save request', async (_language, userMessage, content) => {
    const saved = await invokeMemoryTool(
      userMessage,
      `gconv-memory-journey-localized-${String(_language).toLowerCase()}`,
      { action: 'add', target: 'user', content },
    );
    expect(saved.result).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(await assets.listAbilityAssets(USER_ID)).toEqual([]);
    expect(await candidates.listRecallCandidates(USER_ID)).toEqual([]);

  });

  it('reads preserved personal assets while retired memory writes cannot create or edit them', async () => {
    const original = '我长期偏好简洁回答。';
    const corrected = '我长期偏好先给结论，再解释原因。';
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const assets = await import('../../../../src/main/features/recall/asset-service');
    // This scenario starts from a historical user-authored asset; no removed
    // creation path is used to manufacture it.
    const { seedStoredAbilityAsset } = await import('../../../helpers/stored-ability-asset');
    const { writeReviewDecision } = await import('../../../../src/main/features/cognition/review-decision');
    await writeReviewDecision(USER_ID, { targetRef: 'recall_candidate:cand-existing-user-profile',
      antecedentRef: 'cand-existing-user-profile', decisionType: 'accept', decision: 'accept', actor: 'user',
      scope: 'general', decisionId: 'rd_existing_profile_fixture' });
    const now = new Date().toISOString();
    const asset = await seedStoredAbilityAsset(USER_ID, {
      schemaVersion: 2, ownerId: USER_ID, id: 'aa-existing-user-profile-fixture',
      candidateId: 'cand-existing-user-profile', sourceCandidateIds: ['cand-existing-user-profile'],
      reviewDecisionId: 'rd_existing_profile_fixture', type: 'personal', title: '简洁回答偏好', statement: original,
      origin: 'manual', scope: 'general', evidenceRefs: [], version: '1', activeVersion: '1',
      maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', status: 'active',
      createdAt: now, updatedAt: now,
    });
    const next = await buildRunner('帮我整理一份说明。', 'gconv-memory-existing-next');
    expect(next.resolvedSystemPrompt).toContain(original);
    const listed = await invokeMemoryTool('列出已有记忆。', 'gconv-memory-existing-list', { action: 'list', target: 'user' });
    expect(listed.result.ok).toBe(true);
    expect(listed.result.entries.join('\n')).toContain(original);
    for (const action of ['add', 'replace', 'remove']) {
      expect((await invokeMemoryTool('请修改这条记忆。', `gconv-memory-retired-${action}`,
        { action, target: 'user', old_text: original, content: corrected })).result.ok).toBe(false);
    }
    expect((await assets.readAbilityAsset(USER_ID, asset.id)).statement).toBe(original);
    const revised = await assets.updateAbilityAsset(USER_ID, asset.id, { statement: corrected, actor: 'user', reason: 'Edit an existing asset through its management service.' });
    expect((await buildRunner('继续整理。', 'gconv-memory-edited')).resolvedSystemPrompt).toContain(corrected);
    await assets.pauseAbilityAsset(USER_ID, asset.id, { actor: 'user', reason: 'Pause preserved asset.', expectedVersion: revised.version });
    expect((await buildRunner('继续整理。', 'gconv-memory-paused')).resolvedSystemPrompt).not.toContain(corrected);
  });
});
