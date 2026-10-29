import { createNightlyCandidateFixture } from '../../../helpers/nightly-formation-fixture';
import { seedStoredAbilityAsset } from '../../../helpers/stored-ability-asset';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-recall-prompt-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

// 自动投影是"静默默认注入"，只接纳 Transfer Verified 及以上。
// 这些用例考的是相关性 / 提示词结构 / 引用对齐，不是成熟度闸门，所以先把资产
// 抬到够格的档位；闸门本身由 formal-asset-runtime.test.ts 覆盖。
async function elevateToTransferVerified(assetId: string) {
  const assets = await import('../../../../src/main/features/recall/asset-service');
  await assets.setAbilityAssetMaturity('user-a', assetId, 'transfer_validated');
}

async function modules() {
  const [candidates, refs, projection, promptInjection, storage, layout, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, refs, projection, promptInjection, storage, layout, assets };
}

async function createAsset() {
  const { candidates } = await modules();
  const candidate = await createNightlyCandidateFixture('user-a', {
    judgment: 'Keep architecture decisions in a decision log before changing runtime boundaries.',
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'rule',
    applicableWhen: ['Architecture review and runtime-boundary changes'],
    forbiddenWhen: ['Informal brainstorming without a decision'],
    suggestedScope: 'review,project',
    spaceId: 'workspace-a',
    sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
  });
  // forceCreateSimilar：本文件的资产是预算测试数据（长填充串），语义上高度
  // 相似会被防分裂闸拦——那是闸门的正确行为，但不是这里要测的东西。
  const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
}

async function createAssetWith(input: { judgment: string; summary: string; sourceId: string; applicableWhen?: string[] }) {
  const { candidates } = await modules();
  const candidate = await createNightlyCandidateFixture('user-a', {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    applicableWhen: input.applicableWhen || ['OAuth', 'database', 'architecture review', 'rules'],
    forbiddenWhen: ['Unrelated casual conversation'],
    suggestedScope: 'global',
    spaceId: 'workspace-a',
    sourceRefs: [{
      kind: 'conversation',
      id: input.sourceId,
      subtype: 'session',
      scope: 'personal',
    }],
  });
  // forceCreateSimilar：本文件的资产是预算测试数据（长填充串），语义上高度
  // 相似会被防分裂闸拦——那是闸门的正确行为，但不是这里要测的东西。
  const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
}

const fakeSemanticOptions = {
  // These tests isolate rendering/relation/budget contracts, not model quality.
  assessApplicability: async (message: string) => {
    const payload = JSON.parse(message) as { currentTask: string; candidates: Array<{ assetId: string; version: string; statement: string }> };
    return JSON.stringify({ decisions: payload.candidates.map((asset, index) => ({ assetId: asset.assetId, version: asset.version,
      verdict: 'applicable', reason: 'Fixture guidance applies to the supplied task.', taskQuote: payload.currentTask.slice(0, 1000),
      assetQuote: asset.statement.slice(0, 1000), rank: index })) });
  },
  embedTexts: async (texts: string[]) => texts.map((text, index) => {
    const lower = (index === 0 ? text : text.split('\n').slice(0, 2).join('\n')).toLowerCase();
    if (lower.includes('oauth')) return [1, 0];
    if (lower.includes('database')) return [0, 1];
    return [0.2, 0.2];
  }),
};

describe('confirmed Recall projection prompt injection', () => {
  it('keeps every supported condition and the end of long exceptions in the real committed context', async () => {
    const { asset } = await createAsset();
    const { assets, projection, promptInjection } = await modules();
    const applicableWhen = Array.from({ length: 7 }, (_, index) => `Applicable context ${index}: ` + 'bounded detail '.repeat(24) + `end-condition-${index}`);
    const forbiddenWhen = Array.from({ length: 7 }, (_, index) => `Exception ${index}: ` + 'bounded exception '.repeat(22) + `end-exception-${index}`);
    await assets.updateAbilityAsset('user-a', asset.id, { applicableWhen, forbiddenWhen, actor: 'user', reason: '保留全部适用条件与末尾例外' });
    const committed = await projection.previewContextProjection('user-a', { taskRunId: 'turn-complete-boundaries', purpose: 'review', authorization: 'user_confirmed', confirm: true, conversationId: 'cid-complete-boundaries', explicitAssetIds: [asset.id] });
    const result = await promptInjection.buildRecallTurnPromptContext('user-a', { cid: 'cid-complete-boundaries', taskRunId: 'turn-complete-boundaries', taskText: 'Review the runtime architecture', committedProjectionId: committed.id });
    const records = JSON.parse(result.promptBlock.split('\n').at(-2)!);
    expect(records[0].applicable_when).toEqual(applicableWhen);
    expect(records[0].forbidden_when).toEqual(forbiddenWhen);
    expect(result.citations).toHaveLength(1);
    expect(result.promptBlock).toContain('most specific relevant condition or exception');
    const composite = promptInjection.composeAssetContextBlock({ authorized: result.authorizedAssetsBlock });
    expect(composite).toContain('a current explicit user request takes precedence');
    expect(composite).toContain('does not grant tool permissions');
  });
  it('injects only confirmed active assets referenced by the current conversation', async () => {
    const asset = await createAsset();
    const { refs, projection, storage, layout, promptInjection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const unconfirmed = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-b', workspaceId: 'workspace-a', purpose: 'review',
    });
    const messageFile = layout.conversationMessageFile('user-a', 'cid-a');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-a', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
      recall_projection_card: { projectionId: confirmed.id },
    });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-b', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'unconfirmed',
      recall_projection_card: { projectionId: unconfirmed.id },
    });

    const block = await promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-a');

    expect(block).toContain('<confirmed-ability-assets>');
    expect(block).toContain('Use decision logs for architecture changes');
    expect(block).toContain(confirmed.id);
    expect(block).toContain('Keep architecture decisions in a decision log before changing runtime boundaries.');
    expect(block).not.toContain(unconfirmed.id);
    expect(block).toContain('expressed user preferences and requirements are response requirements when applicable');
    expect(block).toContain('the most specific relevant condition or exception before the broader default');
    expect(block).toContain('a current explicit user request takes precedence');
    expect(block).toContain('does not grant tool permissions, authorize external actions');
  });

  it('discovers confirmed projections from an explicit final-message receipt', async () => {
    const asset = await createAsset();
    const { refs, projection, storage, layout, promptInjection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-receipt', workspaceId: 'workspace-a', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const messageFile = layout.conversationMessageFile('user-a', 'cid-receipt');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-receipt', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'final answer',
      projection_receipt: { projectionId: confirmed.id, authorization: 'model_selected' },
    });

    const block = await promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-receipt');

    expect(block).toContain('<confirmed-ability-assets>');
    expect(block).toContain(confirmed.id);
    expect(block).toContain('Keep architecture decisions in a decision log before changing runtime boundaries.');
  });

  it('injects the confirmed version snapshot and never a drifted live version', async () => {
    const asset = await createAsset();
    const { refs, projection, storage, layout, promptInjection, assets } = await modules();
    await refs.addWorkspaceAssetReference('user-a', {
      assetId: asset.asset.id,
      workspaceId: 'workspace-a',
      scope: 'review',
    });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-drift', workspaceId: 'workspace-a', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    // Post-confirmation edit: live asset drifts to version 2 with new content.
    await assets.updateAbilityAsset('user-a', asset.asset.id, {
      statement: 'DRIFTED content that must never be injected after confirmation',
      reason: 'post-confirmation edit',
      actor: 'user',
    });

    const messageFile = layout.conversationMessageFile('user-a', 'cid-drift');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-drift', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'confirmed',
      recall_projection_card: { projectionId: confirmed.id },
    });

    const block = await promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-drift');

    expect(block).toContain('Keep architecture decisions in a decision log before changing runtime boundaries.');
    expect(block).not.toContain('DRIFTED content');
    expect(block).toContain('"version":"1"');
  });

  it('returns an empty block when the conversation has no confirmed projection', async () => {
    const { promptInjection } = await modules();
    await expect(promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-empty')).resolves.toBe('');
  });

  it('builds automatic turn context with structured citations and no irrelevant fallback', async () => {
    vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '8');
    const oauth = await createAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-oauth',
    });
    const database = await createAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-database',
    });
    const { promptInjection } = await modules();

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-auto',
      taskRunId: 'turn-auto',
      taskText: 'Audit OAuth login callback handling',
      workspaceId: 'workspace-a',
    }, fakeSemanticOptions);

    expect(result.promptBlock).toContain('<confirmed-ability-assets>');
    expect(result.promptBlock).toContain('Review OAuth callback and token exchange security.');
    expect(result.promptBlock).not.toContain('Plan database migrations with rollback windows.');
    // 适用/禁用条件随注入带进 prompt，模型拿得到硬约束。
    expect(result.promptBlock).toContain('applicable_when');
    expect(result.promptBlock).toContain('forbidden_when');
    expect(result.promptBlock).toContain('Unrelated casual conversation');
    expect(result.citations).toEqual([
      expect.objectContaining({
        assetId: oauth.asset.id,
        title: oauth.asset.title,
        type: 'rule',
        version: '1',
        scope: 'general',
        matchMethod: 'semantic',
        matchScore: 1,
      }),
    ]);
    expect(result.citations[0].projectionId).toMatch(/^proj-auto-/);
    expect(result.citations.map((citation) => citation.assetId)).not.toContain(database.asset.id);
  });

  it('carries only rendered automatic Semantica relations into answer validation evidence', async () => {
    vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '1');
    const entry = await createAssetWith({
      judgment: '家庭一周晚餐计划：先确定每天的菜品。',
      summary: 'Dinner planning workflow',
      sourceId: 'conversation-dinner-entry',
      applicableWhen: ['帮我安排家庭一周晚餐和周末准备'],
    });
    const shopping = await createAssetWith({
      judgment: '周末买菜清单：按晚餐计划整理食材。',
      summary: 'Weekend grocery workflow',
      sourceId: 'conversation-dinner-shopping',
      applicableWhen: ['帮我安排家庭一周晚餐和周末准备'],
    });
    const unrelated = await createAssetWith({
      judgment: '旅行路线规划：安排周末交通。',
      summary: 'Travel route workflow',
      sourceId: 'conversation-travel-route',
      applicableWhen: ['帮我安排家庭一周晚餐和周末准备'],
    });
    const { assets, promptInjection } = await modules();
    for (const item of [entry.asset, shopping.asset, unrelated.asset]) {
      await assets.updateAbilityAsset('user-a', item.id, {
        relations: [], reason: 'Semantica prompt evidence fixture reset', actor: 'user',
      });
    }
    await assets.updateAbilityAsset('user-a', shopping.asset.id, {
      relations: [{ kind: 'depends_on', assetId: entry.asset.id }],
      reason: 'Semantica prompt evidence fixture',
      actor: 'user',
    });

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-semantica-evidence',
      taskRunId: 'turn-semantica-evidence',
      taskText: '帮我安排家庭一周晚餐和周末准备',
      workspaceId: 'workspace-a',
    }, {
      minScore: 0.3,
      assessApplicability: fakeSemanticOptions.assessApplicability,
      embedTexts: async (texts: string[]) => texts.map((text, index) => (
        index === 0 || text.includes('家庭一周晚餐计划') ? [1, 0] : [0, 1]
      )),
    });

    const renderedIds = new Set(result.citations.map((citation) => citation.assetId));
    expect(renderedIds).toEqual(new Set([entry.asset.id, shopping.asset.id]));
    expect(renderedIds.has(unrelated.asset.id)).toBe(false);
    expect(result.answerEvidence?.assets.map((asset) => asset.assetId).sort()).toEqual(
      [...renderedIds].sort(),
    );
    expect(result.answerEvidence?.relations).toEqual([
      expect.objectContaining({
        paths: [expect.objectContaining({
          entryAssetId: entry.asset.id,
          assetId: shopping.asset.id,
          distance: 1,
          relationKind: 'depends_on',
          direction: 'incoming',
          evidencePath: [expect.objectContaining({
            fromAssetId: shopping.asset.id,
            toAssetId: entry.asset.id,
            kind: 'depends_on',
          })],
        })],
      }),
    ]);
    for (const relation of result.answerEvidence?.relations || []) {
      for (const relationPath of relation.paths) {
        expect(renderedIds.has(relationPath.entryAssetId)).toBe(true);
        expect(renderedIds.has(relationPath.assetId)).toBe(true);
      }
    }
  });

  it('keeps explicitly confirmed conversation assets ahead of automatic matches and deduplicates them', async () => {
    const oauth = await createAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-oauth',
    });
    const { refs, projection, storage, layout, promptInjection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', {
      assetId: oauth.asset.id,
      workspaceId: 'workspace-a',
      scope: 'global',
    });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'manual-task',
      workspaceId: 'workspace-a',
      purpose: 'global',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions);
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const messageFile = layout.conversationMessageFile('user-a', 'cid-manual');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-manual', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'confirmed',
      recall_projection_card: { projectionId: confirmed.id },
    });

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-manual',
      taskRunId: 'turn-auto-after-manual',
      taskText: 'Audit OAuth login callback handling',
      workspaceId: 'workspace-a',
    }, fakeSemanticOptions);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      assetId: oauth.asset.id,
      projectionId: confirmed.id,
      matchMethod: 'manual',
    });
  });

  it('injects only the explicitly committed projection for a KSTAR turn', async () => {
    const selected = await createAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-explicit-oauth',
    });
    const unrelated = await createAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-explicit-database',
    });
    const { projection, promptInjection } = await modules();
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-explicit',
      purpose: 'global',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions);
    const revised = await projection.reviseContextProjection('user-a', preview.id, {
      removeAssetIds: [unrelated.asset.id],
    });
    const confirmed = await projection.confirmContextProjection('user-a', revised.id);

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-explicit',
      taskRunId: 'turn-explicit',
      taskText: 'Audit OAuth login callback handling',
      committedProjectionId: confirmed.id,
      forecastId: 'wf-explicit',
    });

    expect(result.citations).toEqual([
      expect.objectContaining({
        assetId: selected.asset.id,
        projectionId: confirmed.id,
        forecastId: 'wf-explicit',
        matchMethod: 'manual',
      }),
    ]);
    // Prompt blocks are JSON-escaped: the enriched statement (judgment +
    // value, newline-joined) appears with an escaped backslash-n. The
    // unrelated asset must never leak in.
    // 2026-09-19 归一化：value 缺省兜底=judgment，标题（summary）不再拼进正文。
    expect(result.promptBlock).toContain('Review OAuth callback and token exchange security.');
    expect(result.promptBlock).not.toContain(unrelated.asset.statement);
    // committed 投影同样带边界条件。
    expect(result.promptBlock).toContain('applicable_when');
    expect(result.promptBlock).toContain('forbidden_when');
    expect(result.promptBlock).toContain('Unrelated casual conversation');
  });

  it('preserves Semantica relation evidence for a governed KSTAR workspace projection', async () => {
    vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '1');
    const entry = await createAssetWith({
      judgment: '家庭一周晚餐计划：先确定每天的菜品。',
      summary: 'Dinner planning workflow',
      sourceId: 'conversation-kstar-dinner-entry',
      applicableWhen: ['工作日晚餐', '周末准备', '家庭一周晚餐'],
    });
    const shopping = await createAssetWith({
      judgment: '周末买菜清单：按晚餐计划整理食材。',
      summary: 'Weekend grocery workflow',
      sourceId: 'conversation-kstar-dinner-shopping',
      applicableWhen: ['工作日晚餐', '周末准备', '家庭一周晚餐'],
    });
    const { assets, refs, projection, promptInjection } = await modules();
    await assets.updateAbilityAsset('user-a', entry.asset.id, {
      relations: [],
      scope: 'general',
      scopePolicy: {},
      reason: 'KSTAR Semantica fixture reset',
      actor: 'user',
    });
    await assets.updateAbilityAsset('user-a', shopping.asset.id, {
      relations: [{ kind: 'depends_on', assetId: entry.asset.id }],
      scope: 'general',
      scopePolicy: {},
      reason: 'KSTAR Semantica fixture',
      actor: 'user',
    });
    await refs.addWorkspaceAssetReference('user-a', {
      assetId: entry.asset.id, workspaceId: 'workspace-a', scope: 'general',
    });
    await refs.addWorkspaceAssetReference('user-a', {
      assetId: shopping.asset.id, workspaceId: 'workspace-a', scope: 'general',
    });
    const storedEntry = await assets.readAbilityAsset('user-a', entry.asset.id);
    const workspaceRefs = await refs.listWorkspaceAssetReferences('user-a');
    expect({ scope: storedEntry.scope, scopePolicy: storedEntry.scopePolicy }).toEqual({
      scope: 'general', scopePolicy: undefined,
    });
    expect(workspaceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: entry.asset.id, workspaceId: 'workspace-a', scope: 'global' }),
      expect.objectContaining({ assetId: shopping.asset.id, workspaceId: 'workspace-a', scope: 'global' }),
    ]));

    const committed = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-kstar-semantica',
      workspaceId: 'workspace-a',
      purpose: 'conversation_task',
      taskText: '请安排工作日晚餐和周末准备',
      authorization: 'workspace_policy',
      confirm: true,
    }, {
      minScore: 0.3,
      embedTexts: async (texts: string[]) => texts.map((text, index) => {
        if (index === 0 || text.includes('家庭一周晚餐计划')) return [1, 0];
        return [0, 1];
      }),
    });
    expect(committed.omittedRefs).toEqual([]);
    expect(committed.assetIds).toEqual(expect.arrayContaining([entry.asset.id, shopping.asset.id]));
    expect(committed.assetMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: shopping.asset.id,
        matchMethod: 'ontology',
        entryAssetId: entry.asset.id,
        distance: 1,
        evidencePath: [expect.objectContaining({
          fromAssetId: shopping.asset.id,
          toAssetId: entry.asset.id,
          kind: 'depends_on',
        })],
      }),
    ]));

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-kstar-semantica',
      taskRunId: 'turn-kstar-semantica',
      taskText: '请安排工作日晚餐和周末准备',
      workspaceId: 'workspace-a',
      committedProjectionId: committed.id,
    });

    expect(result.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: shopping.asset.id, matchMethod: 'ontology' }),
    ]));
    expect(result.answerEvidence?.relations).toEqual([
      expect.objectContaining({
        query: '请安排工作日晚餐和周末准备',
        paths: [expect.objectContaining({
          entryAssetId: entry.asset.id,
          assetId: shopping.asset.id,
          distance: 1,
          relationKind: 'depends_on',
        })],
      }),
    ]);
  });

  it('rejects committed injection when a frozen asset version changed', async () => {
    const selected = await createAssetWith({
      judgment: 'Review OAuth callback state.',
      summary: 'OAuth callback state',
      sourceId: 'conversation-version-drift',
    });
    const { projection, promptInjection } = await modules();
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-drift', purpose: 'global',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    await assets.updateAbilityAsset('user-a', selected.asset.id, {
      statement: 'Changed after Forecast.', actor: 'user', reason: 'test drift',
    });

    await expect(promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-drift', taskRunId: 'turn-drift', taskText: 'Review OAuth',
      committedProjectionId: confirmed.id,
    })).rejects.toMatchObject({ code: 'projection_asset_version_changed' });
  });

  it('injects an asset only once when it sits in both the committed and the conversation projection', async () => {
    const oauth = await createAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-overlap-oauth',
    });
    const { projection, storage, layout, promptInjection } = await modules();
    // 两条确认投影含同一资产：任务 committed 挂载 + 会话消息卡片。
    const committedPreview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-overlap-committed',
      purpose: 'global',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions);
    const committed = await projection.confirmContextProjection('user-a', committedPreview.id);

    const sessionPreview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-overlap-session',
      purpose: 'global',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions);
    const session = await projection.confirmContextProjection('user-a', sessionPreview.id);
    const messageFile = layout.conversationMessageFile('user-a', 'cid-overlap');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-overlap', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'overlap',
      recall_projection_card: { projectionId: session.id },
    });

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-overlap',
      taskRunId: 'turn-overlap',
      taskText: 'Audit OAuth login callback handling',
      committedProjectionId: committed.id,
    }, fakeSemanticOptions);

    // 修复前：合并去重键含 projectionId，两条投影 id 必不相同 → 过滤永不生效，
    // 同一资产 statement 双份注入、usage 流水双计（升档链输入被虚增）。
    expect(result.citations.filter((c) => c.assetId === oauth.asset.id)).toHaveLength(1);
    expect(result.citations[0].projectionId).toBe(committed.id);
    const occurrences = result.promptBlock.match(new RegExp(oauth.asset.id, 'g')) || [];
    expect(occurrences).toHaveLength(1);
  });

  it('returns no turn context when no approved memory is relevant', async () => {
    await createAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-database',
    });
    const { promptInjection } = await modules();

    await expect(promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-empty-auto',
      taskRunId: 'turn-empty-auto',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions)).resolves.toEqual({ promptBlock: '', citations: [] });
  });

  it('keeps the prompt envelope valid and citations aligned when assets exceed the block budget', async () => {
    vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '8');
    for (let index = 0; index < 12; index += 1) {
      await createAssetWith({
        // 各条用不同字母填充：正文纯净化（value 兜底=judgment）后，十二条只差
        // 序号的文本语义相似 ≥0.85，会撞 promote 的防分裂闸——这是闸门的正确行为。
        judgment: `Rule ${index}: ${String.fromCharCode(97 + (index % 26)).repeat(1_900)}`,
        summary: `Long rule ${index}`,
        sourceId: `conversation-long-${index}`,
      });
    }
    const { promptInjection } = await modules();

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-long',
      taskRunId: 'turn-long',
      taskText: 'Apply the long rules',
    }, { ...fakeSemanticOptions, limit: 12 });

    expect(result.promptBlock.length).toBeLessThanOrEqual(14_000);
    expect(result.promptBlock).toMatch(/<confirmed-ability-assets>[\s\S]*<\/confirmed-ability-assets>$/);
    const payload = result.promptBlock.split('\n').at(-2)!;
    const records = JSON.parse(payload) as Array<{ asset_id: string }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(12);
    expect(result.citations.map((citation) => citation.assetId))
      .toEqual(records.map((record) => record.asset_id));

    const omissions = await import('../../../../src/main/features/recall/projection-omission');
    const unavailableAudit = vi.spyOn(omissions, 'recordProjectionOmission').mockRejectedValue(new Error('synthetic audit unavailable'));
    try {
      const continued = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-long', taskRunId: 'turn-long-audit-unavailable', taskText: 'Apply the long rules',
      }, { ...fakeSemanticOptions, limit: 12 });
      expect(continued.promptBlock).toMatch(/<confirmed-ability-assets>[\s\S]*<\/confirmed-ability-assets>$/);
      const continuedRecords = JSON.parse(continued.promptBlock.split('\n').at(-2)!);
      expect(continued.citations.map(citation => citation.assetId)).toEqual(continuedRecords.map((record: { asset_id: string }) => record.asset_id));
      expect(continuedRecords.length).toBeGreaterThan(0);
      expect(continuedRecords.length).toBeLessThan(12);
      expect(unavailableAudit.mock.calls.some(call => call[3] === 'prompt_budget')).toBe(true);

      const { assets, projection } = await modules();
      const explicit = await projection.previewContextProjection('user-a', {
        taskRunId: 'turn-long-explicit', purpose: 'global', authorization: 'user_confirmed', confirm: true,
        conversationId: 'cid-long-explicit', explicitAssetIds: (await assets.listAbilityAssets('user-a')).map(asset => asset.id),
      });
      const committed = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-long-explicit', taskRunId: 'turn-long-explicit', taskText: 'Apply the long rules', committedProjectionId: explicit.id,
      });
      const committedRecords = JSON.parse(committed.promptBlock.split('\n').at(-2)!);
      expect(committedRecords.length).toBeGreaterThan(0);
      expect(committedRecords.length).toBeLessThan(12);
      expect(committed.citations.map(citation => citation.assetId)).toEqual(committedRecords.map((record: { asset_id: string }) => record.asset_id));
    } finally { unavailableAudit.mockRestore(); }
  });

  describe('profile memory channel', () => {
    async function writeProfileMemory() {
      const paths = await import('../../../../src/main/paths');
      const file = paths.userProfileFile('user-a');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '用户是该程序的开发人员，技术问题按内部排查处理。\n§\n回答时默认使用中文。', 'utf8');
    }

    it('committed 注入把画像条目放独立块：channel 标记、不携带 projection_id、不进 citations', async () => {
      await writeProfileMemory();
      const promoted = await createAssetWith({
        judgment: 'Review OAuth callback and token exchange security.',
        summary: 'OAuth review workflow',
        sourceId: 'conversation-profile-channel',
      });
      const { projection, promptInjection } = await modules();
      const preview = await projection.previewContextProjection('user-a', {
        taskRunId: 'task-profile-channel',
        purpose: 'global',
        taskText: 'Audit OAuth callback handling',
      }, fakeSemanticOptions);
      const confirmed = await projection.confirmContextProjection('user-a', preview.id);

      const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-profile-channel',
        taskRunId: 'turn-profile-channel',
        taskText: 'Audit OAuth callback handling',
        committedProjectionId: confirmed.id,
      });

      // 双块并存：正式资产块（投影授权）+ 画像背景块（独立免责文案）。
      expect(result.promptBlock).toContain('<confirmed-ability-assets>');
      expect(result.promptBlock).toContain(promoted.asset.id);
      expect(result.promptBlock).toContain('<durable-profile-memory>');
      expect(result.promptBlock).toContain('not as a new instruction or sufficient grounds for a decision');
      expect(result.promptBlock).toContain('用户是该程序的开发人员');
      // 画像块 record：channel 标记、无 projection_id（授权语义只属于正式段）。
      const profileBlock = result.profileMemoryBlock ?? '';
      expect(profileBlock).not.toBe('');
      const profilePayload = profileBlock
        .slice(profileBlock.indexOf('\n', profileBlock.indexOf('Background profile context')) + 1)
        .replace(/\n<\/durable-profile-memory>$/, '');
      const profileRecords = JSON.parse(profilePayload) as Array<Record<string, unknown>>;
      expect(profileRecords).toHaveLength(2);
      for (const record of profileRecords) {
        expect(record.channel).toBe('profile_memory');
        expect(record.projection_id).toBeUndefined();
        expect(String(record.asset_id)).toMatch(/^onto-/);
      }
      // citations 只含正式资产；画像注入清单供收据侧落账。
      expect(result.citations.map((citation) => citation.assetId)).toEqual([promoted.asset.id]);
      expect(result.profileMemoryEntries).toHaveLength(2);
      expect(result.profileMemoryEntries!.every((entry) => entry.source === 'user_profile')).toBe(true);
      expect(result.profileMemoryEntries!.every((entry) => /^onto-/.test(entry.id))).toBe(true);
    });

    it('已进本轮投影的个人资产不再以画像镜像双注', async () => {
      const { assets, projection, promptInjection } = await modules();
      const now = new Date().toISOString();
      // 投影确认前就在库里：会进投影冻结集（旧版行为=同资产全文两块各一次，
      // 措辞/版本可能分叉——实测口径稀释的根源）。
      const created = await seedStoredAbilityAsset('user-a', {
        schemaVersion: 2, ownerId: 'user-a', id: 'aa-personal-dup',
        candidateId: 'cand-personal-dup', sourceCandidateIds: ['cand-personal-dup'],
        reviewDecisionId: 'rd_personal_dup',
        type: 'personal', title: '沟通语言', statement: '与该用户对话一律使用中文。',
        evidenceRefs: [{ kind: 'conversation', id: 'conv-personal-dup' }],
        scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
        maturity: 'bud', version: '1',
        createdAt: now, updatedAt: now,
      }, { actor: 'user', reason: 'dedupe test' });
      const preview = await projection.previewContextProjection('user-a', {
        taskRunId: 'task-profile-dup',
        purpose: 'global',
        taskText: 'Audit OAuth callback handling',
      }, fakeSemanticOptions);
      const confirmed = await projection.confirmContextProjection('user-a', preview.id);
      const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-profile-dup',
        taskRunId: 'turn-profile-dup',
        taskText: 'Audit OAuth callback handling',
        committedProjectionId: confirmed.id,
      });
      // 授权投影块是更强形态：保留全文与 projection 引用。
      expect(result.promptBlock).toContain('<confirmed-ability-assets>');
      expect(result.promptBlock).toContain(created.id);
      // 画像块不再重复注入同 id；注入清单亦不含（收据按授权通道落账）。
      const profileBlock = result.profileMemoryBlock ?? '';
      expect(profileBlock.includes(created.id)).toBe(false);
      expect((result.profileMemoryEntries ?? []).map((entry) => entry.id)).not.toContain(created.id);
    });

    it('库里已有正式个人资产（未进本轮投影冻结集）：画像块渲染真实 id/成熟度/版本，注入清单可回连资产', async () => {
      const { assets, projection, promptInjection } = await modules();
      const promoted = await createAssetWith({
        judgment: 'Review OAuth callback and token exchange security.',
        summary: 'OAuth review workflow',
        sourceId: 'conversation-profile-real',
      });
      const preview = await projection.previewContextProjection('user-a', {
        taskRunId: 'task-profile-real',
        purpose: 'global',
        taskText: 'Audit OAuth callback handling',
      }, fakeSemanticOptions);
      const confirmed = await projection.confirmContextProjection('user-a', preview.id);
      // 投影确认之后才落库的个人资产：可读、但不在冻结集 → 走画像镜像通道。
      const now = new Date().toISOString();
      const created = await seedStoredAbilityAsset('user-a', {
        schemaVersion: 2, ownerId: 'user-a', id: 'aa-personal-channel',
        candidateId: 'cand-personal-channel', sourceCandidateIds: ['cand-personal-channel'],
        reviewDecisionId: 'rd_personal_channel',
        type: 'personal', title: '沟通语言', statement: '与该用户对话一律使用中文。',
        evidenceRefs: [{ kind: 'conversation', id: 'conv-personal-channel' }],
        scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified',
        maturity: 'bud', version: '1',
        createdAt: now, updatedAt: now,
      }, { actor: 'user', reason: 'profile channel test' });
      await assets.setAbilityAssetMaturity('user-a', created.id, 'transfer_validated');

      const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-profile-real',
        taskRunId: 'turn-profile-real',
        taskText: 'Audit OAuth callback handling',
        committedProjectionId: confirmed.id,
      });

      const profileBlock = result.profileMemoryBlock ?? '';
      expect(profileBlock).not.toBe('');
      const profilePayload = profileBlock
        .slice(profileBlock.indexOf('\n', profileBlock.indexOf('Background profile context')) + 1)
        .replace(/\n<\/durable-profile-memory>$/, '');
      const profileRecords = JSON.parse(profilePayload) as Array<Record<string, unknown>>;
      // 真实资产过闸门后镜像进块：id/成熟度/版本与库内记录一致，可回连审计。
      const record = profileRecords.find((row) => row.asset_id === created.id);
      expect(record).toBeTruthy();
      expect(record!.maturity).toBe('transfer_validated');
      expect(record!.version).toBe(created.version);
      // 注入清单（供回执侧落账）带真实 id——用量统计与成熟度证据链的钥匙。
      expect(result.profileMemoryEntries?.map((entry) => entry.id)).toContain(created.id);
      expect(result.profileMemoryEntries?.every((entry) => !/^onto-/.test(entry.id))).toBe(true);
      // 已进投影的规则资产不属于画像镜像（loadOntologyAssets 只镜像 personal）。
      expect((result.profileMemoryEntries ?? []).map((entry) => entry.id)).not.toContain(promoted.asset.id);
    });

    it('无 durable memory 时不产生画像块，返回结构不携带画像字段', async () => {
      const promoted = await createAssetWith({
        judgment: 'Review OAuth callback and token exchange security.',
        summary: 'OAuth review workflow',
        sourceId: 'conversation-no-profile',
      });
      const { projection, promptInjection } = await modules();
      const preview = await projection.previewContextProjection('user-a', {
        taskRunId: 'task-no-profile',
        purpose: 'global',
        taskText: 'Audit OAuth callback handling',
      }, fakeSemanticOptions);
      const confirmed = await projection.confirmContextProjection('user-a', preview.id);

      const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-no-profile',
        taskRunId: 'turn-no-profile',
        taskText: 'Audit OAuth callback handling',
        committedProjectionId: confirmed.id,
      });

      expect(result.promptBlock).toContain(promoted.asset.id);
      expect(result.promptBlock).not.toContain('<durable-profile-memory>');
      expect(result.profileMemoryBlock).toBeUndefined();
      expect(result.profileMemoryEntries).toBeUndefined();
    });
  });

  describe('asset-context 单块三区（呈现面合一）', () => {
    it('composeAssetContextBlock：三区有序合一块、内层标签保留、空子区省略、全空得空串', async () => {
      const { composeAssetContextBlock } = await import('../../../../src/main/features/recall/prompt-injection');
      const merged = composeAssetContextBlock({
        authorized: '<confirmed-ability-assets>\n[{"asset_id":"aa-x"}]\n</confirmed-ability-assets>',
        profile: '<durable-profile-memory>\n[{"channel":"profile_memory"}]\n</durable-profile-memory>',
        catalog: 'Asset catalog: 3 assets are available for this task.',
      });
      expect(merged.startsWith('<asset-context>')).toBe(true);
      expect(merged.trimEnd().endsWith('</asset-context>')).toBe(true);
      // 三区顺序固定：授权 → 画像 → 目录。
      const orderAuth = merged.indexOf('### Task-authorized assets');
      const orderProfile = merged.indexOf('### Durable profile');
      const orderCatalog = merged.indexOf('### Discoverable catalog');
      expect(orderAuth).toBeGreaterThan(-1);
      expect(orderAuth).toBeLessThan(orderProfile);
      expect(orderProfile).toBeLessThan(orderCatalog);
      // 内层标签原样保留（既有模型面契约不变）。
      expect(merged).toContain('<confirmed-ability-assets>');
      expect(merged).toContain('<durable-profile-memory>');
      // 统一导语只出现一次（吸收三段旧导语，不再逐块重复）。
      expect(merged.match(/<asset-context>/g)).toHaveLength(1);
      // 空子区整体省略——不留空标题。
      const noProfile = composeAssetContextBlock({
        authorized: '<confirmed-ability-assets>x</confirmed-ability-assets>',
        catalog: 'Asset catalog: 2 assets',
      });
      expect(noProfile).not.toContain('### Durable profile');
      expect(noProfile).toContain('### Task-authorized assets');
      expect(noProfile).toContain('### Discoverable catalog');
      // 全空 → 空串（调用方据此不 append）。
      expect(composeAssetContextBlock({})).toBe('');
      expect(composeAssetContextBlock({ authorized: '', profile: '', catalog: '' })).toBe('');
    });

    it('装配交出裸块（authorizedAssetsBlock/profileAssetsBlock）：带标签、不带旧长导语', async () => {
      const paths = await import('../../../../src/main/paths');
      const file = paths.userProfileFile('user-a');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, '用户偏好真机画像条目。\n§\n第二条画像。', 'utf8');
      const promoted = await createAssetWith({
        judgment: 'Review OAuth callback and token exchange security.',
        summary: 'OAuth review workflow',
        sourceId: 'conversation-asset-context-merge',
      });
      const { projection, promptInjection } = await modules();
      const preview = await projection.previewContextProjection('user-a', {
        taskRunId: 'task-asset-context-merge', purpose: 'global', taskText: 'Audit OAuth callback handling',
      }, fakeSemanticOptions);
      const confirmed = await projection.confirmContextProjection('user-a', preview.id);

      const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
        cid: 'cid-asset-context-merge',
        taskRunId: 'turn-asset-context-merge',
        taskText: 'Audit OAuth callback handling',
        committedProjectionId: confirmed.id,
      });

      // 裸授权块：标签 + 记录，无旧长导语（导语上移到 <asset-context> 总导语）。
      expect(result.authorizedAssetsBlock ?? '').toContain('<confirmed-ability-assets>');
      expect(result.authorizedAssetsBlock ?? '').toContain(promoted.asset.id);
      expect(result.authorizedAssetsBlock ?? '').not.toContain('### Stored reusable ability assets');
      // 裸画像块：标签 + 记录，无旧免责段（语义并入子区头）。
      expect(result.profileAssetsBlock ?? '').toContain('<durable-profile-memory>');
      expect(result.profileAssetsBlock ?? '').not.toContain('### Durable profile memory');
      expect(result.profileAssetsBlock ?? '').not.toContain('Background profile context for this user');
      // 兼容面不动：旧 promptBlock / profileMemoryBlock 形态保持（CogSeed Runtime 路径仍用）。
      expect(result.promptBlock).toContain('### Stored reusable ability assets');
    });
  });

  describe('Commander-dispatched assets (agent grant)', () => {
    it('renders only the granted active assets with the dispatched block', async () => {
      const { assets, promptInjection } = await modules();
      const promoted = await createAsset();
      const { asset } = promoted;
      const blocked = await seedStoredAbilityAsset('user-a', {
        schemaVersion: 2,
        ownerId: 'user-a',
        id: 'aa-000000000000000000000000',
        candidateId: 'cand-blocked',
        title: 'Blocked asset',
        statement: 'Should never be dispatched while paused.',
        type: 'rule',
        scope: 'global',
        evidenceRefs: [{ kind: 'execution', id: 'exec-blocked' }],
        reviewDecisionId: 'legacy-untracked',
        lifecycleStatus: 'user_confirmed_unverified',
        status: 'paused',
        maturity: 'seed',
        version: '1',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      }, 'test paused asset');

      const result = await promptInjection.buildDispatchedAssetsPromptBlock('user-a', [
        asset.id,
        blocked.id,
        'aa-nonexistent',
      ]);

      expect(result.promptBlock).toContain('<commander-dispatched-assets>');
      expect(result.promptBlock).toContain('The Commander explicitly granted');
      expect(result.promptBlock).toContain(asset.title);
      expect(result.promptBlock).not.toContain('Blocked asset');
      expect(result.assetIds).toEqual([asset.id]);
      // 派发授权注入同样带边界条件（createAsset 带
      // applicableWhen/forbiddenWhen）。
      expect(result.promptBlock).toContain('applicable_when');
      expect(result.promptBlock).toContain('forbidden_when');
      expect(result.promptBlock).toContain('Informal brainstorming without a decision');
    });

    it('returns an empty block when nothing is granted', async () => {
      const { promptInjection } = await modules();
      const result = await promptInjection.buildDispatchedAssetsPromptBlock('user-a', ['aa-unknown']);
      expect(result).toEqual({ promptBlock: '', assetIds: [], assets: [] });
    });
  });
});

/**
 * 注入契约：适用/禁用条件必须随资产进入**每一条**注入路径。
 *
 * `forbidden_when` 是硬安全约束。晋升 gate 校验它、「我的资产」详情页显示它，
 * 但在此之前三条注入路径的 record 里都没有——唯独模型拿不到。用户看到
 * 「禁止：…」以为约束在生效，实际上模型从来没读到过。
 *
 * 这组用例按**路径**而不是按函数组织：三条路径各自独立构造 record，任何一条
 * 漏掉都是一个真实的安全缺口，所以必须逐条钉死，不能只测其中一条。
 */
describe('适用/禁用条件注入契约', () => {
  it('carries forbidden_when into the confirmed-projection path', async () => {
    const asset = await createAsset();
    const { refs, projection, storage, layout, promptInjection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-cond', workspaceId: 'workspace-a', purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const messageFile = layout.conversationMessageFile('user-a', 'cid-cond');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-cond', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'card',
      recall_projection_card: { projectionId: confirmed.id },
    });

    const block = await promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-cond');

    expect(block).toContain('forbidden_when');
    expect(block).toContain('Informal brainstorming without a decision');
    expect(block).toContain('applicable_when');
    expect(block).toContain('Architecture review and runtime-boundary changes');
  });

  it('carries forbidden_when into the committed-projection path', async () => {
    const selected = await createAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-cond-committed',
    });
    const { projection, promptInjection } = await modules();
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-cond-committed',
      purpose: 'global',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions);
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);

    const result = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-cond-committed',
      taskRunId: 'turn-cond-committed',
      taskText: 'Audit OAuth login callback handling',
      committedProjectionId: confirmed.id,
    });

    expect(result.promptBlock).toContain(selected.asset.id);
    expect(result.promptBlock).toContain('forbidden_when');
    expect(result.promptBlock).toContain('Unrelated casual conversation');
  });

  it('carries forbidden_when into the Commander-dispatch path', async () => {
    const asset = await createAsset();
    const { promptInjection } = await modules();

    const result = await promptInjection.buildDispatchedAssetsPromptBlock('user-a', [asset.asset.id]);

    expect(result.assetIds).toEqual([asset.asset.id]);
    expect(result.promptBlock).toContain('forbidden_when');
    expect(result.promptBlock).toContain('Informal brainstorming without a decision');
  });

  /**
   * 缺失 = 「没提出过」，**不是**「无限制」。
   *
   * 所以空条件不写字段，而不是写一个空数组——写空值会让模型把「没说」读成
   * 「已确认无限制」，那比不带更危险：它把一个未知伪装成一个结论。
   */
  it('omits the fields entirely when an asset carries no conditions', async () => {
    const { candidates, promptInjection } = await modules();
    // 用 personal：适用/禁用条件是 RuleAsset 的准入门槛，rule 类候选
    // 缺边界会被 `rule_boundary_required` 直接挡下，构造不出「无条件的规则」。
    // personal 天然没有这两个字段，正是要测的那种资产。
    const candidate = await createNightlyCandidateFixture('user-a', {
      judgment: 'Works as a product owner defining release scope.',
      summary: 'Product owner role slice',
      suggestedType: 'personal',
      suggestedScope: 'global',
      spaceId: 'workspace-a',
      sourceRefs: [{ kind: 'execution', id: 'exec-no-cond' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
    await elevateToTransferVerified(promoted.asset.id);

    const result = await promptInjection.buildDispatchedAssetsPromptBlock('user-a', [promoted.asset.id]);

    expect(result.promptBlock).toContain(promoted.asset.id);
    expect(result.promptBlock).not.toContain('forbidden_when');
    expect(result.promptBlock).not.toContain('applicable_when');
  });
});


it('keeps the complete unclassified method and its final limitation when explicitly dispatched', async () => {
  const { candidates, promptInjection } = await modules();
  const statement = '适用条件：核对工程依据。\n\n1. 核对证据。\n2. 记录适用范围。\n\n' + '方法步骤应保持原有顺序。'.repeat(190) + '\n\n局限：未核对外部环境时不能据此宣称验证完成。';
  const candidate = await createNightlyCandidateFixture('user-a', {
    judgment: statement, summary: '条件证据核对流程', value: '便于以后复用核对过程并保留结论的局限。',
    suggestedType: 'cognition', suggestedScope: 'project', suggestedAction: 'create',
    sourceRefs: [{ kind: 'execution', id: 'exec-cognition-complete' }],
  });
  const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
  expect((await promptInjection.evaluateRecallAssetRuntimeEligibility('user-a', asset, { operation: 'default_injection' })).eligible).toBe(false);
  const dispatched = await promptInjection.buildDispatchedAssetsPromptBlock('user-a', [asset.id]);
  expect(dispatched.assetIds).toEqual([asset.id]);
  expect(dispatched.promptBlock).toContain('未核对外部环境时不能据此宣称验证完成');
  expect(dispatched.promptBlock).toContain(JSON.stringify(statement).slice(1, -1));
});


it('omits complete dispatched cognition records when the shared prompt budget is full', async () => {
  const { candidates, promptInjection } = await modules();
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    const statement = '方法条件：明确选用。\n' + String.fromCharCode(97 + index).repeat(3_700) + `\n局限末尾标记${index}`;
    const candidate = await createNightlyCandidateFixture('user-a', {
      judgment: statement, summary: `预算完整方法${index}`, value: '以完整过程及局限支持后续显式选用。',
      suggestedType: 'cognition', suggestedScope: 'project', suggestedAction: 'create',
      sourceRefs: [{ kind: 'execution', id: `exec-budget-complete-${index}` }],
    });
    const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
    ids.push(asset.id);
  }
  const result = await promptInjection.buildDispatchedAssetsPromptBlock('user-a', ids);
  expect(result.promptBlock.length).toBeLessThanOrEqual(14_000);
  expect(result.assetIds.length).toBeGreaterThan(0);
  expect(result.assetIds.length).toBeLessThan(ids.length);
  expect(result.assets.map(asset => asset.id)).toEqual(result.assetIds);
  expect(result.omittedAssetIds).toEqual(ids.slice(result.assetIds.length));
  const { prepareAssetUsageClaim } = await import('../../../../src/main/features/recall/asset-usage-claim');
  await expect(prepareAssetUsageClaim('user-a', 'turn-budget', { assetId: result.omittedAssetIds![0], assetVersion: '1',
    outputExcerpt: 'The omitted asset cannot support adoption.' }, result.assets.map(asset => ({ assetId: asset.id, assetVersion: asset.version }))))
    .rejects.toThrow('not supplied');
  for (let index = 0; index < ids.length; index++) {
    expect(result.promptBlock.includes(`局限末尾标记${index}`)).toBe(result.assetIds.includes(ids[index]));
  }
});
