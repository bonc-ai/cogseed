import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

  it('injects a workspace-local ws- skill from the current workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-agent-skill-'));
    const skill = path.join(workspace, '.cogseed', 'skills', 'demo');
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: demo\ndescription: Workspace demo.\n---\nUse the workspace demo.');
    try {
      const resolved = await resolveCogSeedAgentExecutionContext('user-context', 'agent-context', 'cid-context', {
        getAgentForChatDispatch: vi.fn(async () => ({
          agent_id: 'agent-context',
          name: 'Context Agent',
          workflow: 'Do the work.',
          skill_list: ['ws-demo'],
          runtime: { kind: 'in_process' as const },
          profile: { role: 'Researcher', knowhow: [], standards: [] },
        })) as any,
        isAgentEnabled: () => true,
        getWorkspacePath: async () => workspace,
      });
      expect(resolved.skillInstructions).toEqual([
        expect.objectContaining({ label: 'Authorized skill instructions: ws-demo', content: expect.stringContaining('Use the workspace demo.') }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('injects workspace AGENTS.md after the Agent identity/instructions', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-agent-context-'));
    try {
      fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Always cite the source document.');
      const resolved = await resolveCogSeedAgentExecutionContext('user-context', 'agent-context', 'cid-context', {
        getAgentForChatDispatch: vi.fn(async () => ({
          agent_id: 'agent-context',
          name: 'Context Agent',
          workflow: 'Do the work.',
          runtime: { kind: 'in_process' as const },
          profile: { role: 'Researcher', knowhow: [], standards: [] },
        })) as any,
        isAgentEnabled: () => true,
        getWorkspacePath: async () => workspace,
      });
      expect(resolved.workspaceInstructions).toEqual([
        expect.objectContaining({ label: 'Workspace instructions: AGENTS.md', content: 'Always cite the source document.' }),
      ]);
      expect(buildCogSeedAgentRuntimeContext(resolved)).toEqual([
        expect.objectContaining({
          content: expect.stringContaining('Always cite the source document.'),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('injects only enabled skills from the persisted allowlist so continuations need no discovery reads', async () => {
    const skills = await import('../../../../src/main/features/skills');
    const listing = vi.spyOn(skills, 'listSkillsForUser').mockResolvedValue([
      { id: 'allowed', enabled: true, source: 'custom' },
      { id: 'disabled', enabled: false, source: 'marketplace' },
      { id: 'unrelated', enabled: true, source: 'marketplace' },
    ] as any);
    const read = vi.spyOn(skills, 'readSkillFileForUser').mockResolvedValue({ ok: true, content: 'Follow verified evidence.', path: 'SKILL.md', ext: 'md' });
    try {
      const resolved = await resolveCogSeedAgentExecutionContext('user-context', 'agent-context', 'cid-context', {
        getAgentForChatDispatch: vi.fn(async () => ({ agent_id: 'agent-context', name: 'Agent', workflow: '', skill_list: ['allowed', 'disabled'] })) as any,
        isAgentEnabled: () => true,
      });
      expect(read).toHaveBeenCalledExactlyOnceWith('user-context', 'custom', 'allowed');
      expect(buildCogSeedAgentRuntimeContext(resolved)).toContainEqual(expect.objectContaining({ label: 'Authorized skill instructions: allowed', content: expect.stringContaining('Follow verified evidence.') }));
    } finally { listing.mockRestore(); read.mockRestore(); }
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
