import type { Agent } from '../agents';
import { P3394_ENVELOPE_PERFORMATIVES, type P3394EnvelopePerformative } from './envelope';
import {
  normalizeP3394AgentIdentity,
  validateIdentityRuntimeBoundary,
  type P3394IdentityValidationError,
} from './identity';

export type P3394RuntimeKind = 'cogseed-native' | 'local-cli';

export interface P3394CapabilityProfile {
  agent_id: string;
  runtime_kind: P3394RuntimeKind;
  capabilities: string[];
  skill_scope?: string[];
  supported_performatives: P3394EnvelopePerformative[];
  supports_streaming: boolean;
  supports_artifacts: boolean;
}

export type P3394CapabilityProfileValidationReason =
  | P3394IdentityValidationError['reason']
  | 'invalid_capability_profile'
  | 'missing_capability_profile'
  | 'missing_runtime_kind'
  | 'unsupported_runtime_kind';

export interface P3394CapabilityProfileValidationError {
  reason: P3394CapabilityProfileValidationReason;
  field: string;
  message: string;
}

export type P3394CapabilityProfileResult =
  | { ok: true; profile: P3394CapabilityProfile }
  | { ok: false; error: P3394CapabilityProfileValidationError };

function fail(
  reason: P3394CapabilityProfileValidationReason,
  field: string,
  message: string,
): { ok: false; error: P3394CapabilityProfileValidationError } {
  return { ok: false, error: { reason, field, message } };
}

function dedupeStrings(values: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)));
}

export function buildP3394CapabilityProfile(agent: Agent): P3394CapabilityProfileResult {
  const identityResult = normalizeP3394AgentIdentity(agent);
  if (identityResult.ok === false) return { ok: false, error: identityResult.error };

  const boundaryResult = validateIdentityRuntimeBoundary(identityResult.identity, agent.runtime);
  if (boundaryResult.ok === false) return { ok: false, error: boundaryResult.error };

  const runtimeKind: P3394RuntimeKind = agent.runtime?.kind === 'cli' ? 'local-cli' : 'cogseed-native';
  const capabilities = ['handle_message'];
  if (runtimeKind === 'local-cli') capabilities.push('local-cli');

  const skillScope = dedupeStrings(agent.skill_list);
  if (Array.isArray(agent.skill_list)) capabilities.push('mate-skill-scope');

  const profile: P3394CapabilityProfile = {
    agent_id: identityResult.identity.agent_id,
    runtime_kind: runtimeKind,
    capabilities: Array.from(new Set(capabilities)),
    supported_performatives: [...P3394_ENVELOPE_PERFORMATIVES],
    supports_streaming: false,
    supports_artifacts: runtimeKind === 'local-cli',
    ...(Array.isArray(agent.skill_list) ? { skill_scope: skillScope } : {}),
  };

  return { ok: true, profile };
}

export function validateP3394CapabilityProfile(value: unknown): P3394CapabilityProfileResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('missing_capability_profile', 'capability_profile', 'P3394 bridge manifest requires a capability_profile.');
  }
  const raw = value as Record<string, unknown>;
  const agentId = typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
  if (!agentId) return fail('invalid_capability_profile', 'capability_profile.agent_id', 'Capability profile requires agent_id.');
  const runtimeKind = raw.runtime_kind;
  if (!runtimeKind) return fail('missing_runtime_kind', 'capability_profile.runtime_kind', 'Capability profile requires runtime_kind.');
  if (runtimeKind !== 'cogseed-native' && runtimeKind !== 'local-cli') {
    return fail('unsupported_runtime_kind', 'capability_profile.runtime_kind', 'Capability profile runtime_kind is unsupported.');
  }
  if (!Array.isArray(raw.capabilities) || !raw.capabilities.every((value) => typeof value === 'string')) {
    return fail('invalid_capability_profile', 'capability_profile.capabilities', 'Capability profile requires string capabilities.');
  }

  const profile: P3394CapabilityProfile = {
    agent_id: agentId,
    runtime_kind: runtimeKind,
    capabilities: dedupeStrings(raw.capabilities),
    supported_performatives: Array.isArray(raw.supported_performatives)
      ? raw.supported_performatives.filter((value): value is P3394EnvelopePerformative => typeof value === 'string' && (P3394_ENVELOPE_PERFORMATIVES as readonly string[]).includes(value))
      : [],
    supports_streaming: raw.supports_streaming === true,
    supports_artifacts: raw.supports_artifacts === true,
    ...(Array.isArray(raw.skill_scope) ? { skill_scope: dedupeStrings(raw.skill_scope) } : {}),
  };
  return { ok: true, profile };
}
