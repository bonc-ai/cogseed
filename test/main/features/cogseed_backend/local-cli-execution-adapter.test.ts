import { describe, expect, it, vi } from 'vitest';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

const chatsMock = vi.hoisted(() => ({
  getConversation: vi.fn(async () => null),
}));
const convWsMock = vi.hoisted(() => ({
  getConversationWorkspacePath: vi.fn(async () => '/tmp/space-ws/slug'),
}));
const agentsMock = vi.hoisted(() => ({
  getAgentCliProjectDirInfo: vi.fn(async () => null),
}));
const userWsMock = vi.hoisted(() => ({
  getWorkspacePath: vi.fn(() => '/tmp/root-ws'),
}));
const gatewayTurnMock = vi.hoisted(() => ({
  runP3394GatewayTurn: vi.fn(),
}));
vi.mock('../../../../src/main/features/p3394_bridge/p3394-gateway-turn', () => ({
  runP3394GatewayTurn: gatewayTurnMock.runP3394GatewayTurn,
}));
vi.mock('../../../../src/main/features/chats', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/chats')>()),
  getConversation: chatsMock.getConversation,
}));
vi.mock('../../../../src/main/features/group_chat/conv_workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/group_chat/conv_workspace')>()),
  getConversationWorkspacePath: convWsMock.getConversationWorkspacePath,
}));
vi.mock('../../../../src/main/features/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/agents')>()),
  getAgentCliProjectDirInfo: agentsMock.getAgentCliProjectDirInfo,
}));
vi.mock('../../../../src/main/features/user_workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/features/user_workspace')>()),
  getWorkspacePath: userWsMock.getWorkspacePath,
}));

describe('CogSeed Backend local CLI execution adapter', () => {
  it('maps runner events into Runtime envelopes and persists the external CLI session', async () => {
    const setSessionId = vi.fn(async () => {});
    const runCli = vi.fn(async (input: any) => {
      input.onEvent({ type: 'text-delta', text: 'working' });
      input.onEvent({ type: 'tool-event', tool: 'bash', phase: 'use' });
      input.onEvent({ type: 'tool-event', tool: 'bash', phase: 'result', output: 'ok' });
      input.onEvent({ type: 'done', status: 'completed', output: 'final CLI answer', sessionId: 'cli-session-1' });
      return { runId: 'run-cli-1', status: 'completed', output: 'final CLI answer', sessionId: 'cli-session-1' };
    });
    const { createMateLocalCliExecutionAdapter } = await import('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter');
    const adapter = createMateLocalCliExecutionAdapter({
      runCli,
      getSessionId: vi.fn(async () => null),
      setSessionId,
      clearSession: vi.fn(async () => {}),
      resolveWorkingDir: vi.fn(async () => '/tmp/project'),
    } as any);

    const events = await collect(adapter.run({
      userId: 'cli-adapter-user',
      conversationId: 'cid-cli-adapter',
      agentId: 'agent-cli-adapter',
      agentName: 'CLI Agent',
      requestId: 'req-cli-adapter',
      taskId: 'mate-task-cli-adapter',
      sessionId: 'mate-session-cli-adapter',
      runtimeSessionId: 'mruntime-cli-adapter',
      task: 'Implement the change.',
      context: [{ type: 'text', content: 'Follow the persisted workflow.' }],
      localCli: { cli: 'claude', model: 'sonnet', customArgs: ['--verbose'] },
    }, { signal: new AbortController().signal }));

    expect(runCli).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'cli-adapter-user',
      cid: 'cid-cli-adapter',
      agentId: 'agent-cli-adapter',
      cli: 'claude',
      model: 'sonnet',
      customArgs: ['--verbose'],
      prompt: expect.stringContaining('Implement the change.'),
      cwd: '/tmp/project',
    }));
    expect(events.map((event) => [event.type, event.status, event.metadata?.kernel_event])).toEqual([
      ['event', 'running', undefined],
      ['event', 'running', 'tool_call'],
      ['event', 'running', 'tool_result'],
      ['result', 'completed', undefined],
    ]);
    expect(setSessionId).toHaveBeenCalledWith(
      'cli-adapter-user', 'cid-cli-adapter', 'agent-cli-adapter', 'claude', 'cli-session-1',
    );
  });

  it('retries one rejected resume as a fresh continuation without changing the task text', async () => {
    const prompts: string[] = [];
    const clearSession = vi.fn(async () => {});
    const runCli = vi.fn(async (input: any) => {
      prompts.push(input.prompt);
      if (input.resumeSessionId) {
        input.onEvent({ type: 'stderr-line', line: 'session not found' });
        input.onEvent({ type: 'done', status: 'failed', error: 'resume failed' });
        return { runId: 'run-old', status: 'failed', error: 'resume failed' };
      }
      input.onEvent({ type: 'done', status: 'completed', output: 'fresh continuation', sessionId: 'cli-session-new' });
      return { runId: 'run-new', status: 'completed', output: 'fresh continuation', sessionId: 'cli-session-new' };
    });
    const { createMateLocalCliExecutionAdapter } = await import('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter');
    const adapter = createMateLocalCliExecutionAdapter({
      runCli,
      getSessionId: vi.fn(async () => 'cli-session-old'),
      setSessionId: vi.fn(async () => {}),
      clearSession,
      resolveWorkingDir: vi.fn(async () => '/tmp/project'),
    } as any);

    const events = await collect(adapter.run({
      userId: 'cli-adapter-user',
      conversationId: 'cid-cli-adapter',
      agentId: 'agent-cli-adapter',
      agentName: 'CLI Agent',
      requestId: 'req-cli-continuation',
      taskId: 'mate-task-cli-continuation',
      sessionId: 'mate-session-cli-continuation',
      runtimeSessionId: 'mruntime-cli-continuation',
      task: 'Only this continuation.',
      context: [],
      localCli: { cli: 'claude' },
    }, { signal: new AbortController().signal }));

    expect(runCli).toHaveBeenCalledTimes(2);
    expect(prompts).toEqual([prompts[0], prompts[0]]);
    expect(prompts[0]).toContain('Only this continuation.');
    expect(clearSession).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'completed', text: 'fresh continuation' });
  });

  it('defaults a space conversation working dir into the space workspace dir (spaces/<sid>/workspace/<slug>)', async () => {
    chatsMock.getConversation.mockResolvedValue({
      conversation_id: 'cid-space',
      space_id: 'sp_space_1',
      project_id: undefined,
    } as any);
    const runCli = vi.fn(async (input: any) => {
      input.onEvent({ type: 'done', status: 'completed', output: 'ok', sessionId: 'cli-session-space' });
      return { runId: 'run-space', status: 'completed', output: 'ok', sessionId: 'cli-session-space' };
    });
    const { createMateLocalCliExecutionAdapter } = await import('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter');
    const adapter = createMateLocalCliExecutionAdapter({
      runCli,
      getSessionId: vi.fn(async () => null),
      setSessionId: vi.fn(async () => {}),
      clearSession: vi.fn(async () => {}),
    } as any);

    await collect(adapter.run({
      userId: 'cli-adapter-user',
      conversationId: 'cid-space',
      agentId: 'agent-cli-adapter',
      agentName: 'CLI Agent',
      requestId: 'req-cli-space',
      taskId: 'mate-task-cli-space',
      sessionId: 'mate-session-cli-space',
      runtimeSessionId: 'mruntime-cli-space',
      task: 'Space task.',
      context: [],
      localCli: { cli: 'claude' },
    }, { signal: new AbortController().signal }));

    expect(convWsMock.getConversationWorkspacePath).toHaveBeenCalledWith('cli-adapter-user', 'cid-space');
    expect(runCli).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/space-ws/slug' }));
  });

  it('keeps an explicit agent custom project dir ahead of the space workspace dir', async () => {
    convWsMock.getConversationWorkspacePath.mockClear();
    chatsMock.getConversation.mockResolvedValue({
      conversation_id: 'cid-space-custom',
      space_id: 'sp_space_1',
      project_id: undefined,
    } as any);
    agentsMock.getAgentCliProjectDirInfo.mockResolvedValue({
      agent_id: 'agent-cli-adapter',
      is_coding: true,
      mode: 'custom',
      path: '/tmp/custom-repo',
      effective_path: '/tmp/custom-repo',
      workspace_path: '/tmp/root-ws',
      custom_path: '/tmp/custom-repo',
      exists: true,
    } as any);
    const runCli = vi.fn(async (input: any) => {
      input.onEvent({ type: 'done', status: 'completed', output: 'ok', sessionId: 'cli-session-custom' });
      return { runId: 'run-custom', status: 'completed', output: 'ok', sessionId: 'cli-session-custom' };
    });
    const { createMateLocalCliExecutionAdapter } = await import('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter');
    const adapter = createMateLocalCliExecutionAdapter({
      runCli,
      getSessionId: vi.fn(async () => null),
      setSessionId: vi.fn(async () => {}),
      clearSession: vi.fn(async () => {}),
    } as any);

    await collect(adapter.run({
      userId: 'cli-adapter-user',
      conversationId: 'cid-space-custom',
      agentId: 'agent-cli-adapter',
      agentName: 'CLI Agent',
      requestId: 'req-cli-custom',
      taskId: 'mate-task-cli-custom',
      sessionId: 'mate-session-cli-custom',
      runtimeSessionId: 'mruntime-cli-custom',
      task: 'Custom dir task.',
      context: [],
      localCli: { cli: 'claude' },
    }, { signal: new AbortController().signal }));

    expect(convWsMock.getConversationWorkspacePath).not.toHaveBeenCalled();
    expect(runCli).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/custom-repo' }));
  });

  it('routes a viaP3394Gateway config through the managed gateway and maps the reply', async () => {
    gatewayTurnMock.runP3394GatewayTurn.mockResolvedValueOnce({ text: 'gateway reply text' });
    const { createMateLocalCliExecutionAdapter } = await import('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter');
    const adapter = createMateLocalCliExecutionAdapter({ runCli: vi.fn() } as any);

    const events = await collect(adapter.run({
      userId: 'cli-adapter-user',
      conversationId: 'cid-cli-adapter',
      agentId: 'agent-cli-adapter',
      agentName: 'ClaudeCode',
      requestId: 'req-cli-gateway',
      taskId: 'mate-task-cli-gateway',
      sessionId: 'mate-session-cli-gateway',
      runtimeSessionId: 'mruntime-cli-gateway',
      task: 'Review this via gateway.',
      context: [],
      localCli: { cli: 'claude', agentName: 'ClaudeCode', viaP3394Gateway: true },
    }));

    expect(gatewayTurnMock.runP3394GatewayTurn).toHaveBeenCalledWith(expect.objectContaining({
      uid: 'cli-adapter-user',
      cid: 'cid-cli-adapter',
      cli: 'claude',
      prompt: expect.stringContaining('Review this via gateway.'),
    }));
    expect(events.at(-1)).toMatchObject({ type: 'result', status: 'completed', text: 'gateway reply text' });
  });

  it('maps a gateway failure to a failed runtime envelope with the failure code', async () => {
    gatewayTurnMock.runP3394GatewayTurn.mockResolvedValueOnce({
      text: '', failureCode: 'p3394_reply_timeout', error: 'timed out waiting for reply',
    });
    const { createMateLocalCliExecutionAdapter } = await import('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter');
    const adapter = createMateLocalCliExecutionAdapter({ runCli: vi.fn() } as any);

    const events = await collect(adapter.run({
      userId: 'cli-adapter-user',
      conversationId: 'cid-cli-adapter',
      agentId: 'agent-cli-adapter',
      agentName: 'ClaudeCode',
      requestId: 'req-cli-gw-fail',
      taskId: 'mate-task-cli-gw-fail',
      sessionId: 'mate-session-cli-gw-fail',
      runtimeSessionId: 'mruntime-cli-gw-fail',
      task: 'Fail via gateway.',
      context: [],
      localCli: { cli: 'claude', viaP3394Gateway: true },
    }));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      status: 'failed',
      metadata: { code: 'p3394_reply_timeout', p3394: true },
    });
  });
});
