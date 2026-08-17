#!/usr/bin/env tsx
/**
 * P3394 interop server for the Hermes live demo.
 *
 * Runs a real CogSeed bridge node with an HTTP channel on loopback and
 * streams execution events into a result file, so a real Hermes agent can
 * POST a UMF task and then read the reply.
 *
 * Usage: npm run p3394:hermes-server [-- --port 43101]
 *
 * Prints HERMES_ENDPOINT and RESULT_FILE to stdout.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'p3394-hermes-user';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-hermes-'));
process.env.ORKAS_WORKSPACE_ROOT = WORK;
const RESULT_FILE = path.join(WORK, 'result.jsonl');
const STATE_FILE = path.join(WORK, 'adapter-state.json');

const portIndex = process.argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;
const TOKEN = 'p3394-hermes-demo-token';

async function main(): Promise<void> {
  const { P3394BridgeKernel } = await import('../src/main/features/p3394_bridge/bridge');
  const { P3394BridgeExecutor } = await import('../src/main/features/p3394_bridge/executor');
  const { buildP3394BridgeManifest } = await import('../src/main/features/p3394_bridge/manifest');
  const { P3394CogseedRuntimeAdapter } = await import('../src/main/features/p3394_bridge/cogseed-runtime-adapter');
  const { createMateRuntimeController } = await import('../src/main/features/cogseed_backend/runtime-controller');
  const { P3394HttpChannel } = await import('../src/main/features/p3394_bridge/http-channel');

  const manifestOf = (id: string) => {
    const r = buildP3394BridgeManifest({ agent_id: id, name: id, description_zh: '', description_en: '', workflow: '', category: 'general' } as never);
    if (!r.ok) throw new Error(r.error.message);
    return r.manifest;
  };

  const bridge = new P3394BridgeKernel();
  bridge.registry.register({ identity: { agent_id: 'hermes', display_name: 'Hermes' }, manifest: manifestOf('hermes') });
  bridge.registry.register({ identity: { agent_id: 'cogseed', display_name: 'CogSeed' }, manifest: manifestOf('cogseed') });

  // CogSeed replies with an echo of the received task text — proof that the
  // message travelled from Hermes into the real CogSeed execution stores.
  const runtime = {
    shutdown: async () => {},
    run: async function* (_userId: string, input: unknown) {
      const task = (input as { task?: string }).task ?? '';
      yield { type: 'event', status: 'running', text: 'CogSeed 已收到 Hermes 的消息，正在处理…', metadata: {} };
      await new Promise((resolve) => setTimeout(resolve, 400));
      yield { type: 'result', status: 'completed', text: 'CogSeed 回复：已收到消息「' + task.slice(0, 200) + '」。P3394 互操作验证成功。', metadata: {} };
    },
  };
  const controller = createMateRuntimeController({ runtime });
  const adapter = new P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 50, stateFile: STATE_FILE });

  const channel = new P3394HttpChannel('cogseed-http', {
    listen: { host: '127.0.0.1', port: PORT },
    authToken: TOKEN,
  });
  channel.setLocalManifest(manifestOf('cogseed'));

  const executor = new P3394BridgeExecutor({
    bridge,
    runtime: adapter,
    onEvent: (sessionId, event) => {
      fs.appendFileSync(RESULT_FILE, JSON.stringify({ at: new Date().toISOString(), session_id: sessionId, event }) + '\n');
      process.stdout.write('[event] ' + event.kind + (event.data && typeof event.data.text === 'string' ? ': ' + event.data.text : '') + '\n');
    },
  });
  channel.subscribe((envelope) => { executor.execute(envelope); });
  await channel.listen();

  const address = (channel as unknown as { server: { address(): { port: number } } }).server.address();
  const endpoint = 'http://127.0.0.1:' + address.port;
  process.stdout.write('HERMES_ENDPOINT=' + endpoint + '\n');
  process.stdout.write('HERMES_TOKEN=' + TOKEN + '\n');
  process.stdout.write('RESULT_FILE=' + RESULT_FILE + '\n');
  process.stdout.write('WORKSPACE=' + WORK + '\n');

  // Keep serving until a task completes (bounded demo run).
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await channel.close();
}

main().catch((error) => {
  process.stderr.write('server failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
});