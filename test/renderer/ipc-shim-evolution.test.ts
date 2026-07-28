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

  it('GET /api/evolution/skills/:skillId/versions → evolution.skills.versions', async () => {
    const invoke = vi.fn(async () => ({ ok: true, versions: [] }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/skills/sk1/versions');
    expect(invoke).toHaveBeenCalledWith('evolution.skills.versions', expect.objectContaining({ skillId: 'sk1' }));
  });

  it('POST /api/evolution/skills/:skillId/export → evolution.skills.export', async () => {
    const invoke = vi.fn(async () => ({ ok: true, zipPath: '/tmp/sk1-v0.2.0.zip' }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/skills/sk1/export', { method: 'POST', body: JSON.stringify({ version: '0.2.0' }) });
    expect(invoke).toHaveBeenCalledWith('evolution.skills.export', expect.objectContaining({ skillId: 'sk1', version: '0.2.0' }));
  });

  it('GET /api/evolution/skills/:skillId/recommend → evolution.evolve.recommend', async () => {
    const invoke = vi.fn(async () => ({ ok: true, suggestions: [] }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/skills/sk1/recommend');
    expect(invoke).toHaveBeenCalledWith('evolution.evolve.recommend', expect.objectContaining({ skillId: 'sk1' }));
  });

  it('POST /api/evolution/skills/capture-intent → evolution.skills.captureIntent', async () => {
    const invoke = vi.fn(async () => ({ ok: true, questions: [] }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/skills/capture-intent', { method: 'POST', body: JSON.stringify({ name: 'x', purpose: 'p' }) });
    expect(invoke).toHaveBeenCalledWith('evolution.skills.captureIntent', expect.objectContaining({ name: 'x', purpose: 'p' }));
  });

  it('POST /api/evolution/skills/create-draft → evolution.skills.createDraft', async () => {
    const invoke = vi.fn(async () => ({ ok: true, skill: { id: 'sk-new' } }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/skills/create-draft', { method: 'POST', body: JSON.stringify({ name: 'x' }) });
    expect(invoke).toHaveBeenCalledWith('evolution.skills.createDraft', expect.objectContaining({ name: 'x' }));
  });

  it('GET /api/evolution/ontology/:skillId/bindings → evolution.ontology.bindings', async () => {
    const invoke = vi.fn(async () => ({ ok: true, refs: [] }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/ontology/sk1/bindings');
    expect(invoke).toHaveBeenCalledWith('evolution.ontology.bindings', expect.objectContaining({ skillId: 'sk1' }));
  });

  it('POST /api/evolution/ontology/:skillId/bind → evolution.ontology.bind', async () => {
    const invoke = vi.fn(async () => ({ ok: true, refs: ['onto-b'] }));
    const { apiFetch } = loadShim(invoke);
    await apiFetch('/api/evolution/ontology/sk1/bind', { method: 'POST', body: JSON.stringify({ ontologyId: 'onto-b' }) });
    expect(invoke).toHaveBeenCalledWith('evolution.ontology.bind', expect.objectContaining({ skillId: 'sk1', ontologyId: 'onto-b' }));
  });

  it('POST /api/evolution/evals/run 走流式（stream 被调用）', async () => {
    const stream = vi.fn(() => ({ promise: Promise.resolve(), cancel: () => {} }));
    const { apiFetch } = loadShim(vi.fn(async () => ({ ok: true })), stream);
    const res = await apiFetch('/api/evolution/evals/run', { method: 'POST', body: JSON.stringify({ skillId: 'sk1', cases: [] }) });
    expect(res.body).toBeDefined();
    expect(stream).toHaveBeenCalled();
  });
});
