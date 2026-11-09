/** Offline production assembly: actual users, reception store, buildRunner and
 * SDK execution. Only model transport and bus/relay edges are synthetic. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentRunEvent, LLMProvider } from '#core-agent';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: vi.fn(), dialog: {}, shell: {} }));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const UID = 'consult-runner-owner';
const PEER = 'cs_consult_peer';
const CID = 'a2a-0123456789abcdef0462';
const MESSAGE_ID = 'consult-runner-question';
const PRIVATE_TEXT = 'PRIVATE MODEL REASONING DO NOT FORWARD';
const PROPOSAL = 'An exception requiring owner approval';
const ENV_KEYS = ['COGSEED_WORKSPACE_ROOT', 'CORE_AGENT_AUTH_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'] as const;
const previous: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {};
const network = vi.fn(() => { throw new Error('This integration test must remain offline'); });
let root: string;
let question: { messageId: string; conversationId: string; fromAccount: string; toAccount: string; createdAt: string; text: string };

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consult-runner-')));
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  process.env.COGSEED_WORKSPACE_ROOT = root;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  vi.resetModules();
  network.mockClear();
  vi.stubGlobal('fetch', network);

  // Real activation is essential: consultation scope checks the live uid.
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  expect(users.getActiveUserId()).toBe(UID);
  const auth = await import('../../../../src/main/features/auth');
  vi.spyOn(auth, 'pickChatEntryGroupForUser').mockResolvedValue([
    { entryId: 'offline-consult', profileId: 'offline-consult', provider: 'openai', model: 'gpt-4o', apiKey: 'synthetic-only' },
  ]);
  const { saveHubSession } = await import('../../../../src/main/features/hub_account/tokens');
  const { writeHubAccountState } = await import('../../../../src/main/features/hub_account/state');
  saveHubSession(UID, { session_id: 'offline-session', access_token: 'fixture', refresh_token: 'fixture',
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(), refresh_expires_at: new Date(Date.now() + 7200_000).toISOString() });
  writeHubAccountState(UID, { account_id: UID });
  const { writeJson } = await import('../../../../src/main/storage');
  const { userContactsFile } = await import('../../../../src/main/paths');
  await writeJson(userContactsFile(UID), { version: 1, contacts: [{ userId: PEER, name: 'Visitor', addedAt: new Date().toISOString() }] });
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(UID, { conversationId: CID, title: 'Private decision integration' });
  await chats.updateConversation(UID, CID, { a2a: { role: 'receiver', state: 'active', exchange_id: CID, peer_user_id: PEER, workspace: root } });
  const conversation = await chats.getConversation(UID, CID);
  question = { messageId: MESSAGE_ID, conversationId: CID, fromAccount: PEER, toAccount: UID, createdAt: new Date().toISOString(), text: 'Can the owner approve this exception?' };
  const ledger = await import('../../../../src/main/features/a2a/reception-ledger');
  expect(await ledger.journalReception(UID, { ...question, peerUserId: PEER, generation: conversation!._cogseed_result_generation! })).toBe(true);
  const [entry] = await ledger.readReceptionLedger(UID);
  expect(await ledger.updateReceptionEntry(UID, entry, row => ({ ...row, admission: 'committed' }))).not.toBeNull();
});

afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  await drainMainRuntimeForTest(UID);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

it('executes the host consultation tool with the original dispatch turn and suppresses SDK private final text', async () => {
  const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
  const { runReception, recoverClaimedReceptions } = await import('../../../../src/main/features/a2a/reception-run');
  const { listConsultations } = await import('../../../../src/main/features/a2a/consultations');
  const relay = vi.fn(async () => ({ messageId: 'must-not-forward' }));
  const events: AgentRunEvent[] = [];
  const expectedTurnId = 'turn-a2a-in-' + createHash('sha256').update(MESSAGE_ID).digest('hex').slice(0, 20);
  let listener: ((event: any) => void) | undefined;
  let modelCalls = 0;
  const complete = vi.fn(async () => { throw new Error('No extra synthesis/model request is allowed'); });
  const provider: LLMProvider = {
    id: 'openai', name: 'Offline consultation provider', validateAuth: async () => true, complete,
    async *stream() {
      if (++modelCalls > 1) throw new Error('The consultation tool must end the SDK turn');
      yield { type: 'text_delta', text: PRIVATE_TEXT };
      yield { type: 'message_end', model: 'gpt-4o', stopReason: 'tool_use', content: [
        { type: 'text', text: PRIVATE_TEXT },
        { type: 'tool_use', id: 'private-consultation', name: 'request_a2a_consultation', input: { question: 'Private owner-only question', proposedReply: PROPOSAL } },
      ], usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } };
    },
  };
  const result = await runReception(UID, question, {
    send: relay,
    timeoutMs: 10_000,
    addMember: async () => true,
    subscribe: async (_uid, _cid, next) => { listener = next; return () => { listener = undefined; }; },
    enqueue: async input => {
      expect(input.dispatchTurnId).toBe(expectedTurnId);
      expect(input.fromActorId).toBe('a2a_' + PEER);
      const built = await buildRunner({
        userId: UID, cid: input.cid, sessionId: 'gworker-consultation-integration',
        ephemeralSession: true, skillList: [], systemPrompt: 'Use the private consultation tool, then stop.',
        turnId: input.dispatchTurnId,
        receptionScope: { sourceActorId: input.fromActorId, conversationId: input.cid, root },
        toolAllowlist: ['request_a2a_consultation'],
      });
      expect(built.toolDefs.find(tool => tool.name === 'request_a2a_consultation')).toMatchObject({ source: 'cogseed' });
      vi.spyOn(built.runner.getProviders(), 'get').mockReturnValue(provider);
      for await (const event of built.runner.runStream({ message: input.model_text || input.text })) events.push(event);
      const done = events.find(event => event.type === 'done');
      expect(done).toBeDefined();
      if (!done || done.type !== 'done') throw new Error('SDK did not finish the consultation turn');
      // The SDK really retains streamed private text as final on endTurn. Feed
      // that actual result into reception's bus boundary to prove host suppression.
      expect(done.result.text).toContain(PRIVATE_TEXT);
      listener!({ type: 'message', turn_end: true, turn_id: input.dispatchTurnId,
        msg: { from: 'commander', to: ['user'], text: done.result.text } });
    },
  });
  const toolEnd = events.find(event => event.type === 'tool_end' && event.name === 'request_a2a_consultation');
  expect(toolEnd).toBeDefined();
  if (!toolEnd || toolEnd.type !== 'tool_end') throw new Error('Host tool did not execute');
  expect(toolEnd.isError).not.toBe(true);
  const receipt = JSON.parse(toolEnd.result);
  expect(receipt).toMatchObject({ state: 'pending' });
  expect(modelCalls).toBe(1);
  expect(complete).not.toHaveBeenCalled();
  expect(result).toEqual({ status: 'awaiting_owner' });
  const rows = await listConsultations(UID, { conversationId: CID });
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(receipt.consultationId);
  expect(rows[0]).toMatchObject({ state: 'pending', peerUserId: PEER, sourceMessageId: MESSAGE_ID, turnId: expectedTurnId,
    toAccount: UID, workspace: root, question: 'Private owner-only question', proposedReply: PROPOSAL });
  expect(rows[0].generation).toBeTruthy();
  expect(relay).not.toHaveBeenCalled();
  await recoverClaimedReceptions(UID, { send: relay });
  expect(relay).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});
