import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The store resolves uid-scoped paths per call (never a module constant), so
 *  the test only has to redirect the two helpers into a temp root. */
let tmpRoot = '';
vi.mock('../../../../src/main/paths', () => ({
  userBackgroundRunsDir: (uid: string) => path.join(tmpRoot, uid),
  userBackgroundRunFile: (uid: string, runId: string) => path.join(tmpRoot, uid, `${runId}.json`),
}));

type Store = typeof import('../../../../src/main/features/local_agents/background_runs');

async function loadStore(): Promise<Store> {
  return await import('../../../../src/main/features/local_agents/background_runs');
}

function record(runId: string, over: Partial<import('../../../../src/main/features/local_agents/background_runs').BackgroundRunRecord> = {}) {
  return {
    runId,
    kind: 'local-cli' as const,
    cli: 'claude',
    uid: 'user-a',
    cwd: '/tmp/ws',
    argv: ['claude', '-p'],
    pid: 4242,
    startedAt: '2026-10-15T10:00:00.000Z',
    promotedBy: 'wall' as const,
    status: 'running' as const,
    updatedAt: '2026-10-15T10:00:00.000Z',
    ...over,
  };
}

describe('local_agents › background run records', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-runs-'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('round-trips a promoted run and resolves it under the uid directory', async () => {
    const store = await loadStore();
    store.createBackgroundRun(record('run-1'));

    const read = store.readBackgroundRun('user-a', 'run-1');
    expect(read?.runId).toBe('run-1');
    expect(read?.promotedBy).toBe('wall');
    expect(fs.existsSync(path.join(tmpRoot, 'user-a', 'run-1.json'))).toBe(true);
    // uid scoping: another user must not see it
    expect(store.readBackgroundRun('user-b', 'run-1')).toBeNull();
  });

  it('updates a record to its terminal state and stamps updatedAt', async () => {
    const store = await loadStore();
    store.createBackgroundRun(record('run-2'));

    const settled = store.updateBackgroundRun('user-a', 'run-2', {
      status: 'completed',
      exitCode: 0,
      outputPath: '/tmp/ws/out.txt',
    });

    expect(settled?.status).toBe('completed');
    expect(settled?.exitCode).toBe(0);
    expect(settled?.outputPath).toBe('/tmp/ws/out.txt');
    expect(settled?.updatedAt >= settled!.startedAt).toBe(true);
    expect(store.readBackgroundRun('user-a', 'run-2')?.status).toBe('completed');
  });

  it('returns null instead of throwing for an unknown run or unreadable file', async () => {
    const store = await loadStore();
    expect(store.readBackgroundRun('user-a', 'nope')).toBeNull();
    expect(store.updateBackgroundRun('user-a', 'nope', { status: 'failed' })).toBeNull();

    store.createBackgroundRun(record('run-3'));
    fs.writeFileSync(path.join(tmpRoot, 'user-a', 'run-3.json'), '{ not json', 'utf8');
    expect(store.readBackgroundRun('user-a', 'run-3')).toBeNull();
  });

  it('lists newest first and skips malformed records', async () => {
    const store = await loadStore();
    store.createBackgroundRun(record('older', { startedAt: '2026-10-15T09:00:00.000Z' }));
    store.createBackgroundRun(record('newer', { startedAt: '2026-10-15T11:00:00.000Z' }));
    fs.writeFileSync(path.join(tmpRoot, 'user-a', 'broken.json'), 'nope', 'utf8');

    expect(store.listBackgroundRuns('user-a').map((r) => r.runId)).toEqual(['newer', 'older']);
    expect(store.listBackgroundRuns('user-missing')).toEqual([]);
  });

  it('refuses to remove a still-running record, removes it once settled', async () => {
    const store = await loadStore();
    store.createBackgroundRun(record('run-4'));
    // A live child must keep its record: cleanup rules depend on it.
    expect(store.removeBackgroundRun('user-a', 'run-4')).toBe(false);
    expect(store.readBackgroundRun('user-a', 'run-4')).not.toBeNull();

    store.updateBackgroundRun('user-a', 'run-4', { status: 'timeout' });
    expect(store.removeBackgroundRun('user-a', 'run-4')).toBe(true);
    expect(store.readBackgroundRun('user-a', 'run-4')).toBeNull();
  });

  it('sanitizes a run id that would otherwise escape the uid directory', async () => {
    const store = await loadStore();
    store.createBackgroundRun(record('../escape'));
    const written = fs.readdirSync(path.join(tmpRoot, 'user-a'));
    expect(written.some((n) => n.includes('..'))).toBe(false);
  });
});
