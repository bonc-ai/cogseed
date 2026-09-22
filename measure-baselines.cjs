// 集成彩排用：按 guard 同款口径测量各模块的真实计数，输出 实际值 vs 冻结基线。
// 用途：多个降债 PR 合并后，基线必须按**合并后的真实计数**重设，否则冻结值形同虚设
// （guard 只拦"变高"，留一个过高的基线等于给自己留后门）。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '.');
const modulesRoot = path.join(root, 'src/renderer/modules');
const guardPath = path.join(root, 'test/renderer/shared-ui-adoption-guard.test.ts');

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

const rawControlCount = (s) => (s.match(/<(?:button|input|textarea|select)\b/gi) || []).length;
const dynamicControlCount = (s) => (s.match(/\b(?:document\.)?createElement\(\s*['"](?:button|input|textarea|select)['"]\s*\)/gi) || []).length
  + (s.match(/\bel\(\s*['"](?:button|input|textarea|select)['"]/gi) || []).length;
const rawCheckboxCount = (s) => (s.match(/<input\b[^>]*\btype\s*=\s*['"]checkbox['"]/gi) || []).length
  + (s.match(/\.type\s*=\s*['"]checkbox['"]/gi) || []).length;
const emojiLineCount = (s) => s.split('\n').filter((l) => EMOJI_RE.test(l)).length;
const inlineSvgCount = (s) => (s.match(/<svg\b/gi) || []).length;
const literalZIndexCount = (s) => [...s.matchAll(/z-index\s*:\s*([^;}]+)/gi)].filter((m) => !/var\(\s*--z-/i.test(m[1] || '')).length;

const guard = fs.readFileSync(guardPath, 'utf8');
function baselineTable(name) {
  const m = guard.match(new RegExp(`const ${name}: Record<string, number> = \\{([\\s\\S]*?)\\n\\};`));
  if (!m) return null;
  const table = {};
  for (const line of m[1].split('\n')) {
    const hit = line.match(/^\s*'([^']+)':\s*(\d+),/);
    if (hit) table[hit[1]] = Number(hit[2]);
  }
  return table;
}

const tables = {
  legacyRawControlBaseline: { label: '裸控件', fn: rawControlCount },
  legacyDynamicControlBaseline: { label: '动态控件', fn: dynamicControlCount },
  legacyRawCheckboxBaseline: { label: '裸 checkbox', fn: rawCheckboxCount },
  emojiAsIconBaseline: { label: 'emoji', fn: emojiLineCount },
  inlineSvgBaseline: { label: '内联 svg', fn: inlineSvgCount },
  literalZIndexBaseline: { label: '字面 z-index', fn: literalZIndexCount },
};

const targets = Object.keys(tables);
for (const name of targets) {
  const table = baselineTable(name);
  if (!table) { console.log(`!! 读不到 ${name}`); continue; }
  const rows = [];
  for (const file of Object.keys(table)) {
    const abs = path.join(modulesRoot, file);
    if (!fs.existsSync(abs)) { rows.push([file, table[file], '文件不存在']); continue; }
    const actual = tables[name].fn(fs.readFileSync(abs, 'utf8'));
    if (actual !== table[file]) rows.push([file, table[file], actual]);
  }
  console.log(`\n== ${tables[name].label}（${name}）：${rows.length} 处需要重设 ==`);
  for (const [file, base, actual] of rows) console.log(`   ${file.padEnd(34)} 基线 ${String(base).padStart(3)} → 实际 ${actual}`);
}
