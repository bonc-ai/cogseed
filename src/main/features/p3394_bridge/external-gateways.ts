/**
 * P3394 external-agent gateway host — the CogSeed-managed half of the
 * agent-modal 「外接」tab (P3394 way).
 *
 * Instead of dispatching a picked CLI directly, CogSeed starts a managed
 * p3394-gateway child process for it: the gateway self-registers the node
 * (hello) into the bridge registry, and every conversation turn with that
 * agent goes through P3394 envelopes — the same path any external Agent
 * (Hermes, Claude Code, Codex, OpenClaw, WorkBuddy, user-built agents)
 * uses. One protocol, any agent.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import { createLogger } from '../../logger';
import { p3394StateFile, variantRoot } from './runtime-paths';
import { P3394PeerRegistry } from './registry';
import { getP3394BridgeInfo } from './app-wiring';
import { detectOne } from '../local_agents/registry';
// GUI-launched apps inherit a minimal PATH; the managed gateway's children
// (e.g. `codebuddy` via a bare preset name) need the same conventional
// install roots local CLI discovery already knows about.
import { buildCliSpawnEnv } from '../local_agents/spawn-command';

const log = createLogger('p3394-bridge:external-gateways');

// ── 崩溃守护（watchdog） ─────────────────────────────────────────────
// 托管网关崩溃后自动重启（带退避与防风暴），而不是等下次用户触发。
// 主动停止（stopExternalGateway / stopAllExternalGateways / 应用退出）会
// 解除守护：exit 时若已 detach 则不再自动恢复。
const watched = new Map<string, ChildProcess>();
const watchedStartInput = new Map<string, { binPath?: string; alias?: string; bridgeInfo?: { endpoint: string; token: string } | null }>();
const restartCounts = new Map<string, number>();
const WATCHDOG_RESTART_DELAY_MS = Number(process.env.ORKAS_P3394_WATCHDOG_DELAY_MS || 5_000);
const WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3;
/** 已排队的自动重启定时器（key 为 cli）。detachWatch / stop 必须取消它，
 *  否则「删除 agent → 网关 crash 时排队的 timer 到点复活网关 → hello →
 *  投影重建同名 agent → 再次创建同名被拒」——重启必须尊重主动停止。 */
const restartTimers = new Map<string, NodeJS.Timeout>();
/** Crash 自愈语义标记：exit 回调排 timer 时加入，detachWatch 清除。timer
 *  触发时以此判断「仍期望自愈」——不能用 `watched.has(cli)`，因为 crash
 *  的 exit 回调会先删 watched 再排 timer，那会把正常自愈也拦掉。 */
const expectedRestart = new Set<string>();

export function detachWatch(cli: string): void {
  watched.delete(cli);
  watchedStartInput.delete(cli);
  restartCounts.delete(cli);
  expectedRestart.delete(cli);
  const timer = restartTimers.get(cli);
  if (timer) {
    clearTimeout(timer);
    restartTimers.delete(cli);
  }
}

function scheduleRestart(cli: string, input: { binPath?: string; alias?: string; bridgeInfo?: { endpoint: string; token: string } | null }): void {
  const failures = restartCounts.get(cli) ?? 0;
  if (failures >= WATCHDOG_MAX_CONSECUTIVE_FAILURES) {
    log.warn('P3394 external gateway auto-restart giving up', { cli, attempts: failures });
    restartCounts.delete(cli);
    return;
  }
  // 已有排队 timer → 不重复排（stop/detach 会取消；防并发 crash 双排）。
  if (restartTimers.has(cli)) return;
  expectedRestart.add(cli);
  log.info('P3394 external gateway crashed — scheduling auto-restart', { cli, delayMs: WATCHDOG_RESTART_DELAY_MS });
  const timer = setTimeout(() => {
    restartTimers.delete(cli);
    // 触发前再确认该 cli 仍受托管（未被删除/停止）：detachWatch 取消不了
    // 已在事件循环中等待的 timer 回调本身，这里双保险。
    if (!expectedRestart.has(cli)) return;
    expectedRestart.delete(cli);
    void startExternalGateway({
      cli,
      ...(input.binPath ? { binPath: input.binPath } : {}),
      ...(input.alias ? { alias: input.alias } : {}),
      ...(input.bridgeInfo !== undefined ? { bridgeInfo: input.bridgeInfo } : {}),
    }).then((result) => {
      if (result.ok) {
        restartCounts.delete(cli);
      } else {
        restartCounts.set(cli, (restartCounts.get(cli) ?? 0) + 1);
        log.warn('P3394 external gateway auto-restart failed', { cli, error: result.error });
      }
    });
  }, WATCHDOG_RESTART_DELAY_MS);
  restartTimers.set(cli, timer);
  if (typeof timer.unref === 'function') timer.unref();
}

function watchGateway(cli: string, child: ChildProcess, input: { binPath?: string; alias?: string; bridgeInfo?: { endpoint: string; token: string } | null }): void {
  watched.set(cli, child);
  watchedStartInput.set(cli, { binPath: input.binPath, alias: input.alias, bridgeInfo: input.bridgeInfo });
  child.once('exit', (code) => {
    // 已被主动停止 / 被新实例替换 → 不自动恢复。
    if (watched.get(cli) !== child) return;
    watched.delete(cli);
    watchedStartInput.delete(cli);
    scheduleRestart(cli, input);
  });
}

export interface P3394ExternalGatewayState {
  cli: string;
  agent_id: string;
  alias: string;
  bin: string;
  port: number;
  pid: number;
  started_at: string;
  /** Live check: pid exists and answers signals (best effort). */
  running: boolean;
}

export type P3394ExternalGatewayResult<T> =
  | { ok: true; value: T; error?: never }
  | { ok: false; error: string; value?: never };

/** CLI type → gateway preset / node id. Mirrors gateway PRESETS +
 *  LOCAL_CLI_TYPES; every entry is a real P3394 preset. */
const CLI_TO_PRESET: Record<string, { preset: string; id: string }> = {
  claude: { preset: 'claude', id: 'claude' },
  codex: { preset: 'codex', id: 'codex' },
  openclaw: { preset: 'openclaw', id: 'openclaw' },
  opencode: { preset: 'opencode', id: 'opencode' },
  hermes: { preset: 'hermes', id: 'hermes' },
  workbuddy: { preset: 'workbuddy', id: 'workbuddy' },
  gemini: { preset: 'gemini', id: 'gemini' },
  aider: { preset: 'aider', id: 'aider' },
};

export function p3394ExternalGatewayIdFor(cliType: string): string | null {
  const mapping = CLI_TO_PRESET[String(cliType || '').trim()];
  return mapping ? mapping.id : null;
}

interface GatewayStateFile { schema_version: number; gateways: Array<Omit<P3394ExternalGatewayState, 'running'>> }

const SCHEMA_VERSION = 1;

function stateFilePath(): string {
  return p3394StateFile('p3394-external-gateways.json');
}

function readStateFile(): GatewayStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) as Partial<GatewayStateFile>;
    if (parsed.schema_version === SCHEMA_VERSION && Array.isArray(parsed.gateways)) {
      return { schema_version: SCHEMA_VERSION, gateways: parsed.gateways };
    }
  } catch { /* missing/malformed: start empty */ }
  return { schema_version: SCHEMA_VERSION, gateways: [] };
}

function writeStateFile(state: GatewayStateFile): void {
  const file = stateFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 唯一 tmp 名：多个 CLI 并发 respawn/start 时各自写同一 state 文件，
  // 固定 .tmp 会让并发 rename 互相覆盖/撞 ENOENT（✗7）。
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  // 0600：与其余 P3394 落盘保持一致（该文件目前无凭据，沿用私有惯例）。
  fs.writeFileSync(tmp, JSON.stringify({ ...state, saved_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prunes dead gateway records from the state file (app boot + list). */
function pruneDead(): void {
  const state = readStateFile();
  const alive = state.gateways.filter((g) => pidAlive(g.pid));
  if (alive.length !== state.gateways.length) writeStateFile({ schema_version: SCHEMA_VERSION, gateways: alive });
}

/** Live view of managed gateways (prunes dead records as a side effect). */
export function listExternalGateways(): P3394ExternalGatewayState[] {
  pruneDead();
  return readStateFile().gateways.map((g) => ({ ...g, running: pidAlive(g.pid) }));
}

/** Finds a free loopback port (bind-0 style allocation). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 本机 P3394 网关脚本的真实路径（本地优先：ORKAS_PC_DIR → 打包
 *  asar-unpacked → dev 仓库根）。对端引导用它给出可审查的具体路径。 */
export function p3394GatewayScriptPath(): string {
  // 本地优先：CogSeed 自带 gateway（仓库 dev 根 / 打包 asar-unpacked），
  // 无需对端从 NPM 拉取。
  if (process.env.ORKAS_PC_DIR) {
    return path.join(process.env.ORKAS_PC_DIR, 'p3394-gateway', 'gateway.cjs');
  }
  if (app && app.isPackaged) {
    // Packaged builds: gateway lives as a real file under app.asar.unpacked
    // (asar contents are not readable by a spawned child process).
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'p3394-gateway', 'gateway.cjs');
  }
  return path.resolve(__dirname, '..', '..', '..', '..', 'p3394-gateway', 'gateway.cjs');
}

function gatewayScriptPath(): string {
  return p3394GatewayScriptPath();

}

/** In-flight start dedup (S-04): concurrent starts of the same CLI share
 *  one promise so respawn / self-heal / user-init cannot double-spawn. */
const startingGateways = new Map<string, Promise<P3394ExternalGatewayResult<P3394ExternalGatewayState>>>();

/**
 * Starts (or reuses) the managed P3394 gateway for a CLI type. The
 * gateway self-registers into the bridge registry via hello; this
 * function waits for that registration before returning ok.
 *
 * Deduplicates in-flight starts per CLI (S-04): a second caller for the
 * same CLI while the first is still registering reuses the first call's
 * promise instead of spawning a second gateway process.
 */
export function startExternalGateway(input: {
  cli: string;
  binPath?: string;
  alias?: string;
  /** Test seam: bridge endpoint/token override (defaults to the live bridge). */
  bridgeInfo?: { endpoint: string; token: string } | null;
}): Promise<P3394ExternalGatewayResult<P3394ExternalGatewayState>> {
  const cli = String(input.cli || '').trim();
  const inflight = startingGateways.get(cli);
  if (inflight) return inflight;
  const attempt = doStartExternalGateway(input).finally(() => { startingGateways.delete(cli); });
  startingGateways.set(cli, attempt);
  return attempt;
}

async function doStartExternalGateway(input: {
  cli: string;
  binPath?: string;
  alias?: string;
  /** Test seam: bridge endpoint/token override (defaults to the live bridge). */
  bridgeInfo?: { endpoint: string; token: string } | null;
}): Promise<P3394ExternalGatewayResult<P3394ExternalGatewayState>> {
  const cli = String(input.cli || '').trim();
  const mapping = CLI_TO_PRESET[cli];
  if (!mapping) return { ok: false, error: 'p3394_unsupported_cli: ' + cli };
  const bridgeInfo = input.bridgeInfo === undefined ? getP3394BridgeInfo() : input.bridgeInfo;
  if (!bridgeInfo) return { ok: false, error: 'p3394_bridge_unavailable' };

  // Reuse a live gateway of the same CLI type.
  const existing = listExternalGateways().find((g) => g.cli === cli && g.running);
  if (existing) return { ok: true, value: existing };

  const scriptPath = gatewayScriptPath();
  if (!fs.existsSync(scriptPath)) return { ok: false, error: 'p3394_gateway_script_missing' };
  let port: number;
  try { port = await freePort(); } catch (error) {
    return { ok: false, error: 'p3394_port_alloc_failed: ' + (error instanceof Error ? error.message : String(error)) };
  }
  const alias = String(input.alias || '').trim().slice(0, 60) || mapping.id;
  const gatewayHome = path.join(variantRoot(), 'external-gateways', cli);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ELECTRON_RUN_AS_NODE: '1',
    P3394_GATEWAY_PORT: String(port),
    P3394_GATEWAY_HOST: '127.0.0.1',
    P3394_ADVERTISE_ENDPOINT: 'http://127.0.0.1:' + port,
    P3394_GATEWAY_HOME: gatewayHome,
    COGSEED_ENDPOINT: bridgeInfo.endpoint,
    COGSEED_TOKEN: bridgeInfo.token,
    P3394_AGENT: mapping.preset,
    P3394_AGENT_ID: mapping.id,
    P3394_AGENT_ALIAS: alias,
    // 检测到的 CLI 绝对路径优先于 PATH（GUI 启动的 app 看不到 shell PATH）。
    P3394_AGENT_CLI: String(input.binPath || '').trim() || mapping.id,
    P3394_HEARTBEAT_MS: '30000',
  };

  let child: ChildProcess | null = null;
  try {
    // GUI-launched apps see a minimal PATH; add the standard install roots
    // (~/.local/bin, /opt/homebrew/bin, ...) so the gateway's own children
    // (bare preset commands like `codebuddy`) resolve like in a terminal.
    const childEnv = buildCliSpawnEnv(scriptPath, env);
    child = spawn(process.execPath, [scriptPath], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let errLog = '';
    let outLog = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outLog.length < 2000) outLog += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errLog.length < 2000) errLog += chunk.toString('utf8');
    });
    // 等待 hello 注册：节点在注册表里出现 endpoint 即接入成功。注册表
    // 可能由本进程的常驻实例或桥的入站 listener 写入，因此每轮都从磁盘
    // 重建快照（持久化文件是唯一事实来源）。
    const deadline = Date.now() + 15_000;
    let registered = false;
    while (Date.now() < deadline) {
      const registry = new P3394PeerRegistry({ filePath: p3394StateFile('p3394-peers.json') });
      const peer = registry.resolve(mapping.id);
      // A stale registry entry is not enough: recovery must observe the
      // endpoint allocated for this child.
      const expectedEndpoint = 'http://127.0.0.1:' + port;
      if (peer.ok && peer.value.endpoints?.includes(expectedEndpoint)) {
        registered = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (!registered) {
      child.kill('SIGTERM');
      const detail = [outLog.trim(), errLog.trim(), 'exit=' + String(child.exitCode)].filter(Boolean).join(' | ').slice(-1500);
      return { ok: false, error: 'p3394_gateway_registration_timeout' + (detail ? ': ' + detail : '') };
    }
    const state = readStateFile();
    const record = {
      cli,
      agent_id: mapping.id,
      alias,
      bin: String(input.binPath || '').trim() || mapping.id,
      port,
      pid: child.pid ?? 0,
      started_at: new Date().toISOString(),
    };
    state.gateways = state.gateways.filter((g) => g.cli !== cli);
    state.gateways.push(record);
    writeStateFile(state);
    log.info('P3394 external gateway started', { cli, agent_id: mapping.id, port, pid: child.pid });
    watchGateway(cli, child, { binPath: input.binPath, alias, bridgeInfo: input.bridgeInfo });
    return { ok: true, value: { ...record, running: true } };
  } catch (error) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 预热一个外接智能体的托管网关（fire-and-forget，幂等）。把「spawn +
 *  hello 注册等待」前移到 wake 批准的时刻，无模型直调外接智能体时
 *  sendAndWait 能更快命中已注册节点，避免等 turn 阶段 recoverGateway
 *  首次 send 失败后才拉起。失败静默（发送时 recoverGateway 兜底）。 */
export function prewarmExternalGateway(input: {
  cli: string;
  alias?: string;
}): void {
  const cli = String(input.cli || '').trim();
  if (!cli) return;
  // 已 running → 无需预热。
  if (listExternalGateways().some((g) => g.cli === cli && g.running)) return;
  void (async () => {
    try {
      const detected = await detectOne(cli as never);
      await startExternalGateway({
        cli,
        ...(detected && detected.path ? { binPath: detected.path } : {}),
        ...(input.alias ? { alias: input.alias } : {}),
      });
    } catch { /* 预热失败不阻塞——发送时 recoverGateway 会兜底 */ }
  })();
}

/** Stops a managed gateway (SIGTERM, graceful). Keeps the registry entry
 *  so the agent shows as offline rather than vanishing. */
export async function stopExternalGateway(cli: string): Promise<P3394ExternalGatewayResult<null>> {
  const key = String(cli || '').trim();
  const record = listExternalGateways().find((g) => g.cli === key);
  if (!record) return { ok: true, value: null };
  detachWatch(key);
  try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
  // 确认进程退出：SIGTERM 后短暂等待，仍存活则 SIGKILL 兜底——否则僵尸
  // 网关会继续 hello/心跳，删除 agent 后触发投影重建同名 agent。
  if (pidAlive(record.pid)) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && pidAlive(record.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (pidAlive(record.pid)) {
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
      log.warn('P3394 external gateway SIGKILL fallback', { cli: key, pid: record.pid });
    }
  }
  const state = readStateFile();
  state.gateways = state.gateways.filter((g) => g.cli !== key);
  writeStateFile(state);
  log.info('P3394 external gateway stopped', { cli: key });
  return { ok: true, value: null };
}

/**
 * App-quit cleanup: stop every managed gateway process but KEEP the state
 * file records — boot recovery (respawnManagedGateways) restores them on
 * the next launch. Clearing the records here would make every restart
 * silently drop the managed gateways, forcing 「外接」agents to depend on
 * manually started processes. Explicit stopExternalGateway / agent delete
 * still removes the matching record.
 */
export async function stopAllExternalGateways(): Promise<void> {
  for (const record of listExternalGateways()) {
    if (!record.running) continue;
    detachWatch(record.cli);
    try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // 清空守护表（连同没有存活记录的 cli）。
  for (const cli of [...watched.keys()]) detachWatch(cli);
}

/**
 * Boot recovery: respawn every managed gateway recorded in the state file.
 *
 * The app restarts stop every managed gateway (stopAllExternalGateways on
 * quit/boot), so without this the 「外接」agents silently depend on a
 * manually started gateway process — the classic "works once, gone after
 * restart" failure. startExternalGateway is idempotent (reuses a live
 * gateway), so a concurrent boot is safe.
 */
export async function respawnManagedGateways(
  opts: { bridgeInfo?: { endpoint: string; token: string } | null } = {},
): Promise<{ restarted: string[]; failed: Array<{ cli: string; error: string }> }> {
  const state = readStateFile();
  const out: { restarted: string[]; failed: Array<{ cli: string; error: string }> } = { restarted: [], failed: [] };
  // M-02: 并行恢复，避免 15s×N 串行阻塞桥启动；startExternalGateway 内部
  // 已有 per-cli in-flight 去重（S-04），同 cli 不会双 spawn。
  await Promise.all(state.gateways.map(async (record) => {
    if (!record.cli) return;
    // `bin` holds the absolute CLI path when discovery found one; fall back
    // to the bare preset name (the gateway resolves it against PATH).
    const binPath = record.bin && record.bin !== record.cli ? record.bin : undefined;
    const started = await startExternalGateway({
      cli: record.cli,
      alias: record.alias,
      ...(binPath ? { binPath } : {}),
      // Test seam: defaults to the live bridge.
      ...(opts.bridgeInfo !== undefined ? { bridgeInfo: opts.bridgeInfo } : {}),
    });
    if (started.ok) out.restarted.push(record.cli);
    else out.failed.push({ cli: record.cli, error: started.error });
  }));
  if (out.restarted.length > 0 || out.failed.length > 0) {
    log.info('P3394 managed gateways respawned', out);
  }
  return out;
}
