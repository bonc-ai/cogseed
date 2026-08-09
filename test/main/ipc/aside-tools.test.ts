import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

/**
 * Guards the aside's read-only property at the boundary that actually decides
 * it: the options handed to the model client.
 *
 * `maxToolLoops: 0` does NOT disable tools — it is dropped as falsy by the
 * option spreads between client.ts and runner.ts, leaving the full local tool
 * set (write_file, delete_file, bash, …) attached. Only `disableTools` empties
 * the tool array, so that flag is asserted here explicitly.
 */

let invokeHandler: any = null;
let streamStartHandler: any = null;
const modelCalls: any[] = [];

vi.mock('electron', () => ({
  ipcMain: {
    handle: (c: string, f: any) => { if (c === 'orkas.invoke') invokeHandler = f; },
    on: (c: string, f: any) => { if (c === 'orkas.streamStart') streamStartHandler = f; },
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: false },
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logFromRenderer: vi.fn(),
}));

let root = '';
const UID = 'asideToolUser';

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-tools-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  invokeHandler = null;
  streamStartHandler = null;
  modelCalls.length = 0;
  vi.resetModules();
  vi.doMock('../../../src/main/ipc/local_agents', () => ({ invokeHandlers: {} }));
  // Stub the model so no provider/auth is needed; record what it was asked for.
  vi.doMock('../../../src/main/model/client', () => ({
    streamChatWithModel: (opts: any) => {
      modelCalls.push(opts);
      return (async function* () { yield { type: 'delta', text: 'explained' }; })();
    },
    chatWithModel: vi.fn(),
    abortActiveSession: vi.fn(),
    abortActiveSessionsForConversation: vi.fn(),
  }));
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
  (await import('../../../src/main/ipc/index')).register();
});
afterEach(() => {
  delete process.env.ORKAS_WORKSPACE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

/** Drive a stream channel and collect what the renderer would receive. */
async function runStream(channel: string, payload: any): Promise<any[]> {
  const events: any[] = [];
  const sender = {
    ...trustedIpcSender(),
    isDestroyed: () => false,
    send: (_ch: string, ev: any) => { events.push(ev); },
  };
  await streamStartHandler({ sender }, { requestId: `req-${Date.now()}`, channel, payload });
  // Let the generator drain.
  for (let i = 0; i < 50 && !events.some((e) => e?.type === 'done'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return events;
}

async function seedConversation(): Promise<string> {
  const chats = await import('../../../src/main/features/chats');
  const conv = await chats.createConversation(UID, { title: 'Task' });
  const { conversationMessageFile } = await import('../../../src/main/util/project-layout');
  const file = conversationMessageFile(UID, conv.conversation_id, null);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = Array.from({ length: 8 }, (_, i) => JSON.stringify({
    id: `m${i}`, ts: new Date(Date.UTC(2026, 7, 5, 0, 0, i)).toISOString(),
    from: i % 2 === 0 ? 'user' : 'assistant', to: [], text: `message ${i}`,
  }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return conv.conversation_id;
}

describe('aside askStream — tool lockdown', () => {
  it('asks the model with every tool disabled', async () => {
    const cid = await seedConversation();

    await runStream('aside.askStream', { cid, anchor_msg_id: 'm4', question: 'explain this' });

    expect(modelCalls).toHaveLength(1);
    const opts = modelCalls[0];
    // The flag that actually empties the tool array.
    expect(opts.disableTools).toBe(true);
    // No skills injected into the prompt either.
    expect(opts.skillList).toEqual([]);
    // maxToolLoops is deliberately NOT relied upon (falsy values get dropped).
    expect(opts.maxToolLoops).toBeUndefined();
  });

  it('scopes the model session to the aside, not the task session', async () => {
    const cid = await seedConversation();
    await runStream('aside.askStream', { cid, anchor_msg_id: 'm3', question: 'explain' });
    expect(modelCalls[0].sessionId).toBe(`aside-${cid}`);
  });

  it('sends the anchored context and the read-only contract', async () => {
    const cid = await seedConversation();
    await runStream('aside.askStream', { cid, anchor_msg_id: 'm4', question: 'explain this' });
    const opts = modelCalls[0];
    expect(opts.message).toContain('→ [user] message 4');
    expect(opts.message).toContain('explain this');
    expect(opts.systemPrompt).toContain('只解释，不执行');
  });

  it('records the answer as an aside turn, leaving the transcript untouched', async () => {
    const cid = await seedConversation();
    const { conversationMessageFile } = await import('../../../src/main/util/project-layout');
    const transcript = conversationMessageFile(UID, cid, null);
    const before = fs.readFileSync(transcript, 'utf8');

    await runStream('aside.askStream', { cid, anchor_msg_id: 'm4', question: 'explain this' });

    const aside = await import('../../../src/main/features/conversation_aside');
    const turns = await aside.listAsideTurns(UID, cid, null);
    expect(turns).toHaveLength(1);
    expect(turns[0].answer).toBe('explained');
    expect(fs.readFileSync(transcript, 'utf8')).toBe(before);
  });

  it('refuses an unknown conversation without calling the model', async () => {
    const events = await runStream('aside.askStream', {
      cid: 'ffffffffffff', anchor_msg_id: 'm1', question: 'explain',
    });
    expect(events.some((e) => e?.type === 'error')).toBe(true);
    expect(modelCalls).toHaveLength(0);
  });

  it('rejects a malformed cid without calling the model', async () => {
    const events = await runStream('aside.askStream', {
      cid: '../escape', anchor_msg_id: 'm1', question: 'explain',
    });
    expect(events.some((e) => e?.type === 'error' && /invalid cid/.test(e.text))).toBe(true);
    expect(modelCalls).toHaveLength(0);
  });
});
