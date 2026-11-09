import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previous: string | undefined;
const userId = 'graph-snapshot-user';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-graph-snapshot-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

function snapshot(revision: number, ownerId = userId) {
  return {
    schemaVersion: 1 as const,
    ownerId,
    scope: 'global' as const,
    ontologyRevision: revision,
    at: '2026-10-05',
    contentScale: 'instances' as const,
    nodes: [{
      id: 'module-a', recordId: 'module-a', version: 1, label: '模块', kind: 'module',
      x: 10, y: 20, source: { kind: 'user' as const, label: '用户确认' },
    }],
    edges: [],
    suggestions: [],
    generatedAt: new Date().toISOString(),
    generator: { kind: 'model' as const, promptVersion: 'v1' },
    validation: { valid: true as const, checkedRecordVersions: { 'module-a': 1 } },
  };
}

describe('ontology graph snapshot store', () => {
  it('keeps the previous snapshot while a newer generation is running or failed', async () => {
    const store = await import('../../../../src/main/features/cognition/ontology/graph-snapshot');
    const scope = { kind: 'global' as const };
    const saved = await store.saveGraphSnapshot(userId, snapshot(2));
    expect(saved).toMatchObject({ status: 'ready', ontologyRevision: 2 });
    await store.beginGraphSnapshotGeneration(userId, scope, 3);
    expect(await store.readGraphSnapshotEntry(userId, scope)).toMatchObject({
      status: 'running', ontologyRevision: 3, snapshot: { ontologyRevision: 2 },
    });
    await store.failGraphSnapshotGeneration(userId, scope, 3, 'model unavailable');
    expect(await store.readGraphSnapshotEntry(userId, scope)).toMatchObject({
      status: 'failed', ontologyRevision: 3, error: 'model unavailable', snapshot: { ontologyRevision: 2 },
    });
  });

  it('never replaces a newer snapshot with an older ontology revision', async () => {
    const store = await import('../../../../src/main/features/cognition/ontology/graph-snapshot');
    const scope = { kind: 'global' as const };
    await store.saveGraphSnapshot(userId, snapshot(4));
    await store.saveGraphSnapshot(userId, snapshot(3));
    expect(await store.readGraphSnapshotEntry(userId, scope)).toMatchObject({
      ontologyRevision: 4, snapshot: { ontologyRevision: 4 },
    });
  });

  it('stores snapshots by scope and refuses another owner', async () => {
    const store = await import('../../../../src/main/features/cognition/ontology/graph-snapshot');
    await store.saveGraphSnapshot(userId, snapshot(1));
    expect((await store.listGraphSnapshotEntries(userId)).global).toMatchObject({ status: 'ready' });
    expect(fs.existsSync(store.graphSnapshotStorePath(userId))).toBe(true);
    await expect(store.saveGraphSnapshot(userId, snapshot(2, 'other-user'))).rejects.toMatchObject({ code: 'not_authorized' });
  });
});
