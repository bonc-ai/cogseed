import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

let root: string;
let previous: string | undefined;
const uid = 'ontology-archive-user';

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-archive-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function loaded() {
  const store = await import('../../../src/main/features/cognition_kernel/store');
  return store;
}

async function createAndEdit(store: Awaited<ReturnType<typeof loaded>>, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const current = store.loadCognitionStoreSync(uid).ontology;
    const revision = current?.revision ?? 0;
    const command = index === 0
      ? { commandId: 'create-people', expectedRevision: revision, actions: [{
        intent: 'create' as const, recordId: 'people',
        record: { kind: 'module', name: '个人本体', description: '', scope: { kind: 'personal' } },
        sourceLabel: '用户确认',
      }] }
      : { commandId: `edit-${index}`, expectedRevision: revision, actions: [{
        intent: 'update' as const, recordId: 'people', expectedVersion: current!.records.people.version,
        patch: { description: `第 ${index} 次更新` }, sourceLabel: '用户确认',
      }] };
    const outcome = await store.applyCognitionDeltas(uid, { kind: 'ontology', command });
    expect(outcome.ok).toBe(true);
  }
}

describe('cognition ontology history archive', () => {
  it('sidelining old history and unreferenced receipts keeps the live document valid and writable', async () => {
    const store = await loaded();
    await createAndEdit(store, 5);
    const before = store.loadCognitionStoreSync(uid).ontology!;
    expect(before.history).toHaveLength(5);
    expect(Object.keys(before.receipts)).toHaveLength(5);

    const outcome = await store.archiveCognitionOntologyHistory(uid, { keepHistory: 2, keepReceipts: 2 });
    expect(outcome).toMatchObject({ ok: true, archivedHistory: 3, archivedReceipts: 3 });
    expect(outcome.archivePath && fs.existsSync(outcome.archivePath)).toBe(true);

    const archived = fs.readFileSync(outcome.archivePath!, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string });
    expect(archived.filter((row) => row.kind === 'history')).toHaveLength(3);
    expect(archived.filter((row) => row.kind === 'receipt')).toHaveLength(3);

    const after = store.loadCognitionStoreSync(uid).ontology!;
    expect(after.history).toHaveLength(2);
    expect(Object.keys(after.receipts)).toHaveLength(2);
    expect(after.history.map((entry) => entry.commandId)).toEqual(['edit-3', 'edit-4']);
    expect(Object.keys(after.receipts).sort()).toEqual(['edit-3', 'edit-4']);
    expect(after.records.people).toMatchObject({ kind: 'module', description: '第 4 次更新' });
    expect(after.revision).toBe(before.revision + 1);

    const next = await store.applyCognitionDeltas(uid, { kind: 'ontology', command: {
      commandId: 'after-archive', expectedRevision: after.revision, actions: [{
        intent: 'update', recordId: 'people', expectedVersion: after.records.people.version,
        patch: { description: '归档后继续编辑' }, sourceLabel: '用户确认',
      }],
    } });
    expect(next.ok).toBe(true);
    expect(store.loadCognitionStoreSync(uid).ontology!.records.people).toMatchObject({ description: '归档后继续编辑' });
  });

  it('keeps every record latest history and each retained receipt command unit', async () => {
    const store = await loaded();
    const apply = async (command: Record<string, unknown>) => {
      const current = store.loadCognitionStoreSync(uid).ontology;
      const outcome = await store.applyCognitionDeltas(uid, { kind: 'ontology',
        command: { ...command, expectedRevision: current?.revision ?? 0 } });
      expect(outcome.ok).toBe(true);
    };
    const version = (recordId: string) => store.loadCognitionStoreSync(uid).ontology!.records[recordId].version;
    await apply({ commandId: 'create-a', actions: [{ intent: 'create', recordId: 'a',
      record: { kind: 'module', name: 'A', description: '', scope: { kind: 'personal' } }, sourceLabel: '用户确认' }] });
    await apply({ commandId: 'create-b', actions: [{ intent: 'create', recordId: 'b',
      record: { kind: 'module', name: 'B', description: '', scope: { kind: 'personal' } }, sourceLabel: '用户确认' }] });
    await apply({ commandId: 'edit-a-1', actions: [{ intent: 'update', recordId: 'a', expectedVersion: version('a'),
      patch: { description: 'A1' }, sourceLabel: '用户确认' }] });
    await apply({ commandId: 'edit-b-1', actions: [{ intent: 'update', recordId: 'b', expectedVersion: version('b'),
      patch: { description: 'B1' }, sourceLabel: '用户确认' }] });
    await apply({ commandId: 'edit-a-2', actions: [{ intent: 'update', recordId: 'a', expectedVersion: version('a'),
      patch: { description: 'A2' }, sourceLabel: '用户确认' }] });
    expect(store.loadCognitionStoreSync(uid).ontology!.history).toHaveLength(5);

    const outcome = await store.archiveCognitionOntologyHistory(uid, { keepHistory: 1, keepReceipts: 1 });
    expect(outcome).toMatchObject({ ok: true, archivedHistory: 3, archivedReceipts: 3 });
    const after = store.loadCognitionStoreSync(uid).ontology!;
    expect(after.history.map(entry => entry.commandId)).toEqual(['edit-b-1', 'edit-a-2']);
    expect(Object.keys(after.receipts).sort()).toEqual(['edit-a-2', 'edit-b-1']);
    expect(after.records.a).toMatchObject({ description: 'A2' });
    expect(after.records.b).toMatchObject({ description: 'B1' });

    await apply({ commandId: 'edit-after', actions: [{ intent: 'update', recordId: 'a', expectedVersion: after.records.a.version,
      patch: { description: 'after archive' }, sourceLabel: '用户确认' }] });
    expect(store.loadCognitionStoreSync(uid).ontology!.records.a).toMatchObject({ description: 'after archive' });
  });

  it('rejects invalid bounds and leaves a document below the bounds untouched', async () => {
    const store = await loaded();
    await createAndEdit(store, 2);
    await expect(store.archiveCognitionOntologyHistory(uid, { keepHistory: -1, keepReceipts: 1 }))
      .resolves.toMatchObject({ ok: false, archivedHistory: 0 });
    const untouched = store.loadCognitionStoreSync(uid).ontology!;
    const outcome = await store.archiveCognitionOntologyHistory(uid, { keepHistory: 10, keepReceipts: 10 });
    expect(outcome).toMatchObject({ ok: true, archivedHistory: 0, archivedReceipts: 0 });
    expect(store.loadCognitionStoreSync(uid).ontology!.history).toEqual(untouched.history);
  });

  it('service wrapper rejects invalid bounds, archives through the transition and notifies once', async () => {
    const store = await loaded();
    await createAndEdit(store, 2);
    const service = await import('../../../src/main/features/cognition/ontology/service');
    await expect(service.archiveOntologyHistory(uid, -1, 1)).rejects.toMatchObject({ code: 'invalid_input' });
    const before = store.loadCognitionStoreSync(uid).ontology!.revision;
    const result = await service.archiveOntologyHistory(uid, 1, 1);
    expect(result).toMatchObject({ archivedHistory: 1, archivedReceipts: 1 });
    expect(result.archivePath && fs.existsSync(result.archivePath)).toBe(true);
    expect(store.loadCognitionStoreSync(uid).ontology!.revision).toBe(before + 1);
    const events = await import('../../../src/main/features/recall/store-events');
    expect(vi.mocked(events.notifyCognitionWrite)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(events.notifyCognitionWrite)).toHaveBeenCalledWith(uid, 'ontology', 'update');
  });
});
