#!/usr/bin/env node
/**
 * p3394-gateway — 给对端 Agent 装的 P3394 实现包。
 *
 * 装上即内建 P3394：收 envelope → 交给本机 Agent 的模型/CLI → 回 envelope。
 * CogSeed 内建 P3394，对端装上本包后两边直接互通，中间没有任何转接层。
 *
 * 两种运行模式（P3394_AGENT_MODE）：
 *   oneshot（默认）  每消息 spawn 一次 CLI；网关侧维护会话 transcript + 会话
 *                    工作区（in/out），跨轮保留上下文 —— 适合 hermes/claude/
 *                    codex 等 oneshot CLI。
 *   sscli            常驻单个 CLI 进程，按 p3394-sscli/1.0 JSONL 协议交换
 *                    hello/open_session/deliver/事件/cancel/heartbeat —— 适合
 *                    支持结构化会话协议的 Agent Runtime（指南 §9.2）。
 *
 * 会话连续性（两种模式通用）：
 *   - 同一 session_id 的多轮消息共享一个会话目录（transcript + 工作区）；
 *   - 入站 resource/artifact part（data URI + sha256 digest）落盘到会话
 *     workspace/in/，并把路径告诉 Agent；
 *   - Agent 运行期间写入 workspace/out/ 的文件随回复作为 resource part
 *     回传（digest 校验）——Artifact 端到端传递。
 *
 * 安装（对端机器上，一行）：
 *   npm install -g @cogseed/p3394-gateway
 * 启动（默认适配 Hermes）：
 *   COGSEED_ENDPOINT=http://127.0.0.1:8444 COGSEED_TOKEN=<token> p3394-gateway
 *
 * 配置（环境变量）：
 *   P3394_GATEWAY_PORT        监听端口（默认 9000）
 *   P3394_GATEWAY_TOKEN       本端入站鉴权（默认空 = 不鉴权，仅回环）
 *   P3394_GATEWAY_HOME        会话/工作区根目录（默认 ~/.p3394-gateway）
 *   COGSEED_ENDPOINT          回复发回的 CogSeed 端点（默认 http://127.0.0.1:8444）
 *   COGSEED_TOKEN             回发 CogSeed 的 Bearer 令牌
 *   P3394_ADVERTISE_ENDPOINT  向 CogSeed 自报的本端地址（默认 http://127.0.0.1:<port>）
 *   P3394_AGENT               预设名：hermes/claude/codex/opencode/gemini/aider/openclaw/workbuddy（默认 hermes）
 *   P3394_AGENT_ID            本节点的 agent_id（默认随预设）
 *   P3394_AGENT_ALIAS         本节点自报的显示名（默认空 = 用 agent_id）
 *   P3394_AGENT_MODE          oneshot（默认）| sscli
 *   P3394_AGENT_CLI           自定义 CLI（覆盖预设）
 *   P3394_AGENT_CLI_ARGS      CLI 参数模板，{message} 为消息占位（oneshot；覆盖预设）
 *   P3394_AGENT_TIMEOUT_MS    Agent 单次回答上限（默认 10 分钟）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.P3394_GATEWAY_PORT || 9000);
// ECS 跨机器：可绑定局域网地址（默认回环，安全优先）。
const GATEWAY_HOST = (process.env.P3394_GATEWAY_HOST || '127.0.0.1').trim();
const AUTH_TOKEN = (process.env.P3394_GATEWAY_TOKEN || '').trim();
const COGSEED_ENDPOINT = (process.env.COGSEED_ENDPOINT || 'http://127.0.0.1:8444').replace(/\/$/, '');
const COGSEED_TOKEN = (process.env.COGSEED_TOKEN || '').trim();
const GATEWAY_HOME = (process.env.P3394_GATEWAY_HOME || path.join(os.homedir(), '.p3394-gateway')).trim();
const isLoopbackHost = GATEWAY_HOST === '127.0.0.1' || GATEWAY_HOST === 'localhost' || GATEWAY_HOST === '::1';
const ADVERTISE_ENDPOINT = (process.env.P3394_ADVERTISE_ENDPOINT || 'http://' + (isLoopbackHost ? '127.0.0.1' : GATEWAY_HOST) + ':' + PORT).replace(/\/$/, '');
// ECS 心跳：定期向 CogSeed 报告在线（默认 60s；0 关闭）。
const HEARTBEAT_MS = Number(process.env.P3394_HEARTBEAT_MS ?? 60 * 1000);
// V-04 反向入口：P3394_SEND_TASK 非空时，启动后向 CogSeed 发起一次任务，
// 等待自动回发结果、打印后退出（Hermes → CogSeed → Hermes 闭环）。
const SEND_TASK = (process.env.P3394_SEND_TASK || '').trim();
const SEND_TASK_TIMEOUT_MS = Number(process.env.P3394_SEND_TASK_TIMEOUT_MS || 30 * 1000);
const replyWaiters = new Map(); // message_id → 处理回信的函数

// 预设：市面上常见智能体的 CLI 模板（oneshot 非交互模式，stdout 输出最终回复）。
const PRESETS = {
  hermes:   { cli: 'hermes',  args: '-z {message} --cli',       id: 'hermes' },
  claude:   { cli: 'claude',  args: '-p {message}',             id: 'claude' },
  codex:    { cli: 'codex',   args: 'exec {message}',           id: 'codex' },
  opencode: { cli: 'opencode', args: 'run {message}',           id: 'opencode' },
  gemini:   { cli: 'gemini',  args: '-p {message}',             id: 'gemini' },
  aider:    { cli: 'aider',   args: '--message {message} --yes', id: 'aider' },
  openclaw: { cli: 'openclaw', args: '-p {message}',            id: 'openclaw' },
  workbuddy: { cli: 'codebuddy', args: '-p {message}',          id: 'workbuddy' },
};
const PRESET_NAME = (process.env.P3394_AGENT || 'hermes').trim().toLowerCase();
const preset = PRESETS[PRESET_NAME] || null;
if (!preset) {
  console.error('[p3394-gateway] 未知 P3394_AGENT=' + PRESET_NAME + '，可用预设：' + Object.keys(PRESETS).join(', '));
  process.exit(2);
}
const AGENT_ID = (process.env.P3394_AGENT_ID || preset.id).trim();
const AGENT_ALIAS = (process.env.P3394_AGENT_ALIAS || '').trim();
const AGENT_MODE = (process.env.P3394_AGENT_MODE || 'oneshot').trim().toLowerCase();
if (AGENT_MODE !== 'oneshot' && AGENT_MODE !== 'sscli') {
  console.error('[p3394-gateway] 未知 P3394_AGENT_MODE=' + AGENT_MODE + '（oneshot | sscli）');
  process.exit(2);
}
const CLI = (process.env.P3394_AGENT_CLI || preset.cli).trim();
const CLI_ARGS = (process.env.P3394_AGENT_CLI_ARGS || preset.args).trim();
const TIMEOUT_MS = Number(process.env.P3394_AGENT_TIMEOUT_MS || 10 * 60 * 1000);
const NODE_KIND = (process.env.P3394_NODE_KIND || 'agent').trim();
if (!['agent', 'sub_agent', 'task_agent', 'capability', 'model_runtime'].includes(NODE_KIND)) {
  console.error('[p3394-gateway] P3394_NODE_KIND must be agent|sub_agent|task_agent|capability|model_runtime');
  process.exit(2);
}
const PROFILES = (process.env.P3394_PROFILES || 'p3394-session/1.0,p3394-artifact/1.0').split(',').map((s) => s.trim()).filter(Boolean);

const MANIFEST = {
  spec_version: 'p3394/1.0',
  identity: { agent_id: AGENT_ID, display_name: AGENT_ALIAS || AGENT_ID },
  runtime: { kind: 'in_process' },
  capability_profile: {
    agent_id: AGENT_ID,
    runtime_kind: 'cogseed-native',
    capabilities: ['handle_message', 'artifact.transfer'],
    supported_performatives: ['request', 'response', 'inform', 'cancel'],
    supports_streaming: AGENT_MODE === 'sscli',
    supports_artifacts: true,
  },
  conformance: {
    level: 'level-2-session-aware',
    registry: true,
    agent_home: true,
    runtime_adapter: true,
    capabilities: {
      sessions: true,
      artifacts: true,
      streaming: AGENT_MODE === 'sscli',
      cancellation: true,
      restart_recovery: true,
      multi_party_sessions: true,
      delegation: false,
      checkpoints: false,
      resource_policy: false,
    },
  },
};

// ── 幂等（LRU） ──
const IDEM_MAX = 256;
const processed = new Map();
function remember(key, value) {
  if (processed.has(key)) processed.delete(key);
  processed.set(key, value);
  if (processed.size > IDEM_MAX) {
    const oldest = processed.keys().next().value;
    processed.delete(oldest);
  }
}
const MAX_REPLY_BYTES = 100 * 1024;
const MAX_MESSAGE_LEN = 20000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 3;
const MAX_DECODE_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_TURNS = 8;
const TRANSCRIPT_BYTES = 16 * 1024;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function mimeFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  const map = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.html': 'text/html', '.py': 'text/x-python', '.js': 'text/javascript',
  };
  return map[ext] || 'application/octet-stream';
}

// ── 会话目录 / transcript / 工作区 ──
function sessionDir(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
  return path.join(GATEWAY_HOME, 'sessions', safe);
}
function workspaceDirs(sessionId) {
  const dir = sessionDir(sessionId);
  const inDir = path.join(dir, 'workspace', 'in');
  const outDir = path.join(dir, 'workspace', 'out');
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  return { dir, inDir, outDir };
}
function transcriptFile(sessionId) { return path.join(sessionDir(sessionId), 'transcript.jsonl'); }

function readTranscriptTail(sessionId) {
  const file = transcriptFile(sessionId);
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  const picked = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && picked.length < TRANSCRIPT_TURNS; i -= 1) {
    if (bytes + lines[i].length > TRANSCRIPT_BYTES) break;
    picked.unshift(lines[i]);
    bytes += lines[i].length;
  }
  return picked.join('\n');
}
function appendTranscript(sessionId, role, text) {
  const line = JSON.stringify({ at: new Date().toISOString(), role, text: String(text).slice(0, MAX_MESSAGE_LEN) });
  fs.appendFileSync(transcriptFile(sessionId), line + '\n');
}

// ── p3394-object 拉取（入站，§12 resource endpoint） ──
// 信封里的 resource part 若是 p3394-object URI（内容寻址引用），从发送方
// 的资源端点拉取原始字节并验证 digest。失败不阻塞消息处理。
function fetchObjectPart(digestRef, endpoint, token) {
  const digest = String(digestRef).toLowerCase().replace(/^sha256:/, '').replace(/^p3394-object:sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let url;
    try { url = new URL(endpoint.replace(/\/$/, '') + '/p3394/objects/' + digest); } catch { resolve(null); return; }
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ hostname: url.hostname, port: url.port ? Number(url.port) : 80, path: url.pathname, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { resolve(res.statusCode === 200 ? Buffer.concat(chunks) : null); });
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function fetchObjectParts(envelope, inDir) {
  const files = [];
  const parts = (envelope && envelope.payload && envelope.payload.parts) || [];
  const ext = (envelope && envelope.extensions) || {};
  const endpoint = (typeof ext.reply_endpoint === 'string' && ext.reply_endpoint) || COGSEED_ENDPOINT;
  if (!endpoint) return files;
  const token = typeof ext.reply_token === 'string' ? ext.reply_token : COGSEED_TOKEN;
  let index = 0;
  for (const part of parts) {
    if (part.type !== 'resource' && part.type !== 'artifact') continue;
    if (typeof part.uri !== 'string' || !part.uri.startsWith('p3394-object:')) continue;
    const digestRef = part.digest || part.uri;
    const content = await fetchObjectPart(digestRef, endpoint, token);
    if (!content || !content.length || content.length > MAX_DECODE_BYTES) {
      console.error('[p3394-gateway] object fetch failed: ' + (part.name || digestRef));
      continue;
    }
    const expected = String(digestRef).toLowerCase().replace(/^sha256:/, '').replace(/^p3394-object:sha256:/, '');
    if (/^[a-f0-9]{64}$/.test(expected) && sha256(content) !== expected) {
      console.error('[p3394-gateway] object digest mismatch, dropped');
      continue;
    }
    const declared = typeof part.name === 'string' && part.name.trim() ? part.name.trim() : '';
    const safe = (declared || 'p3394-artifact-' + (index + 1)).replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'p3394-artifact-' + (index + 1);
    const abs = path.join(inDir, safe);
    fs.writeFileSync(abs, content);
    files.push({ name: safe, path: abs, bytes: content.length });
    index += 1;
  }
  return files;
}

// ── Artifact 解码（入站）／收集（出站） ──
function decodeResourceParts(envelope, inDir) {
  const files = [];
  const parts = (envelope && envelope.payload && envelope.payload.parts) || [];
  let index = 0;
  for (const part of parts) {
    if (part.type !== 'resource' && part.type !== 'artifact') continue;
    if (typeof part.uri !== 'string' || !part.uri.startsWith('data:')) continue;
    const comma = part.uri.indexOf(',');
    if (comma < 0) continue;
    const meta = part.uri.slice(5, comma);
    const isB64 = /;base64$/i.test(meta);
    const payload = part.uri.slice(comma + 1);
    const content = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (!content.length || content.length > MAX_DECODE_BYTES) continue;
    if (part.digest) {
      const expected = String(part.digest).toLowerCase().replace(/^sha256:/, '');
      if (sha256(content) !== expected) {
        console.error('[p3394-gateway] artifact digest mismatch, dropped');
        continue;
      }
    }
    const declared = typeof part.name === 'string' && part.name.trim() ? part.name.trim() : '';
    const safe = (declared || 'p3394-artifact-' + (index + 1)).replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'p3394-artifact-' + (index + 1);
    const abs = path.join(inDir, safe);
    fs.writeFileSync(abs, content);
    files.push({ name: safe, path: abs, bytes: content.length });
    index += 1;
  }
  return files;
}

function collectOutParts(outDir, sinceMs) {
  const parts = [];
  let entries = [];
  try { entries = fs.readdirSync(outDir); } catch { return parts; }
  const files = entries
    .map((name) => path.join(outDir, name))
    .filter((abs) => { try { const st = fs.statSync(abs); return st.isFile() && st.mtimeMs >= sinceMs; } catch { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const abs of files.slice(0, MAX_ARTIFACT_FILES)) {
    try {
      const st = fs.statSync(abs);
      if (st.size === 0 || st.size > MAX_ARTIFACT_BYTES) continue;
      const content = fs.readFileSync(abs);
      const media = mimeFor(abs);
      parts.push({
        type: 'resource',
        uri: 'data:' + media + ';base64,' + content.toString('base64'),
        media_type: media,
        name: path.basename(abs),
        digest: sha256(content),
      });
    } catch { /* skip */ }
  }
  return parts;
}

function envelopeText(envelope) {
  const parts = (envelope && envelope.payload && envelope.payload.parts) || [];
  return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n').trim();
}

// ── oneshot 模式：每消息 spawn CLI（可取消） ──
const activeTasks = new Map(); // task_id → child
const cancelledTasks = new Set(); // task_id → 已被 cancel 控制帧终止
function runAgent(message, taskId) {
  return new Promise((resolve, reject) => {
    const args = CLI_ARGS.split(' ').map((part) => part.replace('{message}', message));
    const child = spawn(CLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (taskId) activeTasks.set(taskId, child);
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      if (taskId) activeTasks.delete(taskId);
      reject(new Error('p3394_agent_timeout'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { if (out.length < MAX_REPLY_BYTES * 4) out += chunk; });
    child.stderr.on('data', (chunk) => { if (errOut.length < 8 * 1024) errOut += chunk; });
    child.on('error', (error) => { clearTimeout(timer); if (taskId) activeTasks.delete(taskId); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (taskId) activeTasks.delete(taskId);
      if (code === 0) resolve(out.trim());
      else reject(new Error('agent exited ' + code + (errOut ? ': ' + errOut.slice(-300) : '')));
    });
  });
}

function cancelTask(taskId) {
  const child = activeTasks.get(taskId);
  if (!child) return false;
  cancelledTasks.add(taskId);
  child.kill('SIGTERM');
  activeTasks.delete(taskId);
  return true;
}

/** 引号感知的 argv 切分（sscli 模式的 CLI 参数可能含带空格的路径）。 */
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}

/** sscli 模式的 CLI 参数：整串是真实存在的脚本路径时按单参数处理（路径可含空格），
 *  否则按引号感知切分。 */
function sscliArgs() {
  const raw = String(CLI_ARGS || '').trim();
  if (!raw) return [];
  if (fs.existsSync(raw)) return [raw];
  return splitArgs(raw);
}

// ── sscli 模式：常驻 CLI，p3394-sscli/1.0 JSONL ──
/** Codex Desktop app-server adapter. The ChatGPT app ships this runtime and
 * uses the same CODEX_HOME as the visible Desktop conversations. */
const CODEX_APP_SERVER = process.env.P3394_CODEX_APP_SERVER || '/Applications/ChatGPT.app/Contents/Resources/codex';
class CodexAppServerRuntime {
  constructor() {
    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.threads = new Map();
    this.seq = 0;
  }
  _send(message) {
    if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  _request(method, params, timeoutMs = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('p3394_codex_app_server_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }
  _onLine(line) {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'p3394_codex_app_server_error'));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method === 'item/agentMessage/delta' && msg.params) {
      const entry = this.pending.get('turn:' + msg.params.threadId);
      if (entry) entry.deltas.push(msg.params.delta || '');
    }
    if (msg.method === 'turn/completed' && msg.params) {
      const key = 'turn:' + msg.params.threadId; const entry = this.pending.get(key);
      if (entry) { this.pending.delete(key); clearTimeout(entry.timer); entry.resolve(entry.deltas.join('')); }
    }
  }
  async start() {
    if (this.child) return;
    this.child = spawn(CODEX_APP_SERVER, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk.toString(); const lines = this.buf.split('\n'); this.buf = lines.pop();
      for (const line of lines) if (line.trim()) this._onLine(line.trim());
    });
    this.child.stderr.on('data', (chunk) => { if (String(chunk).includes('ERROR')) console.error('[p3394-gateway] codex app-server: ' + String(chunk).trim().slice(-500)); });
    this.child.on('close', () => { for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('p3394_codex_app_server_exited')); } this.pending.clear(); this.child = null; });
    await this._request('initialize', { clientInfo: { name: 'p3394-gateway', version: '1.0' }, capabilities: { experimentalApi: true } });
    this._send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }
  async deliver(sessionId, text, cwd) {
    await this.start();
    let threadId = this.threads.get(sessionId);
    if (!threadId) {
      const result = await this._request('thread/start', { cwd: cwd || null, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false });
      threadId = result && result.thread && result.thread.id;
      if (!threadId) throw new Error('p3394_codex_thread_start_failed');
      this.threads.set(sessionId, threadId);
    }
    const id = ++this.seq;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete('turn:' + threadId); reject(new Error('p3394_codex_turn_timeout')); }, TIMEOUT_MS);
      this.pending.set('turn:' + threadId, { resolve, reject, timer, deltas: [] });
    });
    this._send({ jsonrpc: '2.0', id, method: 'turn/start', params: { threadId, input: [{ type: 'text', text, text_elements: [] }] } });
    return promise;
  }
  cancel() { /* app-server cancellation is version-specific; process remains reusable */ }
  close() { if (this.child) { this.child.kill('SIGTERM'); this.child = null; } }
}
const codexAppServerRuntime = new CodexAppServerRuntime();

const SSCLI_PROTOCOL = 'p3394-sscli/1.0';
const SSCLI_HEARTBEAT_MS = 30 * 1000;
const SSCLI_HANDSHAKE_MS = 15 * 1000;

class SscliRuntime {
  constructor() {
    this.child = null;
    this.pending = new Map(); // request_id → {resolve, reject, deltas, timer}
    this.sessions = new Set();
    this.reqSeq = 0;
    this.lineBuf = '';
    this.heartbeatTimer = null;
    this.closing = false;
  }
  _nextReq() { this.reqSeq += 1; return 'req-' + this.reqSeq; }
  _send(op) { if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(op) + '\n'); }
  _request(op, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = op.request_id || this._nextReq();
      op.request_id = requestId;
      const entry = {
        resolve, reject,
        deltas: [],
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error('p3394_sscli_timeout'));
        }, timeoutMs),
      };
      this.pending.set(requestId, entry);
      this._send(op);
    });
  }
  _parseLine(line) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { return; }
    if (parsed.event && parsed.request_id) {
      const entry = this.pending.get(parsed.request_id);
      if (!entry) return;
      if (parsed.event === 'delta' && typeof parsed.text === 'string') entry.deltas.push(parsed.text);
      if (parsed.event === 'completed') {
        this.pending.delete(parsed.request_id);
        clearTimeout(entry.timer);
        entry.resolve(entry.deltas.join(''));
      } else if (parsed.event === 'failed') {
        this.pending.delete(parsed.request_id);
        clearTimeout(entry.timer);
        entry.reject(new Error(parsed.error || 'p3394_sscli_failed'));
      }
      return;
    }
    if (parsed.ok !== undefined && parsed.request_id) {
      const entry = this.pending.get(parsed.request_id);
      if (!entry) return;
      this.pending.delete(parsed.request_id);
      clearTimeout(entry.timer);
      if (parsed.ok === true) entry.resolve(parsed);
      else entry.reject(new Error(parsed.error || 'p3394_sscli_rejected'));
    }
  }
  _failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
  async start() {
    if (this.child) return;
    this.child = spawn(CLI, sscliArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lineBuf = '';
    let errLog = '';
    this.child.stdout.on('data', (chunk) => {
      this.lineBuf += chunk;
      const lines = this.lineBuf.split('\n');
      this.lineBuf = lines.pop();
      for (const line of lines) { if (line.trim()) this._parseLine(line.trim()); }
    });
    this.child.stderr.on('data', (chunk) => { if (errLog.length < 8 * 1024) errLog += chunk; });
    this.child.on('error', (error) => { this._failAll(error); this.child = null; });
    this.child.on('close', () => {
      this._failAll(new Error('p3394_sscli_exited' + (errLog ? ': ' + errLog.slice(-200) : '')));
      this.child = null;
      this.sessions.clear();
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    });
    await this._request({ op: 'hello', protocol: SSCLI_PROTOCOL }, SSCLI_HANDSHAKE_MS);
    this.heartbeatTimer = setInterval(() => {
      if (this.pending.size === 0 && this.child && this.child.stdin.writable) {
        this._send({ op: 'heartbeat', protocol: SSCLI_PROTOCOL });
      }
    }, SSCLI_HEARTBEAT_MS);
    this.heartbeatTimer.unref();
    console.log('[p3394-gateway] sscli runtime connected');
  }
  async openSession(sessionId, goal, workspace) {
    await this.start();
    if (this.sessions.has(sessionId)) return;
    await this._request({
      op: 'open_session',
      session_id: sessionId,
      goal: goal || 'p3394-collaboration',
      workspace,
    }, SSCLI_HANDSHAKE_MS);
    this.sessions.add(sessionId);
  }
  async deliver(sessionId, messageId, text) {
    await this.start();
    return this._request({
      op: 'deliver',
      session_id: sessionId,
      message: { message_id: messageId, payload: { parts: [{ type: 'text', text }] } },
    }, TIMEOUT_MS);
  }
  cancel(taskId) {
    if (!this.child) return;
    this._send({ op: 'cancel', task_id: taskId });
  }
  close() {
    this.closing = true;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.child) { this.child.kill('SIGTERM'); this.child = null; }
  }
}

const sscliRuntime = new SscliRuntime();

// ── 回复回发（可携带 resource parts） ──
function postReply(envelope, replyText, resourceParts) {
  const ext = (envelope && envelope.extensions) || {};
  const replyEndpoint = (typeof ext.reply_endpoint === 'string' && ext.reply_endpoint) || COGSEED_ENDPOINT;
  const replyToken = typeof ext.reply_token === 'string' ? ext.reply_token : COGSEED_TOKEN;
  const parts = [{ type: 'text', text: replyText }];
  for (const part of (resourceParts || [])) parts.push(part);
  const body = JSON.stringify({
    envelope: {
      spec_version: 'p3394/1.0',
      message_id: 'msg-reply-' + Date.now().toString(36),
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      kind: 'message',
      performative: 'inform',
      role: 'responder',
      sender: { agent_id: AGENT_ID, ...(AGENT_ALIAS ? { alias: AGENT_ALIAS } : {}) },
      recipients: [{ agent_id: (envelope.sender && envelope.sender.agent_id) || 'cogseed' }],
      payload: { parts },
      idempotency_key: 'idem-reply-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    },
  });
  const url = new URL(replyEndpoint.replace(/\/$/, '') + '/p3394/envelope');
  const headers = { 'Content-Type': 'application/json' };
  if (replyToken) headers.Authorization = 'Bearer ' + replyToken;
  let attempt = 0;
  const deliver = () => {
    attempt += 1;
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log('[p3394-gateway] reply delivered ' + res.statusCode);
      } else {
        console.error('[p3394-gateway] reply rejected ' + res.statusCode);
      }
    });
    req.on('error', (error) => {
      if (attempt < 2) { console.error('[p3394-gateway] reply failed, retrying: ' + error.message); setTimeout(deliver, 1500); }
      else console.error('[p3394-gateway] reply failed: ' + error.message);
    });
    req.end(body);
  };
  deliver();
}

// 串行队列：同一时刻只处理一条消息，避免并发锁/限流问题。
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** 取消控制帧（guide §9.2）：绕过串行队列，立即终止运行中的任务。 */
function handleCancel(envelope) {
  const taskId = envelope.task_id;
  if (!taskId) {
    postReply(envelope, '[已取消]');
    return;
  }
  const killed = cancelTask(taskId);
  sscliRuntime.cancel(taskId);
  console.log('[p3394-gateway] cancel task ' + taskId + (killed ? ' (killed)' : ' (nothing running)'));
  postReply(envelope, '[已取消]');
}

async function handleEnvelope(envelope) {
  const idem = envelope.idempotency_key;
  if (idem && processed.has(idem)) {
    console.log('[p3394-gateway] duplicate skipped ' + idem);
    postReply(envelope, processed.get(idem));
    return;
  }
  const text = envelopeText(envelope).slice(0, MAX_MESSAGE_LEN);
  if (!text) {
    postReply(envelope, '（空消息）');
    return;
  }
  console.log('[p3394-gateway] received from ' + (envelope.sender && envelope.sender.agent_id) + ': ' + text.slice(0, 120));
  const sessionId = String(envelope.session_id || '');
  const { inDir, outDir, dir } = workspaceDirs(sessionId);
  const runStartedAt = Date.now();

  // 入站附件落盘 + 提示路径（data URI 内联 + p3394-object 拉取）
  const inFiles = decodeResourceParts(envelope, inDir);
  try {
    const fetched = await fetchObjectParts(envelope, inDir);
    for (const file of fetched) inFiles.push(file);
  } catch (error) {
    console.error('[p3394-gateway] object parts failed: ' + (error && error.message ? error.message : String(error)));
  }
  let artifactNote = '';
  if (inFiles.length) {
    artifactNote = '\n\n[附件已保存到会话工作区，路径如下]\n' + inFiles.map((file) => '- ' + file.path).join('\n');
  }

  try {
    let rawReply;
    if (PRESET_NAME === 'codex') {
      rawReply = await codexAppServerRuntime.deliver(sessionId, text + artifactNote, dir);
    } else if (AGENT_MODE === 'sscli') {
      const goal = envelope.payload && envelope.payload.metadata && typeof envelope.payload.metadata.goal === 'string'
        ? envelope.payload.metadata.goal
        : '';
      await sscliRuntime.openSession(sessionId, goal, dir);
      rawReply = await sscliRuntime.deliver(sessionId, envelope.message_id, text + artifactNote);
    } else {
      const transcript = readTranscriptTail(sessionId);
      const prompt = (transcript ? '[会话历史]\n' + transcript + '\n\n' : '') + text + artifactNote;
      rawReply = await runAgent(prompt, envelope.task_id);
    }
    const reply = rawReply.length > MAX_REPLY_BYTES ? rawReply.slice(0, MAX_REPLY_BYTES) + '\n[输出过长已截断]' : rawReply;
    // 会话连续性：落盘 transcript
    if (AGENT_MODE !== 'sscli' || PRESET_NAME === 'codex') {
      appendTranscript(sessionId, 'in', text);
      appendTranscript(sessionId, 'out', reply);
    }
    // Agent 运行期间写入 workspace/out/ 的文件 → 随回复回传（Artifact 端到端）
    const outParts = collectOutParts(outDir, runStartedAt);
    if (outParts.length) console.log('[p3394-gateway] attaching ' + outParts.length + ' artifact(s) to reply');
    if (idem) remember(idem, reply);
    console.log('[p3394-gateway] agent replied ' + reply.slice(0, 120));
    postReply(envelope, reply, outParts);
  } catch (error) {
    // 已被 cancel 控制帧终止的任务：取消回执已发，不再补发错误回信。
    if (envelope.task_id && cancelledTasks.has(envelope.task_id)) {
      cancelledTasks.delete(envelope.task_id);
      return;
    }
    postReply(envelope, '[p3394_gateway_error] ' + (error && error.message ? error.message : String(error)));
  }
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/p3394/manifest')) {
    json(res, 200, { ok: true, manifest: MANIFEST });
    return;
  }
  if (req.url && req.url.startsWith('/p3394/health')) {
    json(res, 200, { ok: true, agent_id: AGENT_ID });
    return;
  }
  if (req.url && req.url.startsWith('/p3394/envelope') && req.method === 'POST') {
    if (AUTH_TOKEN) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + AUTH_TOKEN) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let envelope = null;
      try {
        const parsed = JSON.parse(body);
        envelope = (parsed && parsed.envelope) || null;
      } catch {
        /* fallthrough */
      }
      if (!envelope || !envelope.message_id || !envelope.session_id || !envelope.idempotency_key) {
        json(res, 422, { ok: false, error: 'invalid_envelope' });
        return;
      }
      json(res, 200, { ok: true, message_id: envelope.message_id });
      // V-04 反向闭环：本端发起的任务回信（reply_to 命中 waiter）直接交给
      // 等待方，不进入 CLI 执行路径。
      if (envelope.reply_to && replyWaiters.has(envelope.reply_to)) {
        const waiter = replyWaiters.get(envelope.reply_to);
        replyWaiters.delete(envelope.reply_to);
        waiter(envelope);
        return;
      }
      // cancel 控制帧必须绕过串行队列立即处理，否则会被正在运行的长任务阻塞。
      if (envelope.kind === 'control' && envelope.performative === 'cancel') {
        handleCancel(envelope);
        return;
      }
      void enqueue(() => handleEnvelope(envelope));
    });
    return;
  }
  json(res, 404, { ok: false, error: 'not_found' });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('[p3394-gateway] shutting down (' + signal + ')');
    sscliRuntime.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}

server.listen(PORT, GATEWAY_HOST, () => {
  console.log('[p3394-gateway] ' + AGENT_ID + ' P3394 endpoint on http://' + (isLoopbackHost ? '127.0.0.1' : GATEWAY_HOST) + ':' + PORT + ' · mode: ' + AGENT_MODE);
  console.log('[p3394-gateway] replies to ' + COGSEED_ENDPOINT + ' · preset: ' + PRESET_NAME + (PRESET_NAME === 'codex' ? ' · runtime: Codex Desktop app-server (' + CODEX_APP_SERVER + ')' : ' · CLI: ' + CLI + ' ' + CLI_ARGS));
  registerWithCogseed();
  if (SEND_TASK) sendTaskOneShot(SEND_TASK);
  if (HEARTBEAT_MS > 0) {
    const timer = setInterval(sendHeartbeat, HEARTBEAT_MS);
    timer.unref();
  }
});

/**
 * V-04 反向闭环：本网关（对端 Agent）主动向 CogSeed 发起一次任务，
 * 信封携带本端 reply_endpoint/reply_token；CogSeed 执行完自动回发结果，
 * 网关命中 waiter 后打印回复并退出。
 */
function sendTaskOneShot(text) {
  const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const task = {
    spec_version: 'p3394/1.0',
    message_id: 'msg-task-' + nonce,
    session_id: 'ses-task-' + nonce,
    task_id: 'tsk-' + nonce,
    kind: 'task',
    performative: 'request',
    sender: { agent_id: AGENT_ID, ...(AGENT_ALIAS ? { alias: AGENT_ALIAS } : {}) },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: text.slice(0, MAX_MESSAGE_LEN) }], metadata: { goal: text.slice(0, 200) } },
    extensions: { reply_endpoint: ADVERTISE_ENDPOINT, reply_token: AUTH_TOKEN },
    idempotency_key: 'idem-task-' + nonce,
  };
  replyWaiters.set(task.message_id, (reply) => {
    const replyText = envelopeText(reply);
    console.log('[p3394-gateway] task reply from ' + (reply.sender && reply.sender.agent_id) + ': ' + replyText.slice(0, 120));
    process.stdout.write(replyText + '\n');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[p3394-gateway] send-task timeout waiting for reply');
    process.exit(1);
  }, SEND_TASK_TIMEOUT_MS);
  const url = new URL(COGSEED_ENDPOINT + '/p3394/envelope');
  const headers = { 'Content-Type': 'application/json' };
  if (COGSEED_TOKEN) headers.Authorization = 'Bearer ' + COGSEED_TOKEN;
  const body = JSON.stringify({ envelope: task });
  const req = http.request(url, { method: 'POST', headers }, (res) => {
    res.resume();
    if (!(res.statusCode >= 200 && res.statusCode < 300)) {
      console.error('[p3394-gateway] send-task rejected ' + res.statusCode);
      process.exit(1);
    }
  });
  req.on('error', (error) => {
    console.error('[p3394-gateway] send-task failed: ' + error.message);
    process.exit(1);
  });
  req.end(body);
}

/** ECS 心跳：轻量 control 信封（inform），刷新 CogSeed 注册表里的 last_seen。 */
function sendHeartbeat() {
  if (!COGSEED_ENDPOINT) return;
  const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const beat = {
    spec_version: 'p3394/1.0',
    message_id: 'msg-heartbeat-' + nonce,
    session_id: 'ses-heartbeat-' + nonce,
    kind: 'control',
    performative: 'inform',
    sender: { agent_id: AGENT_ID, ...(AGENT_ALIAS ? { alias: AGENT_ALIAS } : {}) },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: '' }], metadata: { heartbeat: true } },
    extensions: {
      endpoints: [ADVERTISE_ENDPOINT],
      capabilities: MANIFEST.capability_profile.capabilities,
      locality: 'same_host',
      node_kind: NODE_KIND,
      supported_profiles: PROFILES,
    },
    idempotency_key: 'idem-heartbeat-' + nonce,
  };
  const url = new URL(COGSEED_ENDPOINT.replace(/\/$/, '') + '/p3394/envelope');
  const headers = { 'Content-Type': 'application/json' };
  if (COGSEED_TOKEN) headers.Authorization = 'Bearer ' + COGSEED_TOKEN;
  const req = http.request(url, { method: 'POST', headers }, (res) => { res.resume(); });
  req.on('error', () => { /* CogSeed 离线：下一拍重试即可 */ });
  req.end(JSON.stringify({ envelope: beat }));
}

/** 启动即注册：向 CogSeed 发一个 hello 信封，自报 agent_id / 显示名 / 本端
 *  地址 / 能力 —— CogSeed 收到后自动把本节点注册进 P3394 注册表（含 endpoint
 *  与 capabilities），之后即可被 CogSeed 主动调用（p3394_send）。幂等：重复
 *  启动只重发一次 hello。 */
function registerWithCogseed() {
  if (!COGSEED_ENDPOINT) return;
  const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const hello = {
    spec_version: 'p3394/1.0',
    message_id: 'msg-hello-' + nonce,
    session_id: 'ses-hello-' + nonce,
    kind: 'control',
    performative: 'request',
    sender: { agent_id: AGENT_ID, ...(AGENT_ALIAS ? { alias: AGENT_ALIAS } : {}) },
    recipients: [{ agent_id: 'cogseed' }],
    payload: { parts: [{ type: 'text', text: '' }], metadata: { registration: true } },
    extensions: {
      endpoints: [ADVERTISE_ENDPOINT],
      capabilities: MANIFEST.capability_profile.capabilities,
      locality: 'same_host',
      node_kind: NODE_KIND,
      supported_profiles: PROFILES,
    },
    idempotency_key: 'idem-hello-' + nonce,
  };
  const url = new URL(COGSEED_ENDPOINT.replace(/\/$/, '') + '/p3394/envelope');
  const headers = { 'Content-Type': 'application/json' };
  if (COGSEED_TOKEN) headers.Authorization = 'Bearer ' + COGSEED_TOKEN;
  const req = http.request(url, { method: 'POST', headers }, (res) => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    console.log('[p3394-gateway] registered with CogSeed: ' + res.statusCode + (ok ? ' (ok)' : ''));
    res.resume();
  });
  req.on('error', (error) => {
    console.log('[p3394-gateway] registration hello failed (CogSeed offline?): ' + error.message);
  });
  req.end(JSON.stringify({ envelope: hello }));
}
