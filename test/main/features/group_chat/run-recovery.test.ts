import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Boot-time worker closure (N-02/R-11). A run actor left `pending` by a previous
 * process has no live worker: on 2026-10-12 the run produced no terminal, so the
 * card stayed "running" while nothing executed it.
 */
const USER = 'cogseed-run-recovery-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-run-recovery-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function recovery() {
  return import('../../../../src/main/features/group_chat/run_recovery');
}

describe('run actor recovery', () => {
  it('selects only the actors that never reached a terminal', async () => {
    const { pendingRunActorIds } = await recovery();
    expect(pendingRunActorIds({
      actors: [
        { agent_id: 'worker-a', terminal: 'pending' },
        { agent_id: 'worker-b', terminal: 'done' },
        { agent_id: 'worker-c', terminal: 'blocked' },
        { agent_id: 'worker-d', terminal: 'pending' },
      ],
    })).toEqual(['worker-a', 'worker-d']);
  });

  it('is defensive about malformed run records', async () => {
    const { pendingRunActorIds } = await recovery();
    expect(pendingRunActorIds(null)).toEqual([]);
    expect(pendingRunActorIds({})).toEqual([]);
    expect(pendingRunActorIds({ actors: [{} as never, { agent_id: 'x' } as never] })).toEqual([]);
  });

  it('tells the same restart story as the task path', async () => {
    const { RUN_ACTOR_RESTART_REASON } = await recovery();
    expect(RUN_ACTOR_RESTART_REASON).toBe('worker_restart');
  });

  it('closes stale actors at boot and reports how many (nothing to close here)', async () => {
    const { closeStaleRunActorsAtBoot } = await recovery();
    // No conversations in a fresh workspace: recovery must be a no-op, not a throw.
    await expect(closeStaleRunActorsAtBoot(USER)).resolves.toMatchObject({
      scannedConversations: 0,
      scannedRuns: 0,
      closedActors: 0,
    });
  });
});
