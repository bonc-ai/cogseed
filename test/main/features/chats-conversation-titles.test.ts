import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// 批量会话标题窄口（2026-09-25 验收修复 US-603）：证据来源解析要把 cid 翻成
// 用户看得懂的标题，且五处展示必须同名。这个口只许返回 title——查无的 cid 不
// 返回条目（渲染层据此显示「来源记录不可用」，而不是裸 id），且不得夹带正文。

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-conv-titles-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadChats() {
  return import('../../../src/main/features/chats');
}

describe('listConversationTitles（来源解析用的批量标题口）', () => {
  it('按请求顺序返回命中项，查无的 cid 不返回条目', async () => {
    const chats = await loadChats();
    const first = await chats.createConversation(TEST_UID, { title: '天津攻略' });
    const second = await chats.createConversation(TEST_UID, { title: '季度复盘' });

    const titles = await chats.listConversationTitles(TEST_UID, [
      second.conversation_id,
      'deadbeef0001',
      first.conversation_id,
    ]);

    expect(titles).toEqual([
      { cid: second.conversation_id, title: '季度复盘' },
      { cid: first.conversation_id, title: '天津攻略' },
    ]);
  });

  it('只返回 cid 与 title 两个字段，不夹带会话其余数据', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '只要标题' });

    const [entry] = await chats.listConversationTitles(TEST_UID, [conv.conversation_id]);

    expect(Object.keys(entry).sort()).toEqual(['cid', 'title']);
  });

  it('标题与 getConversation 一致（窄口不另造、不截断标题）', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '一个很长很长的会话标题用于验证不被截断' });

    const [entry] = await chats.listConversationTitles(TEST_UID, [conv.conversation_id]);
    const full = await chats.getConversation(TEST_UID, conv.conversation_id);

    expect(entry.title).toBe(full?.title);
    expect(entry.title).toBe('一个很长很长的会话标题用于验证不被截断');
  });

  it('重复 cid 去重，空数组直接返回空', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '去重' });

    expect(await chats.listConversationTitles(TEST_UID, [conv.conversation_id, conv.conversation_id]))
      .toEqual([{ cid: conv.conversation_id, title: '去重' }]);
    expect(await chats.listConversationTitles(TEST_UID, [])).toEqual([]);
  });

  it('超过 50 条或含非法 cid 一律拒绝，不做隐式截断', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '批量上限' });
    const tooMany = Array.from({ length: 51 }, (_, index) => (index === 0
      ? conv.conversation_id
      : `${String(index).padStart(11, '0')}f`));

    await expect(chats.listConversationTitles(TEST_UID, tooMany))
      .rejects.toThrow('invalid conversation title batch');
    await expect(chats.listConversationTitles(TEST_UID, ['../escape']))
      .rejects.toThrow('invalid conversation title batch');
    await expect(chats.listConversationTitles(TEST_UID, 'nope' as unknown as string[]))
      .rejects.toThrow('invalid conversation title batch');
  });
});
