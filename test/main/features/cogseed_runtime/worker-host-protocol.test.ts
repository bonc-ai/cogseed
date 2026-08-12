import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { MATE_AGENT_RUNTIME_PROTOCOL_VERSION, type RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';
import { createRuntimeWorkerService, type RuntimeWorkerChild } from '../../../../src/main/features/cogseed_runtime/worker-process';

function fakeChild(onMessage: (message: any, child: RuntimeWorkerChild) => void): RuntimeWorkerChild & { sent: any[] } {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const handlers = new Map<string, Array<(...args: any[]) => void>>(); const sent: any[] = [];
  const child: any = {
    stdin, stdout, stderr, sent, killed: false,
    kill() { child.killed = true; for (const fn of handlers.get('exit') || []) fn(0, null); return true; },
    on(event: string, fn: (...args: any[]) => void) { (handlers.get(event) || handlers.set(event, []).get(event)!).push(fn); return child; },
    once(event: string, fn: (...args: any[]) => void) { return child.on(event, fn); },
    off() { return child; },
  };
  stdin.on('data', (chunk) => String(chunk).split('\n').filter(Boolean).forEach((line) => { const msg = JSON.parse(line); sent.push(msg); onMessage(msg, child); }));
  return child;
}

function write(child: RuntimeWorkerChild, message: unknown) { child.stdout.write(JSON.stringify(message) + '\n'); }

it('dispatches worker host calls with the normalized pending request', async () => {
  let requestSeen: RuntimeRunRequest | undefined;
  const service = createRuntimeWorkerService({
    hostToolHandler: async (call, context) => { requestSeen = context.request; return { content: `host:${call.name}` }; },
    spawnWorker: () => fakeChild((msg, child) => {
      if (msg.type === 'hello') write(child, { type: 'hello', protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION, capabilities: ['mate-host-tools-v1'] });
      if (msg.type === 'run') write(child, { type: 'host_tool_call', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, call_id: 'host-call-1', name: 'office_read', input: { path: '/tmp/a.docx' } });
      if (msg.type === 'host_tool_result') write(child, { type: 'result', request_id: msg.request_id, runtime_session_id: msg.runtime_session_id, status: 'completed', text: msg.content });
    }),
  });
  const request: RuntimeRunRequest = {
    protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION, type: 'run', request_id: 'req-host-protocol', runtime_session_id: 'mruntime-host-protocol', user_id: 'host-user', task: 'host', context: [], attachments: [],
  };
  const events = [];
  for await (const event of service.run(request)) events.push(event);
  expect(requestSeen?.user_id).toBe('host-user');
  expect(events.at(-1)?.text).toBe('host:office_read');
  await service.shutdown();
});
