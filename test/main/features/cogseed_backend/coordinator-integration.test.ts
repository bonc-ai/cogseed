import * as fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import * as paths from '../../../../src/main/paths';
import { createMateRuntimeController } from '../../../../src/main/features/cogseed_backend/runtime-controller';

const UID = 'coordinator-cancel-user';
afterEach(() => fs.rmSync(paths.userRoot(UID), { recursive: true, force: true }));

it('calls the parent cancellation hook after persisting cancellation', async () => {
  const cancelChildrenForParent = vi.fn(async () => {});
  const runtime: any = { run: async function* () {}, shutdown: vi.fn() };
  const controller = createMateRuntimeController({ runtime, cancelChildrenForParent });
  const parent = await controller.startMateTask(UID, { requestId: 'req-cancel-parent', task: 'parent' });
  const cancelled = await controller.cancelMateTask(UID, parent.taskId);
  expect(cancelled.status).toBe('cancelled');
  expect(cancelChildrenForParent).toHaveBeenCalledWith(UID, parent.taskId);
});

it('does not undo persisted cancellation when child cleanup fails', async () => {
  const runtime: any = { run: async function* () {}, shutdown: vi.fn() };
  const controller = createMateRuntimeController({ runtime, cancelChildrenForParent: async () => { throw new Error('cleanup failed'); } });
  const parent = await controller.startMateTask(UID, { requestId: 'req-cancel-failure', task: 'parent' });
  await expect(controller.cancelMateTask(UID, parent.taskId)).resolves.toMatchObject({ status: 'cancelled' });
});
