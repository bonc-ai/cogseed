import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../../src/main/features/agents';
import {
  buildP3394BridgeManifest,
  buildP3394CapabilityProfile,
  normalizeP3394AgentIdentity,
  validateIdentityRuntimeBoundary,
  validateP3394BridgeManifest,
} from '../../../../src/main/features/p3394';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'agent-bridge-001',
    name: 'Bridge Agent',
    description_zh: '',
    description_en: 'Bridge test agent',
    workflow: 'Handle bridge messages.',
    category: 'productivity',
    ...overrides,
  };
}

describe('P3394 bridge identity, capability profile, and manifest', () => {
  it('normalizes identity from an in-process Agent', () => {
    const result = normalizeP3394AgentIdentity(agent({ runtime: { kind: 'in_process' } }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected identity normalization success');
    expect(result.identity).toEqual({
      agent_id: 'agent-bridge-001',
      display_name: 'Bridge Agent',
    });
  });

  it('rejects alias equal to agent_id', () => {
    const result = normalizeP3394AgentIdentity(agent({ agent_id: 'agent-bridge-001', name: 'Bridge Agent' }), {
      alias: 'agent-bridge-001',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected identity normalization failure');
    expect(result.error.reason).toBe('alias_equals_agent_id');
    expect(result.error.field).toBe('alias');
  });


  it('rejects empty and malformed agent_id without trimming into a new identity', () => {
    const empty = normalizeP3394AgentIdentity(agent({ agent_id: '   ' }));
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('expected empty agent_id failure');
    expect(empty.error.reason).toBe('missing_agent_id');

    const padded = normalizeP3394AgentIdentity(agent({ agent_id: ' agent-bridge-001 ' }));
    expect(padded.ok).toBe(false);
    if (padded.ok) throw new Error('expected malformed agent_id failure');
    expect(padded.error.reason).toBe('malformed_agent_id');
  });

  it('rejects agent_id as model profile', () => {
    const identity = { agent_id: 'agent-bridge-001', display_name: 'Bridge Agent' };
    const result = validateIdentityRuntimeBoundary(identity, { model: 'agent-bridge-001' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected runtime boundary failure');
    expect(result.error.reason).toBe('model_profile_equals_agent_id');
    expect(result.error.field).toBe('model');
  });

  it('allows undefined model profile and non-agent model profile', () => {
    const identity = { agent_id: 'agent-bridge-001', display_name: 'Bridge Agent' };

    expect(validateIdentityRuntimeBoundary(identity, undefined).ok).toBe(true);
    expect(validateIdentityRuntimeBoundary(identity, { model: 'gpt-5' }).ok).toBe(true);
  });

  it('rejects CLI runtime model equal to agent_id', () => {
    const identity = { agent_id: 'agent-bridge-001', display_name: 'Bridge Agent' };
    const result = validateIdentityRuntimeBoundary(identity, {
      kind: 'p3394-gateway',
      cli: 'codex',
      model: 'agent-bridge-001',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected CLI runtime boundary failure');
    expect(result.error.reason).toBe('model_profile_equals_agent_id');
    expect(result.error.field).toBe('runtime.model');
  });

  it('maps in-process runtime to cogseed-native', () => {
    const result = buildP3394CapabilityProfile(agent({ runtime: { kind: 'in_process' } }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected capability profile success');
    expect(result.profile.runtime_kind).toBe('cogseed-native');
    expect(result.profile.capabilities).toContain('handle_message');
    expect(result.profile.capabilities).not.toContain('local-cli');
  });

  it('maps CLI runtime to local-cli and includes local-cli capability', () => {
    const result = buildP3394CapabilityProfile(agent({ runtime: { kind: 'p3394-gateway', cli: 'codex', model: 'gpt-5' } }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected capability profile success');
    expect(result.profile.runtime_kind).toBe('local-cli');
    expect(result.profile.capabilities).toEqual(expect.arrayContaining(['handle_message', 'local-cli']));
  });

  it('deduplicates skill_list and creates cogseed-skill-scope capability', () => {
    const result = buildP3394CapabilityProfile(agent({ skill_list: [' research ', 'write', 'research', '', 'write'] }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected capability profile success');
    expect(result.profile.skill_scope).toEqual(['research', 'write']);
    expect(result.profile.capabilities).toEqual(expect.arrayContaining(['handle_message', 'cogseed-skill-scope']));
  });

  it('builds manifest with identity, runtime, capability profile, channel declaration, session/security/conformance', () => {
    const result = buildP3394BridgeManifest(agent({
      runtime: { kind: 'p3394-gateway', cli: 'codex', model: 'gpt-5' },
      skill_list: ['research'],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected manifest success');
    expect(result.manifest.spec_version).toBe('p3394/1.0');
    expect(result.manifest.identity.agent_id).toBe('agent-bridge-001');
    expect(result.manifest.runtime).toEqual({ kind: 'p3394-gateway', cli: 'codex', model: 'gpt-5' });
    expect(result.manifest.capability_profile.agent_id).toBe('agent-bridge-001');
    expect(result.manifest.capability_profile.runtime_kind).toBe('local-cli');
    expect(result.manifest.channels).toEqual([
      {
        id: 'local-agent-bridge',
        kind: 'local',
        direction: 'inbound-outbound',
      },
    ]);
    expect(result.manifest.session).toEqual(expect.objectContaining({ scope: 'per-conversation' }));
    expect(result.manifest.security).toEqual(expect.objectContaining({ identity_source: 'cogseed-agent' }));
    expect(result.manifest.conformance).toEqual(expect.objectContaining({ level: 'level-2-session-aware', registry: true, agent_home: true, runtime_adapter: true }));
    expect(result.manifest.conformance.capabilities).toMatchObject({ sessions: true, artifacts: true, cancellation: true, restart_recovery: true, checkpoints: false });
  });

  it('rejects non-local channels and overclaimed conformance levels', () => {
    const valid = buildP3394BridgeManifest(agent());
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error('expected manifest success');

    const remoteChannel = { ...valid.manifest, channels: [{ id: 'remote', kind: 'websocket', direction: 'inbound-outbound' }] };
    const channelResult = validateP3394BridgeManifest(remoteChannel);
    expect(channelResult.ok).toBe(false);
    if (channelResult.ok) throw new Error('expected non-local channel failure');
    expect(channelResult.error.reason).toBe('invalid_channels');

    // Level 3 声明但缺多参与方/delegation → 拒绝
    const prematureConformance = {
      ...valid.manifest,
      conformance: { level: 'level-3-collaborative', registry: true, agent_home: true, runtime_adapter: true },
    };
    const conformanceResult = validateP3394BridgeManifest(prematureConformance);
    expect(conformanceResult.ok).toBe(false);
    if (conformanceResult.ok) throw new Error('expected conformance failure');
    expect(conformanceResult.error.reason).toBe('invalid_conformance');

    // Level 2 声明缺三项支撑 → 拒绝
    const unsupported = { ...valid.manifest, conformance: { level: 'level-2-session-aware', registry: false, agent_home: true, runtime_adapter: true } };
    const unsupportedResult = validateP3394BridgeManifest(unsupported);
    expect(unsupportedResult.ok).toBe(false);
    if (unsupportedResult.ok) throw new Error('expected conformance failure');
    expect(unsupportedResult.error.reason).toBe('invalid_conformance');
  });

  it('rejects object validation when runtime or capability profile is missing', () => {
    const valid = buildP3394BridgeManifest(agent());
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error('expected manifest success');

    const missingRuntime = { ...valid.manifest } as Record<string, unknown>;
    delete missingRuntime.runtime;
    const runtimeResult = validateP3394BridgeManifest(missingRuntime);
    expect(runtimeResult.ok).toBe(false);
    if (runtimeResult.ok) throw new Error('expected missing runtime failure');
    expect(runtimeResult.error.reason).toBe('missing_runtime');

    const missingCapabilityProfile = { ...valid.manifest } as Record<string, unknown>;
    delete missingCapabilityProfile.capability_profile;
    const profileResult = validateP3394BridgeManifest(missingCapabilityProfile);
    expect(profileResult.ok).toBe(false);
    if (profileResult.ok) throw new Error('expected missing capability profile failure');
    expect(profileResult.error.reason).toBe('missing_capability_profile');
  });
});
