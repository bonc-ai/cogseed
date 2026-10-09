import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const ASIDE = '../../../src/main/features/conversation_aside';
const CHATS = '../../../src/main/features/chats';
const LAYOUT = '../../../src/main/util/project-layout';
const PATHS = '../../../src/main/paths';

let uid = '';
beforeEach(() => { uid = `aside-${randomUUID()}`; });
afterEach(async () => {
  const { userRoot } = await import(PATHS);
  await fs.rm(userRoot(uid), { recursive: true, force: true });
});

/** Write a main-conversation transcript straight to its jsonl. */
async function seedConversation(cid: string, count: number): Promise<void> {
  const { conversationMessageFile } = await import(LAYOUT);
  const file = conversationMessageFile(uid, cid, null);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      id: `m${i}`,
      ts: new Date(Date.UTC(2026, 7, 5, 0, 0, i)).toISOString(),
      from: i % 2 === 0 ? 'user' : 'assistant',
      to: [],
      text: `message ${i}`,
    }));
  }
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

async function readMainTranscript(cid: string): Promise<string> {
  const { conversationMessageFile } = await import(LAYOUT);
  try { return await fs.readFile(conversationMessageFile(uid, cid, null), 'utf8'); }
  catch { return ''; }
}

describe('conversation aside — core invariant: the main thread stays clean', () => {
  it('never writes an aside turn into the main message file', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside01';
    await seedConversation(cid, 10);
    const before = await readMainTranscript(cid);

    await mod.appendAsideTurn(uid, cid, {
      anchorIndex: 6,
      anchorExcerpt: 'message 6',
      question: 'why freeze first?',
      answer: 'because the comparison would be void otherwise',
      agentId: 'agent-x',
      model: 'test-model',
    });

    // The main transcript is byte-identical, and the aside lives elsewhere.
    expect(await readMainTranscript(cid)).toBe(before);
    const turns = await mod.listAsideTurns(uid, cid);
    expect(turns).toHaveLength(1);
    expect(turns[0].question).toBe('why freeze first?');
  });

  it('stores asides beside the conversation, not in its transcript path', async () => {
    const mod = await import(ASIDE);
    const { conversationMessageFile } = await import(LAYOUT);
    const cid = 'convaside02';
    const asidePath = mod.asideFile(uid, cid, null);
    expect(asidePath).not.toBe(conversationMessageFile(uid, cid, null));
    expect(asidePath.endsWith('aside.jsonl')).toBe(true);
  });

  it('is removed together with the conversation it belongs to', async () => {
    const mod = await import(ASIDE);
    const chats = await import(CHATS);
    const created = await chats.createConversation(uid, { title: 'Task' });
    const cid = created.conversation_id;

    await mod.appendAsideTurn(uid, cid, {
      anchorIndex: 0, anchorExcerpt: 'a', question: 'q', answer: 'a',
      agentId: 'agent-x', model: 'test-model',
    });
    await expect(fs.access(mod.asideFile(uid, cid, null))).resolves.toBeUndefined();

    await chats.deleteConversation(uid, cid);

    // purgeGroupDir already covers the aside file — no extra cleanup hook.
    await expect(fs.access(mod.asideFile(uid, cid, null))).rejects.toThrow();
  });
});

describe('conversation aside — context window', () => {
  it('takes five messages before the anchor and two after', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside03';
    await seedConversation(cid, 20);

    const context = await mod.buildAsideContext(uid, cid, { index: 10 });

    expect(context.messages.map((m: any) => m.index)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(context.anchorIndex).toBe(10);
    expect(context.messages.filter((m: any) => m.isAnchor)).toHaveLength(1);
    expect(context.anchorExcerpt).toBe('message 10');
  });

  it('clamps at the start of the conversation', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside04';
    await seedConversation(cid, 20);

    const context = await mod.buildAsideContext(uid, cid, { index: 1 });
    expect(context.messages.map((m: any) => m.index)).toEqual([0, 1, 2, 3]);
  });

  it('truncates at the end instead of padding', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside05';
    await seedConversation(cid, 8);

    const context = await mod.buildAsideContext(uid, cid, { index: 7 });
    expect(context.messages.map((m: any) => m.index)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('returns an empty context for an out-of-range anchor', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside06';
    await seedConversation(cid, 5);

    const context = await mod.buildAsideContext(uid, cid, { index: 99 });
    expect(context.messages).toEqual([]);
    expect(context.anchorExcerpt).toBe('');
  });

  it('rejects a negative anchor index', async () => {
    const mod = await import(ASIDE);
    await expect(mod.buildAsideContext(uid, 'convaside07', { index: -1 }))
      .rejects.toThrow(/invalid anchor/);
  });

  it('locates the anchor by message id', async () => {
    // The renderer only has msgIndex when the history was read anchored (e.g.
    // a search jump). A normally-opened conversation offers just the id, so the
    // id path is the one the UI actually uses.
    const mod = await import(ASIDE);
    const cid = 'convaside15';
    await seedConversation(cid, 20);

    const context = await mod.buildAsideContext(uid, cid, { msgId: 'm10' });

    expect(context.anchorIndex).toBe(10);
    expect(context.anchorExcerpt).toBe('message 10');
    expect(context.messages.map((m: any) => m.index)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('locates an anchor near the start by id without underflowing', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside16';
    await seedConversation(cid, 20);

    const context = await mod.buildAsideContext(uid, cid, { msgId: 'm1' });
    expect(context.messages.map((m: any) => m.index)).toEqual([0, 1, 2, 3]);
  });

  it('reports a missing message id rather than silently anchoring elsewhere', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside17';
    await seedConversation(cid, 5);

    await expect(mod.buildAsideContext(uid, cid, { msgId: 'no-such-message' }))
      .rejects.toThrow(/anchor not found/);
  });

  it('rejects an anchor with neither locator', async () => {
    const mod = await import(ASIDE);
    await expect(mod.buildAsideContext(uid, 'convaside18', {}))
      .rejects.toThrow(/invalid anchor/);
  });
});

describe('conversation aside — prompt construction', () => {
  const context = {
    anchorIndex: 6,
    anchorExcerpt: 'freeze the baseline first',
    messages: [
      { index: 5, from: 'user', text: 'what next?', isAnchor: false },
      { index: 6, from: 'assistant', text: 'freeze the baseline first', isAnchor: true },
      { index: 7, from: 'user', text: 'ok', isAnchor: false },
    ],
  };

  it('marks the anchor and includes the surrounding transcript', async () => {
    const mod = await import(ASIDE);
    const prompt = mod.buildAsidePrompt(context, [], 'why?');
    expect(prompt).toContain('→ [assistant] freeze the baseline first');
    expect(prompt).toContain('  [user] what next?');
    expect(prompt).toContain('why?');
  });

  it('injects the main transcript once and replays prior turns separately', async () => {
    const mod = await import(ASIDE);
    const history = [
      { turnId: 't1', anchorIndex: 6, anchorExcerpt: '', question: 'q1', answer: 'a1', agentId: '', model: '', createdAt: '' },
      { turnId: 't2', anchorIndex: 6, anchorExcerpt: '', question: 'q2', answer: 'a2', agentId: '', model: '', createdAt: '' },
    ];
    const prompt = mod.buildAsidePrompt(context, history, 'q3');

    // The transcript header appears exactly once regardless of thread depth.
    expect(prompt.match(/\[主对话上下文 · 只读\]/g)).toHaveLength(1);
    expect(prompt).toContain('Q: q1');
    expect(prompt).toContain('A: a2');
  });

  it('drops the oldest turns beyond the replay limit', async () => {
    const mod = await import(ASIDE);
    const history = Array.from({ length: 9 }, (_, i) => ({
      turnId: `t${i}`, anchorIndex: 6, anchorExcerpt: '',
      question: `q${i}`, answer: `a${i}`, agentId: '', model: '', createdAt: '',
    }));
    const prompt = mod.buildAsidePrompt(context, history, 'latest');

    expect(prompt).not.toContain('Q: q0');
    expect(prompt).not.toContain('Q: q2');
    expect(prompt).toContain('Q: q3');
    expect(prompt).toContain('Q: q8');
  });

  it('states the read-only contract in the system prompt', async () => {
    const mod = await import(ASIDE);
    const prompt = mod.asideSystemPrompt();
    expect(prompt).toContain('只解释，不执行');
    // The model is told its answers do not reach the main conversation, so it
    // does not offer to carry out actions it cannot perform.
    expect(prompt).toContain('不会写入主对话');
    expect(prompt).toContain('没有任何工具');
  });

  it('keeps the agent persona ahead of the aside rules', async () => {
    const mod = await import(ASIDE);
    const prompt = mod.asideSystemPrompt('You are Ada.');
    expect(prompt.indexOf('You are Ada.')).toBeLessThan(prompt.indexOf('只解释，不执行'));
  });
});

describe('conversation aside — persistence', () => {
  it('returns an empty list before anything is asked', async () => {
    const mod = await import(ASIDE);
    await expect(mod.listAsideTurns(uid, 'convaside08')).resolves.toEqual([]);
  });

  it('keeps turns in ask order', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside09';
    for (const q of ['first', 'second', 'third']) {
      await mod.appendAsideTurn(uid, cid, {
        anchorIndex: 1, anchorExcerpt: 'x', question: q, answer: 'ok',
        agentId: 'agent-x', model: 'test-model',
      });
    }
    const turns = await mod.listAsideTurns(uid, cid);
    expect(turns.map((turn: any) => turn.question)).toEqual(['first', 'second', 'third']);
  });

  it('snapshots a truncated anchor excerpt so history stays readable', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside10';
    const turn = await mod.appendAsideTurn(uid, cid, {
      anchorIndex: 3, anchorExcerpt: 'x'.repeat(400), question: 'q', answer: 'a',
      agentId: 'agent-x', model: 'test-model',
    });
    expect(turn.anchorExcerpt.length).toBeLessThan(400);
    expect(turn.anchorExcerpt.endsWith('…')).toBe(true);
  });

  it('skips a malformed line instead of failing the whole thread', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside11';
    await mod.appendAsideTurn(uid, cid, {
      anchorIndex: 1, anchorExcerpt: 'x', question: 'good', answer: 'a',
      agentId: 'agent-x', model: 'test-model',
    });
    await fs.appendFile(mod.asideFile(uid, cid, null), '{ not json\n', 'utf8');

    const turns = await mod.listAsideTurns(uid, cid);
    expect(turns.map((turn: any) => turn.question)).toEqual(['good']);
  });

  it('clears aside history without touching the main transcript', async () => {
    const mod = await import(ASIDE);
    const cid = 'convaside12';
    await seedConversation(cid, 6);
    const before = await readMainTranscript(cid);
    await mod.appendAsideTurn(uid, cid, {
      anchorIndex: 1, anchorExcerpt: 'x', question: 'q', answer: 'a',
      agentId: 'agent-x', model: 'test-model',
    });

    await mod.clearAsideTurns(uid, cid);

    await expect(mod.listAsideTurns(uid, cid)).resolves.toEqual([]);
    expect(await readMainTranscript(cid)).toBe(before);
  });

  it('treats clearing an untouched conversation as a no-op', async () => {
    const mod = await import(ASIDE);
    await expect(mod.clearAsideTurns(uid, 'convaside13')).resolves.toBeUndefined();
  });

  it('rejects an empty question and an over-long one', async () => {
    const mod = await import(ASIDE);
    const base = {
      anchorIndex: 1, anchorExcerpt: 'x', answer: 'a',
      agentId: 'agent-x', model: 'test-model',
    };
    await expect(mod.appendAsideTurn(uid, 'convaside14', { ...base, question: '   ' }))
      .rejects.toThrow(/empty question/);
    await expect(mod.appendAsideTurn(uid, 'convaside14', { ...base, question: 'x'.repeat(2001) }))
      .rejects.toThrow(/question too long/);
  });

  it('rejects a malformed cid', async () => {
    const mod = await import(ASIDE);
    await expect(mod.listAsideTurns(uid, '../escape')).rejects.toThrow(/invalid cid/);
  });
});
