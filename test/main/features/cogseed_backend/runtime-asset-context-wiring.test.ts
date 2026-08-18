/**
 * 已确认资产必须在**每一条**启动路径上都进 Runtime：首次执行、重试、续跑。
 *
 * 重试原本漏了注入——同一个任务第一次带认知资产、重试后反而没有，用户只会
 * 以为资产失效了。这里只验证接线（内容链路由
 * recall/cognition-asset-runtime-chain.test.ts 端到端覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { MateAgentRuntimeFacade, } from '../../../../src/main/features/cogseed_runtime';
import type { RuntimeEventEnvelope } from '../../../../src/main/features/cogseed_runtime/protocol';

const ASSET_ITEM = { type: 'text', label: 'Confirmed reusable ability assets', content: 'ASSET-BLOCK' };

vi.mock('../../../../src/main/features/cogseed_backend/runtime-asset-context', () => ({
  MAX_RUNTIME_ASSET_CONTEXT_CHARS: 16_000,
  buildRuntimeAssetContext: async () => [ASSET_ITEM],
}));

const USER = 'mate-asset-wiring-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-asset-wiring-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runtimeFrom(events: RuntimeEventEnvelope[]): MateAgentRuntimeFacade & { inputs: any[] } {
  const inputs: any[] = [];
  return {
    inputs,
    async *run(_userId: string, input: unknown) {
      inputs.push(input);
      for (const event of events) yield event;
    },
    async shutdown() {},
  } as MateAgentRuntimeFacade & { inputs: any[] };
}

async function controllerWith(events: RuntimeEventEnvelope[]) {
  const runtime = runtimeFrom(events);
  const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const controller = createMateRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) } as any);
  return { runtime, controller };
}

const assetItems = (input: any) => (input?.context || []).filter((item: any) => item?.label === ASSET_ITEM.label);

/** 启动是异步的：等 runtime 真的被调用，再看它收到了什么。 */
async function waitForLaunches(runtime: { inputs: any[] }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.inputs.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime launched ${runtime.inputs.length} times, expected ${count}`);
}

describe('confirmed ability assets reach every runtime launch path', () => {
  it('injects on the first run', async () => {
    const { runtime, controller } = await controllerWith([
      { type: 'result', request_id: 'req-first', runtime_session_id: 'ms-first', status: 'completed', text: 'done' },
    ]);
    await controller.startMateTask(USER, { requestId: 'req-first', task: 'Run once.', conversationId: 'cid-assets' });
    await waitForLaunches(runtime, 1);
    expect(assetItems(runtime.inputs[0])).toEqual([ASSET_ITEM]);
  });

  it('injects again on retry, so a retried task is not silently stripped of its assets', async () => {
    // 第一次 worker 崩溃 → 任务进 recoverable，才谈得上重试。
    let runs = 0;
    const runtime: any = {
      inputs: [] as any[],
      async *run(_userId: string, input: unknown) {
        this.inputs.push(input);
        runs += 1;
        if (runs === 1) throw new Error('worker crashed');
        yield { type: 'result', request_id: 'req-retry', runtime_session_id: 'ms-retry', status: 'completed', text: 'retried' };
      },
      async shutdown() {},
    };
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createMateRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) } as any);

    const original = await controller.startMateTask(USER, {
      requestId: 'req-orig', task: 'Run once.', conversationId: 'cid-assets',
    });
    await waitForLaunches(runtime, 1);
    expect(assetItems(runtime.inputs[0])).toEqual([ASSET_ITEM]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await tasks.readMateTask(USER, original.taskId);
      if (current?.status === 'recoverable') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await controller.retryMateTask(USER, original.taskId, 'req-retry');
    await waitForLaunches(runtime, 2);
    // 重试拿到同一批资产，且不重复堆叠。
    expect(assetItems(runtime.inputs[1])).toEqual([ASSET_ITEM]);
  });
});
