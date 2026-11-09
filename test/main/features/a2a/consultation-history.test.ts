/** Durable visitor-history privacy: a terminal model bubble is not evidence
 * that the visitor received it when a private consultation interrupted dispatch. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const UID = 'history-owner', CID = 'a2a-history', PEER = 'cs_history', SOURCE = 'private-incoming';
const PRIVATE = 'PRIVATE deliberation and rejected proposal';
const turnId = 'turn-a2a-in-' + createHash('sha256').update(SOURCE).digest('hex').slice(0, 20);
const publicTurnId = 'turn-a2a-in-' + createHash('sha256').update('public-incoming').digest('hex').slice(0, 20);
let root: string, previous: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-history-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
  const { appendJsonl } = await import('../../../../src/main/storage');
  const { conversationMessageFile } = await import('../../../../src/main/util/project-layout');
  const file = conversationMessageFile(UID, CID);
  for (const row of [
    { id: publicTurnId.slice(5), from: 'a2a_' + PEER, to: ['commander'], text: 'Already public question' },
    { from: 'commander', to: ['user'], text: 'Already public answer', turn_id: publicTurnId, turn_end: true },
    { id: turnId.slice(5), from: 'a2a_' + PEER, to: ['commander'], text: 'Question needing owner decision' },
    { from: 'commander', to: ['user'], text: PRIVATE, turn_id: turnId, turn_end: true },
  ]) await appendJsonl(file, row);
});
afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['pending', 'approved', 'revised', 'declined', 'missing-row', 'missing-ledger-flag', 'unpersisted-marker'])('keeps private terminal prose out of the next visitor model context after %s', async state => {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userA2AReceptionLedgerFile, userA2AConsultationsFile } = await import('../../../../src/main/paths');
  await writeJson(userA2AReceptionLedgerFile(UID), { version: 1, entries: state === 'missing-ledger-flag' ? [] : [
    { messageId: SOURCE, conversationId: CID, status: 'running', stage: 'enqueued', consultationRequested: state !== 'unpersisted-marker' },
  ] });
  if (!['missing-row', 'unpersisted-marker'].includes(state)) await writeJson(userA2AConsultationsFile(UID), { version: 1, consultations: [
    { id: 'acons-history', conversationId: CID, sourceMessageId: SOURCE, turnId, peerUserId: PEER,
      question: 'Private owner question', proposedReply: 'Private proposal', state: state === 'missing-ledger-flag' ? 'pending' : state,
      ...(state === 'approved' || state === 'revised' ? { finalReply: 'Owner selected public wording', delivery: { state: 'sent' } } : {}) },
  ] });
  const { loadReceptionHistory, replayReceptionHistory } = await import('../../../../src/main/features/a2a/reception-context');
  const history = await loadReceptionHistory(UID, { conversationId: CID, sourceActorId: 'a2a_' + PEER, root });
  expect(history).toEqual([{ question: 'Already public question', answer: 'Already public answer' }]);
  const { Session } = await import('#core-agent');
  const session = new Session();
  replayReceptionHistory(session, history);
  session.beginUserTurn([{ type: 'text', text: 'Next visitor question' }]);
  for (const view of [session.getMessagesForModel(), session.getMessagesForSummary()]) {
    const text = JSON.stringify(view);
    expect(text).toContain('Already public answer');
    expect(text).toContain('Next visitor question');
    expect(text).not.toContain(PRIVATE);
    expect(text).not.toContain('Private owner question');
    expect(text).not.toContain('Private proposal');
  }
});

it('uses no visitor history when consultation privacy records are unreadable', async () => {
  const { userA2AConsultationsFile } = await import('../../../../src/main/paths');
  const file = userA2AConsultationsFile(UID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ PRIVATE damaged record');
  const { loadReceptionHistory } = await import('../../../../src/main/features/a2a/reception-context');
  expect(await loadReceptionHistory(UID, { conversationId: CID, sourceActorId: 'a2a_' + PEER, root })).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe('{ PRIVATE damaged record');
});

it.each(['answered', 'running', 'uncertain', 'failed'])('requires a successful public send receipt for a known %s dispatch', async status => {
  const { writeJson } = await import('../../../../src/main/storage');
  const { userA2AReceptionLedgerFile } = await import('../../../../src/main/paths');
  await writeJson(userA2AReceptionLedgerFile(UID), { version: 1, entries: [
    { messageId: SOURCE, conversationId: CID, consultationRequested: true },
    { messageId: 'public-incoming', conversationId: CID, status, stage: status === 'answered' ? 'sent' : 'enqueued',
      ...(status === 'answered' ? { answer: { ok: true, relayMessageId: 'known-public-ack' } } : {}) },
  ] });
  const { loadReceptionHistory } = await import('../../../../src/main/features/a2a/reception-context');
  expect(await loadReceptionHistory(UID, { conversationId: CID, sourceActorId: 'a2a_' + PEER, root }))
    .toEqual(status === 'answered' ? [{ question: 'Already public question', answer: 'Already public answer' }] : []);
});
