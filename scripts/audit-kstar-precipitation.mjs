#!/usr/bin/env node
/**
 * KStar 沉淀质量审计
 *
 * 统计最近窗口内 review / 候选池 / 资产的质量指标，用于验证 review
 * 方案改动（后台推理注入对话历史、Commander review 静默窗口）对沉淀
 * 质量的影响。
 *
 * 用法:
 *   node scripts/audit-kstar-precipitation.mjs                 # 默认最近 7 天
 *   node scripts/audit-kstar-precipitation.mjs --since-hours 24
 *   node scripts/audit-kstar-precipitation.mjs --data-root /path/to/data
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const sinceHours = Number(arg('--since-hours', 24 * 7));
const dataRoot = arg('--data-root', path.join(os.homedir(), '.cogseed', 'runtime-variants', 'cogseed', 'data'));

const sinceMs = Date.now() - sinceHours * 3600_000;
const uidDirs = fs.readdirSync(dataRoot).filter((d) => /^\d+$/.test(d));
if (!uidDirs.length) {
  console.error(`no uid dir under ${dataRoot}`);
  process.exit(1);
}
const cloud = path.join(dataRoot, uidDirs[0], 'cloud');
const readJsonDir = (dir) => {
  const full = path.join(cloud, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
};
const inWindow = (rec) => {
  const ts = rec.createdAt || rec.updatedAt;
  return ts && Date.parse(ts) >= sinceMs;
};
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(0)}%` : '-');

// ── 1. reviews ──────────────────────────────────────────────────────────
const reviews = readJsonDir('kstar/reviews').filter(inWindow);
const methods = {};
const lessons = { total: 0, withLesson: 0 };
const outcomes = {};
const attributions = {};
for (const r of reviews) {
  const m = r.inferenceMethod || 'unknown';
  methods[m] = (methods[m] || 0) + 1;
  lessons.total += 1;
  if (r.lesson?.trim()) lessons.withLesson += 1;
  outcomes[r.outcome || 'unclear'] = (outcomes[r.outcome || 'unclear'] || 0) + 1;
  attributions[r.attribution || 'unclear'] = (attributions[r.attribution || 'unclear'] || 0) + 1;
}

// ── 2. candidates ───────────────────────────────────────────────────────
const candidates = readJsonDir('recall/records/candidates');
const kstarCands = candidates.filter((c) => String(c.captureKey || '').startsWith('kstar-'));
const candStatus = {};
const merged = kstarCands.filter((c) => c.mergedIntoAssetId).length;
for (const c of kstarCands) candStatus[c.status || '?'] = (candStatus[c.status || '?'] || 0) + 1;

// ── 3. assets ───────────────────────────────────────────────────────────
const assets = readJsonDir('recall/records/ability-assets');
const assetTypes = {};
const assetLife = {};
for (const a of assets) {
  assetTypes[a.type || '?'] = (assetTypes[a.type || '?'] || 0) + 1;
  assetLife[a.lifecycleStatus || a.status || '?'] = (assetLife[a.lifecycleStatus || a.status || '?'] || 0) + 1;
}

// ── 4. lesson 具体性抽样（最近 5 条带 lesson 的 review）──────────────────
const recentLessons = reviews
  .filter((r) => r.lesson?.trim())
  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  .slice(0, 5);

console.log(`# KStar 沉淀质量审计（近 ${sinceHours}h，uid ${uidDirs[0]}）`);
console.log();
console.log('## review（窗口内）');
console.log(`- 总数: ${reviews.length}`);
console.log(`- lesson 提取率: ${pct(lessons.withLesson, lessons.total)} (${lessons.withLesson}/${lessons.total})`);
console.log(`- 生成方式分布: ${Object.entries(methods).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`- outcome: ${Object.entries(outcomes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`- attribution: ${Object.entries(attributions).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log();
console.log('## 候选池（kstar- 线，累计）');
console.log(`- 总数: ${kstarCands.length}`);
console.log(`- 状态: ${Object.entries(candStatus).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`- 语义去重命中(mergedIntoAssetId): ${merged}`);
console.log();
console.log('## 资产（累计）');
console.log(`- type: ${Object.entries(assetTypes).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`- lifecycle: ${Object.entries(assetLife).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log();
console.log('## lesson 抽样（最近 5 条）');
for (const r of recentLessons) {
  console.log(`- [${r.inferenceMethod}] ${String(r.lesson).slice(0, 120)}`);
}
console.log();
console.log('## 观察点');
console.log('- lesson 率异常高(>60%) → 警惕噪音资产');
console.log('- lesson 含具体步骤/工具/触发条件 → 质量好；泛泛而谈("认真完成任务") → 噪音');
console.log('- attribution 分布: 需求漂移场景不应大量 rule_gap');
console.log('- 重复资产 / mergedInto 上升 → 语义去重漏判');
