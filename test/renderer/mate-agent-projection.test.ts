import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadProjection(invokeImpl: (...args: any[]) => Promise<any>) {
  const sandbox: any = {
    console,
    window: { cogseed: { invoke: invokeImpl } },
    setTimeout,
    clearTimeout,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/ipc-shim.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'ipc-shim.js' });
  return sandbox.window.mateAgentProjection;
}

describe('Mate renderer projection cache', () => {
  it('returns cached sessions immediately and publishes one replacement after refresh', async () => {
    let resolveRefresh!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    const projection = loadProjection(invoke);
    const updates: unknown[] = [];

    const first = projection.sessions({ onUpdate: (value: unknown) => updates.push(value) });
    expect(first.snapshot).toBeNull();
    await Promise.resolve();
    resolveRefresh({ ok: true, sessions: [{ sessionId: 'mate-session-1' }] });
    await first.refresh;
    expect(updates).toEqual([[{ sessionId: 'mate-session-1' }]]);

    const secondInvoke = vi.fn(async () => ({ ok: true, sessions: [{ sessionId: 'mate-session-2' }] }));
    projection.setInvoker(secondInvoke);
    const secondUpdates: unknown[] = [];
    const second = projection.sessions({ onUpdate: (value: unknown) => secondUpdates.push(value) });
    expect(second.snapshot).toEqual([{ sessionId: 'mate-session-1' }]);
    await second.refresh;
    expect(secondUpdates).toEqual([[{ sessionId: 'mate-session-2' }]]);
    expect(secondUpdates).toHaveLength(1);
  });



  it('normalizes a conversation id to the Mate commander compatibility session id', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      session: { sessionId: 'mate-session-gconv-conversation-a' },
      collaboration: null,
    }));
    const projection = loadProjection(invoke);

    await projection.session('conversation-a').refresh;

    expect(invoke).toHaveBeenCalledWith('mate_agent.session.read', { sessionId: 'gconv-conversation-a' });
  });

  it('deduplicates concurrent refreshes for one collaboration snapshot key', async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      session: { sessionId: 'mate-session-1' },
      collaboration: { sessionId: 'mate-session-1', task: { taskId: 'mate-task-1' } },
    }));
    const projection = loadProjection(invoke);
    const a: unknown[] = [];
    const b: unknown[] = [];

    const first = projection.session('mate-session-1', { onUpdate: (value: unknown) => a.push(value) });
    const second = projection.collaboration('mate-session-1', { onUpdate: (value: unknown) => b.push(value) });
    expect(first.refresh).toBe(second.refresh);
    await first.refresh;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
