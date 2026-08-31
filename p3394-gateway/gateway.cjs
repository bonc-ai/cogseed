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
 *                    codex 等 oneshot CLI。oneshot 同样增量回发：CLI 运行过程
 *                    中印到 stdout/stderr 的可见输出会实时以 stream delta 帧
 *                    发回 CogSeed（气泡随之增长），不必等工具+回复全部跑完。
 *                    openclaw 预设整体排除（无中间分片，其最终 JSON 回复信封
 *                    写在 stderr 末尾），保持一次性回发。
 *                    `P3394_DISABLE_ONESHOT_STREAM=1` 可整体关闭。
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
 * 安装/获取（对端机器上；本地优先，有就直接用、不要从 NPM 拉）：
 *   1) 已全局安装过：command -v p3394-gateway 有输出 → 直接用 p3394-gateway；
 *   2) CogSeed 自带副本（CogSeed 桌面版内置此包，无需 NPM）：
 *      开发仓库 <仓库根>/p3394-gateway/gateway.cjs；
 *      macOS 已安装应用
 *      /Applications/CogSeed*.app/Contents/Resources/app.asar.unpacked/p3394-gateway/gateway.cjs；
 *      Windows <安装目录>/resources/app.asar.unpacked/p3394-gateway/gateway.cjs；
 *      找到后 node <该路径> 启动即等同于装了包；
 *   3) 以上都没有才：npm install -g @cogseed/p3394-gateway（发布中，失败回退 2）。
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
 *   P3394_AGENT               智能体名：内置预设（hermes/claude/codex/opencode/
 *                              gemini/aider/openclaw/workbuddy）或任意名字
 *                              （未知名默认：身份=名字、CLI=同名命令、
 *                              参数={message}，复杂参数用 P3394_AGENT_CLI_ARGS）
 *   P3394_AGENT_ID            本节点的 agent_id（默认随预设）
 *   P3394_AGENT_ALIAS         本节点自报的显示名（默认空 = 用 agent_id）
 *   P3394_AGENT_MODE          oneshot（默认）| sscli
 *   P3394_AGENT_CLI           自定义 CLI（覆盖预设）
 *   P3394_AGENT_CLI_ARGS      CLI 参数模板，{message} 为消息占位（oneshot；覆盖预设）
 *   P3394_AGENT_TIMEOUT_MS    Agent 单次回答上限（默认 10 分钟）
 *   P3394_DISABLE_ONESHOT_STREAM  1 关闭 oneshot 模式增量输出回发（默认开启）
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.P3394_GATEWAY_PORT || 9000);
// 跨机器：可绑定局域网地址（默认回环，安全优先）。
const GATEWAY_HOST = (process.env.P3394_GATEWAY_HOST || '127.0.0.1').trim();
const AUTH_TOKEN = (process.env.P3394_GATEWAY_TOKEN || '').trim();
const COGSEED_ENDPOINT = (process.env.COGSEED_ENDPOINT || 'http://127.0.0.1:8444').replace(/\/$/, '');
const COGSEED_TOKEN = (process.env.COGSEED_TOKEN || '').trim();
const GATEWAY_HOME = (process.env.P3394_GATEWAY_HOME || path.join(os.homedir(), '.p3394-gateway')).trim();
const isLoopbackHost = GATEWAY_HOST === '127.0.0.1' || GATEWAY_HOST === 'localhost' || GATEWAY_HOST === '::1';
const ADVERTISE_ENDPOINT = (process.env.P3394_ADVERTISE_ENDPOINT || 'http://' + (isLoopbackHost ? '127.0.0.1' : GATEWAY_HOST) + ':' + PORT).replace(/\/$/, '');
// 心跳：定期向 CogSeed 报告在线（默认 60s；0 关闭）。
const HEARTBEAT_MS = Number(process.env.P3394_HEARTBEAT_MS ?? 60 * 1000);
// V-04 反向入口：P3394_SEND_TASK 非空时，启动后向 CogSeed 发起一次任务，
// 等待自动回发结果、打印后退出（Hermes → CogSeed → Hermes 闭环）。
const SEND_TASK = (process.env.P3394_SEND_TASK || '').trim();
const SEND_TASK_TIMEOUT_MS = Number(process.env.P3394_SEND_TASK_TIMEOUT_MS || 30 * 1000);
// Peer call 本地路由：等待 CogSeed 转发 + 目标回复回发的总时限（默认 3 分钟）。
const PEER_CALL_TIMEOUT_MS = Number(process.env.P3394_PEER_CALL_TIMEOUT_MS || 3 * 60 * 1000);
// H-04：运行中 CLI 的 peer 转调提示（P3394 外接智能体互调）。**绝不把
// AUTH_TOKEN 拼进 prompt**——token 会进 Agent 模型上下文 / transcript /
// 进程命令行。回环模式 /p3394/call 免鉴权（本机父子进程），非回环绑定
// 已由下方启动门强制要求 token。
const PEER_CALL_HINT = COGSEED_ENDPOINT
  ? '\n\n[P3394 协作工具] 你可以调用本机 P3394 桥转调其他已接入智能体（如另一个代码智能体）帮你分担子任务。用法：curl -s -X POST http://127.0.0.1:' + PORT + '/p3394/call -H "Content-Type: application/json" -d \'{"peer":"<节点id>","message":"<子任务描述>"}\'，响应里的 reply 字段即对方回复。若网关配置了鉴权令牌请向使用者索取并在 Authorization 头附带；回环模式下可省略。仅在确有需要时使用，并保持回复简洁。'
  : '';
// 入站信封/调用请求体上限（M-01）：JSON 缓冲上限，超限 413。
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
// 流式帧回发通道的有界性（回发侧，与入站 413 对称）：
//   STREAM_POST_TIMEOUT_MS    单帧 POST 请求超时——对端不响应（半开/事件循环
//                             卡死）时不能把终态回复一起拖死（handleEnvelope
//                             会 await stream.finish()）。
//   STREAM_FINISH_DEADLINE_MS finish() 对整条 delta 链的整体截止——delta 是
//                             best-effort，异常慢时让位给终态回发。
//   STREAM_TOTAL_CAP_CHARS    整条消息累计可回发的增量字符上限——失控的常驻
//                             sscli/codex 刷屏时截断帧流（oneshot 侧另有
//                             STREAM_CAP_CHARS 双保险）。
const STREAM_POST_TIMEOUT_MS = Number(process.env.P3394_STREAM_POST_TIMEOUT_MS || 15 * 1000);
const STREAM_FINISH_DEADLINE_MS = Number(process.env.P3394_STREAM_FINISH_DEADLINE_MS || 30 * 1000);
const STREAM_TOTAL_CAP_CHARS = 512 * 1024;
// 其余出站 HTTP（终态回发 / peer-call 转发 / 注册 / 心跳 / 反向任务）的统一
// 请求超时：对端不响应时 socket 必须被销毁（触发 error → 现有重试/告警路径），
// 不能无限挂起泄漏连接。
const OUTBOUND_HTTP_TIMEOUT_MS = 15 * 1000;
// H-03 fail-closed：绑定非回环接口时必须在启动前配置入站鉴权令牌，
// 否则任意内网主机都能无密码调用本网关（命令/数据面全暴露）。
if (!isLoopbackHost && !AUTH_TOKEN) {
  console.error('[p3394-gateway] 绑定到非回环地址（GATEWAY_HOST=' + GATEWAY_HOST + '）必须配置 P3394_GATEWAY_TOKEN —— 拒绝以无鉴权方式暴露内部接口。');
  process.exit(2);
}

/**
 * SSRF 收口（H-01）：入站信封的 reply_endpoint 是对端可控的，直接用于
 * 回发/对象拉取会诱导本网关向任意地址 POST 结果或 GET 对象（数据外泄）。
 * 只信任：回环地址，或用户显式配置的受信端点（COGSEED_ENDPOINT）。
 * 其它声明一律拒绝并回退到配置端点。
 */
function isLoopbackUrl(urlString) {
  let parsed = null;
  try { parsed = new URL(urlString); } catch { return false; }
  let host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // 规范化 IPv4-mapped / IPv6 组合回环。注意 Node 的 URL 对 IPv4-mapped
  // 可能编码成 ::ffff:7f00:1（十六进制）而非 ::ffff:127.0.0.1（点分）。
  if (host.startsWith('::ffff:')) {
    const ip4 = host.slice('::ffff:'.length);
    const dot = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip4);
    if (dot && dot.slice(1).every((s) => Number(s) >= 0 && Number(s) <= 255)) return Number(dot[1]) === 127;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip4);
    if (hex) return (parseInt(hex[1], 16) >> 8) === 127;
    return false;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host === 'localhost') return true;
  const ipv4Segs = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Segs && ipv4Segs.slice(1).every((s) => Number(s) >= 0 && Number(s) <= 255)) {
    return Number(ipv4Segs[1]) === 127; // 127.0.0.0/8 loopback
  }
  return false;
}
function trustedReplyEndpoint(declared) {
  const d = (declared && typeof declared === 'string' && declared.trim()) || '';
  if (!d) return COGSEED_ENDPOINT;
  if (isLoopbackUrl(d) || d === COGSEED_ENDPOINT) return d;
  console.warn('[p3394-gateway] 拒绝非回环/非受信 reply_endpoint: ' + d);
  return COGSEED_ENDPOINT;
}
/** H-01 配套：reply_endpoint 与 reply_token 是**一对**对端声明的回发凭据。
 * 端点声明不可信被回退到配置端点时，声明的 token 必须一并丢弃（改用
 * COGSEED_TOKEN）——否则会把对端提供的 token 打到受信端点上：受信端点按
 * 配置 token 鉴权时全部 401 拒绝，合法回复被无声丢弃。端点受信（回环/等于
 * 配置端点）时 token 才跟随声明（零配置回发场景）。 */
function trustedReplyTarget(declaredEndpoint, declaredToken) {
  const d = (declaredEndpoint && typeof declaredEndpoint === 'string' && declaredEndpoint.trim()) || '';
  const endpoint = trustedReplyEndpoint(d) || COGSEED_ENDPOINT;
  const declaredTrusted = Boolean(d) && (isLoopbackUrl(d) || d === COGSEED_ENDPOINT);
  return {
    endpoint,
    token: declaredTrusted ? (typeof declaredToken === 'string' ? declaredToken : COGSEED_TOKEN) : COGSEED_TOKEN,
  };
}
// V-04 断线重试：发送失败（连接拒绝/非 2xx）按退避重试，默认 2 次额外尝试。
const SEND_TASK_RETRIES = Math.max(1, Number(process.env.P3394_SEND_TASK_RETRIES || 2));
const replyWaiters = new Map(); // message_id → 处理回信的函数

// 预设：市面上常见智能体的 CLI 模板（oneshot 非交互模式，stdout 输出最终回复）。
// 预设只是便捷模板，不是接入白名单——任何 P3394_AGENT 名字都可启动，
// 未知名默认：身份=名字、CLI=同名命令、参数={message}（见下方解析逻辑）。
const PRESETS = {
  hermes:   { cli: 'hermes',  args: '-z {message} --cli',       id: 'hermes' },
  // claude 声明 stream-json 输出（sscli 主导下的流式包装器）：-p 配合
  // --verbose --output-format stream-json --include-partial-messages 才真正
  // 逐 token 出 content_block_delta 帧（缺 --include-partial-messages 时 claude
  // 只在结束前整段收口，包装器无增量可流）。短答也可能只有 assistant 帧。
  claude:   { cli: 'claude',  args: '-p {message}',             id: 'claude', streamJson: true, streamJsonArgs: '--verbose --output-format stream-json --include-partial-messages' },
  codex:    { cli: 'codex',   args: 'exec {message}',           id: 'codex' },
  opencode: { cli: 'opencode', args: 'run {message}',           id: 'opencode' },
  gemini:   { cli: 'gemini',  args: '-p {message}',             id: 'gemini' },
  aider:    { cli: 'aider',   args: '--message {message} --yes', id: 'aider' },
  openclaw: { cli: 'openclaw', args: 'agent --local --json --agent main --message {message}', id: 'openclaw' },
  workbuddy: { cli: 'codebuddy', args: '-p {message}',          id: 'workbuddy' },
};
const PRESET_NAME = (process.env.P3394_AGENT || 'hermes').trim().toLowerCase();
// 预设只是便捷模板，不是白名单：P3394 面向任意智能体/任意程序，任何名字
// 都可接入。未知名字的默认语义：身份 = 该名字；CLI = 同名命令；
// 参数 = 把消息作为唯一参数（复杂参数用 P3394_AGENT_CLI_ARGS 自定义）。
const preset = PRESETS[PRESET_NAME] || null;
const AGENT_ID = (process.env.P3394_AGENT_ID || (preset ? preset.id : PRESET_NAME)).trim();
const AGENT_ALIAS = (process.env.P3394_AGENT_ALIAS || '').trim();
const AGENT_MODE = (process.env.P3394_AGENT_MODE || 'oneshot').trim().toLowerCase();
if (AGENT_MODE !== 'oneshot' && AGENT_MODE !== 'sscli') {
  console.error('[p3394-gateway] 未知 P3394_AGENT_MODE=' + AGENT_MODE + '（oneshot | sscli）');
  process.exit(2);
}
const CLI = (process.env.P3394_AGENT_CLI || (preset ? preset.cli : PRESET_NAME)).trim();
const CLI_ARGS = (process.env.P3394_AGENT_CLI_ARGS || (preset ? preset.args : '{message}')).trim();
const TIMEOUT_MS = Number(process.env.P3394_AGENT_TIMEOUT_MS || 10 * 60 * 1000);
const NODE_KIND = (process.env.P3394_NODE_KIND || 'agent').trim();
if (!['agent', 'sub_agent', 'task_agent', 'capability', 'model_runtime'].includes(NODE_KIND)) {
  console.error('[p3394-gateway] P3394_NODE_KIND must be agent|sub_agent|task_agent|capability|model_runtime');
  process.exit(2);
}
const PROFILES = (process.env.P3394_PROFILES || 'p3394-session/1.0,p3394-artifact/1.0').split(',').map((s) => s.trim()).filter(Boolean);

// oneshot 模式的增量输出：CLI 运行过程中印出的可见输出实时回发为 stream delta
// 帧（CogSeed 气泡随之增长），不必等工具+回复全部跑完。openclaw 特殊处理：
// 它不以增量方式在 stdout 输出（stdout 为空），正文只能等其末尾的 JSON 回复
// 信封一次性落地；但其 stderr 里的 [skills]/[tools] 过程日志（工具调用等）
// 逐行实时回发为 stream progress 帧，让 CogSeed 的 process rail 能看到协作
// 过程，而不是 17 秒一片空白。最终 JSON 信封本身不转发（它是回复正文来源，
// 灌进气泡会污染正文）。其余预设转发 stdout+stderr 为 delta。
// P3394_DISABLE_ONESHOT_STREAM=1 整体关闭。
const ONESHOT_STREAM = String(process.env.P3394_DISABLE_ONESHOT_STREAM || '').trim() !== '1';
const ONESHOT_STREAM_CHILD = ONESHOT_STREAM && PRESET_NAME !== 'openclaw';
const MANIFEST_STREAMING = AGENT_MODE === 'sscli' || PRESET_NAME === 'codex' || ONESHOT_STREAM_CHILD || PRESET_NAME === 'openclaw';

const MANIFEST = {
  spec_version: 'p3394/1.0',
  identity: { agent_id: AGENT_ID, display_name: AGENT_ALIAS || AGENT_ID },
  runtime: { kind: 'in_process' },
  capability_profile: {
    agent_id: AGENT_ID,
    runtime_kind: 'cogseed-native',
    capabilities: ['handle_message', 'artifact.transfer'],
    supported_performatives: ['request', 'response', 'inform', 'cancel'],
    supports_streaming: MANIFEST_STREAMING,
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
      streaming: MANIFEST_STREAMING,
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

function pathWithinRoot(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

function configuredWorkingDirRoots() {
  return String(process.env.P3394_GATEWAY_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
}

/** Resolve the requested CLI cwd without changing the gateway-owned session
 * workspace used for attachments, transcripts, and returned artifacts. */
function resolveEnvelopeWorkingDir(envelope, fallback) {
  const ext = envelope && envelope.extensions;
  const raw = ext && ext.working_dir;
  if (raw === undefined) return fallback;
  const claimedToken = ext && typeof ext.reply_token === 'string' ? ext.reply_token : '';
  const trustedToken = COGSEED_TOKEN && claimedToken
    && Buffer.byteLength(COGSEED_TOKEN) === Buffer.byteLength(claimedToken)
    && crypto.timingSafeEqual(Buffer.from(COGSEED_TOKEN), Buffer.from(claimedToken));
  if (!trustedToken) throw new Error('working_dir_requires_trusted_sender');
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('invalid_working_dir');
  if (!path.isAbsolute(raw.trim())) throw new Error('working_dir_must_be_absolute');
  const requested = path.resolve(raw.trim());
  if (requested === path.parse(requested).root) throw new Error('working_dir_root_forbidden');
  const roots = configuredWorkingDirRoots();
  if (roots.length && !roots.some((root) => pathWithinRoot(requested, root))) {
    throw new Error('working_dir_outside_allowed_roots');
  }
  fs.mkdirSync(requested, { recursive: true });
  if (!fs.statSync(requested).isDirectory()) throw new Error('working_dir_not_directory');
  return requested;
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
  const file = transcriptFile(sessionId);
  fs.appendFileSync(file, line + '\n');
  // 只追加永不截断会让长会话的 transcript.jsonl 无限增长。超过上限后
  // 重写为仅保留最近 N 轮的头（读取侧本来就是按轮/字节截尾，重写无损）。
  try {
    if (fs.statSync(file).size > TRANSCRIPT_BYTES * 64) {
      const kept = readTranscriptTail(sessionId);
      fs.writeFileSync(file, (kept ? kept + '\n' : '') + line + '\n');
    }
  } catch { /* best effort */ }
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
    req.setTimeout(OUTBOUND_HTTP_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function fetchObjectParts(envelope, inDir) {
  const files = [];
  const parts = (envelope && envelope.payload && envelope.payload.parts) || [];
  const ext = (envelope && envelope.extensions) || {};
  // H-01：对象拉取端点同样走受信端点解析（回环/COGSEED_ENDPOINT），
  // 防止诱导本网关向任意内部/外部地址 GET。token 与端点成对回退（声明
  // 端点不可信时声明的 token 一并丢弃，改用配置 token）。
  const { endpoint, token } = trustedReplyTarget(ext.reply_endpoint, ext.reply_token);
  if (!endpoint) return files;
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

/** 把 CLI 运行中的原始字节转成可安全进气泡的可见文本：剥 ANSI 转义序列（颜色/
 *  光标/清屏/OSC 超链），去掉 NUL 等裸控制字符（保留 \n \t \r），并吞掉
 *  `\r` 前的前一屏进度串（\r 回写作覆盖型进度时只留下一段）。 */
function sanitizeStreamText(raw) {
  let s = String(raw || '');
  // ANSI CSI：ESC [ 参数? 中间字节 最终字节
  s = s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
  // ANSI OSC（ESC ] ... BEL / ESC \）：超链接/标题
  s = s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
  // 其余裸控制字符（保留常见空白 \t \n \r）
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  // 覆盖型进度（foo\rbar）→ 保留最后一段，避免气泡里堆满中间进度
  s = s.replace(/[^\r\n]*\r(?!\n)/g, '');
  return s;
}

// ── oneshot 模式：每消息 spawn CLI（可取消） ──

// ── CogSeed 扩展：extensions.execution_prefs（单轮执行偏好透传） ──
// CogSeed 主机可按轮次携带 { reasoning_effort }（low|high）。旧版宿主不发
// 该字段 → undefined，行为与既往完全一致；未知/白名单外的值一律视为"跟随
// CLI 自身默认"。仅 claude 系 runtime 消费（MAX_THINKING_TOKENS env）；其他
// CLI 无已知开关，prefs 被安全忽略。档位→token 预算为启发式映射，与 CogSeed
// 本地直连 backend 保持同一份取值。
const EXEC_EFFORT_TOKENS = { low: '8192', high: '32000' };
function executionPrefsFor(envelope) {
  const ext = (envelope && envelope.extensions) || {};
  const prefs = ext.execution_prefs;
  if (!prefs || typeof prefs !== 'object') return null;
  const effort = typeof prefs.reasoning_effort === 'string' ? prefs.reasoning_effort.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(EXEC_EFFORT_TOKENS, effort)) return null;
  return { maxThinkingTokens: EXEC_EFFORT_TOKENS[effort] };
}

const activeTasks = new Map(); // task_id → child
const cancelledTasks = new Set(); // task_id → 已被 cancel 控制帧终止
function runAgent(message, taskId, cwd, onStream, onProgress) {
  return new Promise((resolve, reject) => {
    const args = CLI_ARGS.split(' ').map((part) => part.replace('{message}', message));
    const child = spawn(CLI, args, { cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    if (taskId) activeTasks.set(taskId, child);
    let out = '';
    let errOut = '';
    let streamedChars = 0;
    // 增量回发上限：防止 CLI 疯狂刷屏把每条 chunk 都堆进增量帧（合并器本身
    // ~80ms/512 字符限速，这里再加一个总量保护；收取 out 不受影响）。
    const STREAM_CAP_CHARS = 256 * 1024;
    const forwardStream = (chunkStr) => {
      if (!onStream) return;
      if (streamedChars >= STREAM_CAP_CHARS) return;
      const visible = sanitizeStreamText(chunkStr);
      if (!visible) return;
      streamedChars += visible.length;
      onStream(visible);
    };
    // openclaw --json：正文一次性出（末尾 JSON 信封），过程日志在 stderr。
    // 把非 JSON 信封的 stderr 行逐行回发为 progress（process rail 可见工具
    // 调用），进入 pretty-printed JSON 回复信封块（trim 后以 `{` 开头）后
    // 停止转发，直到 `}` 结尾的行把信封收尾——JSON 是回复正文来源，不能灌进
    // 气泡。行可能跨 chunk，用残行缓冲拼接。
    let ocPendingLine = '';
    let ocJsonDepth = 0;
    const forwardOpenclawProgress = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      if (ocJsonDepth > 0) {
        if (/}\s*$/.test(trimmed)) ocJsonDepth = 0;
        return;
      }
      if (trimmed.startsWith('{')) { ocJsonDepth = 1; return; }
      if (!onProgress) return;
      if (streamedChars >= STREAM_CAP_CHARS) return;
      const visible = sanitizeStreamText(line);
      if (!visible) return;
      streamedChars += visible.length;
      onProgress(visible);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      if (taskId) activeTasks.delete(taskId);
      reject(new Error('p3394_agent_timeout'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { if (out.length < MAX_REPLY_BYTES * 4) out += chunk; if (ONESHOT_STREAM_CHILD) forwardStream(chunk.toString('utf8')); });
    child.stderr.on('data', (chunk) => {
      if (errOut.length < 8 * 1024) errOut += chunk;
      if (PRESET_NAME === 'openclaw') {
        ocPendingLine += chunk.toString('utf8');
        const lines = ocPendingLine.split(/\r?\n/);
        ocPendingLine = lines.pop() || '';
        for (const line of lines) forwardOpenclawProgress(line);
      } else if (ONESHOT_STREAM_CHILD) {
        forwardStream(chunk.toString('utf8'));
      }
    });
    child.on('error', (error) => { clearTimeout(timer); if (taskId) activeTasks.delete(taskId); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (taskId) activeTasks.delete(taskId);
      if (code === 0) resolve(extractReplyText(out, PRESET_NAME));
      else reject(new Error('agent exited ' + code + (errOut ? ': ' + sanitizeStreamText(errOut.slice(-300)) : '')));
    });
  });
}

/** openclaw --json 模式的输出是 JSON 信封；提取其中的可见回复文本。
 *  优先 finalAssistantVisibleText（冒烟实测字段），再退 JSON 字段或原样。 */
function extractReplyText(out, preset) {
  const text = String(out || '').trim();
  if (!text || preset !== 'openclaw') return text;
  const visible = /"finalAssistantVisibleText"\s*:\s*"([^"]*)"/.exec(text);
  if (visible && visible[1]) return visible[1].replace(/\\n/g, '\n');
  try {
    const parsed = JSON.parse(text);
    const pick = [
      parsed.finalAssistantVisibleText,
      parsed.text,
      parsed.result && parsed.result.text,
      Array.isArray(parsed.payloads) && parsed.payloads[0] && parsed.payloads[0].text,
    ].find((v) => typeof v === 'string' && v.trim());
    if (pick) return pick.trim();
  } catch { /* not a single JSON object — return raw */ }
  return text;
}

function cancelTask(taskId) {
  const child = activeTasks.get(taskId);
  if (!child) return false;
  cancelledTasks.add(taskId);
  child.kill('SIGTERM');
  activeTasks.delete(taskId);
  return true;
}

// ── oneshot 后端（万能兜底）：任何 CLI，只要 `{message}` 参数模板就能跑 ──
// 会话连续性由网关侧 transcript 承担（跨轮回放 + 落盘），无需 agent 握手。
// 在与 sscli 统一的后端接口下，这是"无协议 agent"的默认落点。
const oneshotRuntime = {
  name: 'oneshot',
  async openSession() { /* transcript 负责连续性，无需握手 */ },
  async deliver(sessionId, messageId, text, opts, onDelta, onProgress) {
    const note = (opts && opts.artifactNote) || '';
    const hint = (opts && opts.peerCallHint) || '';
    const transcript = readTranscriptTail(sessionId);
    const prompt = (transcript ? '[会话历史]\n' + transcript + '\n\n' : '') + text + note + hint;
    // 注册可取消键用 task_id（cancel 控制帧按 task_id 匹配）；无 task_id 时
    // 回退到 message_id，保证单消息用例仍可取消。
    const cancelKey = (opts && opts.taskId) || messageId;
    const rawReply = await runAgent(prompt, cancelKey, opts && opts.cwd, onDelta, onProgress);
    const reply = rawReply.length > MAX_REPLY_BYTES ? rawReply.slice(0, MAX_REPLY_BYTES) + '\n[输出过长已截断]' : rawReply;
    appendTranscript(sessionId, 'in', text);
    appendTranscript(sessionId, 'out', reply);
    return reply;
  },
  cancel(taskId) { return cancelTask(taskId); },
  close() {
    for (const child of activeTasks.values()) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    activeTasks.clear();
  },
};


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
    this.activeTurns = new Map(); // task_id（无则 message_id）→ { threadId }
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
    if (msg.method === 'turn/completed' && msg.params) {
      const key = 'turn:' + msg.params.threadId; const entry = this.pending.get(key);
      if (entry) {
        this.pending.delete(key);
        clearTimeout(entry.timer);
        const turn = msg.params.turn || {};
        if (turn.status === 'failed' || turn.status === 'interrupted') {
          entry.reject(new Error((turn.error && turn.error.message) || ('p3394_codex_turn_' + turn.status)));
        } else {
          const itemReply = Array.isArray(turn.items)
            ? turn.items.filter((item) => item && item.type === 'agentMessage' && typeof item.text === 'string').map((item) => item.text).join('')
            : '';
          entry.resolve(entry.deltas.join('') || itemReply);
        }
      }
      return;
    }
    const entry = msg.params && msg.params.threadId ? this._touchTurn(msg.params.threadId) : null;
    if (msg.method === 'item/agentMessage/delta' && msg.params) {
      if (entry) {
        const delta = msg.params.delta || '';
        entry.deltas.push(delta);
        entry.onDelta?.(delta);
      }
    }
    if (entry && (msg.method === 'item/started' || msg.method === 'item/completed')) {
      const itemType = msg.params.item && msg.params.item.type ? String(msg.params.item.type) : 'work';
      this._emitProgress(entry, '[Codex] ' + itemType + (msg.method === 'item/started' ? ' started' : ' completed'));
    } else if (entry && (msg.method === 'item/commandExecution/outputDelta' || msg.method === 'item/mcpToolCall/progress')) {
      this._emitProgress(entry, '[Codex] working');
    }
  }
  _touchTurn(threadId) {
    const key = 'turn:' + threadId;
    const entry = this.pending.get(key);
    if (!entry) return null;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.pending.get(key) !== entry) return;
      this.pending.delete(key);
      this.activeTurns.delete(entry.cancelKey);
      entry.reject(new Error('p3394_codex_turn_timeout'));
    }, TIMEOUT_MS);
    return entry;
  }
  _emitProgress(entry, text) {
    const now = Date.now();
    if (!entry.onProgress || (entry.lastProgressAt && now - entry.lastProgressAt < 15 * 1000)) return;
    entry.lastProgressAt = now;
    entry.onProgress(text);
  }
  async start() {
    if (this.child) return;
    // 并发去重：预热（server.listen 回调）与首轮 deliver 可能同时触发
    // start()，没有这层会让同一个 gateway 双 spawn 两个 app-server。
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._doStart().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }
  async _doStart() {
    if (this.child) return;
    // spawn 失败（app-server 二进制缺失等）必须处理 'error' 事件：不监听
    // 会让 gateway 进程直接崩（uncaught 'error'），而且 initialize 会挂到
    // TIMEOUT_MS 才失败。这里快速失败并清空状态，deliver 侧拿到明确错误。
    let spawnError = null;
    this.child = spawn(CODEX_APP_SERVER, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (error) => {
      spawnError = error;
      this._failPending(new Error('p3394_codex_app_server_spawn_failed: ' + error.message));
      this.child = null;
    });
    this.child.stdout.on('data', (chunk) => {
      this.buf += chunk.toString(); const lines = this.buf.split('\n'); this.buf = lines.pop();
      for (const line of lines) if (line.trim()) this._onLine(line.trim());
    });
    this.child.stderr.on('data', (chunk) => { if (String(chunk).includes('ERROR')) console.error('[p3394-gateway] codex app-server: ' + String(chunk).trim().slice(-500)); });
    this.child.on('close', () => { this._failPending(new Error('p3394_codex_app_server_exited')); this.child = null; });
    await this._request('initialize', { clientInfo: { name: 'p3394-gateway', version: '1.0' }, capabilities: { experimentalApi: true } });
    if (spawnError) throw spawnError;
    this._send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  }
  _failPending(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.activeTurns.clear();
  }
  get name() { return 'codex'; }
  async openSession() { /* codex 的 thread 在 deliver 里惰性创建 */ }
  async deliver(sessionId, messageId, text, opts, onDelta, onProgress) {
    const note = (opts && opts.artifactNote) || '';
    const hint = (opts && opts.peerCallHint) || '';
    const cwd = (opts && opts.cwd) || null;
    await this.start();
    let threadId = this.threads.get(sessionId);
    if (!threadId) {
      const result = await this._request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: false });
      threadId = result && result.thread && result.thread.id;
      if (!threadId) throw new Error('p3394_codex_thread_start_failed');
      this.threads.set(sessionId, threadId);
    }
    // 可取消键与其余 runtime 一致：task_id 优先（cancel 控制帧按 task_id
    // 匹配），无 task_id 回退 message_id。
    const cancelKey = (opts && opts.taskId) || messageId;
    const promise = new Promise((resolve, reject) => {
      // 包装 resolve/reject 以便 turn 结束时同步摘除 activeTurns 登记。
      this.pending.set('turn:' + threadId, {
        resolve: (value) => { this.activeTurns.delete(cancelKey); resolve(value); },
        reject: (error) => { this.activeTurns.delete(cancelKey); reject(error); },
        timer: null,
        deltas: [],
        onDelta,
        onProgress,
        cancelKey,
        lastProgressAt: 0,
      });
      this._touchTurn(threadId);
    });
    this.activeTurns.set(cancelKey, { threadId });
    try {
      await this._request('turn/start', { threadId, input: [{ type: 'text', text: text + note + hint, text_elements: [] }] });
    } catch (error) {
      const entry = this.pending.get('turn:' + threadId);
      if (entry) {
        this.pending.delete('turn:' + threadId);
        clearTimeout(entry.timer);
        entry.reject(error);
      }
    }
    return promise;
  }
  /** 终止在途 turn（app-server v2 协议 turn/interrupt）。不 kill 共享的
   *  app-server 进程——进程保持可复用，只中断目标线程的在途 turn。 */
  cancel(taskId) {
    const entry = this.activeTurns.get(taskId);
    if (!entry) return false;
    this.activeTurns.delete(taskId);
    // 先摘掉本端 pending 的 turn 等待：随后的 turn/completed 无 entry 会被
    // 忽略，避免中断后 partial deltas 被当作正常回复回发。
    const pendingEntry = this.pending.get('turn:' + entry.threadId);
    if (pendingEntry) {
      clearTimeout(pendingEntry.timer);
      this.pending.delete('turn:' + entry.threadId);
      pendingEntry.reject(new Error('p3394_codex_turn_cancelled'));
    }
    try {
      this._send({ jsonrpc: '2.0', method: 'turn/interrupt', params: { threadId: entry.threadId } });
    } catch { /* best effort */ }
    return true;
  }
  close() {
    this.activeTurns.clear();
    if (this.child) { this.child.kill('SIGTERM'); this.child = null; }
  }
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
  get name() { return 'sscli'; }
  _nextReq() { this.reqSeq += 1; return 'req-' + this.reqSeq; }
  _send(op) { if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(op) + '\n'); }
  _request(op, timeoutMs, onDelta) {
    return new Promise((resolve, reject) => {
      const requestId = op.request_id || this._nextReq();
      op.request_id = requestId;
      const entry = {
        resolve, reject,
        deltas: [],
        onDelta,
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
      if (parsed.event === 'delta' && typeof parsed.text === 'string') {
        entry.deltas.push(parsed.text);
        entry.onDelta?.(parsed.text);
      }
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
  async deliver(sessionId, messageId, text, opts, onDelta) {
    const note = (opts && opts.artifactNote) || '';
    const hint = (opts && opts.peerCallHint) || '';
    await this.start();
    return this._request({
      op: 'deliver',
      session_id: sessionId,
      message: { message_id: messageId, payload: { parts: [{ type: 'text', text: text + note + hint }] } },
    }, TIMEOUT_MS, onDelta);
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

// ── Stream-json 后端（sscli 主导下的"流式包装器"）─────────────────────
// 对支持 `--output-format stream-json` 的 CLI（claude -p 等），把 JSONL
// 事件流实时转成与 sscli 相同的 delta 帧喂给网关统一入口：不协商协议，
// 有 content_block_delta 就逐 token 增量，最终以 assistant 完整帧/累积文本
// 收尾。与原生 sscli 常驻进程共用完全相同的下游（createStreamEmitter →
// postStreamEvent）与超时/取消语义。这是让"sscli 主导"落到真实智能体上
// 的通用适配器；新增带 stream-json 的 CLI 只需在 PRESETS 里声明。
const STREAM_JSON_TIMEOUT_MS = Number(process.env.P3394_STREAM_JSON_TIMEOUT_MS || TIMEOUT_MS);

class StreamJsonRuntime {
  constructor() { this.active = new Map(); } // task_id → child（无 task_id 回退 message_id）
  get name() { return 'stream-json'; }
  async openSession() { /* 每次 deliver 独立 spawn 该回调 CLI，无需握手 */ }
  async deliver(sessionId, messageId, text, opts, onDelta) {
    const note = (opts && opts.artifactNote) || '';
    const hint = (opts && opts.peerCallHint) || '';
    // 与 oneshot 一致：回放会话历史，保证跨轮上下文（-p 每次调用是独立的，
    // 不带 [会话历史] 会让 claude 每轮失忆）。
    const transcript = readTranscriptTail(sessionId);
    const prompt = (transcript ? '[会话历史]\n' + transcript + '\n\n' : '') + text + note + hint;
    const args = [...CLI_ARGS.split(' ').map((part) => (part === '{message}' ? prompt : part)), ...((preset && preset.streamJsonArgs) ? preset.streamJsonArgs.split(' ').filter(Boolean) : [])];
    // CogSeed 扩展：单轮推理强度 → MAX_THINKING_TOKENS（无 prefs 时保持
    // CLI 自身默认）。
    const thinkingEnv = (opts && opts.execPrefs) ? { MAX_THINKING_TOKENS: opts.execPrefs.maxThinkingTokens } : null;
    // 可取消键用 task_id（handleCancel 按 task_id 匹配）；无 task_id 回退 message_id。
    const cancelKey = (opts && opts.taskId) || messageId;
    return new Promise((resolve, reject) => {
      const child = spawn(CLI, args, { cwd: (opts && opts.cwd) || undefined, env: thinkingEnv ? Object.assign({}, process.env, thinkingEnv) : undefined, stdio: ['ignore', 'pipe', 'pipe'] });
      this.active.set(cancelKey, child);
      let lineBuf = '';
      let accumulated = '';
      let finished = false;
      let stderrLog = '';
      const finish = (error) => {
        if (finished) return;
        finished = true;
        this.active.delete(cancelKey);
        if (error) reject(error); else {
          // 落盘 transcript（与 oneshot 同构），供跨轮回放。
          appendTranscript(sessionId, 'in', text);
          appendTranscript(sessionId, 'out', accumulated.trim());
          resolve(accumulated.trim());
        }
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
        finish(new Error('p3394_stream_json_timeout'));
      }, STREAM_JSON_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => {
        lineBuf += chunk.toString('utf8');
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const result = this._parseLine(line, onDelta, (t) => { accumulated += t; }, () => accumulated);
          if (result === 'done') {
            clearTimeout(timer);
            finish();
            return;
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderrLog.length < 8 * 1024) stderrLog += chunk;
        const visible = sanitizeStreamText(chunk.toString('utf8'));
        if (visible) onDelta && onDelta(visible); // 进度/stderr 也实时可见
      });
      child.on('error', (error) => { clearTimeout(timer); finish(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (!finished) {
          if (code !== 0) finish(new Error('agent exited ' + code + (stderrLog ? ': ' + sanitizeStreamText(stderrLog.slice(-300)) : '')));
          else finish(); // 进程正常退出，无显式终帧 → 以累积文本收尾
        }
      });
    });
  }
  /** 解析一行 stream-json 事件：text_delta → 逐 token 增量；assistant 完整帧
   *  作为终态（仅在无 delta 累积时以其全文本收尾，避免与已累积的 delta 重复）。
   *  返回 'delta' | 'done' | null。 */
  _parseLine(line, onDelta, append, getAccumulated) {
    let ev;
    try { ev = JSON.parse(line); } catch { return null; }
    if (ev && ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta'
      && ev.event.delta && typeof ev.event.delta.text === 'string') {
      const t = ev.event.delta.text;
      if (t) { append(t); onDelta && onDelta(t); }
      return 'delta';
    }
    if (ev && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      const full = ev.message.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
      if (full && !(getAccumulated && getAccumulated())) append(full);
      return 'done'; // 终态帧（claude stream-json：assistant 后仅余 result）
    }
    return null;
  }
  cancel(taskId) {
    const child = this.active.get(taskId);
    if (!child) return false;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    this.active.delete(taskId);
    return true;
  }
  close() {
    for (const child of this.active.values()) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    this.active.clear();
  }
}
const streamJsonRuntime = new StreamJsonRuntime();

// ── claude stream-json 常驻模式 ─────────────────────────────────────
// claude 支持 `--input-format stream-json` 双工流式：一个常驻进程经 stdin
// 收 user 消息、stdout 推 stream-json 事件，进程内自动延续同一 session 的
// 上下文。相比每轮 spawn（实测 TTFB 8-12s，CLI 启动占大头），常驻化把
// 启动成本摊到整个会话生命周期，热态每轮只剩 LLM 首 token。
// 每个 P3394 session 一个 claude 进程（进程级隔离，避免多会话上下文
// 串扰——resume 切换实测不可靠），空闲回收；gateway 重启后该 session 的
// 首轮用 transcript 重建上下文（与每轮 spawn 语义一致，不丢历史）。
// COGSEED_P3394_CLAUDE_PERSISTENT=0 可整体回退到每轮 spawn。
const CLAUDE_PERSISTENT_ENABLED = String(process.env.COGSEED_P3394_CLAUDE_PERSISTENT ?? '1').trim() !== '0';
const CLAUDE_IDLE_RECLAIM_MS = Number(process.env.P3394_CLAUDE_IDLE_RECLAIM_MS || 10 * 60 * 1000);

class ClaudePersistentRuntime {
  constructor() {
    this.sessions = new Map(); // p3394 sessionId → { child, buf, turn, idleTimer }
    this.turnKeys = new Map(); // cancelKey(task_id) → sessionId
  }
  get name() { return 'claude-persistent'; }
  async openSession() { /* 常驻进程在 deliver 时惰性 spawn */ }

  _args() {
    // CLI_ARGS（'-p {message}'）去掉 {message} 占位，追加双工流式参数。
    // streamJsonArgs 已含 --output-format stream-json（claude preset），
    // 缺失时才补，避免重复参数。
    const base = CLI_ARGS.split(' ').map((part) => part.trim()).filter((part) => part && part !== '{message}');
    const extra = (preset && preset.streamJsonArgs) ? preset.streamJsonArgs.split(' ').filter(Boolean) : [];
    const hasOutputFormat = extra.some((part) => part === '--output-format');
    return [...base, '--input-format', 'stream-json', ...(hasOutputFormat ? [] : ['--output-format', 'stream-json']), ...extra];
  }

  _spawn(sessionId, cwd, maxThinkingTokens) {
    const entry = { sessionId, cwd, child: null, buf: '', turn: null, idleTimer: null, maxThinkingTokens: maxThinkingTokens || null };
    // CogSeed 扩展：单轮偏好随进程固化（MAX_THINKING_TOKENS 是进程级 env）。
    const childEnv = maxThinkingTokens ? Object.assign({}, process.env, { MAX_THINKING_TOKENS: maxThinkingTokens }) : undefined;
    const child = spawn(CLI, this._args(), { cwd: cwd || undefined, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    entry.child = child;
    let stderrLog = '';
    child.stderr.on('data', (chunk) => {
      // 常驻进程的 stderr 是 claude 的 ERROR/MCP 日志，转发进气泡会污染正文
      // （工具调用的过程可见性由 stdout 的 stream_event 事件承担），只收集。
      if (stderrLog.length < 8 * 1024) stderrLog += chunk;
    });
    child.stdout.on('data', (chunk) => {
      entry.buf += chunk.toString('utf8');
      const lines = entry.buf.split('\n');
      entry.buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        this._onLine(entry, line);
      }
    });
    child.on('error', (error) => {
      const turn = entry.turn;
      entry.turn = null;
      if (turn) { clearTimeout(turn.timer); turn.reject(new Error('p3394_claude_spawn_failed: ' + error.message)); }
    });
    child.on('close', (code) => {
      const turn = entry.turn;
      entry.turn = null;
      if (turn) {
        clearTimeout(turn.timer);
        turn.reject(new Error('agent exited ' + code + (stderrLog ? ': ' + sanitizeStreamText(stderrLog.slice(-300)) : '')));
      }
      this._dropSession(sessionId);
    });
    this.sessions.set(sessionId, entry);
    return entry;
  }

  /** 解析一行 stream-json 事件。常驻模式与每轮 spawn 的差异：assistant
   *  完整帧不代表轮结束（工具调用后会有多段），以 result 事件收尾。 */
  _onLine(entry, line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!entry.turn) return; // 无在途轮次的事件（如并发残留）一律忽略
    const turn = entry.turn;
    if (ev && ev.type === 'stream_event' && ev.event && ev.event.type === 'content_block_delta'
      && ev.event.delta && typeof ev.event.delta.text === 'string') {
      const t = ev.event.delta.text;
      if (t) {
        turn.accumulated += t;
        turn.onDelta && turn.onDelta(t);
      }
      return;
    }
    if (ev && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      // 完整 assistant 帧：仅在无 delta 累积时作为终态文本回退（claude 短答
      // 可能只有这一帧没有 content_block_delta）。
      const full = ev.message.content
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('');
      if (full) turn.lastAssistantText = full;
      return;
    }
    if (ev && ev.type === 'result') {
      clearTimeout(turn.timer);
      entry.turn = null;
      this._armIdleReclaim(entry.sessionId, entry);
      if (ev.is_error) turn.reject(new Error(ev.error || 'p3394_claude_turn_failed'));
      else turn.resolve((turn.accumulated || turn.lastAssistantText || '').trim());
    }
  }

  _armIdleReclaim(sessionId, entry) {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      // 空闲回收：无在途轮次且超时 → 关进程释放内存（下次 deliver 重建）。
      if (!entry.turn) {
        try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
        this._dropSession(sessionId);
      }
    }, CLAUDE_IDLE_RECLAIM_MS);
    entry.idleTimer.unref();
  }

  _dropSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    for (const [key, sid] of this.turnKeys) {
      if (sid === sessionId) this.turnKeys.delete(key);
    }
  }

  async deliver(sessionId, messageId, text, opts, onDelta) {
    const note = (opts && opts.artifactNote) || '';
    const hint = (opts && opts.peerCallHint) || '';
    const cancelKey = (opts && opts.taskId) || messageId;
    const cwd = (opts && opts.cwd) || process.cwd();
    // 本轮的推理强度预算：与常驻进程已固化值不同时必须重启进程（env 是
    // spawn 时定死的，进程活着改不了）；重启后首轮由 transcript 恢复上下文。
    // 在途轮次不可杀——旧配置跑完当轮，下一轮 deliver 再对齐。
    const wantThinking = (opts && opts.execPrefs) ? opts.execPrefs.maxThinkingTokens : null;
    let entry = this.sessions.get(sessionId);
    if (entry && entry.maxThinkingTokens !== (wantThinking || null) && !entry.turn) {
      try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
      this._dropSession(sessionId);
      entry = null;
    }
    const fresh = !entry || entry.child.exitCode !== null || !entry.child.stdin.writable;
    if (fresh) {
      // 新进程（首次/上次进程已退出/被取消）：首轮回放 transcript，保证
      // 跨 gateway 重启与进程重建后的上下文不丢（常驻进程内后续轮自动延续）。
      entry = this._spawn(sessionId, cwd, wantThinking);
    } else if (entry.cwd !== cwd) {
      throw new Error('p3394_session_cwd_conflict');
    }
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    const transcript = readTranscriptTail(sessionId);
    const prompt = (fresh && transcript ? '[会话历史]\n' + transcript + '\n\n' : '') + text + note + hint;
    this.turnKeys.set(cancelKey, sessionId);
    return new Promise((resolve, reject) => {
      entry.turn = {
        resolve: (value) => { this.turnKeys.delete(cancelKey); resolve(value); },
        reject: (error) => { this.turnKeys.delete(cancelKey); reject(error); },
        timer: setTimeout(() => {
          // 超时：挂死的轮次不能占着常驻进程，立即丢弃该会话并杀掉进程重建
          // （上下文由 transcript 恢复）。不依赖 close 事件：否则窗口期内
          // 下一次 deliver 可能复用濒死的进程写 stdin。
          const turn = entry.turn;
          entry.turn = null;
          this.turnKeys.delete(cancelKey);
          try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
          this._dropSession(sessionId);
          reject(new Error('p3394_claude_timeout'));
        }, STREAM_JSON_TIMEOUT_MS),
        accumulated: '',
        lastAssistantText: '',
        onDelta,
      };
      try {
        entry.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
      } catch (error) {
        clearTimeout(entry.turn.timer);
        entry.turn = null;
        this.turnKeys.delete(cancelKey);
        reject(new Error('p3394_claude_write_failed: ' + (error && error.message ? error.message : String(error))));
      }
    });
  }
  cancel(taskId) {
    const sessionId = this.turnKeys.get(taskId);
    if (!sessionId) return false;
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.turnKeys.delete(taskId);
    // 必须 reject 挂起的 turn：否则 handleEnvelope 的 deliver promise 永不
    // settle，gateway 的串行队列（enqueue）会被这个挂起任务永久卡死，后续
    // 所有消息都不再执行。错误回信由 handleCancel 的 cancelledTasks 抑制。
    if (entry.turn) {
      clearTimeout(entry.turn.timer);
      const turn = entry.turn;
      entry.turn = null;
      turn.reject(new Error('p3394_claude_cancelled'));
    }
    // 取消 = 终止该 session 的常驻进程：claude stream-json 无 interrupt
    // 输入，kill 最可靠；下一轮 deliver 重新 spawn（首轮带 transcript）。
    try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
    this._dropSession(sessionId);
    return true;
  }
  close() {
    for (const entry of this.sessions.values()) {
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      if (entry.turn) { clearTimeout(entry.turn.timer); entry.turn = null; }
      try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.sessions.clear();
    this.turnKeys.clear();
  }
}
const claudePersistentRuntime = new ClaudePersistentRuntime();

/** 运行时后端选择 —— sscli 主导：显式声明 sscli 的 agent 优先走
 *  p3394-sscli/1.0 常驻协议（原生 delta 流式）；声明了 stream-json 输出且
 *  未原生讲协议的 CLI（如 claude -p）走流式包装器（同一 sscli 语义）；
 *  codex 走其专有 app-server JSON-RPC；其余任何 CLI 落到 oneshot 万能兜底
 *  （{message} 模板 + 网关 transcript 连续性）。统一 deliver 接口让新增后端
 *  只是在这里多注册一个分支。 */
function runtimeFor() {
  if (AGENT_MODE === 'sscli') {
    if (preset && preset.streamJson) {
      // claude 常驻双工流式（默认开；COGSEED_P3394_CLAUDE_PERSISTENT=0
      // 回退到每轮 spawn 的 stream-json 包装器）。
      if (PRESET_NAME === 'claude' && CLAUDE_PERSISTENT_ENABLED) return claudePersistentRuntime;
      return streamJsonRuntime;
    }
    return sscliRuntime;
  }
  if (PRESET_NAME === 'codex') return codexAppServerRuntime;
  return oneshotRuntime;
}

// ── 回复回发（可携带 resource parts） ──
function postReply(envelope, replyText, resourceParts) {
  const ext = (envelope && envelope.extensions) || {};
  // H-01：回发端点只信任回环/受信配置（COGSEED_ENDPOINT），防止诱导本网关
  // 把任务结果 POST 到任意第三方地址（数据外泄）。token 与端点成对回退。
  const { endpoint: replyEndpoint, token: replyToken } = trustedReplyTarget(ext.reply_endpoint, ext.reply_token);
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
      reply_to: envelope.message_id,
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
    // 请求必须有界：对端不响应时销毁 socket（触发 error → 重试/告警），
    // 否则挂起的连接既不重试也不释放。
    req.setTimeout(OUTBOUND_HTTP_TIMEOUT_MS, () => req.destroy());
    req.on('error', (error) => {
      if (attempt < 2) { console.error('[p3394-gateway] reply failed, retrying: ' + error.message); setTimeout(deliver, 1500); }
      else console.error('[p3394-gateway] reply failed: ' + error.message);
    });
    req.end(body);
  };
  deliver();
}

/** Sends a best-effort incremental reply. Stream frames are deliberately
 * separate event envelopes so the terminal reply remains the only frame that
 * resolves the outbound request. */
function postStreamEvent(envelope, text, sequence, kind) {
  const ext = (envelope && envelope.extensions) || {};
  // H-01：流式帧回发与终态回发（postReply）同规则——只信任回环/受信配置
  // （COGSEED_ENDPOINT）。对端可控的 reply_endpoint 若不校验，攻击者发一条
  // 入站信封即可让本网关把运行中的增量输出（现代 CLI 流式输出即回复全文，
  // 可能含敏感内容）POST 到任意第三方地址 —— SSRF + 数据外泄。token 与端点
  // 成对回退：声明端点不可信时一并丢弃声明的 token。
  const { endpoint: replyEndpoint, token: replyToken } = trustedReplyTarget(ext.reply_endpoint, ext.reply_token);
  const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const body = JSON.stringify({
    envelope: {
      spec_version: 'p3394/1.0',
      message_id: 'msg-stream-' + nonce,
      session_id: envelope.session_id,
      task_id: envelope.task_id,
      kind: 'event',
      performative: 'inform',
      role: 'responder',
      sender: { agent_id: AGENT_ID, ...(AGENT_ALIAS ? { alias: AGENT_ALIAS } : {}) },
      recipients: [{ agent_id: (envelope.sender && envelope.sender.agent_id) || 'cogseed' }],
      reply_to: envelope.message_id,
      payload: {
        parts: [{ type: 'text', text }],
        metadata: { stream_event: kind || 'delta', stream_seq: sequence, stream_source_message_id: envelope.message_id },
      },
      idempotency_key: 'idem-stream-' + nonce,
    },
  });
  const url = new URL(replyEndpoint.replace(/\/$/, '') + '/p3394/envelope');
  const headers = { 'Content-Type': 'application/json' };
  if (replyToken) headers.Authorization = 'Bearer ' + replyToken;
  return new Promise((resolve) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error('[p3394-gateway] stream event rejected ' + res.statusCode);
        }
        resolve();
      });
    });
    // 回发通道必须有界：对端不响应（连接建立后挂起）时不能无限等待——
    // handleEnvelope 会 await stream.finish()，帧卡死会连带阻塞终态回发。
    req.setTimeout(STREAM_POST_TIMEOUT_MS, () => {
      req.destroy();
      resolve();
    });
    req.on('error', (error) => {
      console.error('[p3394-gateway] stream event failed: ' + error.message);
      resolve();
    });
    req.end(body);
  });
}

/** Coalesces token deltas to avoid one HTTP request per token while keeping
 * the visible response live (roughly 12 updates/second at most). */
function createStreamEmitter(envelope) {
  let buffer = '';
  let progressBuffer = '';
  let sequence = 0;
  let timer = null;
  let progressTimer = null;
  let streamedChars = 0;
  let chain = Promise.resolve();
  const flush = (kind) => {
    const text = kind === 'progress' ? progressBuffer : buffer;
    if (!text) return;
    if (kind === 'progress') progressBuffer = '';
    else buffer = '';
    sequence += 1;
    chain = chain.then(() => postStreamEvent(envelope, text, sequence, kind));
  };
  const armFlush = (kind) => {
    const isProgress = kind === 'progress';
    const length = isProgress ? progressBuffer.length : buffer.length;
    if (length >= 512) {
      if (isProgress) { if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; } }
      else { if (timer) { clearTimeout(timer); timer = null; } }
      flush(kind);
    } else if (isProgress ? !progressTimer : !timer) {
      const t = setTimeout(() => { if (isProgress) progressTimer = null; else timer = null; flush(kind); }, 80);
      t.unref();
      if (isProgress) progressTimer = t;
      else timer = t;
    }
  };
  return {
    push(text) {
      if (typeof text !== 'string' || !text) return;
      // 总量上限：失控/异常的常驻 CLI（sscli/codex）无限刷 delta 时截断帧流，
      // 而不是无限向回发端点 POST（oneshot 侧 runAgent 另有 256KB 双保险）。
      if (streamedChars >= STREAM_TOTAL_CAP_CHARS) return;
      streamedChars += text.length;
      buffer += text;
      armFlush('delta');
    },
    // openclaw 过程日志（[skills]/[tools] 等）→ progress 帧，process rail 展示。
    pushProgress(text) {
      if (typeof text !== 'string' || !text) return;
      if (streamedChars >= STREAM_TOTAL_CAP_CHARS) return;
      streamedChars += text.length;
      progressBuffer += (progressBuffer && !/\n$/.test(progressBuffer) ? '\n' : '') + text;
      armFlush('progress');
    },
    async finish() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
      flush('delta');
      flush('progress');
      // 整体截止：delta 通道是 best-effort，异常慢（对端不响应）时必须在
      // 有限时间内让位给终态回发，不能无限拖住 handleEnvelope。
      await Promise.race([
        chain,
        new Promise((resolve) => { const deadline = setTimeout(resolve, STREAM_FINISH_DEADLINE_MS); deadline.unref(); }),
      ]);
    },
  };
}

// 串行队列：同一时刻只处理一条消息，避免并发锁/限流问题。只在共享单个
// 子进程的模式下真正必要（sscli 常驻 JSONL 子进程 / codex app-server）——
// 同一进程的并发 deliver 会互相踩协议状态。oneshot 模式每条消息都会 spawn
// 一个独立的 CLI 子进程，没有共享运行时，因此走并发路径：这样同一智能体的
// 上一条长任务还在跑时，新的一条快速消息也能立即启动，不用干等旧任务。
const RUNS_OWN_CLI_PROCESS = AGENT_MODE !== 'sscli' && PRESET_NAME !== 'codex';
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** 取消控制帧（guide §9.2）：绕过串行队列，立即终止运行中的任务。
 *  统一分发给全部运行时：oneshot 子进程（activeTasks）/ stream-json 子进程
 *  （StreamJsonRuntime.active）/ codex app-server 在途 turn / sscli 常驻进程
 *  （JSONL cancel）。各端都以 task_id 为 cancel 键注册运行中的任务（无
 *  task_id 时回退 message_id），未持有该 task 的端直接返回 false。任一 runtime
 *  命中即记入 cancelledTasks——被 kill 的子进程/turn 之后的非零退出/拒绝会在
 *  handleEnvelope 里被抑制，不再补发错误回信（否则用户会同时看到取消回执与
 *  一条 [p3394_gateway_error] 或半截回复）。 */
function handleCancel(envelope) {
  const taskId = envelope.task_id;
  if (!taskId) {
    postReply(envelope, '[已取消]');
    return;
  }
  const killed = cancelTask(taskId) || streamJsonRuntime.cancel(taskId) || codexAppServerRuntime.cancel(taskId) || claudePersistentRuntime.cancel(taskId);
  if (killed) cancelledTasks.add(taskId);
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
  // 会话工作区 mkdir + 入站附件落盘必须被保护：任一失败都不能把信封静默
  // 丢弃——对端会一直干等回复直到超时（表现为"无回复/超慢"）。失败要回
  // 显式 `[p3394_gateway_error]` 错误信，让 CogSeed 快速失败、不空等。
  let inDir = '';
  let outDir = '';
  let dir = '';
  let inFiles = [];
  let runtimeDir = '';
  try {
    const dirs = workspaceDirs(sessionId);
    inDir = dirs.inDir;
    outDir = dirs.outDir;
    dir = dirs.dir;
    runtimeDir = resolveEnvelopeWorkingDir(envelope, dir);
    inFiles = decodeResourceParts(envelope, inDir);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('[p3394-gateway] session setup failed: ' + message);
    postReply(envelope, '[p3394_gateway_error] ' + sanitizeStreamText(message));
    return;
  }
  const runStartedAt = Date.now();
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
    const stream = createStreamEmitter(envelope);
    // 统一入口：按 runtimeFor() 选中后端（sscli 主导 / codex 专有 / oneshot
    // 兜底），会话连续性由各后端自管（oneshot 走网关 transcript，sscli/codex
    // 常驻进程内建历史）。
    const runtime = runtimeFor();
    const goal = envelope.payload && envelope.payload.metadata && typeof envelope.payload.metadata.goal === 'string'
      ? envelope.payload.metadata.goal
      : '';
    await runtime.openSession(sessionId, goal, runtimeDir);
    // taskId 随 opts 传给运行时：oneshot / stream-json 子进程按 task_id 注册
    // 可取消键，使 cancel 控制帧（按 task_id 匹配）能真正终止运行中的 CLI。
    // execPrefs：CogSeed 扩展的单轮执行偏好（见 executionPrefsFor）。
    const rawReply = await runtime.deliver(sessionId, envelope.message_id, text, { cwd: runtimeDir, taskId: envelope.task_id, artifactNote, peerCallHint: PEER_CALL_HINT, execPrefs: executionPrefsFor(envelope) }, (delta) => stream.push(delta), (line) => stream.pushProgress(line));
    await stream.finish();
    const reply = rawReply.length > MAX_REPLY_BYTES ? rawReply.slice(0, MAX_REPLY_BYTES) + '\n[输出过长已截断]' : rawReply;
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
    postReply(envelope, '[p3394_gateway_error] ' + sanitizeStreamText(error && error.message ? error.message : String(error)));
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
  // Peer call 本地路由：运行中的 CLI 智能体（oneshot 子进程 / sscli 常驻）
  // 通过本端点转调另一个 P3394 节点。本网关只与 CogSeed 桥通信：信封带
  // extensions.forward_to，由桥解析目标并转发（peer-forward），回复经本端
  // reply_endpoint 回发、由 replyWaiters 匹配后作为本端点响应返回。
  // 鉴权：仅回环可访问 + 需 Bearer AUTH_TOKEN（与本端入站信封一致）。
  if (req.url && req.url.startsWith('/p3394/call') && req.method === 'POST') {
    if (AUTH_TOKEN) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + AUTH_TOKEN) {
        json(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
    }
    let body = '';
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES && !bodyTooLarge) {
        bodyTooLarge = true;
        json(res, 413, { ok: false, error: 'payload_too_large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (bodyTooLarge) return;
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* fallthrough */ }
      const peer = parsed && typeof parsed.peer === 'string' ? parsed.peer.trim() : '';
      const message = parsed && typeof parsed.message === 'string' ? parsed.message.trim() : '';
      if (!peer || !message) {
        json(res, 422, { ok: false, error: 'peer_and_message_required' });
        return;
      }
      // 本地预校验（与桥 peer-forward 的拒绝规则一致，避免无效目标
      // 空等 3 分钟超时）：桥自身节点 id 不可作为转发目标；也不可转发
      // 给自己。桥对这些情况的响应是 200-ack + 异步失败（不回传错误），
      // 所以必须在本地拦截。
      if (peer === 'cogseed' || peer === 'cogseed' || peer === 'cogseed') {
        json(res, 502, { ok: false, error: 'p3394_call_forward_rejected: p3394_forward_invalid_target (bridge self node)' });
        return;
      }
      if (peer === AGENT_ID) {
        json(res, 502, { ok: false, error: 'p3394_call_forward_rejected: p3394_forward_invalid_target (cannot forward to self)' });
        return;
      }
      const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const env = {
        spec_version: 'p3394/1.0',
        message_id: 'msg-fwd-' + nonce,
        session_id: 'ses-fwd-' + nonce,
        task_id: 'tsk-fwd-' + nonce,
        kind: 'task',
        performative: 'request',
        role: 'requester',
        sender: { agent_id: AGENT_ID, ...(AGENT_ALIAS ? { alias: AGENT_ALIAS } : {}) },
        recipients: [{ agent_id: peer }],
        payload: { parts: [{ type: 'text', text: message.slice(0, MAX_MESSAGE_LEN) }], metadata: { goal: 'peer call to ' + peer } },
        extensions: { forward_to: peer, reply_endpoint: ADVERTISE_ENDPOINT, reply_token: AUTH_TOKEN },
        idempotency_key: 'idem-fwd-' + nonce,
      };
      const timer = setTimeout(() => {
        if (replyWaiters.has(env.message_id)) {
          replyWaiters.delete(env.message_id);
          json(res, 504, { ok: false, error: 'p3394_call_timeout' });
        }
      }, PEER_CALL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      replyWaiters.set(env.message_id, (reply) => {
        clearTimeout(timer);
        // 桥转发失败时回传的错误信封（app-wiring.ts 方案 2）：识别前缀并
        // 映射为 502，而不是当作成功回复返回。
        const replyText = envelopeText(reply);
        if (replyText.startsWith('[p3394_forward_error]')) {
          json(res, 502, { ok: false, peer, error: replyText.replace('[p3394_forward_error] ', '') });
          return;
        }
        json(res, 200, { ok: true, peer, reply: replyText });
      });
      const url = new URL(COGSEED_ENDPOINT + '/p3394/envelope');
      const headers = { 'Content-Type': 'application/json' };
      if (COGSEED_TOKEN) headers.Authorization = 'Bearer ' + COGSEED_TOKEN;
      const fwdReq = http.request(url, { method: 'POST', headers }, (r) => {
        // 读取桥的响应体：非 2xx（如 p3394_forward_invalid_target 422）必须
        // 立即失败返回，否则 replyWaiters 会空等 PEER_CALL_TIMEOUT_MS 超时。
        let resBody = '';
        r.on('data', (chunk) => { resBody += chunk; });
        r.on('end', () => {
          if (r.statusCode && r.statusCode >= 200 && r.statusCode < 300) return; // 转发已受理，等待对端回信
          clearTimeout(timer);
          if (replyWaiters.has(env.message_id)) {
            replyWaiters.delete(env.message_id);
            let reason = 'HTTP ' + r.statusCode;
            try { const parsed = JSON.parse(resBody); if (parsed && typeof parsed.error === 'string') reason = parsed.error; } catch { /* fallthrough */ }
            json(res, 502, { ok: false, error: 'p3394_call_forward_rejected: ' + reason });
          }
        });
      });
      fwdReq.on('error', (error) => {
        clearTimeout(timer);
        if (replyWaiters.has(env.message_id)) {
          replyWaiters.delete(env.message_id);
          json(res, 502, { ok: false, error: 'p3394_call_send_failed: ' + (error && error.message ? error.message : String(error)) });
        }
      });
      // 转发请求必须有界：桥不响应时销毁 socket（触发 error → 502），
      // 否则挂起的转发连接延迟到 PEER_CALL_TIMEOUT_MS 才由 waiter 兜底。
      fwdReq.setTimeout(OUTBOUND_HTTP_TIMEOUT_MS, () => fwdReq.destroy());
      fwdReq.end(JSON.stringify({ envelope: env }));
    });
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
    let bodyTooLarge = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES && !bodyTooLarge) {
        bodyTooLarge = true;
        json(res, 413, { ok: false, error: 'payload_too_large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (bodyTooLarge) return;
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
      // oneshot 模式并发执行（每条消息独立 CLI 进程，不排队）；sscli/codex
      // 共享单子进程，仍走串行队列。
      if (RUNS_OWN_CLI_PROCESS) {
        void handleEnvelope(envelope).catch((error) => {
          console.error('[p3394-gateway] envelope failed: ' + (error && error.message ? error.message : String(error)));
        });
      } else {
        void enqueue(() => handleEnvelope(envelope));
      }
    });
    return;
  }
  json(res, 404, { ok: false, error: 'not_found' });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('[p3394-gateway] shutting down (' + signal + ')');
    // 统一关闭各运行时：回杀运行中的 oneshot CLI 子进程（否则退场后它们继续
    // 跑成孤儿）、sscli 常驻子进程、codex app-server。
    sscliRuntime.close();
    codexAppServerRuntime.close();
    streamJsonRuntime.close();
    claudePersistentRuntime.close();
    oneshotRuntime.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}

server.listen(PORT, GATEWAY_HOST, () => {
  console.log('[p3394-gateway] ' + AGENT_ID + ' P3394 endpoint on http://' + (isLoopbackHost ? '127.0.0.1' : GATEWAY_HOST) + ':' + PORT + ' · mode: ' + AGENT_MODE);
  console.log('[p3394-gateway] runtime: ' + runtimeFor().name);
  console.log('[p3394-gateway] replies to ' + COGSEED_ENDPOINT + ' · preset: ' + PRESET_NAME + (PRESET_NAME === 'codex' ? ' · runtime: Codex Desktop app-server (' + CODEX_APP_SERVER + ')' : ' · CLI: ' + CLI + ' ' + CLI_ARGS));
  // codex 预热：gateway 一启动就把 app-server 拉起来（冷启动实测 ~8s，
  // 首轮对话才 spawn 会让用户干等）。fire-and-forget，失败静默——首次
  // deliver 会再走 start() 兜底。
  if (PRESET_NAME === 'codex') {
    codexAppServerRuntime.start().catch((error) => {
      console.error('[p3394-gateway] codex app-server warmup failed: ' + (error && error.message ? error.message : String(error)));
    });
  }
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
 *
 * 断线恢复：发送失败（CogSeed 未起/连接拒绝/非 2xx）按退避重试
 * （P3394_SEND_TASK_RETRIES 次，间隔 1.2s * attempt）；总等待受
 * SEND_TASK_TIMEOUT_MS 封顶，超时以非零码退出。
 */
function sendTaskOneShot(text, attempt = 1) {
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
  const retry = (why) => {
    if (attempt < SEND_TASK_RETRIES) {
      console.error('[p3394-gateway] send-task ' + why + ', retrying (' + attempt + '/' + SEND_TASK_RETRIES + ')');
      setTimeout(() => sendTaskOneShot(text, attempt + 1), 1200 * attempt);
      return true;
    }
    console.error('[p3394-gateway] send-task ' + why + ' after ' + attempt + ' attempt(s)');
    process.exit(1);
    return false;
  };
  const req = http.request(url, { method: 'POST', headers }, (res) => {
    res.resume();
    if (!(res.statusCode >= 200 && res.statusCode < 300)) {
      retry('rejected ' + res.statusCode);
    }
  });
  req.setTimeout(OUTBOUND_HTTP_TIMEOUT_MS, () => req.destroy());
  req.on('error', (error) => {
    retry('failed: ' + error.message);
  });
  req.end(body);
}

/** 心跳：轻量 control 信封（inform），刷新 CogSeed 注册表里的 last_seen。 */
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
  req.setTimeout(OUTBOUND_HTTP_TIMEOUT_MS, () => req.destroy());
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
  req.setTimeout(OUTBOUND_HTTP_TIMEOUT_MS, () => req.destroy());
  req.on('error', (error) => {
    console.log('[p3394-gateway] registration hello failed (CogSeed offline?): ' + error.message);
  });
  req.end(JSON.stringify({ envelope: hello }));
}
