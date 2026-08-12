#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const pcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
require(require.resolve('tsx/cjs', { paths: [pcDir] }));
const tsxEsm = require(require.resolve('tsx/esm/api', { paths: [pcDir] }));
tsxEsm.register();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-host-smoke-'));
process.env.ORKAS_WORKSPACE_ROOT = root;
process.env.ORKAS_PC_DIR = pcDir;
process.env.ORKAS_MATE_RUNTIME_TEST_HOST_ECHO = '1';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
let service;
try {
  const { createRuntimeWorkerService } = require('../src/main/features/cogseed_runtime/worker-process.ts');
  const { createMateHostToolRouter } = require('../src/main/features/cogseed_backend/host-tool-router.ts');
  const calls = [];
  const router = createMateHostToolRouter({
    office: { run: async (name, input, scope) => { calls.push({ name, userId: scope.userId }); return { content: JSON.stringify({ office: input.path }) }; } },
    browser: { run: async (name, _input, scope) => { calls.push({ name, userId: scope.userId }); return { content: JSON.stringify({ url: 'https://example.com', text: 'Example' }) }; } },
    coordinator: {
      delegate: async (_uid, _requestId, input) => { calls.push({ name: 'mate_delegate', task: input.task }); return { taskId: 'mate-task-smokechild', sessionId: 'mate-session-smokechild', runtimeSessionId: 'mruntime-smokechild', status: 'running' }; },
      tasks: async () => ({ coordinationId: 'mate-coord-smoke', children: [] }),
      cancel: async () => ({ taskId: 'mate-task-smokechild', status: 'cancelled' }),
    },
  });
  service = createRuntimeWorkerService({ hostToolHandler: (call, context) => router.handle(call, context) });
  const request = {
    protocol_version: 2, type: 'run', request_id: 'req-host-smoke', runtime_session_id: 'mruntime-host-smoke', user_id: 'mate-host-smoke-user',
    task: JSON.stringify({ hostTools: [
      { name: 'office_read', input: { path: '/tmp/report.docx' } },
      { name: 'browser_snapshot', input: {} },
      { name: 'mate_delegate', input: { task: 'Inspect one bounded subtask' } },
    ] }), context: [], attachments: [], read_only_roots: ['/tmp'], writable_roots: ['/tmp'], working_dir: '/tmp',
  };
  const events = [];
  for await (const event of service.run(request)) events.push(event);
  const result = events.find((event) => event.type === 'result');
  assert(result?.status === 'completed', 'host smoke did not complete');
  assert(calls.map((call) => call.name).join(',') === 'office_read,browser_snapshot,mate_delegate', 'host calls were not ordered');
  assert(calls.every((call) => !call.userId || call.userId === request.user_id), 'host call user scope mismatch');
  await service.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, hostCalls: calls.length }) + '\n');
} catch (error) {
  try { await service?.shutdown(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  process.stderr.write((error?.stack || String(error)) + '\n'); process.exitCode = 1;
}
