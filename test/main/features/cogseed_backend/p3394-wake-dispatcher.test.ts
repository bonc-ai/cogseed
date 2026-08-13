import { describe, expect, it, vi } from 'vitest';

const startMateTask = vi.fn(async () => ({ status: 'running' }));
const cancelMateTask = vi.fn();
const resolveCogSeedAgentExecutionContext = vi.fn(async () => ({
  agentId: 'agent-1',
  agentName: 'Formal Agent',
  workflow: 'Follow the formal workflow.',
  skillList: ['skill-one'],
  interactive: true,
  runtime: { kind: 'in_process' as const },
}));

vi.mock('../../../../src/main/features/cogseed_backend/runtime-controller', () => ({
  mateRuntimeController: { startMateTask, cancelMateTask },
}));

vi.mock('../../../../src/main/features/cogseed_backend/coordinator', () => ({
  readMateCoordination: vi.fn(),
}));

vi.mock('../../../../src/main/features/cogseed_backend/agent-execution-context', () => ({
  resolveCogSeedAgentExecutionContext,
  buildCogSeedAgentRuntimeContext: vi.fn(() => [
    { type: 'text', label: 'Formal Agent execution context', content: 'Follow the formal workflow.' },
  ]),
}));

describe('CogSeed P3394 wake dispatcher', () => {
  it('falls back to a direct CogSeed task for legacy interactive handoffs with a conversation scope', async () => {
    const { mateWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await mateWakeDispatcher.dispatch('user-1', {
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

    expect(startMateTask).toHaveBeenCalledWith('user-1', expect.objectContaining({
      requestId: 'req-wake-wake-1',
      sessionId: 'gconv-cid-1',
      agentId: 'agent-1',
      task: 'Continue interactively',
      conversationId: 'cid-1',
      executionKind: 'cogseed-native',
      allowedSkillIds: ['skill-one'],
      context: [{ type: 'text', label: 'Formal Agent execution context', content: 'Follow the formal workflow.' }],
    }));
    expect(startMateTask.mock.calls[0]?.[1]).not.toHaveProperty('profileId');
  });
});
