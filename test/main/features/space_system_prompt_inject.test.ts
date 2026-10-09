import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// 测试环境无真实模型配置：buildRunner 的 auth gate 会抛
// no_model_configured。这里给一个假 chat entry + 标记已配置，让
// buildRunner 走到 prompt 组装（本测试只验证 space 注入，不跑模型）。
const fakeChatEntry = {
  entryId: 'test-entry',
  profileId: 'test-profile',
  provider: 'test-provider',
  model: 'test-model',
  apiKey: 'test-key',
};
vi.mock('../../../src/main/features/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/auth')>();
  return {
    ...actual,
    hasConfiguredModel: () => ({ configured: true }),
    getConfiguredModelCooldown: () => null,
    getConfiguredModelOAuthExpiredMessage: () => null,
    pickChatEntryGroup: async () => [fakeChatEntry],
  };
});

// 捕获 bus → streamChatWithModel 的 ChatOptions（验证 spaceId 从会话透传）。
let capturedChatOptions: Array<Record<string, unknown>> = [];
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    capturedChatOptions.push({
      cid: opts?.cid,
      spaceId: opts?.spaceId,
      projectId: opts?.projectId,
      hasSystemPrompt: typeof opts?.systemPrompt === 'string' && opts.systemPrompt.length > 0,
    });
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevAnthropicKey: string | undefined;
const UID = 'u1';

beforeEach(async () => {
  capturedChatOptions = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-space-inject-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  // buildRunner's prompt assembly is intentionally behind the model-auth
  // gate. These tests inspect the assembled prompt without making a request,
  // so supply the supported development fallback explicitly.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 建「学生」空间：指令 + 角色模板。直接手写模板文件（不装台账，避免触发
 *  vec_store/better-sqlite3 原生模块——沙箱 ABI 不匹配，见角色画像基线测试）。 */
async function makeSpaceWithProfile() {
  const spaces = await import('../../../src/main/features/spaces');
  const created = await spaces.createSpace(UID, {
    name: '学生空间',
    template_id: 'student',
    instructions: '这是空间默认目标：帮助学生真正理解知识。',
  });
  if (!created.ok) throw new Error('create space failed');
  const tmplFile = path.join(
    tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups', 'student.md');
  fs.mkdirSync(path.dirname(tmplFile), { recursive: true });
  fs.writeFileSync(tmplFile, [
    '# 学生（模板）',
    '> 模板: student@0.2.0-review.1',
    '',
    '## 学习背景',
    '### 教育阶段',
    '- 硕士',
    '### 专业与学习方向',
    '### 流水',
    '',
    '## 学期与课程',
    '### 课程清单',
    '- 机器学习',
    '### 流水',
    '',
  ].join('\n'), 'utf8');
  return { spaces, sid: created.space.space_id };
}

/** 等 commander turn 异步跑完（空间会话会先自动补 agent/skill，模型调用延后一拍）。 */
async function waitForCaptures(pred: (o: Record<string, unknown>) => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = capturedChatOptions.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

describe('spaces › 绑定会话 system prompt 注入（问题 B 验证）', () => {
  it('bus 把会话 space_id 透传给 streamChatWithModel（opts.spaceId）', async () => {
    const { sid } = await makeSpaceWithProfile();
    const chats = await import('../../../src/main/features/chats');
    const groupChat = await import('../../../src/main/features/group_chat');
    const conv = await chats.createConversation(UID, { title: '绑定会话', spaceId: sid });
    expect(conv.space_id).toBe(sid);

    const res = await groupChat.send({ userId: UID, cid: conv.conversation_id, text: '帮我看一下' });
    expect(res.ok).toBe(true);

    const opts = await waitForCaptures((o) => o.spaceId === sid);
    expect(opts).toBeTruthy(); // 空间会话 → spaceId 已进入 ChatOptions

    const { dropConv } = await import('../../../src/main/features/group_chat/bus');
    await dropConv(UID, conv.conversation_id);
  });

  it('孤儿会话不透传 spaceId（对照组）', async () => {
    const chats = await import('../../../src/main/features/chats');
    const groupChat = await import('../../../src/main/features/group_chat');
    const conv = await chats.createConversation(UID, { title: '孤儿' });
    expect(conv.space_id).toBeUndefined();

    const res = await groupChat.send({ userId: UID, cid: conv.conversation_id, text: 'hi' });
    expect(res.ok).toBe(true);

    const opts = await waitForCaptures((o) => o.cid === conv.conversation_id);
    expect(opts).toBeTruthy();
    expect(opts?.spaceId).toBeUndefined();

    const { dropConv } = await import('../../../src/main/features/group_chat/bus');
    await dropConv(UID, conv.conversation_id);
  });

  it('buildRunner 收到 spaceId → resolvedSystemPrompt 含空间指令 + 角色画像 + context policy', async () => {
    const { sid } = await makeSpaceWithProfile();
    const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
    const built = await buildRunner({
      sessionId: `gconv-${'a'.repeat(12)}`,
      userId: UID,
      spaceId: sid,
      systemPrompt: '## Your role\nYou are the **commander** of this group chat.',
      disableTools: true, // 只验 prompt，不跑工具
    });
    const prompt = built.resolvedSystemPrompt || '';
    expect(prompt).toContain('## Space context policy');
    expect(prompt).toContain('## Space instructions (user-authored)');
    expect(prompt).toContain('这是空间默认目标：帮助学生真正理解知识。');
    expect(prompt).toContain('## 当前角色画像');
    expect(prompt).toContain('学习背景 · 教育阶段: 硕士');
    expect(prompt).toContain('学期与课程 · 课程清单: 机器学习');
    expect(prompt).not.toContain('@proj:p_abc');
    // 基础 systemPrompt 仍在（bus 的 commander prompt 是基座）
    expect(prompt).toContain('You are the **commander**');
  });

  it('buildRunner 无 spaceId → 不含空间指令/画像/context policy（对照组）', async () => {
    const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
    const built = await buildRunner({
      sessionId: `gconv-${'b'.repeat(12)}`,
      userId: UID,
      systemPrompt: '## Your role\nYou are the **commander** of this group chat.',
      disableTools: true,
    });
    const prompt = built.resolvedSystemPrompt || '';
    expect(prompt).not.toContain('## Space instructions (user-authored)');
    expect(prompt).not.toContain('## 当前角色画像');
    expect(prompt).not.toContain('## Space context policy');
  });
});
