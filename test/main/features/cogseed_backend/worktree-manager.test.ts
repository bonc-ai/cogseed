// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCogSeedWorktreeManager } from '../../../../src/main/features/cogseed_backend/worktree-manager';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('CogSeed worktree manager', () => {
  let tempRoot = '';
  let repository = '';
  let suffixNumber = 0;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-worktree-test-'));
    repository = path.join(tempRoot, 'repository');
    fs.mkdirSync(repository);
    git(repository, ['init', '-b', 'develop']);
    git(repository, ['config', 'user.name', 'CogSeed Test']);
    git(repository, ['config', 'user.email', 'cogseed-test@example.invalid']);
    fs.writeFileSync(path.join(repository, 'README.md'), '# Test\n', 'utf8');
    git(repository, ['add', 'README.md']);
    git(repository, ['commit', '-m', 'initial']);
    suffixNumber = 0;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function manager(overrides: Parameters<typeof createCogSeedWorktreeManager>[0] = {}) {
    return createCogSeedWorktreeManager({
      resolveWorkspace: () => repository,
      suffix: () => `test-${++suffixNumber}`,
      inspectProcesses: async () => ({ state: 'clear' }),
      ...overrides,
    });
  }

  it('creates, lists, and safely removes a managed worktree while retaining its branch', async () => {
    const service = manager();

    const created = await service.create('worktree-user', { branch: 'dev/tester', baseRef: 'develop' });

    expect(created).toMatchObject({ branch: 'dev/tester', dirty: false, verifiable: true });
    expect(path.basename(created.path)).toMatch(/^cogseed-worktree-dev-tester-test-1$/);
    await expect(service.resolve('worktree-user', path.basename(created.path))).resolves.toBe(created.path);
    await expect(service.resolve('worktree-user', 'cogseed-worktree-missing')).rejects.toMatchObject({ code: 'E_WORKTREE_NOT_REGISTERED' });
    await expect(service.resolve('worktree-user', '../repository')).rejects.toMatchObject({ code: 'E_WORKTREE_PATH_INVALID' });
    await expect(service.list('worktree-user')).resolves.toMatchObject({
      repository: { path: fs.realpathSync(repository), branch: 'develop' },
      worktrees: [expect.objectContaining({ path: created.path, branch: 'dev/tester' })],
    });

    await expect(service.remove('worktree-user', {
      path: created.path,
      expectedBranch: 'dev/tester',
    })).resolves.toEqual({ removed: true, path: created.path, branch: 'dev/tester' });

    expect(fs.existsSync(created.path)).toBe(false);
    expect(git(repository, ['show-ref', '--verify', 'refs/heads/dev/tester'])).toBeTruthy();
  });

  it('attaches an existing local branch without changing its commit', async () => {
    git(repository, ['branch', 'dev/existing']);
    const expectedHead = git(repository, ['rev-parse', 'refs/heads/dev/existing']);

    const created = await manager().create('worktree-user', { branch: 'dev/existing', baseRef: 'HEAD~100' });

    expect(created.head).toBe(expectedHead);
    expect(created.branch).toBe('dev/existing');
  });

  it('blocks dirty worktrees and branch mismatches', async () => {
    const service = manager();
    const created = await service.create('worktree-user', { branch: 'dev/dirty' });

    await expect(service.remove('worktree-user', {
      path: created.path,
      expectedBranch: 'dev/other',
    })).rejects.toMatchObject({ code: 'E_WORKTREE_BRANCH_MISMATCH' });

    fs.writeFileSync(path.join(created.path, 'private.tmp'), 'do not delete\n', 'utf8');
    await expect(service.remove('worktree-user', {
      path: created.path,
      expectedBranch: 'dev/dirty',
    })).rejects.toMatchObject({ code: 'E_WORKTREE_DIRTY' });
    expect(fs.existsSync(created.path)).toBe(true);
  });

  it('blocks unmanaged paths, symlinks, the main repository, and active processes', async () => {
    const service = manager({ inspectProcesses: async () => ({ state: 'active' }) });
    const created = await service.create('worktree-user', { branch: 'dev/occupied' });
    const outside = path.join(tempRoot, 'outside');
    fs.mkdirSync(outside);

    await expect(service.remove('worktree-user', {
      path: repository,
      expectedBranch: 'develop',
    })).rejects.toMatchObject({ code: 'E_WORKTREE_MAIN_REPOSITORY' });
    await expect(service.remove('worktree-user', {
      path: outside,
      expectedBranch: 'dev/occupied',
    })).rejects.toMatchObject({ code: 'E_WORKTREE_OUTSIDE_MANAGED_ROOT' });

    const link = path.join(tempRoot, 'cogseed-worktree-link');
    fs.symlinkSync(created.path, link, 'dir');
    await expect(service.remove('worktree-user', {
      path: link,
      expectedBranch: 'dev/occupied',
    })).rejects.toMatchObject({ code: 'E_WORKTREE_SYMLINK' });
    await expect(service.remove('worktree-user', {
      path: created.path,
      expectedBranch: 'dev/occupied',
    })).rejects.toMatchObject({ code: 'E_WORKTREE_PROCESS_ACTIVE' });
  });

  it('fails closed when the repository, base, or process state cannot be verified', async () => {
    const missingRepo = createCogSeedWorktreeManager({ resolveWorkspace: () => path.join(tempRoot, 'missing') });
    await expect(missingRepo.list('worktree-user')).rejects.toMatchObject({ code: 'E_WORKTREE_REPOSITORY_UNAVAILABLE' });

    const service = manager();
    await expect(service.create('worktree-user', { branch: '../invalid', baseRef: 'develop' }))
      .rejects.toMatchObject({ code: 'E_WORKTREE_BRANCH_INVALID' });
    await expect(service.create('worktree-user', { branch: 'dev/no-base', baseRef: 'missing-base' }))
      .rejects.toMatchObject({ code: 'E_WORKTREE_BASE_INVALID' });

    const uncertain = manager({ inspectProcesses: async () => ({ state: 'unknown' }) });
    const created = await uncertain.create('worktree-user', { branch: 'dev/uncertain' });
    await expect(uncertain.remove('worktree-user', {
      path: created.path,
      expectedBranch: created.branch,
    })).rejects.toMatchObject({ code: 'E_WORKTREE_PROCESS_UNVERIFIED' });
  });

  it.runIf(process.platform === 'darwin')('verifies a clear worktree with the real macOS lsof check', async () => {
    const service = createCogSeedWorktreeManager({
      resolveWorkspace: () => repository,
      suffix: () => 'macos-lsof',
    });
    const created = await service.create('worktree-user', { branch: 'dev/macos-lsof' });

    await expect(service.remove('worktree-user', {
      path: created.path,
      expectedBranch: created.branch,
    })).resolves.toMatchObject({ removed: true, branch: 'dev/macos-lsof' });
  });
});
