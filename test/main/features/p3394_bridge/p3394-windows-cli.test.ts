import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForHealth(port: number, token: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/p3394/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('P3394 gateway health timeout');
}

describe.runIf(process.platform === 'win32')('P3394 Windows CLI gateway', () => {
  it.each(['absolute', 'PATH + PATHEXT'])('probes Claude models through a real .cmd entry (%s)', async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-claude-cmd-'));
    const target = path.join(root, 'fake-claude.cjs');
    const shim = path.join(root, 'claude.cmd');
    const token = 'p3394-windows-model-token';
    const port = await freePort();
    fs.writeFileSync(target, [
      "const reply = { result: 'Current model: Sonnet 5\\nUsage: /model <name>. Available: sonnet, opus, haiku.' };",
      'process.stdout.write(JSON.stringify(reply));',
      '',
    ].join('\n'));
    fs.writeFileSync(shim, '@echo off\r\n"%COGSEED_TEST_NODE%" "%~dp0\\fake-claude.cjs" %*\r\n');
    const cli = mode === 'absolute' ? shim : 'claude';
    const gateway = spawn(process.execPath, [path.resolve('p3394-gateway/gateway.cjs')], {
      env: {
        ...process.env,
        PATH: `${root};${process.env.PATH || ''}`,
        PATHEXT: '.CMD;.BAT;.EXE;.COM',
        COGSEED_TEST_NODE: process.execPath,
        P3394_AGENT: 'claude',
        P3394_AGENT_CLI: cli,
        P3394_GATEWAY_PORT: String(port),
        P3394_GATEWAY_TOKEN: token,
        P3394_HEARTBEAT_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let logs = '';
    gateway.stdout?.on('data', (chunk) => { logs += chunk; });
    gateway.stderr?.on('data', (chunk) => { logs += chunk; });
    try {
      await waitForHealth(port, token);
      const response = await fetch(`http://127.0.0.1:${port}/p3394/models`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status, logs).toBe(200);
      const body = await response.json() as { status?: string; current?: string; models?: Array<{ id?: string }> };
      expect(body.status, logs).toBe('ready');
      expect(body.current).toBe('Sonnet 5');
      expect(body.models?.map((model) => model.id)).toEqual(['sonnet', 'opus', 'haiku']);
    } finally {
      gateway.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => gateway.once('close', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`gateway close timeout: ${logs}`)), 5000)),
      ]);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30_000);
});
