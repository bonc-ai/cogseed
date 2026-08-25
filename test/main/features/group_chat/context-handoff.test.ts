import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid42';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ctx-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Append a record to the main conversation jsonl (chats/<cid>.jsonl). */
async function appendMain(record: Record<string, unknown>): Promise<void> {
  const { conversationLayout } = await import('../../../../src/main/util/project-layout');
  const { appendJsonlAtomic } = await import('../../../../src/main/storage');
  const layout = conversationLayout(TEST_UID, TEST_CID);
  fs.mkdirSync(path.dirname(layout.messageFile), { recursive: true });
  await appendJsonlAtomic(layout.messageFile, record);
}

/** Seed the conversation main log exactly like the bus does: each message is
 *  persisted to main AND to every actor's slice via visibility.appendVisible,
 *  so the visibility-slice model matches production (agent-x sees only its own
 *  messages; the user↔commander thread is invisible to it). */
async function seedConversation(records: Array<Record<string, unknown>>): Promise<void> {
  const v = await import('../../../../src/main/features/group_chat/visibility');
  for (const rec of records) {
    await appendMain(rec);
    const msg = rec as Parameters<typeof v.appendVisible>[2];
    await v.appendVisible(
      TEST_UID,
      TEST_CID,
      msg,
      ['commander', 'user', 'agent-x'],
    );
  }
}

describe('group_chat › switched-agent context handoff', () => {
  it('returns empty when the conversation has no prior messages', async () => {
    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    const out = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm-trigger');
    expect(out).toBe('');
  });

  it('digests the missed user↔commander conversation when switching to a fresh agent', async () => {
    await seedConversation([
      { id: 'm1', ts: 't1', from: 'user', to: ['commander'], text: '帮我分析一下这个需求', model_text: '帮我分析一下这个需求' },
      { id: 'm2', ts: 't2', from: 'commander', to: ['user'], text: '好的，我先梳理要点。' },
      { id: 'm3', ts: 't3', from: 'user', to: ['commander'], text: '重点是兼容老系统。', model_text: '重点是兼容老系统。' },
      // the triggering message to agent-x itself
      { id: 'm4', ts: 't4', from: 'user', to: ['agent-x'], text: '现在轮到你来实现。', model_text: '现在轮到你来实现。' },
    ]);

    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    const out = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm4');

    expect(out).toContain('<group-context-summary>');
    // The user↔commander thread the agent never saw is included…
    expect(out).toContain('帮我分析一下这个需求');
    expect(out).toContain('重点是兼容老系统');
    // …while the agent's own trigger message is not digested as "missed".
    expect(out).not.toContain('现在轮到你来实现');
    // G-26: the digest opens with the participant roster of the digested
    // window so the receiving agent knows who it shares the chat with.
    expect(out).toContain('<participants>user, commander</participants>');
    // Watermark persisted so the same digest is not re-attached.
    expect(m.contextSummaryWatermarkExistsForTest(TEST_UID, TEST_CID, 'agent-x')).toBe(true);
  });

  it('watermark prevents re-injecting the same missed context on the next message', async () => {
    await seedConversation([
      { id: 'm1', ts: 't1', from: 'user', to: ['commander'], text: '分析需求A', model_text: '分析需求A' },
      { id: 'm2', ts: 't2', from: 'commander', to: ['user'], text: '收到。' },
      { id: 'm3', ts: 't3', from: 'user', to: ['agent-x'], text: '开始工作', model_text: '开始工作' },
    ]);

    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    const first = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm3');
    expect(first).toContain('分析需求A');

    // A second user message to the same agent with no NEW missed context:
    // the digest must not repeat the old missed messages.
    await seedConversation([
      { id: 'm4', ts: 't4', from: 'user', to: ['agent-x'], text: '继续', model_text: '继续' },
    ]);
    const second = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm4');
    expect(second).toBe('');
  });

  it('digests only NEW missed context after the watermark advanced', async () => {
    await seedConversation([
      { id: 'm1', ts: 't1', from: 'user', to: ['commander'], text: '需求A', model_text: '需求A' },
      { id: 'm2', ts: 't2', from: 'user', to: ['agent-x'], text: '开工', model_text: '开工' },
    ]);
    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm2');

    // Later the user talks to the commander again — that new thread is missed.
    await seedConversation([
      { id: 'm3', ts: 't3', from: 'user', to: ['commander'], text: '追加需求B', model_text: '追加需求B' },
      { id: 'm4', ts: 't4', from: 'commander', to: ['user'], text: '好，记下了。' },
      { id: 'm5', ts: 't5', from: 'user', to: ['agent-x'], text: '继续', model_text: '继续' },
    ]);
    const out = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm5');

    expect(out).toContain('追加需求B');
    expect(out).toContain('好，记下了。');
    // Old already-digested context is not repeated.
    expect(out).not.toContain('需求A');
  });

  it('caps the digest and reports omitted earlier messages', async () => {
    const records: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 15; i += 1) {
      records.push({
        id: `m${i}`, ts: `t${i}`, from: 'user', to: ['commander'],
        text: `旧对话内容 ${i}`, model_text: `旧对话内容 ${i}`,
      });
    }
    records.push({ id: 'm-trigger', ts: 't15', from: 'user', to: ['agent-x'], text: '开始', model_text: '开始' });
    await seedConversation(records);

    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    const out = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm-trigger', {
      maxMessages: 5,
    });

    expect(out).toContain('<omitted>');
    // Only the newest 5 are kept.
    expect(out).toContain('旧对话内容 14');
    expect(out).toContain('旧对话内容 10');
    expect(out).not.toContain('旧对话内容 0');
  });

  it('truncates long message bodies per message', async () => {
    await seedConversation([
      {
        id: 'm1', ts: 't1', from: 'user', to: ['commander'],
        text: 'X'.repeat(600), model_text: 'Y'.repeat(600),
      },
      { id: 'm2', ts: 't2', from: 'user', to: ['agent-x'], text: '开始', model_text: '开始' },
    ]);
    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    const out = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm2', { maxChars: 100 });

    // Uses model_text (Y…) and truncates at the cap.
    expect(out).toContain('Y'.repeat(100));
    expect(out).not.toContain('Y'.repeat(101));
  });

  it('ignores messages the actor has already seen (its own slice)', async () => {
    await seedConversation([
      { id: 'm1', ts: 't1', from: 'commander', to: ['agent-x'], text: '这是给你的任务', model_text: '这是给你的任务' },
      { id: 'm2', ts: 't2', from: 'agent-x', to: ['commander'], text: '我完成了', model_text: '我完成了' },
      { id: 'm3', ts: 't3', from: 'user', to: ['agent-x'], text: '继续', model_text: '继续' },
    ]);
    const m = await import('../../../../src/main/features/group_chat/context_handoff');
    const out = await m.buildSwitchedAgentContextDigest(TEST_UID, TEST_CID, 'agent-x', 'm3');
    // agent-x saw m1 (commander→it) and m2 (its own reply); neither is "missed".
    expect(out).toBe('');
  });
});
