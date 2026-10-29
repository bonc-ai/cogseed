import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * 审批推送去重（T5 / P01）。
 *
 * 主进程按 `request_id` 唯一持有审批记录；同一次请求被投递两次（队列重投递、
 * 重连补发）时，界面只能让用户决定一次。这里钉住的就是：重复推送不产生第二个
 * 弹窗、不产生第二次 respond；不同 request_id 仍然各弹各的。
 */
const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/action-approval.js'), 'utf8');

interface Harness {
  /** Resolve the pending modal with an approve verdict. */
  approve: () => Promise<void>;
  showCount: () => number;
  responses: Array<{ request_id: string; decision: string }>;
  push: (info: Record<string, unknown>) => void;
  flush: () => Promise<void>;
}

function createHarness(): Harness {
  const responses: Array<{ request_id: string; decision: string }> = [];
  let showCount = 0;
  let resolveModal: ((value: any) => void) | null = null;
  const pushHandlers = new Map<string, (info: any) => void>();

  const sandbox: Record<string, any> = {
    document: {
      documentElement: { lang: 'zh-CN' },
      addEventListener() {},
      removeEventListener() {},
    },
    createLogger: () => ({ warn() {}, info() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      const raw = String(key);
      return vars ? `${raw}:${JSON.stringify(vars)}` : raw;
    },
    // 共享弹窗替身：每次打开记一次，返回一个可被 approve() 解决的 promise。
    uiModal: () => {
      showCount += 1;
      const promise = new Promise((resolve) => { resolveModal = resolve; });
      return {
        dialog: { querySelector: () => null },
        close: () => resolveModal && resolveModal({ value: 'deny' }),
        then: promise.then.bind(promise),
        catch: promise.catch.bind(promise),
        finally: promise.finally.bind(promise),
        [Symbol.toStringTag]: 'Promise',
      };
    },
    cogseed: {
      invoke: async (channel: string, payload: any) => {
        if (channel === 'actionApproval.respond') responses.push(payload);
        return { handled: true };
      },
      onPushEvent: (channel: string, handler: (info: any) => void) => {
        pushHandlers.set(channel, handler);
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'action-approval.js' });

  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };

  return {
    responses,
    showCount: () => showCount,
    push: (info) => pushHandlers.get('action-approval:request')?.(info),
    approve: async () => {
      await flush();
      if (resolveModal) resolveModal({ value: 'approve' });
      await flush();
    },
    flush,
  };
}

const request = (requestId: string, extra: Record<string, unknown> = {}) => ({
  request_id: requestId,
  actor: 'CogSeed Agent',
  action: 'bash',
  target: 'mkdir probe',
  scope: '/tmp',
  risk: 'high',
  reasons: ['a2a_reception_shell'],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...extra,
});

describe('action approval › duplicate pushes', () => {
  it('shows one modal for the same request delivered twice', async () => {
    const harness = createHarness();

    harness.push(request('approval-1'));
    harness.push(request('approval-1'));
    await harness.flush();
    await harness.approve();

    // The second delivery must not become a second queued modal after the first
    // decision: one request, one modal, one verdict.
    expect(harness.showCount()).toBe(1);
    expect(harness.responses).toEqual([{ request_id: 'approval-1', decision: 'approve' }]);
  });

  it('ignores a late re-delivery after the request was already decided', async () => {
    const harness = createHarness();

    harness.push(request('approval-2'));
    await harness.flush();
    await harness.approve();
    // 迟到重投递：同一个 request_id 不应再弹窗、再 respond。
    harness.push(request('approval-2'));
    await harness.flush();

    expect(harness.showCount()).toBe(1);
    expect(harness.responses).toHaveLength(1);
  });

  it('still shows a separate modal for a different request id', async () => {
    const harness = createHarness();

    harness.push(request('approval-3'));
    await harness.flush();
    await harness.approve();
    harness.push(request('approval-4'));
    await harness.flush();

    expect(harness.showCount()).toBe(2);
    await harness.approve();
    expect(harness.responses.map((row) => row.request_id)).toEqual(['approval-3', 'approval-4']);
  });
});
