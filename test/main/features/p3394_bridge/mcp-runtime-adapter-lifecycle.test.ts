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

interface FakeMcpChildOptions {
  initializeError?: string;
  respondToTools?: boolean;
  onRequest?: (request: { id: number; method: string }) => void;
}

function fakeMcpChild(options: FakeMcpChildOptions = {}) {
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
      options.onRequest?.(request);
      if (request.method !== 'initialize' && options.respondToTools === false) continue;
      if (request.method === 'initialize' && options.initializeError) {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: options.initializeError } })}\n`);
        continue;
      }
      const result = request.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } }
        : { content: [{ type: 'text', text: JSON.stringify({ native_session_id: `native-${request.params?.arguments?.session_id}` }) }] };
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    }
  });
  return child;
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
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

  it.each([
    {
      name: 'error',
      emit: (child: ReturnType<typeof fakeMcpChild>) => child.emit('error', new Error('runtime transport failed')),
      expected: 'runtime transport failed',
    },
    {
      name: 'close',
      emit: (child: ReturnType<typeof fakeMcpChild>) => child.emit('close', 17, null),
      expected: 'p3394_mcp_runtime_closed',
    },
  ])('rejects pending RPCs and clears their timers on child $name', async ({ emit, expected }) => {
    vi.useFakeTimers();
    const toolRequestSeen = deferredVoid();
    const child = fakeMcpChild({
      respondToTools: false,
      onRequest: (request) => {
        if (request.method === 'tools/call') toolRequestSeen.resolve();
      },
    });
    // Keep EventEmitter's special error event from throwing before the adapter
    // has a chance to demonstrate whether it registered its lifecycle handler.
    child.on('error', () => {});
    processMocks.spawnCli.mockReturnValue(child);
    processMocks.killProcessTree.mockResolvedValue(undefined);
    const adapter = new P3394McpRuntimeAdapter({ command: 'runtime.cmd', requestTimeoutMs: 30_000 });
    let rejection: Error | null = null;
    const opening = adapter.openSession({ session_id: 'pending', agent_id: 'agent' }).catch((error: Error) => {
      rejection = error;
    });

    await toolRequestSeen.promise;
    emit(child);
    await flushPromises();
    const rejectionBeforeTimeout = rejection;
    const timersAfterFailure = vi.getTimerCount();

    await vi.runAllTimersAsync();
    await opening;
    await adapter.close();
    vi.useRealTimers();
    child.stdout.destroy();
    child.stderr.destroy();

    expect(rejectionBeforeTimeout?.message).toContain(expected);
    expect(timersAfterFailure).toBe(0);
  });

  it('terminates a child after initialization failure and starts cleanly on retry', async () => {
    const failedChild = fakeMcpChild({ initializeError: 'initialize rejected' });
    const healthyChild = fakeMcpChild();
    processMocks.spawnCli.mockReturnValueOnce(failedChild).mockReturnValueOnce(healthyChild);
    processMocks.killProcessTree.mockResolvedValue(undefined);
    const adapter = new P3394McpRuntimeAdapter({ command: 'runtime.cmd' });

    await expect(adapter.openSession({ session_id: 'first', agent_id: 'agent' })).rejects.toThrow('initialize rejected');
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(failedChild, 'SIGTERM');

    const binding = await adapter.openSession({ session_id: 'second', agent_id: 'agent' });
    expect(binding.native_session_id).toBe('native-second');
    expect(processMocks.spawnCli).toHaveBeenCalledTimes(2);

    await adapter.close();
    failedChild.stdout.destroy();
    failedChild.stderr.destroy();
    healthyChild.stdout.destroy();
    healthyChild.stderr.destroy();
  });

  it('deduplicates concurrent starts onto one child initialization', async () => {
    const child = fakeMcpChild();
    processMocks.spawnCli.mockReturnValue(child);
    processMocks.killProcessTree.mockResolvedValue(undefined);
    const adapter = new P3394McpRuntimeAdapter({ command: 'runtime.cmd' });

    const [first, second] = await Promise.all([
      adapter.openSession({ session_id: 'first', agent_id: 'agent' }),
      adapter.openSession({ session_id: 'second', agent_id: 'agent' }),
    ]);

    expect(first.native_session_id).toBe('native-first');
    expect(second.native_session_id).toBe('native-second');
    expect(processMocks.spawnCli).toHaveBeenCalledTimes(1);

    await adapter.close();
    child.stdout.destroy();
    child.stderr.destroy();
  });

  it('deduplicates concurrent close and rejects an in-flight RPC before the kill barrier resolves', async () => {
    vi.useFakeTimers();
    const toolRequestSeen = deferredVoid();
    const killDone = deferredVoid();
    const child = fakeMcpChild({
      respondToTools: false,
      onRequest: (request) => {
        if (request.method === 'tools/call') toolRequestSeen.resolve();
      },
    });
    processMocks.spawnCli.mockReturnValue(child);
    processMocks.killProcessTree.mockReturnValue(killDone.promise);
    const adapter = new P3394McpRuntimeAdapter({ command: 'runtime.cmd', requestTimeoutMs: 30_000 });
    let rejection: Error | null = null;
    const opening = adapter.openSession({ session_id: 'closing', agent_id: 'agent' }).catch((error: Error) => {
      rejection = error;
    });

    await toolRequestSeen.promise;
    const firstClose = adapter.close();
    const secondClose = adapter.close();
    await flushPromises();
    const rejectionBeforeTimeout = rejection;
    const timersWhileClosing = vi.getTimerCount();

    expect(processMocks.killProcessTree).toHaveBeenCalledTimes(1);
    killDone.resolve();
    await Promise.all([firstClose, secondClose]);
    await vi.runAllTimersAsync();
    await opening;
    vi.useRealTimers();
    child.stdout.destroy();
    child.stderr.destroy();

    expect(rejectionBeforeTimeout?.message).toContain('p3394_mcp_runtime_closed');
    expect(timersWhileClosing).toBe(0);
  });
});
