import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let root: string;
const uid = 'wake-binding-user';
const cid = 'conversation-a';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-p3394-wake-binding-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.COGSEED_WORKSPACE_ROOT;
  vi.resetModules();
});

describe('P3394 wake asset confirmation binding', () => {
  it('persists the projection snapshot on both the request and approval', async () => {
    const wake = await import('../../../../src/main/features/p3394/wake-service');
    const pending = await wake.evaluateWake(uid, {
      conversationId: cid,
      agentId: 'agent-a',
      source: 'dispatch_to',
      sourceActorId: 'commander',
      objective: 'Review callback',
      dispatchPayload: { text: 'Review callback' },
    });
    const snapshot = {
      projection_id: 'proj-a',
      wake_request_id: pending.request.id,
      projection_status: 'confirmed' as const,
      confirmed_at: '2026-08-08T00:00:00.000Z',
      asset_ids: ['asset-a'],
      asset_versions: { 'asset-a': '1' },
      task_run_id: 'task-a',
      conversation_id: cid,
    };

    const approved = await wake.approveWakeRequest(uid, pending.request.id, { assetConfirmationSnapshot: snapshot });

    expect(approved.request.asset_confirmation_snapshot).toEqual(snapshot);
    expect(approved.approval.asset_confirmation_snapshot).toEqual(snapshot);
    vi.resetModules();
    const reloaded = await import('../../../../src/main/features/p3394/wake-service');
    await expect(reloaded.getWakeRequest(uid, pending.request.id)).resolves.toMatchObject({
      asset_confirmation_snapshot: snapshot,
    });
  });
});
