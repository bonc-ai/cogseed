// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { logPathRef } from '../../util/log-redact';
import {
  inspectMacWorktreeProcesses,
  runWorktreeGit,
  type WorktreeProcessInspection,
  type WorktreeProcessResult,
} from '../../util/worktree-process';
import { getWorkspacePath } from '../user_workspace';

const log = createLogger('cogseed-worktree-manager');
const MANAGED_PREFIX = 'cogseed-worktree-';

export type CogSeedWorktreeErrorCode =
  | 'E_WORKTREE_REPOSITORY_UNAVAILABLE'
  | 'E_WORKTREE_BRANCH_INVALID'
  | 'E_WORKTREE_BASE_INVALID'
  | 'E_WORKTREE_BRANCH_IN_USE'
  | 'E_WORKTREE_PATH_INVALID'
  | 'E_WORKTREE_MAIN_REPOSITORY'
  | 'E_WORKTREE_SYMLINK'
  | 'E_WORKTREE_OUTSIDE_MANAGED_ROOT'
  | 'E_WORKTREE_NOT_REGISTERED'
  | 'E_WORKTREE_REPOSITORY_MISMATCH'
  | 'E_WORKTREE_BRANCH_MISMATCH'
  | 'E_WORKTREE_DIRTY'
  | 'E_WORKTREE_PROCESS_ACTIVE'
  | 'E_WORKTREE_PROCESS_UNVERIFIED'
  | 'E_WORKTREE_CREATE_FAILED'
  | 'E_WORKTREE_REMOVE_FAILED'
  | 'E_WORKTREE_UNVERIFIED';

export class CogSeedWorktreeError extends Error {
  readonly code: CogSeedWorktreeErrorCode;

  constructor(code: CogSeedWorktreeErrorCode) {
    super(code);
    this.name = 'CogSeedWorktreeError';
    this.code = code;
  }
}

export interface CogSeedManagedWorktree {
  path: string;
  name: string;
  branch: string;
  head: string;
  dirty: boolean | null;
  verifiable: boolean;
}

export interface CogSeedWorktreeProjection {
  schemaVersion: 1;
  repository: {
    path: string;
    branch: string;
  };
  worktrees: CogSeedManagedWorktree[];
}

export interface CogSeedWorktreeCreateInput {
  branch: string;
  baseRef?: string;
}

export interface CogSeedWorktreeRemoveInput {
  path: string;
  expectedBranch: string;
}

interface RegisteredWorktree {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

interface CogSeedWorktreeManagerDeps {
  resolveWorkspace?: (userId: string) => string;
  platform?: NodeJS.Platform;
  suffix?: () => string;
  inspectProcesses?: (worktreePath: string) => Promise<WorktreeProcessInspection>;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
}

async function git(cwd: string, args: string[]): Promise<WorktreeProcessResult> {
  return runWorktreeGit(cwd, args);
}

function parseWorktreeList(raw: string): RegisteredWorktree[] {
  const records: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const field of raw.split('\0')) {
    if (!field) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (current) records.push(current);
      current = {
        path: field.slice('worktree '.length),
        head: '',
        branch: '',
        bare: false,
        detached: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch ')) current.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (field === 'bare') current.bare = true;
    else if (field === 'detached') current.detached = true;
    else if (field.startsWith('prunable')) current.prunable = true;
  }
  if (current) records.push(current);
  return records;
}

function worktreeError(code: CogSeedWorktreeErrorCode): never {
  throw new CogSeedWorktreeError(code);
}

function validateBranchText(value: unknown): string {
  const branch = typeof value === 'string' ? value.trim() : '';
  if (!branch || branch.length > 200 || branch.startsWith('-') || /[\0\r\n]/.test(branch)) {
    worktreeError('E_WORKTREE_BRANCH_INVALID');
  }
  return branch;
}

function validateBaseRefText(value: unknown): string {
  const baseRef = typeof value === 'string' && value.trim() ? value.trim() : 'HEAD';
  if (baseRef.length > 300 || baseRef.startsWith('-') || /[\0\r\n]/.test(baseRef)) {
    worktreeError('E_WORKTREE_BASE_INVALID');
  }
  return baseRef;
}

function validateManagedName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name
    || name.length > 180
    || path.basename(name) !== name
    || !name.startsWith(MANAGED_PREFIX)
    || !/^[A-Za-z0-9._-]+$/.test(name)) {
    worktreeError('E_WORKTREE_PATH_INVALID');
  }
  return name;
}

export function createCogSeedWorktreeManager(deps: CogSeedWorktreeManagerDeps = {}) {
  const resolveWorkspace = deps.resolveWorkspace ?? getWorkspacePath;
  const platform = deps.platform ?? process.platform;
  const suffix = deps.suffix ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const inspectProcesses = deps.inspectProcesses ?? ((worktreePath) => inspectMacWorktreeProcesses(worktreePath, platform));

  async function repositoryContext(userId: string): Promise<{
    root: string;
    commonDir: string;
    branch: string;
    managedParent: string;
    registered: RegisteredWorktree[];
  }> {
    const workspace = path.resolve(resolveWorkspace(userId));
    try {
      const root = fs.realpathSync(path.resolve((await git(workspace, ['rev-parse', '--show-toplevel'])).stdout.trim()));
      const commonDir = path.resolve((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
      const branch = (await git(root, ['branch', '--show-current'])).stdout.trim();
      const registered = parseWorktreeList((await git(root, ['worktree', 'list', '--porcelain', '-z'])).stdout);
      if (!root || !commonDir || !registered.length) worktreeError('E_WORKTREE_UNVERIFIED');
      return { root, commonDir, branch, managedParent: path.dirname(root), registered };
    } catch (error) {
      if (error instanceof CogSeedWorktreeError) throw error;
      log.warn('configured workspace is not a verifiable Git repository', { workspace: logPathRef(workspace) });
      worktreeError('E_WORKTREE_REPOSITORY_UNAVAILABLE');
    }
  }

  function isManagedPath(repo: { root: string; managedParent: string }, candidate: string): boolean {
    const resolved = path.resolve(candidate);
    const candidateParent = path.dirname(resolved);
    let comparableParent = candidateParent;
    try { comparableParent = fs.realpathSync(candidateParent); } catch { /* removal fails closed later */ }
    return normalizedPath(comparableParent) === normalizedPath(repo.managedParent)
      && path.basename(resolved).startsWith(MANAGED_PREFIX)
      && normalizedPath(resolved) !== normalizedPath(repo.root);
  }

  async function dirtyState(worktreePath: string): Promise<boolean | null> {
    try {
      return (await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=normal'])).stdout.trim().length > 0;
    } catch {
      return null;
    }
  }

  return {
    async resolve(userId: string, rawName: string): Promise<string> {
      const repo = await repositoryContext(userId);
      const name = validateManagedName(rawName);
      const registered = repo.registered.find((entry) => path.basename(entry.path) === name
        && isManagedPath(repo, entry.path));
      if (!registered) worktreeError('E_WORKTREE_NOT_REGISTERED');
      if (registered.bare || registered.detached || registered.prunable) worktreeError('E_WORKTREE_UNVERIFIED');

      const worktreePath = path.resolve(registered.path);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(worktreePath);
      } catch {
        worktreeError('E_WORKTREE_UNVERIFIED');
      }
      if (stat.isSymbolicLink()) worktreeError('E_WORKTREE_SYMLINK');
      if (!stat.isDirectory()) worktreeError('E_WORKTREE_PATH_INVALID');

      let worktreeCommon = '';
      try {
        worktreeCommon = path.resolve((await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
      } catch {
        worktreeError('E_WORKTREE_UNVERIFIED');
      }
      if (normalizedPath(worktreeCommon) !== normalizedPath(repo.commonDir)) {
        worktreeError('E_WORKTREE_REPOSITORY_MISMATCH');
      }
      return worktreePath;
    },

    async list(userId: string): Promise<CogSeedWorktreeProjection> {
      const repo = await repositoryContext(userId);
      const managed = repo.registered.filter((entry) => isManagedPath(repo, entry.path));
      const worktrees = await Promise.all(managed.map(async (entry): Promise<CogSeedManagedWorktree> => {
        const dirty = entry.prunable || entry.bare || entry.detached ? null : await dirtyState(entry.path);
        return {
          path: path.resolve(entry.path),
          name: path.basename(entry.path),
          branch: entry.branch,
          head: entry.head,
          dirty,
          verifiable: dirty !== null && !entry.prunable && !entry.bare && !entry.detached,
        };
      }));
      return {
        schemaVersion: 1,
        repository: { path: repo.root, branch: repo.branch },
        worktrees: worktrees.sort((left, right) => left.name.localeCompare(right.name)),
      };
    },

    async create(userId: string, input: CogSeedWorktreeCreateInput): Promise<CogSeedManagedWorktree> {
      const repo = await repositoryContext(userId);
      const branch = validateBranchText(input?.branch);
      const baseRef = validateBaseRefText(input?.baseRef);
      try {
        await git(repo.root, ['check-ref-format', '--branch', branch]);
      } catch {
        worktreeError('E_WORKTREE_BRANCH_INVALID');
      }

      const branchRef = `refs/heads/${branch}`;
      const branchRecord = repo.registered.find((entry) => entry.branch === branch);
      if (branchRecord) worktreeError('E_WORKTREE_BRANCH_IN_USE');

      const slug = branch.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'branch';
      const worktreePath = path.join(repo.managedParent, `${MANAGED_PREFIX}${slug}-${suffix()}`);
      if (!isManagedPath(repo, worktreePath) || fs.existsSync(worktreePath)) worktreeError('E_WORKTREE_PATH_INVALID');

      let branchExists = false;
      try {
        await git(repo.root, ['show-ref', '--verify', '--quiet', branchRef]);
        branchExists = true;
      } catch {
        branchExists = false;
      }
      let baseCommit = '';
      if (!branchExists) {
        try {
          baseCommit = (await git(repo.root, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`])).stdout.trim();
        } catch {
          worktreeError('E_WORKTREE_BASE_INVALID');
        }
      }
      try {
        if (branchExists) await git(repo.root, ['worktree', 'add', worktreePath, branch]);
        else await git(repo.root, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
      } catch {
        log.warn('Git refused to create managed worktree', { worktree: logPathRef(worktreePath), branch });
        worktreeError('E_WORKTREE_CREATE_FAILED');
      }

      const projection = await this.list(userId);
      const created = projection.worktrees.find((item) => normalizedPath(item.path) === normalizedPath(worktreePath));
      if (!created?.verifiable || created.branch !== branch) worktreeError('E_WORKTREE_UNVERIFIED');
      log.info('managed worktree created', { worktree: logPathRef(worktreePath), branch });
      return created;
    },

    async remove(userId: string, input: CogSeedWorktreeRemoveInput): Promise<{ removed: true; path: string; branch: string }> {
      const repo = await repositoryContext(userId);
      const worktreePath = typeof input?.path === 'string' ? path.resolve(input.path) : '';
      const expectedBranch = validateBranchText(input?.expectedBranch);
      if (!worktreePath) worktreeError('E_WORKTREE_PATH_INVALID');
      try {
        if (normalizedPath(fs.realpathSync(worktreePath)) === normalizedPath(repo.root)) {
          worktreeError('E_WORKTREE_MAIN_REPOSITORY');
        }
      } catch (error) {
        if (error instanceof CogSeedWorktreeError) throw error;
      }
      if (!isManagedPath(repo, worktreePath)) worktreeError('E_WORKTREE_OUTSIDE_MANAGED_ROOT');

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(worktreePath);
      } catch {
        worktreeError('E_WORKTREE_UNVERIFIED');
      }
      if (stat.isSymbolicLink()) worktreeError('E_WORKTREE_SYMLINK');
      if (!stat.isDirectory()) worktreeError('E_WORKTREE_PATH_INVALID');

      const registered = repo.registered.find((entry) => normalizedPath(entry.path) === normalizedPath(worktreePath));
      if (!registered) worktreeError('E_WORKTREE_NOT_REGISTERED');
      if (registered.bare || registered.detached || registered.prunable) worktreeError('E_WORKTREE_UNVERIFIED');
      if (registered.branch !== expectedBranch) worktreeError('E_WORKTREE_BRANCH_MISMATCH');

      let worktreeCommon = '';
      try {
        worktreeCommon = path.resolve((await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
      } catch {
        worktreeError('E_WORKTREE_UNVERIFIED');
      }
      if (normalizedPath(worktreeCommon) !== normalizedPath(repo.commonDir)) worktreeError('E_WORKTREE_REPOSITORY_MISMATCH');

      const dirty = await dirtyState(worktreePath);
      if (dirty === null) worktreeError('E_WORKTREE_UNVERIFIED');
      if (dirty) worktreeError('E_WORKTREE_DIRTY');

      const processInspection = await inspectProcesses(worktreePath);
      if (processInspection.state === 'active') worktreeError('E_WORKTREE_PROCESS_ACTIVE');
      if (processInspection.state !== 'clear') worktreeError('E_WORKTREE_PROCESS_UNVERIFIED');

      try {
        await git(repo.root, ['worktree', 'remove', '--', worktreePath]);
      } catch {
        log.warn('Git refused to remove managed worktree', { worktree: logPathRef(worktreePath), branch: expectedBranch });
        worktreeError('E_WORKTREE_REMOVE_FAILED');
      }
      log.info('managed worktree removed; branch retained', { worktree: logPathRef(worktreePath), branch: expectedBranch });
      return { removed: true, path: worktreePath, branch: expectedBranch };
    },
  };
}

export const cogseedWorktreeManager = createCogSeedWorktreeManager();
