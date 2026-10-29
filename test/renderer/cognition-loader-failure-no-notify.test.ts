import { describe, expect, it } from 'vitest';

/**
 * 按需 loader 失败不得通过 notify 自激成请求循环。
 * 失败路径不 notify，成功路径照常通知；后续用户操作或其他区块通知时，
 * failed 状态仍可重拉。测试以 mock IPC 计数核对该通知边界。
 */

const globalScope = globalThis as unknown as Record<string, unknown>;
type Invoke = (channel: string, payload: Record<string, unknown>) => Promise<unknown>;
let invokeImpl: Invoke = async () => ({ ok: true });
const ipcCounts = new Map<string, number>();
const invoke = (channel: string, payload: Record<string, unknown>) => {
  ipcCounts.set(channel, (ipcCounts.get(channel) || 0) + 1);
  return invokeImpl(channel, payload);
};
const count = (channel: string) => ipcCounts.get(channel) || 0;

const NS = (() => {
  const stub: Record<string, unknown> = {};
  globalScope.window = {
    CogAssets: stub,
    cogseed: { invoke },
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../src/renderer/modules/cognition-assets/core.js');
  return stub as unknown as {
    store: Record<string, unknown>;
    notify: () => void;
    onChange: (fn: () => void) => () => void;
    loadExperiences: (force?: boolean) => Promise<void>;
    loadExperienceDetail: (id: string, force?: boolean) => Promise<void>;
    loadImprovementOutcomes: (force?: boolean) => Promise<void>;
    loadKstarFailures: (force?: boolean) => Promise<void>;
  };
})();

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('经验/失败面通道失败不 notify', () => {
  it('标签加载器已退役，重绘不请求标签库', async () => {
    expect((NS as unknown as Record<string, unknown>).loadTags).toBeUndefined();
    const before = count('recall.tags.list');
    NS.notify();
    await settle();
    expect(count('recall.tags.list')).toBe(before);
  });

  it('loadExperiences 失败：失败尾部不 notify（app.js 钩子每帧补拉的环被掐断）', async () => {
    let notifies = 0;
    const off = NS.onChange(() => { notifies += 1; });
    invokeImpl = async (channel) => (channel === 'recall.experiences.list'
      ? { ok: false, error: 'experiences unreadable', code: 'E_IO' }
      : { ok: true });
    const before = notifies;
    await NS.loadExperiences();
    await settle();
    expect(NS.store.experiences).toMatchObject({ loading: false, failed: true });
    expect(notifies).toBe(before + 1);
    off();
  });

  it('loadExperienceDetail 失败：失败尾部不 notify（详情路由补拉环被掐断）', async () => {
    let notifies = 0;
    const off = NS.onChange(() => { notifies += 1; });
    invokeImpl = async (channel) => (channel === 'recall.experiences.read'
      ? { ok: false, error: 'experience unreadable', code: 'E_IO' }
      : { ok: true });
    const before = notifies;
    await NS.loadExperienceDetail('exp-loop');
    await settle();
    expect(NS.store.experienceDetail).toMatchObject({ experienceId: 'exp-loop', loading: false, failed: true });
    expect(notifies).toBe(before + 1);
    off();
  });
});
