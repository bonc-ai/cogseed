/**
 * P1-1 回归：应用启动时 Managed Gateway 恢复必须显式拿到真 Bridge 信息。
 *
 * 真实走 app-wiring 的 maybeStartP3394Bridge 启动链：state 文件里遗留的
 * 托管网关应在本桥启动期间被 respawn，且 respawn 必须拿到本桥自己的
 * endpoint/token——而不是回退 getP3394BridgeInfo()。
 *
 * 修复前 buildBridge 调用 respawnManagedGateways() 时 activeHandle 仍未赋值
 * （要等 maybeStartP3394Bridge 拿到 handle 之后才注册），getP3394BridgeInfo()
 * 返回 null → doStartExternalGateway 以 p3394_bridge_unavailable 拒绝 → 重启
 * 后所有「外接」agent 离线。本测试在修复前必然失败（hermes 起不来）、修复后
 * 通过（真实 spawn + hello 注册）。
 *
 * 独立文件：external-gateways.test.ts 由并行会话维护，避免编辑冲突（同
 * external-gateways-watchdog.test.ts 的约定）。
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listExternalGateways, stopExternalGateway } from '../../../../src/main/features/p3394_bridge/external-gateways';
import { p3394StateFile } from '../../../../src/main/features/p3394_bridge/runtime-paths';

const VARIANT = 'p3394-boot-' + Math.random().toString(36).slice(2, 8);
let previousVariant: string | undefined;
let previousWs: string | undefined;
let bridgeHandle: { close: () => Promise<void> } | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}

beforeAll(async () => {
  previousVariant = process.env.COGSEED_RUNTIME_VARIANT;
  previousWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_RUNTIME_VARIANT = VARIANT;
  // paths.ts 要求：index.ts 启动时设置；测试环境需显式给出隔离工作区。
  process.env.COGSEED_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-boot-ws-'));
  process.env.COGSEED_P3394_PORT = String(await freePort());
  process.env.COGSEED_P3394_TOKEN = 'boot-recover-token';
  // 非 conversation 模式：走 cogseed-task runtime（测试确定性）。
  process.env.COGSEED_P3394_CONVERSATION = '0';

  const { activateUser } = await import('../../../../src/main/features/users');
  activateUser('u-boot-' + Math.random().toString(36).slice(2, 10));

  // 预置"上次运行遗留"的托管网关记录（cli=hermes，真实可执行 CLI），模拟
  // 应用重启后 state 文件仍在、网关进程已被清掉的场景。
  const gatewayStateFile = p3394StateFile('p3394-external-gateways.json');
  fs.mkdirSync(path.dirname(gatewayStateFile), { recursive: true });
  fs.writeFileSync(gatewayStateFile, JSON.stringify({
    schema_version: 1,
    gateways: [{ cli: 'hermes', agent_id: 'hermes', alias: 'BootHermes', bin: '/bin/echo', port: 1, pid: 1, started_at: new Date().toISOString() }],
  }));
});

afterAll(async () => {
  await stopExternalGateway('hermes').catch(() => {});
  await bridgeHandle?.close().catch(() => {});
  if (previousVariant === undefined) delete process.env.COGSEED_RUNTIME_VARIANT;
  else process.env.COGSEED_RUNTIME_VARIANT = previousVariant;
  if (previousWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWs;
  delete process.env.COGSEED_P3394_PORT;
  delete process.env.COGSEED_P3394_TOKEN;
  delete process.env.COGSEED_P3394_CONVERSATION;
  try { fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', VARIANT), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('P3394 managed-gateway boot recovery (real bridge, P1-1)', () => {
  it('respawns a recorded gateway during bridge boot — bridgeInfo passed explicitly, not via the global handle', async () => {
    const { maybeStartP3394Bridge } = await import('../../../../src/main/features/p3394_bridge/app-wiring');
    bridgeHandle = await maybeStartP3394Bridge();
    expect(bridgeHandle, 'bridge failed to start').not.toBeNull();
    if (!bridgeHandle) return;

    // respawn 在 buildBridge 内 await 完成，因此桥返回时 hermes 要么已注册、
    // 要么立即可见；这里再轮询一次兜底（防御性，注册是异步 hello）。
    const deadline = Date.now() + 15_000;
    let running = false;
    while (Date.now() < deadline && !running) {
      running = listExternalGateways().some((g) => g.cli === 'hermes' && g.running);
      if (!running) await new Promise((r) => setTimeout(r, 400));
    }
    expect(running, 'managed gateway was NOT recovered at boot (bridgeInfo lost?)').toBe(true);
    const listed = listExternalGateways().find((g) => g.cli === 'hermes');
    expect(listed?.alias).toBe('BootHermes');
  }, 60_000);
});
