import type { Agent, AgentRuntime } from '../agents';
import { buildP3394CapabilityProfile, validateP3394CapabilityProfile, type P3394CapabilityProfile } from './capability-profile';
import { normalizeP3394AgentIdentity, validateP3394AgentIdentity, validateIdentityRuntimeBoundary, type P3394AgentIdentity } from './identity';

export const P3394_BRIDGE_SPEC_VERSION = 'p3394/1.0' as const;

export interface P3394BridgeChannelDeclaration {
  id: string;
  kind: 'local';
  direction: 'inbound-outbound';
}

/** SDK design §17 integration levels. Level 2 (session-aware) is what the
 *  CogSeed bridge declares: native session identity, workspace, artifacts,
 *  cancellation and restart recovery all work. Level 3 pieces that are still
 *  missing (checkpoints, resource policy) stay declared as false. */
export type P3394ConformanceLevel =
  | 'level-0-client-only'
  | 'level-1-reachable-agent'
  | 'level-2-session-aware'
  | 'level-3-collaborative'
  | 'bridge-phase-1';

export interface P3394ConformanceDeclaration {
  level: P3394ConformanceLevel;
  registry: boolean;
  agent_home: boolean;
  runtime_adapter: boolean;
  capabilities?: {
    sessions: boolean;
    artifacts: boolean;
    streaming: boolean;
    cancellation: boolean;
    restart_recovery: boolean;
    multi_party_sessions: boolean;
    delegation: boolean;
    checkpoints: boolean;
    resource_policy: boolean;
  };
}

export interface P3394BridgeManifest {
  spec_version: typeof P3394_BRIDGE_SPEC_VERSION;
  identity: P3394AgentIdentity;
  runtime: AgentRuntime;
  capability_profile: P3394CapabilityProfile;
  channels: P3394BridgeChannelDeclaration[];
  session: {
    scope: 'per-conversation';
    requires_session_id: boolean;
  };
  security: {
    identity_source: 'cogseed-agent';
    renderer_identity_source: false;
    model_profile_separate_from_agent_id: true;
  };
  conformance: P3394ConformanceDeclaration;
}

export type P3394BridgeManifestValidationReason =
  | 'invalid_manifest'
  | 'unsupported_spec_version'
  | 'missing_identity'
  | 'missing_runtime'
  | 'invalid_runtime'
  | 'missing_capability_profile'
  | 'missing_channels'
  | 'invalid_channels'
  | 'invalid_session'
  | 'invalid_security'
  | 'invalid_conformance'
  | 'missing_session'
  | 'missing_security'
  | 'missing_conformance'
  | string;

export interface P3394BridgeManifestValidationError {
  reason: P3394BridgeManifestValidationReason;
  field: string;
  message: string;
}

export type P3394BridgeManifestResult =
  | { ok: true; manifest: P3394BridgeManifest }
  | { ok: false; error: P3394BridgeManifestValidationError };

function fail(
  reason: P3394BridgeManifestValidationReason,
  field: string,
  message: string,
): { ok: false; error: P3394BridgeManifestValidationError } {
  return { ok: false, error: { reason, field, message } };
}

function normalizeRuntime(runtime: AgentRuntime | undefined): AgentRuntime {
  return runtime?.kind === 'cli'
    ? {
        kind: 'cli',
        cli: runtime.cli,
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(runtime.custom_args?.length ? { custom_args: [...runtime.custom_args] } : {}),
        ...(runtime.cli_provider_id ? { cli_provider_id: runtime.cli_provider_id } : {}),
      }
    : { kind: 'in_process' };
}

function validateRuntime(value: unknown): { ok: true; runtime: AgentRuntime } | { ok: false; error: P3394BridgeManifestValidationError } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('missing_runtime', 'runtime', 'P3394 bridge manifest requires runtime.');
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'in_process') return { ok: true, runtime: { kind: 'in_process' } };
  if (raw.kind === 'cli' && typeof raw.cli === 'string' && raw.cli.trim()) {
    const runtime: AgentRuntime = { kind: 'cli', cli: raw.cli.trim() };
    if (typeof raw.model === 'string' && raw.model.trim()) runtime.model = raw.model.trim();
    if (Array.isArray(raw.custom_args)) runtime.custom_args = raw.custom_args.filter((value): value is string => typeof value === 'string');
    if (typeof raw.cli_provider_id === 'string' && raw.cli_provider_id.trim()) runtime.cli_provider_id = raw.cli_provider_id.trim();
    return { ok: true, runtime };
  }
  return fail('invalid_runtime', 'runtime', 'P3394 bridge manifest runtime is invalid.');
}

export function buildP3394BridgeManifest(agent: Agent): P3394BridgeManifestResult {
  const identityResult = normalizeP3394AgentIdentity(agent);
  if (identityResult.ok === false) return { ok: false, error: identityResult.error };

  const runtime = normalizeRuntime(agent.runtime);
  const boundaryResult = validateIdentityRuntimeBoundary(identityResult.identity, runtime);
  if (boundaryResult.ok === false) return { ok: false, error: boundaryResult.error };

  const profileResult = buildP3394CapabilityProfile({ ...agent, runtime });
  if (profileResult.ok === false) return { ok: false, error: profileResult.error };

  return {
    ok: true,
    manifest: {
      spec_version: P3394_BRIDGE_SPEC_VERSION,
      identity: identityResult.identity,
      runtime,
      capability_profile: profileResult.profile,
      channels: [{ id: 'local-agent-bridge', kind: 'local', direction: 'inbound-outbound' }],
      session: { scope: 'per-conversation', requires_session_id: true },
      security: {
        identity_source: 'cogseed-agent',
        renderer_identity_source: false,
        model_profile_separate_from_agent_id: true,
      },
      conformance: {
        level: 'level-2-session-aware',
        registry: true,
        agent_home: true,
        runtime_adapter: true,
        capabilities: {
          sessions: true,
          artifacts: true,
          streaming: false,
          cancellation: true,
          restart_recovery: true,
          multi_party_sessions: true,
          delegation: true,
          checkpoints: false,
          resource_policy: false,
        },
      },
    },
  };
}

export function validateP3394BridgeManifest(value: unknown): P3394BridgeManifestResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_manifest', 'manifest', 'Expected P3394 bridge manifest object.');
  }
  const raw = value as Record<string, unknown>;
  if (raw.spec_version !== P3394_BRIDGE_SPEC_VERSION) {
    return fail('unsupported_spec_version', 'spec_version', 'P3394 bridge manifest spec_version is unsupported.');
  }
  if (!raw.identity) return fail('missing_identity', 'identity', 'P3394 bridge manifest requires identity.');
  const identityResult = validateP3394AgentIdentity(raw.identity);
  if (identityResult.ok === false) return { ok: false, error: identityResult.error };

  const runtimeResult = validateRuntime(raw.runtime);
  if (runtimeResult.ok === false) return runtimeResult;
  const boundaryResult = validateIdentityRuntimeBoundary(identityResult.identity, runtimeResult.runtime);
  if (boundaryResult.ok === false) return { ok: false, error: boundaryResult.error };

  if (!raw.capability_profile) {
    return fail('missing_capability_profile', 'capability_profile', 'P3394 bridge manifest requires capability_profile.');
  }
  const profileResult = validateP3394CapabilityProfile(raw.capability_profile);
  if (profileResult.ok === false) return { ok: false, error: profileResult.error };

  if (!Array.isArray(raw.channels)) return fail('missing_channels', 'channels', 'P3394 bridge manifest requires channels.');
  const channels: P3394BridgeChannelDeclaration[] = [];
  for (let index = 0; index < raw.channels.length; index += 1) {
    const channel = raw.channels[index];
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      return fail('invalid_channels', `channels[${index}]`, 'P3394 bridge manifest channel must be an object.');
    }
    const item = channel as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim()) {
      return fail('invalid_channels', `channels[${index}].id`, 'P3394 bridge local channel requires id.');
    }
    if (item.kind !== 'local') {
      return fail('invalid_channels', `channels[${index}].kind`, 'Phase 1 P3394 bridge manifest only permits local channels.');
    }
    if (item.direction !== 'inbound-outbound') {
      return fail('invalid_channels', `channels[${index}].direction`, 'Phase 1 P3394 bridge manifest requires inbound-outbound local channel direction.');
    }
    channels.push({ id: item.id.trim(), kind: 'local', direction: 'inbound-outbound' });
  }

  if (!raw.session || typeof raw.session !== 'object' || Array.isArray(raw.session)) return fail('missing_session', 'session', 'P3394 bridge manifest requires session.');
  const session = raw.session as Record<string, unknown>;
  if (session.scope !== 'per-conversation' || session.requires_session_id !== true) {
    return fail('invalid_session', 'session', 'Phase 1 P3394 bridge manifest requires per-conversation sessions with explicit session_id.');
  }

  if (!raw.security || typeof raw.security !== 'object' || Array.isArray(raw.security)) return fail('missing_security', 'security', 'P3394 bridge manifest requires security.');
  const security = raw.security as Record<string, unknown>;
  if (security.identity_source !== 'cogseed-agent' || security.renderer_identity_source !== false || security.model_profile_separate_from_agent_id !== true) {
    return fail('invalid_security', 'security', 'P3394 bridge manifest must keep identity and capability ownership in CogSeed main process.');
  }

  if (!raw.conformance || typeof raw.conformance !== 'object' || Array.isArray(raw.conformance)) return fail('missing_conformance', 'conformance', 'P3394 bridge manifest requires conformance.');
  const conformance = raw.conformance as Record<string, unknown>;
  const level = conformance.level;
  const validLevels: P3394ConformanceLevel[] = ['level-0-client-only', 'level-1-reachable-agent', 'level-2-session-aware', 'level-3-collaborative', 'bridge-phase-1'];
  if (typeof level !== 'string' || !(validLevels as string[]).includes(level)) {
    return fail('invalid_conformance', 'conformance.level', 'Unsupported conformance level.');
  }
  // bridge-phase-1（历史）不得声明 registry / agent home / runtime adapter。
  if (level === 'bridge-phase-1' && (conformance.registry !== false || conformance.agent_home !== false || conformance.runtime_adapter !== false)) {
    return fail('invalid_conformance', 'conformance', 'bridge-phase-1 manifest must not claim registry, agent home, or runtime adapter support.');
  }
  // Level 2+ 必须真实声明三项支撑（SDK §17）。
  if ((level === 'level-2-session-aware' || level === 'level-3-collaborative') && (conformance.registry !== true || conformance.agent_home !== true || conformance.runtime_adapter !== true)) {
    return fail('invalid_conformance', 'conformance', 'Conformance level ' + level + ' requires registry, agent home and runtime adapter support.');
  }
  // Level 3 必须声明多参与方与 delegation。
  if (level === 'level-3-collaborative') {
    const caps = (conformance.capabilities && typeof conformance.capabilities === 'object' ? conformance.capabilities : {}) as Record<string, unknown>;
    if (caps.multi_party_sessions !== true || caps.delegation !== true) {
      return fail('invalid_conformance', 'conformance.capabilities', 'level-3-collaborative requires multi_party_sessions and delegation capabilities.');
    }
  }
  const capabilities = conformance.capabilities && typeof conformance.capabilities === 'object' && !Array.isArray(conformance.capabilities)
    ? conformance.capabilities as unknown as P3394ConformanceDeclaration['capabilities']
    : undefined;

  return {
    ok: true,
    manifest: {
      spec_version: P3394_BRIDGE_SPEC_VERSION,
      identity: identityResult.identity,
      runtime: runtimeResult.runtime,
      capability_profile: profileResult.profile,
      channels,
      session: { scope: 'per-conversation', requires_session_id: true },
      security: {
        identity_source: 'cogseed-agent',
        renderer_identity_source: false,
        model_profile_separate_from_agent_id: true,
      },
      conformance: {
        level: level as P3394ConformanceLevel,
        registry: conformance.registry === true,
        agent_home: conformance.agent_home === true,
        runtime_adapter: conformance.runtime_adapter === true,
        ...(capabilities ? { capabilities } : {}),
      },
    },
  };
}
