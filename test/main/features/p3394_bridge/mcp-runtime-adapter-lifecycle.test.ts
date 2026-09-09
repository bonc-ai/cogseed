import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const processMocks = vi.hoisted(() => ({
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('../../../../src/main/features/local_agents/backends/base', () => processMocks);

import { P3394McpRuntimeAdapter } from '../../../../src/main/features/p3394_bridge/mcp-runtime-adapter';

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeMcpChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  let buffered = '';
  stdin.on('data', (chunk) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffered.slice(0, newline)) as { id: number; method: string; params?: { arguments?: { session_id?: string } } };
      buffered = buffered.slice(newline + 1);
      const result = request.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
        : { content: [{ type: 'text', text: JSON.stringify({ native_session_id: `native-${request.params?.arguments?.session_id}` }) }] };
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    }
  });
  return child;
}

describe('P3394 MCP runtime process lifecycle', () => {
  beforeEach(() => {
    processMocks.spawnCli.mockReset();
    processMocks.killProcessTree.mockReset();
  });

  it('launches through the shared CLI resolver with cwd and environment additions', async () => {
    const child = fakeMcpChild();
    processMocks.spawnCli.mockReturnValue(child);
    processMocks.killProcessTree.mockResolvedValue(undefined);
    const adapter = new P3394McpRuntimeAdapter({
      command: 'runtime.cmd',
      args: ['--stdio'],
      env: { P3394_TEST_TOKEN: 'from-env' },
    });

    try {
      await adapter.openSession({ session_id: 'session-1', agent_id: 'agent-1' });
      expect(processMocks.spawnCli).toHaveBeenCalledWith(
        'runtime.cmd',
        ['--stdio'],
        process.cwd(),
        expect.objectContaining({ P3394_TEST_TOKEN: 'from-env' }),
      );
    } finally {
      await adapter.close();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it('does not resolve close until the shared tree-termination barrier completes', async () => {
    const child = fakeMcpChild();
    const killDone = deferredVoid();
    processMocks.spawnCli.mockReturnValue(child);
    processMocks.killProcessTree.mockReturnValue(killDone.promise);
    const adapter = new P3394McpRuntimeAdapter({ command: 'runtime.cmd' });
    await adapter.openSession({ session_id: 'session-2', agent_id: 'agent-2' });

    let settled = false;
    const closing = adapter.close().then(() => { settled = true; });
    await Promise.resolve();

    expect(processMocks.killProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
    expect(settled).toBe(false);

    killDone.resolve();
    await closing;
    expect(settled).toBe(true);
    child.stdout.destroy();
    child.stderr.destroy();
  });
});
