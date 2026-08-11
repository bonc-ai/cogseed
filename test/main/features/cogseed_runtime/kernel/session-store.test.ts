import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../../../../src/main/paths';
import {
  appendNativeSessionRecord,
  claimRuntimeRequest,
  createNativeRuntimeSession,
  readNativeRuntimeSession,
  runtimeRequestLedgerFile,
} from '../../../../../src/main/features/cogseed_runtime/kernel/session-store';

const UID = 'native-kernel-session-user';

afterEach(() => {
  fs.rmSync(paths.userRoot(UID), { recursive: true, force: true });
});

describe('native Runtime session store', () => {
  it('creates a native header under local/mate_runtime/sessions', async () => {
    const sid = 'mruntime-native1';
    await createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:00');
    await createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:01');

    const file = paths.mateRuntimeSessionFile(UID, sid);
    expect(file).toBe(path.join(paths.userLocalRoot(UID), 'mate_runtime', 'sessions', `${sid}.jsonl`));
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(paths.userSessionFile(UID, sid))).toBe(false);

    const session = await readNativeRuntimeSession(UID, sid);
    expect(session.header).toEqual({
      type: 'session_header',
      version: 1,
      kernel: 'mate-agent-native',
      runtime_session_id: sid,
      created_at: '2026-08-04T00:00:00',
    });
    expect(session.records).toHaveLength(1);
  });

  it('serializes concurrent first-time native session creation', async () => {
    const sid = 'mruntime-native-create-race';
    await Promise.all(Array.from({ length: 10 }, () =>
      createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:00')));

    const session = await readNativeRuntimeSession(UID, sid);
    expect(session.records).toEqual([
      {
        type: 'session_header',
        version: 1,
        kernel: 'mate-agent-native',
        runtime_session_id: sid,
        created_at: '2026-08-04T00:00:00',
      },
    ]);
  });

  it('appends native records after the header', async () => {
    const sid = 'mruntime-native2';
    await createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:00');
    await appendNativeSessionRecord(UID, sid, {
      type: 'turn',
      request_id: 'req-turn1',
      role: 'user',
      content: 'hello',
      created_at: '2026-08-04T00:00:01',
    });

    const session = await readNativeRuntimeSession(UID, sid);
    expect(session.records).toEqual([
      {
        type: 'session_header',
        version: 1,
        kernel: 'mate-agent-native',
        runtime_session_id: sid,
        created_at: '2026-08-04T00:00:00',
      },
      {
        type: 'turn',
        request_id: 'req-turn1',
        role: 'user',
        content: 'hello',
        created_at: '2026-08-04T00:00:01',
      },
    ]);
  });

  it('claims request ids idempotently', async () => {
    const first = await claimRuntimeRequest(UID, 'mruntime-native3', 'req-dup', 'run-a', '2026-08-04T00:00:00');
    const second = await claimRuntimeRequest(UID, 'mruntime-native3', 'req-dup', 'run-b', '2026-08-04T00:00:01');

    expect(first).toEqual({ claimed: true });
    expect(second).toEqual({ claimed: false, existingRunId: 'run-a', status: 'running' });
    expect(runtimeRequestLedgerFile(UID)).toBe(path.join(paths.mateRuntimeRoot(UID), 'request-ledger.json'));
    expect(fs.existsSync(runtimeRequestLedgerFile(UID))).toBe(true);
  });

  it('rejects invalid request and run ids', async () => {
    await expect(claimRuntimeRequest(UID, 'mruntime-native4', 'bad-req', 'run-a', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime request id/);
    await expect(claimRuntimeRequest(UID, 'mruntime-native4', '../escape', 'run-a', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime request id/);
    await expect(claimRuntimeRequest(UID, 'mruntime-native4', 'req-valid', '../escape', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime run id/);
  });

  it('serializes concurrent duplicate request claims in this process', async () => {
    const results = await Promise.all([
      claimRuntimeRequest(UID, 'mruntime-native-concurrent', 'req-race', 'run-a', '2026-08-04T00:00:00'),
      claimRuntimeRequest(UID, 'mruntime-native-concurrent', 'req-race', 'run-b', '2026-08-04T00:00:00'),
    ]);

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(1);
    const loser = results.find((r) => !r.claimed);
    expect(loser).toEqual(expect.objectContaining({ claimed: false, status: 'running' }));
  });

  it('rejects invalid runtime session ids', async () => {
    await expect(createNativeRuntimeSession(UID, 'gconv-not-runtime', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime session id/);
    await expect(createNativeRuntimeSession(UID, '../escape', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime session id/);
  });

  it('rejects malformed native turn records while reading history', async () => {
    const sid = 'mruntime-malformed-turn';
    const file = paths.mateRuntimeSessionFile(UID, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'session_header',
        version: 1,
        kernel: 'mate-agent-native',
        runtime_session_id: sid,
        created_at: '2026-08-04T00:00:00',
      }),
      JSON.stringify({ type: 'turn', request_id: 'bad-req', role: 'user', content: 'hello', created_at: '2026-08-04T00:00:01' }),
    ].join('\n') + '\n');

    await expect(readNativeRuntimeSession(UID, sid)).rejects.toThrow(/invalid native runtime session record/);
  });

  it('rejects repeated native headers while reading history', async () => {
    const sid = 'mruntime-repeated-header';
    const file = paths.mateRuntimeSessionFile(UID, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const header = {
      type: 'session_header',
      version: 1,
      kernel: 'mate-agent-native',
      runtime_session_id: sid,
      created_at: '2026-08-04T00:00:00',
    };
    fs.writeFileSync(file, [JSON.stringify(header), JSON.stringify(header)].join('\n') + '\n');

    await expect(readNativeRuntimeSession(UID, sid)).rejects.toThrow(/invalid native runtime session record/);
  });

  it('rejects corrupt request ledgers without overwriting them', async () => {
    const ledgerFile = runtimeRequestLedgerFile(UID);
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, '{ corrupt json', 'utf8');

    await expect(claimRuntimeRequest(UID, 'mruntime-native-ledger', 'req-ledger', 'run-a', '2026-08-04T00:00:00')).rejects.toThrow(/invalid runtime request ledger/);
    expect(fs.readFileSync(ledgerFile, 'utf8')).toBe('{ corrupt json');
  });

  it('refuses to treat legacy core-agent-shaped mruntime files as native history', async () => {
    const sid = 'mruntime-legacy';
    const file = paths.mateRuntimeSessionFile(UID, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'legacy core-agent line' }) + '\n');

    await expect(readNativeRuntimeSession(UID, sid)).rejects.toThrow(/legacy core-agent runtime session/);
    await expect(createNativeRuntimeSession(UID, sid, '2026-08-04T00:00:00')).rejects.toThrow(/legacy core-agent runtime session/);
  });
});
