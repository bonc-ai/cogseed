import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (event: unknown, request: { channel: string; payload?: unknown }) => Promise<{ ok: boolean } & Record<string, unknown>>;
let invokeHandler: InvokeFn | null = null;
const UID = 'uRecallIpc';

const recallMock = vi.hoisted(() => ({
  listRecallCandidates: vi.fn(async () => []),
  readRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id })),
  saveRecallCandidate: vi.fn(async (_uid: string, input: unknown) => input),
  deferRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'deferred' })),
  resumeRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id, status: 'pending' })),
  rejectRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'rejected' })),
  promoteRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ candidate: { id }, asset: { id: 'aa-a' } })),
}));

const assetMock = vi.hoisted(() => ({
  updateAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, ...input })),
  pauseAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, status: 'paused', ...input as object })),
  resumeAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, status: 'active', ...input as object })),
  revokeAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, status: 'revoked', ...input as object })),
  recommendAbilityAssetAction: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, ...input })),
}));
const sourceMock = vi.hoisted(() => ({
  COGNITION_CATALOG_KINDS: ['conversation', 'artifact_file', 'execution_evaluation', 'user_teaching_signal', 'authorized_external_system'],
  listCognitionSources: vi.fn(async () => [{ kind: 'conversation', status: 'empty', count: 0, items: [] }]),
}));
const captureMock = vi.hoisted(() => ({
  listRecallCaptures: vi.fn(async () => []),
  queryRecallCaptures: vi.fn(async () => ({ captures: [], nextCursor: null, counts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 } })),
  readRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  retryRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  pauseRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'paused' })),
  resumeRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  cancelRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'cancelled' })),
  runRecallCaptureNow: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  queueManualRecallCaptureFromConversation: vi.fn(async (_uid: string, conversationId: string) => ({ id: 'rcap-manual', conversationId, status: 'waiting_manual' })),
}));
const captureSettingsMock = vi.hoisted(() => ({
  readRecallCaptureSettings: vi.fn(async (uid: string) => ({ id: 'settings', ownerId: uid, enabled: true, executionPolicy: 'smart', quietMinutes: 10, nightlyStart: '02:00', nightlyEnd: '06:00', catchUpMissed: true })),
  updateRecallCaptureSettings: vi.fn(async (uid: string, input: unknown) => ({ id: 'settings', ownerId: uid, ...input })),
}));
const viewMock = vi.hoisted(() => ({
  listRecallViews: vi.fn(async () => []),
  readRecallView: vi.fn(async (_uid: string, id: string) => ({ id })),
}));
const teachingMock = vi.hoisted(() => ({
  listUserTeachingSignals: vi.fn(async () => []),
  revokeUserTeachingSignal: vi.fn(async (_uid: string, id: string) => ({ id, status: 'revoked' })),
}));
const projectionMock = vi.hoisted(() => ({
  listContextProjections: vi.fn(async () => []),
  previewContextProjection: vi.fn(async (_uid: string, input: unknown) => ({ id: 'proj-a', ...input as object })),
  confirmContextProjection: vi.fn(async (_uid: string, id: string) => ({ id, status: 'confirmed' })),
  readContextProjection: vi.fn(async (_uid: string, id: string) => ({ id })),
}));

const groupChatMock = vi.hoisted(() => ({
  sendCommanderMessage: vi.fn(async (input: unknown) => ({ msg: { id: 'msg-commander', ...(input as object) } })),
}));
const projectionMessageMock = vi.hoisted(() => ({
  previewAndPostProjectionCardForNextTask: vi.fn(async (_uid: string, input: unknown, port: { send(input: { text: string; card: { projectionId: string } }): Promise<{ id: string }> }) => {
    const msg = await port.send({ text: 'Found 1 reusable ability asset for conversation_task; omitted 0.', card: { projectionId: 'proj-next' } });
    return { taskRunId: 'rt-next', projection: { id: 'proj-next' }, card: { projectionId: 'proj-next' }, msg };
  }),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'orkas.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/features/group_chat', () => groupChatMock);
vi.mock('../../../src/main/features/recall/projection-message', () => projectionMessageMock);
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
vi.mock('../../../src/main/features/recall/candidate-service', () => recallMock);
vi.mock('../../../src/main/features/recall/asset-service', () => assetMock);
vi.mock('../../../src/main/features/recall/source-catalog', () => sourceMock);
vi.mock('../../../src/main/features/recall/capture-service', () => captureMock);
vi.mock('../../../src/main/features/recall/capture-settings', () => captureSettingsMock);
vi.mock('../../../src/main/features/recall/recall-view-service', () => viewMock);
vi.mock('../../../src/main/features/recall/teaching-service', () => teachingMock);
vi.mock('../../../src/main/features/recall/context-projection', () => projectionMock);

beforeEach(async () => {
  process.env.ORKAS_WORKSPACE_ROOT = os.tmpdir();
  invokeHandler = null;
  vi.resetModules(); vi.clearAllMocks();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  const users = await import('../../../src/main/features/users'); users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => vi.resetModules());
function call(channel: string, payload: unknown = {}) { if (!invokeHandler) throw new Error('missing handler'); return invokeHandler({ sender: trustedIpcSender() }, { channel, payload }); }

describe('ipc › recall candidate governance', () => {
  it('routes validated save and governance actions with the active uid', async () => {
    await expect(call('recall.candidates.save', { judgment: 'Use decision logs', suggestedType: 'rule', suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] })).resolves.toMatchObject({ ok: true });
    expect(recallMock.saveRecallCandidate).toHaveBeenCalledWith(UID, expect.objectContaining({ judgment: 'Use decision logs', suggestedType: 'rule' }));
    await expect(call('recall.candidates.promote', { candidateId: 'cand-a' })).resolves.toMatchObject({ ok: true, asset: { id: 'aa-a' } });
    expect(recallMock.promoteRecallCandidate).toHaveBeenCalledWith(UID, 'cand-a', { actor: 'user' });
  });



  it('routes validated ability asset governance with explicit user reason and structured scope policy', async () => {
    await expect(call('recall.assets.update', {
      assetId: 'aa-a',
      statement: 'Keep a scoped decision log.',
      scope: 'architecture-review',
      scopePolicy: { purposeTags: ['architecture', 'review'], workspaceIds: ['workspace-a'] },
      reason: 'Narrow the reusable rule.',
      acknowledgeRecommendation: true,
    })).resolves.toMatchObject({ ok: true, asset: { id: 'aa-a' } });
    expect(assetMock.updateAbilityAsset).toHaveBeenCalledWith(UID, 'aa-a', expect.objectContaining({
      statement: 'Keep a scoped decision log.',
      scopePolicy: { purposeTags: ['architecture', 'review'], workspaceIds: ['workspace-a'] },
      reason: 'Narrow the reusable rule.',
      actor: 'user',
      acknowledgeRecommendation: true,
    }));

    await expect(call('recall.assets.resume', { assetId: 'aa-a', note: 'verified again' })).resolves.toMatchObject({ ok: true, asset: { status: 'active' } });
    expect(assetMock.resumeAbilityAsset).toHaveBeenCalledWith(UID, 'aa-a', { actor: 'user', reason: 'verified again' });

    await expect(call('recall.assets.recommend', { assetId: 'aa-a', action: 'pause', reason: 'negative transfer' })).resolves.toMatchObject({ ok: true, asset: { action: 'pause' } });
    expect(assetMock.recommendAbilityAssetAction).toHaveBeenCalledWith(UID, 'aa-a', { actor: 'system', action: 'pause', reason: 'negative transfer' });
  });

  it('rejects malformed ability asset governance payloads before feature calls', async () => {
    await expect(call('recall.assets.update', { assetId: 'aa-a', statement: 'x', reason: '' })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.assets.resume', { assetId: '../bad', note: 'x' })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.assets.recommend', { assetId: 'aa-a', action: 'delete', reason: 'x' })).resolves.toMatchObject({ ok: false });
    expect(assetMock.updateAbilityAsset).not.toHaveBeenCalled();
    expect(assetMock.resumeAbilityAsset).not.toHaveBeenCalled();
    expect(assetMock.recommendAbilityAssetAction).not.toHaveBeenCalled();
  });

  it('rejects invalid ids, enums, oversized text, and missing source refs before feature calls', async () => {
    await expect(call('recall.candidates.save', { judgment: 'x', suggestedType: 'unknown', suggestedScope: 'a', sourceRefs: [] })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.candidates.promote', { candidateId: '../bad' })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.candidates.defer', { candidateId: 'cand-a', note: 'x'.repeat(1_001) })).resolves.toMatchObject({ ok: false });
    expect(recallMock.promoteRecallCandidate).not.toHaveBeenCalled();
  });

  it('routes validated source and capture requests through the active user boundary', async () => {
    await expect(call('recall.sources.list', { kinds: ['conversation', 'artifact_file'], conversationId: 'conv-a', limit: 10 }))
      .resolves.toMatchObject({ ok: true, sources: expect.any(Array) });
    expect(sourceMock.listCognitionSources).toHaveBeenCalledWith(UID, {
      kinds: ['conversation', 'artifact_file'],
      conversationId: 'conv-a',
      limit: 10,
    });

    await expect(call('recall.captures.list', { limit: 5 }))
      .resolves.toMatchObject({ ok: true, captures: [] });
    expect(captureMock.queryRecallCaptures).toHaveBeenCalledWith(UID, { limit: 5 });
    await expect(call('recall.captures.list', { statuses: ['waiting_quiet', 'waiting_completion'], executionPolicy: 'smart' }))
      .resolves.toMatchObject({ ok: true, captures: [] });

    await expect(call('recall.captures.read', { captureId: 'rcap-a' }))
      .resolves.toMatchObject({ ok: true, capture: { id: 'rcap-a' } });

    await expect(call('recall.captures.retry', { captureId: 'rcap-a' }))
      .resolves.toMatchObject({ ok: true, capture: { status: 'queued' } });
    expect(captureMock.retryRecallCapture).toHaveBeenCalledWith(UID, 'rcap-a');

    await expect(call('recall.captures.pause', { captureId: 'rcap-a' })).resolves.toMatchObject({ capture: { status: 'paused' } });
    await expect(call('recall.captures.resume', { captureId: 'rcap-a' })).resolves.toMatchObject({ capture: { status: 'queued' } });
    await expect(call('recall.captures.cancel', { captureId: 'rcap-a' })).resolves.toMatchObject({ capture: { status: 'cancelled' } });
    await expect(call('recall.captures.runNow', { captureId: 'rcap-a' })).resolves.toMatchObject({ capture: { status: 'queued' } });
    await expect(call('recall.captures.manualCreate', { conversationId: 'conv-a' }))
      .resolves.toMatchObject({ capture: { conversationId: 'conv-a', status: 'waiting_manual' } });
    expect(captureMock.queueManualRecallCaptureFromConversation).toHaveBeenCalledWith(UID, 'conv-a');

    await expect(call('recall.captures.settings.update', { executionPolicy: 'nightly', nightlyStart: '02:00' }))
      .resolves.toMatchObject({ ok: true, settings: { executionPolicy: 'nightly' } });
    expect(captureSettingsMock.updateRecallCaptureSettings).toHaveBeenCalledWith(UID, { executionPolicy: 'nightly', nightlyStart: '02:00' });
    await expect(call('recall.captures.settings.update', { executionPolicy: 'smart', quietMinutes: 30 }))
      .resolves.toMatchObject({ ok: true, settings: { executionPolicy: 'smart', quietMinutes: 30 } });
    await expect(call('recall.captures.settings.get'))
      .resolves.toMatchObject({ ok: true, settings: { enabled: true }, model: { configured: expect.any(Boolean) } });
    expect(captureSettingsMock.readRecallCaptureSettings).toHaveBeenCalledWith(UID);

    await expect(call('recall.views.list', { purpose: 'conversation_capture', workspaceId: 'workspace-a', limit: 5 }))
      .resolves.toMatchObject({ ok: true, views: [] });
    expect(viewMock.listRecallViews).toHaveBeenCalledWith(UID, { purpose: 'conversation_capture', workspaceId: 'workspace-a', limit: 5 });
    await expect(call('recall.views.read', { viewId: 'rv-a' })).resolves.toMatchObject({ ok: true, view: { id: 'rv-a' } });

    await expect(call('recall.projections.list', { workspaceId: 'workspace-a', includeExpired: true, limit: 10 }))
      .resolves.toMatchObject({ ok: true, projections: [] });
    expect(projectionMock.listContextProjections).toHaveBeenCalledWith(UID, {
      workspaceId: 'workspace-a', includeExpired: true, limit: 10,
    });

    await expect(call('recall.teaching.list', { conversationId: 'conv-a', status: 'active', limit: 5 }))
      .resolves.toMatchObject({ ok: true, signals: [] });
    await expect(call('recall.teaching.revoke', { signalId: 'teach-a' }))
      .resolves.toMatchObject({ ok: true, signal: { status: 'revoked' } });
    expect(teachingMock.revokeUserTeachingSignal).toHaveBeenCalledWith(UID, 'teach-a');
  });



  it('routes next-task reuse suggestions through the commander projection bridge', async () => {
    await expect(call('recall.projections.previewAndPostForNextTask', {
      cid: 'conv-a',
      workspaceId: 'workspace-a',
      purpose: 'conversation_task',
      taskText: 'Next review task',
      authorization: 'user_confirmed',
    })).resolves.toMatchObject({ ok: true, taskRunId: 'rt-next', msg: { id: 'msg-commander' } });

    expect(projectionMessageMock.previewAndPostProjectionCardForNextTask).toHaveBeenCalledWith(UID, expect.objectContaining({
      cid: 'conv-a',
      workspaceId: 'workspace-a',
      purpose: 'conversation_task',
      taskText: 'Next review task',
      authorization: 'user_confirmed',
    }), expect.objectContaining({ send: expect.any(Function) }));
    expect(groupChatMock.sendCommanderMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: UID,
      cid: 'conv-a',
      text: 'Found 1 reusable ability asset for conversation_task; omitted 0.',
      recall_projection_card: { projectionId: 'proj-next' },
    }));
  });

  it('rejects malformed source and capture inputs before feature calls', async () => {
    await expect(call('recall.sources.list', { kinds: ['legacy_patch'] }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.sources.list', { conversationId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.captures.list', { limit: 101 }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.captures.list', { statuses: ['unknown'] }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.captures.list', { executionPolicy: 'weekly' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.captures.retry', { captureId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.captures.pause', { captureId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.projections.list', { status: 'unknown' }))
      .resolves.toMatchObject({ ok: false });
  });
});
