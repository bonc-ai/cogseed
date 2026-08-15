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
  resumeRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ id, status: 'pending_review' })),
  rejectRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'rejected' })),
  ignoreRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'ignored' })),
  keepCurrentRecallCandidate: vi.fn(async (_uid: string, id: string, note?: string) => ({ id, note, status: 'ignored' })),
  batchPromoteRecallCandidates: vi.fn(async (_uid: string, candidateIds: string[]) => ({
    succeeded: candidateIds.map((candidateId) => ({ candidateId, assetId: `aa-${candidateId}`, reviewDecisionId: `rd_${candidateId}00000000` })),
    failed: [],
  })),
  promoteRecallCandidate: vi.fn(async (_uid: string, id: string) => ({ candidate: { id }, asset: { id: 'aa-a' } })),
}));
const assetMock = vi.hoisted(() => ({
  listAbilityAssets: vi.fn(async () => []),
  readAbilityAsset: vi.fn(async (_uid: string, id: string) => ({ id })),
  updateAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, ...input as object })),
  pauseAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, status: 'paused', ...input as object })),
  resumeAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, status: 'active', ...input as object })),
  revokeAbilityAsset: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, status: 'revoked', ...input as object })),
  recommendAbilityAssetAction: vi.fn(async (_uid: string, id: string, input: unknown) => ({ id, ...input as object })),
  listAbilityAssetVersions: vi.fn(async (_uid: string, id: string) => [{ assetId: id, version: '1' }]),
  listAbilityAssetAudit: vi.fn(async (_uid: string, id: string) => [{ assetId: id, action: 'created' }]),
}));
const sourceMock = vi.hoisted(() => ({
  COGNITION_CATALOG_KINDS: ['conversation', 'artifact_file', 'execution_evaluation', 'user_teaching_signal', 'authorized_external_system'],
  listCognitionSources: vi.fn(async () => [{ kind: 'conversation', status: 'empty', count: 0, items: [] }]),
  pauseCognitionSource: vi.fn(async (_uid: string, kind: string, sourceId: string) => ({ kind, sourceId, availability: 'paused' })),
  resumeCognitionSource: vi.fn(async (_uid: string, kind: string, sourceId: string) => ({ kind, sourceId, availability: 'active' })),
  retryCognitionSource: vi.fn(async (_uid: string, kind: string, sourceId: string) => ({ kind, sourceId, availability: 'active' })),
  reconnectCognitionSource: vi.fn(async (_uid: string, kind: string, sourceId: string) => ({ kind, sourceId, availability: 'active' })),
  previewCognitionSourceRemoval: vi.fn(async () => ({ affectedAssetCount: 2, revocableAssetCount: 1 })),
  removeCognitionSource: vi.fn(async (_uid: string, kind: string, sourceId: string, revokeAssets: boolean) => ({
    control: { kind, sourceId, availability: 'removed' },
    affectedAssetIds: ['aa-a', 'aa-b'],
    revokedAssetIds: revokeAssets ? ['aa-a'] : [],
    failedAssetIds: [],
  })),
  removeCognitionSourceRef: vi.fn(async (_uid: string, source: { kind: string; id: string }, revokeAssets: boolean) => ({
    control: { kind: source.kind, sourceId: source.id, availability: 'removed' },
    affectedAssetIds: [],
    revokedAssetIds: revokeAssets ? ['aa-a'] : [],
    failedAssetIds: [],
  })),
}));
const chatsMock = vi.hoisted(() => ({
  getConversation: vi.fn(async () => ({
    conversation_id: 'conv-delete',
    title: 'Deleted conversation',
    updated_at: '2026-08-14T00:00:00.000Z',
  })),
  deleteConversation: vi.fn(async () => true),
}));
const recycleBinMock = vi.hoisted(() => ({
  createAppRecycleBatchForConversation: vi.fn(async () => ({ id: 'recycle-a' })),
  createAppRecycleBatchForConversations: vi.fn(async () => ({ id: 'recycle-all' })),
}));
const captureMock = vi.hoisted(() => ({
  listRecallCaptures: vi.fn(async () => []),
  queryRecallCaptures: vi.fn(async () => ({ captures: [], nextCursor: null, counts: { waiting: 0, processing: 0, review: 0, failed: 0, completed: 0, cancelled: 0 } })),
  readRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  readRecallCaptureWorkflow: vi.fn(async (_uid: string, id: string) => ({ id, status: 'review_ready', workflowStatus: 'completed' })),
  retryRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  pauseRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'paused' })),
  resumeRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  cancelRecallCapture: vi.fn(async (_uid: string, id: string) => ({ id, status: 'cancelled' })),
  runRecallCaptureNow: vi.fn(async (_uid: string, id: string) => ({ id, status: 'queued' })),
  queueManualRecallCaptureFromConversation: vi.fn(async (_uid: string, conversationId: string) => ({ id: 'rcap-manual', conversationId, status: 'waiting_manual' })),
  startHistoricalRecallCapture: vi.fn(async (_uid: string, conversationId: string) => ({
    id: 'rcap-historical-auto', conversationId, status: 'queued', autoWrite: true,
  })),
  promoteRecallCaptureCandidate: vi.fn(async (_uid: string, id: string) => ({
    candidate: { id },
    asset: { id: 'aa-a' },
    decision: { decision_id: 'rd_capture00000000' },
    receipt: {
      assetId: 'aa-a',
      assetType: 'rule',
      version: '1',
      lifecycleStatus: 'user_confirmed_unverified',
      scope: 'project',
      sourceRefs: [{ kind: 'conversation', id: 'conv-a' }],
      reviewDecisionId: 'rd_capture00000000',
    },
  })),
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
const usageFeedbackMock = vi.hoisted(() => ({
  recordRecallMessageFeedback: vi.fn(async (_uid: string, input: unknown) => ({
    ...input as object,
    citationCount: 1,
    recordedCount: 1,
    records: [],
  })),
}));
const skillDraftMock = vi.hoisted(() => ({
  prepareRecallSkillDraft: vi.fn(async (_uid: string, assetId: string) => ({
    assetId,
    draftHash: 'a'.repeat(64),
    validation: { ok: true, target: 'level_a', label: 'level_a_structure', issues: [] },
  })),
  confirmRecallSkillDraft: vi.fn(async (_uid: string, assetId: string) => ({
    draft: { assetId, status: 'installed' },
    skill: { id: 'apply-recall-method', name: 'apply-recall-method' },
  })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: InvokeFn) => { if (channel === 'orkas.invoke') invokeHandler = fn; }, on: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }), logFromRenderer: vi.fn() }));
vi.mock('../../../src/main/features/chats', () => chatsMock);
vi.mock('../../../src/main/features/recycle_bin', () => recycleBinMock);
vi.mock('../../../src/main/features/recall/candidate-service', () => recallMock);
vi.mock('../../../src/main/features/recall/asset-service', () => assetMock);
vi.mock('../../../src/main/features/recall/source-catalog', () => sourceMock);
vi.mock('../../../src/main/features/recall/capture-service', () => captureMock);
vi.mock('../../../src/main/features/recall/capture-settings', () => captureSettingsMock);
vi.mock('../../../src/main/features/recall/recall-view-service', () => viewMock);
vi.mock('../../../src/main/features/recall/teaching-service', () => teachingMock);
vi.mock('../../../src/main/features/recall/context-projection', () => projectionMock);
vi.mock('../../../src/main/features/recall/usage-feedback-service', () => usageFeedbackMock);
vi.mock('../../../src/main/features/recall/skill-draft-service', () => skillDraftMock);

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
  it('routes Recall memory pause, resume, removal, and version history', async () => {
    await expect(call('recall.assets.pause', { assetId: 'aa-method', note: '暂时不用' }))
      .resolves.toMatchObject({ ok: true, asset: { status: 'paused' } });
    await expect(call('recall.assets.resume', { assetId: 'aa-method' }))
      .resolves.toMatchObject({ ok: true, asset: { status: 'active' } });
    await expect(call('recall.assets.revoke', { assetId: 'aa-method', note: '用户移除' }))
      .resolves.toMatchObject({ ok: true, asset: { status: 'revoked' } });
    await expect(call('recall.assets.versions', { assetId: 'aa-method' }))
      .resolves.toMatchObject({ ok: true, versions: [{ version: '1' }], audit: [{ action: 'created' }] });

    expect(assetMock.pauseAbilityAsset).toHaveBeenCalledWith(UID, 'aa-method', { actor: 'user', reason: '暂时不用' });
    expect(assetMock.resumeAbilityAsset).toHaveBeenCalledWith(UID, 'aa-method', { actor: 'user', reason: 'user resume' });
    expect(assetMock.revokeAbilityAsset).toHaveBeenCalledWith(UID, 'aa-method', { actor: 'user', reason: '用户移除' });
    expect(assetMock.listAbilityAssetVersions).toHaveBeenCalledWith(UID, 'aa-method');
    await expect(call('recall.assets.resume', { assetId: '../bad' })).resolves.toMatchObject({ ok: false });
    expect(assetMock.resumeAbilityAsset).toHaveBeenCalledTimes(1);
  });

  it('routes validated save and governance actions with the active uid', async () => {
    await expect(call('recall.candidates.save', { judgment: 'Use decision logs', suggestedType: 'rule', suggestedScope: 'architecture', sourceRefs: [{ kind: 'execution', id: 'exec-a' }] })).resolves.toMatchObject({ ok: true });
    expect(recallMock.saveRecallCandidate).toHaveBeenCalledWith(UID, expect.objectContaining({ judgment: 'Use decision logs', suggestedType: 'rule' }));
    await expect(call('recall.candidates.promote', { candidateId: 'cand-a' })).resolves.toMatchObject({
      ok: true,
      asset: { id: 'aa-a' },
      decision: { decision_id: 'rd_capture00000000' },
      receipt: {
        assetId: 'aa-a',
        assetType: 'rule',
        version: '1',
        scope: 'project',
        reviewDecisionId: 'rd_capture00000000',
      },
    });
    expect(captureMock.promoteRecallCaptureCandidate).toHaveBeenCalledWith(UID, 'cand-a', { riskAcknowledged: false });
    await expect(call('recall.candidates.ignore', { candidateId: 'cand-a', note: 'not reusable' })).resolves.toMatchObject({ ok: true, candidate: { status: 'ignored' } });
    expect(recallMock.ignoreRecallCandidate).toHaveBeenCalledWith(UID, 'cand-a', 'not reusable');
    await expect(call('recall.candidates.promoteBatch', { candidateIds: ['cand-a', 'cand-b'] })).resolves.toMatchObject({ ok: true, failed: [] });
    expect(recallMock.batchPromoteRecallCandidates).toHaveBeenCalledWith(UID, ['cand-a', 'cand-b']);
  });

  it('routes structured ability asset governance and recommendations', async () => {
    await expect(call('recall.assets.update', {
      assetId: 'aa-method',
      statement: 'Keep the reusable method scoped.',
      scopePolicy: { purposeTags: ['review'], workspaceIds: ['workspace-a'] },
      reason: 'Narrow the reuse boundary.',
      acknowledgeRecommendation: true,
    })).resolves.toMatchObject({ ok: true, asset: { id: 'aa-method' } });
    expect(assetMock.updateAbilityAsset).toHaveBeenCalledWith(UID, 'aa-method', expect.objectContaining({
      statement: 'Keep the reusable method scoped.',
      scopePolicy: { purposeTags: ['review'], workspaceIds: ['workspace-a'] },
      reason: 'Narrow the reuse boundary.',
      actor: 'user',
      acknowledgeRecommendation: true,
    }));

    await expect(call('recall.assets.recommend', { assetId: 'aa-method', action: 'rework', reason: 'Effectiveness regressed.' }))
      .resolves.toMatchObject({ ok: true, asset: { action: 'rework' } });
    expect(assetMock.recommendAbilityAssetAction).toHaveBeenCalledWith(UID, 'aa-method', {
      actor: 'system', action: 'rework', reason: 'Effectiveness regressed.',
    });
  });

  it('routes the two-step Recall skill draft flow and validates the confirmation hash', async () => {
    await expect(call('recall.skills.prepare', { assetId: 'aa-method' }))
      .resolves.toMatchObject({ ok: true, draft: { assetId: 'aa-method' } });
    expect(skillDraftMock.prepareRecallSkillDraft).toHaveBeenCalledWith(UID, 'aa-method');

    const draftHash = 'a'.repeat(64);
    await expect(call('recall.skills.confirm', { assetId: 'aa-method', draftHash }))
      .resolves.toMatchObject({ ok: true, skill: { id: 'apply-recall-method' } });
    expect(skillDraftMock.confirmRecallSkillDraft).toHaveBeenCalledWith(UID, 'aa-method', draftHash);

    await expect(call('recall.skills.prepare', { assetId: '../bad' })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.skills.confirm', { assetId: 'aa-method', draftHash: 'bad' })).resolves.toMatchObject({ ok: false });
    expect(skillDraftMock.confirmRecallSkillDraft).toHaveBeenCalledTimes(1);
  });

  it('passes the retryable Recall skill generation state through IPC', async () => {
    skillDraftMock.prepareRecallSkillDraft.mockResolvedValueOnce({
      assetId: 'aa-method',
      assetVersion: '1',
      status: 'failed',
      title: 'Review method',
      scope: 'product',
      attempt: 1,
      errorCode: 'model_not_configured',
      errorMessage: 'A usable model has not been configured.',
      retryable: true,
    });

    await expect(call('recall.skills.prepare', { assetId: 'aa-method' })).resolves.toMatchObject({
      ok: true,
      draft: { status: 'failed', errorCode: 'model_not_configured', retryable: true },
    });
    expect(skillDraftMock.prepareRecallSkillDraft).toHaveBeenCalledWith(UID, 'aa-method');
  });

  it('rejects invalid ids, enums, oversized text, and missing source refs before feature calls', async () => {
    await expect(call('recall.candidates.save', { judgment: 'x', suggestedType: 'unknown', suggestedScope: 'a', sourceRefs: [] })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.candidates.promote', { candidateId: '../bad' })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.candidates.defer', { candidateId: 'cand-a', note: 'x'.repeat(1_001) })).resolves.toMatchObject({ ok: false });
    expect(captureMock.promoteRecallCaptureCandidate).not.toHaveBeenCalled();
  });

  it('routes validated source and capture requests through the active user boundary', async () => {
    await expect(call('recall.sources.list', { kinds: ['conversation', 'artifact_file'], conversationId: 'conv-a', limit: 10 }))
      .resolves.toMatchObject({ ok: true, sources: expect.any(Array) });
    expect(sourceMock.listCognitionSources).toHaveBeenCalledWith(UID, {
      kinds: ['conversation', 'artifact_file'],
      conversationId: 'conv-a',
      limit: 10,
    });
    await expect(call('recall.sources.pause', { kind: 'conversation', sourceId: 'conv-a' }))
      .resolves.toMatchObject({ ok: true, control: { availability: 'paused' } });
    await expect(call('recall.sources.resume', { kind: 'conversation', sourceId: 'conv-a' }))
      .resolves.toMatchObject({ ok: true, control: { availability: 'active' } });
    await expect(call('recall.sources.retry', { kind: 'artifact_file', sourceId: 'ctx-a' }))
      .resolves.toMatchObject({ ok: true });
    await expect(call('recall.sources.reconnect', { kind: 'conversation', sourceId: 'conv-a' }))
      .resolves.toMatchObject({ ok: true });
    await expect(call('recall.sources.removeImpact', { kind: 'conversation', sourceId: 'conv-a' }))
      .resolves.toMatchObject({ ok: true, impact: { affectedAssetCount: 2, revocableAssetCount: 1 } });
    await expect(call('recall.sources.remove', { kind: 'conversation', sourceId: 'conv-a', revokeAssets: false }))
      .resolves.toMatchObject({ ok: true, result: { revokedAssetIds: [] } });
    expect(sourceMock.removeCognitionSource).toHaveBeenCalledWith(UID, 'conversation', 'conv-a', false);

    await expect(call('recall.captures.list', { limit: 5 }))
      .resolves.toMatchObject({ ok: true, captures: [] });
    expect(captureMock.queryRecallCaptures).toHaveBeenCalledWith(UID, { limit: 5 });
    await expect(call('recall.captures.list', { statuses: ['waiting_quiet', 'waiting_completion'], executionPolicy: 'smart' }))
      .resolves.toMatchObject({ ok: true, captures: [] });
    await expect(call('recall.captures.list', { statuses: ['completed'] }))
      .resolves.toMatchObject({ ok: true, captures: [] });
    expect(captureMock.queryRecallCaptures).toHaveBeenCalledWith(UID, { statuses: ['completed'] });
    await expect(call('recall.captures.list', { statuses: ['waiting', 'writing'] }))
      .resolves.toMatchObject({ ok: true, captures: [] });

    await expect(call('recall.captures.read', { captureId: 'rcap-a' }))
      .resolves.toMatchObject({ ok: true, capture: { id: 'rcap-a', workflowStatus: 'completed' } });
    expect(captureMock.readRecallCaptureWorkflow).toHaveBeenCalledWith(UID, 'rcap-a');

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
    await expect(call('recall.captures.historicalAutoStart', { conversationId: 'conv-a' }))
      .resolves.toMatchObject({ capture: { conversationId: 'conv-a', status: 'queued', autoWrite: true } });
    expect(captureMock.startHistoricalRecallCapture).toHaveBeenCalledWith(UID, 'conv-a');
    expect(captureMock.queueManualRecallCaptureFromConversation).toHaveBeenCalledTimes(1);

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

  it('writes a Recall source tombstone only after a conversation delete succeeds', async () => {
    await expect(call('conversations.delete', { cid: 'conv-delete' }))
      .resolves.toMatchObject({ ok: true, deleted: true });

    expect(chatsMock.getConversation).toHaveBeenCalledWith(UID, 'conv-delete', undefined);
    expect(chatsMock.deleteConversation).toHaveBeenCalledWith(UID, 'conv-delete', undefined);
    expect(sourceMock.removeCognitionSourceRef).toHaveBeenCalledWith(UID, expect.objectContaining({
      kind: 'conversation',
      subtype: 'session',
      scope: 'conversation',
      id: 'conv-delete',
      title: 'Deleted conversation',
    }), false);
  });

  it('rejects malformed source and capture inputs before feature calls', async () => {
    await expect(call('recall.sources.list', { kinds: ['obsolete_source_kind'] }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.sources.list', { conversationId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.sources.pause', { kind: 'conversation', sourceId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.sources.remove', { kind: 'conversation', sourceId: 'conv-a' }))
      .resolves.toMatchObject({ ok: false });
    await expect(call('recall.sources.retry', { kind: 'unknown', sourceId: 'conv-a' }))
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
    await expect(call('recall.captures.historicalAutoStart', { conversationId: '../bad' }))
      .resolves.toMatchObject({ ok: false });
    expect(captureMock.startHistoricalRecallCapture).not.toHaveBeenCalledWith(UID, '../bad');
    await expect(call('recall.projections.list', { status: 'unknown' }))
      .resolves.toMatchObject({ ok: false });
  });

  it('routes only validated Recall message feedback through the active user boundary', async () => {
    await expect(call('recall.usage.feedback', {
      cid: 'conv-a',
      messageId: 'msg-a',
      feedback: 'positive',
    })).resolves.toMatchObject({
      ok: true,
      result: { feedback: 'positive', citationCount: 1 },
    });
    expect(usageFeedbackMock.recordRecallMessageFeedback).toHaveBeenCalledWith(UID, {
      cid: 'conv-a',
      messageId: 'msg-a',
      feedback: 'positive',
    });

    await expect(call('recall.usage.feedback', {
      cid: '../bad', messageId: 'msg-a', feedback: 'positive',
    })).resolves.toMatchObject({ ok: false });
    await expect(call('recall.usage.feedback', {
      cid: 'conv-a', messageId: 'msg-a', feedback: 'neutral',
    })).resolves.toMatchObject({ ok: false });
    expect(usageFeedbackMock.recordRecallMessageFeedback).toHaveBeenCalledTimes(1);
  });
});
