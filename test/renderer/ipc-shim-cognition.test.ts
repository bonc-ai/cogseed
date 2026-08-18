import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadShim(invoke: (...args: unknown[]) => Promise<unknown>) {
  const sandbox: Record<string, unknown> & { window?: Record<string, unknown> } = {
    console,
    URL,
    URLSearchParams,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    ReadableStream,
    btoa,
    fetch: vi.fn(),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    window: { cogseed: { invoke, stream: () => ({ promise: Promise.resolve(), cancel() {} }) } },
  };
  (sandbox.window as Record<string, unknown>).window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/ipc-shim.js'), 'utf8'), sandbox);
  return (sandbox as Record<string, unknown>).apiFetch as (url: string, options?: Record<string, unknown>) => Promise<{ json: () => Promise<unknown> }>;
}

describe('cognition ipc shim routes', () => {
  it('遗留 CognitionAsset store 的 REST 入口已全部删除', async () => {
    // 那个 store 只剩读用途（memory.ts 用 listActiveCognitionSourceIds 门控历史
    // MEMORY 记录的可见性），**不再有任何写入入口**，也从不参与正式认知资产 /
    // 认知树 / runtime 注入。正式资产的 canonical 读口在 ipc/index.ts。
    const invoke = vi.fn(async () => ({ ok: true }));
    const apiFetch = loadShim(invoke);
    for (const [url, options] of [
      ['/api/cognition/assets', undefined],
      ['/api/cognition/assets/page?page=2&pageSize=50', undefined],
      ['/api/cognition/assets/capture', { method: 'POST', body: '{}' }],
      ['/api/cognition/assets/cog_1', undefined],
      ['/api/cognition/assets/cog_1/confirm', { method: 'POST', body: '{}' }],
      ['/api/cognition/assets/cog_1/defer', { method: 'POST', body: '{}' }],
      ['/api/cognition/assets/cog_1/reuse', { method: 'POST', body: '{}' }],
      ['/api/cognition/assets/cog_1/evidence', { method: 'POST', body: '{}' }],
    ] as [string, Record<string, unknown> | undefined][]) {
      const response = await apiFetch(url, options);
      await expect(response.json()).resolves.toMatchObject({ ok: false });
    }
    expect(invoke).not.toHaveBeenCalled();
  });
});
