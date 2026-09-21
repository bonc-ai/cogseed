import { beforeEach, describe, expect, it, vi } from 'vitest';

const startCogSeedTask = vi.fn(async () => ({ status: 'running' }));
const cancelCogSeedTask = vi.fn();
const getConversationWorkspacePath = vi.fn(async () => '/tmp/wake-conversation-workspace');
const resolveCogSeedLocalCliWorkingDir = vi.fn(async () => '/tmp/wake-conversation-workspace');
const resolveCogSeedAgentExecutionContext = vi.fn(async () => ({
  agentId: 'agent-1',
  agentName: 'Formal Agent',
  workflow: 'Follow the formal workflow.',
  skillList: ['skill-one'],
  interactive: true,
  runtime: { kind: 'in_process' as const },
}));
const readGroupChatRun = vi.fn(async () => null as any);
const recordRunDispatch = vi.fn(async () => null);

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
vi.mock('../../../../src/main/features/group_chat/conv_workspace', () => ({
  getConversationWorkspacePath,
}));
vi.mock('../../../../src/main/features/cogseed_backend/local-cli-execution-adapter', () => ({
  resolveCogSeedLocalCliWorkingDir,
}));
vi.mock('../../../../src/main/features/group_chat/run_store', () => ({
  readRun: readGroupChatRun,
  recordRunDispatch,
}));

describe('CogSeed P3394 wake dispatcher', () => {
  beforeEach(() => {
    startCogSeedTask.mockClear();
    cancelCogSeedTask.mockClear();
    getConversationWorkspacePath.mockClear();
    resolveCogSeedLocalCliWorkingDir.mockClear();
    readGroupChatRun.mockReset();
    readGroupChatRun.mockResolvedValue(null);
    recordRunDispatch.mockReset();
    recordRunDispatch.mockResolvedValue(null);
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
      dispatch_payload: { text: 'Reply through the real CLI', asset_ids: ['asset-approved'] },
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
      workingDir: '/tmp/wake-conversation-workspace',
      abilityAssetIds: ['asset-approved'],
    }));
    expect(resolveCogSeedLocalCliWorkingDir).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'cid-1',
      agentId: 'external-1',
    });
  });

  it('checks the durable run stop before a late Wake can start the removed actor', async () => {
    readGroupChatRun.mockResolvedValueOnce({
      run_id: 'run-stopped-1',
      status: 'running',
      requires_sequential: false,
      actors: [{ agent_id: 'agent-1', terminal: 'removed', reason: 'member_removed' }],
    });
    const { cogseedWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await expect(cogseedWakeDispatcher.dispatch('user-1', {
      id: 'wake-late-removed',
      conversation_id: 'cid-1',
      execution_domain: 'group_chat',
      execution_scope_id: 'cid-1',
      agent_id: 'agent-1',
      source: 'user_mention',
      source_actor_id: 'user',
      objective: 'Must not start after removal',
      context_scope: ['conversation:cid-1'],
      behavior_scope: ['user_mention'],
      dispatch_payload: {
        text: 'Must not start after removal',
        run_id: 'run-stopped-1',
      },
      status: 'approved',
      created_at: '2026-09-21T00:00:00.000Z',
      updated_at: '2026-09-21T00:00:00.000Z',
    })).rejects.toThrow(/stopped|removed/i);

    expect(startCogSeedTask).not.toHaveBeenCalled();
    expect(recordRunDispatch).not.toHaveBeenCalled();
  });

  it('fails closed when a Wake references a missing or unreadable run', async () => {
    readGroupChatRun.mockResolvedValueOnce(null);
    const { cogseedWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await expect(cogseedWakeDispatcher.dispatch('user-1', {
      id: 'wake-missing-ledger',
      conversation_id: 'cid-1',
      execution_domain: 'group_chat',
      execution_scope_id: 'cid-1',
      agent_id: 'agent-1',
      source: 'user_mention',
      source_actor_id: 'user',
      objective: 'Must not start without its run',
      context_scope: ['conversation:cid-1'],
      behavior_scope: ['user_mention'],
      dispatch_payload: { text: 'Must not start without its run', run_id: 'run-missing-1' },
      status: 'approved',
      created_at: '2026-09-21T00:00:00.000Z',
      updated_at: '2026-09-21T00:00:00.000Z',
    })).rejects.toThrow(/run.*unavailable|ledger/i);

    expect(recordRunDispatch).not.toHaveBeenCalled();
    expect(startCogSeedTask).not.toHaveBeenCalled();
  });

  it('persists the Wake dispatch before starting its backend task', async () => {
    const before = {
      run_id: 'run-ledger-success',
      status: 'running',
      actors: [{ agent_id: 'agent-1', terminal: 'pending', dispatched: [] }],
    };
    const after = {
      ...before,
      actors: [{
        agent_id: 'agent-1',
        terminal: 'pending',
        dispatched: ['turn-wake-wake-ledger-success'],
      }],
    };
    readGroupChatRun.mockResolvedValueOnce(before);
    recordRunDispatch.mockResolvedValueOnce(after);
    const { cogseedWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await cogseedWakeDispatcher.dispatch('user-1', {
      id: 'wake-ledger-success',
      conversation_id: 'cid-1',
      execution_domain: 'group_chat',
      execution_scope_id: 'cid-1',
      agent_id: 'agent-1',
      source: 'user_mention',
      source_actor_id: 'user',
      objective: 'Start only after persistence',
      context_scope: ['conversation:cid-1'],
      behavior_scope: ['user_mention'],
      dispatch_payload: { text: 'Start only after persistence', run_id: 'run-ledger-success' },
      status: 'approved',
      created_at: '2026-09-21T00:00:00.000Z',
      updated_at: '2026-09-21T00:00:00.000Z',
    });

    expect(recordRunDispatch).toHaveBeenCalledWith(
      'user-1',
      'cid-1',
      'run-ledger-success',
      'agent-1',
      'turn-wake-wake-ledger-success',
    );
    expect(recordRunDispatch.mock.invocationCallOrder[0])
      .toBeLessThan(startCogSeedTask.mock.invocationCallOrder[0]);
  });

  it('does not start a Wake task when durable dispatch persistence fails', async () => {
    readGroupChatRun.mockResolvedValueOnce({
      run_id: 'run-ledger-failure',
      status: 'running',
      actors: [{ agent_id: 'agent-1', terminal: 'pending', dispatched: [] }],
    });
    recordRunDispatch.mockResolvedValueOnce(null);
    const { cogseedWakeDispatcher } = await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    await expect(cogseedWakeDispatcher.dispatch('user-1', {
      id: 'wake-ledger-failure',
      conversation_id: 'cid-1',
      execution_domain: 'group_chat',
      execution_scope_id: 'cid-1',
      agent_id: 'agent-1',
      source: 'user_mention',
      source_actor_id: 'user',
      objective: 'Do not start after write failure',
      context_scope: ['conversation:cid-1'],
      behavior_scope: ['user_mention'],
      dispatch_payload: { text: 'Do not start after write failure', run_id: 'run-ledger-failure' },
      status: 'approved',
      created_at: '2026-09-21T00:00:00.000Z',
      updated_at: '2026-09-21T00:00:00.000Z',
    })).rejects.toThrow(/dispatch.*persist|ledger/i);

    expect(startCogSeedTask).not.toHaveBeenCalled();
  });
});
