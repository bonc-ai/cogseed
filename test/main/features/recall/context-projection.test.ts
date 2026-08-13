import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
let tmp: string; let previous: string | undefined;
beforeEach(() => { vi.resetModules(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-projection-')); previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = tmp; });
afterEach(() => { if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous; fs.rmSync(tmp, { recursive: true, force: true }); });
async function modules() { const [candidates, assets, refs, projection] = await Promise.all([import('../../../../src/main/features/recall/candidate-service'), import('../../../../src/main/features/recall/asset-service'), import('../../../../src/main/features/recall/workspace-refs'), import('../../../../src/main/features/recall/context-projection')]); return { candidates, assets, refs, projection }; }
async function createAsset() { const { candidates } = await modules(); const candidate = await candidates.saveRecallCandidate('user-a', { judgment: 'Preserve source evidence in reviews.', suggestedType: 'rule', suggestedScope: 'review,project', sourceRefs: [{ kind: 'execution', id: 'exec-a' }, { kind: 'memory', id: 'mem-a' }] }); return candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' }); }

async function createAssetWith(input: { judgment: string; summary: string; scope?: string; sourceId: string }) {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    suggestedScope: input.scope || 'review',
    sourceRefs: [{ kind: 'execution', id: input.sourceId }],
  });
  return candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
}

async function createAutomaticAssetWith(input: {
  judgment: string;
  summary: string;
  sourceId: string;
  sourceKind?: 'conversation' | 'artifact_file';
}) {
  const { candidates } = await modules();
  const sourceKind = input.sourceKind || 'conversation';
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    suggestedScope: 'global',
    sourceRefs: [{
      kind: sourceKind,
      id: input.sourceId,
      subtype: sourceKind === 'conversation' ? 'session' : 'artifact',
      scope: 'personal',
    }],
  });
  return candidates.promoteRecallCandidate('user-a', candidate.id);
}

const fakeSemanticOptions = {
  embedTexts: async (texts: string[]) => texts.map((text) => {
    const lower = text.toLowerCase();
    if (lower.includes('oauth')) return [1, 0];
    if (lower.includes('database')) return [0, 1];
    return [0.2, 0.2];
  }),
};

describe('RecallView and ContextProjection', () => {
  it('previews workspace-scoped active assets and explains omitted assets', async () => {
    const { asset } = await createAsset();
    const { refs, assets, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const otherCandidate = await (await modules()).candidates.saveRecallCandidate('user-a', { judgment: 'Only use archived data with confirmation.', suggestedType: 'rule', suggestedScope: 'archive', sourceRefs: [{ kind: 'memory', id: 'mem-b' }] });
    const other = await (await modules()).candidates.promoteRecallCandidate('user-a', otherCandidate.id, { actor: 'user' });
    await assets.pauseAbilityAsset('user-a', other.asset.id, { actor: 'user', reason: 'not ready' });

    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed' });
    expect(preview.status).toBe('preview');
    expect(preview.assetIds).toEqual([asset.id]);
    expect(preview.sourceRefs.map((ref) => ref.id)).toEqual(['exec-a', 'mem-a']);
    expect(preview.omittedRefs).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: other.asset.id, reason: 'asset_paused' })]));
  });


  it('semantic-ranks only assets already allowed by workspace and exact scope', async () => {
    const oauth = await createAssetWith({ judgment: 'Review OAuth callback and token exchange security.', summary: 'OAuth review workflow', scope: 'review', sourceId: 'exec-oauth' });
    const database = await createAssetWith({ judgment: 'Plan database migrations with rollback windows.', summary: 'Database migration rule', scope: 'review', sourceId: 'exec-db' });
    const scopeMismatch = await createAssetWith({ judgment: 'OAuth client secret rotation checklist.', summary: 'OAuth secret rotation', scope: 'security', sourceId: 'exec-oauth-scope' });
    const { refs, projection } = await modules();
    for (const asset of [oauth.asset, database.asset, scopeMismatch.asset]) {
      await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: asset.scope });
    }

    const preview = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-semantic', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Audit OAuth login callback handling', authorization: 'user_confirmed',
    }, fakeSemanticOptions);

    expect(preview.assetIds).toEqual([oauth.asset.id, database.asset.id]);
    expect(preview.assetMatches).toEqual([
      expect.objectContaining({ assetId: oauth.asset.id, matchMethod: 'semantic', matchScore: expect.any(Number) }),
      expect.objectContaining({ assetId: database.asset.id, matchMethod: 'semantic', matchScore: expect.any(Number) }),
    ]);
    expect(preview.assetIds).not.toContain(scopeMismatch.asset.id);
  });

  it('creates one confirmed automatic projection from only high-relevance active assets', async () => {
    const oauth = await createAutomaticAssetWith({
      judgment: 'Review OAuth callback and token exchange security.',
      summary: 'OAuth review workflow',
      sourceId: 'conversation-oauth',
    });
    const database = await createAutomaticAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-database',
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

  it('does not create an automatic projection when semantic matching fails or no asset reaches the threshold', async () => {
    await createAutomaticAssetWith({
      judgment: 'Plan database migrations with rollback windows.',
      summary: 'Database migration rule',
      sourceId: 'conversation-database',
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
    const first = await createAssetWith({ judgment: 'First review rule.', summary: 'First', scope: 'review', sourceId: 'exec-first' });
    const second = await createAssetWith({ judgment: 'Second review rule.', summary: 'Second', scope: 'review', sourceId: 'exec-second' });
    const { refs, projection } = await modules();
    await refs.addWorkspaceAssetReference('user-a', { assetId: first.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    await refs.addWorkspaceAssetReference('user-a', { assetId: second.asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const preview = await projection.previewContextProjection('user-a', { taskRunId: 'task-dedupe', workspaceId: 'workspace-a', purpose: 'review' });

    const revised = await projection.reviseContextProjection('user-a', preview.id, {
      addAssetIds: [second.asset.id, second.asset.id],
      removeAssetIds: [first.asset.id, first.asset.id],
    });
    expect(revised.assetIds).toEqual([second.asset.id]);

    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: ['../bad'] }))
      .rejects.toThrow(/invalid projection asset/i);
    await expect(projection.reviseContextProjection('user-a', preview.id, { addAssetIds: [second.asset.id], removeAssetIds: [second.asset.id] }))
      .rejects.toThrow(/both add and remove/i);
  });

  it('rejects unknown inactive and workspace-ineligible manual additions', async () => {
    const first = await createAssetWith({ judgment: 'First review rule.', summary: 'First', scope: 'review', sourceId: 'exec-first' });
    const inactive = await createAssetWith({ judgment: 'Paused review rule.', summary: 'Paused', scope: 'review', sourceId: 'exec-paused' });
    const scopeMismatch = await createAssetWith({ judgment: 'Security-only rule.', summary: 'Security', scope: 'security', sourceId: 'exec-security' });
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
    const first = await createAssetWith({ judgment: 'First review rule.', summary: 'First', scope: 'review', sourceId: 'exec-first' });
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
    const { asset } = await createAsset();
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
    const { asset } = await createAsset();
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
});

describe('committed projection knowledge boundary', () => {
  it('freezes asset ids and exact versions when a preview is confirmed', async () => {
    const { asset } = await createAsset();
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
    const { asset } = await createAsset();
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
});
