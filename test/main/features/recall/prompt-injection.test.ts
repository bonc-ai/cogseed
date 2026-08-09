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
  return candidates.promoteRecallCandidate('user-a', candidate.id);
}

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
});
