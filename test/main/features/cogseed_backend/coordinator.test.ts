import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as paths from '../../../../src/main/paths';
import { createMateCoordinator, readMateCoordination } from '../../../../src/main/features/cogseed_backend/coordinator';
import { createMateTask, readMateTask } from '../../../../src/main/features/cogseed_backend/task-store';
import { transitionMateTask } from '../../../../src/main/features/cogseed_backend/lifecycle';

const UID = 'mate-coordinator-user';
afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

async function parent() {
  return (await createMateTask(UID, { requestId: 'req-parent', task: 'Coordinate work' })).task;
}

function setup() {
  const startTask = vi.fn(async (userId: string, input: any) => (await createMateTask(userId, input)).task);
  const cancelTask = vi.fn(async (userId: string, taskId: string) => transitionMateTask(userId, taskId, 'cancelled'));
  return { coordinator: createMateCoordinator({ startTask, cancelTask }), startTask, cancelTask };
}

describe('CogSeed coordinator', () => {
  it('delegates a linked depth-one child idempotently', async () => {
    const p = await parent(); const h = setup();
    const first = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-1', task: 'Research A', role: 'researcher' });
    const repeated = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-1', task: 'Research A', role: 'researcher' });
    expect(repeated.taskId).toBe(first.taskId);
    expect(h.startTask).toHaveBeenCalledTimes(1);
    await expect(readMateTask(UID, first.taskId)).resolves.toMatchObject({ parentTaskId: p.taskId, coordinationDepth: 1, coordinationId: expect.stringMatching(/^mate-coord-/) });
    const record = await readMateCoordination(UID, first.coordinationId!); expect(record?.workflowRunId).toMatch(/^wrun-/);
  });

  it('enforces four children and depth one', async () => {
    const p = await parent(); const h = setup();
    for (let i = 0; i < 4; i++) await h.coordinator.delegate(UID, p.requestId, { requestId: `req-child-${i}`, task: `Child ${i}` });
    await expect(h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-5', task: 'Too many' })).rejects.toThrow(/budget/i);
    const child = await readMateTask(UID, (await h.coordinator.tasks(UID, p.requestId, [])).children[0].taskId);
    await expect(h.coordinator.delegate(UID, child!.requestId, { requestId: 'req-grandchild', task: 'Nested' })).rejects.toThrow(/depth/i);
  });

  it('reads and cancels only linked children', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-a', task: 'A' });
    const other = (await createMateTask(UID, { requestId: 'req-other', task: 'Other' })).task;
    await expect(h.coordinator.tasks(UID, p.requestId, [child.taskId])).resolves.toMatchObject({ children: [{ taskId: child.taskId }] });
    await expect(h.coordinator.cancel(UID, p.requestId, other.taskId)).rejects.toThrow(/linked/i);
    await h.coordinator.cancel(UID, p.requestId, child.taskId);
    expect(h.cancelTask).toHaveBeenCalledWith(UID, child.taskId);
  });


  it('summarizes child status by task id and keeps results scoped to the owning user', async () => {
    const p = await parent(); const h = setup();
    const child = await h.coordinator.delegate(UID, p.requestId, { requestId: 'req-child-sum', task: 'Summarize me' });
    await h.coordinator.cancel(UID, p.requestId, child.taskId);

    const otherUser = 'mate-coordinator-other';
    const otherParent = (await createMateTask(otherUser, { requestId: 'req-parent', task: 'Coordinate work' })).task;
    const other = setup();
    await other.coordinator.delegate(otherUser, otherParent.requestId, { requestId: 'req-child-other', task: 'Elsewhere' });

    await expect(h.coordinator.tasks(UID, p.requestId, [child.taskId, 'mate-task-missing'])).resolves.toMatchObject({
      coordinationId: expect.stringMatching(/^mate-coord-/),
      children: [{ taskId: child.taskId, status: 'cancelled' }],
    });
    await expect(h.coordinator.tasks(otherUser, otherParent.requestId, [])).resolves.toMatchObject({
      children: [{ taskId: expect.stringMatching(/^mate-task-/), status: 'created' }],
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
    await expect(readMateTask(UID, active.taskId)).resolves.toMatchObject({ status: 'cancelled' });
    await expect(readMateTask(UID, terminal.taskId)).resolves.toMatchObject({ status: 'cancelled' });
  });

});
