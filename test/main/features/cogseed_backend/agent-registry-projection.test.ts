// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';

import { buildCogSeedAgentRegistryProjection } from '../../../../src/main/features/cogseed_backend/agent-registry-projection';

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
      listAgentSummaries: vi.fn(async () => []),
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
  });
});
