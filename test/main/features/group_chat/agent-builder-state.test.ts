import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILDER_FLOW_TTL_MS, clearBuilderFlow, isExpired, readBuilderFlow, writeBuilderFlow,
} from '../../../../src/main/features/group_chat/agent-builder-state';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builder-state-'));
const UID = 'u1'; const CID = 'c1';
const BASE = { version: 1, cid: CID, agentId: '287ce6012204', mode: 'governed' as const, draftId: 'draft-1' };

/** Write raw bytes straight to the state file (bypasses validation on write). */
function writeRaw(state: unknown): void {
  fs.mkdirSync(path.join(tmp, UID, CID), { recursive: true });
  fs.writeFileSync(path.join(tmp, UID, CID, 'builder-flow.json'), JSON.stringify(state));
}

describe('agent-builder-state', () => {
  beforeEach(() => { fs.rmSync(path.join(tmp, 'u1'), { recursive: true, force: true }); });
  it('round-trips state', async () => {
    await writeBuilderFlow(UID, CID, { ...BASE, stage: 'awaiting_confirm', expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() }, { dir: tmp });
    const s = await readBuilderFlow(UID, CID, { dir: tmp });
    expect(s?.stage).toBe('awaiting_confirm');
    expect(s?.draftId).toBe('draft-1');
    expect(s?.version).toBe(1);
  });
  it('returns null when absent', async () => {
    expect(await readBuilderFlow(UID, 'missing', { dir: tmp })).toBeNull();
  });
  it('clears state', async () => {
    await writeBuilderFlow(UID, CID, { ...BASE, stage: 'done', expiresAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, { dir: tmp });
    await clearBuilderFlow(UID, CID, { dir: tmp });
    expect(await readBuilderFlow(UID, CID, { dir: tmp })).toBeNull();
  });
  it('returns null for malformed JSON', async () => {
    fs.mkdirSync(path.join(tmp, UID, CID), { recursive: true });
    fs.writeFileSync(path.join(tmp, UID, CID, 'builder-flow.json'), '{ not json');
    expect(await readBuilderFlow(UID, CID, { dir: tmp })).toBeNull();
  });
  it('returns null for malformed state', async () => {
    const base = { ...BASE, expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: new Date().toISOString() };
    writeRaw({ ...base, stage: 'bogus_stage' });
    expect(await readBuilderFlow(UID, CID, { dir: tmp })).toBeNull();
    writeRaw({ ...base, stage: 'awaiting_confirm', agentId: '' });
    expect(await readBuilderFlow(UID, CID, { dir: tmp })).toBeNull();
    const { expiresAt: _omit, ...noExpiry } = base;
    void _omit;
    writeRaw({ ...noExpiry, stage: 'awaiting_confirm' });
    expect(await readBuilderFlow(UID, CID, { dir: tmp })).toBeNull();
  });
  it('corrupt expiresAt does not produce a never-expiring flow', async () => {
    writeRaw({ ...BASE, stage: 'awaiting_confirm', expiresAt: 'not-a-date', updatedAt: new Date().toISOString() });
    const s = await readBuilderFlow(UID, CID, { dir: tmp });
    expect(s).not.toBeNull();
    expect(s && isExpired(s)).toBe(true);
  });
  it('isExpired treats invalid expiresAt as expired', () => {
    expect(isExpired({ ...BASE, stage: 'awaiting_confirm', expiresAt: 'garbage', updatedAt: '' })).toBe(true);
    expect(isExpired({ ...BASE, stage: 'awaiting_confirm', expiresAt: '', updatedAt: '' })).toBe(true);
  });
  it('isExpired respects TTL', () => {
    expect(isExpired({ ...BASE, stage: 'awaiting_confirm', expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: '' })).toBe(false);
    expect(isExpired({ ...BASE, stage: 'awaiting_confirm', expiresAt: new Date(Date.now() - 1_000).toISOString(), updatedAt: '' })).toBe(true);
    expect(BUILDER_FLOW_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
