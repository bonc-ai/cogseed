import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

const uid = 'transcript-launch-user';
let root: string;
let previousRoot: string | undefined;
let controller: { shutdown(): Promise<void> } | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-launch-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(async () => {
  await controller?.shutdown();
  await drainMainRuntimeForTest(uid);
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

it('launches correction with the persisted task session through the real runtime facade', async () => {
  const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const { createCogSeedAgentRuntime } = await import('../../../../src/main/features/cogseed_runtime');
  const { createCogSeedHostToolRouter } = await import('../../../../src/main/features/cogseed_backend/host-tool-router');
  const { readCogSeedTaskByRequestId } = await import('../../../../src/main/features/cogseed_backend/task-store');
  const { upsertEntry } = await import('../../../../src/main/features/transcript_glossary');
  await upsertEntry(uid, { wrong: '扣格种子', correct: 'CogSeed', kind: 'product' });
  const router = createCogSeedHostToolRouter();
  const observed: any[] = [];
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  const runtime = createCogSeedAgentRuntime({
    allowedRootsForUser: () => [root], captureClosure: async () => undefined,
    worker: {
      async *run(request: any) {
        const task = await readCogSeedTaskByRequestId(uid, request.request_id);
        const result = await router.handle({ type: 'host_tool_call', call_id: 'scan',
          request_id: request.request_id, runtime_session_id: request.runtime_session_id,
          name: 'transcript_glossary_scan', input: { docId: 'meeting', text: '讨论扣格种子', includeReview: false },
        }, { request, signal: new AbortController().signal });
        observed.push({ session: request.runtime_session_id, persisted: task?.runtimeSessionId, result });
        resolveFinished();
        yield { type: 'result' as const, request_id: request.request_id, runtime_session_id: request.runtime_session_id, status: 'completed' as const, text: 'fixture' };
      },
      async shutdown() {},
    } as any,
  });
  const instance = createCogSeedRuntimeController({ runtime, projectTaskEvent: async () => undefined, runtimeHealthWatchdog: false });
  controller = instance;
  await instance.startCogSeedTask(uid, { requestId: 'req-transcript-launch', task: 'Correct the transcript', workingDir: root });
  await finished;
  expect(observed[0].session).toBe(observed[0].persisted);
  expect(observed[0].result.isError).not.toBe(true);
  expect(observed[0].result.correction?.state).toBe('scanned');
});

it('keeps confirmation waiting and resumes the same task/session exactly once', async () => {
  const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const { createCogSeedAgentRuntime } = await import('../../../../src/main/features/cogseed_runtime');
  const { readCogSeedTask, readCogSeedTaskByRequestId } = await import('../../../../src/main/features/cogseed_backend/task-store');
  const seen: any[] = [];
  const projectTaskEvent = vi.fn(async () => undefined);
  const runtime = createCogSeedAgentRuntime({ allowedRootsForUser: () => [root], captureClosure: async () => undefined,
    worker: { async *run(request: any) {
      seen.push({ request, task: await readCogSeedTaskByRequestId(uid, request.request_id) });
      if (seen.length === 1) yield { type: 'error', request_id: request.request_id, runtime_session_id: request.runtime_session_id,
        status: 'failed', error: '- 「错词」 → 「正确词」 (1)', metadata: { code: 'transcript_confirmation_required' } };
      else yield { type: 'result', request_id: request.request_id, runtime_session_id: request.runtime_session_id,
        status: 'completed', text: 'Minutes delivered.' };
    }, async shutdown() {} } as any,
  });
  const instance = createCogSeedRuntimeController({ runtime, projectTaskEvent, runtimeHealthWatchdog: false });
  controller = instance;
  const initial = await instance.startCogSeedTask(uid, { requestId: 'req-confirm-start', task: 'Summarize', workingDir: root });
  await instance.waitForTaskTurn(uid, initial.taskId);
  expect((await readCogSeedTask(uid, initial.taskId))?.status).toBe('waiting_user');
  await expect(instance.recoverOrphanedTasks(uid)).resolves.toMatchObject({ taskIds: [] });
  expect((await readCogSeedTask(uid, initial.taskId))?.status).toBe('waiting_user');
  const resumed = await instance.resumeCogSeedTask(uid, initial.taskId, { requestId: 'req-confirm-resume', continuation: 'Apply confirmed choices.' });
  await instance.waitForTaskTurn(uid, resumed.taskId);
  expect(resumed.taskId).toBe(initial.taskId);
  expect((await readCogSeedTask(uid, initial.taskId))?.status).toBe('completed');
  expect(seen).toHaveLength(2);
  expect(seen[1].task?.taskId).toBe(initial.taskId);
  expect(seen[1].request.runtime_session_id).toBe(initial.runtimeSessionId);
  await instance.resumeCogSeedTask(uid, initial.taskId, { requestId: 'req-confirm-resume', continuation: 'Apply confirmed choices.' });
  expect(seen).toHaveLength(2);
});
