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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-native-smoke-'));
process.env.COGSEED_WORKSPACE_ROOT = root;
process.env.COGSEED_PC_DIR = pcDir;
process.env.COGSEED_COGSEED_RUNTIME_TEST_ECHO = '1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function eventually(fn, label, timeoutMs = 5_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try { return await fn(); }
    catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`${label}: ${lastError?.message || lastError || 'timeout'}`);
}

try {
  const { createCogSeedRuntimeController } = require('../src/main/features/cogseed_backend/runtime-controller.ts');
  const { readCogSeedTask } = require('../src/main/features/cogseed_backend/task-store.ts');
  const { readCogSeedTaskEvents } = require('../src/main/features/cogseed_backend/event-store.ts');
  const { cogseedAgentRuntime } = require('../src/main/features/cogseed_runtime/index.ts');

  const userId = 'cogseed-smoke-user';
  const controller = createCogSeedRuntimeController();

  const first = await controller.startCogSeedTask(userId, {
    requestId: 'req-smoke-complete',
    task: 'Smoke text result.',
  });
  assert(first.status === 'running', 'startCogSeedTask must return a running background task');

  const completed = await eventually(async () => {
    const task = await readCogSeedTask(userId, first.taskId);
    assert(task?.status === 'completed', `expected completed, got ${task?.status || 'missing'}`);
    return task;
  }, 'completed task');
  const completedEvents = await readCogSeedTaskEvents(userId, first.taskId, 0, 50);
  assert(completed.sessionId.startsWith('cogseed-session-'), 'completed task must have Mate session id');
  assert(completed.runtimeSessionId.startsWith('mruntime-'), 'completed task must have Runtime session id');
  assert(completedEvents.some((event) => event.type === 'task.queued'), 'completed task missing task.queued event');
  assert(completedEvents.some((event) => event.type === 'task.started'), 'completed task missing task.started event');
  assert(completedEvents.some((event) => event.type === 'task.completed'), 'completed task missing task.completed event');
  assert(completedEvents.every((event, index) => event.sequence === index + 1), 'completed task event sequence must be contiguous');

  const second = await controller.startCogSeedTask(userId, {
    requestId: 'req-smoke-cancel',
    task: 'Cancel before worker dispatch.',
  });
  const cancelled = await controller.cancelCogSeedTask(userId, second.taskId);
  assert(cancelled.status === 'cancelled', 'cancelCogSeedTask must persist cancelled status');
  const cancelledEvents = await readCogSeedTaskEvents(userId, second.taskId, 0, 50);
  assert(cancelledEvents.some((event) => event.type === 'task.cancelled'), 'cancelled task missing task.cancelled event');

  await cogseedAgentRuntime.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, completedTaskId: first.taskId, cancelledTaskId: second.taskId }) + '\n');
} catch (error) {
  try {
    const { cogseedAgentRuntime } = require('../src/main/features/cogseed_runtime/index.ts');
    await cogseedAgentRuntime.shutdown();
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  process.stderr.write((error && error.stack) ? `${error.stack}\n` : `${String(error)}\n`);
  process.exitCode = 1;
}
