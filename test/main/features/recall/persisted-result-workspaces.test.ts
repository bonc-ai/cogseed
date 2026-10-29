import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const UID = 'result-workspace-user';
const BODY = 'Owner: synthetic-role. Acceptance: the synthetic review is recorded.';
let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-result-workspaces-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = path.join(root, 'data');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  // `system-alias` 用例把一个 junction 指向 OS 临时根（win32 没有 symlink 语义时
  // 的别名形态）。递归删除一旦走进这个 reparse point，就会在 root 本身上报
  // 「The name of the file cannot be resolved by the system」——清理阶段失败，
  // 与用例结论无关。先摘链接，让递归删除只处理本用例自己的树。
  try { fs.unlinkSync(path.join(root, 'system-alias')); } catch { /* 未创建 / 已摘除 */ }
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, text = BODY): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function modules() {
  const [chats, workspaces, convWorkspaces, results, layout, paths, storage] = await Promise.all([
    import('../../../../src/main/features/chats'),
    import('../../../../src/main/features/user_workspace'),
    import('../../../../src/main/features/group_chat/conv_workspace'),
    import('../../../../src/main/features/recall/persisted-result-content'),
    import('../../../../src/main/util/project-layout'),
    import('../../../../src/main/paths'),
    import('../../../../src/main/storage'),
  ]);
  const defaultRoot = path.join(root, 'workspaces', 'default');
  fs.mkdirSync(defaultRoot, { recursive: true });
  expect(workspaces.setWorkspacePath(UID, defaultRoot).ok).toBe(true);
  return { chats, workspaces, convWorkspaces, results, layout, paths, storage, defaultRoot };
}

async function stateFile(cid: string, state: Record<string, unknown>) {
  const { conversationLayout } = await import('../../../../src/main/util/project-layout');
  return write(conversationLayout(UID, cid).stateFile, JSON.stringify({ version: 1, status: 'idle', ...state }));
}

async function scopedConversation(kind: 'space' | 'explicit') {
  const m = await modules();
  let spaceId: string | undefined;
  if (kind === 'space') {
    const spaces = await import('../../../../src/main/features/spaces');
    const created = await spaces.createSpace(UID, { name: 'Synthetic result space' });
    if (!created.ok) throw new Error('space fixture failed');
    spaceId = created.space.space_id;
  }
  const conversation = await m.chats.createConversation(UID, { title: 'Synthetic result', ...(spaceId ? { spaceId } : {}) });
  const cid = conversation.conversation_id;
  const workspace = spaceId ? m.paths.spaceWorkspaceDir(UID, spaceId) : path.join(root, 'explicit-project');
  const file = write(path.join(workspace, 'deliverable.md'));
  if (kind === 'explicit') await stateFile(cid, { coding_project_dir: workspace, coding_project_dir_explicit: true });
  return { ...m, cid, workspace, file };
}

describe('persisted result workspace authorization', () => {
  it('keeps default/project workspace and conversation attachment contracts without selecting a slug', async () => {
    const m = await modules();
    const projectId = 'synthetic-result-project';
    await m.storage.writeJson(m.paths.projectMetaFile(UID, projectId), { project_id: projectId, name: 'Synthetic result project' });
    const projectRoot = path.join(root, 'workspaces', 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    expect(m.workspaces.setWorkspacePath(UID, projectRoot, projectId).ok).toBe(true);
    const conversations = [
      { conversation: await m.chats.createConversation(UID, { title: 'Default result' }), workspace: m.defaultRoot },
      { conversation: await m.chats.createConversation(UID, { title: 'Project result', projectId }), workspace: projectRoot },
    ];
    for (const { conversation, workspace } of conversations) {
      const cid = conversation.conversation_id;
      const state = m.layout.conversationLayout(UID, cid).stateFile;
      const before = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : undefined;
      const files = [write(path.join(workspace, 'historical.md')), write(path.join(m.layout.chatAttachmentDirForConversation(UID, cid), 'attachment.txt'))];
      const content = await m.results.readPersistedResultContent(UID, cid, { id: 'reply-default', produced: files });
      expect(content.coverage).toEqual({ complete: true, totalFiles: 2, readableFiles: 2 });
      expect(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : undefined).toBe(before);
    }
    expect(await m.convWorkspaces.getConversationWorkspacePath(UID, 'missing-conversation')).toBe(m.defaultRoot);
    const missing = await m.results.readPersistedResultContent(UID, 'missing-conversation', {
      id: 'reply-missing', produced: [path.join(m.defaultRoot, 'historical.md')],
    });
    expect(missing.coverage).toEqual({ complete: false, totalFiles: 1, readableFiles: 0 });
  });

  it('reads space and legacy-root results without creating the target or migrating legacy files', async () => {
    const m = await scopedConversation('space');
    const legacy = write(path.join(m.defaultRoot, 'legacy-result', 'legacy.md'));
    const state = await stateFile(m.cid, { workspace_dir: 'legacy-result' });
    const before = fs.readFileSync(state, 'utf8');
    const target = path.join(m.workspace, 'legacy-result');
    const content = await m.results.readPersistedResultContent(UID, m.cid, { id: 'reply-space', produced: [m.file, legacy] });
    expect(content.coverage).toEqual({ complete: true, totalFiles: 2, readableFiles: 2 });
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(state, 'utf8')).toBe(before);
    const unused = await m.chats.createConversation(UID, { title: 'No output workspace' });
    const unusedState = m.layout.conversationLayout(UID, unused.conversation_id).stateFile;
    const unusedBefore = fs.existsSync(unusedState) ? fs.readFileSync(unusedState, 'utf8') : undefined;
    await m.convWorkspaces.getConversationWorkspaceReadRoots(UID, unused.conversation_id);
    expect(fs.existsSync(unusedState) ? fs.readFileSync(unusedState, 'utf8') : undefined).toBe(unusedBefore);
    expect(fs.existsSync(path.join(m.defaultRoot, 'no-output-workspace'))).toBe(false);
  });

  it.each(['implicit', 'missing', 'not-directory', 'system-root', 'system-alias'] as const)(
    'does not authorize a %s explicit-workspace binding or its neighboring files', async fault => {
      const m = await modules();
      const conversation = await m.chats.createConversation(UID, { title: 'Invalid binding result' });
      const outside = write(path.join(root, 'unrelated', 'result.md'), 'Unauthorised synthetic content.');
      let selected = path.dirname(outside);
      if (fault === 'missing') selected = path.join(root, 'removed-selection');
      if (fault === 'not-directory') selected = write(path.join(root, 'selected-file.txt'));
      if (fault === 'system-root') selected = os.tmpdir();
      if (fault === 'system-alias') {
        selected = path.join(root, 'system-alias');
        fs.symlinkSync(os.tmpdir(), selected, process.platform === 'win32' ? 'junction' : 'dir');
      }
      await stateFile(conversation.conversation_id, {
        workspace_dir: path.relative(m.defaultRoot, path.dirname(outside)),
        coding_project_dir: selected, coding_project_dir_explicit: fault !== 'implicit',
      });
      expect(await m.convWorkspaces.getConversationWorkspaceReadRoots(UID, conversation.conversation_id)).toEqual([m.defaultRoot]);
      const content = await m.results.readPersistedResultContent(UID, conversation.conversation_id, { id: 'reply-invalid', produced: [outside] });
      expect(content.coverage).toEqual({ complete: false, totalFiles: 1, readableFiles: 0 });
      expect(content.refs[1].status).toBe('unverified');
      expect(content.text).not.toContain('Unauthorised');
    },
  );

  it('rejects neighboring roots, traversal and symlink escapes rather than trusting produced paths', async () => {
    const m = await scopedConversation('explicit');
    const outside = write(path.join(m.workspace + '-neighbor', 'private.md'), 'Unauthorised neighboring content.');
    const link = path.join(m.workspace, 'escape.md');
    fs.symlinkSync(outside, link);
    const content = await m.results.readPersistedResultContent(UID, m.cid, { id: 'reply-escape', produced: [
      outside, path.join(m.workspace, '..', path.basename(m.workspace) + '-neighbor', 'private.md'), link,
    ] });
    expect(content.coverage.complete).toBe(false);
    expect(content.coverage.readableFiles).toBe(0);
    expect(content.refs.slice(1).every(ref => ref.status === 'unverified')).toBe(true);
    expect(content.text).not.toContain('Unauthorised');
  });

  it.each(['space', 'explicit'] as const)('carries a %s deliverable into adoption evidence, then invalidates changed content', async kind => {
    const m = await scopedConversation(kind);
    const message = { id: 'scoped-reply', from: 'commander', turn_id: 'scoped-task', turn_end: true,
      text: 'The deliverable is available.', produced: [m.file] };
    await m.storage.appendJsonlAtomic(m.layout.conversationMessageFile(UID, m.cid), message);
    const injections = await import('../../../../src/main/features/recall/injection-receipt');
    await injections.recordInjectionReceipt(UID, { taskRunId: 'scoped-task', projectionId: 'scoped-projection',
      assetId: 'asset-synthetic', assetVersion: '1', messageId: message.id, boundary: 'real', status: 'injected' });
    const claims = await import('../../../../src/main/features/recall/asset-usage-claim');
    const receipts = await claims.finalizeAssetUsageClaims(UID, { cid: m.cid, taskRunId: message.turn_id, messageId: message.id,
      claims: [{ assetId: 'asset-synthetic', assetVersion: '1', outputExcerpt: BODY }] });
    expect(receipts).toEqual([expect.objectContaining({ status: 'applied', resultCoverage: { complete: true, totalFiles: 1, readableFiles: 1 },
      outputEvidence: { refId: expect.stringMatching(/^result-/), start: expect.any(Number), end: expect.any(Number) } })]);

    const executions = await import('../../../../src/main/features/execution-records');
    const executionResults = await import('../../../../src/main/features/recall/execution-result-content');
    await executions.create(UID, { executionId: 'turn-scoped-task', kind: 'core-agent', sessionId: 'synthetic-session',
      conversationId: m.cid, agentId: 'commander', boundary: 'real', permissionMode: 'read-only', bindResultMessage: true });
    await executions.complete(UID, 'turn-scoped-task', { status: 'completed', output: message.text });
    await executionResults.bindExecutionResultMessage(UID, 'turn-scoped-task', m.cid, message);
    const record = await executions.read(UID, 'turn-scoped-task');
    write(m.file, 'A later revision no longer contains the cited evidence.');
    await expect(executionResults.readExecutionResultContent(UID, record)).rejects.toThrow('changed or incomplete');
  });
});
