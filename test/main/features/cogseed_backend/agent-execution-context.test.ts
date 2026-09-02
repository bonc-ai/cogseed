import { describe, expect, it, vi } from 'vitest';

import {
  buildCogSeedAgentRuntimeContext,
  resolveCogSeedAgentExecutionContext,
} from '../../../../src/main/features/cogseed_backend/agent-execution-context';
import { buildCogSeedAgentRegistryProjection } from '../../../../src/main/features/cogseed_backend/agent-registry-projection';

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
      listCliEntries: vi.fn(async () => [{ type: cli, available: true }]),
      listPeers: vi.fn(async () => []),
    })).rejects.toThrow(/not executable/i);
  });
});

/**
 * The gate used to check `enabled`, existence and runtime support only. It was
 * written around the in-process shape, where `installed` and `online` are
 * constants — so an uninstalled CLI or an unreachable peer was admitted and the
 * run failed later, mid-execution, instead of at submit time.
 */
describe('CogSeed Agent execution admission eligibility', () => {
  const admit = (
    agent: Record<string, unknown>,
    host: { cli?: Array<{ type: string; available: boolean }>; peers?: Array<Record<string, unknown>> } = {},
  ) => resolveCogSeedAgentExecutionContext('user-admission', String(agent.agent_id), 'cid-admission', {
    getAgentForChatDispatch: vi.fn(async () => agent) as any,
    isAgentEnabled: vi.fn(() => agent.enabled !== false),
    listCliEntries: vi.fn(async () => host.cli ?? []),
    listPeers: vi.fn(async () => (host.peers ?? []) as never),
  });

  const inProcess = { agent_id: 'agent-native', name: 'Native', workflow: 'Work.', runtime: { kind: 'in_process' } };
  const localCli = { agent_id: 'agent-cli', name: 'Codex', workflow: 'Work.', runtime: { kind: 'cli', cli: 'codex' } };
  const gateway = { agent_id: 'agent-gw', name: 'Gateway', workflow: 'Work.', runtime: { kind: 'p3394-gateway', cli: 'claude' } };

  it('admits an in-process Agent without touching host discovery', async () => {
    const listCliEntries = vi.fn(async () => []);
    const listPeers = vi.fn(async () => []);
    await expect(resolveCogSeedAgentExecutionContext('user-admission', 'agent-native', 'cid-admission', {
      getAgentForChatDispatch: vi.fn(async () => inProcess) as any,
      isAgentEnabled: vi.fn(() => true),
      listCliEntries,
      listPeers,
    })).resolves.toMatchObject({ agentId: 'agent-native', runtime: { kind: 'in_process' } });
    // `installed` and `online` are identities for in-process Agents, so the
    // common dispatch path must not pay for CLI probing or peer listing.
    expect(listCliEntries).not.toHaveBeenCalled();
    expect(listPeers).not.toHaveBeenCalled();
  });

  it('admits an installed local CLI Agent', async () => {
    await expect(admit(localCli, { cli: [{ type: 'codex', available: true }] }))
      .resolves.toMatchObject({ agentId: 'agent-cli', runtime: { kind: 'cli', cli: 'codex' } });
  });

  it('admits a gateway-backed Agent whose peer is online', async () => {
    await expect(admit(gateway, { peers: [{ agent_id: 'agent-gw', online: true }] }))
      .resolves.toMatchObject({ agentId: 'agent-gw' });
  });

  it('rejects an uninstalled local CLI Agent', async () => {
    await expect(admit(localCli, { cli: [{ type: 'codex', available: false }] }))
      .rejects.toMatchObject({ message: 'CogSeed Agent is unavailable', reasonCode: 'not_installed' });
  });

  it('rejects a gateway-backed Agent whose peer is offline', async () => {
    await expect(admit(gateway, { peers: [{ agent_id: 'agent-gw', online: false }] }))
      .rejects.toMatchObject({ message: 'CogSeed Agent is unavailable', reasonCode: 'offline' });
  });

  it('rejects an Agent whose peer is disabled', async () => {
    await expect(admit(gateway, { peers: [{ agent_id: 'agent-gw', online: true, disabled: true }] }))
      .rejects.toMatchObject({ reasonCode: 'peer_disabled' });
  });

  it('rejects a management-only identity', async () => {
    await expect(admit({ ...inProcess, agent_id: 'agent-workbench', interaction_mode: 'management_only' }))
      .rejects.toMatchObject({ message: 'CogSeed Agent is unavailable', reasonCode: 'management_only' });
  });

  it('rejects a disabled Agent', async () => {
    await expect(admit({ ...inProcess, enabled: false }))
      .rejects.toMatchObject({ reasonCode: 'disabled' });
  });

  it('rejects an unsupported runtime with its own message', async () => {
    await expect(admit({ ...localCli, runtime: { kind: 'cli', cli: 'gemini' } }, { cli: [{ type: 'gemini', available: true }] }))
      .rejects.toMatchObject({ message: 'CogSeed Agent runtime is not executable', reasonCode: 'unsupported_runtime' });
  });
});

/**
 * The contract this task exists to establish: one set of Agent facts must
 * produce the same dispatchability answer on both surfaces. They used to
 * disagree in both directions — the projection knew about install and
 * reachability that the gate ignored, and the gate rejected management
 * identities the projection advertised.
 */
describe('registry projection and execution admission agree', () => {
  const cliEntries = [
    { type: 'codex', available: true },
    { type: 'openclaw', available: false },
  ];
  const peers = [
    { agent_id: 'gw-online', online: true },
    { agent_id: 'gw-offline', online: false },
    { agent_id: 'gw-blocked', online: true, disabled: true },
  ];
  const definitions = [
    { agent_id: 'native-ok', name: 'Native', enabled: true, source: 'custom', runtime: { kind: 'in_process' } },
    { agent_id: 'native-workbench', name: 'Workbench', enabled: true, source: 'marketplace', runtime: { kind: 'in_process' }, interaction_mode: 'management_only' },
    { agent_id: 'cli-ok', name: 'Codex', enabled: true, source: 'custom', runtime: { kind: 'cli', cli: 'codex' } },
    { agent_id: 'cli-missing', name: 'OpenClaw', enabled: true, source: 'custom', runtime: { kind: 'cli', cli: 'openclaw' } },
    { agent_id: 'cli-unsupported', name: 'Gemini', enabled: true, source: 'custom', runtime: { kind: 'cli', cli: 'gemini' } },
    { agent_id: 'gw-online', name: 'Gateway online', enabled: true, source: 'custom', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
    { agent_id: 'gw-offline', name: 'Gateway offline', enabled: true, source: 'custom', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
    { agent_id: 'gw-blocked', name: 'Gateway blocked', enabled: true, source: 'custom', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
    { agent_id: 'native-off', name: 'Disabled', enabled: false, source: 'custom', runtime: { kind: 'in_process' } },
  ];

  it('reaches the same dispatchability verdict for every source kind', async () => {
    const projection = await buildCogSeedAgentRegistryProjection('user-consistency', {
      listAgentSummaries: vi.fn(async () => definitions) as never,
      detectAll: vi.fn(async () => cliEntries) as never,
      listTasks: vi.fn(async () => []) as never,
      listChannels: vi.fn(async () => []) as never,
      listPeers: vi.fn(() => peers) as never,
      listGateways: vi.fn(() => []) as never,
      listRemoteNodes: vi.fn(() => ({ nodes: [] })) as never,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    for (const definition of definitions) {
      const projected = projection.agents.find((agent) => agent.agentId === definition.agent_id);
      expect(projected, definition.agent_id).toBeDefined();

      const admitted = await resolveCogSeedAgentExecutionContext(
        'user-consistency',
        definition.agent_id,
        'cid-consistency',
        {
          getAgentForChatDispatch: vi.fn(async () => ({ ...definition, workflow: 'Work.' })) as never,
          isAgentEnabled: vi.fn(() => definition.enabled !== false),
          listCliEntries: vi.fn(async () => cliEntries),
          listPeers: vi.fn(async () => peers),
        },
      ).then(() => ({ ok: true, reasonCode: undefined as string | undefined }))
        .catch((error: { reasonCode?: string }) => ({ ok: false, reasonCode: error.reasonCode }));

      expect(admitted.ok, `${definition.agent_id} dispatchability`).toBe(projected!.dispatchable);
      expect(admitted.reasonCode, `${definition.agent_id} reason`).toBe(projected!.eligibilityReason);
    }
  });
});
