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
    window: { orkas: { invoke, stream: () => ({ promise: Promise.resolve(), cancel() {} }) } },
  };
  (sandbox.window as Record<string, unknown>).window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/ipc-shim.js'), 'utf8'), sandbox);
  return (sandbox as Record<string, unknown>).apiFetch as (url: string, options?: Record<string, unknown>) => Promise<{ json: () => Promise<unknown> }>;
}

describe('cognition ipc shim routes', () => {
  it('分页摘要、旧列表与从对话捕获都通过受控 IPC', async () => {
    const invoke = vi.fn(async () => ({ ok: true, assets: [] }));
    const apiFetch = loadShim(invoke);
    await apiFetch('/api/cognition/assets/page?page=2&pageSize=50');
    await apiFetch('/api/cognition/assets');
    await apiFetch('/api/cognition/assets/capture', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', summary: 'y', evidence: { kind: 'conversation', summary: 'z', sourceLabel: 's' } }),
    });
    expect(invoke).toHaveBeenNthCalledWith(1, 'cognition.assets.page', { page: '2', pageSize: '50' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'cognition.assets.list', {});
    expect(invoke).toHaveBeenNthCalledWith(3, 'cognition.assets.capture', expect.objectContaining({ title: 'x' }));
  });

  it('动态资产 id 被解码后传入详情、确认和复用路由', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const apiFetch = loadShim(invoke);
    await apiFetch('/api/cognition/assets/cog%20one');
    await apiFetch('/api/cognition/assets/cog_1/confirm', { method: 'POST', body: '{}' });
    await apiFetch('/api/cognition/assets/cog_1/reuse', { method: 'POST', body: JSON.stringify({ sourceLabel: 'task' }) });
    expect(invoke).toHaveBeenNthCalledWith(1, 'cognition.assets.get', { assetId: 'cog one' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'cognition.assets.confirm', { assetId: 'cog_1' });
    expect(invoke).toHaveBeenNthCalledWith(3, 'cognition.assets.reuse', { sourceLabel: 'task', assetId: 'cog_1' });
  });
});
