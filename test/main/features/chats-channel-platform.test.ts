/**
 * Conversation.channel_platform —— 渠道会话标记的持久化往返。
 *
 * 覆盖：
 *   - createConversation({channelPlatform}) 落盘 channel_platform
 *   - getConversation 读回字段（normalize 白名单放行）
 *   - 未传 platform 的普通会话不产生该字段
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-chats-channel-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('chats — channel_platform persistence', () => {
  it('createConversation persists channelPlatform and reads it back', async () => {
    const chats = await import('../../../src/main/features/chats');
    const created = await chats.createConversation(TEST_UID, {
      title: '飞书 · 张三',
      channelPlatform: 'feishu_lark',
    });
    expect(created.channel_platform).toBe('feishu_lark');
    const read = await chats.getConversation(TEST_UID, created.conversation_id);
    expect(read?.channel_platform).toBe('feishu_lark');
  });

  it('ordinary conversations stay unmarked', async () => {
    const chats = await import('../../../src/main/features/chats');
    const created = await chats.createConversation(TEST_UID, { title: '普通任务' });
    expect(created.channel_platform).toBeUndefined();
    const read = await chats.getConversation(TEST_UID, created.conversation_id);
    expect(read?.channel_platform).toBeUndefined();
  });

  it('listConversations returns the field for channel conversations', async () => {
    const chats = await import('../../../src/main/features/chats');
    const created = await chats.createConversation(TEST_UID, {
      title: '微信 · 李四',
      channelPlatform: 'wechat_personal',
    });
    const list = await chats.listConversations(TEST_UID);
    const row = list.find((c) => c.conversation_id === created.conversation_id);
    expect(row?.channel_platform).toBe('wechat_personal');
  });
});
