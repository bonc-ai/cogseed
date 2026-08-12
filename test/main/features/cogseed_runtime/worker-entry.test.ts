import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as path from 'node:path';

import { MATE_AGENT_RUNTIME_PROTOCOL_VERSION, type RuntimeRunRequest } from '../../../../src/main/features/cogseed_runtime/protocol';

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill();
  }
});

function startEchoWorker(): { child: ChildProcessWithoutNullStreams; nextLine: () => Promise<any> } {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'bin', 'cogseed-runtime-worker.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ORKAS_PC_DIR: process.cwd(),
      ORKAS_MATE_RUNTIME_TEST_ECHO: '1',
    },
  });
  children.push(child);
  const rl = createInterface({ input: child.stdout });
  const queue: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  rl.on('line', (line) => {
    const parsed = JSON.parse(line);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  return {
    child,
    nextLine: () => {
      const existing = queue.shift();
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

describe('cogseed-runtime-worker.cjs', () => {
  it('speaks protocol JSONL on stdout and keeps task output correlated', async () => {
    const { child, nextLine } = startEchoWorker();
    child.stdin.write(`${JSON.stringify({ type: 'hello', protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION })}\n`);
    expect(await nextLine()).toEqual({
      type: 'hello',
      protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
      capabilities: ['run', 'cancel', 'health', 'shutdown', 'mate-host-tools-v1'],
    });

    const req: RuntimeRunRequest = {
      protocol_version: MATE_AGENT_RUNTIME_PROTOCOL_VERSION,
      type: 'run',
      request_id: 'req-entry',
      runtime_session_id: 'mruntime-entry',
      user_id: 'runtime-entry-user',
      task: 'echo body',
      context: [],
      attachments: [],
    };
    child.stdin.write(`${JSON.stringify(req)}\n`);

    expect(await nextLine()).toEqual(expect.objectContaining({ type: 'event', request_id: 'req-entry', status: 'started' }));
    expect(await nextLine()).toEqual(expect.objectContaining({ type: 'result', request_id: 'req-entry', runtime_session_id: 'mruntime-entry', status: 'completed', text: 'echo body' }));
  });
});
