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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-native-smoke-'));
process.env.ORKAS_WORKSPACE_ROOT = root;
process.env.ORKAS_PC_DIR = pcDir;
process.env.ORKAS_MATE_RUNTIME_TEST_ECHO = '1';

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
  const { createMateRuntimeController } = require('../src/main/features/cogseed_backend/runtime-controller.ts');
  const { readMateTask } = require('../src/main/features/cogseed_backend/task-store.ts');
  const { readMateTaskEvents } = require('../src/main/features/cogseed_backend/event-store.ts');
  const { mateAgentRuntime } = require('../src/main/features/cogseed_runtime/index.ts');

  const userId = 'mate-smoke-user';
  const controller = createMateRuntimeController();

  const first = await controller.startMateTask(userId, {
    requestId: 'req-smoke-complete',
    task: 'Smoke text result.',
  });
  assert(first.status === 'running', 'startMateTask must return a running background task');

  const completed = await eventually(async () => {
    const task = await readMateTask(userId, first.taskId);
    assert(task?.status === 'completed', `expected completed, got ${task?.status || 'missing'}`);
    return task;
  }, 'completed task');
  const completedEvents = await readMateTaskEvents(userId, first.taskId, 0, 50);
  assert(completed.sessionId.startsWith('mate-session-'), 'completed task must have Mate session id');
  assert(completed.runtimeSessionId.startsWith('mruntime-'), 'completed task must have Runtime session id');
  assert(completedEvents.some((event) => event.type === 'task.queued'), 'completed task missing task.queued event');
  assert(completedEvents.some((event) => event.type === 'task.started'), 'completed task missing task.started event');
  assert(completedEvents.some((event) => event.type === 'task.completed'), 'completed task missing task.completed event');
  assert(completedEvents.every((event, index) => event.sequence === index + 1), 'completed task event sequence must be contiguous');

  const second = await controller.startMateTask(userId, {
    requestId: 'req-smoke-cancel',
    task: 'Cancel before worker dispatch.',
  });
  const cancelled = await controller.cancelMateTask(userId, second.taskId);
  assert(cancelled.status === 'cancelled', 'cancelMateTask must persist cancelled status');
  const cancelledEvents = await readMateTaskEvents(userId, second.taskId, 0, 50);
  assert(cancelledEvents.some((event) => event.type === 'task.cancelled'), 'cancelled task missing task.cancelled event');

  await mateAgentRuntime.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ ok: true, completedTaskId: first.taskId, cancelledTaskId: second.taskId }) + '\n');
} catch (error) {
  try {
    const { mateAgentRuntime } = require('../src/main/features/cogseed_runtime/index.ts');
    await mateAgentRuntime.shutdown();
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  process.stderr.write((error && error.stack) ? `${error.stack}\n` : `${String(error)}\n`);
  process.exitCode = 1;
}
