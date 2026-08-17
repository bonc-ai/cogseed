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

const log = createLogger('p3394-bridge:external-gateways');

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
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...state, saved_at: new Date().toISOString() }, null, 2));
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

/**
 * Starts (or reuses) the managed P3394 gateway for a CLI type. The
 * gateway self-registers into the bridge registry via hello; this
 * function waits for that registration before returning ok.
 */
export async function startExternalGateway(input: {
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
    child = spawn(process.execPath, [scriptPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    return { ok: true, value: { ...record, running: true } };
  } catch (error) {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Stops a managed gateway (SIGTERM, graceful). Keeps the registry entry
 *  so the agent shows as offline rather than vanishing. */
export async function stopExternalGateway(cli: string): Promise<P3394ExternalGatewayResult<null>> {
  const record = listExternalGateways().find((g) => g.cli === String(cli || '').trim());
  if (!record) return { ok: true, value: null };
  try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
  const state = readStateFile();
  state.gateways = state.gateways.filter((g) => g.cli !== String(cli || '').trim());
  writeStateFile(state);
  log.info('P3394 external gateway stopped', { cli });
  return { ok: true, value: null };
}

/** App-quit cleanup: stop every managed gateway. */
export async function stopAllExternalGateways(): Promise<void> {
  for (const record of listExternalGateways()) {
    if (!record.running) continue;
    try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const state = readStateFile();
  writeStateFile({ schema_version: SCHEMA_VERSION, gateways: [] });
}
