#!/usr/bin/env node
/**
 * 类名一致性检查（桌面端渲染层）。
 *
 * 为什么有它：今天两端都撞到同一类"半截约定" —— 源码里用了某个类名，样式表里却没有
 * 定义，于是静默降级成无样式（`.agents-detail-exec-*`、`.ui-modal__list/__hint`、
 * `.agent-failure-text`）。反过来也有定义了没人用的类（`.agent-actions`）。这类问题
 * 不会报错、不会被单元测试拦住，只会让界面"看着没排版"。
 *
 * 判定边界（保守优先，宁漏不误报）：
 * - 只看 `src/renderer/modules/**\/*.js` 模板串里的 `class="…"`，以及 `src/renderer/*.css`
 *   的选择器。渲染层不用 Tailwind，所以「带连字符或下划线的类名」就是自定义类名，
 *   `ui-` / `agents-` / `agent-` / `marketplace-` / `chat-` / `sc-` 等都是真实类名。
 * - 忽略：`data-*`/`aria-*`、单段小写词（可能是第三方或状态类）、含 `${}` 的模板片段、
 *   以 `is-`/`has-` 开头的**复合修饰类**在"定义了没人用"一侧不报（它们只跟基类一起出现）。
 * - `defined-but-unused` 只作提示（默认不影响退出码）：CSS 里存在少量给未来/条件分支用的类，
 *   误报成本比漏报高。
 *
 * 用法：
 *   node scripts/check-class-names.mjs              # 校验（有新增 used-but-undefined 就退出 1）
 *   node scripts/check-class-names.mjs --update-baseline   # 把当前结果固化为 baseline
 *   node scripts/check-class-names.mjs --json       # 机器可读输出
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'scripts/class-names-baseline.json');
/** 源码面：渲染层全部 JS 与静态 HTML（`class="…"` 在两者里同一形态）。 */
const SOURCE_ROOT = 'src/renderer';
const SOURCE_EXTENSIONS = ['.js', '.html'];
/** 样式面：渲染层全部 CSS（22 个文件，漏一个就会把它的类名误判成"没定义"）。 */
const STYLE_EXTENSIONS = ['.css'];
/** 生成物/开发用页面不参与。 */
const SKIP_DIRS = new Set(['node_modules', 'profile', 'profile2', 'dist']);
/** 单段小写词太多是第三方/状态类，只检查"像自定义类"的：含 `-` 或 `_`。 */
const CUSTOM_CLASS = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/;

function walk(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((ext) => full.endsWith(ext))) out.push(full);
  }
  return out;
}

function usedClasses() {
  const used = new Map(); // class -> Set<file>
  const patterns = [
    /class="([^"]*)"/g,
    /className="([^"]*)"/g,
    /classList\.(?:add|remove|toggle|contains)\(\s*'([^']+)'/g,
  ];
  for (const file of walk(join(ROOT, SOURCE_ROOT), SOURCE_EXTENSIONS)) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        for (const raw of match[1].split(/\s+/)) {
          const token = raw.trim();
          if (!token || token.includes('$') || token.includes('{')) continue;
          if (!CUSTOM_CLASS.test(token)) continue;
          const rel = file.slice(ROOT.length + 1);
          if (!used.has(token)) used.set(token, new Set());
          used.get(token).add(rel);
        }
      }
    }
  }
  return used;
}

function definedClasses() {
  const defined = new Map(); // class -> Set<file>
  for (const full of walk(join(ROOT, SOURCE_ROOT), STYLE_EXTENSIONS)) {
    const source = readFileSync(full, 'utf8');
    const rel = full.slice(ROOT.length + 1);
    for (const match of source.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      const token = match[1];
      if (!CUSTOM_CLASS.test(token)) continue;
      if (!defined.has(token)) defined.set(token, new Set());
      defined.get(token).add(rel);
    }
  }
  return defined;
}

const used = usedClasses();
const defined = definedClasses();
const usedButUndefined = [...used.keys()].filter((name) => !defined.has(name)).sort();
const definedButUnused = [...defined.keys()]
  .filter((name) => !used.has(name))
  // 状态/修饰类（`is-…` / `has-…`）常按条件拼接，静态扫描看不到用法，单列出来噪音太大。
  .filter((name) => !/(^|-)(is|has)-/.test(name))
  .sort();

const argv = new Set(process.argv.slice(2));
let baseline = { definedButUnused: [], usedButUndefined: [] };
try {
  baseline = { ...baseline, ...JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) };
} catch {
  /* 首次运行没有 baseline */
}

if (argv.has('--update-baseline')) {
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify({ definedButUnused, usedButUndefined }, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `[class-names] baseline 已更新：used-but-undefined ${usedButUndefined.length} 条、`
      + `defined-but-unused ${definedButUnused.length} 条 → ${BASELINE_PATH.slice(ROOT.length + 1)}`,
  );
  process.exit(0);
}

const newUndefined = usedButUndefined.filter((name) => !baseline.usedButUndefined?.includes(name));
const newUnused = definedButUnused.filter((name) => !baseline.definedButUnused?.includes(name));

if (argv.has('--json')) {
  console.log(JSON.stringify({ definedButUnused, newUndefined, newUnused, usedButUndefined }, null, 2));
} else {
  console.log(
    `[class-names] 已定义类名 ${defined.size} 个 / 源码用到 ${used.size} 个；`
      + `baseline 覆盖 used-but-undefined ${baseline.usedButUndefined?.length ?? 0} 条、`
      + `defined-but-unused ${baseline.definedButUnused?.length ?? 0} 条`,
  );
  if (newUndefined.length) {
    console.error(`\n[class-names] ✗ 新增「用了没定义」的类名 ${newUndefined.length} 条：`);
    for (const name of newUndefined) {
      console.error(`  ${name}`);
      for (const file of used.get(name) ?? []) console.error(`    ← ${file}`);
    }
  }
  if (newUnused.length) {
    console.log(`\n[class-names] 提示：「定义了没人用」新增 ${newUnused.length} 条（不影响退出码）`);
    for (const name of newUnused) console.log(`  ${name}`);
  }
  if (!newUndefined.length) console.log('[class-names] ✓ 没有新增「用了没定义」的类名');
}

process.exit(newUndefined.length ? 1 : 0);
