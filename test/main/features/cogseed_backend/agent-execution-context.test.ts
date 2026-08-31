import { describe, expect, it, vi } from 'vitest';

import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
} from '../../../../src/main/features/cogseed_backend/agent-execution-context';

describe('CogSeed formal Agent execution context', () => {
  it('derives workflow, skills, runtime, and interactive semantics from the persisted Agent', async () => {
    const getAgentForChatDispatch = vi.fn(async () => ({
      agent_id: 'agent-context',
      name: 'Context Agent',
      description_zh: '',
      description_en: 'A formal Agent.',
      workflow: '1. Inspect inputs.\n2. Produce the result.',
      skill_list: ['skill-alpha', 'skill-beta'],
      runtime: { kind: 'in_process' as const },
      interactive: false,
      category: 'general',
      profile: { role: 'Researcher', knowhow: ['Source checking'], standards: ['Cite evidence'] },
    }));

    const resolved = await resolveCogSeedAgentExecutionContext('user-context', 'agent-context', 'cid-context', {
      getAgentForChatDispatch: getAgentForChatDispatch as any,
      isAgentEnabled: vi.fn(() => true),
    });

    expect(resolved).toMatchObject({
      agentId: 'agent-context',
      agentName: 'Context Agent',
      workflow: expect.stringContaining('Inspect inputs'),
      skillList: ['skill-alpha', 'skill-beta'],
      interactive: true,
      runtime: { kind: 'in_process' },
    });
    const context = buildCogSeedAgentRuntimeContext(resolved);
    expect(context).toEqual([
      expect.objectContaining({
        type: 'text',
        label: 'Formal Agent execution context',
        content: expect.stringContaining('Cite evidence'),
      }),
    ]);
    expect(JSON.stringify(context)).toContain('skill-alpha');
  });

  it('rejects unavailable or management-only Agents before task admission', async () => {
    await expect(resolveCogSeedAgentExecutionContext('user-context', 'agent-missing', 'cid-context', {
      getAgentForChatDispatch: vi.fn(async () => null),
      isAgentEnabled: vi.fn(() => true),
    })).rejects.toThrow(/unavailable/i);
  });

  it.each(['gemini', 'aider'])('keeps discovered %s CLI Agents out of execution admission', async (cli) => {
    await expect(resolveCogSeedAgentExecutionContext('user-context', `agent-${cli}`, 'cid-context', {
      getAgentForChatDispatch: vi.fn(async () => ({
        agent_id: `agent-${cli}`,
        name: `${cli} Agent`,
        workflow: 'Draft only.',
        category: 'general',
        runtime: { kind: 'cli', cli },
      }) as any),
      isAgentEnabled: vi.fn(() => true),
    })).rejects.toThrow(/not executable/i);
  });
});
