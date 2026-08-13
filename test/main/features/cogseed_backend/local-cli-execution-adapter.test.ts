import { describe, expect, it, vi } from 'vitest';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

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
});
