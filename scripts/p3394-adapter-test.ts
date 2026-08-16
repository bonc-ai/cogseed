#!/usr/bin/env tsx
/**
 * P3394 channel adapter test CLI (SDK design §18: `p3394 adapter test`).
 *
 * Runs the framework-independent channel contract suite against one of the
 * built-in adapters. The in-process adapter is the default because it needs
 * no network configuration:
 *
 *   npx tsx scripts/p3394-adapter-test.ts in-process [--json]
 *
 * Network adapters (http/unix) only pass descriptor/health/close checks in
 * this harness unless a listener is bound — the real delivery paths are
 * covered by their dedicated test suites and the gateway smoke test.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 独立工作区 + 运行时变体：src/main 模块（paths.ts）需要这些变量，且本
// 脚本绝不触碰任何真实 CogSeed 实例的状态。必须在动态 import 之前设置。
process.env.ORKAS_WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-adapter-test-'));
process.env.ORKAS_RUNTIME_VARIANT = 'p3394-adapter-test-' + Date.now().toString(36);

interface AdapterModule {
  default?: never;
  [key: string]: unknown;
}

async function adapterFor(name: string): Promise<{ adapter: { descriptor: { id: string }; listen(): Promise<void>; dial(p: string): Promise<void>; send(e: unknown): Promise<unknown>; subscribe(l: (e: unknown) => void): () => void; close(): Promise<void>; health?(): Promise<unknown> } } | null> {
  switch (name) {
    case 'in-process':
    case 'inprocess': {
      const mod = (await import('../src/main/features/p3394_bridge/in-process-channel')) as AdapterModule;
      return { adapter: new (mod.P3394InProcessChannel as new () => unknown)() as never };
    }
    case 'ipc': {
      const mod = (await import('../src/main/features/p3394_bridge/ipc-channel')) as AdapterModule;
      return { adapter: new (mod.P3394IpcChannel as new (id: string) => unknown)('ipc') as never };
    }
    case 'unix':
    case 'unix-socket': {
      const mod = (await import('../src/main/features/p3394_bridge/unix-socket-channel')) as AdapterModule;
      return { adapter: new (mod.P3394UnixSocketChannel as new (id: string) => unknown)('unix') as never };
    }
    case 'websocket':
    case 'wss': {
      const mod = (await import('../src/main/features/p3394_bridge/websocket-channel')) as AdapterModule;
      return { adapter: new (mod.P3394WebSocketChannel as new (config: unknown) => unknown)({ enabled: true, auth_token: 'testkit' }) as never };
    }
    default:
      return null;
  }
}

async function main(): Promise<void> {
  const name = process.argv[2];
  const resolved = await adapterFor(name || 'in-process');
  if (!resolved) {
    process.stderr.write('Unknown adapter: ' + (name ?? '(none)') + '\n');
    process.stderr.write('Available: in-process | ipc | unix | websocket\n');
    process.exit(2);
  }
  const { runP3394ChannelAdapterConformance } = (await import('../src/main/features/p3394_bridge/channel-testkit')) as {
    runP3394ChannelAdapterConformance: (a: unknown) => Promise<{ adapter: string; checks: Array<{ name: string; status: string; reason?: string }>; ok: boolean }>;
  };
  const report = await runP3394ChannelAdapterConformance(resolved.adapter);
  const json = process.argv.includes('--json');
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('P3394 adapter test: ' + report.adapter + '\n');
    for (const c of report.checks) {
      const mark = c.status === 'pass' ? 'ok' : c.status === 'skip' ? '--' : 'FAIL';
      process.stdout.write('  [' + mark + '] ' + c.name + (c.reason ? ' — ' + c.reason : '') + '\n');
    }
    process.stdout.write('result: ' + (report.ok ? 'pass' : 'FAIL') + '\n');
  }
  process.exit(report.ok ? 0 : 1);
}

void main();