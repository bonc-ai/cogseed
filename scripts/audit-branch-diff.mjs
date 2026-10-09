#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const READ_ONLY_GIT_COMMANDS = Object.freeze([
  'rev-parse',
  'merge-base',
  'log',
  'diff',
  'ls-tree',
]);

export function parseMergeBase(text) {
  return String(text || '').trim().split(/\s+/)[0] || '';
}

export function parseCommitRows(text) {
  return String(text || '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf('\t');
      return at < 0
        ? { hash: line, subject: '' }
        : { hash: line.slice(0, at), subject: line.slice(at + 1) };
    });
}

/** Parse `git diff --name-status -z`, including the two paths in a rename. */
export function parseNameStatusZ(text) {
  const fields = String(text || '').split('\0');
  const rows = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const pathCount = status[0] === 'R' || status[0] === 'C' ? 2 : 1;
    const paths = fields.slice(index, index + pathCount).filter(Boolean);
    index += pathCount;
    if (paths.length) rows.push({ status, paths });
  }
  return rows;
}

/** Parse `git ls-tree -r -z` into the path-to-blob map needed for comparisons. */
export function parseTreeZ(text) {
  return String(text || '')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const metadata = tab < 0 ? entry : entry.slice(0, tab);
      const treePath = tab < 0 ? '' : entry.slice(tab + 1);
      const [, type = '', blob = ''] = metadata.split(/\s+/);
      return { path: treePath, type, blob };
    })
    .filter((entry) => entry.path && entry.type === 'blob' && entry.blob);
}

function rowsByPath(rows) {
  const result = new Map();
  for (const row of rows || []) {
    if (!row || typeof row.path !== 'string' || !row.path) continue;
    result.set(row.path, row.blob ?? null);
  }
  return result;
}

function independentRows(left, right) {
  return [
    ...[...left.entries()]
      .filter(([filePath]) => !right.has(filePath))
      .map(([filePath, blob]) => ({ side: 'left', path: filePath, blob })),
    ...[...right.entries()]
      .filter(([filePath]) => !left.has(filePath))
      .map(([filePath, blob]) => ({ side: 'right', path: filePath, blob })),
  ].sort((a, b) => a.path.localeCompare(b.path) || a.side.localeCompare(b.side));
}

export function classifyBranchChanges({ left = [], right = [] } = {}) {
  const leftByPath = rowsByPath(left);
  const rightByPath = rowsByPath(right);
  const duplicate = [];
  const parallel = [];

  for (const filePath of [...leftByPath.keys()].filter((candidate) => rightByPath.has(candidate)).sort()) {
    const leftBlob = leftByPath.get(filePath);
    const rightBlob = rightByPath.get(filePath);
    const row = { path: filePath, leftBlob, rightBlob };
    (leftBlob === rightBlob ? duplicate : parallel).push(row);
  }

  return { duplicate, parallel, independent: independentRows(leftByPath, rightByPath) };
}

export function sanitizeRef(ref) {
  const safe = String(ref || '')
    .replaceAll('\\', '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^\.+$/, '')
    .slice(0, 160);
  return safe || 'ref';
}

export function buildBranchAudit({
  root,
  baseRef,
  targetRef,
  mergeBase,
  leftTip,
  rightTip,
  leftCommits = [],
  rightCommits = [],
  leftPaths = [],
  rightPaths = [],
  generatedAt = new Date().toISOString(),
}) {
  const classifications = classifyBranchChanges({ left: leftPaths, right: rightPaths });
  const overlap = [...classifications.duplicate, ...classifications.parallel]
    .sort((a, b) => a.path.localeCompare(b.path));
  const currentPaths = [...leftPaths].sort((a, b) => a.path.localeCompare(b.path));
  const targetPaths = [...rightPaths].sort((a, b) => a.path.localeCompare(b.path));

  return Object.freeze({
    schema: 1,
    generatedAt,
    root,
    baseRef,
    targetRef,
    mergeBase,
    tips: { current: leftTip, target: rightTip },
    uniqueCommits: { current: leftCommits, target: rightCommits },
    paths: { current: currentPaths, target: targetPaths, overlap },
    pathOverlap: overlap,
    classifications,
  });
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function changedPaths(root, mergeBase, ref) {
  const statusRows = parseNameStatusZ(git([
    'diff', '--name-status', '-z', '--find-renames', mergeBase, ref, '--',
  ], root));
  const tree = new Map(parseTreeZ(git(['ls-tree', '-r', '-z', '--full-tree', ref], root)).map((row) => [row.path, row.blob]));
  const paths = new Set(statusRows.flatMap((row) => row.paths));
  return [...paths].sort().map((filePath) => ({ path: filePath, blob: tree.get(filePath) ?? null }));
}

export function collectBranchAudit(targetRef, { cwd = process.cwd(), baseRef = 'HEAD' } = {}) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const mergeBase = parseMergeBase(git(['merge-base', baseRef, targetRef], root));
  if (!mergeBase) throw new Error(`Unable to find a merge base for ${baseRef} and ${targetRef}`);
  const [leftTip, rightTip] = [baseRef, targetRef].map((ref) => git(['rev-parse', ref], root).trim());
  const commits = (ref) => parseCommitRows(git(['log', '--no-decorate', '--format=%H%x09%s', `${mergeBase}..${ref}`], root));
  return buildBranchAudit({
    root,
    baseRef,
    targetRef,
    mergeBase,
    leftTip,
    rightTip,
    leftCommits: commits(baseRef),
    rightCommits: commits(targetRef),
    leftPaths: changedPaths(root, mergeBase, baseRef),
    rightPaths: changedPaths(root, mergeBase, targetRef),
  });
}

export function formatBranchAudit(report, reportPath = '') {
  const { duplicate, parallel, independent } = report.classifications;
  return [
    `Branch audit: ${report.baseRef} vs ${report.targetRef}`,
    `Merge base: ${report.mergeBase}`,
    `Unique commits: current ${report.uniqueCommits.current.length}, target ${report.uniqueCommits.target.length}`,
    `Paths: overlap ${report.paths.overlap.length}, duplicate ${duplicate.length}, parallel ${parallel.length}, independent ${independent.length}`,
    reportPath ? `Report: ${reportPath}` : '',
  ].filter(Boolean).join('\n');
}

export function reportPathFor(root, targetRef) {
  return path.join(root, '.build', 'audits', `${sanitizeRef(targetRef)}.json`);
}

function cli(argv = process.argv.slice(2)) {
  const targetRef = argv.find((arg) => !arg.startsWith('-'));
  const baseIndex = argv.indexOf('--base');
  const baseRef = baseIndex >= 0 ? argv[baseIndex + 1] : 'HEAD';
  if (!targetRef || (baseIndex >= 0 && !baseRef)) {
    throw new Error('Usage: node scripts/audit-branch-diff.mjs <target-ref> [--base <ref>] [--json]');
  }
  const report = collectBranchAudit(targetRef, { baseRef });
  const outputPath = reportPathFor(report.root, targetRef);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${formatBranchAudit(report, outputPath)}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    cli();
  } catch (error) {
    console.error(`[audit-branch-diff] ${error.message || error}`);
    process.exit(1);
  }
}
