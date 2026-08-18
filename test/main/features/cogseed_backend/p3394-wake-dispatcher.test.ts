import { beforeEach, describe, expect, it, vi } from 'vitest';

const startCogSeedTask = vi.fn(async () => ({ status: 'running' }));
const cancelCogSeedTask = vi.fn();
const resolveCogSeedAgentExecutionContext = vi.fn(async () => ({
  agentId: 'agent-1',
  agentName: 'Formal Agent',
  workflow: 'Follow the formal workflow.',
  skillList: ['skill-one'],
  interactive: true,
  runtime: { kind: 'in_process' as const },
}));

vi.mock('../../../../src/main/features/cogseed_backend/runtime-controller', () => ({
  cogseedRuntimeController: { startCogSeedTask, cancelCogSeedTask },
}));

vi.mock('../../../../src/main/features/cogseed_backend/coordinator', () => ({
  readCogSeedCoordination: vi.fn(),
}));

vi.mock('../../../../src/main/features/cogseed_backend/agent-execution-context', () => ({
  resolveCogSeedAgentExecutionContext,
  buildCogSeedAgentRuntimeContext: vi.fn(() => [
    { type: 'text', label: 'Formal Agent execution context', content: 'Follow the formal workflow.' },
  ]),
}));

describe('CogSeed P3394 wake dispatcher', () => {
  beforeEach(() => {
    startCogSeedTask.mockClear();
    cancelCogSeedTask.mockClear();
    resolveCogSeedAgentExecutionContext.mockReset();
    resolveCogSeedAgentExecutionContext.mockResolvedValue({
      agentId: 'agent-1',
      agentName: 'Formal Agent',
      workflow: 'Follow the formal workflow.',
      skillList: ['skill-one'],
      interactive: true,
      runtime: { kind: 'in_process' as const },
      knowhow: [],
      standards: [],
    });
  });

  it('falls back to a direct CogSeed task for legacy interactive handoffs with a conversation scope', async () => {
    const { cogseedWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await cogseedWakeDispatcher.dispatch('user-1', {
      id: 'wake-1',
      conversation_id: 'cid-1',
      execution_domain: 'group_chat',
      execution_scope_id: 'cid-1',
      workflow_step_id: 'wstep-1',
      agent_id: 'agent-1',
      source: 'hand_off_to',
      source_actor_id: 'commander',
      objective: 'Continue interactively',
      context_scope: ['conversation:cid-1'],
      behavior_scope: ['hand_off_to'],
      dispatch_payload: { text: 'Continue interactively' },
      status: 'approved',
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-11T00:00:00.000Z',
    });

    expect(startCogSeedTask).toHaveBeenCalledWith('user-1', expect.objectContaining({
      requestId: 'req-wake-wake-1',
      sessionId: 'gconv-cid-1',
      agentId: 'agent-1',
      task: 'Continue interactively',
      conversationId: 'cid-1',
      executionKind: 'cogseed-native',
      allowedSkillIds: ['skill-one'],
      context: [{ type: 'text', label: 'Formal Agent execution context', content: 'Follow the formal workflow.' }],
    }));
    expect(startCogSeedTask.mock.calls[0]?.[1]).not.toHaveProperty('profileId');
  });

  it('runs a P3394 gateway Agent through the real local CLI adapter', async () => {
    resolveCogSeedAgentExecutionContext.mockResolvedValueOnce({
      agentId: 'external-1',
      agentName: 'ClaudeCode',
      workflow: '',
      interactive: true,
      runtime: {
        kind: 'p3394-gateway',
        cli: 'claude',
        model: 'claude-opus-4-7',
        custom_args: ['--debug'],
        cli_provider_id: 'cp:external-claude',
      },
      knowhow: [],
      standards: [],
    } as any);
    const { cogseedWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await cogseedWakeDispatcher.dispatch('user-1', {
      id: 'wake-external-1',
      conversation_id: 'cid-1',
      execution_domain: 'group_chat',
      execution_scope_id: 'cid-1',
      agent_id: 'external-1',
      source: 'user_mention',
      source_actor_id: 'user',
      objective: 'Reply through the real CLI',
      context_scope: ['conversation:cid-1'],
      behavior_scope: ['user_mention'],
      dispatch_payload: { text: 'Reply through the real CLI' },
      status: 'approved',
      created_at: '2026-08-17T00:00:00.000Z',
      updated_at: '2026-08-17T00:00:00.000Z',
    });

    expect(startCogSeedTask).toHaveBeenCalledWith('user-1', expect.objectContaining({
      agentId: 'external-1',
      executionKind: 'local-cli',
      localCli: {
        cli: 'claude',
        agentName: 'ClaudeCode',
        model: 'claude-opus-4-7',
        customArgs: ['--debug'],
        cliProviderId: 'cp:external-claude',
        viaP3394Gateway: true,
      },
    }));
  });
});
