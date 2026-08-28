#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CSS_DIR = path.join(ROOT, 'src', 'renderer');
const BASELINE = path.join(HERE, 'design-tokens-baseline.json');

// tokens.css owns literal values. Vendor assets are outside this top-level scan.
const EXEMPT = new Set(['tokens.css']);

const FONT_SCALE = new Set([11, 12, 13, 14, 16, 20]);
const RADIUS_SCALE = new Set([6, 8, 12, 999]);

const RULES = [
  {
    key: 'color',
    label: 'color literals',
    hint: 'Use a semantic color token, adding it to tokens.css when needed.',
    scan(source) {
      const hits = [];
      for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) hits.push(match[0]);
      for (const match of source.matchAll(/\brgba?\([^)]*\)/g)) hits.push(match[0]);
      return hits;
    },
  },
  {
    key: 'zIndex',
    label: 'literal z-index values',
    hint: 'Use the matching --z-* layer token from tokens.css.',
    scan(source) {
      const hits = [];
      for (const match of source.matchAll(/z-index\s*:\s*([^;}]+)/g)) {
        if (!/var\(--z-/.test(match[1])) hits.push(match[0].trim());
      }
      return hits;
    },
  },
  {
    key: 'fontSize',
    label: 'off-scale font sizes',
    hint: 'Use 11, 12, 13, 14, 16, or 20px through a --font-size-* token.',
    scan(source) {
      const hits = [];
      for (const match of source.matchAll(/font-size\s*:\s*([\d.]+)px/g)) {
        if (!FONT_SCALE.has(Number(match[1]))) hits.push(match[0].trim());
      }
      return hits;
    },
  },
  {
    key: 'radius',
    label: 'off-scale radii',
    hint: 'Use 6, 8, 12, or 999px through a --radius-* token.',
    scan(source) {
      const hits = [];
      for (const match of source.matchAll(/border-radius\s*:\s*([\d.]+)px/g)) {
        if (!RADIUS_SCALE.has(Number(match[1]))) hits.push(match[0].trim());
      }
      return hits;
    },
  },
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssFiles() {
  if (!fs.existsSync(CSS_DIR)) return [];
  return fs
    .readdirSync(CSS_DIR)
    .filter((file) => file.endsWith('.css') && !EXEMPT.has(file))
    .sort();
}

function measure() {
  const report = {};
  for (const file of cssFiles()) {
    const source = stripComments(fs.readFileSync(path.join(CSS_DIR, file), 'utf8'));
    const counts = {};
    for (const rule of RULES) {
      const hits = rule.scan(source);
      if (hits.length) counts[rule.key] = hits.length;
    }
    if (Object.keys(counts).length) report[file] = counts;
  }
  return report;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

function total(report) {
  let count = 0;
  for (const rules of Object.values(report)) {
    for (const value of Object.values(rules)) count += value;
  }
  return count;
}

const args = new Set(process.argv.slice(2));
const current = measure();

if (args.has('--update')) {
  const previous = loadBaseline();
  if (previous && !args.has('--force')) {
    const increases = [];
    for (const [file, counts] of Object.entries(current)) {
      for (const [key, count] of Object.entries(counts)) {
        const priorCount = previous[file]?.[key] ?? 0;
        if (count > priorCount) increases.push(`${file} ${key}: ${priorCount} -> ${count}`);
      }
    }
    if (increases.length) {
      console.error('Refusing to update the baseline because token debt increased:');
      for (const increase of increases) console.error(`  ${increase}`);
      console.error('Fix the increase, or use --force with an explicit PR explanation.');
      process.exit(1);
    }
  }
  fs.writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`Updated token baseline: ${Object.keys(current).length} files, ${total(current)} findings.`);
  process.exit(0);
}

const baseline = loadBaseline();
if (!baseline) {
  console.error('Missing scripts/design-tokens-baseline.json. Run npm run tokens:update once.');
  process.exit(1);
}

const failures = [];
for (const [file, counts] of Object.entries(current)) {
  for (const [key, count] of Object.entries(counts)) {
    const priorCount = baseline[file]?.[key] ?? 0;
    if (count <= priorCount) continue;
    const rule = RULES.find((candidate) => candidate.key === key);
    failures.push({ file, rule, priorCount, count });
  }
}

if (failures.length) {
  console.error('Design-token gate failed because literal-value debt increased:');
  for (const failure of failures) {
    console.error(
      `  ${failure.file} ${failure.rule.label}: ${failure.priorCount} -> ${failure.count}`,
    );
    console.error(`    ${failure.rule.hint}`);
  }
  console.error('Token definitions live in src/renderer/tokens.css.');
  process.exit(1);
}

const reduction = total(baseline) - total(current);
if (reduction > 0) {
  console.log(`Design-token gate passed with ${reduction} fewer findings; run npm run tokens:update.`);
} else {
  console.log(`Design-token gate passed: ${total(current)} existing findings, no increase.`);
}
