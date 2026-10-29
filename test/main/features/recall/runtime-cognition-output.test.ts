import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mocks = vi.hoisted(() => ({ task: vi.fn(), meta: vi.fn(), events: vi.fn(), head: vi.fn(), snapshot: vi.fn(), readable: vi.fn(), model: vi.fn(), projection: vi.fn() }));
vi.mock('../../../../src/main/features/cogseed_backend/task-store', () => ({ readCogSeedTask: mocks.task }));
vi.mock('../../../../src/main/features/cogseed_runtime/store', () => ({ readRuntimeRunMeta: mocks.meta, readRuntimeRunEvents: mocks.events }));
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: async () => ({ conversation_id: 'conv-runtime', project_id: 'project-a', kind: 'normal' }) }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({ readAbilityAsset: mocks.head, readAbilityAssetVersionSnapshot: mocks.snapshot }));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({ filterRecallAssetsForAgentRead: mocks.readable }));
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: mocks.model }));
vi.mock('../../../../src/main/features/recall/context-projection', () => ({ readContextProjection: mocks.projection }));
let root: string;
const task = { ownerId: 'user-a', taskId: 'task-runtime', executionId: 'cogseed-exec-a', runtimeRunId: 'run_a', requestId: 'req-a',
  runtimeSessionId: 'cogseed-runtime-session-a', status: 'completed', executionKind: 'cogseed-native', conversationId: 'conv-runtime',
  agentId: 'commander', task: '解释这次选择。', abilityAssetIds: ['aa-pref'] };
const output = '结论：保留来源。\n原因：后续可核查。';
const terminal = { type: 'result', request_id: task.requestId, runtime_session_id: task.runtimeSessionId,
  status: 'completed', text: output, metadata: { runtime_run_id: task.runtimeRunId } };
beforeEach(async () => {
  vi.resetModules(); Object.values(mocks).forEach(mock => mock.mockReset());
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-runtime-output-')); vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
  mocks.task.mockResolvedValue({ ...task });
  mocks.meta.mockResolvedValue({ run_id: task.runtimeRunId, request_id: task.requestId, runtime_session_id: task.runtimeSessionId, status: 'running' });
  mocks.events.mockResolvedValue([terminal]);
  mocks.head.mockResolvedValue({ id: 'aa-pref', ownerId: 'user-a', status: 'active', scope: 'general', version: '1', evidenceRefs: [] });
  mocks.snapshot.mockResolvedValue({ type: 'cognition', contentCategory: 'preference', statement: '先给结论，再说明原因。', evidenceRefs: [] });
  mocks.projection.mockResolvedValue({ status: 'confirmed', conversationId: task.conversationId, taskRunId: 'earlier-projection-turn',
    assetIds: ['aa-pref'], assetVersions: { 'aa-pref': '1' } });
  mocks.readable.mockImplementation(async (_uid, rows) => rows);
  mocks.model.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ assetId: 'aa-pref', version: '1', status: 'complied', outputEvidence: { quote: '结论：保留来源。' } }] }), meta: {} } });
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
async function supplied(projectionId?: string) {
  const { recordInjectionReceipt } = await import('../../../../src/main/features/recall/injection-receipt');
  await recordInjectionReceipt('user-a', { taskRunId: task.taskId, messageId: 'runtime-result-' + task.executionId,
    assetId: 'aa-pref', assetVersion: '1', status: 'injected', boundary: 'real', channel: 'runtime', ...(projectionId ? { projectionId } : {}) });
}
describe('isolated Runtime terminal-text consumption', () => {
  it('checks persisted terminal text and records text adoption against its actual run without creating a UI message', async () => {
    await supplied();
    const { checkPersistedRuntimeCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    const receipt = await checkPersistedRuntimeCognitionOutput('user-a', task.taskId);
    expect(receipt).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied' }],
      resultSource: { kind: 'runtime_terminal', taskId: task.taskId, runId: 'run_a', requestId: task.requestId, runtimeSessionId: task.runtimeSessionId } });
    const request = mocks.model.mock.calls[0][1];
    expect(request.systemPrompt).toContain('no trusted produced-file manifest');
    expect(JSON.parse(request.message).resultRefs).toEqual([expect.objectContaining({ kind: 'execution_output', id: 'run_a' })]);
    expect(mocks.readable.mock.calls[0][2]).toMatchObject({ projectId: 'project-a', agentId: 'commander' });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', projectionId: 'runtime-task',
      resultSource: expect.objectContaining({ runId: 'run_a' }), evidenceRefs: [expect.objectContaining({ kind: 'execution', id: 'run_a' })] })]);
    const { conversationMessageReadFile } = await import('../../../../src/main/util/project-layout');
    await expect(fs.access(conversationMessageReadFile('user-a', 'conv-runtime'))).rejects.toThrow();
  });
  it('checks a reused confirmed projection against the current Runtime scope, not the earlier projection turn', async () => {
    await supplied('projection-a');
    mocks.task.mockResolvedValue({ ...task, abilityAssetIds: [] });
    const { checkPersistedRuntimeCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedRuntimeCognitionOutput('user-a', task.taskId)).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied' }] });
    expect(mocks.projection).toHaveBeenCalledWith('user-a', 'projection-a');
    expect(mocks.readable.mock.calls[0][2]).toMatchObject({ projectId: 'project-a', agentId: 'commander' });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([expect.objectContaining({ status: 'applied', projectionId: 'projection-a' })]);
  });
  it.each(['request', 'session', 'run', 'multiple', 'failed', 'not_completed'])('refuses an unbound %s terminal before model use', async fault => {
    await supplied();
    if (fault === 'request') mocks.meta.mockResolvedValue({ run_id: 'run_a', request_id: 'other', runtime_session_id: task.runtimeSessionId });
    if (fault === 'session') mocks.events.mockResolvedValue([{ ...terminal, runtime_session_id: 'other' }]);
    if (fault === 'run') mocks.events.mockResolvedValue([{ ...terminal, metadata: { runtime_run_id: 'run_other' } }]);
    if (fault === 'multiple') mocks.events.mockResolvedValue([terminal, terminal]);
    if (fault === 'failed') mocks.events.mockResolvedValue([{ ...terminal, status: 'failed' }]);
    if (fault === 'not_completed') mocks.task.mockResolvedValue({ ...task, status: 'running' });
    const { checkPersistedRuntimeCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    await expect(checkPersistedRuntimeCognitionOutput('user-a', task.taskId)).rejects.toThrow('runtime result');
    expect(mocks.model).not.toHaveBeenCalled();
  });
  it('keeps changed terminal text or revoked guidance unknown without writing adoption', async () => {
    await supplied();
    mocks.model.mockImplementation(async () => {
      mocks.events.mockResolvedValue([{ ...terminal, text: '核查期间终态正文被改动。' }]);
      return { result: { text: JSON.stringify({ checks: [{ assetId: 'aa-pref', version: '1', status: 'complied', outputEvidence: { quote: '结论：保留来源。' } }] }), meta: {} } };
    });
    const { checkPersistedRuntimeCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
    expect(await checkPersistedRuntimeCognitionOutput('user-a', task.taskId)).toMatchObject({ modelCompleted: false, checks: [{ status: 'unknown' }] });
    const { listAssetUsageReceipts } = await import('../../../../src/main/features/recall/asset-usage-receipt');
    expect(await listAssetUsageReceipts('user-a')).toEqual([]);
    mocks.events.mockResolvedValue([terminal]); mocks.readable.mockResolvedValue([]); mocks.model.mockClear();
    expect(await checkPersistedRuntimeCognitionOutput('user-a', task.taskId)).toMatchObject({ modelCompleted: false });
    expect(mocks.model).not.toHaveBeenCalled();
  });
});
