import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * R-11 decision (2026-10-13): the commander waits for the actors it dispatched
 * and reports once they finish — the same shape this agent uses for sub-agents.
 * The predicate is the "may we ask for the report now?" half; it must never fire
 * while a worker can still deliver, and never twice per dispatch batch.
 */
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-actor-report-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runStore() {
  return import('../../../../src/main/features/group_chat/run_store');
}

const run = (actors: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  run_id: 'run-x',
  cid: 'cid-x',
  created_at: '2026-10-13T00:00:00.000Z',
  updated_at: '2026-10-13T00:00:00.000Z',
  actors,
  status: 'running',
  actor_report_requested: true,
  ...extra,
}) as never;

describe('actor report convergence (R-11)', () => {
  it('never reports direct or legacy runs without an explicit parent report request', async () => {
    const { shouldEnqueueActorReport } = await runStore();
    const actors = [{ agent_id: 'worker', terminal: 'done', produced: { messages: 1, artifacts: [] } }];
    expect(shouldEnqueueActorReport(run(actors, { actor_report_requested: undefined }))).toBe(false);
    expect(shouldEnqueueActorReport(run(actors, { actor_report_requested: false }))).toBe(false);
  });

  it('persists a report request separately from the immutable user submission', async () => {
    const store = await runStore();
    const created = await store.createRun({
      uid: 'report-user', cid: 'report-cid', submittedText: 'user request',
      memberAgentIds: ['worker'], mentionAgentIds: ['worker'],
    });
    expect(created?.actor_report_requested).toBeUndefined();
    await store.requestActorReport('report-user', 'report-cid', created!.run_id);
    const restored = await store.readRun('report-user', 'report-cid', created!.run_id);
    expect(restored?.actor_report_requested).toBe(true);
    expect(restored?.input_snapshot).toEqual(created?.input_snapshot);
    await store.recordRunActorTerminal('report-user', 'report-cid', created!.run_id, 'worker', {
      terminal: 'done', messages: 1,
    });
    expect(store.shouldEnqueueActorReport(await store.readRun('report-user', 'report-cid', created!.run_id))).toBe(true);
  });

  it('keeps waiting while any dispatched actor is still pending', async () => {
    const { shouldEnqueueActorReport } = await runStore();
    expect(shouldEnqueueActorReport(run([
      { agent_id: 'commander', terminal: 'done', produced: { messages: 1, artifacts: [] } },
      { agent_id: 'review-agent', terminal: 'pending' },
    ]))).toBe(false);
  });

  it('asks for the report once every actor is terminal and something was produced', async () => {
    const { shouldEnqueueActorReport } = await runStore();
    expect(shouldEnqueueActorReport(run([
      { agent_id: 'commander', terminal: 'done', produced: { messages: 1, artifacts: [] } },
      { agent_id: 'review-agent', terminal: 'done', produced: { messages: 1, artifacts: [] } },
    ]))).toBe(true);
  });

  it('waits for user decisions while still reporting actual failures', async () => {
    // 2026-10-13: the worker ended blocked/waiting_user after a successful retry,
    // so a 'done'-only predicate never asked the commander to report at all.
    const { shouldEnqueueActorReport } = await runStore();
    expect(shouldEnqueueActorReport(run([
      { agent_id: 'worker', terminal: 'blocked', reason: 'waiting_user', produced: { messages: 1, artifacts: [] } },
    ]))).toBe(false);
    expect(shouldEnqueueActorReport(run([
      { agent_id: 'worker', terminal: 'failed', reason: 'provider_400', produced: { messages: 1, artifacts: [] } },
    ]))).toBe(true);
  });

  it('does not ask when the finished actors produced nothing', async () => {
    const { shouldEnqueueActorReport } = await runStore();
    expect(shouldEnqueueActorReport(run([
      { agent_id: 'review-agent', terminal: 'done', produced: { messages: 0, artifacts: [] } },
      { agent_id: 'other', terminal: 'failed', reason: 'runtime_failed' },
    ]))).toBe(false);
  });

  it('reports at most once per dispatch batch (anti-flap latch)', async () => {
    const { shouldEnqueueActorReport } = await runStore();
    expect(shouldEnqueueActorReport(run([
      { agent_id: 'review-agent', terminal: 'done', produced: { messages: 1, artifacts: [] } },
    ], { actor_report_enqueued: true }))).toBe(false);
  });

  it('has nothing to report for a run without actors', async () => {
    const { shouldEnqueueActorReport } = await runStore();
    expect(shouldEnqueueActorReport(run([]))).toBe(false);
    expect(shouldEnqueueActorReport(null)).toBe(false);
  });
});
