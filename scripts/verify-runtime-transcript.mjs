#!/usr/bin/env node
/** Exercise the real Runtime worker/host bridge and correction gate in an
 * isolated data root. Uses the production glossary engine, task store and
 * file tools; a scripted model keeps verification deterministic and offline.
 * Run with Electron's Node runtime (ELECTRON_RUN_AS_NODE=1). */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

const pcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
require(require.resolve('tsx/cjs', { paths: [pcDir] }));
require(require.resolve('tsx/esm/api', { paths: [pcDir] })).register();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-transcript-verify-'));
process.env.COGSEED_WORKSPACE_ROOT = root;
process.env.COGSEED_PC_DIR = pcDir;
process.env.COGSEED_COGSEED_RUNTIME_TEST_HOST_ECHO = '1';
let service;
let controller;
try {
  require('../src/main/logger.ts').initLogger();
  const { createCogSeedTask } = require('../src/main/features/cogseed_backend/task-store.ts');
  const { createCogSeedHostToolRouter } = require('../src/main/features/cogseed_backend/host-tool-router.ts');
  const { createRuntimeWorkerService } = require('../src/main/features/cogseed_runtime/worker-process.ts');
  const { createDefaultNativeRuntimeExecutor } = require('../src/main/features/cogseed_runtime/runtime-executor.ts');
  const { upsertEntry } = require('../src/main/features/transcript_glossary.ts');
  const uid = 'transcript-verification-user';
  const { task } = await createCogSeedTask(uid, { requestId: 'req-transcript-verify', task: 'Verify correction boundary', workingDir: root });
  await upsertEntry(uid, { wrong: '扣格种子', correct: 'CogSeed', kind: 'product' });
  const args = { docId: 'verification-meeting', text: '今天讨论扣格种子的使用方式。', includeReview: false };
  const router = createCogSeedHostToolRouter();
  const request = { protocol_version: 2, type: 'run', request_id: task.requestId, runtime_session_id: task.runtimeSessionId, user_id: uid,
    task: JSON.stringify({ hostTools: [
      { name: 'transcript_glossary_scan', input: args },
      { name: 'transcript_glossary_apply', input: args },
    ] }), context: [], attachments: [], read_only_roots: [root], writable_roots: [root], working_dir: root };
  service = createRuntimeWorkerService({ hostToolHandler: (call, context) => router.handle(call, context) });
  const bridgeEvents = [];
  for await (const event of service.run(request)) bridgeEvents.push(event);
  assert.equal(bridgeEvents.at(-1)?.status, 'completed');
  const outputs = JSON.parse(bridgeEvents.at(-1).text);
  assert.match(outputs[1].content, /今天讨论CogSeed的使用方式/);

  // Start through the production controller/facade, rather than supplying
  // the task session by hand as above. This catches missing launch identity.
  const { createCogSeedRuntimeController } = require('../src/main/features/cogseed_backend/runtime-controller.ts');
  const { createCogSeedAgentRuntime } = require('../src/main/features/cogseed_runtime/index.ts');
  const { readCogSeedTask } = require('../src/main/features/cogseed_backend/task-store.ts');
  const runtime = createCogSeedAgentRuntime({ worker: service, allowedRootsForUser: () => [root],
    captureClosure: async () => undefined });
  controller = createCogSeedRuntimeController({ runtime, runtimeHealthWatchdog: false,
    projectTaskEvent: async () => undefined });
  const launched = await controller.startCogSeedTask(uid, {
    requestId: 'req-transcript-controller-verify', task: request.task, workingDir: root,
  });
  let settled;
  for (let attempt = 0; attempt < 200; attempt++) {
    settled = await readCogSeedTask(uid, launched.taskId);
    if (settled && ['completed', 'failed', 'cancelled', 'recoverable'].includes(settled.status)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(settled?.status, 'completed', `controller bridge failed: ${settled?.errorCode}`);
  const { readRuntimeRunMeta } = require('../src/main/features/cogseed_runtime/store.ts');
  const runMeta = await readRuntimeRunMeta(uid, settled.runtimeRunId);
  assert.equal(runMeta.runtime_session_id, settled.runtimeSessionId);
  await controller.shutdown();
  await service.shutdown();

  const outcomes = [];
  for (const success of [true, false]) {
    const target = path.join(root, success ? 'verified-minutes.md' : 'blocked-minutes.md');
    const correctionInput = success ? args : { ...args, docId: '' };
    let round = 0;
    const executor = createDefaultNativeRuntimeExecutor({
      modelAdapter: { async *stream(input) {
        assert(input.tools.some(tool => tool.name === 'transcript_glossary_apply'));
        if (round++ === 0) {
          yield { type: 'tool_call', call: { id: 'scan', name: 'transcript_glossary_scan', arguments: correctionInput } };
          yield { type: 'tool_call', call: { id: 'apply', name: 'transcript_glossary_apply', arguments: correctionInput } };
          yield { type: 'tool_call', call: { id: 'write', name: 'write_file', arguments: { path: target, content: 'Verified fixture minutes.' } } };
        } else yield { type: 'delta', text: 'Done.' };
      } },
      hostToolClient: {
        call: call => router.handle({ type: 'host_tool_call', request_id: call.requestId, runtime_session_id: call.runtimeSessionId, call_id: 'verify-call', name: call.name, input: call.input }, { request, signal: new AbortController().signal }),
        resolve() { return false; }, rejectAll() {},
      },
    });
    const events = [];
    for await (const event of executor({ ...request, task: 'Verify correction and minutes',
      context: [{ type: 'text', label: 'Formal Agent execution context', content: 'Run transcript_glossary_scan and transcript_glossary_apply before minutes.' }],
      tool_policy: { fileRead: 'explicit_roots', fileWrite: 'explicit_writable_roots', shell: 'none', skillRun: 'none', network: 'none', connectors: 'none' },
    })) events.push(event);
    assert.equal(fs.existsSync(target), success);
    assert.equal(events.at(-1)?.status, success ? 'completed' : 'failed');
    if (!success) assert.equal(events.at(-1)?.metadata?.code, 'transcript_correction_incomplete');
    outcomes.push({ correctionSucceeded: success, minutesWritten: fs.existsSync(target), status: events.at(-1)?.status });
  }
  process.stdout.write(JSON.stringify({ ok: true, realWorkerBridge: true, controllerLaunch: true, outcomes }) + '\n');
} catch (error) {
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exitCode = 1;
} finally {
  await controller?.shutdown();
  await service?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}
