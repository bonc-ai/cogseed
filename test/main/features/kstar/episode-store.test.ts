import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-store-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sampleEpisode(ownerId: string, id = 'kse-run-a') {
  return {
    schemaVersion: 1 as const,
    ownerId,
    id,
    sessionId: 'mruntime-session-a',
    taskRunId: 'run-a',
    k: {
      memoryRefs: [],
      contextRefs: ['context-a'],
      abilityAssetRefs: [],
    },
    s: { conversationSummary: 'A bounded situation.' },
    t: { userGoal: 'Complete the requested task.', constraints: [] },
    a: { toolCalls: [], agentActions: [] },
    r: { status: 'completed' as const, finalText: 'Done.', producedFiles: [] },
    evidenceRefs: [{ kind: 'execution' as const, id: 'run-a' }],
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  };
}

async function modules() {
  const [store, paths] = await Promise.all([
    import('../../../../src/main/features/kstar/episode-store'),
    import('../../../../src/main/features/kstar/paths'),
  ]);
  return { store, paths };
}

describe('KSTAR episode store', () => {
  it('writes, reads, and idempotently replays an owned episode', async () => {
    const { store, paths } = await modules();
    const record = sampleEpisode('kstar-user-a');

    await expect(store.writeKstarEpisode('kstar-user-a', record)).resolves.toEqual(record);
    await expect(store.writeKstarEpisode('kstar-user-a', record)).resolves.toEqual(record);
    await expect(store.readKstarEpisode('kstar-user-a', record.id)).resolves.toEqual(record);
    expect(paths.kstarEpisodePath('kstar-user-a', record.id)).toBe(
      path.join(tmpDir, 'kstar-user-a', 'cloud', 'kstar', 'episodes', `${record.id}.json`),
    );
  });

  it('isolates owners and rejects conflicting replays', async () => {
    const { store } = await modules();
    const record = sampleEpisode('kstar-user-a');
    await store.writeKstarEpisode('kstar-user-a', record);

    await expect(store.readKstarEpisode('kstar-user-b', record.id)).resolves.toBeNull();
    await expect(store.writeKstarEpisode('kstar-user-b', record as any)).rejects.toThrow(/owner/i);
    await expect(store.writeKstarEpisode('kstar-user-a', {
      ...record,
      t: { ...record.t, userGoal: 'Conflicting replacement.' },
    })).rejects.toThrow(/conflict/i);
  });

  it('rejects unsafe path segments before path construction', async () => {
    const { paths } = await modules();
    for (const invalid of ['../escape', 'nested/value', 'bad.value', '', ' user ', 'user\\id']) {
      expect(() => paths.kstarRoot(invalid)).toThrow(/invalid kstar user id/i);
      expect(() => paths.kstarEpisodePath('kstar-user-a', invalid)).toThrow(/invalid kstar episode id/i);
    }
  });

  it('lists healthy episodes newest-first while skipping corrupt and future-schema records', async () => {
    const { store, paths } = await modules();
    const older = sampleEpisode('kstar-user-a', 'kse-run-older');
    const newer = {
      ...sampleEpisode('kstar-user-a', 'kse-run-newer'),
      createdAt: '2026-08-05T01:00:00.000Z',
      updatedAt: '2026-08-05T01:00:00.000Z',
    };
    await store.writeKstarEpisode('kstar-user-a', older);
    await store.writeKstarEpisode('kstar-user-a', newer);

    const episodesDir = path.dirname(paths.kstarEpisodePath('kstar-user-a', older.id));
    fs.writeFileSync(path.join(episodesDir, 'kse-corrupt.json'), '{broken', 'utf8');
    fs.writeFileSync(path.join(episodesDir, 'kse-future.json'), JSON.stringify({
      ...sampleEpisode('kstar-user-a', 'kse-future'),
      schemaVersion: 99,
    }), 'utf8');

    await expect(store.listKstarEpisodes('kstar-user-a')).resolves.toEqual([newer, older]);
    await expect(store.readKstarEpisode('kstar-user-a', 'kse-corrupt')).rejects.toThrow(/invalid JSON/i);
    await expect(store.readKstarEpisode('kstar-user-a', 'kse-future')).rejects.toThrow(/future schema/i);
  });
});
