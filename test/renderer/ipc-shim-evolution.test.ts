import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadShim(
  invokeImpl: (...args: any[]) => Promise<any> = vi.fn(async () => ({ ok: true })),
  streamImpl: (...args: any[]) => { promise: Promise<void>; cancel: () => void } = () => ({ promise: Promise.resolve(), cancel: () => {} }),
) {
  const sandbox: any = {
    console, URL, URLSearchParams, ArrayBuffer, Uint8Array, TextEncoder, ReadableStream, btoa,
    fetch: vi.fn(),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    window: { Monitor: { error: vi.fn() }, orkas: { invoke: invokeImpl, stream: streamImpl } },
  };
  sandbox.Monitor = sandbox.window.Monitor;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/ipc-shim.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'ipc-shim.js' });
  return { apiFetch: sandbox.apiFetch as Function, invoke: invokeImpl };
}

describe('evolution ipc-shim routes', () => {
  it('POST /api/evolution/dashboard → evolution.dashboard', async () => {
    const invoke = vi.fn(async () => ({ ok: true, skillCount: 1 }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/dashboard', { method: 'POST', body: '{}' });
    expect(invoke).toHaveBeenCalledWith('evolution.dashboard', expect.anything());
  });

  it('POST /api/evolution/evolve/start → evolution.evolve.start', async () => {
    const invoke = vi.fn(async () => ({ ok: true, runId: 'r1' }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/evolve/start', { method: 'POST', body: JSON.stringify({ skillId: 'sk1' }) });
    expect(invoke).toHaveBeenCalledWith('evolution.evolve.start', expect.objectContaining({ skillId: 'sk1' }));
  });

  it('GET /api/evolution/evals/:skillId → evolution.evals.get with skillId param', async () => {
    const invoke = vi.fn(async () => ({ ok: true, skillId: 'sk1', cases: [], runs: [] }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/evals/sk1');
    expect(invoke).toHaveBeenCalledWith('evolution.evals.get', expect.objectContaining({ skillId: 'sk1' }));
  });

  it('POST /api/evolution/evals/run 走流式（stream 被调用）', async () => {
    const stream = vi.fn(() => ({ promise: Promise.resolve(), cancel: () => {} }));
    const { apiFetch } = loadShim(vi.fn(async () => ({ ok: true })), stream);
    const res = await apiFetch('/api/evolution/evals/run', { method: 'POST', body: JSON.stringify({ skillId: 'sk1', cases: [] }) });
    expect(res.body).toBeDefined();
    expect(stream).toHaveBeenCalled();
  });
});
