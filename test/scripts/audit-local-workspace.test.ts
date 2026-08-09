import { describe, expect, it } from 'vitest';
import {
  MUTATING_GIT_SUBCOMMANDS,
  buildWorkspaceAudit,
  parseBranchRows,
  parseStashRows,
  parseWorktreePorcelain,
} from '../../scripts/audit-local-workspace.mjs';

describe('workspace audit', () => {
  it('parses linked worktrees and branch rows with gone upstreams', () => {
    expect(parseWorktreePorcelain('worktree /repo\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\nworktree /wt\r\nHEAD def\r\nbranch refs/heads/feature\r\n')).toEqual([
      { path: '/repo', head: 'abc', branch: 'main', detached: false },
      { path: '/wt', head: 'def', branch: 'feature', detached: false },
    ]);
    expect(parseWorktreePorcelain('')).toEqual([]);
    expect(parseBranchRows('main\torigin/main\t[ahead 2]\tabc\nold\torigin/old\t[gone]\tdef\n')).toEqual([
      { name: 'main', upstream: 'origin/main', track: '[ahead 2]', tip: 'abc', upstreamGone: false },
      { name: 'old', upstream: 'origin/old', track: '[gone]', tip: 'def', upstreamGone: true },
    ]);
  });

  it('parses stash metadata and detects duplicate tips', () => {
    expect(parseStashRows('stash@{0}\tabc\tparent\tOn main: backup\n')).toEqual([
      { ref: 'stash@{0}', hash: 'abc', parents: 'parent', subject: 'On main: backup' },
    ]);
    const report = buildWorkspaceAudit({
      root: '/repo', currentCommit: 'abc',
      worktrees: [], stashes: [],
      branches: [
        { name: 'main', upstream: 'origin/main', track: '', tip: 'abc', upstreamGone: false },
        { name: 'feature', upstream: '', track: '', tip: 'abc', upstreamGone: false },
      ],
    });
    expect(report.duplicateTips).toEqual([{ tip: 'abc', branches: ['feature', 'main'] }]);
  });

  it('defines a mutation denylist and the report schema is JSON-safe', () => {
    expect(MUTATING_GIT_SUBCOMMANDS).toEqual(expect.arrayContaining(['reset', 'checkout', 'switch', 'push', 'branch -d', 'stash pop', 'worktree remove']));
    const report = buildWorkspaceAudit({ root: '/repo', currentCommit: 'abc', worktrees: [], branches: [], stashes: [] });
    expect(() => JSON.stringify(report)).not.toThrow();
    expect(report).toMatchObject({ schema: 1, root: '/repo', currentCommit: 'abc' });
    expect(Object.isFrozen(report)).toBe(true);
  });
});
