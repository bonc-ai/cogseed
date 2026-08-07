import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../../../../src/main/features/mate_agent_runtime/protocol';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-closure-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const request: RuntimeRunRequest = {
  protocol_version: 1, type: 'run', request_id: 'req-closure', runtime_session_id: 'mruntime-closure',
  user_id: 'closure-user', task: 'Create a report.', context: [], attachments: [],
};
const events: RuntimeEventEnvelope[] = [
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_call', id: 'a', name: 'read_file', arguments: { path: 'x' } } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_result', id: 'a', name: 'read_file', isError: false } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_call', id: 'b', name: 'write_file', arguments: { path: 'y', content: '...' } } },
  { type: 'event', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'running', metadata: { kernel_event: 'tool_result', id: 'b', name: 'write_file', isError: false } },
  { type: 'result', request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'completed', text: 'Report created.' },
];

describe('KSTAR task closure', () => {
  it('persists episode, review, extraction run, and pending candidate idempotently', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const first = await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-closure', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    const second = await closure.captureRuntimeKstarClosure({ userId: 'closure-user', runId: 'run-closure', request, events, createdAt: '2026-08-05T00:00:00.000Z' });

    expect(first.episode.id).toBe('kse-run-closure');
    expect(first.review.id).toBe('ksr-kse-run-closure');
    expect(first.extractionRun).toMatchObject({ status: 'created', candidateIds: [first.candidates[0].id] });
    expect(second.candidates.map((candidate) => candidate.id)).toEqual(first.candidates.map((candidate) => candidate.id));
    expect(first.candidates[0].status).toBe('pending');
    expect(fs.existsSync(path.join(tmpDir, 'closure-user', 'cloud', 'recall', 'records', 'ability-assets'))).toBe(false);
  });

  it('keeps episode and review when proposal bridging fails', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const failingBridge = async () => { throw new Error('recall unavailable'); };
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-failed-bridge', request, events, createdAt: '2026-08-05T00:00:00.000Z',
      bridge: failingBridge,
    });

    expect(result.episode.id).toBe('kse-run-failed-bridge');
    expect(result.review.id).toBe('ksr-kse-run-failed-bridge');
    expect(result.candidates).toEqual([]);
    expect(result.extractionRun).toMatchObject({ status: 'failed', error: 'candidate_bridge_failed' });
  });
});

describe('KSTAR group terminal subscriber', () => {
  it('captures one bounded group terminal event and ignores duplicate delivery', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    const captured: any[] = [];
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-a', ts: '2026-08-05T00:00:01.000Z', from: 'user', text: 'Make a plan.' }],
      capture: async (input: any) => { captured.push(input); return {} as any; },
    });
    const event = {
      run_id: 'run-group-terminal', user_id: 'group-user', conversation_id: 'cid-group', status: 'completed',
      started_at_ms: Date.parse('2026-08-05T00:00:00.000Z'), finished_at_ms: Date.parse('2026-08-05T00:01:00.000Z'),
    };
    listener?.(event);
    listener?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ userId: 'group-user', runId: 'run-group-terminal', conversationId: 'cid-group', status: 'completed' });
    stop();
  });

  it('swallows message-loader and capture errors so bus terminal delivery is unaffected', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => { throw new Error('messages unavailable'); },
    });
    expect(() => listener?.({
      run_id: 'run-group-error', user_id: 'group-user', conversation_id: 'cid-group', status: 'failed',
      started_at_ms: 0, finished_at_ms: 1,
    })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
  });
});

describe('KSTAR closure concurrency', () => {
  it('serializes concurrent captures for the same user and episode', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const recallBridge = await import('../../../../src/main/features/kstar/recall-bridge');
    let bridgeCalls = 0;
    const bridge = async (userId: string, proposals: any[]) => {
      bridgeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return recallBridge.saveKstarCandidateProposals(userId, proposals);
    };
    const input = { userId: 'closure-user', runId: 'run-concurrent', request, events, createdAt: '2026-08-05T00:00:00.000Z', bridge };
    await Promise.all([closure.captureRuntimeKstarClosure(input), closure.captureRuntimeKstarClosure(input)]);
    expect(bridgeCalls).toBe(1);
  });
});

describe('KSTAR closure recovery and referential integrity', () => {
  it('retries a transient group capture once without a duplicate terminal event', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    let listener: ((event: any) => void) | undefined;
    let captureCalls = 0;
    const stop = closure.startGroupKstarClosure({
      subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = undefined; }; },
      readMessages: async () => [{ id: 'msg-retry', ts: '2026-08-05T00:00:01.000Z', from: 'user', text: 'Retry this.' }],
      capture: async () => {
        captureCalls += 1;
        if (captureCalls === 1) throw new Error('transient');
        return {} as any;
      },
    });
    listener?.({ run_id: 'run-retry', user_id: 'group-user', conversation_id: 'cid-retry', status: 'completed', started_at_ms: Date.parse('2026-08-05T00:00:00.000Z'), finished_at_ms: Date.parse('2026-08-05T00:01:00.000Z') });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captureCalls).toBe(2);
    stop();
  });

  it('rebuilds a created extraction run whose review reference belongs to another episode', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const store = await import('../../../../src/main/features/kstar/episode-store');
    await store.writeKstarJsonRecord('closure-user', 'extraction-runs', {
      schemaVersion: 1, ownerId: 'closure-user', id: 'ksx-kse-run-cross', episodeId: 'kse-run-cross',
      reviewId: 'ksr-other-episode', candidateIds: [], status: 'created',
      createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
    });
    let bridgeCalls = 0;
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-cross', request: { ...request, user_id: 'closure-user' }, events,
      createdAt: '2026-08-05T00:00:00.000Z', bridge: async () => { bridgeCalls += 1; return []; },
    });
    expect(bridgeCalls).toBe(1);
    expect(result.extractionRun.reviewId).toBe(result.review.id);
  });
});

describe('KSTAR extraction reconciliation', () => {
  it('does not treat an empty created run as complete when current proposals exist', async () => {
    const closure = await import('../../../../src/main/features/kstar/task-closure');
    const builder = await import('../../../../src/main/features/kstar/episode-builder');
    const reviews = await import('../../../../src/main/features/kstar/review-service');
    const store = await import('../../../../src/main/features/kstar/episode-store');
    const currentEpisode = builder.buildRuntimeKstarEpisode({ userId: 'closure-user', runId: 'run-reconcile', request, events, createdAt: '2026-08-05T00:00:00.000Z' });
    await store.writeKstarEpisode('closure-user', currentEpisode);
    const currentReview = await reviews.saveKstarReviewRecord('closure-user', reviews.createInitialKstarReview(currentEpisode));
    await store.writeKstarJsonRecord('closure-user', 'extraction-runs', {
      schemaVersion: 1, ownerId: 'closure-user', id: 'ksx-kse-run-reconcile', episodeId: currentEpisode.id,
      reviewId: currentReview.id, candidateIds: [], status: 'created',
      createdAt: currentEpisode.createdAt, updatedAt: currentEpisode.updatedAt,
    });
    let bridgeCalls = 0;
    const result = await closure.captureRuntimeKstarClosure({
      userId: 'closure-user', runId: 'run-reconcile', request, events, createdAt: '2026-08-05T00:00:00.000Z',
      bridge: async (_userId, proposals) => { bridgeCalls += 1; return proposals.map(() => ({ id: `candidate-${bridgeCalls}`, status: 'pending' } as any)); },
    });
    expect(bridgeCalls).toBe(1);
    expect(result.extractionRun.candidateIds).toHaveLength(1);
  });
});
