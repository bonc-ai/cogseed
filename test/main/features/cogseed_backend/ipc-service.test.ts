import { describe, expect, it, vi } from 'vitest';

import { createMateIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';

describe('Mate IPC service', () => {
  it('delegates validated user-scoped task operations without exposing backend selection or fallback fields', async () => {
    const controller = {
      startMateTask: vi.fn(async (_userId: string, input: { requestId: string; task: string }) => ({ taskId: 'mate-task-ipc', status: 'running', ...input })),
      cancelMateTask: vi.fn(async (_userId: string, taskId: string) => ({ taskId, status: 'cancelled' })),
    };
    const service = createMateIpcService({
      controller,
      readTask: vi.fn(async () => ({ taskId: 'mate-task-ipc', status: 'running' })),
      retryTask: vi.fn(async () => ({ taskId: 'mate-task-retry', status: 'created' })),
      readEvents: vi.fn(async () => []),
    });

    await expect(service.start('ipc-user', { requestId: 'req-ipc', task: 'Do work.', allowFallback: true })).rejects.toThrow(/fallback/i);
    await expect(service.start('ipc-user', { requestId: 'req-ipc', task: 'Do work.' })).resolves.toMatchObject({ taskId: 'mate-task-ipc', status: 'running' });
    await expect(service.cancel('ipc-user', 'mate-task-ipc')).resolves.toMatchObject({ status: 'cancelled' });
    expect(controller.startMateTask).toHaveBeenCalledWith('ipc-user', { requestId: 'req-ipc', task: 'Do work.' });
  });
});
