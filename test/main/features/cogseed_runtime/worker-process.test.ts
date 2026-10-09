import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION,
  type RuntimeEventEnvelope,
  type RuntimeRunRequest,
} from '../../../../src/main/features/cogseed_runtime/protocol';
import { createRuntimeWorkerService, type RuntimeWorkerChild } from '../../../../src/main/features/cogseed_runtime/worker-process';

type FakeChild = RuntimeWorkerChild & {
  sent: unknown[];
  exitNow(code?: number): void;
};

const children: FakeChild[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.exitNow(0);
});

function makeChild(onMessage?: (msg: any, child: FakeChild) => void): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const sent: unknown[] = [];
  const child: FakeChild = {
    stdin: stdin as any,
    stdout: stdout as any,
    stderr: stderr as any,
    killed: false,
    kill: () => { child.exitNow(0); return true; },
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return child as any;
    },
    once: (event: string, handler: (...args: any[]) => void) => {
      const wrapped = (...args: any[]) => {
        handlers.get(event)?.delete(wrapped);
        handler(...args);
      };
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(wrapped);
      return child as any;
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      handlers.get(event)?.delete(handler);
      return child as any;
    },
    sent,
    exitNow: (code = 0) => {
      if (child.killed) return;
      child.killed = true;
      for (const handler of handlers.get('exit') || []) handler(code, null);
      stdout.end(); stderr.end(); stdin.end();
    },
  } as any;
  stdin.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      sent.push(parsed);
      if (onMessage) onMessage(parsed, child);
    }
  });
  children.push(child);
  return child;
}

function write(child: FakeChild, msg: unknown): void {
  child.stdout.write(`${JSON.stringify(msg)}\n`);
}

function request(id = 'req-A'): RuntimeRunRequest {
  return {
    protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION,
    type: 'run',
    request_id: id,
    runtime_session_id: `mruntime-${id}`,
    user_id: 'runtime-worker-user',
    task: 'Echo this',
    context: [],
    attachments: [],
  };
}

async function collect(iterable: AsyncIterable<RuntimeEventEnvelope>): Promise<RuntimeEventEnvelope[]> {
  const out: RuntimeEventEnvelope[] = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

describe('CogSeed Runtime worker process service', () => {
  it('handshakes and correlates responses by request_id', async () => {
    const service = createRuntimeWorkerService({
      handshakeTimeoutMs: 500,
      spawnWorker: () => makeChild((msg, child) => {
        if (msg.type === 'hello') {
          write(child, { type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, capabilities: ['run', 'cancel'] });
        }
        if (msg.type === 'run') {
          write(child, { type: 'event', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, status: 'started', text: 'started' });
          write(child, { type: 'result', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, status: 'completed', text: 'done' });
        }
      }),
    });

    const events = await collect(service.run(request('req-A')));

    expect(events.map((e) => e.type)).toEqual(['event', 'result']);
    expect(events.every((e) => e.request_id === 'req-A')).toBe(true);
    expect(children[0].sent[0]).toEqual({ type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION });
    await service.shutdown();
  });

  it('rejects protocol version mismatch before running a task', async () => {
    const service = createRuntimeWorkerService({
      handshakeTimeoutMs: 500,
      spawnWorker: () => makeChild((msg, child) => {
        if (msg.type === 'hello') write(child, { type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION + 1, capabilities: [] });
      }),
    });

    await expect(collect(service.run(request('req-version')))).rejects.toThrow(/protocol version/i);
    expect(children[0].sent.filter((m: any) => m.type === 'run')).toHaveLength(0);
    await service.shutdown().catch(() => {});
  });

  it('sends cancel for the in-flight request and yields cancellation', async () => {
    let sawCancel = false;
    const service = createRuntimeWorkerService({
      handshakeTimeoutMs: 500,
      spawnWorker: () => makeChild((msg, child) => {
        if (msg.type === 'hello') write(child, { type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, capabilities: ['run', 'cancel'] });
        if (msg.type === 'run') write(child, { type: 'event', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, status: 'running', text: 'running' });
        if (msg.type === 'cancel') {
          sawCancel = true;
          write(child, { type: 'error', request_id: msg.request_id, runtime_session_id: 'mruntime-req-cancel', status: 'cancelled', error: 'cancelled' });
        }
      }),
    });
    const controller = new AbortController();
    const events: RuntimeEventEnvelope[] = [];
    const consume = (async () => {
      for await (const ev of service.run(request('req-cancel'), { signal: controller.signal })) {
        events.push(ev);
        if (ev.status === 'running') controller.abort();
      }
    })();

    await consume;
    expect(sawCancel).toBe(true);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: 'error', request_id: 'req-cancel', status: 'cancelled' }));
    await service.shutdown();
  });

  it('restarts the worker after a crash', async () => {
    let spawnCount = 0;
    const service = createRuntimeWorkerService({
      handshakeTimeoutMs: 500,
      spawnWorker: () => {
        spawnCount += 1;
        return makeChild((msg, child) => {
          if (msg.type === 'hello') write(child, { type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, capabilities: ['run'] });
          if (msg.type === 'run' && spawnCount === 1) child.exitNow(1);
          if (msg.type === 'run' && spawnCount === 2) write(child, { type: 'result', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, status: 'completed', text: 'after restart' });
        });
      },
    });

    await expect(collect(service.run(request('req-crash')))).rejects.toThrow(/exited/);
    const events = await collect(service.run(request('req-after-crash')));

    expect(spawnCount).toBe(2);
    expect(events.at(-1)?.text).toBe('after restart');
    await service.shutdown();
  });

  it('does not dispatch a run request when the signal is already aborted', async () => {
    const service = createRuntimeWorkerService({
      handshakeTimeoutMs: 500,
      spawnWorker: () => makeChild((msg, child) => {
        if (msg.type === 'hello') write(child, { type: 'hello', protocol_version: COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION, capabilities: ['run', 'cancel'] });
        if (msg.type === 'run') write(child, { type: 'result', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, status: 'completed', text: 'should not run' });
      }),
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(service.run(request('req-pre-abort'), { signal: controller.signal }));

    expect(events).toEqual([expect.objectContaining({ type: 'error', request_id: 'req-pre-abort', status: 'cancelled' })]);
    expect(children[0].sent.filter((m: any) => m.type === 'run')).toHaveLength(0);
    await service.shutdown();
  });

});
