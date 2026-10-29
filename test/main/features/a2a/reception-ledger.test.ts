import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmp: string;
let previous: string | undefined;
const uid = 'ledger-user';
const identity = {
  messageId: 'message-1', conversationId: 'a2a-0123456789abcdef0123',
  peerUserId: 'peer-1', text: 'question', generation: 'generation-1',
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-ledger-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('durable reception ledger identity', () => {
  it('normalizes before journaling and replaces only the same full identity', async () => {
    const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
    await ledger.journalReception(uid, { ...identity, text: '  question  ' });
    expect(await ledger.readReceptionLedger(uid)).toEqual([expect.objectContaining(identity)]);
    expect(await ledger.updateReceptionEntry(uid, { ...identity, generation: 'stale-generation' },
      (row) => ({ ...row, status: 'answered' }))).toBeNull();
    expect(await ledger.updateReceptionEntry(uid, identity,
      (row) => ({ ...row, messageId: 'replacement' }))).toBeNull();
    await ledger.updateReceptionEntry(uid, identity, (row) => ({ ...row, stage: 'reserved', status: 'running' }));
    expect(await ledger.readReceptionLedger(uid)).toEqual([expect.objectContaining({ ...identity, stage: 'reserved' })]);
  });

  it.each(['messageId', 'generation'] as const)('detects a changed %s even when the remaining payload is intact', async (field) => {
    const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
    await ledger.journalReception(uid, identity);
    const [entry] = await ledger.readReceptionLedger(uid);
    expect(ledger.validReceptionPayload({ ...entry, [field]: 'tampered' })).toBe(false);
  });

  it('preserves deduplication receipts beyond the old terminal retention limit', async () => {
    const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
    const storage = await import('../../../../src/main/storage');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    await ledger.journalReception(uid, identity);
    const [entry] = await ledger.readReceptionLedger(uid);
    const entries = Array.from({ length: 201 }, (_, index) => {
      const row = { ...entry, messageId: `terminal-${index}`, status: 'answered' };
      return { ...row, payloadHash: ledger.receptionPayloadHash(row) };
    });
    await storage.writeJson(userA2AReceptionLedgerFile(uid), { version: 1, entries });
    await ledger.journalReception(uid, identity);
    expect(await ledger.readReceptionLedger(uid)).toHaveLength(202);
    expect(await ledger.journalReception(uid, { ...identity, messageId: 'terminal-0', text: 'conflict' })).toBe(false);
  });

  it.each(['invalid-json', 'invalid-shape'] as const)('does not overwrite a %s ledger as an empty inbox', async (kind) => {
    const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
    const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
    await ledger.journalReception(uid, identity);
    const file = userA2AReceptionLedgerFile(uid);
    const corrupt = kind === 'invalid-json' ? '{broken' : '{"version":1,"entries":{}}';
    fs.writeFileSync(file, corrupt);
    await expect(ledger.journalReception(uid, { ...identity, messageId: 'another' })).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(corrupt);
  });
});
