import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;
const USER = 'wake-store-merge-user';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-wake-store-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function request(id: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    conversation_id: 'cid-wake-merge',
    agent_id: 'agent-wake',
    agent_name: 'Deployment Agent',
    source: 'user_mention',
    objective: 'Deploy the release',
    behavior_scope: ['user_mention'],
    context_scope: ['conversation:cid-wake-merge'],
    dispatch_payload: { text: 'Deploy the release' },
    status: 'pending',
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: updatedAt,
    ...extra,
  } as any;
}

async function stores() {
  const wakeStore = await import('../../../../src/main/features/p3394/wake-store');
  const storage = await import('../../../../src/main/storage');
  return { ...wakeStore, writeJson: storage.writeJson };
}

describe('P3394 wake state cross-instance writes', () => {
  it('keeps requests another instance wrote instead of persisting a stale snapshot', async () => {
    const { mutateWakeState, readWakeState, wakeStateFile, writeJson } = await stores();

    await mutateWakeState(USER, (state) => {
      state.requests.push(request('wake-local', '2026-10-21T00:00:01.000Z'));
    });

    // A second app instance (a source build and an installed build can share one data
    // root) completes its own read-modify-write while this cycle awaits workflow
    // reconciliation. Its file copy knows nothing about `wake-local`.
    await mutateWakeState(USER, async (state) => {
      state.requests.push(request('wake-late', '2026-10-21T00:00:02.000Z'));
      await writeJson(wakeStateFile(USER), {
        version: 1,
        requests: [request('wake-peer', '2026-10-21T00:00:03.000Z')],
        approvals: [],
        updated_at: '2026-10-21T00:00:03.000Z',
      });
    });

    const state = await readWakeState(USER);
    // Requests only ever appear — never disappear — so the union is the truthful
    // result. Persisting our stale copy dropped a live approval card's request and
    // made "approve" fail with `wake request not found` (2026-10-21).
    expect(state.requests.map((row) => row.id).sort()).toEqual([
      'wake-late',
      'wake-local',
      'wake-peer',
    ]);
  });

  it('converges a record both instances changed on the later update', async () => {
    const { mutateWakeState, readWakeState, wakeStateFile, writeJson } = await stores();

    await mutateWakeState(USER, (state) => {
      state.requests.push(request('wake-shared', '2026-10-21T00:00:00.000Z'));
    });

    const rewritePeer = async (status: string, updatedAt: string) => {
      await writeJson(wakeStateFile(USER), {
        version: 1,
        requests: [request('wake-shared', updatedAt, { status })],
        approvals: [],
        updated_at: updatedAt,
      });
    };

    // The peer's decision is later than ours: it wins.
    await mutateWakeState(USER, async (state) => {
      const row = state.requests.find((entry) => entry.id === 'wake-shared')!;
      row.status = 'approved';
      row.updated_at = '2026-10-21T00:00:05.000Z';
      await rewritePeer('expired', '2026-10-21T00:00:09.000Z');
    });
    expect((await readWakeState(USER)).requests[0]?.status).toBe('expired');

    // Our decision is the later one now: ours wins.
    await mutateWakeState(USER, async (state) => {
      const row = state.requests.find((entry) => entry.id === 'wake-shared')!;
      row.status = 'approved';
      row.updated_at = '2026-10-21T00:00:20.000Z';
      await rewritePeer('expired', '2026-10-21T00:00:12.000Z');
    });
    expect((await readWakeState(USER)).requests[0]?.status).toBe('approved');
  });

  it('keeps an untouched peer record verbatim and does not duplicate approvals', async () => {
    const { mutateWakeState, readWakeState, wakeStateFile, writeJson } = await stores();

    await mutateWakeState(USER, (state) => {
      state.requests.push(request('wake-a', '2026-10-21T00:00:00.000Z'));
      state.approvals.push({
        id: 'approval-a',
        request_id: 'wake-a',
        conversation_id: 'cid-wake-merge',
        agent_id: 'agent-wake',
        context_scope: ['conversation:cid-wake-merge'],
        behavior_scope: ['user_mention'],
        status: 'active',
        created_at: '2026-10-21T00:00:00.000Z',
        updated_at: '2026-10-21T00:00:00.000Z',
      } as any);
    });

    // The peer appends a second approval without touching ours.
    await mutateWakeState(USER, async (state) => {
      state.requests.push(request('wake-b', '2026-10-21T00:00:04.000Z'));
      await writeJson(wakeStateFile(USER), {
        version: 1,
        requests: [request('wake-a', '2026-10-21T00:00:00.000Z')],
        approvals: [
          {
            id: 'approval-a',
            request_id: 'wake-a',
            conversation_id: 'cid-wake-merge',
            agent_id: 'agent-wake',
            context_scope: ['conversation:cid-wake-merge'],
            behavior_scope: ['user_mention'],
            status: 'active',
            created_at: '2026-10-21T00:00:00.000Z',
            updated_at: '2026-10-21T00:00:00.000Z',
          },
          {
            id: 'approval-peer',
            request_id: 'wake-b',
            conversation_id: 'cid-wake-merge',
            agent_id: 'agent-wake',
            context_scope: ['conversation:cid-wake-merge'],
            behavior_scope: ['user_mention'],
            status: 'active',
            created_at: '2026-10-21T00:00:04.000Z',
            updated_at: '2026-10-21T00:00:04.000Z',
          },
        ],
        updated_at: '2026-10-21T00:00:04.000Z',
      });
    });

    const state = await readWakeState(USER);
    expect(state.requests.map((row) => row.id).sort()).toEqual(['wake-a', 'wake-b']);
    expect(state.approvals.map((row) => row.id).sort()).toEqual(['approval-a', 'approval-peer']);
  });
});
