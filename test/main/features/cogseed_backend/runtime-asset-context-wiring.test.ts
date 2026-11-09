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

import type { CogSeedAgentRuntimeFacade, } from '../../../../src/main/features/cogseed_runtime';
import type { RuntimeEventEnvelope } from '../../../../src/main/features/cogseed_runtime/protocol';

const ASSET_ITEM = { type: 'text', label: 'Confirmed reusable ability assets', content: 'ASSET-BLOCK' };
const ONTOLOGY_ITEM = { type: 'text', label: 'Task ontology', content: '<task-ontology>ONTOLOGY-BLOCK</task-ontology>' };
const probes = vi.hoisted(() => ({
  ontologyCalls: 0,
  ontologyInputs: [] as any[],
  reception: vi.fn(),
  finalizeUsage: vi.fn(),
  assetAssembly: vi.fn(),
  dispatchedAssembly: vi.fn(),
  kstarLifecycle: vi.fn(),
}));

vi.mock('../../../../src/main/features/kstar/lifecycle-adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/kstar/lifecycle-adapter')>(),
  readKstarTaskLifecycle: probes.kstarLifecycle,
}));

vi.mock('../../../../src/main/features/cogseed_backend/runtime-asset-context', () => ({
  MAX_RUNTIME_ASSET_CONTEXT_CHARS: 16_000,
  buildDispatchedRuntimeAssetContext: async () => [],
  buildDispatchedRuntimeAssetContextAssembly: probes.dispatchedAssembly,
  buildRuntimeAssetContext: async () => [ASSET_ITEM],
  buildRuntimeAssetContextAssembly: probes.assetAssembly,
  buildRuntimeOntologyContext: async (_userId: string, _taskId: string, input: any) => {
    probes.ontologyCalls += 1;
    probes.ontologyInputs.push(input);
    return [ONTOLOGY_ITEM];
  },
}));
vi.mock('../../../../src/main/features/cogseed_backend/runtime-tool-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/cogseed_backend/runtime-tool-policy')>(),
  isA2AReceptionRequest: probes.reception,
}));
vi.mock('../../../../src/main/features/recall/runtime-result-content', () => ({
  runtimeResultAnchor: (executionId: string) => `runtime-result-${executionId}`,
  readRuntimeResultContent: async () => ({
    anchorId: 'runtime-result-exec-usage',
    content: { text: 'completed [[ontology:module-a/rule-a@2]]' },
  }),
}));
vi.mock('../../../../src/main/features/cognition/ontology/usage-receipt', () => ({
  finalizeOntologyUsageCitations: probes.finalizeUsage,
}));

const USER = 'cogseed-asset-wiring-user';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-asset-wiring-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  probes.ontologyCalls = 0;
  probes.ontologyInputs = [];
  probes.reception.mockReset().mockResolvedValue(false);
  probes.finalizeUsage.mockReset().mockResolvedValue([]);
  probes.assetAssembly.mockReset().mockResolvedValue({ items: [ASSET_ITEM], assetIds: ['asset-1'] });
  probes.dispatchedAssembly.mockReset().mockResolvedValue({ items: [], assetIds: [] });
  probes.kstarLifecycle.mockReset().mockResolvedValue({ task: undefined, requirement: undefined });
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runtimeFrom(events: RuntimeEventEnvelope[]): CogSeedAgentRuntimeFacade & { inputs: any[] } {
  const inputs: any[] = [];
  return {
    inputs,
    async *run(_userId: string, input: unknown) {
      inputs.push(input);
      for (const event of events) yield event;
    },
    async shutdown() {},
  } as CogSeedAgentRuntimeFacade & { inputs: any[] };
}

async function controllerWith(events: RuntimeEventEnvelope[]) {
  const runtime = runtimeFrom(events);
  const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
  const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) } as any);
  return { runtime, controller };
}

const assetItems = (input: any) => (input?.context || []).filter((item: any) => item?.label === ASSET_ITEM.label);
const contextLabels = (input: any) => (input?.context || []).map((item: any) => item?.label).filter(Boolean);

/** 启动是异步的：等 runtime 真的被调用，再看它收到了什么。 */
async function waitForLaunches(runtime: { inputs: any[] }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.inputs.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runtime launched ${runtime.inputs.length} times, expected ${count}`);
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

describe('confirmed ability assets reach every runtime launch path', () => {
  it('injects on the first run', async () => {
    const { runtime, controller } = await controllerWith([
      { type: 'result', request_id: 'req-first', runtime_session_id: 'ms-first', status: 'completed', text: 'done' },
    ]);
    await controller.startCogSeedTask(USER, { requestId: 'req-first', task: 'Run once.', conversationId: 'cid-assets' });
    await waitForLaunches(runtime, 1);
    expect(assetItems(runtime.inputs[0])).toEqual([ASSET_ITEM]);
    expect(contextLabels(runtime.inputs[0])).toEqual([ASSET_ITEM.label, ONTOLOGY_ITEM.label]);
    await waitFor(() => probes.finalizeUsage.mock.calls.length > 0, 'terminal ontology usage receipt was not finalized');
    expect(probes.finalizeUsage).toHaveBeenCalledWith(USER, expect.objectContaining({
      taskRunId: expect.stringMatching(/^cogseed-task-/),
      messageId: 'runtime-result-exec-usage',
      finalText: 'completed [[ontology:module-a/rule-a@2]]',
      executionId: expect.any(String),
    }));
  });

  it('uses the KStar goal as the ontology query seed, matching the chat path', async () => {
    probes.kstarLifecycle.mockResolvedValue({
      task: undefined,
      requirement: { goalText: '准备甲项目评审会' },
    });
    const { runtime, controller } = await controllerWith([
      { type: 'result', request_id: 'req-goal', runtime_session_id: 'ms-goal', status: 'completed', text: 'done' },
    ]);
    await controller.startCogSeedTask(USER, {
      requestId: 'req-goal', task: '本轮补充：把议程发给我。', conversationId: 'cid-goal',
    });
    await waitForLaunches(runtime, 1);
    expect(probes.ontologyInputs[0]).toMatchObject({
      purpose: '准备甲项目评审会',
      topicQuery: '准备甲项目评审会',
    });
  });

  it('skips task ontology for an A2A reception run', async () => {
    probes.reception.mockResolvedValue(true);
    const { runtime, controller } = await controllerWith([
      { type: 'result', request_id: 'req-reception', runtime_session_id: 'ms-reception', status: 'completed', text: 'done' },
    ]);
    await controller.startCogSeedTask(USER, { requestId: 'req-reception', task: 'Run reception.', conversationId: 'cid-reception' });
    await waitForLaunches(runtime, 1);
    expect(contextLabels(runtime.inputs[0])).toEqual([ASSET_ITEM.label]);
    expect(probes.ontologyCalls).toBe(0);
  });

  it('does not suppress ontology for assets that were not injected', async () => {
    probes.assetAssembly.mockResolvedValue({ items: [], assetIds: ['asset-ghost'] });
    probes.dispatchedAssembly.mockResolvedValue({ items: [], assetIds: ['asset-granted'] });
    const { runtime, controller } = await controllerWith([
      { type: 'result', request_id: 'req-ghost', runtime_session_id: 'ms-ghost', status: 'completed', text: 'done' },
    ]);
    await controller.startCogSeedTask(USER, {
      requestId: 'req-ghost', task: 'Run without assets.', conversationId: 'cid-ghost',
      abilityAssetIds: ['asset-granted'],
    });
    await waitForLaunches(runtime, 1);
    expect(contextLabels(runtime.inputs[0])).toEqual([ONTOLOGY_ITEM.label]);
    expect(probes.ontologyInputs[0].injectedAssetIds).toEqual([]);
  });

  it('skips task ontology for a delegated child task', async () => {
    const { runtime, controller } = await controllerWith([
      { type: 'result', request_id: 'req-child', runtime_session_id: 'ms-child', status: 'completed', text: 'done' },
    ]);
    await controller.startCogSeedTask(USER, {
      requestId: 'req-child', task: 'Run child.', conversationId: 'cid-child', parentTaskId: 'cogseed-task-parent',
    });
    await waitForLaunches(runtime, 1);
    expect(contextLabels(runtime.inputs[0])).toEqual([ASSET_ITEM.label]);
    expect(probes.ontologyCalls).toBe(0);
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
    const { createCogSeedRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const tasks = await import('../../../../src/main/features/cogseed_backend/task-store');
    const controller = createCogSeedRuntimeController({ runtime, projectTaskEvent: vi.fn(async () => {}) } as any);

    const original = await controller.startCogSeedTask(USER, {
      requestId: 'req-orig', task: 'Run once.', conversationId: 'cid-assets',
    });
    await waitForLaunches(runtime, 1);
    expect(assetItems(runtime.inputs[0])).toEqual([ASSET_ITEM]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await tasks.readCogSeedTask(USER, original.taskId);
      if (current?.status === 'recoverable') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await controller.retryCogSeedTask(USER, original.taskId, 'req-retry');
    await waitForLaunches(runtime, 2);
    // 重试拿到同一批资产，且不重复堆叠。
    expect(assetItems(runtime.inputs[1])).toEqual([ASSET_ITEM]);
  });
});
