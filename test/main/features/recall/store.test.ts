import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-recall-store-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function recallModules() {
  const [store, paths] = await Promise.all([
    import('../../../../src/main/features/recall/store'),
    import('../../../../src/main/features/recall/paths'),
  ]);
  return { store, paths };
}

describe('Recall store foundation', () => {
  it('exposes the recall API through the barrel without ambiguous exports', async () => {
    const recall = await import('../../../../src/main/features/recall');

    expect(recall.RECALL_SCHEMA_VERSION).toBe(2);
    expect(recall.readRecallJsonRecord).toBeTypeOf('function');
    expect(recall.recallJsonRecordPath).toBeTypeOf('function');
  });

  it('rejects invalid user ids before constructing recall paths', async () => {
    const { paths } = await recallModules();
    const invalidUserIds = ['../escape', 'nested/user', 'bad.user', '', ' space ', 'user\\id'];

    for (const userId of invalidUserIds) {
      expect(() => paths.recallRoot(userId)).toThrow(/invalid recall user id/i);
      expect(() => paths.recallJsonRecordPath(userId, 'profiles', 'profile_1')).toThrow(/invalid recall user id/i);
      expect(() => paths.recallJsonlPath(userId, 'events', 'daily')).toThrow(/invalid recall user id/i);
      expect(() => paths.recallMigrationsPath(userId)).toThrow(/invalid recall user id/i);
    }

    expect(paths.recallRoot('opaque-user_123')).toBe(path.join(tmpDir, 'opaque-user_123', 'cloud', 'recall'));
  });

  it('creates and updates JSON records under the user-scoped cloud recall root', async () => {
    const { store, paths } = await recallModules();
    const userId = 'recall-user-a';

    await store.writeRecallJsonRecord(userId, 'profiles', 'profile_1', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'profile_1',
      label: 'first',
      count: 1,
    });

    const updated = await store.updateRecallJsonRecord(userId, 'profiles', 'profile_1', (current) => ({
      ...current,
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'profile_1',
      label: 'updated',
      count: Number(current?.count ?? 0) + 1,
    }));

    expect(updated).toMatchObject({ ownerId: userId, id: 'profile_1', label: 'updated', count: 2 });
    expect(paths.recallRoot(userId)).toBe(path.join(tmpDir, userId, 'cloud', 'recall'));
    expect(paths.recallJsonRecordPath(userId, 'profiles', 'profile_1'))
      .toBe(path.join(tmpDir, userId, 'cloud', 'recall', 'records', 'profiles', 'profile_1.json'));
    await expect(store.readRecallJsonRecord(userId, 'profiles', 'profile_1'))
      .resolves.toMatchObject({ ownerId: userId, id: 'profile_1', label: 'updated', count: 2 });
  });

  it('appends and lists owned JSONL records while isolating users', async () => {
    const { store, paths } = await recallModules();

    await store.appendRecallJsonlRecord('alice', 'events', 'daily', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: 'alice',
      id: 'evt_1',
      value: 'a1',
    });
    await store.appendRecallJsonlRecord('bob', 'events', 'daily', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: 'bob',
      id: 'evt_1',
      value: 'b1',
    });
    await store.appendRecallJsonlRecord('alice', 'events', 'daily', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: 'alice',
      id: 'evt_2',
      value: 'a2',
    });

    await expect(store.appendRecallJsonlRecord('alice', 'events', 'daily', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: 'bob',
      id: 'evt_wrong',
    })).rejects.toThrow(/owner/i);

    expect(await store.listRecallJsonlRecords('alice', 'events', 'daily', 10)).toEqual([
      expect.objectContaining({ ownerId: 'alice', id: 'evt_1', value: 'a1' }),
      expect.objectContaining({ ownerId: 'alice', id: 'evt_2', value: 'a2' }),
    ]);
    expect(await store.listRecallJsonlRecords('bob', 'events', 'daily', 10)).toEqual([
      expect.objectContaining({ ownerId: 'bob', id: 'evt_1', value: 'b1' }),
    ]);
    expect(paths.recallJsonlPath('alice', 'events', 'daily'))
      .toBe(path.join(tmpDir, 'alice', 'cloud', 'recall', 'jsonl', 'events', 'daily.jsonl'));
  });

  it('rejects malformed JSONL syntax with stream context and line number', async () => {
    const { store, paths } = await recallModules();
    const userId = 'malformed-jsonl-syntax-user';
    const streamPath = paths.recallJsonlPath(userId, 'events', 'daily');

    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, [
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: userId,
        id: 'evt_1',
      }),
      '{not valid json',
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: userId,
        id: 'evt_2',
      }),
    ].join('\n'), 'utf8');

    await expect(store.listRecallJsonlRecords(userId, 'events', 'daily', 1))
      .rejects.toThrow(/recall jsonl events\/daily line 2: invalid json/i);
  });

  it('rejects interior blank JSONL lines with stream context and line number', async () => {
    const { store, paths } = await recallModules();
    const userId = 'blank-jsonl-user';
    const streamPath = paths.recallJsonlPath(userId, 'events', 'daily');

    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, [
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: userId,
        id: 'evt_1',
      }),
      '   ',
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: userId,
        id: 'evt_2',
      }),
    ].join('\n'), 'utf8');

    await expect(store.listRecallJsonlRecords(userId, 'events', 'daily', 10))
      .rejects.toThrow(/recall jsonl events\/daily line 2: blank line/i);
  });

  it('allows exactly the trailing empty JSONL segment caused by a final newline', async () => {
    const { store, paths } = await recallModules();
    const userId = 'trailing-newline-jsonl-user';
    const streamPath = paths.recallJsonlPath(userId, 'events', 'daily');

    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, `${JSON.stringify({
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'evt_1',
    })}\n`, 'utf8');

    await expect(store.listRecallJsonlRecords(userId, 'events', 'daily', 10))
      .resolves.toEqual([expect.objectContaining({ ownerId: userId, id: 'evt_1' })]);
  });

  it('returns the newest JSONL records for positive finite limits and full records otherwise', async () => {
    const { store, paths } = await recallModules();
    const userId = 'tail-limit-jsonl-user';
    const streamPath = paths.recallJsonlPath(userId, 'events', 'daily');
    const lines = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: `evt_${index + 1}`,
    }));

    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, `${lines.join('\n')}\n`, 'utf8');

    expect((await store.listRecallJsonlRecords(userId, 'events', 'daily', 2)).map((record) => record.id))
      .toEqual(['evt_4', 'evt_5']);
    expect((await store.listRecallJsonlRecords(userId, 'events', 'daily', 0)).map((record) => record.id))
      .toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']);
    expect((await store.listRecallJsonlRecords(userId, 'events', 'daily', Number.POSITIVE_INFINITY)).map((record) => record.id))
      .toEqual(['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5']);
  });

  it('validates malformed JSONL record objects outside the returned tail', async () => {
    const { store, paths } = await recallModules();
    const userId = 'malformed-jsonl-object-user';
    const streamPath = paths.recallJsonlPath(userId, 'events', 'daily');

    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, [
      JSON.stringify({ id: 'evt_1' }),
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: userId,
        id: 'evt_2',
      }),
    ].join('\n'), 'utf8');

    await expect(store.listRecallJsonlRecords(userId, 'events', 'daily', 1))
      .rejects.toThrow(/recall jsonl events\/daily line 1: malformed/i);
  });

  it('validates JSONL record owners outside the returned tail', async () => {
    const { store, paths } = await recallModules();
    const userId = 'malformed-jsonl-owner-user';
    const streamPath = paths.recallJsonlPath(userId, 'events', 'daily');

    fs.mkdirSync(path.dirname(streamPath), { recursive: true });
    fs.writeFileSync(streamPath, [
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: 'other-user',
        id: 'evt_1',
      }),
      JSON.stringify({
        schemaVersion: store.RECALL_SCHEMA_VERSION,
        ownerId: userId,
        id: 'evt_2',
      }),
    ].join('\n'), 'utf8');

    await expect(store.listRecallJsonlRecords(userId, 'events', 'daily', 1))
      .rejects.toThrow(/recall jsonl events\/daily line 1: .*owner/i);
  });

  it('treats missing records as absent and invalid JSON as malformed', async () => {
    const { store, paths } = await recallModules();
    const userId = 'read-error-user';

    await expect(store.readRecallJsonRecord(userId, 'profiles', 'missing_1'))
      .resolves.toBeUndefined();

    const recordPath = paths.recallJsonRecordPath(userId, 'profiles', 'bad_json');
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, '{not valid json', 'utf8');

    await expect(store.readRecallJsonRecord(userId, 'profiles', 'bad_json'))
      .rejects.toThrow(/malformed recall record: invalid json/i);
  });

  it('serializes per-record updates under a lock so concurrent updates are not lost', async () => {
    const { store } = await recallModules();
    const userId = 'lock-user';

    await store.writeRecallJsonRecord(userId, 'counters', 'counter_1', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'counter_1',
      count: 0,
    });

    await Promise.all(Array.from({ length: 25 }, () => store.updateRecallJsonRecord(userId, 'counters', 'counter_1', (current) => ({
      ...current,
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'counter_1',
      count: Number(current?.count ?? 0) + 1,
    }))));

    await expect(store.readRecallJsonRecord(userId, 'counters', 'counter_1'))
      .resolves.toMatchObject({ ownerId: userId, id: 'counter_1', count: 25 });
  });

  it('rejects malformed records, mismatched owners, invalid ids, and invalid collection names', async () => {
    const { store, paths } = await recallModules();
    const userId = 'malformed-user';
    const recordPath = paths.recallJsonRecordPath(userId, 'profiles', 'bad_1');

    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: store.RECALL_SCHEMA_VERSION, id: 'bad_1' }), 'utf8');
    await expect(store.readRecallJsonRecord(userId, 'profiles', 'bad_1')).rejects.toThrow(/malformed recall record/i);

    fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: store.RECALL_SCHEMA_VERSION, ownerId: 'other', id: 'bad_1' }), 'utf8');
    await expect(store.readRecallJsonRecord(userId, 'profiles', 'bad_1')).rejects.toThrow(/owner/i);

    await expect(store.writeRecallJsonRecord(userId, '../profiles', 'bad_2', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'bad_2',
    })).rejects.toThrow(/invalid/i);
    await expect(store.writeRecallJsonRecord(userId, 'profiles', '../bad_2', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: '../bad_2',
    })).rejects.toThrow(/invalid/i);
  });

  it('applies migration markers idempotently', async () => {
    const { store, paths } = await recallModules();
    const userId = 'migration-user';

    const first = await store.migrateRecallStore(userId);
    const second = await store.migrateRecallStore(userId);

    expect(second).toEqual(first);
    expect(second).toMatchObject({
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'recall-migrations',
      applied: expect.objectContaining({ 'recall-store-v1': expect.any(String) }),
    });

    const markerPath = paths.recallMigrationsPath(userId);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toEqual(first);
  });

  it('refuses future-schema migration markers without overwriting them', async () => {
    const { store, paths } = await recallModules();
    const userId = 'migration-future-user';
    const markerPath = paths.recallMigrationsPath(userId);
    const futureMarker = {
      schemaVersion: store.RECALL_SCHEMA_VERSION + 1,
      ownerId: userId,
      id: 'recall-migrations',
      applied: { future: '2030-01-01T00:00:00.000Z' },
    };

    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(futureMarker, null, 2), 'utf8');

    await expect(store.migrateRecallStore(userId)).rejects.toThrow(/future schema/i);
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf8'))).toEqual(futureMarker);
  });

  it('never overwrites a record written by a future schema', async () => {
    const { store, paths } = await recallModules();
    const userId = 'future-user';
    const recordPath = paths.recallJsonRecordPath(userId, 'profiles', 'profile_future');
    const futureRecord = {
      schemaVersion: store.RECALL_SCHEMA_VERSION + 1,
      ownerId: userId,
      id: 'profile_future',
      futureOnly: true,
    };

    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify(futureRecord, null, 2), 'utf8');

    await expect(store.writeRecallJsonRecord(userId, 'profiles', 'profile_future', {
      schemaVersion: store.RECALL_SCHEMA_VERSION,
      ownerId: userId,
      id: 'profile_future',
      futureOnly: false,
    })).rejects.toThrow(/future schema/i);
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8'))).toEqual(futureRecord);
  });
});
