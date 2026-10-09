import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
let tmp: string; let previous: string | undefined;
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-projection-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = tmp; });
afterEach(async () => {
  try {
    await drainMainRuntimeForTest('user-a');
  } finally {
    if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
// 自动投影是"静默默认注入"，按 PRD 3.6 只接纳 Transfer Verified 及以上。
// 这些用例考的是相关性 / 提示词结构 / 引用对齐，不是成熟度闸门，所以先把资产
// 抬到够格的档位；闸门本身由 formal-asset-runtime.test.ts 覆盖。
async function elevateToTransferVerified(assetId: string) {
  const assets = await import('../../../../src/main/features/recall/asset-service');
  await assets.setAbilityAssetMaturity('user-a', assetId, 'transfer_validated');
}

async function modules() { const [candidates, assets, refs, projection] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/asset-service'), import('../../../../src/main/features/recall/workspace-refs'), import('../../../../src/main/features/recall/context-projection')]); return { candidates, assets, refs, projection }; }
async function createAsset(spaceId?: string) { const { candidates } = await modules(); const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Preserve source evidence in reviews.', suggestedType: 'rule', applicableWhen: ['Formal review with traceable evidence'], forbiddenWhen: ['Informal discussion without a review decision'], suggestedScope: 'review,project', ...(spaceId ? { spaceId } : {}), sourceRefs: [{ kind: 'execution', id: 'exec-a' }, { kind: 'memory', id: 'mem-a' }] }); const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });

  await elevateToTransferVerified(promoted.asset.id);
  return promoted; }

async function createAssetWith(input: { judgment: string; summary: string; scope?: string; sourceId: string; spaceId?: string }) {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    applicableWhen: ['正式评审与架构决策时'],
    forbiddenWhen: ['内部快速对齐'],
    suggestedScope: input.scope || 'review',
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    sourceRefs: [{ kind: 'execution', id: input.sourceId }],
  });
  const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
}

async function createAutomaticAssetWith(input: {
  judgment: string;
  summary: string;
  sourceId: string;
  sourceKind?: 'conversation' | 'artifact_file';
  spaceId?: string;
  applicableWhen?: string[];
}) {
  const { candidates } = await modules();
  const sourceKind = input.sourceKind || 'conversation';
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    applicableWhen: input.applicableWhen || ['OAuth'],
    forbiddenWhen: ['内部快速对齐'],
    suggestedScope: 'global',
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    sourceRefs: [{
      kind: sourceKind,
      id: input.sourceId,
      subtype: sourceKind === 'conversation' ? 'session' : 'artifact',
      scope: 'personal',
    }],
  });
  const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
}

const fakeSemanticOptions = {
  embedTexts: async (texts: string[]) => texts.map((text) => {
    const lower = text.toLowerCase();
    if (lower.includes('oauth')) return [1, 0];
    if (lower.includes('database')) return [0, 1];
    return [0.2, 0.2];
  }),
};

describe('Recall context projection scope policy', () => {
  async function promoteScopedAsset(judgment: string, sourceId: string) {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment,
      summary: 'Scoped knowledge',
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'review',
      spaceId: 'workspace-a',
      sourceRefs: [{ kind: 'execution', id: sourceId }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
  }

  it('excludes assets whose scope policy restricts the projection workspace or purpose', async () => {
    const { refs, projection, assets } = await modules();
    const asset = (await promoteScopedAsset('Scoped OAuth review knowledge.', 'exec-scope')).asset;
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await assets.updateAbilityAsset('user-a', asset.id, {
      scopePolicy: { workspaceIds: ['workspace-other'], purposeTags: ['database'] },
      reason: 'narrow scope',
      actor: 'user',
    });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-scope', workspaceId: 'workspace-a', purpose: 'review',
    });

    expect(preview.assetIds).toEqual([]);
    expect(preview.omittedRefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ assetId: asset.id, reason: 'scope_mismatch' })]),
    );
  });

  it('includes an asset when its scope policy matches the projection context', async () => {
    const { refs, projection, assets } = await modules();
    const asset = (await promoteScopedAsset('OAuth review knowledge in workspace.', 'exec-scope-ok')).asset;
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await assets.updateAbilityAsset('user-a', asset.id, {
      scopePolicy: { workspaceIds: ['workspace-a'], purposeTags: ['review'] },
      reason: 'match scope',
      actor: 'user',
    });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-scope-ok', workspaceId: 'workspace-a', purpose: 'review',
    });

    expect(preview.assetIds).toEqual([asset.id]);
  });
});

describe('RecallView and ContextProjection', () => {
  it('previews workspace-scoped active assets and explains omitted assets', async () => {
    const { asset } = await createAsset('workspace-a');
    const { refs, assets, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const otherCandidate = await (await modules()).candidates.saveRecallCandidate('user-a', { judgment: 'Only use archived data with confirmation.', suggestedType: 'rule', applicableWhen: ['Archive restoration and audit'], forbiddenWhen: ['Live operational changes'], suggestedScope: 'archive', sourceRefs: [{ kind: 'memory', id: 'mem-b' }] });
    const other = await (await modules()).candidates.promoteRecallCandidate('user-a', otherCandidate.id, { actor: 'user' });
    await assets.pauseAbilityAsset('user-a', other.asset.id, { actor: 'user', reason: 'not ready' });

    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed' });
    expect(preview.status).toBe('preview');
    expect(preview.assetIds).toEqual([asset.id]);
    expect(preview.sourceRefs.map((ref) => ref.id)).toEqual(['exec-a', 'mem-a']);
    expect(preview.omittedRefs).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: other.asset.id, reason: 'asset_paused' })]));
  });

  it('excludes archived, deleted, and purged assets from a projection preview', async () => {
    const { assets, projection } = await modules();
    const archived = await createAssetWith({ judgment: 'Archive checklist knowledge.', summary: 'Archive checklist', sourceId: 'exec-archived' });
    const deleted = await createAssetWith({ judgment: 'Deleted checklist knowledge.', summary: 'Deleted checklist', sourceId: 'exec-deleted' });
    const purged = await createAssetWith({ judgment: 'Purged checklist knowledge.', summary: 'Purged checklist', sourceId: 'exec-purged' });
    await assets.archiveAbilityAsset('user-a', archived.asset.id, { actor: 'user', reason: 'archive test' });
    await assets.deleteAbilityAsset('user-a', deleted.asset.id, { actor: 'user', reason: 'delete test' });
    await assets.purgeAbilityAsset('user-a', purged.asset.id, { actor: 'user', reason: 'purge test' });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-inactive-assets', purpose: 'review', authorization: 'user_confirmed',
    });

    expect(preview.assetIds).not.toEqual(expect.arrayContaining([
      archived.asset.id, deleted.asset.id, purged.asset.id,
    ]));
    expect(preview.omittedRefs).toEqual(expect.arrayContaining([
      { assetId: archived.asset.id, reason: 'asset_archived' },
      { assetId: deleted.asset.id, reason: 'asset_deleted' },
      { assetId: purged.asset.id, reason: 'asset_purged' },
    ]));
  });


  it('semantic-ranks only assets already allowed by workspace and exact scope', async () => {
    const oauth = await createAssetWith({ judgment: 'Review OAuth callback and token exchange security.', summary: 'OAuth review workflow', scope: 'review', sourceId: 'exec-oauth', spaceId: 'workspace-a' });
    const database = await createAssetWith({ judgment: 'Plan database migrations with rollback windows.', summary: 'Database migration rule', scope: 'review', sourceId: 'exec-db', spaceId: 'workspace-a' });
    const scopeMismatch = await createAssetWith({ judgment: 'OAuth client secret rotation checklist.', summary: 'OAuth secret rotation', scope: 'security', sourceId: 'exec-oauth-scope', spaceId: 'workspace-a' });
    const { refs, projection } = await modules();
    for (const asset of [oauth.asset, database.asset, scopeMismatch.asset]) {
      await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: asset.scope });
    }

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-semantic', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Audit OAuth login callback handling', authorization: 'user_confirmed',
    }, {
      ...fakeSemanticOptions,
      embedTexts: async (texts: string[]) => texts.map((text) => {
        const lower = text.toLowerCase();
        if (lower.includes('oauth') && lower.includes('secret')) return [0, 1];
        if (lower.includes('oauth')) return [1, 0];
        if (lower.includes('database')) return [0.9, 0.1];
        return [0, 1];
      }),
    });

    expect(preview.assetIds).toEqual([oauth.asset.id, database.asset.id]);
    expect(preview.assetMatches).toEqual([
      expect.objectContaining({ assetId: oauth.asset.id, matchMethod: 'semantic', matchScore: expect.any(Number) }),
      expect.objectContaining({ assetId: database.asset.id, matchMethod: 'semantic', matchScore: expect.any(Number) }),
    ]);
    expect(preview.assetIds).not.toContain(scopeMismatch.asset.id);
  });

  it('automatic full-text injection stays OFF by default (2026-09-22 反转)', async () => {
    const { createAutomaticContextProjection } = await import('../../../../src/main/features/recall/context-projection');
    const users = await import('../../../../src/main/features/users');
    users.activateUser('user-baseline-off');
    await createAutomaticAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-baseline-off',
    });
    const projection = await createAutomaticContextProjection('user-baseline-off', {
      taskRunId: 'turn-baseline-off',
      taskText: 'Audit OAuth login callback handling',
    });
    expect(projection).toBeUndefined();
  });

  it('creates one confirmed automatic projection from only high-relevance active assets', async () => {
    // 2026-09-22 起正文自动注入默认关闭；这两条锁定选择机制本身的测试显式
    // 打开旧行为（COGSEED_RECALL_BASELINE_TOP>0），机制代码保留作回滚通道。
    vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '8');
    const oauth = await createAutomaticAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-oauth',
      spaceId: 'workspace-a',
    });
    const database = await createAutomaticAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-database',
      spaceId: 'workspace-a',
      applicableWhen: ['Database migration planning'],
    });
    const { projection } = await modules();

    const first = await projection.createAutomaticContextProjection('user-a', {
      taskRunId: 'turn-oauth',
      taskText: 'Audit OAuth login callback handling',
      workspaceId: 'workspace-a',
    }, fakeSemanticOptions);
    const retry = await projection.createAutomaticContextProjection('user-a', {
      taskRunId: 'turn-oauth',
      taskText: 'Audit OAuth login callback handling',
      workspaceId: 'workspace-a',
    }, fakeSemanticOptions);

    expect(first).toMatchObject({
      status: 'confirmed',
      authorization: 'not_required',
      purpose: 'conversation_reply',
      taskRunId: 'turn-oauth',
      workspaceId: 'workspace-a',
      assetIds: [oauth.asset.id],
    });
    expect(first?.assetIds).not.toContain(database.asset.id);
    expect(first?.assetMatches).toEqual([
      expect.objectContaining({ assetId: oauth.asset.id, matchMethod: 'semantic', matchScore: 1 }),
    ]);
    expect(retry?.id).toBe(first?.id);
  });

  it('excludes paused sources and explicitly disabled workspace references from automatic projections', async () => {
    const pausedSource = await createAutomaticAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'Paused source OAuth rule',
      sourceId: 'conversation-paused',
    });
    const disabledWorkspace = await createAutomaticAssetWith({
      judgment: 'Audit OAuth redirect URI validation.',
      summary: 'Disabled workspace OAuth rule',
      sourceId: 'conversation-disabled-workspace',
    });
    const { refs, projection } = await modules();
    const sourceControl = await import('../../../../src/main/features/recall/source-control');
    await sourceControl.pauseCognitionSource('user-a', pausedSource.asset.evidenceRefs[0]);
    const workspaceRef = await refs.addWorkspaceAssetReference('user-a', {
      assetId: disabledWorkspace.asset.id,
      workspaceId: 'workspace-a',
      scope: 'global',
    });
    await refs.updateWorkspaceAssetReference('user-a', workspaceRef.id, { enabled: false });

    await expect(projection.createAutomaticContextProjection('user-a', {
      taskRunId: 'turn-filtered',
      taskText: 'Audit OAuth login callback handling',
      workspaceId: 'workspace-a',
    }, fakeSemanticOptions)).resolves.toBeUndefined();
  });

  it('space conversations auto-inject from the GLOBAL pool (资产池全局共享，含其它空间资产)', async () => {
    vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '8');
    const own = await createAutomaticAssetWith({
      judgment: 'Review OAuth callback and token exchange security in workspace-a.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-oauth-own',
      spaceId: 'workspace-a',
    });
    const foreign = await createAutomaticAssetWith({
      judgment: 'Review OAuth callback and token exchange security in workspace-b.',
      summary: 'OAuth review workflow B',
      sourceId: 'conversation-oauth-foreign',
      spaceId: 'workspace-b',
    });
    const { projection } = await modules();

    const auto = await projection.createAutomaticContextProjection('user-a', {
      taskRunId: 'turn-oauth-space',
      taskText: 'Audit OAuth login callback handling',
      workspaceId: 'workspace-a',
    }, fakeSemanticOptions);

    // 全局池共享：本空间与他空间资产都可自动注入；tab 显示才按空间过滤
    expect(auto?.assetIds).toContain(own.asset.id);
    expect(auto?.assetIds).toContain(foreign.asset.id);
  });

  it('does not create an automatic projection when semantic matching fails or no asset reaches the threshold', async () => {
    await createAutomaticAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-database',
      applicableWhen: ['Database migration planning'],
    });
    const { projection } = await modules();

    await expect(projection.createAutomaticContextProjection('user-a', {
      taskRunId: 'turn-unrelated',
      taskText: 'Audit OAuth login callback handling',
    }, fakeSemanticOptions)).resolves.toBeUndefined();
    await expect(projection.createAutomaticContextProjection('user-a', {
      taskRunId: 'turn-embedding-failed',
      taskText: 'Audit OAuth login callback handling',
    }, {
      embedTexts: async () => { throw new Error('embedding unavailable'); },
    })).resolves.toBeUndefined();
  });

  it('deduplicates manual edits and rejects invalid revision combinations', async () => {
    const first = await createAssetWith({ judgment: 'First review rule.', summary: 'First', scope: 'review', sourceId: 'exec-first', spaceId: 'workspace-a' });
    const second = await createAssetWith({ judgment: 'Second review rule.', summary: 'Second', scope: 'review', sourceId: 'exec-second', spaceId: 'workspace-a' });
    const { refs, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: first.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await refs.addWorkspaceAssetReference('user-a', { assetId: second.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-dedupe', workspaceId: 'workspace-a', purpose: 'review' });

    const revised = await projection.reviseContextProjection('user-a', preview.id, {
      addAssetIds: [second.asset.id, second.asset.id],
      removeAssetIds: [first.asset.id, first.asset.id],
    });
    expect(revised.assetIds).toEqual([second.asset.id]);
    expect(revised.modelSelectedAssetIds).toBeUndefined();
    expect(revised.modelSelectionEvents).toBeUndefined();

    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: ['../bad'] }))
      .rejects.toThrow(/invalid projection asset/i);
    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: [second.asset.id], removeAssetIds: [second.asset.id] }))
      .rejects.toThrow(/both add and remove/i);
  });

  it('rejects unknown inactive and workspace-ineligible manual additions', async () => {
    const first = await createAssetWith({ judgment: 'First review rule.', summary: 'First', scope: 'review', sourceId: 'exec-first', spaceId: 'workspace-a' });
    const inactive = await createAssetWith({ judgment: 'Paused review rule.', summary: 'Paused', scope: 'review', sourceId: 'exec-paused', spaceId: 'workspace-a' });
    const scopeMismatch = await createAssetWith({ judgment: 'Security-only rule.', summary: 'Security', scope: 'security', sourceId: 'exec-security', spaceId: 'workspace-a' });
    const { refs, assets, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: first.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await refs.addWorkspaceAssetReference('user-a', { assetId: inactive.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await refs.addWorkspaceAssetReference('user-a', { assetId: scopeMismatch.asset.id, workspaceId: 'workspace-a', scope: 'security' });
    await assets.pauseAbilityAsset('user-a', inactive.asset.id, { actor: 'user', reason: 'not ready' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-invalid-add', workspaceId: 'workspace-a', purpose: 'review' });

    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: ['asset-missing'] }))
      .rejects.toThrow(/not found/i);
    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: [inactive.asset.id] }))
      .rejects.toThrow(/not active/i);
    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: [scopeMismatch.asset.id] }))
      .rejects.toThrow(/not eligible/i);
  });

  it('allows removing every task asset without deleting formal assets', async () => {
    const first = await createAssetWith({ judgment: 'First review rule.', summary: 'First', scope: 'review', sourceId: 'exec-first', spaceId: 'workspace-a' });
    const { refs, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: first.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-empty', workspaceId: 'workspace-a', purpose: 'review' });

    const revised = await projection.reviseContextProjection('user-a', preview.id, { removeAssetIds: [first.asset.id] });

    expect(revised.assetIds).toEqual([]);
    expect(revised.assetVersions).toEqual({});
    expect(revised.sourceRefs).toEqual([]);
    await expect((await modules()).assets.readAbilityAsset('user-a', first.asset.id))
      .resolves.toMatchObject({ id: first.asset.id, status: 'active' });
  });

  it('rejects edits to confirmed deferred rejected and expired projections', async () => {
    const { asset } = await createAsset('workspace-a');
    const { projection } = await modules();
    const confirmedPreview = await projection.previewContextProjection('user-a', { taskRunId: 'task-lock', purpose: 'review' });
    await projection.confirmContextProjection('user-a', confirmedPreview.id);
    await expect(projection.reviseContextProjection('user-a', confirmedPreview.id, { removeAssetIds: [asset.id] }))
      .rejects.toThrow(/cannot be revised/i);

    const deferred = await projection.previewContextProjection('user-a', { taskRunId: 'task-deferred', purpose: 'review' });
    await projection.deferContextProjection('user-a', deferred.id, 'later');
    await expect(projection.reviseContextProjection('user-a', deferred.id, { removeAssetIds: [asset.id] }))
      .rejects.toThrow(/cannot be revised/i);

    const rejected = await projection.previewContextProjection('user-a', { taskRunId: 'task-rejected', purpose: 'review' });
    await projection.rejectContextProjection('user-a', rejected.id, 'no');
    await expect(projection.reviseContextProjection('user-a', rejected.id, { removeAssetIds: [asset.id] }))
      .rejects.toThrow(/cannot be revised/i);

    const expired = await projection.previewContextProjection('user-a', { taskRunId: 'task-expired', purpose: 'review', expiresAt: '2000-01-01T00:00:00.000Z' });
    await expect(projection.reviseContextProjection('user-a', expired.id, { removeAssetIds: [asset.id] }))
      .rejects.toThrow(/expired/i);
    await expect((await modules()).assets.readAbilityAsset('user-a', asset.id))
      .resolves.toMatchObject({ id: asset.id, status: 'active' });
  });

  it('confirms a non-expired projection once and rejects expired projections', async () => {
    const { asset } = await createAsset('workspace-a');
    const { refs, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed', expiresAt: '2099-01-01T00:00:00.000Z' });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    expect(confirmed.status).toBe('confirmed');
    await expect(projection.confirmContextProjection('user-a', preview.id)).rejects.toThrow(/already confirmed/i);

    const expired = await projection.previewContextProjection('user-a', { taskRunId: 'task-b', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed', expiresAt: '2000-01-01T00:00:00.000Z' });
    await expect(projection.confirmContextProjection('user-a', expired.id)).rejects.toThrow(/expired/i);
  });

  it('preserves legacy source kinds when reading an existing projection', async () => {
    const { projection } = await modules();
    const store = await import('../../../../src/main/features/recall/store');
    await store.writeRecallJsonRecord('user-a', 'projections', 'proj-legacy', {
      schemaVersion: 1,
      ownerId: 'user-a',
      id: 'proj-legacy',
      taskRunId: 'task-legacy',
      purpose: 'review',
      authorization: 'user_confirmed',
      assetIds: [],
      sourceRefs: [
        { kind: 'message', id: 'msg-legacy' },
        { kind: 'context', id: 'ctx-legacy' },
        { kind: 'memory', id: 'mem-legacy' },
      ],
      omittedRefs: [],
      status: 'preview',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const read = await projection.readContextProjection('user-a', 'proj-legacy');
    expect(read.sourceRefs).toEqual([
      expect.objectContaining({ kind: 'message', subtype: 'message', id: 'msg-legacy', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'context', subtype: 'context_file', id: 'ctx-legacy', taxonomyVersion: 1 }),
      expect.objectContaining({ kind: 'memory', subtype: 'teaching', id: 'mem-legacy', taxonomyVersion: 1, degraded: true, reason: 'legacy_memory_untraceable' }),
    ]);
  });

  it('lists projections newest first and derives expired preview state without rewriting records', async () => {
    const { projection } = await modules();
    await projection.previewContextProjection('user-a', {
      taskRunId: 'task-old', purpose: 'review', expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const current = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-current', workspaceId: 'workspace-a', purpose: 'review',
    });

    await expect(projection.listContextProjections('user-a')).resolves.toEqual([
      expect.objectContaining({ id: current.id, status: 'preview' }),
    ]);
    await expect(projection.listContextProjections('user-a', { includeExpired: true })).resolves.toEqual([
      expect.objectContaining({ id: current.id, status: 'preview' }),
      expect.objectContaining({ taskRunId: 'task-old', status: 'expired' }),
    ]);
    await expect(projection.listContextProjections('user-a', { workspaceId: 'workspace-a' })).resolves.toHaveLength(1);
  });

  it('filters projections by taskRunId and conversationId', async () => {
    const { projection } = await modules();
    const recallStore = await import('../../../../src/main/features/recall/store');
    const first = await recallStore.writeRecallJsonRecord('user-a', 'projections', 'proj-filter-a', {
      schemaVersion: 2, ownerId: 'user-a', id: 'proj-filter-a', taskRunId: 'task-filter-a', conversationId: 'cid-filter-a',
      purpose: 'trace', authorization: 'user_confirmed', assetIds: [], sourceRefs: [], omittedRefs: [], status: 'preview',
      createdAt: '2026-09-03T00:00:00.000Z',
    });
    const second = await recallStore.writeRecallJsonRecord('user-a', 'projections', 'proj-filter-b', {
      schemaVersion: 2, ownerId: 'user-a', id: 'proj-filter-b', taskRunId: 'task-filter-b', conversationId: 'cid-filter-b',
      purpose: 'trace', authorization: 'user_confirmed', assetIds: [], sourceRefs: [], omittedRefs: [], status: 'preview',
      createdAt: '2026-09-03T00:00:01.000Z',
    });

    await expect(projection.listContextProjections('user-a', { taskRunId: 'task-filter-a' })).resolves.toEqual([
      expect.objectContaining({ id: first.id, taskRunId: 'task-filter-a' }),
    ]);
    await expect(projection.listContextProjections('user-a', { taskRunId: 'task-filter-b' })).resolves.toEqual([
      expect.objectContaining({ id: second.id, taskRunId: 'task-filter-b' }),
    ]);
    await expect(projection.listContextProjections('user-a', { conversationId: 'cid-filter-a' })).resolves.toEqual([
      expect.objectContaining({ id: first.id }),
    ]);
  });
});

describe('Recall projection auto-confirm and semantic Top-N', () => {
  async function promoteAsset(judgment: string, sourceId: string, scope: string) {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment,
      summary: judgment.slice(0, 60),
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: scope,
      sourceRefs: [{ kind: 'execution', id: sourceId }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
  }

  it('writes a confirmed projection when confirm is requested', async () => {
    const { projection } = await modules();
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-auto-confirm', purpose: 'review', confirm: true,
    });

    expect(preview.status).toBe('confirmed');
    expect(preview.confirmedAt).toEqual(expect.any(String));
    await expect(projection.readContextProjection('user-a', preview.id))
      .resolves.toMatchObject({ status: 'confirmed' });
  });

  it('drops low-relevance assets below the semantic threshold and caps to Top-N', async () => {
    const { projection } = await modules();
    const first = (await promoteAsset('OAuth callback security review.', 'exec-top-1', 'review')).asset;
    const second = (await promoteAsset('Database migration planning.', 'exec-top-2', 'review')).asset;
    const third = (await promoteAsset('Unrelated travel planning.', 'exec-top-3', 'review')).asset;

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-topn',
      purpose: 'review',
      taskText: 'Audit OAuth login callback handling',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => {
        const lower = text.toLowerCase();
        if (lower.includes('oauth')) return [1, 0];
        if (lower.includes('database')) return [0.1, 1];
        return [0.05, 1];
      }),
      minScore: 0.3,
      limit: 2,
    });

    expect(preview.assetIds).toEqual([first.id]);
    expect(preview.assetMatches).toEqual([
      expect.objectContaining({ assetId: first.id, matchMethod: 'semantic', matchScore: 1 }),
    ]);
    expect(preview.assetIds).not.toContain(second.id);
    expect(preview.assetIds).not.toContain(third.id);
    expect(preview.omittedRefs.some((ref) => ref.assetId === third.id)).toBe(true);
  });

  it('does not force-fill Top-N from a weak pool (relative-significance gate)', async () => {
    const { projection } = await modules();
    const { asset: strong } = await createAssetWith({ judgment: 'OAuth callback state check.', summary: 'OAuth', sourceId: 'exec-rel-1' });
    const { asset: weak } = await createAssetWith({ judgment: 'Database index tuning notes.', summary: 'Database', sourceId: 'exec-rel-2' });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-rel',
      purpose: 'review',
      taskText: 'OAuth callback state check',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => {
        const lower = text.toLowerCase();
        if (lower.includes('oauth')) return [1, 0];
        return [0.3, 1]; // above the 0.25 floor, far below the best 1.0
      }),
      limit: 2,
    });

    // The weak asset clears the absolute floor but fails the relative gate
    // (0.3 < 1.0 * 0.5) — a weak pool yields one asset, not two.
    expect(preview.assetIds).toEqual([strong.id]);
    expect(preview.assetIds).not.toContain(weak.id);
    expect(preview.omittedRefs.some((ref) => ref.assetId === weak.id && ref.reason === 'low_relevance')).toBe(true);
  });

  it('keeps a coherent batch when the pool is uniformly strong (relative gate stays quiet)', async () => {
    const { projection } = await modules();
    const { asset: a } = await createAssetWith({ judgment: 'OAuth callback state check.', summary: 'OAuth', sourceId: 'exec-rel-a' });
    const { asset: b } = await createAssetWith({ judgment: 'OAuth token refresh flow.', summary: 'OAuth', sourceId: 'exec-rel-b' });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-rel-ok',
      purpose: 'review',
      taskText: 'OAuth callback state check',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => (
        text.toLowerCase().includes('oauth') ? [1, 0] : [0, 1]
      )),
      limit: 2,
    });

    expect(preview.assetIds).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

describe('Recall retrieval quality regression', () => {
  async function promoteAsset(judgment: string, sourceId: string, scope: string) {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment,
      summary: judgment.slice(0, 60),
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: scope,
      sourceRefs: [{ kind: 'execution', id: sourceId }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
  }

  it('recalls assets whose scope term appears inside a sentence-shaped purpose', async () => {
    const { projection } = await modules();
    const asset = (await promoteAsset('OAuth callback security review.', 'exec-sentence', 'review')).asset;

    // Purpose is a full sentence, not the bare scope term: the old exact-match
    // gate excluded every non-* asset and silently emptied the pool.
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-sentence',
      purpose: 'Use frozen OAuth review knowledge',
      taskText: 'Audit OAuth login callback handling',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => (
        text.toLowerCase().includes('oauth') ? [1, 0] : [0, 1]
      )),
    });

    expect(preview.assetIds).toEqual([asset.id]);
  });

  it('matches a sentence-shaped asset scope against a sentence-shaped purpose via shared tokens', async () => {
    const { projection } = await modules();
    // Real-world line: teaching/capture wrote a free-form scope sentence, the
    // Commander passes a sentence purpose. Neither contains the other verbatim.
    const asset = (await promoteAsset('代码审查必须包含证据与风险。', 'exec-sentence-cn', '代码审查（尤其不可修改代码的架构审查）')).asset;

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-sentence-cn',
      purpose: '审查 Group Chat 消息路由，分析模块职责',
      taskText: '审查 Group Chat 消息路由模块',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => (
        text.includes('审查') ? [1, 0] : [0, 1]
      )),
    });

    // 审查 token appears on both sides → the soft scope gate passes and the
    // asset survives into semantic ranking.
    expect(preview.assetIds).toEqual([asset.id]);
  });

  it('bridges an ASCII scope tag to a CJK purpose via language aliases', async () => {
    const { projection } = await modules();
    // KStar precipitation writes short ASCII tags (scopeForTask → 'review');
    // a Chinese purpose must still match through the alias table.
    const asset = (await promoteAsset('OAuth callback review knowledge.', 'exec-alias', 'review')).asset;

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-alias',
      purpose: '审查 Group Chat 消息路由',
      taskText: '审查消息路由模块',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => (
        // Fake embedder: the asset matches the query direction; the purpose
        // label (first vector) is the query so it shares the [1,0] direction.
        text.includes('OAuth') || text.includes('审查消息路由') ? [1, 0] : [0, 1]
      )),
    });

    expect(preview.omittedRefs).toEqual([]);
    expect(preview.assetIds).toEqual([asset.id]);
  });

  it('keeps ASCII scope matching whole-word (no substring bleed)', async () => {
    const { projection } = await modules();
    // ASCII tokens must stay exact: 'cat' must not match 'category'.
    const asset = (await promoteAsset('OAuth callback rule.', 'exec-ascii', 'cat')).asset;

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-ascii',
      purpose: 'category review',
      taskText: 'OAuth callback rule',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => (
        text.toLowerCase().includes('oauth') ? [1, 0] : [0, 1]
      )),
    });

    expect(preview.omittedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: asset.id, reason: 'scope_mismatch' }),
    ]));
    expect(preview.assetIds).not.toContain(asset.id);
  });

  it('marks the projection as degraded when semantic embedding fails', async () => {
    const { projection } = await modules();
    await promoteAsset('OAuth callback security review.', 'exec-degraded', 'review');

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-degraded',
      purpose: 'review',
      taskText: 'Audit OAuth login callback handling',
    }, {
      embedTexts: async () => { throw new Error('embedding unavailable'); },
    });

    expect(preview.selectionDegraded).toBe(true);
    expect(preview.assetIds).toEqual([]);
    expect(preview.assetMatches).toEqual([]);
  });
});

describe('Recall ontology-assisted hybrid retrieval', () => {
  async function createOntologyAsset(input: {
    groupId: string;
    field: string;
    judgment: string;
    sourceId: string;
  }) {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: input.judgment,
      summary: input.judgment,
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: input.sourceId }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, {
      actor: 'user',
      ontologyRefs: [{ groupId: input.groupId, field: input.field }],
    });
    await elevateToTransferVerified(promoted.asset.id);
    return promoted.asset;
  }

  it('selects an ontology-only candidate and deduplicates one asset into one match', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const { projection } = await modules();
    const group = await groups.createGroup('user-a', 'OAuth 回调安全');
    await groups.appendFieldValue('user-a', group.group!.group_id, '回调验证', 'OAuth → callback', '手动');
    const asset = await createOntologyAsset({
      groupId: group.group!.group_id,
      field: '回调验证',
      judgment: '验证回调目标后再交换令牌。',
      sourceId: 'exec-ontology-only',
    });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-ontology-only',
      purpose: 'review',
      taskText: '验证 OAuth 回调安全',
    }, {
      embedTexts: async () => { throw new Error('embedding unavailable'); },
    });

    expect(preview.assetIds).toEqual([asset.id]);
    expect(preview.assetMatches).toEqual([
      expect.objectContaining({ assetId: asset.id, matchMethod: 'ontology' }),
    ]);
    expect(preview.assetMatches).toHaveLength(1);
    expect(preview.selectionDegraded).toBe(true);
  });

  it('prioritizes dual-route evidence as semantic_ontology over semantic-only matches', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const { projection } = await modules();
    const group = await groups.createGroup('user-a', 'OAuth 回调安全');
    await groups.appendFieldValue('user-a', group.group!.group_id, '回调验证', 'OAuth → callback', '手动');
    const dual = await createOntologyAsset({
      groupId: group.group!.group_id,
      field: '回调验证',
      judgment: '验证 OAuth 回调目标。',
      sourceId: 'exec-dual',
    });
    const semanticOnly = await (await modules()).candidates.saveRecallCandidate('user-a', {
      judgment: '验证 OAuth token exchange。',
      summary: 'OAuth token exchange',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-semantic-only' }],
    });
    const promoted = await (await modules()).candidates.promoteRecallCandidate('user-a', semanticOnly.id, { actor: 'user' });
    await elevateToTransferVerified(promoted.asset.id);

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-dual',
      purpose: 'review',
      taskText: 'Verify OAuth callback handling',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => (
        text.toLocaleLowerCase().includes('oauth') ? [1, 0] : [0, 1]
      )),
    });

    expect(preview.assetIds).toEqual([dual.id, promoted.asset.id]);
    expect(preview.assetMatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: dual.id, matchMethod: 'semantic_ontology' }),
      expect.objectContaining({ assetId: promoted.asset.id, matchMethod: 'semantic' }),
    ]));
    expect(preview.assetMatches).toHaveLength(2);
  });
});

describe('Recall retrieval refinement', () => {
  async function promoteAsset(judgment: string, sourceId: string, scope: string, type: 'rule' | 'template' | 'skill_method' | 'personal' = 'rule') {
    const { candidates } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment,
      summary: judgment.slice(0, 60),
      suggestedType: type,
      ...(type === 'rule' ? {
        applicableWhen: ['OAuth review and callback validation'],
        forbiddenWhen: ['Unrelated casual conversation'],
      } : {}),
      suggestedScope: scope,
      sourceRefs: [{ kind: 'execution', id: sourceId }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
  await elevateToTransferVerified(promoted.asset.id);
  return promoted;
  }

  it('does not let shared type/scope labels inflate semantic similarity', async () => {
    const { projection } = await modules();
    const ruleAsset = (await promoteAsset('OAuth callback state validation.', 'exec-match-1', 'review', 'rule')).asset;
    const methodAsset = (await promoteAsset('OAuth token refresh method: read the stored refresh token, request a new access token, then verify the new expiry before use.', 'exec-match-2', 'review', 'skill_method')).asset;
    let embedTexts: string[] = [];
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-match',
      purpose: 'review',
      taskText: 'OAuth callback state validation',
    }, {
      embedTexts: async (texts: string[]) => {
        embedTexts = texts;
        return texts.map((text) => (text.toLowerCase().includes('oauth') ? [1, 0] : [0, 1]));
      },
    });

    // Match text must not contain the type/scope dimension labels.
    for (const text of embedTexts.slice(1)) {
      expect(text.toLowerCase()).not.toMatch(/\brule\b/);
      expect(text.toLowerCase()).not.toMatch(/\breview\b/);
    }
    expect(preview.assetIds).toEqual(expect.arrayContaining([ruleAsset.id, methodAsset.id]));
    expect(preview.assetIds).toHaveLength(2);
  });

  it('renders the referenced ontology group title (T-Box) in the semantic match text', async () => {
    const { candidates, projection } = await modules();
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const group = await groups.createGroup('user-a', '代码审查规范');
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'OAuth callback review must check state.',
      summary: 'OAuth callback review',
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-tbox' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, {
      actor: 'user',
      ontologyRefs: [{ groupId: group.group!.group_id }],
    });
    const asset = promoted.asset;

    let embedTexts: string[] = [];
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-tbox',
      purpose: 'review',
      taskText: 'OAuth callback review',
    }, {
      embedTexts: async (texts: string[]) => {
        embedTexts = texts;
        return texts.map((text) => (text.includes('OAuth') ? [1, 0] : [0, 1]));
      },
    });

    // The concept name (group title) replaced the opaque group id in the
    // match text, so a query using the concept's natural-language name can
    // rank the asset.
    // The asset's match text (not the query) carries the concept name.
    const assetText = embedTexts.find((text) => text.includes('代码审查规范'));
    expect(assetText).toBeTruthy();
    expect(assetText).toContain('OAuth callback review');
    expect(assetText).not.toContain(group.group!.group_id);
    expect(preview.assetIds).toContain(asset.id);
  });

  it('guarantees one asset per type before filling Top-N by score', async () => {
    const { projection } = await modules();
    const ruleA = (await promoteAsset('OAuth callback rule one.', 'exec-div-1', 'review', 'rule')).asset;
    const ruleB = (await promoteAsset('OAuth callback rule two.', 'exec-div-2', 'review', 'rule')).asset;
    const method = (await promoteAsset('OAuth callback method: validate the state first, then exchange the code, then verify the returned scope.', 'exec-div-3', 'review', 'skill_method')).asset;

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-div',
      purpose: 'review',
      taskText: 'OAuth callback rule one',
    }, {
      embedTexts: async (texts: string[]) => texts.map((text) => {
        const lower = text.toLowerCase();
        if (lower.includes('rule one')) return [1, 0];
        if (lower.includes('rule two')) return [0.9, 1];
        if (lower.includes('method')) return [0.8, 1];
        return [0, 1];
      }),
      limit: 2,
    });

    // Diversity: the top-2 rule assets do not crowd out the single method asset.
    expect(preview.assetIds).toEqual([ruleA.id, method.id]);
  });
});

describe('committed projection knowledge boundary', () => {
  it('freezes asset ids and exact versions when a preview is confirmed', async () => {
    const { asset } = await createAsset('workspace-a');
    const { refs, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', {
      assetId: asset.id,
      workspaceId: 'workspace-a',
      scope: 'review',
    });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-freeze',
      workspaceId: 'workspace-a',
      purpose: 'review',
    });
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.assetIds).toEqual(preview.assetIds);
    expect(confirmed.assetVersions).toEqual(preview.assetVersions);
  });

  it('rejects confirmation when a selected asset version changed', async () => {
    const { asset } = await createAsset('workspace-a');
    const { refs, assets, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', {
      assetId: asset.id,
      workspaceId: 'workspace-a',
      scope: 'review',
    });
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-version-drift',
      workspaceId: 'workspace-a',
      purpose: 'review',
    });
    await assets.updateAbilityAsset('user-a', asset.id, {
      statement: 'Changed after preview.',
      actor: 'user',
      reason: 'test version drift',
    });

    await expect(projection.confirmContextProjection('user-a', preview.id))
      .rejects.toMatchObject({ code: 'projection_asset_version_changed' });
  });

  it('includes a space-attributed asset in its own workspace without an explicit workspace reference', async () => {
    const { candidates, projection, refs } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Space-owned OAuth lesson injects in its own space.',
      summary: 'Space-owned lesson',
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'review',
      spaceId: 'workspace-a',
      sourceRefs: [{ kind: 'execution', id: 'exec-space-owned' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
    await elevateToTransferVerified(promoted.asset.id);
    // 去掉 promote 自动挂载的 ref，验证"空间归属资产免登记卡"的兜底
    await refs.removeWorkspaceAssetReference('user-a', `war-${promoted.asset.id}-workspace-a`);

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-space-owned', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
    });
    expect(preview.assetIds).toContain(promoted.asset.id);
    expect(preview.omittedRefs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: promoted.asset.id, reason: 'workspace_not_referenced' }),
    ]));
  });

  it('includes assets from OTHER workspaces in a space conversation (资产池全局共享)', async () => {
    const { candidates, projection, refs } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Workspace-B lesson is part of the shared pool for workspace-a.',
      summary: 'Shared pool lesson',
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'review',
      spaceId: 'workspace-b',
      sourceRefs: [{ kind: 'execution', id: 'exec-foreign' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
    await elevateToTransferVerified(promoted.asset.id);
    await refs.removeWorkspaceAssetReference('user-a', `war-${promoted.asset.id}-workspace-b`);

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-foreign', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
    });
    // 设计：引用=全局池共享（含其它空间产生的资产）；tab 显示才按空间过滤
    expect(preview.assetIds).toContain(promoted.asset.id);
    expect(preview.omittedRefs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: promoted.asset.id, reason: 'workspace_not_referenced' }),
    ]));
  });

  it('real-world shape: scope=space / scope=general assets pass the purpose gate in previews', async () => {
    const { candidates, projection, refs } = await modules();
    // 真实资产形态：suggestedScope='space'（发布公告五段式、信息架构四层法）
    const spaceAsset = await candidates.saveRecallCandidate('user-a', {
      judgment: '发布类公告应包含：背景、变更点、影响范围、生效时间、联系方式五段。',
      summary: '发布公告五段式',
      suggestedType: 'rule',
      suggestedScope: 'space',
      spaceId: 'workspace-a',
      sourceRefs: [{ kind: 'conversation', id: 'conv-space' }],
    });
    const spacePromoted = await candidates.promoteRecallCandidate('user-a', spaceAsset.id, { actor: 'user' });
    await elevateToTransferVerified(spacePromoted.asset.id);
    await refs.removeWorkspaceAssetReference('user-a', `war-${spacePromoted.asset.id}-workspace-a`);
    // 真实资产形态：scope='general'（KSTAR gap 资产，无空间归属）
    const generalAsset = await candidates.saveRecallCandidate('user-a', {
      judgment: '编号/短码缺少项目上下文时应先向用户确认所指目标。',
      summary: '待修正经验：短码缺上下文',
      suggestedType: 'rule',
      suggestedScope: 'general',
      sourceRefs: [{ kind: 'execution', id: 'exec-general' }],
    });
    const generalPromoted = await candidates.promoteRecallCandidate('user-a', generalAsset.id, { actor: 'user' });
    await elevateToTransferVerified(generalPromoted.asset.id);

    // 空间会话（purpose='review'）：space 资产 + general 资产都进候选（全局池共享）
    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-real-shape', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
    });
    expect(preview.assetIds).toContain(spacePromoted.asset.id);
    expect(preview.assetIds).toContain(generalPromoted.asset.id);
    expect(preview.omittedRefs).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: spacePromoted.asset.id, reason: 'scope_mismatch' }),
      expect.objectContaining({ assetId: generalPromoted.asset.id, reason: 'scope_mismatch' }),
    ]));

    // 非空间会话（workspaceId 为空）：general 资产同样可进（全池候选）
    const globalPreview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-real-shape-global', purpose: 'review', authorization: 'user_confirmed',
    });
    expect(globalPreview.assetIds).toContain(generalPromoted.asset.id);
  });

  it('a disabled workspace reference still blocks a space-attributed asset', async () => {
    const { candidates, projection, refs } = await modules();
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Disabled lesson stays out.',
      summary: 'Disabled lesson',
      suggestedType: 'rule',
      applicableWhen: ['正式评审与架构决策时'],
      forbiddenWhen: ['内部快速对齐'],
      suggestedScope: 'review',
      spaceId: 'workspace-a',
      sourceRefs: [{ kind: 'execution', id: 'exec-disabled' }],
    });
    const promoted = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });
    await elevateToTransferVerified(promoted.asset.id);
    await refs.updateWorkspaceAssetReference('user-a', `war-${promoted.asset.id}-workspace-a`, { enabled: false });

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-disabled', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
    });
    expect(preview.assetIds).not.toContain(promoted.asset.id);
    expect(preview.omittedRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: promoted.asset.id, reason: 'workspace_disabled' }),
    ]));
  });
});

describe('模型自选投影的撤销（2026-09-18）', () => {
  it('撤销幂等；不存在/非模型自选各给明确拒绝', async () => {
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const created = await projection.previewContextProjection('user-a', {
      taskRunId: 'turn-revoke01',
      purpose: 'model_selected',
      authorization: 'model_selected',
      confirm: true,
    });
    expect(created.status).toBe('confirmed');

    const first = await projection.revokeModelSelectedProjection('user-a', created.id);
    expect(first.status).toBe('revoked');
    // 幂等：重复撤销返回同一终态，不报错、不产生第二份状态。
    const second = await projection.revokeModelSelectedProjection('user-a', created.id);
    expect(second.status).toBe('revoked');

    await expect(projection.revokeModelSelectedProjection('user-a', 'proj-doesnotexist01'))
      .rejects.toThrow('not found');

    const userOwned = await projection.previewContextProjection('user-a', {
      taskRunId: 'turn-revoke02',
      purpose: 'conversation_reply',
      authorization: 'user_confirmed',
      confirm: true,
    });
    await expect(projection.revokeModelSelectedProjection('user-a', userOwned.id))
      .rejects.toThrow('not model-selected');
  });

describe('撤销在时间线里可见（2026-09-18）', () => {
  it('已撤销的模型自选投影产生"已撤销"事件，未撤销的仍是"已带入"', async () => {
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const timeline = await import('../../../../src/main/features/recall/timeline-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');

    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: '撤销可见性用例：这条资产要被挂上一次再撤销。',
      summary: 'revoke-visibility',
      suggestedType: 'rule',
      suggestedScope: 'review,project',
      sourceRefs: [{ kind: 'execution', id: 'exec-revoke-vis' }],
    });
    const asset = (await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true })).asset;

    const created = await projection.previewContextProjection('user-a', {
      taskRunId: 'turn-revoke-vis', purpose: 'model_selected', authorization: 'model_selected', confirm: true,
    });
    await projection.appendAssetsToModelSelectedProjection('user-a', created.id, [asset.id]);

    const before = await timeline.listAbilityAssetTimeline('user-a', asset.id);
    expect(before.some((item) => item.kind === 'projection_confirmed' && item.refs.projectionId === created.id)).toBe(true);

    await projection.revokeModelSelectedProjection('user-a', created.id);
    const after = await timeline.listAbilityAssetTimeline('user-a', asset.id);
    const revokedEvent = after.find((item) => item.kind === 'projection_revoked' && item.refs.projectionId === created.id);
    expect(revokedEvent).toBeTruthy();
    expect(String(revokedEvent?.title || '')).toContain('revoked');
  });
});

describe('注入体量对比（2026-09-18，可用高效）：模型自选的增量必须远小于整块上限', () => {
  it('带一条会话投影时的提示词块，比不带多出的是"这几条资产的正文"，且整块仍 ≤ 14000', async () => {
    const promptInjection = await import('../../../../src/main/features/recall/prompt-injection');
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');

    // 造一条有正文体积的资产
    const body = '性能类提问必须用真实日志做分层归因：先拆链路、再定位瓶颈、最后只给一个可优化项。'.repeat(8);
    const candidate = await candidates.saveRecallCandidate('user-a', {
      judgment: `${body}（体积对比用例）`,
      summary: 'volume',
      suggestedType: 'rule',
      suggestedScope: 'review,project',
      sourceRefs: [{ kind: 'execution', id: 'exec-volume' }],
    });
    await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user', forceCreateSimilar: true });

    const base = await promptInjection.buildRecallTurnPromptContext('user-a', {
      cid: 'cid-volume', taskRunId: 'turn-volume01', taskText: '做一次归因分析',
    });
    expect(base.promptBlock.length).toBeLessThanOrEqual(14000);

    // 挂一条模型自选投影（含同一条资产）→ 提示词里的增量应≈该资产正文长度，且整块仍在上限内
    const created = await projection.previewContextProjection('user-a', {
      taskRunId: 'turn-volume01', conversationId: 'cid-volume', purpose: 'model_selected',
      authorization: 'model_selected', confirm: true,
    });
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const [asset] = (await assets.listAbilityAssets('user-a')).filter((item) => item.status === 'active');
    await projection.appendAssetsToModelSelectedProjection('user-a', created.id, [asset.id]);

    // 注入侧的查找依据是**会话里的卡消息**（不只是投影记录）——真实链路里
    // attach 工具会投卡；这里把卡消息补上，否则拿到的块恒为空。
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const chatFile = path.join(paths.userChatsDir('user-a'), 'cid-volume.jsonl');
    fs.mkdirSync(path.dirname(chatFile), { recursive: true });
    await storage.appendJsonl(chatFile, {
      id: 'msg-volume-card', ts: new Date().toISOString(), from: 'commander', to: ['user'],
      text: 'Preload candidates', recall_projection_card: { projectionId: created.id },
    });

    const withAttachment = await promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-volume');
    const delta = withAttachment.length;
    // eslint-disable-next-line no-console
    console.log(`[volume] 基线块=${base.promptBlock.length} 字符；带自选投影的块=${delta} 字符；整块上限=14000`);
    expect(withAttachment).toContain(asset.title.slice(0, 10));
    expect(delta).toBeLessThanOrEqual(14000);
    expect(delta).toBeGreaterThan(0);
    // 增量 = 这一条资产的正文（不是把整块重算一遍）：块长应明显小于"上限 − 基线"的余量。
    expect(delta).toBeLessThan(base.promptBlock.length + 3000);
  });
});
});



describe('model-selected projection accounting', () => {
  it('records only newly attached model assets and keeps repeated calls idempotent', async () => {
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const first = await createAssetWith({ judgment: 'Model-selected accounting rule one', summary: 'model-one', sourceId: 'exec-model-one' });
    const second = await createAssetWith({ judgment: 'Model-selected accounting rule two', summary: 'model-two', sourceId: 'exec-model-two' });
    const created = await projection.previewContextProjection('user-a', {
      taskRunId: 'turn-model-base', purpose: 'model_selected', authorization: 'model_selected', confirm: true,
    });

    const attached = await projection.appendAssetsToModelSelectedProjection(
      'user-a', created.id, [first.asset.id, second.asset.id], { taskRunId: 'turn-model-a' },
    );
    expect(attached.modelSelectedAssetIds).toEqual([first.asset.id, second.asset.id]);
    expect(attached.modelSelectionEvents).toHaveLength(1);
    expect(attached.modelSelectionEvents?.[0]).toMatchObject({
      taskRunId: 'turn-model-a',
      assetIds: [first.asset.id, second.asset.id],
      addedAssetIds: [first.asset.id, second.asset.id],
    });

    const repeated = await projection.appendAssetsToModelSelectedProjection(
      'user-a', attached.id, [second.asset.id], { taskRunId: 'turn-model-b' },
    );
    expect(repeated.assetIds).toEqual([first.asset.id, second.asset.id]);
    expect(repeated.modelSelectedAssetIds).toEqual([first.asset.id, second.asset.id]);
    expect(repeated.modelSelectionEvents).toHaveLength(2);
    expect(repeated.modelSelectionEvents?.[1]).toMatchObject({
      taskRunId: 'turn-model-b',
      assetIds: [second.asset.id],
      addedAssetIds: [],
    });

    const { buildProjectionCard } = await import('../../../../src/main/features/recall/projection-card');
    const card = await buildProjectionCard('user-a', repeated.id);
    expect(card.modelSelectedAssetIds).toEqual([first.asset.id, second.asset.id]);
    expect(card.modelSelectedCount).toBe(2);
    expect(card.totalAssetCount).toBe(2);

    await projection.revokeModelSelectedProjection('user-a', repeated.id);
    const revokedCard = await buildProjectionCard('user-a', repeated.id);
    expect(revokedCard.status).toBe('revoked');
  });
});
