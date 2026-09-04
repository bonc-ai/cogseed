// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import { buildCogSeedAgentRegistryProjection, resolveAgentEligibility } from '../../../../src/main/features/cogseed_backend/agent-registry-projection';

describe('CogSeed Agent Registry projection', () => {
  it('normalizes supported runtimes and excludes private execution data', async () => {
    const cliTypes = ['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy', 'gemini', 'aider'] as const;
    const projection = await buildCogSeedAgentRegistryProjection('registry-user', {
      listAgentSummaries: vi.fn(async () => [
        { agent_id: 'codex-agent', name: 'Bearer do-not-leak', enabled: true, source: '/Users/private/agent.json', runtime: { kind: 'cli', cli: 'codex' } },
        { agent_id: 'gemini-agent', name: 'Gemini draft', enabled: true, source: 'custom', runtime: { kind: 'cli', cli: 'gemini' } },
        { agent_id: 'commander', name: 'Commander', enabled: true, source: 'platform', runtime: { kind: 'in_process' } },
      ] as any),
      detectAll: vi.fn(async () => cliTypes.map((type) => ({
        type, path: `/Users/private/bin/${type}`, version: '1.0.0', available: true,
        auth: { loggedIn: true, mode: 'oauth' },
      })) as any),
      listTasks: vi.fn(async () => [{
        schemaVersion: 1, taskId: 'cogseed-task-private', sessionId: 'cogseed-session-private',
        runtimeSessionId: 'private-cli-session-id', executionId: 'exec-safe', requestId: 'req-private',
        ownerId: 'registry-user', status: 'running', task: 'Read /Users/private/key and use token=do-not-leak',
        agentId: 'codex-agent', conversationId: 'run-center-safe', executionKind: 'local-cli',
        localCli: { cli: 'codex' }, workingDir: '/Users/private/repository',
        createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:01:00.000Z',
      }] as any),
      listChannels: vi.fn(async () => [{
        id: 'channel-safe', displayName: 'alice@example.internal', platform: 'feishu', enabled: true,
        status: { kind: 'connected', checkedAt: '2026-08-27T00:02:00.000Z' },
        secrets_enc: 'do-not-leak',
      }] as any),
      listPeers: vi.fn(() => []),
      listGateways: vi.fn(() => [{ cli: 'codex', running: true, started_at: '2026-08-27T00:02:30.000Z' }]),
      listRemoteNodes: vi.fn(() => ({ ok: true as const, nodes: [] })),
      now: () => new Date('2026-08-27T00:03:00.000Z'),
    });

    expect(projection.updatedAt).toBe('2026-08-27T00:03:00.000Z');
    expect(projection.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'codex-agent', displayName: 'codex-agent', sourceKind: 'local-cli',
        runtimeKind: 'cli:codex', health: 'busy', dispatchable: true,
        currentTaskId: 'cogseed-task-private', currentConversationId: 'run-center-safe',
      }),
      expect.objectContaining({ agentId: 'gemini-agent', health: 'unsupported', dispatchable: false }),
    ]));
    for (const type of ['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy']) {
      expect(projection.runtimes).toContainEqual(expect.objectContaining({ runtimeKind: type, dispatchable: true }));
    }
    expect(projection.runtimes).toContainEqual(expect.objectContaining({
      runtimeKind: 'codex', gatewayRunning: true, gatewayControllable: true,
    }));
    for (const type of ['gemini', 'aider']) {
      expect(projection.runtimes).toContainEqual(expect.objectContaining({ runtimeKind: type, health: 'unsupported', dispatchable: false }));
    }
    expect(projection.channels).toContainEqual(expect.objectContaining({
      channelId: 'channel-safe', displayName: 'feishu', platform: 'feishu', health: 'ready',
    }));

    const serialized = JSON.stringify(projection);
    for (const privateValue of ['/Users/private', 'do-not-leak', 'private-cli-session-id', 'token=', 'secrets_enc', 'alice@example.internal']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toContain('path');
    expect(serialized).not.toContain('auth');
    expect(serialized).not.toContain('endpoint');
  });

  it('normalizes P3394 peers and remote nodes without exposing endpoint credentials or treating channels as Agents', async () => {
    const projection = await buildCogSeedAgentRegistryProjection('registry-user', {
      listAgentSummaries: vi.fn(async () => [{
        agent_id: 'codex-agent', name: 'Codex', enabled: true, source: 'custom',
        runtime: { kind: 'p3394-gateway', cli: 'codex' },
      }] as any),
      detectAll: vi.fn(async () => []),
      listTasks: vi.fn(async () => []),
      listChannels: vi.fn(async () => [{
        id: 'channel-bridge', displayName: 'Team bridge', platform: 'telegram', enabled: true,
        status: { kind: 'connected', checkedAt: '2026-08-27T01:00:00.000Z' },
      }] as any),
      listPeers: vi.fn(() => [
        {
          agent_id: 'cogseed', display_name: 'CogSeed', online: true,
          disabled: false, capabilities: ['task-execution'],
        },
        {
          agent_id: 'remote-reviewer', display_name: 'Remote reviewer', node_kind: 'agent',
          online: true, disabled: false, last_seen_at: '2026-08-27T01:01:00.000Z',
          capabilities: ['review', 'token=must-not-cross'], endpoints: ['http://192.0.2.8:9000'],
        },
        {
          agent_id: 'codex', display_name: 'Codex runtime', node_kind: 'agent',
          online: true, disabled: false, last_seen_at: '2026-08-27T01:01:30.000Z',
          capabilities: ['task-execution'], endpoints: ['http://127.0.0.1:9001'],
        },
        {
          agent_id: 'bridge-peer', display_name: 'Bridge peer', node_kind: 'channel_bridge',
          online: true, disabled: false, capabilities: ['messages'],
        },
        {
          agent_id: 'capability-peer', display_name: 'Capability peer', node_kind: 'capability',
          online: true, disabled: false, capabilities: ['search'],
        },
      ] as any),
      listGateways: vi.fn(() => []),
      listRemoteNodes: vi.fn(() => ({
        ok: true as const,
        nodes: [{
          id: 'remote-node-safe', label: 'Remote runtime', endpoint: 'http://192.0.2.8:9000',
          tokenPreview: 'abcd…ef', expected_identity: 'remote-reviewer', enabled: true,
          created_at: '2026-08-27T00:59:00.000Z',
        }],
      })),
      now: () => new Date('2026-08-27T01:02:00.000Z'),
    });

    expect(projection.agents).toContainEqual(expect.objectContaining({
      agentId: 'remote-reviewer', sourceKind: 'p3394', online: true, dispatchable: true,
    }));
    expect(projection.agents).toContainEqual(expect.objectContaining({
      agentId: 'codex-agent', displayName: 'Codex', sourceKind: 'p3394',
      runtimeKind: 'p3394-gateway:codex', online: true, dispatchable: true,
    }));
    expect(projection.agents.some((agent) => agent.agentId === 'codex')).toBe(false);
    expect(projection.agents.some((agent) => agent.agentId === 'bridge-peer')).toBe(false);
    expect(projection.agents.some((agent) => agent.agentId === 'cogseed')).toBe(false);
    expect(projection.agents).toContainEqual(expect.objectContaining({
      agentId: 'capability-peer', health: 'unsupported', dispatchable: false,
    }));
    expect(projection.runtimes).toContainEqual(expect.objectContaining({
      runtimeId: 'remote-node-safe', agentId: 'remote-reviewer', sourceKind: 'p3394',
      runtimeKind: 'p3394-remote', dispatchable: true,
    }));
    expect(projection.channels).toContainEqual(expect.objectContaining({
      channelId: 'channel-bridge', platform: 'telegram', health: 'ready',
    }));
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain('192.0.2.8');
    expect(serialized).not.toContain('abcd…ef');
    expect(serialized).not.toContain('token=must-not-cross');
    expect(serialized).not.toContain('endpoint');
    expect(projection.registryFreshness).toBe('fresh');
    expect(projection.agents.find((agent) => agent.agentId === 'capability-peer'))
      .toMatchObject({ eligibilityReason: 'unsupported_runtime' });
  });

  it('reports one machine reason per ineligible Agent and none when dispatchable', async () => {
    const projection = await buildCogSeedAgentRegistryProjection('registry-user', {
      listAgentSummaries: vi.fn(async () => [
        { agent_id: 'ready-agent', name: 'Ready', enabled: true, source: 'custom', runtime: { kind: 'in_process' } },
        { agent_id: 'off-agent', name: 'Switched off', enabled: false, source: 'custom', runtime: { kind: 'in_process' } },
        // Host-owned management identity. The execution admission gate has
        // always rejected it; the projection used to advertise it anyway.
        { agent_id: 'workbench-agent', name: 'Workbench', enabled: true, source: 'marketplace', runtime: { kind: 'in_process' }, interaction_mode: 'management_only' },
        { agent_id: 'missing-cli-agent', name: 'Missing CLI', enabled: true, source: 'custom', runtime: { kind: 'cli', cli: 'codex' } },
        { agent_id: 'unsupported-agent', name: 'Unsupported', enabled: true, source: 'custom', runtime: { kind: 'cli', cli: 'gemini' } },
        { agent_id: 'offline-peer-agent', name: 'Offline gateway', enabled: true, source: 'custom', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
        { agent_id: 'blocked-peer-agent', name: 'Blocked peer', enabled: true, source: 'custom', runtime: { kind: 'p3394-gateway', cli: 'claude' } },
      ] as any),
      detectAll: vi.fn(async () => [
        { type: 'codex', available: false },
        { type: 'gemini', available: true },
        { type: 'claude', available: true },
      ] as any),
      listTasks: vi.fn(async () => []),
      listChannels: vi.fn(async () => []),
      listPeers: vi.fn(() => [
        { agent_id: 'offline-peer-agent', node_kind: 'agent', online: false, disabled: false },
        { agent_id: 'blocked-peer-agent', node_kind: 'agent', online: true, disabled: true },
      ] as any),
      listGateways: vi.fn(() => []),
      listRemoteNodes: vi.fn(() => ({ ok: true as const, nodes: [] })),
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });

    const reasonById = new Map(projection.agents.map((agent) => [agent.agentId, agent.eligibilityReason]));
    expect(reasonById.get('ready-agent')).toBeUndefined();
    expect(reasonById.get('off-agent')).toBe('disabled');
    expect(reasonById.get('workbench-agent')).toBe('management_only');
    expect(reasonById.get('missing-cli-agent')).toBe('not_installed');
    expect(reasonById.get('unsupported-agent')).toBe('unsupported_runtime');
    expect(reasonById.get('offline-peer-agent')).toBe('offline');
    expect(reasonById.get('blocked-peer-agent')).toBe('peer_disabled');

    const byId = new Map(projection.agents.map((agent) => [agent.agentId, agent]));
    expect(byId.get('ready-agent')).toMatchObject({ dispatchable: true, health: 'ready' });
    // The badge must agree with the eligibility answer; a management identity
    // shown as "ready" but refused at dispatch is the divergence being closed.
    expect(byId.get('workbench-agent')).toMatchObject({ dispatchable: false, health: 'disabled' });
    for (const agent of projection.agents) {
      expect(agent.dispatchable, agent.agentId).toBe(agent.eligibilityReason === undefined);
    }
  });
});

describe('resolveAgentEligibility', () => {
  const eligible = {
    enabled: true, managementOnly: false, peerDisabled: false,
    installed: true, online: true, runtimeSupported: true,
  };

  it('admits an Agent only when every condition holds', () => {
    expect(resolveAgentEligibility(eligible)).toEqual({ dispatchable: true });
  });

  it('names exactly one reason per failing condition', () => {
    expect(resolveAgentEligibility({ ...eligible, enabled: false })).toEqual({ dispatchable: false, reasonCode: 'disabled' });
    expect(resolveAgentEligibility({ ...eligible, managementOnly: true })).toEqual({ dispatchable: false, reasonCode: 'management_only' });
    expect(resolveAgentEligibility({ ...eligible, peerDisabled: true })).toEqual({ dispatchable: false, reasonCode: 'peer_disabled' });
    expect(resolveAgentEligibility({ ...eligible, runtimeSupported: false })).toEqual({ dispatchable: false, reasonCode: 'unsupported_runtime' });
    expect(resolveAgentEligibility({ ...eligible, installed: false })).toEqual({ dispatchable: false, reasonCode: 'not_installed' });
    expect(resolveAgentEligibility({ ...eligible, online: false })).toEqual({ dispatchable: false, reasonCode: 'offline' });
  });

  it('reports the policy reason first when several conditions fail at once', () => {
    expect(resolveAgentEligibility({
      enabled: false, managementOnly: true, peerDisabled: true,
      installed: false, online: false, runtimeSupported: false,
    })).toEqual({ dispatchable: false, reasonCode: 'disabled' });
  });
});
