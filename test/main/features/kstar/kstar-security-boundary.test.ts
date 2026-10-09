import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const forecastMock = vi.hoisted(() => ({ commitCommanderForecast: vi.fn() }));
vi.mock('../../../../src/main/features/kstar/forecast-commit', () => forecastMock);
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

let root: string;
let previousRoot: string | undefined;
beforeEach(() => { vi.resetModules(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kstar-boundary-')); previousRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; });
afterEach(() => { if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previousRoot; fs.rmSync(root, { recursive: true, force: true }); });

describe('KSTAR security boundaries', () => {
  it('rejects unsafe host IDs before reading another user or path', async () => {
    const service = await import('../../../../src/main/features/kstar/control-service');
    const result = await service.executeKstarControl({ userId: 'user-a', conversationId: '../user-b', allowedToolNames: new Set() }, { operation: 'abandon', idempotencyKey: 'boundary-abandon' });
    expect(result).toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });
  });

  it('rejects an ID from another current state and never writes a spoofed update', async () => {
    const service = await import('../../../../src/main/features/kstar/control-service');
    const result = await service.executeKstarControl({ userId: 'user-a', conversationId: 'cid-a', allowedToolNames: new Set() }, {
      operation: 'upsert_state', idempotencyKey: 'boundary-update',
      task: { operation: 'update', taskId: 'task-user-b', title: 'spoof' },
      requirement: { operation: 'keep', requirementId: 'req-user-b' },
    });
    expect(result).toMatchObject({ ok: false, code: 'kstar_control_invalid_input' });
  });

  it('fails closed for illegal lifecycle transitions', async () => {
    const { assertKstarTransition } = await import('../../../../src/main/features/kstar/state-machine');
    expect(() => assertKstarTransition('task', 'closed', 'open')).toThrow(/invalid KSTAR task transition/);
    expect(() => assertKstarTransition('review', 'confirmed', 'inferred')).toThrow(/invalid KSTAR review transition/);
  });
});
