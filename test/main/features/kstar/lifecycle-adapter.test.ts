import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-lifecycle-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedRequirement(input: {
  conversationId?: string;
  taskStatus?: 'open' | 'closing' | 'closed' | 'abandoned';
  requirementStatus?: 'open' | 'waiting_review' | 'closed' | 'abandoned';
  projectionId?: string;
  wakeRequestId?: string;
} = {}) {
  const store = await import('../../../../src/main/features/kstar/requirement-store');
  const conversationId = input.conversationId || 'cid-life';
  const task = store.createKstarTaskRecord('life-user', { conversationId, title: 'Lifecycle task' });
  const requirement = store.createKstarRequirementRecord('life-user', {
    taskId: task.id,
    conversationId,
    userMessageIds: ['msg-life'],
    title: 'Lifecycle requirement',
    goalText: 'Exercise lifecycle states',
  });
  await store.replaceKstarTask('life-user', {
    ...task,
    status: input.taskStatus || 'open',
    requirementIds: [requirement.id],
    currentRequirementId: requirement.id,
  });
  await store.replaceKstarRequirement('life-user', {
    ...requirement,
    status: input.requirementStatus || 'open',
    ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    ...(input.wakeRequestId ? { wakeRequestId: input.wakeRequestId } : {}),
  });
  const state = store.createInitialConversationTaskState('life-user', conversationId);
  await store.writeConversationTaskState('life-user', { ...state, currentTaskId: task.id, currentRequirementId: requirement.id });
  return { store, task, requirement, conversationId };
}

async function previewProjection(taskRunId: string) {
  const projection = await import('../../../../src/main/features/recall/context-projection');
  return projection.previewContextProjection('life-user', { taskRunId, purpose: 'Lifecycle task', taskText: 'Exercise lifecycle states' });
}

async function pendingWake(conversationId: string) {
  const wake = await import('../../../../src/main/features/p3394/wake-service');
  const pending = await wake.evaluateWake('life-user', {
    conversationId,
    agentId: 'agent-life',
    source: 'dispatch_to',
    sourceActorId: 'commander',
    objective: 'Lifecycle task',
    dispatchPayload: { text: 'Lifecycle task' },
  });
  return { wake, pending };
}

describe('KSTAR lifecycle adapter', () => {
  it('returns none when no task state exists', async () => {
    const lifecycle = await import('../../../../src/main/features/kstar/lifecycle-adapter');
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-missing')).resolves.toMatchObject({ status: 'none', state: null });
  });

  it('maps draft, review, closed, and cancelled states from umbrella task records', async () => {
    const lifecycle = await import('../../../../src/main/features/kstar/lifecycle-adapter');
    await seedRequirement({ conversationId: 'cid-draft' });
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-draft')).resolves.toMatchObject({ status: 'draft' });

    await seedRequirement({ conversationId: 'cid-review', taskStatus: 'closing', requirementStatus: 'waiting_review' });
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-review')).resolves.toMatchObject({ status: 'awaiting_user_satisfaction' });

    await seedRequirement({ conversationId: 'cid-closed', taskStatus: 'closed', requirementStatus: 'closed' });
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-closed')).resolves.toMatchObject({ status: 'closed' });

    await seedRequirement({ conversationId: 'cid-cancelled', taskStatus: 'abandoned', requirementStatus: 'abandoned' });
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-cancelled')).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('maps preload preview, confirmed assets, and executing through projection and wake records', async () => {
    const lifecycle = await import('../../../../src/main/features/kstar/lifecycle-adapter');
    const preview = await previewProjection('task-life');
    await seedRequirement({ projectionId: preview.id });
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-life')).resolves.toMatchObject({
      status: 'preload_preview',
      projection: { id: preview.id, status: 'preview' },
    });

    const projection = await import('../../../../src/main/features/recall/context-projection');
    const kstarState = await import('../../../../src/main/features/kstar/requirement-state');
    const { wake, pending } = await pendingWake('cid-life');
    const approved = await projection.confirmAndApproveWake('life-user', { cid: 'cid-life', projectionId: preview.id, wakeRequestId: pending.request.id });
    expect(approved.ok).toBe(true);
    await kstarState.bindKstarRequirementWakeRequest('life-user', {
      conversationId: 'cid-life', projectionId: preview.id, wakeRequestId: pending.request.id,
    });
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-life')).resolves.toMatchObject({
      status: 'authorized',
      requirement: { projectionId: preview.id, wakeRequestId: pending.request.id },
      projection: { id: preview.id, status: 'confirmed' },
      wakeRequest: { id: pending.request.id, status: 'approved' },
    });

    await wake.markWakeRequestExecuted('life-user', pending.request.id);
    await expect(lifecycle.readKstarTaskLifecycle('life-user', 'cid-life')).resolves.toMatchObject({
      status: 'executing',
      wakeRequest: { id: pending.request.id, status: 'executed' },
      assetConfirmationSnapshot: { projection_id: preview.id, wake_request_id: pending.request.id },
    });
  });
});
