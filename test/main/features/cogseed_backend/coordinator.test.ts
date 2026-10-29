import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as paths from '../../../../src/main/paths';
import { createCogSeedCoordinator, readCogSeedCoordination } from '../../../../src/main/features/cogseed_backend/coordinator';
import { createCogSeedTask, readCogSeedTask } from '../../../../src/main/features/cogseed_backend/task-store';
import { transitionCogSeedTask } from '../../../../src/main/features/cogseed_backend/lifecycle';
import {
  appendNativeSessionRecord,
  createNativeRuntimeSession,
} from '../../../../src/main/features/cogseed_runtime/kernel/session-store';

const UID = 'cogseed-coordinator-user';
afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

async function parent() {
  return (await createCogSeedTask(UID, { requestId: 'req-parent', task: 'Coordinate work' })).task;
}

function setup() {
  const startTask = vi.fn(async (userId: string, input: any) => (await createCogSeedTask(userId, input)).task);
  const cancelTask = vi.fn(async (userId: string, taskId: string) => transitionCogSeedTask(userId, taskId, 'cancelled'));
  return { coordinator: createCogSeedCoordinator({ startTask, cancelTask }), startTask, cancelTask };
}

describe('CogSeed coordinator', () => {
  it('delegates a linked depth-one child idempotently', async () => {
    const p = await parent(); const h = setup();
    const first = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-1', task: 'Research A', role: 'researcher' });
    const repeated = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-1', task: 'Research A', role: 'researcher' });
    expect(repeated.taskId).toBe(first.taskId);
    expect(h.startTask).toHaveBeenCalledTimes(1);
    await expect(readCogSeedTask(UID, first.taskId)).resolves.toMatchObject({ parentTaskId: p.taskId, coordinationDepth: 1, coordinationId: expect.stringMatching(/^cogseed-coord-/) });
    const record = await readCogSeedCoordination(UID, first.coordinationId!); expect(record?.workflowRunId).toMatch(/^wrun-/);
  });

  it('enforces four children and depth one', async () => {
    const p = await parent(); const h = setup();
    for (let i = 0; i < 4; i++) await h.coordinator.delegate(UID, p.requestId, { requestId: `req-child-${i}`, task: `Child ${i}` });
    await expect(h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-5', task: 'Too many' })).rejects.toThrow(/budget/i);
    const child = await readCogSeedTask(UID, (await h.coordinator.tasks(UID, p.requestId, [])).children[0].taskId);
    await expect(h.coordinator.delegate(UID, child!.requestId, { requestId: 'req-grandchild', task: 'Nested' })).rejects.toThrow(/depth/i);
  });

  it('reads and cancels only linked children', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-a', task: 'A' });
    const other = (await createCogSeedTask(UID, { requestId: 'req-other', task: 'Other' })).task;
    await expect(h.coordinator.tasks(UID, p.requestId, [child.taskId])).resolves.toMatchObject({ children: [{ taskId: child.taskId }] });
    await expect(h.coordinator.cancel(UID, p.requestId, other.taskId)).rejects.toThrow(/linked/i);
    await h.coordinator.cancel(UID, p.requestId, child.taskId);
    expect(h.cancelTask).toHaveBeenCalledWith(UID, child.taskId);
  });


  it('summarizes child status by task id and keeps results scoped to the owning user', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-sum', task: 'Summarize me' });
    await h.coordinator.cancel(UID, p.requestId, child.taskId);

    const otherUser = 'cogseed-coordinator-other';
    const otherParent = (await createCogSeedTask(otherUser, { requestId: 'req-parent', task: 'Coordinate work' })).task;
    const other = setup();
    await other.coordinator.delegate(otherUser, otherParent.requestId, { requestId: 'req-child-other', task: 'Elsewhere' });

    await expect(h.coordinator.tasks(UID, p.requestId, [child.taskId, 'cogseed-task-missing'])).resolves.toMatchObject({
      coordinationId: expect.stringMatching(/^cogseed-coord-/),
      children: [{ taskId: child.taskId, status: 'cancelled' }],
    });
    await expect(h.coordinator.tasks(otherUser, otherParent.requestId, [])).resolves.toMatchObject({
      children: [{ taskId: expect.stringMatching(/^cogseed-task-/), status: 'created' }],
    });
  });

  it('cancels active children and keeps terminal children untouched', async () => {
    const p = await parent(); const h = setup();
    const active = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-active', task: 'Active child' });
    const terminal = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-terminal', task: 'Terminal child' });
    await h.coordinator.cancel(UID, p.requestId, terminal.taskId);
    h.cancelTask.mockClear();

    await h.coordinator.cancelChildrenForParent(UID, p.taskId);

    expect(h.cancelTask).toHaveBeenCalledTimes(1);
    expect(h.cancelTask).toHaveBeenCalledWith(UID, active.taskId);
    await expect(readCogSeedTask(UID, active.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(readCogSeedTask(UID, terminal.taskId)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('joins a finished child and returns its bounded result and written files', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-join', task: 'Write the minutes' });
    const stored = await readCogSeedTask(UID, child.taskId);
    const sessionId = stored!.runtimeSessionId;
    await createNativeRuntimeSession(UID, sessionId, '2026-10-16T00:00:00');
    await appendNativeSessionRecord(UID, sessionId, {
      type: 'turn', request_id: 'req-child-join', role: 'assistant',
      content: 'MINUTES READY', created_at: '2026-10-16T00:00:01',
    });
    await appendNativeSessionRecord(UID, sessionId, {
      type: 'turn', request_id: 'req-child-join', role: 'tool',
      content: '<runtime-tool-result/>', created_at: '2026-10-16T00:00:02',
      tool: { name: 'write_file', input: { path: '/w/minutes.md', content: '# minutes' }, result: { content: 'ok' } },
    });
    await transitionCogSeedTask(UID, child.taskId, 'queued');
    await transitionCogSeedTask(UID, child.taskId, 'running');
    await transitionCogSeedTask(UID, child.taskId, 'completed');

    const joined = await h.coordinator.join(UID, p.requestId, { taskIds: [child.taskId] });

    expect(joined).toMatchObject({ settled: true, timedOut: false });
    expect(joined.tasks).toEqual([expect.objectContaining({
      taskId: child.taskId,
      status: 'completed',
      result: 'MINUTES READY',
      files: ['/w/minutes.md'],
      // Legacy child completed without the contract block: explicit, not silent.
      structuredError: 'missing',
    })]);
  });

  it('returns a timed-out join instead of blocking the parent turn forever', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-hang', task: 'Never finishes' });
    const startedAt = Date.now();

    const joined = await h.coordinator.join(UID, p.requestId, { taskIds: [child.taskId], timeoutMs: 1_000 });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(joined).toMatchObject({ settled: false, timedOut: true });
    expect(joined.tasks[0]).toMatchObject({ taskId: child.taskId, status: 'created', timedOut: true });
  });

  it('treats a child that needs a human as settled for the join', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-wait', task: 'Needs a decision' });
    await transitionCogSeedTask(UID, child.taskId, 'queued');
    await transitionCogSeedTask(UID, child.taskId, 'running');
    await transitionCogSeedTask(UID, child.taskId, 'waiting_user');

    const joined = await h.coordinator.join(UID, p.requestId, { taskIds: [child.taskId], timeoutMs: 1_000 });

    expect(joined).toMatchObject({ settled: true, timedOut: false });
    expect(joined.tasks[0]).toMatchObject({ status: 'waiting_user' });
    expect(joined.tasks[0].timedOut).toBeUndefined();
  });


  it('keeps a failed child\'s partial assistant output instead of discarding it', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-partial', task: 'Fail halfway' });
    const stored = await readCogSeedTask(UID, child.taskId);
    const sessionId = stored!.runtimeSessionId;
    await createNativeRuntimeSession(UID, sessionId, '2026-10-16T00:00:00');
    await appendNativeSessionRecord(UID, sessionId, {
      type: 'turn', request_id: 'req-child-partial', role: 'assistant',
      content: 'PARTIAL: two sections written before the provider failed',
      created_at: '2026-10-16T00:00:01',
    });
    await transitionCogSeedTask(UID, child.taskId, 'queued');
    await transitionCogSeedTask(UID, child.taskId, 'running');
    await transitionCogSeedTask(UID, child.taskId, 'failed');

    const joined = await h.coordinator.join(UID, p.requestId, { taskIds: [child.taskId] });

    expect(joined.tasks[0]).toMatchObject({
      taskId: child.taskId,
      status: 'failed',
      result: 'PARTIAL: two sections written before the provider failed',
    });
  });

  it('returns a validated structured child result and strips the host-only block', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-structured', task: 'Write the minutes' });
    const stored = await readCogSeedTask(UID, child.taskId);
    expect(stored?.task).toContain('## Final result contract');
    const sessionId = stored!.runtimeSessionId;
    await createNativeRuntimeSession(UID, sessionId, '2026-10-16T00:00:00');
    await appendNativeSessionRecord(UID, sessionId, {
      type: 'turn', request_id: 'req-child-structured', role: 'assistant',
      content: [
        'MINUTES READY',
        '```cogseed-result',
        JSON.stringify({
          status: 'completed',
          summary: 'Wrote the minutes',
          files: ['/w/minutes.md', 'relative.md'],
          open_questions: ['Confirm the owner?'],
        }),
        '```',
      ].join('\n'),
      created_at: '2026-10-16T00:00:01',
    });
    await transitionCogSeedTask(UID, child.taskId, 'queued');
    await transitionCogSeedTask(UID, child.taskId, 'running');
    await transitionCogSeedTask(UID, child.taskId, 'completed');

    const joined = await h.coordinator.join(UID, p.requestId, { taskIds: [child.taskId] });

    expect(joined.tasks[0]).toMatchObject({
      taskId: child.taskId,
      status: 'completed',
      result: 'MINUTES READY',
      // The child inherits the parent's delegation-tree trace.
      traceId: p.taskId,
      structured: {
        status: 'completed',
        summary: 'Wrote the minutes',
        files: ['/w/minutes.md'],
        openQuestions: ['Confirm the owner?'],
      },
      files: ['/w/minutes.md'],
    });
    expect(joined.tasks[0].structuredError).toBeUndefined();
  });

  it('reports a malformed structured block without failing the join', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-bad-json', task: 'Break the contract' });
    const stored = await readCogSeedTask(UID, child.taskId);
    const sessionId = stored!.runtimeSessionId;
    await createNativeRuntimeSession(UID, sessionId, '2026-10-16T00:00:00');
    await appendNativeSessionRecord(UID, sessionId, {
      type: 'turn', request_id: 'req-child-bad-json', role: 'assistant',
      content: 'PARTIAL TEXT\n```cogseed-result\n{oops}\n```', created_at: '2026-10-16T00:00:01',
    });
    await transitionCogSeedTask(UID, child.taskId, 'queued');
    await transitionCogSeedTask(UID, child.taskId, 'running');
    await transitionCogSeedTask(UID, child.taskId, 'completed');

    const joined = await h.coordinator.join(UID, p.requestId, { taskIds: [child.taskId] });

    expect(joined.tasks[0]).toMatchObject({
      result: 'PARTIAL TEXT',
      structuredError: 'invalid_json',
    });
    expect(joined.tasks[0].structured).toBeUndefined();
  });

});
