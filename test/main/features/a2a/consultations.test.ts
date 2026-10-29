import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Consultations are where the receiver's judgement enters the exchange (R-11/D-7),
 * so the cases that matter are the refusals: a revise without wording must not
 * silently send the assistant's draft, an already-answered consultation must not be
 * answered twice, and nothing but an approved/revised reply may cross to the peer.
 */
const UID = 'a2a-consult-user';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-consult-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmp;
  vi.resetModules();
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function mod() {
  return import('../../../../src/main/features/a2a/consultations');
}

const base = { conversationId: 'conv-a2a-1', peerUserId: 'cs_alice', peerName: 'Alice', question: '报价能给吗', proposedReply: '可以打八折' };

describe('a2a consultations › lifecycle', () => {
  it('creates a pending consultation and lists it by conversation', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    expect(created).toMatchObject({ state: 'pending', question: '报价能给吗' });
    const listed = await c.listConsultations(UID, { conversationId: 'conv-a2a-1' });
    expect(listed.map((row) => row.id)).toEqual([created.id]);
    expect(await c.listConsultations(UID, { conversationId: 'conv-other' })).toEqual([]);
  });

  it('rejects an incomplete consultation', async () => {
    const c = await mod();
    await expect(c.createConsultation(UID, { ...base, question: '  ' })).rejects.toThrow(/question is required/);
    await expect(c.createConsultation(UID, { ...base, proposedReply: '' })).rejects.toThrow(/proposed reply is required/);
  });
});

describe('a2a consultations › answering', () => {
  it('approve sends the proposed wording unchanged', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    const answered = await c.answerConsultation(UID, created.id, 'approve');
    expect(answered).toMatchObject({ state: 'approved', finalReply: '可以打八折' });
    expect(c.outboundConsultationReply(answered!)).toBe('可以打八折');
  });

  it('revise needs the receiver\'s own wording and uses it', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    await expect(c.answerConsultation(UID, created.id, 'revise')).rejects.toThrow(/revise requires the new wording/);
    // 未改写成功时仍是 pending，不会被当成已批准发出去。
    expect((await c.listConsultations(UID, { state: 'pending' })).length).toBe(1);
    const answered = await c.answerConsultation(UID, created.id, 'revise', '最多九折');
    expect(answered).toMatchObject({ state: 'revised', finalReply: '最多九折' });
    expect(c.outboundConsultationReply(answered!)).toBe('最多九折');
  });

  it('decline sends nothing to the peer', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    const answered = await c.answerConsultation(UID, created.id, 'decline');
    expect(answered).toMatchObject({ state: 'declined' });
    expect(answered!.finalReply).toBeUndefined();
    expect(c.outboundConsultationReply(answered!)).toBeNull();
  });

  it('refuses to answer a consultation twice', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    await c.answerConsultation(UID, created.id, 'approve');
    await expect(c.answerConsultation(UID, created.id, 'decline')).rejects.toThrow(/not pending/);
  });
});

describe('a2a consultations › 5-minute nudge (D-23)', () => {
  it('does not nudge a fresh pending consultation', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    expect(c.needsNudge(created)).toBe(false);
  });

  it('nudges once the window passed, and never after it was answered', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    const later = Date.parse(created.createdAt) + c.A2A_CONSULTATION_NUDGE_MS + 1;
    expect(c.needsNudge(created, later)).toBe(true);
    const answered = await c.answerConsultation(UID, created.id, 'decline');
    expect(c.needsNudge(answered!, later + 60000)).toBe(false);
  });

  it('marks the nudge once and does not repeat it', async () => {
    const c = await mod();
    const created = await c.createConsultation(UID, base);
    const later = Date.parse(created.createdAt) + c.A2A_CONSULTATION_NUDGE_MS + 1;
    const first = await c.nudgePendingConsultations(UID, later);
    expect(first.map((row) => row.id)).toEqual([created.id]);
    expect(first[0].nudgedAt).toBeTruthy();
    expect(await c.nudgePendingConsultations(UID, later + 60000)).toEqual([]);

    const fresh = await c.createConsultation(UID, { ...base, conversationId: 'conv-a2a-2' });
    expect(await c.nudgePendingConsultations(UID, Date.parse(fresh.createdAt) + 1000)).toEqual([]);
  });
});
