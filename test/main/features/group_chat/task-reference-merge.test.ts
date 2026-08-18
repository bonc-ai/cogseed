import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

let tmpDir: string;
let previousWorkspace: string | undefined;
const UID = 'taskref-merge-user';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-taskref-merge-'));
  previousWorkspace = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    for (const cid of ['taskref-target', 'taskref-source']) {
      await bus.abort(UID, cid);
      await bus.dropConv(UID, cid);
    }
  } catch (_) {}
  process.env.COGSEED_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 标准 composer 的 @ 产物/资产 → conversations.taskRefs.add 写入 conv.task_references；
// 发送时（conversations.sendStream / groupChat.send 都汇聚到核心 groupChat.send）
// 必须把产物合并进 references、把资产合并进 model_text —— 否则引用"发不出去"。
describe('space task references merge on send', () => {
  it('merges artifact refs into references and asset refs into model_text', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const layout = await import('../../../../src/main/util/project-layout');
    const sourceConv = await chats.createConversation(UID, { conversationId: 'taskref-source', title: 'Source' });
    const targetConv = await chats.createConversation(UID, { conversationId: 'taskref-target', title: 'Target' });

    // 源会话：一条持有产物的消息（附件文件真实落盘 → 可被 resolveAttachmentAbsPath 定位）
    const sourceRow = {
      id: 'src-msg', ts: '2026-08-15T00:00:00', from: 'user', to: ['commander'],
      text: '生成报告.docx', attachments: ['报告.docx'],
    };
    fs.writeFileSync(
      layout.conversationMessageFile(UID, sourceConv.conversation_id),
      `${JSON.stringify(sourceRow)}\n`,
    );
    const srcDir = layout.chatAttachmentDirForConversation(UID, sourceConv.conversation_id);
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, '报告.docx'), 'artifact content');

    // 目标会话：task_references = 1 产物 + 1 资产（@ 选择器写入的形状）
    await chats.updateConversation(UID, targetConv.conversation_id, {
      task_references: [
        { kind: 'artifact', name: '报告.docx', source_cid: sourceConv.conversation_id, source_title: 'Source', file_name: '报告.docx' },
        { kind: 'asset', name: '配色规范', asset_id: 'aa-1', asset_type: 'rule', summary: '品牌色 #1f9d62' },
      ],
    });

    const result = await groupChat.send({ userId: UID, cid: targetConv.conversation_id, text: '请按引用处理' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 产物 → references（跨任务引用解析后带源消息 + 附件定位）
    const artifactRef = (result.msg?.references || []).find(
      (r) => Array.isArray(r.attachments) && r.attachments.some((a) => a.name === '报告.docx'),
    );
    expect(artifactRef).toBeTruthy();
    expect(artifactRef?.source_cid).toBe(sourceConv.conversation_id);
    expect(artifactRef?.source_msg_id).toBe('src-msg');
    expect(artifactRef?.source_title).toBe('Source');
    // 资产 → model_text 上下文块（不污染用户可见文本）+ space_asset_refs 可见反馈
    expect(result.msg?.model_text).toContain('【本任务引用的空间资产】');
    expect(result.msg?.model_text).toContain('配色规范');
    expect(result.msg?.model_text).toContain('品牌色 #1f9d62');
    expect(result.msg?.space_asset_refs).toEqual([{ name: '配色规范', asset_type: 'rule' }]);
    expect(result.msg?.text).toBe('请按引用处理');
  });

  it('resolves artifact refs whose source message carries produced string paths (AI 产出文件)', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const layout = await import('../../../../src/main/util/project-layout');
    const sourceConv = await chats.createConversation(UID, { conversationId: 'taskref-source', title: 'Producer' });
    const targetConv = await chats.createConversation(UID, { conversationId: 'taskref-target', title: 'Target' });

    // 真实形状：AI 产出的消息 produced[] 是字符串全路径
    const sourceRow = {
      id: 'prod-msg', ts: '2026-08-15T01:00:00', from: 'commander', to: ['user'],
      text: '已生成产物', produced: ['/abs/workspace/官网信息架构/官网信息架构.md'],
    };
    fs.writeFileSync(
      layout.conversationMessageFile(UID, sourceConv.conversation_id),
      `${JSON.stringify(sourceRow)}\n`,
    );
    await chats.updateConversation(UID, targetConv.conversation_id, {
      task_references: [
        { kind: 'artifact', name: '官网信息架构.md', source_cid: sourceConv.conversation_id, source_title: 'Producer', file_name: '官网信息架构.md' },
      ],
    });

    const result = await groupChat.send({ userId: UID, cid: targetConv.conversation_id, text: '处理这个产物' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 源消息 produced[] 是字符串全路径 → 解析后引用带 produced 路径（模型上下文 files）
    const artifactRef = (result.msg?.references || []).find((r) => r.source_msg_id === 'prod-msg');
    expect(artifactRef).toBeTruthy();
    expect(artifactRef?.source_cid).toBe(sourceConv.conversation_id);
    expect(artifactRef?.source_title).toBe('Producer');
    const produced = Array.isArray(artifactRef?.produced) ? artifactRef!.produced! : [];
    expect(produced.some((p) => String(p).includes('官网信息架构.md'))).toBe(true);
  });

  it('leaves sends without task references untouched (regression guard)', async () => {
    const chats = await import('../../../../src/main/features/chats');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const targetConv = await chats.createConversation(UID, { conversationId: 'taskref-target', title: 'Plain' });
    const result = await groupChat.send({ userId: UID, cid: targetConv.conversation_id, text: '普通消息' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.msg?.model_text).toBeUndefined();
    expect(result.msg?.references || []).toHaveLength(0);
    expect(result.msg?.text).toBe('普通消息');
  });
});
