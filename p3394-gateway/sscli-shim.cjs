#!/usr/bin/env node
// ── p3394-sscli 通用协议垫片（shim）──────────────────────────────────────
//
// 让任何「一次性命令行调用」形态的 CLI（gemini/hermes/aider/openclaw/
// opencode/workbuddy…）以 p3394-sscli/1.0 常驻协议接入网关：
//
//   gateway.cjs (SscliRuntime)
//     ↕ stdin/stdout JSONL（p3394-sscli/1.0：hello/open_session/deliver/
//       cancel/heartbeat；delta/completed/failed 事件）
//   sscli-shim.cjs（本文件，常驻）
//     ↕ 每轮 spawn 一次真实 CLI（stdio pipe）
//   gemini / hermes / …
//
// 会话连续性与 G-27 的 oneshot resume 同一套语义：登记了 resume 能力的
// CLI 带 resume 参数续聊（会话号存 shim-sessions/<sid>/cli-session.json），
// 会话被拒清绑定回放重试；未登记的 CLI 靠 transcript 回放兜底。
// 这是 P3394 标准推广前的过渡桥：CLI 将来原生讲协议后，把网关登记的
// shim 包装换回直连即可，上层零改动。
//
// 用法（由 gateway.cjs 自动构造，无需手工调用）：
//   node sscli-shim.cjs --exec <cli> --args <argsTemplate>
//        [--home <sessionsRoot>] [--preset <name>]
//        [--resume-config <base64 JSON：{resumeArgs,sessionIdPattern,sessionGenerate}>]

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROTOCOL = 'p3394-sscli/1.0';
const TIMEOUT_MS = Number(process.env.P3394_AGENT_TIMEOUT_MS || 10 * 60 * 1000);
const TRANSCRIPT_TURNS = 8;
const TRANSCRIPT_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 100 * 1024;
const STREAM_CAP_CHARS = 256 * 1024;

// ── 启动参数解析 ──
function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--exec') out.exec = argv[i + 1];
    else if (a === '--args') out.args = argv[i + 1];
    else if (a === '--home') out.home = argv[i + 1];
    else if (a === '--preset') out.preset = argv[i + 1];
    else if (a === '--resume-config') out.resumeConfig = argv[i + 1];
    else if (a === '--') { out.rest = argv.slice(i + 1); break; }
  }
  return out;
}
const CFG = parseArgv(process.argv.slice(2));
const CLI = String(CFG.exec || '').trim();
const CLI_ARGS = String(CFG.args || '{message}').trim();
let RESUME = null;
try {
  RESUME = CFG.resumeConfig ? JSON.parse(Buffer.from(CFG.resumeConfig, 'base64').toString('utf8')) : null;
} catch { RESUME = null; }
const HOME = String(CFG.home || path.join(os.homedir(), '.p3394-gateway')).trim();

function sanitizeStreamText(s) {
  s = String(s || '');
  s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
  s = s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  s = s.replace(/[^\r\n]*\r(?!\n)/g, '');
  return s;
}

// ── 会话状态（transcript + cli-session，目录与网关会话目录隔离）──
function sessionIdDir(sid) {
  const clean = String(sid || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(HOME, 'shim-sessions', clean);
}
function transcriptFile(sid) { return path.join(sessionIdDir(sid), 'transcript.jsonl'); }
function readTranscriptTail(sid) {
  const file = transcriptFile(sid);
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const picked = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && picked.length < TRANSCRIPT_TURNS; i -= 1) {
    if (bytes + lines[i].length > TRANSCRIPT_BYTES) break;
    picked.unshift(lines[i]);
    bytes += lines[i].length;
  }
  return picked.join('\n');
}
function appendTranscript(sid, role, text) {
  const line = JSON.stringify({ at: new Date().toISOString(), role, text: String(text).slice(0, 20_000) });
  const file = transcriptFile(sid);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch { /* best effort */ }
}
function cliSessionFile(sid) { return path.join(sessionIdDir(sid), 'cli-session.json'); }
function readCliSession(sid) {
  try {
    const data = JSON.parse(fs.readFileSync(cliSessionFile(sid), 'utf8'));
    if (!data || typeof data.sessionId !== 'string' || !data.sessionId) return null;
    if (RESUME && data.cli !== (CFG.preset || CLI)) return null;
    return data;
  } catch { return null; }
}
function writeCliSession(sid, id) {
  if (!id) return;
  try {
    fs.mkdirSync(sessionIdDir(sid), { recursive: true });
    fs.writeFileSync(cliSessionFile(sid), JSON.stringify({ cli: CFG.preset || CLI, sessionId: id, updatedAt: new Date().toISOString() }));
  } catch { /* best effort */ }
}
function clearCliSession(sid) { try { fs.unlinkSync(cliSessionFile(sid)); } catch { /* absent ok */ } }
function extractCliSessionId(output) {
  if (!RESUME || typeof RESUME.sessionIdPattern !== 'string' || !output) return null;
  try {
    const m = new RegExp(RESUME.sessionIdPattern).exec(String(output));
    if (m && m[1]) return m[1].trim();
  } catch { /* bad pattern */ }
  return null;
}
function resumeCapable() { return !!(RESUME && (typeof RESUME.resumeArgs === 'string' || RESUME.sessionGenerate === true)); }
function currentOrGeneratedCliSessionId(sid) {
  const existing = readCliSession(sid);
  if (existing) return existing.sessionId;
  if (RESUME && RESUME.sessionGenerate === true) {
    const id = 'p3394-' + crypto.randomUUID();
    writeCliSession(sid, id);
    return id;
  }
  return null;
}
function buildResumeArgs(id) {
  if (!RESUME || typeof RESUME.resumeArgs !== 'string' || !id) return [];
  return RESUME.resumeArgs.split(' ').filter(Boolean).map((p) => p.replace('{cli_session_id}', id));
}
const RESUME_REJECTED_PATTERNS = [
  /session\s+(?:not\s+found|expired|invalid|does\s+not\s+exist)/i,
  /unknown\s+(?:session|conversation|thread)/i,
  /cannot\s+resume/i,
  /failed\s+to\s+resume/i,
  /No\s+conversation\s+found\s+with\s+session\s+ID/i,
];
function resumeRejectedByText(t) {
  return typeof t === 'string' && t && RESUME_REJECTED_PATTERNS.some((re) => re.test(t));
}

// ── CLI 执行（单轮 spawn；chunk → delta 帧）──
let activeTurn = null; // { child, requestId, streamedChars }
let eventSeq = 0; // 指南 §9.2：Request 内事件单调 sequence
const sessionWorkspaces = new Map(); // session_id → workspace（open_session 声明）

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function emitEvent(fields) {
  eventSeq += 1;
  emit({ ...fields, sequence: eventSeq });
}

// ── 工具过程可见性（best-effort）──
// 多数 CLI 的过程日志（openclaw 的 [skills]/[tools]、aider 的编辑回显等）
// 走 stderr；正文走 stdout。stderr 逐行清洗后转发为 progress 帧 → 网关
// pushProgress → process rail。规则刻意保守：噪声行不进栏（无信息量还刷屏），
// 每轮总量封顶防失控 CLI 爆栏。
const PROGRESS_MAX_LINES = 200;
const SLOW_START_HINT_MS = 8000;
const STDERR_NOISE_RE = /deprecat|warning|debug|verbose|experimental|trace|telemetry|update available|usage data|anonymous|node:internal|--trace|socket hang up/i;
function cliLabel() { return path.basename(String(CLI || 'cli')); }
function progressLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 400) return null;
  if (t.startsWith('{')) return null; // JSON 信封/结构化输出不是过程日志
  if (t.startsWith('[')) {
    // 方括号标签行（openclaw 的 [skills]/[tools] 等）是合法过程日志；
    // 只有整行真能 JSON.parse（数组型结构化输出）才排除。
    try { JSON.parse(t); return null; } catch { /* 标签行，放行 */ }
  }
  if (STDERR_NOISE_RE.test(t)) return null;
  return t;
}

function runCliOnce(requestId, prompt, extraArgs, cwd) {
  return new Promise((resolve, reject) => {
    const args = CLI_ARGS.split(' ').map((p) => p.replace('{message}', prompt)).concat(Array.isArray(extraArgs) ? extraArgs : []);
    // 冷启动可见性：CLI 启动占每轮首字延迟大头（实测 8-12s），spawn 即告知，
    // 超时未见首字再提示一次——无提示时用户面对的是无响应黑盒。
    emitEvent({ event: 'progress', request_id: requestId, text: '正在启动 ' + cliLabel() + '…' });
    const child = spawn(CLI, args, { cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    activeTurn = { child, requestId, streamedChars: 0 };
    let out = '';
    let errOut = '';
    let errLineBuf = '';
    let progressSent = 0;
    const slowStartTimer = setTimeout(() => {
      if (activeTurn && activeTurn.child === child && activeTurn.streamedChars === 0) {
        emitEvent({ event: 'progress', request_id: requestId, text: cliLabel() + ' 冷启动较慢，仍在等待首个输出…' });
      }
    }, SLOW_START_HINT_MS);
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      finish(new Error('p3394_agent_timeout'));
    }, TIMEOUT_MS);
    function finish(error) {
      clearTimeout(timer);
      clearTimeout(slowStartTimer);
      if (activeTurn && activeTurn.child === child) activeTurn = null;
      if (error) reject(error); else resolve(out.trim());
    }
    child.stdout.on('data', (chunk) => {
      if (out.length < MAX_REPLY_BYTES * 4) out += chunk;
      if (!activeTurn || activeTurn.child !== child) return;
      if (activeTurn.streamedChars >= STREAM_CAP_CHARS) return;
      const visible = sanitizeStreamText(chunk.toString('utf8'));
      if (!visible) return;
      activeTurn.streamedChars += visible.length;
      emitEvent({ event: 'delta', request_id: requestId, text: visible });
    });
    child.stderr.on('data', (chunk) => {
      if (errOut.length < 8 * 1024) errOut += chunk;
      // 行可能跨 chunk，残行缓冲拼接后逐行走 progress 通道。
      errLineBuf += chunk.toString('utf8');
      const lines = errLineBuf.split('\n');
      errLineBuf = lines.pop() || '';
      for (const line of lines) {
        const text = progressLine(sanitizeStreamText(line));
        if (!text || progressSent >= PROGRESS_MAX_LINES) continue;
        progressSent += 1;
        emitEvent({ event: 'progress', request_id: requestId, text });
      }
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error('agent exited ' + code + (errOut ? ': ' + sanitizeStreamText(errOut.slice(-300)) : '')));
    });
  });
}

async function handleDeliver(op) {
  const sid = op.session_id || 'default';
  const text = String(op.message && op.message.payload && op.message.payload.parts
    && op.message.payload.parts[0] && op.message.payload.parts[0].text || '');
  if (!text.trim()) {
    emitEvent({ event: 'failed', request_id: op.request_id, error: 'shim_empty_message' });
    return;
  }
  // 指南 §9.2：open_session 声明的 workspace 即 CLI 工作目录（与 oneshot
  // 模式的 extensions.working_dir 语义一致——否则 CLI 退回网关目录，丢
  // 项目上下文）。
  const cwd = sessionWorkspaces.get(sid) || null;
  // G-27 同款降级链：resume 优先（不回放），被拒清绑定回放重试一次。
  if (resumeCapable()) {
    const cliSessionId = currentOrGeneratedCliSessionId(sid);
    if (cliSessionId) {
      try {
        const out = await runCliOnce(op.request_id, text, buildResumeArgs(cliSessionId), cwd);
        const nextId = extractCliSessionId(out);
        if (nextId && nextId !== cliSessionId) writeCliSession(sid, nextId);
        appendTranscript(sid, 'in', text);
        appendTranscript(sid, 'out', out);
        emitEvent({ event: 'completed', request_id: op.request_id });
        return;
      } catch (err) {
        if (!resumeRejectedByText(err && err.message)) throw err;
        clearCliSession(sid);
        // fall through — 回放重试
      }
    }
  }
  const transcript = readTranscriptTail(sid);
  const prompt = (transcript ? '[会话历史]\n' + transcript + '\n\n' : '') + text;
  const out = await runCliOnce(op.request_id, prompt, [], cwd);
  const nextId = extractCliSessionId(out);
  if (nextId) writeCliSession(sid, nextId);
  appendTranscript(sid, 'in', text);
  appendTranscript(sid, 'out', out);
  emitEvent({ event: 'completed', request_id: op.request_id });
}

// ── p3394-sscli/1.0 协议主循环 ──
let lineBuf = '';
process.stdout.write(''); // warm the stream
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  lineBuf += chunk;
  const lines = lineBuf.split('\n');
  lineBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let op;
    try { op = JSON.parse(line); } catch { continue; }
    if (op.op === 'hello') {
      emit({ ok: true, protocol: PROTOCOL, runtime: 'p3394-sscli-shim/1.0', request_id: op.request_id });
    } else if (op.op === 'open_session') {
      if (typeof op.workspace === 'string' && op.workspace.trim()) {
        sessionWorkspaces.set(String(op.session_id || 'default'), op.workspace.trim());
      }
      // 指南 §9.2：应答携带 native_session_id（shim 的原生会话即其会话目录）。
      emit({ ok: true, request_id: op.request_id, native_session_id: 'shim:' + String(op.session_id || 'default') });
    } else if (op.op === 'deliver') {
      handleDeliver(op).catch((err) => {
        const message = (err && err.message) || String(err);
        emitEvent({ event: 'failed', request_id: op.request_id, error: message });
      });
    } else if (op.op === 'cancel') {
      if (activeTurn && activeTurn.child) {
        try { activeTurn.child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      // 在途 deliver 的 runCliOnce 会以非零退出 reject → 上面的 catch 发
      // failed 事件；网关对取消场景已有独立回执，这里不额外应答。
    } else if (op.op === 'heartbeat') {
      emit({ ok: true, request_id: op.request_id });
    } else if (op.request_id !== undefined) {
      emit({ ok: false, error: 'shim_unknown_op', request_id: op.request_id });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => {
  if (activeTurn && activeTurn.child) { try { activeTurn.child.kill('SIGTERM'); } catch {} }
  process.exit(0);
});
