/**
 * WorkspaceContext — one resolved filesystem boundary for every execution
 * layer (native runtime, core-agent, local CLI, terminal, IPC, gateways).
 *
 * The resolver is intentionally dependency-injected so it can be unit-tested
 * without Electron. Production defaults are loaded lazily to avoid cycles
 * with `user_workspace`, `chats`, `spaces` and `conv_workspace`.
 *
 * See docs: `CogSeed-工作空间生产级技术改造方案.md` (ADR-006/007).
 */

import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPathAllowed, isSystemTmpDir } from '../util/path-sandbox';

export type WorkspaceSource = 'task' | 'conversation' | 'space' | 'project' | 'default';

export type WorkspaceStatus =
  | 'ok'
  | 'missing'
  | 'not-directory'
  | 'denied'
  | 'untrusted'
  | 'tcc-blocked';

export type WorkspaceErrorCode =
  | 'E_WORKSPACE_NOT_FOUND'
  | 'E_WORKSPACE_NOT_DIRECTORY'
  | 'E_WORKSPACE_OUTSIDE_DECLARED_ROOTS'
  | 'E_WORKSPACE_PERMISSION_DENIED'
  | 'E_WORKSPACE_UNTRUSTED'
  | 'E_WORKSPACE_TCC_BLOCKED'
  | 'E_WORKSPACE_INVALID_PATH';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ApprovalMode = 'ask' | 'on-failure' | 'on-request' | 'never';

export interface WorkspaceCapabilities {
  agents: readonly string[];
  skills: readonly string[];
  presets: readonly string[];
}

export interface WorkspaceContextDiagnostics {
  requestedPath?: string;
  reason?: string;
  code?: WorkspaceErrorCode;
  resolvedAt: string;
}

export interface WorkspaceContext {
  /** Stable identity; never a raw path. */
  id: string;
  /** Canonical absolute root. */
  root: string;
  source: WorkspaceSource;
  status: WorkspaceStatus;
  writableRoots: readonly string[];
  readOnlyRoots: readonly string[];
  tempRoots: readonly string[];
  protectedPaths: readonly string[];
  capabilities: WorkspaceCapabilities;
  diagnostics: WorkspaceContextDiagnostics;
}

export interface WorkspacePolicy {
  mode: SandboxMode;
  approval: ApprovalMode;
  enforcement: 'in-process' | 'os-full' | 'os-partial';
}

export interface WorkspaceTaskInput {
  taskId?: string;
  /** Canonical root persisted on the task (preferred). */
  workspaceRoot?: string;
  /** Legacy field; used when workspaceRoot is absent. */
  workingDir?: string;
  spaceId?: string;
  projectId?: string;
}

export interface WorkspaceResolveInput {
  task?: WorkspaceTaskInput;
  conversationId?: string;
  spaceId?: string;
  projectId?: string;
  /** Trust is recorded by the UI/trust store; default true for legacy callers. */
  trusted?: boolean;
  /** Space/project declared roots; an existing task root must be inside them. */
  declaredRoots?: readonly string[];
  /** Attachment directories/files; added as read-only roots. */
  attachmentRoots?: readonly string[];
  /** Explicit read-only roots (skills, references). */
  readOnlyRoots?: readonly string[];
  /** Override the platform temp roots (tests / deterministic callers). */
  tempRoots?: readonly string[];
  capabilities?: Partial<WorkspaceCapabilities>;
}

export interface WorkspaceResolverDeps {
  getWorkspaceInfo(userId: string, projectId?: string): Promise<{
    currentPath: string;
    defaultPath: string;
    isDefault: boolean;
  }>;
  getConversation(userId: string, conversationId: string): Promise<{
    project_id?: string;
    space_id?: string;
  } | null>;
  getSpace(userId: string, spaceId: string): Promise<{ project_dir?: string } | null>;
  getSpaceWorkspaceDir(userId: string, spaceId: string): string;
  getConversationWorkspacePath(userId: string, conversationId: string): Promise<string>;
  realpath(candidate: string): Promise<string>;
  stat(candidate: string): Promise<{ isDirectory: boolean }>;
  access(candidate: string): Promise<void>;
  defaultWorkspace(): Promise<string> | string;
  homedir(): string;
  platform(): NodeJS.Platform;
  now(): string;
  dataRoot?: string;
  /** Future macOS TCC classification; default false keeps ADR-001 behavior. */
  isTccBlocked?(candidate: string): boolean;
  /** Best-effort observability hook; must not affect resolution. */
  onResolved?(context: WorkspaceContext, durationMs: number, userId: string): void;
}

export type WorkspaceResolver = (
  userId: string,
  input?: WorkspaceResolveInput,
) => Promise<WorkspaceContext>;

export const WORKSPACE_ERROR_MESSAGES: Record<WorkspaceErrorCode, string> = {
  E_WORKSPACE_NOT_FOUND: '工作空间目录不存在，请重新选择',
  E_WORKSPACE_NOT_DIRECTORY: '所选路径不是文件夹',
  E_WORKSPACE_OUTSIDE_DECLARED_ROOTS: '该目录不属于当前工作空间，请重新绑定',
  E_WORKSPACE_PERMISSION_DENIED: '没有权限访问该目录',
  E_WORKSPACE_UNTRUSTED: '首次使用该目录，请确认信任',
  E_WORKSPACE_TCC_BLOCKED: '系统未授权访问该目录，请在系统设置中授权',
  E_WORKSPACE_INVALID_PATH: '工作空间路径无效',
};

function emptyCapabilities(): WorkspaceCapabilities {
  return { agents: [], skills: [], presets: [] };
}

function normalizeCapabilities(input?: Partial<WorkspaceCapabilities>): WorkspaceCapabilities {
  const clean = (values: readonly string[] | undefined): string[] => (
    Array.isArray(values)
      ? Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
      : []
  );
  return {
    agents: clean(input?.agents),
    skills: clean(input?.skills),
    presets: clean(input?.presets),
  };
}

function isAbsolutePath(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.trim() !== '' && path.isAbsolute(candidate);
}

function errorCodeOf(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : '';
}

function sourceId(input: WorkspaceResolveInput, source: WorkspaceSource, userId: string): string {
  if (source === 'task') return `task:${input.task?.taskId || 'unknown'}`;
  if (source === 'space') return `space:${input.spaceId || input.task?.spaceId || 'unknown'}`;
  if (source === 'project') return `project:${input.projectId || input.task?.projectId || 'unknown'}`;
  if (source === 'conversation') return `conv:${input.conversationId || 'unknown'}`;
  return `default:${userId}`;
}

function sourceOfTask(input: WorkspaceResolveInput): string | null {
  return input.task?.workspaceRoot || input.task?.workingDir || null;
}

function forbiddenRootReason(root: string, deps: WorkspaceResolverDeps): string | null {
  const home = path.resolve(deps.homedir());
  if (root === path.parse(root).root) return 'filesystem-root';
  if (root === home) return 'home-root';
  const library = path.join(home, 'Library');
  if (root === library || root.startsWith(library + path.sep)) return 'library';
  if (deps.dataRoot) {
    const dataRoot = path.resolve(deps.dataRoot);
    if (root === dataRoot || root.startsWith(dataRoot + path.sep)) return 'cogseed-data';
  }
  if (isSystemTmpDir(root)) return 'system-tmp';
  return null;
}

function failContext(
  input: WorkspaceResolveInput,
  userId: string,
  source: WorkspaceSource,
  status: WorkspaceStatus,
  code: WorkspaceErrorCode,
  reason: string,
  root: string,
  requestedPath: string,
  deps: WorkspaceResolverDeps,
): WorkspaceContext {
  return {
    id: sourceId(input, source, userId),
    root,
    source,
    status,
    writableRoots: [],
    readOnlyRoots: [],
    tempRoots: [],
    protectedPaths: [],
    capabilities: normalizeCapabilities(input.capabilities),
    diagnostics: {
      requestedPath,
      reason,
      code,
      resolvedAt: deps.now(),
    },
  };
}

async function canonicalExistingPaths(
  candidates: readonly string[] | undefined,
  deps: WorkspaceResolverDeps,
  opts: { directoryOnly: boolean },
): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of candidates || []) {
    if (!isAbsolutePath(candidate)) continue;
    try {
      const real = await deps.realpath(candidate);
      const stat = await deps.stat(real);
      if ((!opts.directoryOnly || stat.isDirectory) && !out.includes(real)) out.push(real);
    } catch {
      // Missing/unreadable auxiliary roots are skipped; they are optional.
    }
  }
  return out;
}

async function defaultTempRoots(deps: WorkspaceResolverDeps): Promise<string[]> {
  const candidates = deps.platform() === 'win32'
    ? [os.tmpdir()]
    : ['/tmp', os.tmpdir()];
  const out: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = await deps.realpath(candidate);
      const stat = await deps.stat(real);
      if (stat.isDirectory && !out.includes(real)) out.push(real);
    } catch {
      // A missing temp root is not fatal; the platform may not expose it.
    }
  }
  return out;
}

async function evaluateCandidate(
  input: WorkspaceResolveInput,
  userId: string,
  source: WorkspaceSource,
  candidate: string,
  deps: WorkspaceResolverDeps,
): Promise<WorkspaceContext> {
  if (!isAbsolutePath(candidate)) {
    return failContext(input, userId, source, 'denied', 'E_WORKSPACE_INVALID_PATH',
      'workspace path must be absolute', candidate || '', candidate || '', deps);
  }

  let root: string;
  try {
    root = await deps.realpath(candidate);
  } catch (error) {
    const code = errorCodeOf(error);
    const status: WorkspaceStatus = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'denied';
    return failContext(input, userId, source, status,
      status === 'missing' ? 'E_WORKSPACE_NOT_FOUND' : 'E_WORKSPACE_PERMISSION_DENIED',
      `cannot resolve workspace: ${code || 'unknown'}`, path.resolve(candidate), candidate, deps);
  }

  try {
    const stat = await deps.stat(root);
    if (!stat.isDirectory) {
      return failContext(input, userId, source, 'not-directory', 'E_WORKSPACE_NOT_DIRECTORY',
        'workspace is not a directory', root, candidate, deps);
    }
  } catch (error) {
    const code = errorCodeOf(error);
    return failContext(input, userId, source, 'missing', 'E_WORKSPACE_NOT_FOUND',
      `cannot stat workspace: ${code || 'unknown'}`, root, candidate, deps);
  }

  const forbidden = forbiddenRootReason(root, deps);
  if (forbidden) {
    return failContext(input, userId, source, 'denied', 'E_WORKSPACE_PERMISSION_DENIED',
      `workspace root is not allowed: ${forbidden}`, root, candidate, deps);
  }

  const declaredRoots = (input.declaredRoots || []).filter(isAbsolutePath);
  if (declaredRoots.length && !isPathAllowed(root, declaredRoots)) {
    return failContext(input, userId, source, 'denied', 'E_WORKSPACE_OUTSIDE_DECLARED_ROOTS',
      'workspace is outside the declared space/project roots', root, candidate, deps);
  }

  try {
    await deps.access(root);
  } catch (error) {
    const code = errorCodeOf(error);
    if (deps.isTccBlocked?.(root)) {
      return failContext(input, userId, source, 'tcc-blocked', 'E_WORKSPACE_TCC_BLOCKED',
        'macOS denied access to the workspace', root, candidate, deps);
    }
    return failContext(input, userId, source, 'denied', 'E_WORKSPACE_PERMISSION_DENIED',
      `workspace access denied: ${code || 'unknown'}`, root, candidate, deps);
  }

  if (input.trusted === false) {
    return {
      id: sourceId(input, source, userId),
      root,
      source,
      status: 'untrusted',
      writableRoots: [],
      readOnlyRoots: [],
      tempRoots: [],
      protectedPaths: [],
      capabilities: normalizeCapabilities(input.capabilities),
      diagnostics: {
        requestedPath: candidate,
        reason: 'workspace has not been trusted',
        code: 'E_WORKSPACE_UNTRUSTED',
        resolvedAt: deps.now(),
      },
    };
  }

  const tempRoots = input.tempRoots === undefined
    ? await defaultTempRoots(deps)
    : await canonicalExistingPaths(input.tempRoots, deps, { directoryOnly: true });
  const readOnlyRoots = [
    ...await canonicalExistingPaths(input.attachmentRoots, deps, { directoryOnly: false }),
    ...await canonicalExistingPaths(input.readOnlyRoots, deps, { directoryOnly: false }),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const writableRoots = [root, ...tempRoots]
    .filter((value, index, all) => all.indexOf(value) === index);

  return {
    id: sourceId(input, source, userId),
    root,
    source,
    status: 'ok',
    writableRoots,
    readOnlyRoots,
    tempRoots,
    protectedPaths: [path.join(root, '.git')],
    capabilities: normalizeCapabilities(input.capabilities),
    diagnostics: {
      requestedPath: candidate,
      resolvedAt: deps.now(),
    },
  };
}

export function createWorkspaceResolver(deps: WorkspaceResolverDeps): WorkspaceResolver {
  const resolve: WorkspaceResolver = async (userId: string, input: WorkspaceResolveInput = {}): Promise<WorkspaceContext> => {
    const taskRoot = sourceOfTask(input);
    if (taskRoot) {
      return evaluateCandidate(input, userId, 'task', taskRoot, deps);
    }

    const conversation = input.conversationId
      ? await deps.getConversation(userId, input.conversationId).catch(() => null)
      : null;
    const spaceId = input.spaceId || input.task?.spaceId || conversation?.space_id;
    const projectId = input.projectId || input.task?.projectId || conversation?.project_id;
    const normalizedInput: WorkspaceResolveInput = { ...input, spaceId, projectId };

    if (input.conversationId) {
      let candidate: string;
      try {
        candidate = await deps.getConversationWorkspacePath(userId, input.conversationId);
      } catch (error) {
        return failContext(normalizedInput, userId, 'conversation', 'denied',
          'E_WORKSPACE_PERMISSION_DENIED',
          `cannot resolve conversation workspace: ${errorCodeOf(error) || 'unknown'}`,
          '', '', deps);
      }

      let source: WorkspaceSource = 'conversation';
      if (spaceId) {
        const space = await deps.getSpace(userId, spaceId).catch(() => null);
        if (space?.project_dir && path.resolve(space.project_dir) === path.resolve(candidate)) {
          source = 'space';
        }
      }
      if (source === 'conversation' && projectId) {
        const info = await deps.getWorkspaceInfo(userId, projectId).catch(() => null);
        if (info && !info.isDefault && path.resolve(info.currentPath) === path.resolve(candidate)) {
          source = 'project';
        }
      }
      if (source === 'conversation') {
        const defaultWorkspace = await deps.defaultWorkspace();
        if (path.resolve(defaultWorkspace) === path.resolve(candidate)) source = 'default';
      }
      return evaluateCandidate(normalizedInput, userId, source, candidate, deps);
    }

    if (spaceId) {
      const space = await deps.getSpace(userId, spaceId).catch(() => null);
      const candidate = space?.project_dir || deps.getSpaceWorkspaceDir(userId, spaceId);
      return evaluateCandidate(normalizedInput, userId, 'space', candidate, deps);
    }

    if (projectId) {
      const info = await deps.getWorkspaceInfo(userId, projectId).catch(() => null);
      const candidate = info?.currentPath || await deps.defaultWorkspace();
      return evaluateCandidate(normalizedInput, userId, info && !info.isDefault ? 'project' : 'default',
        candidate, deps);
    }

    return evaluateCandidate(normalizedInput, userId, 'default', await deps.defaultWorkspace(), deps);
  };
  return async (userId, input = {}) => {
    const startedAt = Date.now();
    const context = await resolve(userId, input);
    try {
      deps.onResolved?.(context, Date.now() - startedAt, userId);
    } catch {
      // Observability must never fail resolution.
    }
    return context;
  };
}

/** Permission mode → sandbox policy. ADR-005: `full` remains workspace-write. */
export function workspacePolicyFor(
  context: WorkspaceContext,
  permissionMode: 'ask' | 'auto_approve' | 'full',
  opts: { dangerFullAccess?: boolean } = {},
): WorkspacePolicy {
  if (context.status !== 'ok') {
    return { mode: 'read-only', approval: 'never', enforcement: 'in-process' };
  }
  if (opts.dangerFullAccess === true) {
    return { mode: 'danger-full-access', approval: 'never', enforcement: 'in-process' };
  }
  return {
    mode: 'workspace-write',
    approval: permissionMode === 'ask' ? 'ask' : 'on-request',
    enforcement: 'in-process',
  };
}

async function loadDefaultDeps(): Promise<WorkspaceResolverDeps> {
  const [paths, userWorkspace, chats, spaces, convWorkspace] = await Promise.all([
    import('../paths'),
    import('./user_workspace'),
    import('./chats'),
    import('./spaces'),
    import('./group_chat/conv_workspace'),
  ]);
  return {
    async getWorkspaceInfo(userId, projectId) {
      return userWorkspace.getWorkspaceInfo(userId, projectId);
    },
    async getConversation(userId, conversationId) {
      return chats.getConversation(userId, conversationId);
    },
    async getSpace(userId, spaceId) {
      return spaces.getSpace(userId, spaceId);
    },
    getSpaceWorkspaceDir(userId, spaceId) {
      return paths.spaceWorkspaceDir(userId, spaceId);
    },
    getConversationWorkspacePath(userId, conversationId) {
      return convWorkspace.getConversationWorkspacePath(userId, conversationId);
    },
    realpath: (candidate) => fs.realpath(candidate),
    async stat(candidate) {
      const value = await fs.stat(candidate);
      return { isDirectory: value.isDirectory() };
    },
    access: (candidate) => fs.access(candidate, fsConstants.R_OK | fsConstants.W_OK),
    defaultWorkspace: () => paths.DEFAULT_USER_WORKSPACE,
    homedir: () => os.homedir(),
    platform: () => process.platform,
    now: () => new Date().toISOString(),
    dataRoot: paths.WS_ROOT,
    onResolved(context, durationMs, userId) {
      void import('./workspace-metrics')
        .then(({ appendWorkspaceResolutionMetric }) => appendWorkspaceResolutionMetric(userId, context, durationMs))
        .catch(() => { /* best effort */ });
    },
  };
}

let defaultResolver: Promise<WorkspaceResolver> | null = null;

export async function resolveWorkspaceContext(
  userId: string,
  input: WorkspaceResolveInput = {},
): Promise<WorkspaceContext> {
  if (!defaultResolver) defaultResolver = loadDefaultDeps().then(createWorkspaceResolver);
  return (await defaultResolver)(userId, input);
}
