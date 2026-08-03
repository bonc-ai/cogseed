#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MUTATING_GIT_SUBCOMMANDS = Object.freeze([
  'reset', 'checkout', 'switch', 'push', 'branch -d', 'branch -D',
  'stash pop', 'stash drop', 'stash clear', 'worktree remove', 'worktree prune',
]);

export function parseWorktreePorcelain(text) {
  const normalized = String(text || '').replaceAll('\r\n', '\n').trim();
  if (!normalized) return [];
  return normalized.split(/\n\s*\n/).map((block) => {
    const row = Object.fromEntries(block.split('\n').map((line) => {
      const at = line.indexOf(' ');
      return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
    }));
    return {
      path: row.worktree || '',
      head: row.HEAD || '',
      branch: String(row.branch || '').replace(/^refs\/heads\//, ''),
      detached: Object.hasOwn(row, 'detached'),
    };
  });
}

export function parseBranchRows(text) {
  return String(text || '').replaceAll('\r\n', '\n').split('\n').filter(Boolean).map((line) => {
    const [name = '', upstream = '', track = '', tip = ''] = line.split('\t');
    return { name, upstream, track, tip, upstreamGone: track.includes('gone') };
  });
}

export function parseStashRows(text) {
  return String(text || '').replaceAll('\r\n', '\n').split('\n').filter(Boolean).map((line) => {
    const [ref = '', hash = '', parents = '', ...subject] = line.split('\t');
    return { ref, hash, parents, subject: subject.join('\t') };
  });
}

export function buildWorkspaceAudit({ root, currentCommit, worktrees = [], branches = [], stashes = [] }) {
  const tips = new Map();
  for (const branch of branches) {
    if (!branch.tip) continue;
    const list = tips.get(branch.tip) || [];
    list.push(branch.name);
    tips.set(branch.tip, list);
  }
  const duplicateTips = [...tips.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([tip, names]) => ({ tip, branches: names.sort() }))
    .sort((a, b) => a.tip.localeCompare(b.tip));
  return Object.freeze({
    schema: 1,
    generatedAt: new Date().toISOString(),
    root,
    currentCommit,
    worktrees,
    branches,
    upstreamGone: Object.freeze(branches.filter((row) => row.upstreamGone).map((row) => row.name)),
    duplicateTips: Object.freeze(duplicateTips),
    stashes: Object.freeze(stashes),
  });
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}
function statusSummary(worktreePath) {
  try {
    const lines = git(['status', '--porcelain=v1', '--branch'], worktreePath).split('\n');
    return { branchLine: lines[0] || '', changed: lines.slice(1).filter(Boolean).length };
  } catch (error) { return { branchLine: '', changed: -1, error: String(error.message || error) }; }
}
function divergence(root, branch) {
  if (!branch.upstream || branch.upstreamGone) return null;
  try {
    const [behind, ahead] = git(['rev-list', '--left-right', '--count', `${branch.upstream}...${branch.name}`], root).split(/\s+/).map(Number);
    return { behind, ahead };
  } catch { return null; }
}

export function collectWorkspaceAudit(cwd = process.cwd()) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  const currentCommit = git(['rev-parse', 'HEAD'], root);
  const worktrees = parseWorktreePorcelain(git(['worktree', 'list', '--porcelain'], root)).map((row) => ({ ...row, status: statusSummary(row.path) }));
  const branches = parseBranchRows(git(['for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)\t%(objectname:short)', 'refs/heads'], root));
  for (const branch of branches) branch.divergence = divergence(root, branch);
  const stashes = parseStashRows(git(['stash', 'list', '--format=%gd\t%H\t%P\t%gs'], root));
  for (const stash of stashes) {
    try { stash.summary = git(['stash', 'show', '--stat', '--oneline', stash.ref], root).split('\n').slice(0, 40); }
    catch { stash.summary = []; }
  }
  return buildWorkspaceAudit({ root, currentCommit, worktrees, branches, stashes });
}

export function formatWorkspaceAudit(report) {
  const lines = [
    `Workspace audit: ${report.root}`,
    `Current commit: ${report.currentCommit}`,
    `Worktrees: ${report.worktrees.length}`,
  ];
  for (const row of report.worktrees) lines.push(`  - ${row.path} [${row.branch || 'detached'}] changed=${row.status?.changed ?? '?'}`);
  lines.push(`Gone upstreams: ${report.upstreamGone.length ? report.upstreamGone.join(', ') : 'none'}`);
  lines.push(`Duplicate tips: ${report.duplicateTips.length}`);
  for (const row of report.duplicateTips) lines.push(`  - ${row.tip}: ${row.branches.join(', ')}`);
  lines.push(`Stashes: ${report.stashes.length}`);
  for (const row of report.stashes) lines.push(`  - ${row.ref}: ${row.subject}`);
  return lines.join('\n');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const report = collectWorkspaceAudit();
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${formatWorkspaceAudit(report)}\n`);
  } catch (error) {
    console.error(`[audit-local-workspace] ${error.message || error}`);
    process.exit(1);
  }
}
