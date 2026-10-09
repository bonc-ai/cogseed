import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const ASIDE = '../../../src/main/features/conversation_aside';
const LAYOUT = '../../../src/main/util/project-layout';
const PATHS = '../../../src/main/paths';

let uid = '';
beforeEach(() => { uid = `askaside-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import(PATHS);
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

async function seedConversation(cid: string, count = 10): Promise<void> {
  const { conversationMessageFile } = await import(LAYOUT);
  const file = conversationMessageFile(uid, cid, null);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
    id: `m${i}`, ts: new Date(Date.UTC(2026, 7, 5, 0, 0, i)).toISOString(),
    from: i % 2 === 0 ? 'user' : 'assistant', to: [], text: `message ${i}`,
  }));
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

/** Model stub yielding fixed deltas. */
function streamStub(chunks: string[], opts: { capture?: any[] } = {}) {
  return (input: any) => {
    if (opts.capture) opts.capture.push(input);
    return (async function* () {
      for (const text of chunks) yield { type: 'delta', text };
    })();
  };
}

const deps = (stream: any, agent: any = null) => ({
  getAgent: async () => agent,
  isAgentEnabled: () => !!agent,
  stream,
});

async function drain(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('askAside — streaming and persistence', () => {
  it('streams deltas then persists a single final turn', async () => {
    const mod = await import(ASIDE);
    const cid = 'askaside01';
    await seedConversation(cid);

    const events = await drain(mod.askAside(uid, {
      cid, anchorMsgId: 'm6', question: 'why freeze first?',
    }, deps(streamStub(['because ', 'the comparison ', 'would be void']))));

    expect(events.filter((e) => e.type === 'delta').map((e) => e.text))
      .toEqual(['because ', 'the comparison ', 'would be void']);
    const final = events.find((e) => e.type === 'final');
    expect(final.text).toBe('because the comparison would be void');
    expect(final.turn.anchorIndex).toBe(6);

    const turns = await mod.listAsideTurns(uid, cid);
    expect(turns).toHaveLength(1);
    expect(turns[0].answer).toBe('because the comparison would be void');
  });

  it('sends the anchored context and the read-only contract to the model', async () => {
    const mod = await import(ASIDE);
    const cid = 'askaside02';
    await seedConversation(cid);
    const capture: any[] = [];

    await drain(mod.askAside(uid, {
      cid, anchorMsgId: 'm4', question: 'explain',
    }, deps(streamStub(['ok'], { capture }))));

    const call = capture[0];
    expect(call.message).toContain('→ [user] message 4');
    expect(call.message).toContain('explain');
    expect(call.systemPrompt).toContain('只解释，不执行');
    // Aside-scoped session: never shares state with the task's own session.
    expect(call.sessionId).toBe(`aside-${cid}`);
  });

  it('persists nothing when the model errors', async () => {
    const mod = await import(ASIDE);
    const cid = 'askaside03';
    await seedConversation(cid);

    const failing = () => (async function* () {
      yield { type: 'delta', text: 'partial' };
      yield { type: 'error', text: 'provider down' };
    })();

    const events = await drain(mod.askAside(uid, {
      cid, anchorMsgId: 'm3', question: 'explain',
    }, deps(failing)));

    expect(events.at(-1)).toEqual({ type: 'error', text: 'provider down' });
    // A failed ask must not leave a half-written turn that later replays as context.
    await expect(mod.listAsideTurns(uid, cid)).resolves.toEqual([]);
  });

  it('persists nothing when the model throws', async () => {
    const mod = await import(ASIDE);
    const cid = 'askaside04';
    await seedConversation(cid);

    const throwing = () => (async function* () {
      yield { type: 'delta', text: 'x' };
      throw new Error('socket closed');
    })();

    const events = await drain(mod.askAside(uid, {
      cid, anchorMsgId: 'm3', question: 'explain',
    }, deps(throwing)));

    expect(events.at(-1).type).toBe('error');
    await expect(mod.listAsideTurns(uid, cid)).resolves.toEqual([]);
  });

  it('rejects an empty answer rather than storing a blank turn', async () => {
    const mod = await import(ASIDE);
    const cid = 'askaside05';
    await seedConversation(cid);

    const events = await drain(mod.askAside(uid, {
      cid, anchorMsgId: 'm3', question: 'explain',
    }, deps(streamStub(['   ']))));

    expect(events.at(-1)).toEqual({ type: 'error', text: 'empty answer' });
    await expect(mod.listAsideTurns(uid, cid)).resolves.toEqual([]);
  });

  it('never writes to the main transcript', async () => {
    const mod = await import(ASIDE);
    const { conversationMessageFile } = await import(LAYOUT);
    const cid = 'askaside06';
    await seedConversation(cid);
    const file = conversationMessageFile(uid, cid, null);
    const before = await fs.readFile(file, 'utf8');

    await drain(mod.askAside(uid, {
      cid, anchorMsgId: 'm5', question: 'explain',
    }, deps(streamStub(['answer']))));

    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('replays prior turns on a follow-up without re-injecting the transcript', async () => {
    const mod = await import(ASIDE);
    const cid = 'askaside07';
    await seedConversation(cid);
    const capture: any[] = [];

    await drain(mod.askAside(uid, { cid, anchorMsgId: 'm5', question: 'first' },
      deps(streamStub(['a1'], { capture }))));
    await drain(mod.askAside(uid, { cid, anchorMsgId: 'm5', question: 'second' },
      deps(streamStub(['a2'], { capture }))));

    const second = capture[1];
    expect(second.message).toContain('Q: first');
    expect(second.message).toContain('A: a1');
    expect(second.message.match(/\[主对话上下文 · 只读\]/g)).toHaveLength(1);
  });

  it('rejects bad input before calling the model', async () => {
    const mod = await import(ASIDE);
    const stream = vi.fn();
    await expect(drain(mod.askAside(uid, { cid: '../x', anchorMsgId: 'm1', question: 'q' }, deps(stream))))
      .rejects.toThrow(/invalid cid/);
    await expect(drain(mod.askAside(uid, { cid: 'askaside08', anchorIndex: -2, question: 'q' }, deps(stream))))
      .rejects.toThrow(/invalid anchor/);
    await expect(drain(mod.askAside(uid, { cid: 'askaside08', anchorMsgId: 'm1', question: '  ' }, deps(stream))))
      .rejects.toThrow(/empty question/);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('resolveAsideAgent', () => {
  it('borrows the bound agent persona and name', async () => {
    const mod = await import(ASIDE);
    const choice = await mod.resolveAsideAgent('agentone', {
      getAgent: async () => ({ agent_id: 'agentone', name: 'Ada', workflow: 'You are Ada.' }),
      isAgentEnabled: () => true,
    });
    expect(choice).toEqual({ agentId: 'agentone', agentName: 'Ada', personaPrompt: 'You are Ada.' });
  });

  it('falls back to the default model when the agent is disabled', async () => {
    const mod = await import(ASIDE);
    const choice = await mod.resolveAsideAgent('agentone', {
      getAgent: async () => ({ agent_id: 'agentone', name: 'Ada' }),
      isAgentEnabled: () => false,
    });
    expect(choice).toEqual({ agentId: '' });
  });

  it('falls back when the conversation has no bound agent', async () => {
    const mod = await import(ASIDE);
    const choice = await mod.resolveAsideAgent(null, {
      getAgent: async () => null,
      isAgentEnabled: () => true,
    });
    expect(choice).toEqual({ agentId: '' });
  });

  it('falls back when the bound agent id is malformed', async () => {
    const mod = await import(ASIDE);
    const getAgent = vi.fn();
    const choice = await mod.resolveAsideAgent('../escape', {
      getAgent: getAgent as any,
      isAgentEnabled: () => true,
    });
    expect(choice).toEqual({ agentId: '' });
    expect(getAgent).not.toHaveBeenCalled();
  });
});
