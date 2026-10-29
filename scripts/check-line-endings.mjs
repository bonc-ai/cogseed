#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

// scripts/ 的上一级就是本仓库根。此前写成 '..','..'，实际扫到了仓库的**父目录**
// （同机上还有 CogSeed-Enterprise / p3394-gateway 等兄弟检出），于是报出一批不属于
// 本仓库的"违规"——这也是它一直没被接进门的真实原因（2026-10-08 修正）。
const root = path.resolve(import.meta.dirname, '..');
const skipDirs = new Set([
  '.git',
  '.cache',
  'build',
  'data',
  'dist',
  'node_modules',
  'out',
  'venv',
  'workspace',
  'userWorkSpace',
]);
const textExts = new Set([
  '.cjs',
  '.conf',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);
const textNames = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
]);

function isTextFile(name) {
  return textNames.has(name) || textExts.has(path.extname(name).toLowerCase());
}

function shouldSkipDir(name) {
  return skipDirs.has(name);
}

function shouldSkipPath(dir) {
  const rel = path.relative(root, dir).split(path.sep).join('/');
  return rel === 'PC/product/package';
}

function scanFile(file) {
  const bytes = fs.readFileSync(file);
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 10) continue;
    lf += 1;
    if (i > 0 && bytes[i - 1] === 13) crlf += 1;
  }
  if (lf === 0) return null;
  const bareLf = lf - crlf;
  if (crlf > 0 && bareLf > 0) {
    return { file, crlf, bareLf };
  }
  return null;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const next = path.join(dir, entry.name);
      if (!shouldSkipDir(entry.name) && !shouldSkipPath(next)) walk(next, out);
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    const result = scanFile(path.join(dir, entry.name));
    if (result) out.push(result);
  }
}

const mixed = [];
walk(root, mixed);

/**
 * 基线冻结（照 `shared-ui-adoption-guard.test.ts` 的既有先例）：
 * 仓库里已有一批历史混合行尾的文件（早于本门禁存在，且改动它们是纯空白大 diff）。
 * 基线把它们记为"已知"，门禁只对**新增**混合行尾失败——这样新文件/新改动不能
 * 再引入问题，历史文件可以顺手清理后从基线里删掉，而不是让整个门禁长期红着。
 * 允许下调（删除条目）；上调需要 reviewer 同意。
 */
const BASELINE_FILE = path.join(import.meta.dirname, 'line-endings-baseline.json');
let baseline = [];
try {
  const parsed = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  if (Array.isArray(parsed)) baseline = parsed.map((v) => String(v));
} catch {
  baseline = [];
}
const known = new Set(baseline);
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

const fresh = mixed.filter((item) => !known.has(rel(item.file)));
const stale = baseline.filter((entry) => !mixed.some((item) => rel(item.file) === entry));

if (mixed.length) {
  const header = fresh.length ? 'Mixed line endings found:' : 'Mixed line endings (all baselined):';
  console.error(header);
  for (const item of mixed) {
    const tag = known.has(rel(item.file)) ? 'known' : 'NEW';
    console.error(`- [${tag}] ${rel(item.file)} (CRLF=${item.crlf}, LF=${item.bareLf})`);
  }
}
if (stale.length) {
  // 基线里的条目已经干净了 → 提示删掉，避免基线越攒越大（不因此失败）
  console.error('Baselined files are now clean; remove them from scripts/line-endings-baseline.json:');
  for (const entry of stale) console.error(`- ${entry}`);
}
if (fresh.length) process.exit(1);
if (mixed.length) {
  console.log(`No new mixed line endings (${mixed.length} known, ${baseline.length} baselined).`);
} else {
  console.log('No mixed line endings found.');
}
