import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER = 'mate-recall-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-recall-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CogSeed Recall execution bridge', () => {
  it('records terminal CogSeed task facts into execution records without prompts or task mutation', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const bridge = await import('../../../../src/main/features/cogseed_backend/recall-bridge');
    const executionRecords = await import('../../../../src/main/features/cogseed_backend/mate-execution-store');

    const created = (await tasks.createMateTask(USER, {
      requestId: 'req-recall',
      task: 'SECRET prompt text must not be copied to execution records',
    })).task;
    await lifecycle.transitionMateTask(USER, created.taskId, 'queued');
    await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    await lifecycle.transitionMateTask(USER, created.taskId, 'completed', { outputChars: 9 });

    const latestTask = await tasks.readMateTask(USER, created.taskId);
    const fact = await bridge.recordMateTaskRunForRecall(USER, created.taskId);
    const record = await executionRecords.read(USER, fact.executionId);
    const events = await executionRecords.readEvents(USER, fact.executionId);

    expect(latestTask).toEqual(await tasks.readMateTask(USER, created.taskId));
    expect(fact).toMatchObject({ taskId: created.taskId, sessionId: created.sessionId, status: 'completed' });
    expect(record).toMatchObject({
      executionId: fact.executionId,
      kind: 'mate-agent',
      sessionId: created.sessionId,
      status: 'completed',
      boundary: 'real',
    });
    expect(JSON.stringify(record)).not.toContain('SECRET prompt text');
    expect(JSON.stringify(events)).not.toContain('SECRET prompt text');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'mate.task', payload: expect.objectContaining({ taskId: created.taskId, runtimeSessionId: created.runtimeSessionId }) }),
      expect.objectContaining({ type: 'terminal', payload: expect.objectContaining({ status: 'completed' }) }),
    ]));
  });

  it('uses a confirmed projection to create a recall transfer proof and is idempotent on repeat bridge calls', async () => {
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const lifecycle = await import('../../../../src/main/features/cogseed_backend/lifecycle');
    const bridge = await import('../../../../src/main/features/cogseed_backend/recall-bridge');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const refs = await import('../../../../src/main/features/recall/workspace-refs');
    const projection = await import('../../../../src/main/features/recall/context-projection');
    const proofs = await import('../../../../src/main/features/recall/proof-service');

    const candidate = await candidates.saveRecallCandidate(USER, {
      judgment: 'Bring confirmed Mate task evidence into Recall.',
      suggestedType: 'rule',
      suggestedScope: 'review',
      sourceRefs: [{ kind: 'execution', id: 'exec-a' }],
    });
    const { asset } = await candidates.promoteRecallCandidate(USER, candidate.id, { actor: 'user' });
    await refs.addWorkspaceAssetReference(USER, { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
    const created = (await tasks.createMateTask(USER, { requestId: 'req-provenance', task: 'Use confirmed projection.' })).task;
    const preview = await projection.previewContextProjection(USER, { taskRunId: created.taskId, workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed' });
    const confirmed = await projection.confirmContextProjection(USER, preview.id);
    await lifecycle.transitionMateTask(USER, created.taskId, 'queued');
    await lifecycle.transitionMateTask(USER, created.taskId, 'running');
    await lifecycle.transitionMateTask(USER, created.taskId, 'completed', { outputChars: 7 });
    await tasks.updateMateTask(USER, created.taskId, (current) => ({ ...current, executionId: 'mate-exec-provenance' }));
    await tasks.updateMateTask(USER, created.taskId, (current) => ({ ...current, terminalAt: current.terminalAt || new Date().toISOString() }));

    const first = await bridge.recordMateTaskRunForRecall(USER, created.taskId);
    const second = await bridge.recordMateTaskRunForRecall(USER, created.taskId);
    const transferProofs = await proofs.listTransferProofs(USER);

    expect(first).toMatchObject({ taskId: created.taskId, status: 'completed' });
    expect(second).toEqual(first);
    expect(transferProofs).toEqual([expect.objectContaining({ projectionId: confirmed.id, executionId: first.executionId, status: 'succeeded' })]);
  });
});
