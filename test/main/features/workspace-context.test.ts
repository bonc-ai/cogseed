import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createWorkspaceResolver,
  workspacePolicyFor,
  type WorkspaceResolverDeps,
} from '../../../src/main/features/workspace-context';

let tmpRoot: string;
let defaultRoot: string;
let projectRoot: string;
let spaceRoot: string;
let codingRoot: string;
let attachmentDir: string;
let attachmentFile: string;
let referenceDir: string;
let tempDir: string;
let missingRoot: string;
let fileRoot: string;

beforeEach(() => {
  // Windows 的 os.tmpdir() 常是 8.3 短名（`C:\Users\RUNNER~1\…`）。resolver 用的
  // `fs.promises.realpath` 走 native 解析，会把它展开成长名；非 native 的
  // `fs.realpathSync` 不展开，于是期望值留短名、实际值变长名，断言必然不等。
  // 两侧统一用 native 规范化后再比。
  tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-workspace-')));
  defaultRoot = path.join(tmpRoot, 'default');
  projectRoot = path.join(tmpRoot, 'project');
  spaceRoot = path.join(tmpRoot, 'space');
  codingRoot = path.join(tmpRoot, 'coding');
  attachmentDir = path.join(tmpRoot, 'attachments');
  attachmentFile = path.join(attachmentDir, 'input.txt');
  referenceDir = path.join(tmpRoot, 'references');
  tempDir = path.join(tmpRoot, 'temp');
  missingRoot = path.join(tmpRoot, 'missing');
  fileRoot = path.join(tmpRoot, 'not-a-directory');
  for (const dir of [defaultRoot, projectRoot, spaceRoot, codingRoot, attachmentDir, referenceDir, tempDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(attachmentFile, 'attachment');
  fs.writeFileSync(fileRoot, 'not a directory');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeDeps(overrides: Partial<WorkspaceResolverDeps> = {}): WorkspaceResolverDeps {
  const base: WorkspaceResolverDeps = {
    async getWorkspaceInfo(_userId, projectId) {
      if (projectId === 'project-1') {
        return { currentPath: projectRoot, defaultPath: defaultRoot, isDefault: false };
      }
      return { currentPath: defaultRoot, defaultPath: defaultRoot, isDefault: true };
    },
    async getConversation() { return null; },
    async getSpace() { return null; },
    getSpaceWorkspaceDir(userId, spaceId) {
      return path.join(tmpRoot, 'spaces', spaceId, 'workspace');
    },
    async getConversationWorkspacePath() { return defaultRoot; },
    realpath: (candidate) => fs.promises.realpath(candidate),
    async stat(candidate) {
      const value = await fs.promises.stat(candidate);
      return { isDirectory: value.isDirectory() };
    },
    async access(candidate) {
      await fs.promises.access(candidate, fs.constants.R_OK | fs.constants.W_OK);
    },
    defaultWorkspace: () => defaultRoot,
    homedir: () => path.join(tmpRoot, 'home'),
    platform: () => 'darwin',
    now: () => '2026-10-19T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

describe('WorkspaceContext resolver', () => {
  it('resolves the default workspace when no scope is provided', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {});
    expect(context).toMatchObject({
      id: 'default:user-1',
      source: 'default',
      status: 'ok',
      root: defaultRoot,
    });
    expect(context.writableRoots).toContain(defaultRoot);
    expect(context.diagnostics).toMatchObject({ resolvedAt: '2026-10-19T00:00:00.000Z' });
  });

  it('resolves a project-selected external workspace', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', { projectId: 'project-1' });
    expect(context).toMatchObject({ source: 'project', status: 'ok', root: projectRoot });
  });

  it('resolves a space project_dir external workspace', async () => {
    const deps = makeDeps({
      getConversation: async () => ({ space_id: 'space-1' }),
      getSpace: async () => ({ project_dir: spaceRoot }),
      getConversationWorkspacePath: async () => spaceRoot,
    });
    const context = await createWorkspaceResolver(deps)('user-1', { conversationId: 'conv-1' });
    expect(context).toMatchObject({ source: 'space', status: 'ok', root: spaceRoot });
  });

  it('resolves a conversation coding_project_dir external workspace', async () => {
    const deps = makeDeps({
      getConversation: async () => ({}),
      getConversationWorkspacePath: async () => codingRoot,
    });
    const context = await createWorkspaceResolver(deps)('user-1', { conversationId: 'conv-1' });
    expect(context).toMatchObject({ source: 'conversation', status: 'ok', root: codingRoot });
  });

  it('keeps an existing task root when it is inside the declared roots', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { taskId: 'task-1', workspaceRoot: spaceRoot, spaceId: 'space-1' },
      declaredRoots: [spaceRoot],
    });
    expect(context).toMatchObject({
      id: 'task:task-1',
      source: 'task',
      status: 'ok',
      root: spaceRoot,
    });
  });

  it('reports one resolution observation through the metrics hook', async () => {
    const observations: Array<{ status: string; source: string; userId: string; durationMs: number }> = [];
    const deps = makeDeps({
      onResolved(context, durationMs, userId) {
        observations.push({ status: context.status, source: context.source, userId, durationMs });
      },
    });
    await createWorkspaceResolver(deps)('user-1', {});

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ status: 'ok', source: 'default', userId: 'user-1' });
    expect(observations[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects an existing task root outside the declared roots instead of silently moving it', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { taskId: 'task-1', workspaceRoot: projectRoot },
      declaredRoots: [spaceRoot],
    });
    expect(context).toMatchObject({
      source: 'task',
      status: 'denied',
      root: projectRoot,
      diagnostics: { code: 'E_WORKSPACE_OUTSIDE_DECLARED_ROOTS' },
    });
  });

  it('reports a missing workspace directory', async () => {
    const deps = makeDeps({ getConversationWorkspacePath: async () => missingRoot });
    const context = await createWorkspaceResolver(deps)('user-1', { conversationId: 'conv-1' });
    expect(context).toMatchObject({
      status: 'missing',
      diagnostics: { code: 'E_WORKSPACE_NOT_FOUND' },
    });
    expect(context.writableRoots).toEqual([]);
  });

  it('reports a path that is not a directory', async () => {
    const deps = makeDeps({ getConversationWorkspacePath: async () => fileRoot });
    const context = await createWorkspaceResolver(deps)('user-1', { conversationId: 'conv-1' });
    expect(context).toMatchObject({
      status: 'not-directory',
      diagnostics: { code: 'E_WORKSPACE_NOT_DIRECTORY' },
    });
  });

  it('rejects the filesystem root', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { workspaceRoot: '/' },
    });
    expect(context).toMatchObject({
      status: 'denied',
      diagnostics: { code: 'E_WORKSPACE_PERMISSION_DENIED' },
    });
  });

  it('rejects a relative path', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { workspaceRoot: 'relative/workspace' },
    });
    expect(context).toMatchObject({
      status: 'denied',
      diagnostics: { code: 'E_WORKSPACE_INVALID_PATH' },
    });
  });

  it('classifies a TCC access denial as tcc-blocked', async () => {
    const deps = makeDeps({
      async access() {
        const error = new Error('Operation not permitted');
        (error as NodeJS.ErrnoException).code = 'EACCES';
        throw error;
      },
      isTccBlocked: () => true,
    });
    const context = await createWorkspaceResolver(deps)('user-1', {
      task: { taskId: 'task-1', workspaceRoot: spaceRoot },
    });
    expect(context).toMatchObject({
      status: 'tcc-blocked',
      diagnostics: { code: 'E_WORKSPACE_TCC_BLOCKED' },
    });
  });

  it('returns untrusted without granting roots', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { taskId: 'task-1', workspaceRoot: spaceRoot },
      trusted: false,
    });
    expect(context).toMatchObject({
      status: 'untrusted',
      diagnostics: { code: 'E_WORKSPACE_UNTRUSTED' },
      writableRoots: [],
    });
  });

  it('builds writable, read-only and protected roots', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { taskId: 'task-1', workspaceRoot: spaceRoot },
      attachmentRoots: [attachmentDir, attachmentFile],
      readOnlyRoots: [referenceDir],
      tempRoots: [tempDir],
    });
    expect(context.status).toBe('ok');
    expect(context.writableRoots).toEqual([spaceRoot, tempDir]);
    expect(context.readOnlyRoots).toEqual([attachmentDir, attachmentFile, referenceDir]);
    expect(context.protectedPaths).toEqual([path.join(spaceRoot, '.git')]);
  });

  it('rejects a symlink that resolves outside the declared roots', async () => {
    const link = path.join(tmpRoot, 'link-to-project');
    fs.symlinkSync(projectRoot, link, 'dir');
    const context = await createWorkspaceResolver(makeDeps())('user-1', {
      task: { taskId: 'task-1', workspaceRoot: link },
      declaredRoots: [spaceRoot],
    });
    expect(context).toMatchObject({
      status: 'denied',
      root: projectRoot,
      diagnostics: { code: 'E_WORKSPACE_OUTSIDE_DECLARED_ROOTS' },
    });
  });

  it('maps permission modes without granting full disk access', async () => {
    const context = await createWorkspaceResolver(makeDeps())('user-1', {});
    expect(workspacePolicyFor(context, 'ask')).toEqual({
      mode: 'workspace-write',
      approval: 'ask',
      enforcement: 'in-process',
    });
    expect(workspacePolicyFor(context, 'full')).toEqual({
      mode: 'workspace-write',
      approval: 'on-request',
      enforcement: 'in-process',
    });
    expect(workspacePolicyFor(context, 'full', { dangerFullAccess: true })).toEqual({
      mode: 'danger-full-access',
      approval: 'never',
      enforcement: 'in-process',
    });
    const missing = await createWorkspaceResolver(makeDeps({
      getConversationWorkspacePath: async () => missingRoot,
    }))('user-1', { conversationId: 'conv-1' });
    expect(workspacePolicyFor(missing, 'full')).toEqual({
      mode: 'read-only',
      approval: 'never',
      enforcement: 'in-process',
    });
  });
});
