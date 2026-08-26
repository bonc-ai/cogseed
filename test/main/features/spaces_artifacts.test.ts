import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uArt';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-artifacts-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 空间内容目录（目录名跟随空间名，经 paths.spaceContentDir 解析）。 */
async function spaceDirFor(sid: string): Promise<string> {
  const paths = await import('../../../src/main/paths');
  return paths.spaceContentDir(UID, sid);
}

describe('spaces › listSpaceArtifacts（空间产物聚合）', () => {
  it('聚合 AI 产出文件（消息 produced[]），word/pdf 落产物列表', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '绘画空间' });
    if (!created.ok) throw new Error('create space failed');
    const sid = created.space.space_id;
    const conv = await chats.createConversation(UID, { title: '绘画', spaceId: sid });

    // 模拟 AI 产出两个文件：word + pdf（放临时根下任意位置，produced 用绝对路径）
    const wsRoot = path.join(tmpDir, UID, 'userWorkSpace', '绘画');
    fs.mkdirSync(wsRoot, { recursive: true });
    const docx = path.join(wsRoot, '周末去北京怎么玩.docx');
    const pdf = path.join(wsRoot, '报告.pdf');
    fs.writeFileSync(docx, 'x');
    fs.writeFileSync(pdf, 'x');

    // 往会话 jsonl 写一条带 produced 的消息（commander 产出）
    const msgFile = path.join(tmpDir, UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    fs.appendFileSync(msgFile, JSON.stringify({
      id: 'm1', from: 'commander', ts: new Date().toISOString(),
      text: '已生成', produced: [docx, pdf],
    }) + '\n');

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, sid);
    const names = artifacts.map((a) => a.name);
    expect(names).toContain('周末去北京怎么玩.docx');
    expect(names).toContain('报告.pdf');
    // 类型按附件处理（前端按扩展名分类为「文档」）
    const docxEntry = artifacts.find((a) => a.name === '周末去北京怎么玩.docx');
    expect(docxEntry?.type).toBe('attachment');
    expect(docxEntry?.ext).toBe('.docx');
    expect(docxEntry?.sourceSessionId).toBe(conv.conversation_id);
  });

  it('不存在的 produced 路径跳过（文件已删不占位）', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '空' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: 't', spaceId: created.space.space_id });

    const ghost = path.join(tmpDir, 'ghost.docx'); // 不存在
    const msgFile = path.join(tmpDir, UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    fs.appendFileSync(msgFile, JSON.stringify({
      id: 'm1', from: 'commander', ts: new Date().toISOString(),
      text: 'x', produced: [ghost],
    }) + '\n');

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
    expect(artifacts.filter((a) => a.name === 'ghost.docx')).toHaveLength(0);
  });
});

describe('spaces › 产物无确认态（COGSEED-16：产出即正式）', () => {
  async function makeSpaceWithProduced() {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '确认空间' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: 't', spaceId: created.space.space_id });
    const file = path.join(tmpDir, UID, 'userWorkSpace', 't', '成果.docx');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    const msgFile = path.join(tmpDir, UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    fs.appendFileSync(msgFile, JSON.stringify({
      id: 'm1', from: 'commander', ts: new Date().toISOString(), text: 'x', produced: [file],
    }) + '\n');
    return { sid: created.space.space_id, cid: conv.conversation_id, file };
  }

  it('AI 产出直接正式（confirmed=true），无需确认动作', async () => {
    const { sid } = await makeSpaceWithProduced();
    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, sid);
    const entry = artifacts.find((a) => a.name === '成果.docx');
    expect(entry).toBeTruthy();
    expect(entry?.source).toBe('produced');
    expect(entry?.confirmed).toBe(true); // 无确认态：产出即正式
  });

  it('无 artifacts_state.json 时产物同样正式（不再依赖确认清单）', async () => {
    const { sid } = await makeSpaceWithProduced();
    const stateFile = path.join(await spaceDirFor(sid), 'artifacts_state.json');
    expect(fs.existsSync(stateFile)).toBe(false); // 确认流程移除后不再生成状态文件
    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, sid);
    expect(artifacts.every((a) => a.confirmed === true)).toBe(true);
  });

  it('附件直接算正式（无需确认）', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '附' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: 'a', spaceId: created.space.space_id });
    // 上传附件（chatAttachmentDir = cloud/chat_attachments/<cid>）
    const attDir = path.join(tmpDir, UID, 'cloud', 'chat_attachments', conv.conversation_id);
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, '上传资料.pdf'), 'x');

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
    const entry = artifacts.find((a) => a.name === '上传资料.pdf');
    expect(entry?.source).toBe('attachment');
    expect(entry?.confirmed).toBe(true);
  });
});

describe('spaces › 工作区兜底扫描（未登记 produced 的产物文件）', () => {
  it('消息 produced 没记录、但存在于会话工作区的文件也进产物（md/html）', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '兜底空间' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: '报告', spaceId: created.space.space_id });

    // 会话工作区目录（由 getConversationWorkspacePath 解析真实落点）：AI 产出 3 个文件，但消息只记录了 docx
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const wsRoot = await getConversationWorkspacePath(UID, conv.conversation_id);
    fs.mkdirSync(wsRoot, { recursive: true });
    const docx = path.join(wsRoot, '报告.docx');
    const md = path.join(wsRoot, '报告.md');
    const html = path.join(wsRoot, '报告.html');
    fs.writeFileSync(docx, 'x');
    fs.writeFileSync(md, 'x');
    fs.writeFileSync(html, 'x');

    // 消息 produced 只记录 docx
    const msgFile = path.join(tmpDir, UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    fs.appendFileSync(msgFile, JSON.stringify({
      id: 'm1', from: 'commander', ts: new Date().toISOString(), text: 'x', produced: [docx],
    }) + '\n');

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
    const names = artifacts.map((a) => a.name).sort();
    expect(names).toContain('报告.docx');
    expect(names).toContain('报告.md');   // 工作区兜底
    expect(names).toContain('报告.html'); // 工作区兜底（html 放行）
    const htmlEntry = artifacts.find((a) => a.name === '报告.html');
    expect(htmlEntry?.source).toBe('produced');
    expect(htmlEntry?.confirmed).toBe(true); // COGSEED-16：兜底扫描的产出同样直接正式
  });
});

describe('spaces › 严格落位（子目录 / 宽扩展名 / 双目录 artifact）', () => {
  it('工作区子目录产物 + 宽扩展名（.svg）也收', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '严格空间' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: '设计', spaceId: created.space.space_id });
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const wsRoot = await getConversationWorkspacePath(UID, conv.conversation_id);
    // 子目录 output/ 里放 .svg（宽扩展名）和 .doc（旧 Office）
    const outDir = path.join(wsRoot, 'output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, '架构图.svg'), 'x');
    fs.writeFileSync(path.join(outDir, '旧版.doc'), 'x');
    // 消息 produced 为空（都没登记）
    const msgFile = path.join(tmpDir, UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    fs.writeFileSync(msgFile, '');

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
    const names = artifacts.map((a) => a.name);
    expect(names).toContain('架构图.svg');
    expect(names).toContain('旧版.doc');
  });

  it('全局 chat_artifacts 的 web artifact（新产出未迁移）也收', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '网页空间' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: 'web', spaceId: created.space.space_id });
    // 新 web artifact 落全局 chat_artifacts/<cid>/<aid>
    const artDir = path.join(tmpDir, UID, 'cloud', 'chat_artifacts', conv.conversation_id, 'demo-web');
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(artDir, '__cogseed-meta.json'), JSON.stringify({ title: '演示网页', createdAt: new Date().toISOString() }));

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
    const entry = artifacts.find((a) => a.artifactId === 'demo-web');
    expect(entry).toBeTruthy();
    expect(entry?.type).toBe('artifact');
    expect(entry?.source).toBe('artifact');
    expect(entry?.confirmed).toBe(true);
  });
});

describe('spaces › 附件落位与主流 coding agent 一致（上传不进空间文件夹）', () => {
  it('空间会话的聊天上传附件解析到全局 cloud/chat_attachments/，网页产物仍落空间目录', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const layout = await import('../../../src/main/util/project-layout');
    const created = await spaces.createSpace(UID, { name: '主流一致空间' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;
    const conv = await chats.createConversation(UID, { title: '任务', spaceId: sid });

    // 附件：即使透传 spaceHint，也解析到全局目录（空间文件夹只放产物）
    expect(layout.chatAttachmentDirForConversation(UID, conv.conversation_id, null, sid))
      .toBe(path.join(tmpDir, UID, 'cloud', 'chat_attachments', conv.conversation_id));
    expect(layout.chatAttachmentRelPath(UID, conv.conversation_id, 'a.pdf', null, sid))
      .toBe(`cloud/chat_attachments/${conv.conversation_id}/a.pdf`);
    // 网页交互产物（AI 产出）仍收进空间目录（目录名跟随空间名）
    expect(layout.chatArtifactCidDirForConversation(UID, conv.conversation_id, null, sid))
      .toBe(path.join(await spaceDirFor(sid), 'chat_artifacts', conv.conversation_id));
  });

  it('历史已迁入空间目录的附件反向迁回全局（空间文件夹只留产物）', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const arts = await import('../../../src/main/features/spaces_artifacts');
    const created = await spaces.createSpace(UID, { name: '反向迁移空间' });
    if (!created.ok) throw new Error('create failed');
    const sid = created.space.space_id;
    const conv = await chats.createConversation(UID, { title: '任务', spaceId: sid });

    // 模拟旧版数据：附件在空间目录、网页产物在全局（空间目录按命名目录解析）
    const spaceAtt = path.join(await spaceDirFor(sid), 'chat_attachments', conv.conversation_id);
    fs.mkdirSync(spaceAtt, { recursive: true });
    fs.writeFileSync(path.join(spaceAtt, '旧上传.pdf'), 'x');
    const globalArt = path.join(tmpDir, UID, 'cloud', 'chat_artifacts', conv.conversation_id);
    fs.mkdirSync(globalArt, { recursive: true });
    fs.writeFileSync(path.join(globalArt, 'index.html'), 'x');

    await arts.migrateSpaceAttachments(UID, sid);

    // 附件：空间 → 全局
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'chat_attachments', conv.conversation_id, '旧上传.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(spaceAtt, '旧上传.pdf'))).toBe(false);
    // 网页产物：全局 → 空间
    expect(fs.existsSync(path.join(await spaceDirFor(sid), 'chat_artifacts', conv.conversation_id, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(globalArt, 'index.html'))).toBe(false);
  });
});

describe('spaces › 兜底遍历护栏（工作目录解析异常防全盘遍历）', () => {
  it('isUnsafeWorkspaceRoot：主目录/盘根/.cogseed 目录拦截，正常项目目录放行', async () => {
    const arts = await import('../../../src/main/features/spaces_artifacts');
    expect(arts.isUnsafeWorkspaceRoot(os.homedir())).toBe(true); // 事故场景：整个主目录
    expect(arts.isUnsafeWorkspaceRoot(path.parse(os.homedir()).root)).toBe(true); // 文件系统根
    const fakeCogseed = path.join(tmpDir, 'a', '.cogseed', 'b');
    fs.mkdirSync(fakeCogseed, { recursive: true });
    expect(arts.isUnsafeWorkspaceRoot(fakeCogseed)).toBe(true); // CogSeed 自身数据目录
    const normal = path.join(tmpDir, 'normal-project');
    fs.mkdirSync(normal, { recursive: true });
    expect(arts.isUnsafeWorkspaceRoot(normal)).toBe(false); // 主目录下的正常项目不拦截
    expect(arts.isUnsafeWorkspaceRoot(path.join(tmpDir, 'does-not-exist'))).toBe(false);
  });

  it('兜底遍历跳过 node_modules / __pycache__，正常文件仍收', async () => {
    const spaces = await import('../../../src/main/features/spaces');
    const chats = await import('../../../src/main/features/chats');
    const created = await spaces.createSpace(UID, { name: '护栏空间' });
    if (!created.ok) throw new Error('create failed');
    const conv = await chats.createConversation(UID, { title: '护栏', spaceId: created.space.space_id });
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const wsRoot = await getConversationWorkspacePath(UID, conv.conversation_id);
    fs.mkdirSync(path.join(wsRoot, 'node_modules', 'x'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'node_modules', 'x', 'big.js'), 'x');
    fs.writeFileSync(path.join(wsRoot, '__pycache__', 'c.pyc'), 'x');
    fs.writeFileSync(path.join(wsRoot, 'keep.md'), 'keep');

    const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
    const names = artifacts.map((a) => a.name);
    expect(names).toContain('keep.md');
    expect(names).not.toContain('big.js');
    expect(names).not.toContain('c.pyc');
  });

  it('遍历计数超限：中止并回滚兜底结果，produced 登记产物不受影响', async () => {
    const prevLimit = process.env.SPACE_ARTIFACTS_WALK_LIMIT;
    process.env.SPACE_ARTIFACTS_WALK_LIMIT = '10';
    vi.resetModules();
    try {
      const spaces = await import('../../../src/main/features/spaces');
      const chats = await import('../../../src/main/features/chats');
      const created = await spaces.createSpace(UID, { name: '超限空间' });
      if (!created.ok) throw new Error('create failed');
      const conv = await chats.createConversation(UID, { title: '超限', spaceId: created.space.space_id });
      const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
      const wsRoot = await getConversationWorkspacePath(UID, conv.conversation_id);
      fs.mkdirSync(wsRoot, { recursive: true });
      // 15 个兜底文件 + 1 个 produced 登记文件
      for (let i = 0; i < 15; i++) fs.writeFileSync(path.join(wsRoot, `f${i}.md`), 'x');
      const registered = path.join(wsRoot, 'registered.md');
      fs.writeFileSync(registered, 'x');
      const msgFile = path.join(tmpDir, UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
      fs.writeFileSync(msgFile, JSON.stringify({
        id: 'm1', from: 'commander', ts: new Date().toISOString(), text: 'x', produced: [registered],
      }) + '\n');

      const artifacts = await (await import('../../../src/main/features/spaces_artifacts')).listSpaceArtifacts(UID, created.space.space_id);
      const names = artifacts.map((a) => a.name);
      // 兜底结果整体回滚：15 个文件一个都不该出现
      for (let i = 0; i < 15; i++) expect(names).not.toContain(`f${i}.md`);
      // produced 登记的产物保留
      expect(names).toContain('registered.md');
    } finally {
      if (prevLimit === undefined) delete process.env.SPACE_ARTIFACTS_WALK_LIMIT;
      else process.env.SPACE_ARTIFACTS_WALK_LIMIT = prevLimit;
    }
  });
});
