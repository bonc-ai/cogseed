import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mate-runtime-asset-context-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function seedConfirmedProjection(userId: string, cid: string, judgment: string, summary: string) {
  const [candidates, refs, projection, storage, layout] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
  ]);
  const candidate = await candidates.saveRecallCandidate(userId, {
    judgment,
    summary,
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
  });
  const asset = await candidates.promoteRecallCandidate(userId, candidate.id, { actor: 'user' });
  await refs.addWorkspaceAssetReference(userId, { assetId: asset.asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection(userId, {
    taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review',
  });
  const confirmed = await projection.confirmContextProjection(userId, preview.id);
  const messageFile = layout.conversationMessageFile(userId, cid);
  await fs.mkdir(path.dirname(messageFile), { recursive: true });
  await storage.appendJsonlAtomic(messageFile, {
    id: 'msg-a', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
    recall_projection_card: { projectionId: confirmed.id },
  });
  return confirmed;
}

describe('Mate runtime asset context assembly (Decision 2 = connect)', () => {
  it('builds a text runtime context item from confirmed projections, read-only', async () => {
    await seedConfirmedProjection(
      'user-a', 'cid-a',
      'Keep architecture decisions in a decision log before changing runtime boundaries.',
      'Use decision logs for architecture changes',
    );
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/mate_agent_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-a', 'cid-a');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'text', label: 'Confirmed reusable ability assets' });
    expect(items[0].content).toContain('<confirmed-ability-assets>');
    expect(items[0].content).toContain('Use decision logs for architecture changes');
  });

  it('returns an empty array when the conversation has no confirmed projection', async () => {
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/mate_agent_backend/runtime-asset-context');
    await expect(buildRuntimeAssetContext('user-a', 'cid-empty')).resolves.toEqual([]);
  });

  it('never leaks another user assets (user isolation)', async () => {
    await seedConfirmedProjection(
      'user-a', 'cid-a',
      'Private rule of user-a only.', 'Private summary of user-a',
    );
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/mate_agent_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-b', 'cid-a');
    expect(items).toEqual([]);
  });

  it('caps the assembled text to a bounded size', async () => {
    // judgment has a 4000-char ceiling in candidate-service; a large but legal
    // statement must still be capped by the assembler contract.
    await seedConfirmedProjection(
      'user-a', 'cid-a',
      'Rule '.repeat(750), 'Huge statement cap check',
    );
    const { buildRuntimeAssetContext, MAX_RUNTIME_ASSET_CONTEXT_CHARS } =
      await import('../../../../src/main/features/mate_agent_backend/runtime-asset-context');
    const items = await buildRuntimeAssetContext('user-a', 'cid-a');
    expect(items).toHaveLength(1);
    expect(items[0].content.length).toBeLessThanOrEqual(MAX_RUNTIME_ASSET_CONTEXT_CHARS);
  });

  it('fails soft (empty array) when recall store is unavailable', async () => {
    const { buildRuntimeAssetContext } = await import('../../../../src/main/features/mate_agent_backend/runtime-asset-context');
    // No ORKAS_WORKSPACE_ROOT data seeded for this user; reads yield no projections.
    await expect(buildRuntimeAssetContext('user-missing', 'cid-missing')).resolves.toEqual([]);
  });
});
