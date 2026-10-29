import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { A2AConversationMarker } from '../../../../src/main/features/a2a/conversation-marker';

/**
 * Private instructions are the receiver's own words (D-21), so the invariants that
 * matter are which conversation they belong to and who may see them: they must never
 * be injected into the initiator's conversation, and a waiting exchange is not
 * running yet.
 */
const UID = 'a2a-instructions-user';
let tmp: string;
let previous: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-instr-'));
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
  return import('../../../../src/main/features/a2a/instructions');
}

describe('a2a instructions › storage', () => {
  it('appends instructions per conversation and reads them back in order', async () => {
    const m = await mod();
    await m.appendInstruction(UID, 'conv-a', '不要透露报价');
    await m.appendInstruction(UID, 'conv-a', '可以提交付时间');
    await m.appendInstruction(UID, 'conv-b', '别的话题');
    const rows = await m.listInstructions(UID, 'conv-a');
    expect(rows.map((row) => row.text)).toEqual(['不要透露报价', '可以提交付时间']);
    expect((await m.listInstructions(UID, 'conv-b')).map((row) => row.text)).toEqual(['别的话题']);
  });

  it('rejects an empty instruction and trims to the context budget', async () => {
    const m = await mod();
    await expect(m.appendInstruction(UID, 'conv-a', '   ')).rejects.toThrow(/instruction text is required/);
    const long = 'x'.repeat(m.A2A_INSTRUCTION_MAX_CHARS + 50);
    const record = await m.appendInstruction(UID, 'conv-a', long);
    expect(record.text.length).toBe(m.A2A_INSTRUCTION_MAX_CHARS);
  });

  it('survives a corrupt line instead of failing the read', async () => {
    const m = await mod();
    await m.appendInstruction(UID, 'conv-a', '第一条');
    const file = path.join(tmp, UID, 'local', 'a2a-instructions.jsonl');
    fs.appendFileSync(file, 'not json\n');
    expect((await m.listInstructions(UID, 'conv-a')).map((row) => row.text)).toEqual(['第一条']);
  });
});

describe('a2a instructions › context injection (D-21)', () => {
  const receiver: A2AConversationMarker = { role: 'receiver', peer_user_id: 'cs_alice', state: 'active' };
  const instructions = [
    { conversationId: 'conv-a', text: '不要透露报价', at: 't1' },
    { conversationId: 'conv-a', text: '可以提交付时间', at: 't2' },
  ];

  it('injects the recent instructions for an active receiving conversation', async () => {
    const m = await mod();
    const item = m.buildInstructionContext(receiver, instructions);
    expect(item).toBeTruthy();
    expect(item!.content).toContain('不要透露报价');
    expect(item!.content).toContain('可以提交付时间');
    expect(item!.label).toBe('a2a-receiver-instructions');
  });

  it('never injects them into the initiator or a waiting exchange', async () => {
    const m = await mod();
    expect(m.buildInstructionContext({ ...receiver, role: 'initiator' }, instructions)).toBeNull();
    expect(m.buildInstructionContext({ ...receiver, state: 'waiting' }, instructions)).toBeNull();
    expect(m.buildInstructionContext(null, instructions)).toBeNull();
  });

  it('keeps only the most recent instructions', async () => {
    const m = await mod();
    const many = Array.from({ length: 8 }, (_, i) => ({ conversationId: 'conv-a', text: `指示 ${i}`, at: `t${i}` }));
    const item = m.buildInstructionContext(receiver, many)!;
    expect(item.content).toContain('指示 7');
    expect(item.content).not.toContain('指示 0');
  });

describe('a2a instructions › loading from a conversation (D-21)', () => {
  it('returns the context for an active receiving conversation only', async () => {
    const m = await mod();
    const chats = await import('../../../../src/main/features/chats');
    await m.appendInstruction(UID, 'conv-live', '不要透露报价');

    await chats.createConversation(UID, { conversationId: 'conv-live', title: 'live' });
    await chats.updateConversation(UID, 'conv-live', {
      a2a: { role: 'receiver', peer_user_id: 'cs_alice', state: 'active' },
    });
    const item = await m.loadInstructionContext(UID, 'conv-live');
    expect(item?.content).toContain('不要透露报价');

    // 发起方会话：绝不注入对方的私下指示。
    await chats.createConversation(UID, { conversationId: 'conv-out', title: 'out' });
    await chats.updateConversation(UID, 'conv-out', {
      a2a: { role: 'initiator', peer_user_id: 'cs_bob', state: 'active' },
    });
    expect(await m.loadInstructionContext(UID, 'conv-out')).toBeNull();

    // 普通会话、无会话、空 id 都不注入。
    await chats.createConversation(UID, { conversationId: 'conv-plain', title: 'plain' });
    expect(await m.loadInstructionContext(UID, 'conv-plain')).toBeNull();
    expect(await m.loadInstructionContext(UID, 'conv-missing')).toBeNull();
    expect(await m.loadInstructionContext(UID, '')).toBeNull();
  });
});
});
