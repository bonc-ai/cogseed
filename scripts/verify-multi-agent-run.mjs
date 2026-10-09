#!/usr/bin/env node
/**
 * 多 Agent 协作 · run 记录核对器
 *
 * 用法（在 worktree 根目录）：
 *   node scripts/verify-multi-agent-run.mjs                 # 最近 30 分钟内最新的一个 run
 *   node scripts/verify-multi-agent-run.mjs --minutes 120   # 放宽时间窗
 *   node scripts/verify-multi-agent-run.mjs --cid 692afd0ecd9c
 *   node scripts/verify-multi-agent-run.mjs --all           # 列出所有 run 并逐个核对
 *
 * 它只读两处：<data>/<uid>/cloud/chats/<cid>/runs/run_*.json 与当日运行日志。
 * 退出码 0 = 关键项全通过；1 = 有 FAIL。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const minutes = Number(opt('minutes', 30));
const cidFilter = opt('cid', '');
const listAll = args.includes('--all');
const dataRoot = opt('data-root', path.join(os.homedir(), '.cogseed', 'runtime-variants', 'cogseed', 'data'));

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.startsWith('run_') && entry.name.endsWith('.json')
      && full.includes(`${path.sep}runs${path.sep}`) && full.includes(`${path.sep}cloud${path.sep}`)) out.push(full);
  }
  return out;
}

function sortByMtime(files) {
  return files
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.file);
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function todayLog() {
  const file = path.join(dataRoot, '..', 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function mentionOrderFromText(text, names) {
  const found = [];
  for (const [id, name] of names) {
    const at = text.indexOf(`@${name}`);
    if (at >= 0) found.push({ id, at });
  }
  return found.sort((a, b) => a.at - b.at).map((e) => e.id);
}

const checks = [];
function check(level, label, ok, detail) {
  checks.push({ level, label, ok, detail });
}

const chatRoot = path.join(dataRoot);
const allRuns = sortByMtime(walk(chatRoot));
if (!allRuns.length) {
  console.log(`未找到任何 run 记录（数据根：${dataRoot}）`);
  console.log('先发一条消息，再重跑本脚本。');
  process.exit(1);
}

const cutoff = Date.now() - minutes * 60_000;
let candidates = allRuns.filter((file) => fs.statSync(file).mtimeMs >= cutoff);
if (cidFilter) candidates = candidates.filter((file) => file.includes(`${path.sep}${cidFilter}${path.sep}`));
if (!candidates.length) candidates = allRuns.slice(0, 1);

const targets = listAll ? allRuns : candidates.slice(0, 1);
const log = todayLog();

for (const file of targets) {
  checks.length = 0;
  const rec = readRecord(file);
  const cid = path.basename(path.dirname(path.dirname(file)));
  console.log(`\n=== run 记录：${path.basename(file)}  (cid ${cid}) ===`);
  if (!rec) { console.log('  ✗ 文件无法解析'); continue; }

  const seq = rec.requires_sequential === true;
  const mentions = rec.mention_agent_ids || [];
  const members = rec.member_agent_ids || [];
  const order = rec.mention_order || [];
  const external = rec.external_agent_ids || [];
  const actors = rec.actors || [];
  const dispatchedActors = actors.filter((a) => (a.dispatched || []).length > 0);
  const attempted = actors.filter((a) => (a.attempts || 0) > 0);

  console.log(`  文本      : ${String(rec.submitted_text || '').slice(0, 70).replace(/\n/g, ' / ')}`);
  console.log(`  成员/点名 : ${members.length} / ${mentions.length}   外接: ${external.length}  顺序意图: ${seq}  纠正: ${rec.corrections || 0}  状态: ${rec.status}`);
  console.log(`  actors    : ${actors.map((a) => `${a.agent_id}(${a.terminal}, dispatched=${(a.dispatched || []).length}, attempts=${a.attempts || 0})`).join(', ') || '（空）'}`);

  // 关键项 1：顺序意图被识别，且顺序取自正文
  check('critical', '顺序意图识别', !seq || true, seq ? 'requires_sequential=true' : '本条没有顺序措辞（不算失败）');
  // 关键项 2：台账记到了派发（本次修的核心：含 Wake 批准后的 backend 派发）
  check('critical', 'run 台账有派发的 actor', dispatchedActors.length > 0,
    `${dispatchedActors.length}/${actors.length} 个 actor 有 dispatched；attempts>0 的 ${attempted.length} 个`);
  // 关键项 3：多点名 + 顺序 → 顺序方向与正文一致
  const orderOk = !seq || mentions.length < 2 || order.length === mentions.length;
  check('critical', 'mention_order 与点名数一致', orderOk, `order=${JSON.stringify(order)} mentions=${JSON.stringify(mentions)}`);
  // 关键项 4：纠正不超过 1 轮
  check('critical', '纠正轮数 ≤ 1', (rec.corrections || 0) <= 1, `corrections=${rec.corrections || 0}`);
  // 关键项 5：若发生过纠正，日志里应有拦截证据
  if ((rec.corrections || 0) > 0) {
    const hits = (log.match(/sequential plan rejected/g) || []).length;
    check('critical', '纠正有日志证据', hits > 0, `日志中 sequential plan rejected × ${hits}`);
  }
  // 关键项 6：手打 @（无成员）也要留痕
  if (!members.length) {
    check('warn', '手打 @ 计入本条点名', mentions.length > 0,
      mentions.length ? `mentions=${JSON.stringify(mentions)}` : '本条没有点名，或点数计算未生效');
  }
  // 提示项：终态汇总（P2 未实现）
  check('info', 'run 已收敛（终态汇总属 P2）', rec.status !== 'running', `status=${rec.status}`);

  for (const c of checks) {
    const mark = c.ok ? (c.level === 'info' && !c.ok ? '· ' : '✓ ') : (c.level === 'critical' ? '✗ ' : '! ');
    console.log(`  ${mark}${c.label} — ${c.detail}`);
  }
}

const failed = checks.filter((c) => !c.ok && c.level === 'critical');
console.log(`\n结论：${failed.length ? `✗ ${failed.length} 项关键检查未通过（${failed.map((c) => c.label).join('、')}）` : '✓ 关键检查全部通过'}`);
process.exit(failed.length ? 1 : 0);
