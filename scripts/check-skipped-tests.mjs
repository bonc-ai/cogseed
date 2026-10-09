#!/usr/bin/env node
// 硬跳过（it.skip / test.skip / describe.skip）扫描器。
//
// 为什么存在（2026-09-20 审计）：
//   develop 上有 5 处硬跳过，其中一处引用了一份**并不存在**的豁免文档
//   （"Skipped per P7 release-test-waiver"），被测产品代码却仍然活着；
//   而 nightly 里原来那条检查只数文件数、只 ::warning、末尾恒 `exit 0`，
//   并且只匹配 `.skip(`，看不到 `.skipIf(`。结果是"用 skip 静音"这件事
//   没有任何一道会自动变红的关卡。
//
// 现在的口径：
//   - **硬跳过**必须逐条登记在 test/skip-allowlist.json（含理由与登记日期）。
//     出现白名单之外的硬跳过 → 退出码 1，nightly 变红，当天必须处理。
//   - `skipIf` / 条件跳过只统计并打印，不判失败：平台或环境条件跳过是正当用法，
//     但必须"看得见"（它们曾经是覆盖度悄悄流失的地方）。
//   - 白名单里登记了、但代码里已经不存在的条目会提示为"过期条目"（不判失败），
//     提醒顺手清理。
//
// 用法：
//   node scripts/check-skipped-tests.mjs            # 只报告，永远退出 0
//   node scripts/check-skipped-tests.mjs --strict   # 白名单之外一律退出 1
//   node scripts/check-skipped-tests.mjs --root <dir>   # 扫描指定仓库根（自测用）
//
// 无第三方依赖：仓库规则要求新增 npm 依赖必须先讨论。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readRootArg(argv) {
  const i = argv.indexOf('--root');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return REPO_ROOT;
}

const ROOT = readRootArg(process.argv);
const TEST_DIR = path.join(ROOT, 'test');
const ALLOWLIST_PATH = path.join(TEST_DIR, 'skip-allowlist.json');

const HARD_SKIP_RE = /^[ \t]*(it|test|describe)\.skip\s*\(/gm;
const SKIP_IF_RE = /^[ \t]*(it|test|describe)\.skipIf\s*\(/gm;

/** 从 `(` 之后读取第一个字符串字面量作为用例标题。 */
function readTitle(text, from) {
  const window = text.slice(from, from + 400);
  const m = window.match(/^\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/);
  return m ? m[2].replace(/\\(['"`\\])/g, '$1') : '(无法解析标题)';
}

/** 递归收集 test/ 下的 *.test.ts（跳过 node_modules 与 .build）。 */
function collectTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...collectTestFiles(full));
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const hard = [];
  const conditional = [];

  for (const m of text.matchAll(HARD_SKIP_RE)) {
    hard.push({
      file: rel,
      line: text.slice(0, m.index).split('\n').length,
      kind: m[1],
      title: readTitle(text, m.index + m[0].length),
    });
  }
  for (const m of text.matchAll(SKIP_IF_RE)) {
    conditional.push({
      file: rel,
      line: text.slice(0, m.index).split('\n').length,
      kind: `${m[1]}.skipIf`,
      title: readTitle(text, m.index + m[0].length),
    });
  }
  return { hard, conditional };
}

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  const list = Array.isArray(raw?.allowed) ? raw.allowed : [];
  for (const [i, entry] of list.entries()) {
    if (!entry?.file || !entry?.title) {
      throw new Error(`test/skip-allowlist.json 第 ${i + 1} 条缺少 file / title`);
    }
  }
  return list;
}

function main() {
  const strict = process.argv.includes('--strict');
  const allowlist = loadAllowlist();
  const files = collectTestFiles(TEST_DIR).sort();

  const hard = [];
  const conditional = [];
  for (const f of files) {
    const r = scanFile(f);
    hard.push(...r.hard);
    conditional.push(...r.conditional);
  }

  const key = (e) => `${e.file}\u0000${e.title}`;
  const allowedKeys = new Map(allowlist.map((e) => [key(e), e]));
  const unexpected = hard.filter((e) => !allowedKeys.has(key(e)));
  const matched = new Set(hard.map(key));
  const stale = allowlist.filter((e) => !matched.has(key(e)));

  console.log(`扫描 ${files.length} 个测试文件`);
  console.log('');
  console.log(`硬跳过（it/test/describe.skip）：${hard.length} 处`);
  for (const e of hard) {
    const ok = allowedKeys.has(key(e));
    console.log(`  ${ok ? '✅' : '❌'} ${e.file}:${e.line}  ${e.title}`);
  }
  if (stale.length) {
    console.log('');
    console.log(`白名单过期条目（代码里已找不到对应硬跳过，请顺手删除）：${stale.length} 条`);
    for (const e of stale) console.log(`  ⚠️  ${e.file}  ${e.title}`);
  }

  console.log('');
  console.log(`skipIf / 条件跳过：${conditional.length} 处（仅报告，不判失败）`);
  const byFile = new Map();
  for (const e of conditional) byFile.set(e.file, (byFile.get(e.file) ?? 0) + 1);
  for (const [file, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  · ${file}  ${n} 处`);
  }

  if (unexpected.length) {
    console.log('');
    console.log(`::error::发现 ${unexpected.length} 处未登记的硬跳过：`);
    for (const e of unexpected) {
      console.log(`  ${e.file}:${e.line}  ${e.title}`);
    }
    console.log('');
    console.log('处理方式（二选一）：');
    console.log('  1) 去掉 .skip，让用例真正跑起来；');
    console.log('  2) 确属正当延期时，在 test/skip-allowlist.json 里登记 file + title + reason + since，');
    console.log('     并在 PR 描述里写明理由与恢复条件。');
    if (strict) process.exit(1);
    console.log('');
    console.log('（当前为非 --strict 模式：只报告，不判失败）');
  } else {
    console.log('');
    console.log('✅ 所有硬跳过都已在 test/skip-allowlist.json 登记。');
  }
}

main();
