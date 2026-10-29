import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ model: vi.fn(), readable: vi.fn(), control: vi.fn(), conversation: vi.fn(), proofs: vi.fn(), transfers: vi.fn(), claim: vi.fn(), head: vi.fn(), snapshot: vi.fn(), page: vi.fn() }));
vi.mock('../../../../src/main/features/chats', () => ({ getConversation: mocks.conversation, getMessagesPage: mocks.page }));
vi.mock('../../../../src/main/features/group_chat', () => ({ _readSubmitClaim: mocks.claim }));
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: mocks.model }));
vi.mock('../../../../src/main/features/recall/prompt-injection', () => ({ filterRecallAssetsForAgentRead: mocks.readable }));
vi.mock('../../../../src/main/features/recall/source-control', () => ({ readCognitionSourceControl: mocks.control }));
vi.mock('../../../../src/main/features/recall/asset-service', () => ({
  readAbilityAsset: mocks.head, readAbilityAssetVersionSnapshot: mocks.snapshot,
}));
vi.mock('../../../../src/main/features/recall/context-projection', () => ({ readContextProjection: async () => ({ conversationId: 'cid-a', taskRunId: 'task-a' }) }));
vi.mock('../../../../src/main/features/recall/proof-service', () => ({ listTransferProofs: mocks.transfers, listEffectivenessProofs: mocks.proofs }));
let root: string, previous: string | undefined;
const text = 'The result includes the verified evidence.';
const task = 'Review this result and include evidence.';
const claim = { assetId: 'aa-rule', assetVersion: '1', outputExcerpt: text };
const source = { kind: 'group_execution' as const, executionId: 'turn-turn-a', conversationId: 'cid-a', actorId: 'worker-a' };
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-dispatched-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  mocks.head.mockResolvedValue({ id: 'aa-rule', ownerId: 'user-a', status: 'active', scope: 'general', version: '1', evidenceRefs: [] });
  mocks.snapshot.mockResolvedValue({ type: 'cognition', statement: 'Include evidence in the result.', applicableWhen: [], forbiddenWhen: [], evidenceRefs: [] });
  mocks.conversation.mockResolvedValue({ conversation_id: 'cid-a' });
  mocks.readable.mockImplementation(async (_user, assets) => assets);
  mocks.control.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue({ state: 'accepted', run_id: 'run-a', message_id: 'source-a' });
  mocks.model.mockResolvedValue({ result: { text: JSON.stringify({ checks: [{ assetId: 'aa-rule', version: '1', status: 'complied', outputEvidence: { quote: text } }] }), meta: {} } });
});
afterEach(async () => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  await fs.rm(root, { recursive: true, force: true });
});
async function setup(worker = true, binding = true, produced: string[] = [], scope: { agentId?: string; fileKinds?: string[] } = {}) {
  const exec = await import('../../../../src/main/features/execution-records');
  const result = await import('../../../../src/main/features/recall/execution-result-content');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const file = conversationMessageFile('user-a', 'cid-a');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await appendJsonlAtomic(file, { id: 'source-a', from: 'user', text: task, run_id: 'run-a', action_request_id: 'action-a' });
  await exec.create('user-a', { executionId: source.executionId, kind: 'core-agent', sessionId: 'session-a', conversationId: 'cid-a',
    agentId: source.actorId, boundary: 'real', permissionMode: 'read-only', ...(worker ? { bindResultOutput: true } : { bindResultMessage: true }) });
  await exec.complete('user-a', source.executionId, { status: 'completed', output: text });
  if (worker) await result.bindExecutionResultOutput('user-a', source.executionId, 'cid-a', source.actorId, text, produced);
  else {
    const message = { id: 'reply-a', from: source.actorId, text, turn_id: 'turn-a', turn_end: true, run_id: 'run-a' };
    await appendJsonlAtomic(file, message);
    await result.bindExecutionResultMessage('user-a', source.executionId, 'cid-a', message);
  }
  const { recordInjectionReceipt } = await import('../../../../src/main/features/recall/injection-receipt');
  await recordInjectionReceipt('user-a', { assetId: 'aa-rule', assetVersion: '1', taskRunId: 'turn-a',
    messageId: worker ? result.executionResultAnchor(source.executionId) : 'reply-a', status: 'dispatched', channel: 'projection', boundary: 'real',
    ...(binding ? { dispatchBinding: { executionId: source.executionId, conversationId: 'cid-a', actorId: source.actorId, runId: 'run-a', sourceMessageId: 'source-a', scope } } : {}) });
  return file;
}
it.each([false, true])('binds dispatched self-report and independent output check once (worker=%s)', async worker => {
  const file = await setup(worker);
  const claims = await import('../../../../src/main/features/recall/asset-usage-claim');
  const checks = await import('../../../../src/main/features/recall/cognition-output-check');
  const usage = await import('../../../../src/main/features/recall/asset-usage-receipt');
  const finalize = () => worker ? claims.finalizeExecutionAssetUsageClaims('user-a', source, [claim], task)
    : claims.finalizeAssetUsageClaims('user-a', { cid: 'cid-a', taskRunId: 'turn-a', messageId: 'reply-a', claims: [claim], taskText: task });
  expect(await finalize()).toEqual([expect.objectContaining({ status: 'applied', projectionId: 'dispatch-turn' })]);
  const checked = worker ? await checks.checkPersistedExecutionCognitionOutput('user-a', source, task)
    : await checks.checkPersistedCognitionOutput('user-a', { cid: 'cid-a', taskRunId: 'turn-a', messageId: 'reply-a', taskText: task });
  expect(checked).toMatchObject({ modelCompleted: true, checks: [{ status: 'complied' }] });
  await finalize();
  expect(await usage.listAssetUsageReceipts('user-a')).toHaveLength(1);
  expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(worker ? 1 : 2);
  if (worker) expect(checked?.resultSource).toEqual(source);
});
it('keeps historical unbound dispatch out of adoption and checking', async () => {
  await setup(true, false);
  const claims = await import('../../../../src/main/features/recall/asset-usage-claim');
  const checks = await import('../../../../src/main/features/recall/cognition-output-check');
  expect(await claims.finalizeExecutionAssetUsageClaims('user-a', source, [claim], task)).toEqual([]);
  expect(await checks.checkPersistedExecutionCognitionOutput('user-a', source, task)).toBeUndefined();
  expect(mocks.model).not.toHaveBeenCalled();
});
it('rejects actor mismatch, changed scope, and revoked asset sources', async () => {
  await setup();
  const claims = await import('../../../../src/main/features/recall/asset-usage-claim');
  await expect(claims.finalizeExecutionAssetUsageClaims('user-a', { ...source, actorId: 'other-actor' }, [claim], task)).rejects.toThrow('not bound');
  mocks.conversation.mockResolvedValue({ conversation_id: 'cid-a', project_id: 'another-project' });
  expect(await claims.finalizeExecutionAssetUsageClaims('user-a', source, [claim], task)).toEqual([]);
  mocks.conversation.mockResolvedValue({ conversation_id: 'cid-a' }); mocks.readable.mockResolvedValue([]);
  expect(await claims.finalizeExecutionAssetUsageClaims('user-a', source, [claim], task)).toEqual([]);
});
it('recovers worker feedback into the next night with real submission and immutable result context', async () => {
  await setup();
  const store = await import('../../../../src/main/features/recall/store');
  const proof = { id: 'effect-a', transferProofId: 'transfer-a', createdAt: new Date().toISOString(), nightlyFeedback: { status: 'pending', feedback: 'negative' } };
  mocks.proofs.mockResolvedValue([proof]);
  mocks.transfers.mockResolvedValue([{ id: 'transfer-a', projectionId: 'projection-a', receiptExecutionId: source.executionId,
    assetVersions: [{ assetId: 'aa-rule', version: '1' }] }]);
  await store.updateRecallJsonRecord('user-a', 'effectiveness-proofs', proof.id, () => ({ schemaVersion: 1, ownerId: 'user-a', ...proof }));
  const feedback = await import('../../../../src/main/features/recall/effectiveness-feedback');
  const nightly = await import('../../../../src/main/features/recall/nightly-feedback');
  const enqueue = vi.spyOn(nightly, 'queueNightlyFeedback').mockRejectedValueOnce(new Error('transient write failure'));
  await feedback.recoverNightlyEffectivenessFeedback('user-a');
  expect(proof.nightlyFeedback.status).toBe('pending');
  await feedback.recoverNightlyEffectivenessFeedback('user-a');
  await feedback.recoverNightlyEffectivenessFeedback('user-a');
  expect(enqueue).toHaveBeenCalledTimes(2);
  const rows = await nightly.queuedNightlyFeedback('user-a');
  expect(rows).toEqual([expect.objectContaining({ messageId: 'source-a', resultSource: source })]);
  const contexts = await import('../../../../src/main/features/recall/feedback-version-context');
  const observed = await contexts.readFeedbackVersionContext('user-a', 'cid-a', rows.map(nightly.feedbackObservation));
  expect(observed[0].resultContext).toMatchObject({ status: 'available', text, sourceRefs: [{ kind: 'execution_evaluation', id: source.executionId }] });
  await expect(contexts.assertFeedbackResultContextsCurrent('user-a', 'cid-a', observed)).resolves.toBeUndefined();
  mocks.control.mockResolvedValue({ availability: 'paused' });
  await expect(contexts.assertFeedbackResultContextsCurrent('user-a', 'cid-a', observed)).rejects.toThrow('source unavailable');
  expect(mocks.model).not.toHaveBeenCalled();
});

it('refuses worker feedback after a produced file changes or its original submission disappears', async () => {
  const { setWorkspacePath } = await import('../../../../src/main/features/user_workspace');
  setWorkspacePath('user-a', root);
  const produced = path.join(root, 'result.md');
  await fs.writeFile(produced, 'Original produced evidence.');
  await setup(true, true, [produced]);
  const contexts = await import('../../../../src/main/features/recall/feedback-version-context');
  const observation = { messageId: 'source-a', assetId: 'aa-rule', assetVersion: '1', resultSource: source };
  expect(await contexts.readFeedbackResultContext('user-a', 'cid-a', observation)).toMatchObject({ status: 'available', coverage: { totalFiles: 1 } });
  await fs.writeFile(produced, 'Changed produced evidence.');
  await expect(contexts.readFeedbackResultContext('user-a', 'cid-a', observation)).rejects.toThrow('changed or incomplete');
  await fs.writeFile(produced, 'Original produced evidence.');
  mocks.claim.mockResolvedValue(undefined);
  await expect(contexts.readFeedbackResultContext('user-a', 'cid-a', observation)).rejects.toThrow('submitted message unavailable');
});

it('counts a dispatched version once when the worker also reads it', async () => {
  const { recordInjectionReceipt } = await import('../../../../src/main/features/recall/injection-receipt');
  await recordInjectionReceipt('user-a', { taskRunId: 'turn-a', assetId: 'aa-rule', assetVersion: '1', status: 'injected', channel: 'agent_read', boundary: 'real' });
  await setup();
  const { finalizeExecutionAssetUsageClaims } = await import('../../../../src/main/features/recall/asset-usage-claim');
  await finalizeExecutionAssetUsageClaims('user-a', source, [claim], task);
  const { checkPersistedExecutionCognitionOutput } = await import('../../../../src/main/features/recall/cognition-output-check');
  await checkPersistedExecutionCognitionOutput('user-a', source, task);
  expect(await (await import('../../../../src/main/features/recall/asset-usage-receipt')).listAssetUsageReceipts('user-a')).toEqual([
    expect.objectContaining({ projectionId: 'dispatch-turn', status: 'applied' }),
  ]);
});

it('reuses verified dispatch scope and original request when checking constrained feedback assets', async () => {
  await setup(true, true, [], { agentId: source.actorId, fileKinds: ['text'] });
  mocks.readable.mockImplementation(async (_user, assets, context) => context.agentId === source.actorId
    && context.fileKinds?.includes('text') && context.taskText === task ? assets : []);
  const { readFeedbackVersionContext } = await import('../../../../src/main/features/recall/feedback-version-context');
  const input = [{ id: 'nf-scope', messageId: 'source-a', assetId: 'aa-rule', assetVersion: '1', taskRunId: 'task-a',
    resultSource: source, feedback: 'negative' as const, updatedAt: new Date().toISOString() }];
  expect(await readFeedbackVersionContext('user-a', 'cid-a', input)).toEqual([expect.objectContaining({
    versionContext: expect.objectContaining({ status: 'current' }),
    resultContext: expect.objectContaining({ status: 'available', readContext: { agentId: source.actorId, fileKinds: ['text'], taskText: task } }),
  })]);
  mocks.conversation.mockResolvedValue({ conversation_id: 'cid-a', project_id: 'changed-project' });
  expect(await readFeedbackVersionContext('user-a', 'cid-a', input)).toEqual([expect.objectContaining({ resultContext: { status: 'unavailable' } })]);
});


it.each(['status', 'scope', 'head-evidence', 'evaluated-evidence', 'current-evidence'])('new-write rechecks feedback asset access after freezing: %s', async changed => {
  await setup();
  const contexts = await import('../../../../src/main/features/recall/feedback-version-context');
  const input = [{ id: 'nf-frozen', messageId: 'source-a', assetId: 'aa-rule', assetVersion: '1', taskRunId: 'task-a',
    resultSource: source, feedback: 'negative' as const, updatedAt: new Date().toISOString() }];
  const frozen = await contexts.readFeedbackVersionContext('user-a', 'cid-a', input);
  const head = { id: 'aa-rule', ownerId: 'user-a', status: changed === 'status' ? 'paused' : 'active', scope: 'general', version: '2',
    ...(changed === 'scope' ? { scopePolicy: { projectIds: ['another-project'] } } : {}),
    evidenceRefs: changed === 'head-evidence' ? [{ id: 'revoked-source' }] : [] };
  mocks.head.mockResolvedValue(head);
  mocks.snapshot.mockImplementation(async (_user, _id, version) => ({ type: 'cognition', statement: 'Include evidence in the result.',
    evidenceRefs: changed === 'evaluated-evidence' && version === '1' || changed === 'current-evidence' && version === '2'
      ? [{ id: 'revoked-source' }] : [] }));
  mocks.readable.mockImplementation(async (_user, assets, context) => assets.filter((asset: any) => asset.status === 'active'
    && (!asset.scopePolicy?.projectIds || asset.scopePolicy.projectIds.includes(context.projectId))
    && !asset.evidenceRefs?.some((ref: any) => ref.id === 'revoked-source')));
  await expect(contexts.assertFeedbackResultContextsCurrent('user-a', 'cid-a', frozen)).rejects.toThrow('feedback source unavailable');
  expect(mocks.model).not.toHaveBeenCalled();
});
it('new-write permits a readable current version advance without replacing evaluated feedback', async () => {
  await setup();
  const contexts = await import('../../../../src/main/features/recall/feedback-version-context');
  const input = [{ id: 'nf-frozen', messageId: 'source-a', assetId: 'aa-rule', assetVersion: '1', taskRunId: 'task-a',
    resultSource: source, feedback: 'negative' as const, updatedAt: new Date().toISOString() }];
  const frozen = await contexts.readFeedbackVersionContext('user-a', 'cid-a', input);
  mocks.head.mockResolvedValue({ id: 'aa-rule', ownerId: 'user-a', status: 'active', scope: 'general', version: '2', evidenceRefs: [] });
  mocks.snapshot.mockImplementation(async (_user, _id, version) => ({ type: 'cognition', statement: `Readable version ${version}.`, evidenceRefs: [] }));
  await expect(contexts.assertFeedbackResultContextsCurrent('user-a', 'cid-a', frozen)).resolves.toBeUndefined();
  expect((await contexts.readFeedbackVersionContext('user-a', 'cid-a', input))[0].versionContext).toMatchObject({
    status: 'historical', evaluated: { version: '1' }, current: { version: '2' },
  });
  expect(frozen[0].assetVersion).toBe('1');
});
it.each([true, false])('named feedback across midnight uses original submission only with a host binding (%s)', async bound => {
  const file = await setup(false, bound);
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const original = { id: 'source-a', from: 'user', text: task, run_id: 'run-a', action_request_id: 'action-a', ts: '2026-10-19T23:50:00+08:00' };
  const unrelated = { id: 'source-b', from: 'user', text: 'Unrelated second request.', run_id: 'run-b', action_request_id: 'action-b', ts: '2026-10-19T23:58:00+08:00' };
  const reply = { id: 'reply-a', from: source.actorId, text, turn_id: 'turn-a', turn_end: true, run_id: 'run-a', ts: '2026-10-20T00:10:00+08:00' };
  for (const message of [original, unrelated, reply]) await appendJsonlAtomic(file, message);
  mocks.page.mockResolvedValue({ history: [original, unrelated, reply], nextCursor: null });
  const store = await import('../../../../src/main/features/recall/store');
  const proof = { id: 'effect-named', transferProofId: 'transfer-a', createdAt: '2026-10-20T01:00:00+08:00', nightlyFeedback: { status: 'pending', feedback: 'negative' } };
  mocks.proofs.mockResolvedValue([proof]);
  mocks.transfers.mockResolvedValue([{ id: 'transfer-a', projectionId: 'projection-a', receiptExecutionId: source.executionId,
    assetVersions: [{ assetId: 'aa-rule', version: '1' }] }]);
  await store.updateRecallJsonRecord('user-a', 'effectiveness-proofs', proof.id, () => ({ schemaVersion: 1, ownerId: 'user-a', ...proof }));
  await (await import('../../../../src/main/features/recall/effectiveness-feedback')).recoverNightlyEffectivenessFeedback('user-a');
  const nightly = await import('../../../../src/main/features/recall/nightly-feedback');
  const rows = await nightly.queuedNightlyFeedback('user-a');
  expect(rows).toHaveLength(1);
  if (!bound) {
    expect(rows[0]).toMatchObject({ messageId: 'reply-a' });
    expect(rows[0].resultSource).toBeUndefined();
    return;
  }
  expect(rows[0]).toMatchObject({ messageId: 'source-a', resultSource: source });
  const contexts = await import('../../../../src/main/features/recall/feedback-version-context');
  const [observed] = await contexts.readFeedbackVersionContext('user-a', 'cid-a', rows.map(nightly.feedbackObservation));
  expect(observed.resultContext).toMatchObject({ status: 'available', text, readContext: { taskText: task },
    refs: [expect.objectContaining({ kind: 'message', id: 'reply-a' })],
    sourceRefs: expect.arrayContaining([expect.objectContaining({ kind: 'conversation', subtype: 'message', locator: { conversationId: 'cid-a', messageId: 'reply-a' } })]),
  });
  expect(JSON.stringify(observed)).not.toContain(unrelated.text);
  await expect(contexts.assertFeedbackResultContextsCurrent('user-a', 'cid-a', [observed])).resolves.toBeUndefined();
  const { cognitionMessageSourceId } = await import('../../../../src/main/features/recall/source-identity');
  mocks.control.mockImplementation(async (_user, ref) => ref.id === cognitionMessageSourceId('cid-a', 'reply-a') ? { availability: 'paused' } : undefined);
  await expect(contexts.assertFeedbackResultContextsCurrent('user-a', 'cid-a', [observed])).rejects.toThrow('feedback source unavailable');
  expect(mocks.model).not.toHaveBeenCalled();
});
