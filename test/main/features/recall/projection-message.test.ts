import { describe, expect, it, vi } from 'vitest';

const enqueueMock = vi.hoisted(() => vi.fn(async (input: unknown) => ({ id: 'msg-a', ...(input as Record<string, unknown>) })));
const projectionPortMock = vi.hoisted(() => ({ send: enqueueMock }));
const projectionMock = vi.hoisted(() => ({
  previewContextProjection: vi.fn(async (_userId: string, input: unknown) => ({ id: 'proj-preview', status: 'preview', ...(input as Record<string, unknown>) })),
  reviseContextProjection: vi.fn(async (_userId: string, projectionId: string, input: unknown) => ({ id: 'proj-revised', parentProjectionId: projectionId, status: 'preview', ...(input as Record<string, unknown>) })),
}));
const cardMock = vi.hoisted(() => ({
  buildProjectionCard: vi.fn(async (_userId: string, projectionId: string) => ({
    kind: 'recall_projection_card',
    projectionId,
    taskRunId: 'task-a',
    purpose: 'review',
    status: 'preview',
    summary: { includedCount: 2, omittedCount: 1, sourceRefCount: 3 },
    assetSummaries: [{ assetId: 'aa-a', title: 'Use decision logs' }],
    omittedAssetRefs: [{ assetId: 'aa-b', reason: 'asset_paused' }],
    availableActions: ['confirm', 'defer', 'reject'],
  })),
}));

vi.mock('../../../../src/main/features/recall/projection-card', () => cardMock);
vi.mock('../../../../src/main/features/recall/context-projection', () => projectionMock);

describe('recall projection chat messages', () => {
  it('previews and posts a projection card through one explicit trigger', async () => {
    const messages = await import('../../../../src/main/features/recall/projection-message');

    const result = await messages.previewAndPostProjectionCard('user-a', { cid: 'cid-a', taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', taskText: 'OAuth review task' }, projectionPortMock);

    expect(projectionMock.previewContextProjection).toHaveBeenCalledWith('user-a', { taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', taskText: 'OAuth review task' });
    expect(cardMock.buildProjectionCard).toHaveBeenCalledWith('user-a', 'proj-preview');
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ cid: 'cid-a', card: expect.objectContaining({ projectionId: 'proj-preview' }) }));
    expect(result).toMatchObject({ ok: true, projection: { id: 'proj-preview' }, card: { projectionId: 'proj-preview' }, msg: { id: 'msg-a' } });
  });

  it('generates a next-task id for projection and returns it for the next send', async () => {
    const messages = await import('../../../../src/main/features/recall/projection-message');

    const result = await messages.previewAndPostProjectionCardForNextTask('user-a', { cid: 'cid-a', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Next OAuth task' }, projectionPortMock);

    expect(result.taskRunId).toMatch(/^rt-[a-z0-9]+$/);
    expect(projectionMock.previewContextProjection).toHaveBeenCalledWith('user-a', expect.objectContaining({
      taskRunId: result.taskRunId,
      workspaceId: 'workspace-a',
      purpose: 'review',
      taskText: 'Next OAuth task',
    }));
    expect(result.projection).toMatchObject({ taskRunId: result.taskRunId });
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ cid: 'cid-a', card: expect.objectContaining({ projectionId: 'proj-preview' }) }));
  });


  it('revises and posts a replacement projection card', async () => {
    const messages = await import('../../../../src/main/features/recall/projection-message');

    const result = await messages.reviseAndPostProjectionCard('user-a', {
      cid: 'cid-a', projectionId: 'proj-a', purpose: 'archive', addAssetIds: ['asset-extra'], removeAssetIds: ['asset-old'], decisionNote: 'manual draft',
    }, projectionPortMock);

    expect(projectionMock.reviseContextProjection).toHaveBeenCalledWith('user-a', 'proj-a', {
      purpose: 'archive', addAssetIds: ['asset-extra'], removeAssetIds: ['asset-old'], decisionNote: 'manual draft',
    });
    expect(cardMock.buildProjectionCard).toHaveBeenCalledWith('user-a', 'proj-revised');
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ cid: 'cid-a', card: expect.objectContaining({ projectionId: 'proj-revised' }) }));
    expect(result).toMatchObject({ ok: true, projection: { id: 'proj-revised' }, card: { projectionId: 'proj-revised' } });
  });

  it('posts a commander-to-user message carrying the projection card payload', async () => {
    const messages = await import('../../../../src/main/features/recall/projection-message');

    const result = await messages.postProjectionCardMessage('user-a', { cid: 'cid-a', projectionId: 'proj-a' }, projectionPortMock);

    expect(cardMock.buildProjectionCard).toHaveBeenCalledWith('user-a', 'proj-a');
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-a',
      cid: 'cid-a',
      card: expect.objectContaining({ projectionId: 'proj-a' }),
    }));
    expect(enqueueMock.mock.calls[0][0]).toMatchObject({
      text: 'Preload candidates: 2; add or remove as needed.',
    });
    expect(JSON.stringify(enqueueMock.mock.calls[0][0])).not.toContain('statement');
    expect(result).toMatchObject({ ok: true, card: { projectionId: 'proj-a' }, msg: { id: 'msg-a' } });
  });
});
