import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;
beforeEach(() => {
  vi.resetModules();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-recall-terminal-proof-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmp;
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function modules() {
  const [candidates, refs, projection, terminalProof, storage, layout, proofs, assets] = await Promise.all([
    import('../../../../src/main/features/recall/candidate-service'),
    import('../../../../src/main/features/recall/workspace-refs'),
    import('../../../../src/main/features/recall/context-projection'),
    import('../../../../src/main/features/recall/terminal-proof'),
    import('../../../../src/main/storage'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/features/recall/proof-service'),
    import('../../../../src/main/features/recall/asset-service'),
  ]);
  return { candidates, refs, projection, terminalProof, storage, layout, proofs, assets };
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

async function confirmedProjection(taskRunId: string) {
  const { candidates, refs, projection } = await modules();
  const candidate = await candidates.saveRecallCandidate('user-a', {
    judgment: 'Use confirmed evidence in task reviews.',
    summary: 'Use confirmed evidence',
    suggestedType: 'rule',
    suggestedScope: 'review',
    sourceRefs: [{ kind: 'execution', id: `exec-${taskRunId}` }],
  });
  const { asset } = await candidates.promoteRecallCandidate('user-a', candidate.id, { actor: 'user' });
  await refs.addWorkspaceAssetReference('user-a', { assetId: asset.id, workspaceId: 'workspace-a', scope: 'review' });
  const preview = await projection.previewContextProjection('user-a', {
    taskRunId, workspaceId: 'workspace-a', purpose: 'review', authorization: 'user_confirmed',
  });
  return { asset, projection: await projection.confirmContextProjection('user-a', preview.id) };
}

async function attachCard(cid: string, projectionId: string) {
  const { storage, layout } = await modules();
  const file = layout.conversationMessageFile('user-a', cid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await storage.appendJsonlAtomic(file, {
    id: `msg-${projectionId}`, ts: new Date().toISOString(), from: 'commander', to: ['user'], text: 'preview',
    recall_projection_card: { projectionId },
  });
}

describe('Recall terminal transfer proof handler', () => {
  it('completes one transfer proof for a completed task and is idempotent on duplicate terminal events', async () => {
    const { projection } = await confirmedProjection('run-a');
    const { terminalProof, proofs, assets } = await modules();
    const event = { run_id: 'run-a', user_id: 'user-a', conversation_id: 'cid-a', status: 'completed' as const, projection_id: projection.id, started_at_ms: 1, finished_at_ms: 2 };

    const first = await terminalProof.handleRecallTaskTerminal(event);
    const second = await terminalProof.handleRecallTaskTerminal(event);

    expect(first).toMatchObject({ handled: true, proof: { projectionId: projection.id, executionId: 'run-a', status: 'succeeded' } });
    expect(second).toMatchObject({ handled: true, proof: { id: first.proof?.id, status: 'succeeded' } });
    expect((await proofs.listTransferProofs('user-a'))).toHaveLength(1);
    expect((await assets.listAbilityAssets('user-a'))[0].maturity).toBe('transfer_validated');
  });


  it('completes a Mate-shaped terminal event through the shared notification source', async () => {
    const { projection } = await confirmedProjection('mate-run-a');
    await attachCard('mate-cid-a', projection.id);
    const { proofs } = await modules();
    const source = await import('../../../../src/main/features/task_notification_terminal_source');
    const bridge = await import('../../../../src/main/features/group_chat/recall-terminal-proof');
    const stop = bridge.startGroupChatRecallTerminalProofs();
    try {
      source.publishTaskNotificationTerminal({
        run_id: 'mate-run-a',
        user_id: 'user-a',
        conversation_id: 'mate-cid-a',
        status: 'completed',
        started_at_ms: 10,
        finished_at_ms: 20,
      });

      await eventually(async () => {
        await expect(proofs.listTransferProofs('user-a')).resolves.toEqual([
          expect.objectContaining({ projectionId: projection.id, executionId: 'mate-run-a', status: 'succeeded' }),
        ]);
      });
    } finally {
      stop();
    }
  });
  it('uses explicit Mate projection and attempt metadata without requiring a projection card message', async () => {
    const { projection } = await confirmedProjection('logical-run-a');
    const { terminalProof, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'logical-run-a',
      user_id: 'user-a',
      conversation_id: 'mate-cid-a',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
      projection_id: projection.id,
      logical_run_id: 'logical-run-a',
      execution_id: 'mate-attempt-a',
    });

    expect(result).toMatchObject({ handled: true, proof: { projectionId: projection.id, executionId: 'mate-attempt-a', status: 'succeeded' } });
    expect(await proofs.listTransferProofs('user-a')).toEqual([
      expect.objectContaining({ projectionId: projection.id, executionId: 'mate-attempt-a' }),
    ]);
  });

  it('persists a wake request id when terminal proof is attached to a confirmed projection', async () => {
    const { projection } = await confirmedProjection('run-wake-binding');
    const { terminalProof, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-wake-binding',
      user_id: 'user-a',
      conversation_id: 'cid-wake-binding',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
      projection_id: projection.id,
      wake_request_id: 'wake-a',
    });

    expect(result).toMatchObject({ handled: true, proof: { projectionId: projection.id, wakeRequestId: 'wake-a' } });
    expect(await proofs.listTransferProofs('user-a')).toEqual([
      expect.objectContaining({ projectionId: projection.id, wakeRequestId: 'wake-a' }),
    ]);
  });

  it('ignores explicit Mate proof metadata when the logical run does not match the projection', async () => {
    const { projection } = await confirmedProjection('logical-run-b');
    const { terminalProof, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'wrong-run',
      user_id: 'user-a',
      conversation_id: 'mate-cid-b',
      status: 'completed',
      started_at_ms: 1,
      finished_at_ms: 2,
      projection_id: projection.id,
      logical_run_id: 'wrong-run',
      execution_id: 'mate-attempt-b',
    });

    expect(result).toEqual({ handled: false, reason: 'no_confirmed_projection' });
    expect(await proofs.listTransferProofs('user-a')).toEqual([]);
  });

  it('records a rejected transfer without advancing maturity when the task fails', async () => {
    const { projection, asset } = await confirmedProjection('run-failed');
    const { terminalProof, assets, proofs } = await modules();

    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-failed', user_id: 'user-a', conversation_id: 'cid-failed', status: 'failed', projection_id: projection.id, started_at_ms: 1, finished_at_ms: 2,
    });

    expect(result).toMatchObject({ handled: true, proof: { status: 'rejected', executionId: 'run-failed' } });
    expect((await assets.readAbilityAsset('user-a', asset.id)).maturity).toBe('seed');
    expect((await proofs.listTransferProofs('user-a'))[0].status).toBe('rejected');
  });

  it('ignores terminal events with no confirmed projection card', async () => {
    const { terminalProof, proofs } = await modules();
    const result = await terminalProof.handleRecallTaskTerminal({
      run_id: 'run-none', user_id: 'user-a', conversation_id: 'cid-none', status: 'completed', started_at_ms: 1, finished_at_ms: 2,
    });
    expect(result).toEqual({ handled: false, reason: 'no_confirmed_projection' });
    expect(await proofs.listTransferProofs('user-a')).toEqual([]);
  });

});
