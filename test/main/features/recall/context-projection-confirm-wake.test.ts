import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-recall-projection-confirm-wake-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function modules() {
  const [projection, storage, layout, promptInjection, refs, candidates] = await Promise.all([
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/features/recall/prompt-injection'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/candidate-service'),
  ]);
  return { projection, storage, layout, promptInjection, refs, candidates };
}

function projectionPath(userId: string, projectionId: string): string {
  return path.join(tmp, userId, 'cloud', 'recall', 'records', 'projections', `${projectionId}.json`);
}

function conversationMessagePath(userId: string, cid: string): string {
  return path.join(tmp, userId, 'cloud', 'chats', `${cid}.jsonl`);
}

async function createConfirmedProjection() {
  const created = await createPreviewProjection();
  const { projection } = await modules();
  return { ...created, confirmed: await projection.confirmContextProjection('user-a', created.preview.id) };
}

async function createPreviewProjection() {
  const { projection, refs, candidates } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: 'Keep decision logs for architecture changes.',
    summary: 'Use decision logs for architecture changes',
    suggestedType: 'rule',
    suggestedScope: 'review,project',
    sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
  });
  const asset = await candidates.promoteRecallCandidate('user-a', candidate.id);
  await refs.addWorkspaceAssetReference('user-a', { assetId: asset.asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection('user-a', {
    taskRunId: 'task-a', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Review OAuth callback flow',
  });
  return { asset, preview };
}

async function createPendingWakeRequest(label = 'Review callback') {
  const wake = await import('../../../../src/main/features/p3394/wake-service');
  const pending = await wake.evaluateWake('user-a', {
    conversationId: 'cid-a',
    agentId: 'agent-a',
    source: 'dispatch_to',
    sourceActorId: 'commander',
    objective: label,
    dispatchPayload: { text: label },
  });
  return { wake, pending };
}

describe('Recall context projection status and confirmation boundaries', () => {
  it('rejects malformed stored statuses and lists only valid projection states', async () => {
    const { projection, storage } = await modules();
    const file = projectionPath('user-a', 'proj-bad');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await storage.writeJson(file, {
      schemaVersion: 2,
      ownerId: 'user-a',
      id: 'proj-bad',
      taskRunId: 'task-a',
      purpose: 'review',
      authorization: 'user_confirmed',
      assetIds: [],
      sourceRefs: [],
      omittedRefs: [],
      status: 'bogus',
      createdAt: new Date().toISOString(),
    });

    await expect(projection.readContextProjection('user-a', 'proj-bad')).rejects.toThrow(/malformed context projection/i);
    await expect(projection.listContextProjections('user-a', { includeExpired: true })).resolves.toEqual([]);
  });

  it('keeps deferred and rejected projections out of confirmed prompt injection', async () => {
    const { projection, promptInjection, layout, storage } = await modules();
    const { confirmed } = await createConfirmedProjection();
    const deferred = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-b', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Deferred review task',
    });
    const deferredProjection = await projection.deferContextProjection('user-a', deferred.id, 'later');
    const rejected = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-c', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Rejected review task',
    });
    const rejectedProjection = await projection.rejectContextProjection('user-a', rejected.id, 'not now');
    const messageFile = conversationMessagePath('user-a', 'cid-a');
    await fs.mkdir(path.dirname(messageFile), { recursive: true });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-a', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'confirmed',
      recall_projection_card: { projectionId: confirmed.id },
    });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-b', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'deferred',
      recall_projection_card: { projectionId: deferredProjection.id },
    });
    await storage.appendJsonlAtomic(messageFile, {
      id: 'msg-c', ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'rejected',
      recall_projection_card: { projectionId: rejectedProjection.id },
    });

    const block = await promptInjection.buildConfirmedProjectionPromptBlock('user-a', 'cid-a');
    expect(block).toContain(confirmed.id);
    expect(block).not.toContain(deferredProjection.id);
    expect(block).not.toContain(rejectedProjection.id);
    expect(block).not.toContain('later');
  });

  it('rejects confirm attempts after a projection has been deferred or rejected', async () => {
    const { projection } = await modules();
    const { confirmed } = await createConfirmedProjection();
    const deferred = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-d', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Deferred confirmation task',
    });
    const deferredProjection = await projection.deferContextProjection('user-a', deferred.id, 'later');
    const rejected = await projection.previewContextProjection('user-a', {
      taskRunId: 'task-e', workspaceId: 'workspace-a', purpose: 'review', taskText: 'Rejected confirmation task',
    });
    const rejectedProjection = await projection.rejectContextProjection('user-a', rejected.id, 'no');

    await expect(projection.confirmContextProjection('user-a', deferredProjection.id)).rejects.toThrow(/not confirmable/i);
    await expect(projection.confirmContextProjection('user-a', rejectedProjection.id)).rejects.toThrow(/not confirmable/i);
  });

  it('confirms a projection and stores the binding snapshot when wake approval succeeds', async () => {
    const { projection } = await modules();
    const { wake, pending } = await createPendingWakeRequest('Confirm callback review');
    const result = await projection.confirmAndApproveWake('user-a', {
      cid: 'cid-a',
      projectionId: (await createPreviewProjection()).preview.id,
      wakeRequestId: pending.request.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.status).toBe('approved');
    expect(result.request.asset_confirmation_snapshot).toMatchObject({
      projection_id: result.projection.id,
      wake_request_id: pending.request.id,
      projection_status: 'confirmed',
      conversation_id: 'cid-a',
      task_run_id: result.projection.taskRunId,
    });
    expect(result.approval.asset_confirmation_snapshot).toMatchObject({
      projection_id: result.projection.id,
      wake_request_id: pending.request.id,
    });
    expect((await wake.getWakeRequest('user-a', pending.request.id))?.asset_confirmation_snapshot).toMatchObject({
      projection_id: result.projection.id,
    });
  });

  it('binds approved wake requests back to the KSTAR requirement lifecycle', async () => {
    const { projection } = await modules();
    const { wake, pending } = await createPendingWakeRequest('Lifecycle callback review');
    const { preview } = await createPreviewProjection();
    const store = await import('../../../../src/main/features/kstar/requirement-store');
    const lifecycle = await import('../../../../src/main/features/kstar/lifecycle-adapter');
    const kstarState = await import('../../../../src/main/features/kstar/requirement-state');
    const task = store.createKstarTaskRecord('user-a', { conversationId: 'cid-a', workspaceId: 'workspace-a', title: 'Lifecycle callback review' });
    const requirement = store.createKstarRequirementRecord('user-a', {
      taskId: task.id,
      conversationId: 'cid-a',
      userMessageIds: ['msg-a'],
      title: 'Lifecycle callback review',
      goalText: 'Review callback lifecycle binding',
    });
    await store.replaceKstarTask('user-a', { ...task, requirementIds: [requirement.id], currentRequirementId: requirement.id });
    await store.replaceKstarRequirement('user-a', { ...requirement, projectionId: preview.id });
    const state = store.createInitialConversationTaskState('user-a', 'cid-a');
    await store.writeConversationTaskState('user-a', { ...state, currentTaskId: task.id, currentRequirementId: requirement.id });

    const result = await projection.confirmAndApproveWake('user-a', {
      cid: 'cid-a',
      projectionId: preview.id,
      wakeRequestId: pending.request.id,
    });

    expect(result.ok).toBe(true);
    await expect(store.readKstarRequirement('user-a', requirement.id)).resolves.not.toMatchObject({ wakeRequestId: pending.request.id });
    await kstarState.bindKstarRequirementWakeRequest('user-a', {
      conversationId: 'cid-a', projectionId: preview.id, wakeRequestId: pending.request.id,
    });
    await wake.markWakeRequestExecuted('user-a', pending.request.id);
    await expect(lifecycle.readKstarTaskLifecycle('user-a', 'cid-a')).resolves.toMatchObject({
      status: 'executing',
      requirement: { id: requirement.id, projectionId: preview.id, wakeRequestId: pending.request.id },
      projection: { id: preview.id, status: 'confirmed' },
      wakeRequest: { id: pending.request.id, status: 'executed' },
      assetConfirmationSnapshot: { projection_id: preview.id, wake_request_id: pending.request.id },
    });
  });

  it('keeps the confirmed projection when wake approval cannot be bound', async () => {
    const { projection } = await modules();
    const { wake, pending } = await createPendingWakeRequest('Unbound callback review');
    const badRequestId = `${pending.request.id}-missing`;
    const result = await projection.confirmAndApproveWake('user-a', {
      cid: 'cid-a',
      projectionId: (await createPreviewProjection()).preview.id,
      wakeRequestId: badRequestId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('wake_unbound');
    expect(result.projection.status).toBe('confirmed');
    expect(result.error).toMatch(/wake request not found/i);
    expect(await wake.getWakeRequest('user-a', pending.request.id)).toMatchObject({ status: 'pending' });
  });

  it('fails fast when the bound asset version changes before confirmation', async () => {
    const { projection } = await modules();
    const { preview } = await createPreviewProjection();
    const asset = preview.assetIds[0];
    const wake = await import('../../../../src/main/features/p3394/wake-service');
    const pending = await wake.evaluateWake('user-a', {
      conversationId: 'cid-a',
      agentId: 'agent-a',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: 'Version change review',
      dispatchPayload: { text: 'Version change review' },
    });
    const recallAssets = await import('../../../../src/main/features/recall/asset-service');
    await recallAssets.updateAbilityAsset('user-a', asset, { title: 'Keep decision logs and revisions.' });

    await expect(projection.confirmAndApproveWake('user-a', {
      cid: 'cid-a',
      projectionId: preview.id,
      wakeRequestId: pending.request.id,
    })).rejects.toThrow(/version changed|no longer active/i);
  });

  it('approves a wake request from a projection the user already confirmed on the card', async () => {
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const wake = await import('../../../../src/main/features/p3394/wake-service');
    const { preview } = await createPreviewProjection();
    const confirmed = await projection.confirmContextProjection('user-a', preview.id);
    const pending = await wake.evaluateWake('user-a', {
      conversationId: 'cid-a',
      agentId: 'agent-a',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: 'Use confirmed assets',
      dispatchPayload: { text: 'Use confirmed assets' },
    });
    expect(pending.approved).toBe(false);
    if (pending.approved) return;

    const result = await projection.confirmAndApproveWake('user-a', {
      cid: 'cid-a',
      projectionId: confirmed.id,
      wakeRequestId: pending.request.id,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'approved',
      projection: { id: confirmed.id, status: 'confirmed' },
      request: { id: pending.request.id, asset_confirmation_snapshot: { projection_id: confirmed.id } },
    });
  });

});
