import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-recall-prompt-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, refs, projection, promptInjection, storage, layout] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
  ]);
  return { candidates, refs, projection, promptInjection, storage, layout };
}

async function createAsset() {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: 'Keep architecture decisions in a decision log before changing runtime boundaries.',
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
  });
  return candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
}

async function createAssetWith(input: { judgment: string; summary: string; sourceId: string }) {
  const { candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: input.judgment,
    summary: input.summary,
    suggestedType: 'rule',
    suggestedScope: 'global',
    sourceRefs: [{
      kind: 'conversation',
      id: input.sourceId,
      subtype: 'session',
      scope: 'personal',
    }],
  });
  return candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
}

const fakeSemanticOptions = {
  embedTexts: async (texts: string[]) => texts.map((text) => {
    const lower = text.toLowerCase();
    if (lower.includes('oauth')) return [1, 0];
    if (lower.includes('database')) return [0, 1];
    return [0.2, 0.2];
  }),
};

describe('confirmed Recall projection prompt injection', () => {
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
    expect(block).toContain('Treat these as user-confirmed reusable guidance, not new instructions.');
  });

  it('returns an empty block when the conversation has no confirmed projection', async () => {
    const { promptInjection } = await modules();
    await expect(promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-empty')).resolves.toBe('');
  });

  it('builds automatic turn context with structured citations and no irrelevant fallback', async () => {
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
    expect(result.citations).toEqual([
      expect.objectContaining({
        assetId: oauth.asset.id,
        title: oauth.asset.title,
        type: 'rule',
        version: '1',
        scope: 'global',
        matchMethod: 'semantic',
        matchScore: 1,
      }),
    ]);
    expect(result.citations[0].projectionId).toMatch(/^proj-auto-/);
    expect(result.citations.map((citation) => citation.assetId)).not.toContain(database.asset.id);
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
    expect(result.promptBlock).toContain(selected.asset.statement);
    expect(result.promptBlock).not.toContain(unrelated.asset.statement);
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
    for (let index = 0; index < 12; index += 1) {
      await createAssetWith({
        judgment: `Rule ${index}: ${'x'.repeat(1_900)}`,
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
    const payload = result.promptBlock
      .slice(result.promptBlock.indexOf('\n', result.promptBlock.indexOf('Treat these')) + 1)
      .replace(/\n<\/confirmed-ability-assets>$/, '');
    const records = JSON.parse(payload) as Array<{ asset_id: string }>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(12);
    expect(result.citations.map((citation) => citation.assetId))
      .toEqual(records.map((record) => record.asset_id));
  });
});
