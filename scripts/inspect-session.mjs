#!/usr/bin/env node
/**
 * Conversation / session inspector (read-only).
 *
 * Why: debugging a conversation currently means grepping two different JSONL
 * shapes by hand — `cloud/chats/<cid>.jsonl` (room transcript: from/to/text)
 * and `cloud/sessions/<kind>-<tail>.jsonl` (model-facing session: role/content/
 * turnId, plus `.tool-results/` and `.context.json` sidecars). This tool prints
 * the structure of both sides in one view, so "what actually happened in this
 * conversation" is a command instead of an archaeology session.
 *
 * Boundaries:
 *   - Read-only. Never writes, never touches the network, never mutates state.
 *   - Content is truncated to a snippet by default (`--full` prints whole text):
 *     terminal scrollback and pasted bug reports leak easily.
 *   - No dependencies, no TS build: plain Node ESM so it runs on a fresh clone.
 *
 * Usage:
 *   node scripts/inspect-session.mjs [--list] [--uid UID] [--cid CID]
 *                                    [--data-root DIR] [--full] [--json]
 *
 *   --list        list conversations with counts (default when --cid is absent)
 *   --cid CID     detailed view of one conversation (chat + session + sidecars)
 *   --uid UID     user id (default: the only user dir under the data root)
 *   --data-root   container dir (default: first of the known local roots)
 *   --full        print full message text instead of a 60-char snippet
 *   --json        machine-readable output
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SNIPPET = 60;

function parseArgs(argv) {
  const args = { list: false, full: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--full') args.full = true;
    else if (a === '--json') args.json = true;
    else if (a === '--uid') args.uid = argv[++i];
    else if (a === '--cid') args.cid = argv[++i];
    else if (a === '--data-root') args.dataRoot = argv[++i];
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

function firstExisting(candidates) {
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* keep looking */ }
  }
  return null;
}

function resolveDataRoot(explicit) {
  if (explicit) return explicit;
  if (process.env.COGSEED_DATA_ROOT) return process.env.COGSEED_DATA_ROOT;
  return firstExisting([
    path.join(os.homedir(), '.cogseed', 'data'),
    path.join(os.homedir(), '.cogseed-enterprise', 'data'),
    path.join(os.homedir(), '.mate-agent', 'data'),
    path.join(os.homedir(), 'Library', 'Application Support', 'cogseed', 'data'),
  ]);
}

function resolveUid(dataRoot, explicit) {
  if (explicit) return explicit;
  if (process.env.COGSEED_UID) return process.env.COGSEED_UID;
  const entries = fs.readdirSync(dataRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
  return entries.length === 1 ? entries[0] : (entries[0] ?? null);
}

function readJsonl(file, limit = Infinity) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], malformed: 0, bytes: 0 }; }
  const rows = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch { malformed += 1; }
    if (rows.length >= limit) break;
  }
  return { rows, malformed, bytes: Buffer.byteLength(text) };
}

const snippet = (value, full) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (full) return text;
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
};

const iso = (ts) => {
  if (typeof ts === 'number') return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  if (typeof ts === 'string' && ts) return ts.slice(0, 19).replace('T', ' ');
  return '—';
};

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); }
  catch { return []; }
}

function conversationIds(chatsDir) {
  return listDir(chatsDir)
    .filter((e) => !e.dir && e.name.endsWith('.jsonl'))
    .map((e) => e.name.replace(/\.jsonl$/, ''))
    .sort();
}

function summarizeConversation(cid, chatsDir, sessionsDir) {
  const chatFile = path.join(chatsDir, `${cid}.jsonl`);
  const { rows, malformed, bytes } = readJsonl(chatFile);
  const participants = new Map();
  let firstTs = null;
  let lastTs = null;
  let attachments = 0;
  let actionRequests = 0;
  let p3394 = 0;
  for (const row of rows) {
    const key = `${row.from ?? '?'}→${row.to ?? '?'}`;
    participants.set(key, (participants.get(key) ?? 0) + 1);
    if (firstTs === null) firstTs = row.ts ?? null;
    lastTs = row.ts ?? lastTs;
    if (Array.isArray(row.attachments) && row.attachments.length) attachments += row.attachments.length;
    if (row.action_request_id) actionRequests += 1;
    if (row.p3394) p3394 += 1;
  }
  const sessionFiles = listDir(sessionsDir)
    .filter((e) => !e.dir && e.name.startsWith(`gconv-${cid}`) || (!e.dir && e.name.startsWith(cid)))
    .map((e) => e.name);
  const sessionLog = sessionFiles.find((n) => n.endsWith('.jsonl'));
  const toolResultsDir = sessionFiles.find((n) => n.endsWith('.tool-results'));
  const session = sessionLog
    ? readJsonl(path.join(sessionsDir, sessionLog))
    : { rows: [], malformed: 0, bytes: 0 };
  const turns = new Map();
  for (const row of session.rows) {
    const turn = String(row.turnId ?? '(none)');
    turns.set(turn, (turns.get(turn) ?? 0) + 1);
  }
  return {
    cid,
    chat: {
      file: chatFile,
      messages: rows.length,
      malformed,
      bytes,
      firstTs: iso(firstTs),
      lastTs: iso(lastTs),
      participants: [...participants.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`),
      attachments,
      actionRequests,
      p3394,
    },
    session: {
      log: sessionLog ?? null,
      messages: session.rows.length,
      malformed: session.malformed,
      bytes: session.bytes,
      turns: [...turns.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}×${v}`),
      toolResultFiles: toolResultsDir ? listDir(path.join(sessionsDir, toolResultsDir)).length : 0,
      contextFile: sessionFiles.find((n) => n.endsWith('.context.json')) ?? null,
    },
  };
}

function detail(cid, chatsDir, sessionsDir, args) {
  const summary = summarizeConversation(cid, chatsDir, sessionsDir);
  const chatFile = path.join(chatsDir, `${cid}.jsonl`);
  const { rows } = readJsonl(chatFile);
  const lines = rows.map((row, i) => ({
    n: i + 1,
    ts: iso(row.ts),
    route: `${row.from ?? '?'}→${row.to ?? '?'}`,
    chars: typeof row.text === 'string' ? row.text.length : 0,
    flags: [
      row.attachments?.length ? `att×${row.attachments.length}` : '',
      row.action_request_id ? 'action' : '',
      row.p3394 ? 'p3394' : '',
      row.run_id ? 'run' : '',
    ].filter(Boolean).join(' '),
    text: snippet(row.text, args.full),
  }));
  const sessionLog = summary.session.log ? path.join(sessionsDir, summary.session.log) : null;
  const sessionRows = sessionLog ? readJsonl(sessionLog).rows : [];
  const sessionLines = sessionRows.slice(0, 40).map((row, i) => ({
    n: i + 1,
    turn: String(row.turnId ?? '—'),
    role: String(row.role ?? '—'),
    chars: typeof row.content === 'string' ? row.content.length : JSON.stringify(row.content ?? '').length,
    ts: iso(row.ts),
  }));
  return { summary, lines, sessionLog, sessionLines, sessionTotal: sessionRows.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataRoot = resolveDataRoot(args.dataRoot);
  if (!dataRoot) { console.error('找不到数据根：用 --data-root 或 COGSEED_DATA_ROOT 指定'); process.exit(2); }
  const uid = resolveUid(dataRoot, args.uid);
  if (!uid) { console.error(`数据根下没有用户目录：${dataRoot}`); process.exit(2); }
  const chatsDir = path.join(dataRoot, uid, 'cloud', 'chats');
  const sessionsDir = path.join(dataRoot, uid, 'cloud', 'sessions');
  if (!fs.existsSync(chatsDir)) { console.error(`没有 chats 目录：${chatsDir}`); process.exit(2); }

  const ids = conversationIds(chatsDir);
  if (args.cid) {
    if (!ids.includes(args.cid)) { console.error(`没有这个会话：${args.cid}（共 ${ids.length} 个）`); process.exit(2); }
    const out = detail(args.cid, chatsDir, sessionsDir, args);
    if (args.json) { console.log(JSON.stringify(out, null, 2)); return; }
    const { summary } = out;
    console.log(`会话 ${summary.cid}`);
    console.log(`  房间记录: ${summary.chat.messages} 条 / ${summary.chat.bytes}B（坏行 ${summary.chat.malformed}）`);
    console.log(`  参与方  : ${summary.chat.participants.join(', ') || '—'}`);
    console.log(`  时间范围: ${summary.chat.firstTs} → ${summary.chat.lastTs}`);
    console.log(`  附件 ${summary.chat.attachments} / action_request ${summary.chat.actionRequests} / p3394 ${summary.chat.p3394}`);
    console.log(`  会话日志: ${summary.session.log ?? '(无)'} — ${summary.session.messages} 条 / ${summary.session.bytes}B`);
    console.log(`  回合分布: ${summary.session.turns.join(', ') || '—'}`);
    console.log(`  工具结果: ${summary.session.toolResultFiles} 个文件   上下文: ${summary.session.contextFile ?? '(无)'}`);
    console.log('\n房间记录（时间 / 路由 / 字符数 / 标记 / 摘要）');
    for (const l of out.lines) {
      console.log(`  ${String(l.n).padStart(3)}  ${l.ts}  ${l.route.padEnd(24)} ${String(l.chars).padStart(7)}B  ${l.flags.padEnd(14)} ${l.text}`);
    }
    if (out.sessionLog) {
      console.log(`\n会话日志前 ${out.sessionLines.length}/${out.sessionTotal} 条（回合 / 角色 / 字符数）`);
      for (const l of out.sessionLines) console.log(`  ${String(l.n).padStart(3)}  turn=${l.turn.padEnd(12)} ${l.role.padEnd(10)} ${String(l.chars).padStart(7)}B  ${l.ts}`);
    }
    return;
  }

  const summaries = ids.map((cid) => summarizeConversation(cid, chatsDir, sessionsDir));
  if (args.json) { console.log(JSON.stringify({ dataRoot, uid, conversations: summaries }, null, 2)); return; }
  console.log(`数据根 ${dataRoot}  用户 ${uid}  会话 ${summaries.length} 个\n`);
  console.log('  cid           房间  会话日志  回合  工具结果  时间范围');
  for (const s of summaries) {
    console.log(`  ${s.cid.padEnd(14)} ${String(s.chat.messages).padStart(4)}  ${String(s.session.messages).padStart(6)}  ${String(s.session.turns.length).padStart(4)}  ${String(s.session.toolResultFiles).padStart(6)}   ${s.chat.firstTs} → ${s.chat.lastTs}`);
  }
  console.log('\n用 --cid <cid> 看单个会话的完整结构。');
}

main();
