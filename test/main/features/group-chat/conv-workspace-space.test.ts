import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uWs';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ws-space-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadConvWs() {
  return import('../../../../src/main/features/group_chat/conv_workspace');
}

describe('conv_workspace › 空间会话工作区按空间分开存放', () => {
  it('空间会话 → 空间工作区目录（spaces/<sid>/workspace/<slug>），未绑会话 → userWorkSpace', async () => {
    const spaces = await import('../../../../src/main/features/spaces');
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await loadConvWs();
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');

    const created = await spaces.createSpace(UID, { name: '空间A' });
    if (!created.ok) throw new Error('create space failed');
    const bound = await chats.createConversation(UID, { title: '任务甲', spaceId: created.space.space_id });
    const orphan = await chats.createConversation(UID, { title: '孤儿任务' });

    const boundPath = await convWs.getConversationWorkspacePath(UID, bound.conversation_id);
    const orphanPath = await convWs.getConversationWorkspacePath(UID, orphan.conversation_id);

    // 空间会话：spaces/<sid>/workspace/任务甲
    expect(boundPath).toBe(path.join(tmpDir, UID, 'cloud', 'spaces', created.space.space_id, 'workspace', '任务甲'));
    // 未绑会话：userWorkSpace/孤儿任务（getWorkspacePath 根）
    expect(orphanPath).toBe(path.join(getWorkspacePath(UID), '孤儿任务'));
  });

  it('已有空间会话工作区从 userWorkSpace 惰性迁移到空间目录', async () => {
    const spaces = await import('../../../../src/main/features/spaces');
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await loadConvWs();
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');

    const created = await spaces.createSpace(UID, { name: '迁移空间' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;
    const conv = await chats.createConversation(UID, { title: '旧任务', spaceId: sid });

    // 模拟旧布局：state.workspace_dir = 旧任务，文件在 userWorkSpace（getWorkspacePath 根）/旧任务
    const legacyDir = path.join(getWorkspacePath(UID), '旧任务');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, '成果.docx'), 'x');
    const stateFile = path.join(tmpDir, UID, 'cloud', 'chats', conv.conversation_id, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, status: 'idle', workspace_dir: '旧任务' }));

    const newPath = await convWs.getConversationWorkspacePath(UID, conv.conversation_id);
    const expected = path.join(tmpDir, UID, 'cloud', 'spaces', sid, 'workspace', '旧任务');
    expect(newPath).toBe(expected);
    expect(fs.existsSync(path.join(expected, '成果.docx'))).toBe(true);
  });
});

describe('conv_workspace › 方案 Y：归属变更工作区随迁（不丢文件）', () => {
  async function makeBoundConv(spaceName: string) {
    const spaces = await import('../../../../src/main/features/spaces');
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await import('../../../../src/main/features/group_chat/conv_workspace');
    const created = await spaces.createSpace(UID, { name: spaceName });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: '任务', spaceId: created.space.space_id });
    const p = await convWs.getConversationWorkspacePath(UID, conv.conversation_id);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, '成果.docx'), 'x');
    return { sid: created.space.space_id, cid: conv.conversation_id };
  }

  it('解绑空间 → 工作区从空间目录迁到 userWorkSpace（文件不丢）', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await import('../../../../src/main/features/group_chat/conv_workspace');
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    const { sid, cid } = await makeBoundConv('解绑空间');

    await chats.setConversationSpace(UID, cid, null);
    const p2 = await convWs.getConversationWorkspacePath(UID, cid);
    expect(p2).toBe(path.join(getWorkspacePath(UID), '任务'));
    expect(fs.existsSync(path.join(p2, '成果.docx'))).toBe(true); // 文件随迁
  });

  it('换空间 A→B → 工作区从 A 迁到 B（文件不丢）', async () => {
    const spaces = await import('../../../../src/main/features/spaces');
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await import('../../../../src/main/features/group_chat/conv_workspace');
    const { sid: sidA, cid } = await makeBoundConv('换绑A');
    const createdB = await spaces.createSpace(UID, { name: '换绑B' });
    if (!createdB.ok) throw new Error('create failed');
    const sidB = createdB.space.space_id;

    await chats.setConversationSpace(UID, cid, sidB);
    const p = await convWs.getConversationWorkspacePath(UID, cid);
    expect(p).toBe(path.join(tmpDir, UID, 'cloud', 'spaces', sidB, 'workspace', '任务'));
    expect(fs.existsSync(path.join(p, '成果.docx'))).toBe(true);
    // 旧空间目录已搬空
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'spaces', sidA, 'workspace', '任务', '成果.docx'))).toBe(false);
  });

  it('删除空间 → 工作区迁到 userWorkSpace，空间目录删后文件仍在（会话保留产物）', async () => {
    const spaces = await import('../../../../src/main/features/spaces');
    const chats = await import('../../../../src/main/features/chats');
    const convWs = await import('../../../../src/main/features/group_chat/conv_workspace');
    const { getWorkspacePath } = await import('../../../../src/main/features/user_workspace');
    const { sid, cid } = await makeBoundConv('待删空间');

    const del = await spaces.deleteSpace(UID, sid);
    expect(del.ok).toBe(true);
    // 会话 space_id 清空 + 工作区已迁到 userWorkSpace（文件不丢）
    const conv = await chats.getConversation(UID, cid);
    expect(conv?.space_id).toBeUndefined();
    const p = await convWs.getConversationWorkspacePath(UID, cid);
    expect(p).toBe(path.join(getWorkspacePath(UID), '任务'));
    expect(fs.existsSync(path.join(p, '成果.docx'))).toBe(true);
    // 空间目录已删
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'spaces', sid))).toBe(false);
  });
});
