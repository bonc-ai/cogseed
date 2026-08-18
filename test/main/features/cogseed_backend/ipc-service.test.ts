import { describe, expect, it, vi } from 'vitest';

import { createCogSeedIpcService } from '../../../../src/main/features/cogseed_backend/ipc-service';

describe('CogSeed IPC service', () => {
  it('delegates validated user-scoped task operations without exposing backend selection or fallback fields', async () => {
    const controller = {
      startCogSeedTask: vi.fn(async (_userId: string, input: { requestId: string; task: string }) => ({ taskId: 'cogseed-task-ipc', status: 'running', ...input })),
      cancelCogSeedTask: vi.fn(async (_userId: string, taskId: string) => ({ taskId, status: 'cancelled' })),
    };
    const service = createCogSeedIpcService({
      controller,
      readTask: vi.fn(async () => ({ taskId: 'cogseed-task-ipc', status: 'running' })),
      retryTask: vi.fn(async () => ({ taskId: 'cogseed-task-retry', status: 'created' })),
      readEvents: vi.fn(async () => []),
    });

    await expect(service.start('ipc-user', { requestId: 'req-ipc', task: 'Do work.', allowFallback: true })).rejects.toThrow(/fallback/i);
    await expect(service.start('ipc-user', { requestId: 'req-ipc', task: 'Do work.' })).resolves.toMatchObject({ taskId: 'cogseed-task-ipc', status: 'running' });
    await expect(service.cancel('ipc-user', 'cogseed-task-ipc')).resolves.toMatchObject({ status: 'cancelled' });
    expect(controller.startCogSeedTask).toHaveBeenCalledWith('ipc-user', { requestId: 'req-ipc', task: 'Do work.' });
  });
});
