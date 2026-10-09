import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

import * as paths from '../../../../src/main/paths';
import { COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, type RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';
import { createCogSeedAgentRuntime } from '../../../../src/main/features/cogseed_runtime';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

afterEach(() => {
  fs.rmSync(paths.userRoot('runtime-facade-user'), { recursive: true, force: true });
});

describe('CogSeed Runtime facade', () => {
  it('normalizes requests, omits CogSeed cid, persists events, and projects only final text', async () => {
    const seen: RuntimeRunRequest[] = [];
    const projected: Array<{ text: string; runtime_session_id: string; request_id: string }> = [];
    const runtime = createCogSeedAgentRuntime({
      allowedRootsForUser: () => [],
      worker: {
        async *run(req: RuntimeRunRequest) {
          seen.push(req);
          yield { type: 'event' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'started' as const, text: 'started' };
          yield { type: 'result' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'completed' as const, text: 'done' };
        },
        async shutdown() {},
      },
      projectResult: async (uid, event) => {
        projected.push({ text: event.text || '', runtime_session_id: event.runtime_session_id, request_id: event.request_id });
      },
    });

    const events = await collect(runtime.run('runtime-facade-user', {
      task: 'Summarize only this text.',
      context: [{ type: 'text', content: 'Text A' }]
    } as any));

    expect(events.map((e) => e.type)).toEqual(['event', 'result']);
    expect(seen).toHaveLength(1);
    expect(seen[0].protocol_version).toBe(COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION);
    expect(seen[0].runtime_session_id).toMatch(/^mruntime-/);
    expect(seen[0]).not.toHaveProperty('cid');
    expect(seen[0].task).toBe('Summarize only this text.');
    expect(projected).toEqual([{ text: 'done', runtime_session_id: seen[0].runtime_session_id, request_id: seen[0].request_id }]);

    const runRoot = paths.cogseedRuntimeRunsDir('runtime-facade-user');
    expect(fs.existsSync(runRoot)).toBe(true);
    const runIds = fs.readdirSync(runRoot);
    expect(runIds).toHaveLength(1);
    expect(fs.readFileSync(paths.cogseedRuntimeRunEventsFile('runtime-facade-user', runIds[0]), 'utf8')).toContain('done');
  });

  it('rejects transcript-shaped input before dispatching to worker', async () => {
    let called = false;
    const runtime = createCogSeedAgentRuntime({
      allowedRootsForUser: () => [paths.userRoot('runtime-facade-user')],
      worker: {
        async *run(_req: RuntimeRunRequest) { called = true; },
        async shutdown() {},
      },
    });
    const transcript = paths.userSessionFile('runtime-facade-user', 'gconv-secret');

    await expect(collect(runtime.run('runtime-facade-user', {
      task: 'Read transcript.',
      attachments: [{ type: 'file', path: transcript }],
    }))).rejects.toThrow(/transcript/i);
    expect(called).toBe(false);
  });

  it('preserves run created_at when marking the run completed', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createCogSeedAgentRuntime({
      allowedRootsForUser: () => [],
      worker: {
        async *run(req: RuntimeRunRequest) {
          yield { type: 'event' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'running' as const, text: 'running' };
          await gate;
          yield { type: 'result' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'completed' as const, text: 'done' };
        },
        async shutdown() {},
      },
    });

    const iter = runtime.run('runtime-facade-user', { task: 'Track timestamps.' })[Symbol.asyncIterator]();
    await iter.next();
    const runRoot = paths.cogseedRuntimeRunsDir('runtime-facade-user');
    const [runId] = fs.readdirSync(runRoot);
    const initialMeta = JSON.parse(fs.readFileSync(paths.cogseedRuntimeRunMetaFile('runtime-facade-user', runId), 'utf8'));
    release?.();
    await iter.next();
    await iter.next();

    const finalMeta = JSON.parse(fs.readFileSync(paths.cogseedRuntimeRunMetaFile('runtime-facade-user', runId), 'utf8'));
    expect(finalMeta.status).toBe('completed');
    expect(finalMeta.created_at).toBe(initialMeta.created_at);
    expect(finalMeta.updated_at).toBeTruthy();
  });

});

describe('CogSeed Runtime KSTAR capture', () => {
  it('captures terminal Runtime facts after persisting completion and keeps capture failures non-fatal', async () => {
    const captured: Array<{ runId: string; eventTypes: string[] }> = [];
    const runtime = createCogSeedAgentRuntime({
      allowedRootsForUser: () => [],
      worker: {
        async *run(req: RuntimeRunRequest) {
          yield { type: 'event' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'started' as const };
          yield { type: 'result' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'completed' as const, text: 'done' };
        },
        async shutdown() {},
      },
      captureClosure: async (input: { runId: string; events: Array<{ type: string }> }) => {
        captured.push({ runId: input.runId, eventTypes: input.events.map((event) => event.type) });
        throw new Error('capture unavailable');
      },
    });

    const events = await collect(runtime.run('runtime-facade-user', { task: 'Capture this run.' }));

    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'completed' });
    expect(captured).toEqual([{ runId: expect.stringMatching(/^run_/), eventTypes: ['result'] }]);
  });
});

describe('CogSeed Runtime KSTAR terminal behavior', () => {
  it('closes and captures a non-completed terminal result without projecting it as success', async () => {
    const captured: string[] = [];
    const runtime = createCogSeedAgentRuntime({
      allowedRootsForUser: () => [],
      worker: {
        async *run(req: RuntimeRunRequest) {
          yield { type: 'result' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'cancelled' as const, text: 'cancelled' };
        },
        async shutdown() {},
      },
      captureClosure: async (input: { events: Array<{ status: string }> }) => { captured.push(input.events.at(-1)?.status || ''); },
      projectResult: async () => { throw new Error('must not project cancelled result'); },
    });

    const events = await collect(runtime.run('runtime-facade-user', { task: 'Cancel this run.' }));

    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'cancelled' });
    expect(captured).toEqual(['cancelled']);
  });

  it('does not block terminal result delivery on a hung KSTAR capture', async () => {
    let projected = false;
    const runtime = createCogSeedAgentRuntime({
      allowedRootsForUser: () => [],
      worker: {
        async *run(req: RuntimeRunRequest) {
          yield { type: 'result' as const, request_id: req.request_id, runtime_session_id: req.runtime_session_id, status: 'completed' as const, text: 'done' };
        },
        async shutdown() {},
      },
      captureClosure: async () => new Promise<never>(() => {}),
      projectResult: async () => { projected = true; },
    });

    const events = await collect(runtime.run('runtime-facade-user', { task: 'Do not wait for capture.' }));

    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'completed' });
    expect(projected).toBe(true);
  });
});
