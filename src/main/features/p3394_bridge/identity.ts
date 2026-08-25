import type { Agent, AgentRuntime } from '../agents';

export interface P3394AgentIdentity {
  agent_id: string;
  alias?: string;
  display_name: string;
}

export type P3394IdentityValidationReason =
  | 'invalid_identity'
  | 'missing_agent_id'
  | 'malformed_agent_id'
  | 'alias_equals_agent_id'
  | 'missing_display_name'
  | 'model_profile_equals_agent_id';

export interface P3394IdentityValidationError {
  reason: P3394IdentityValidationReason;
  field: string;
  message: string;
}

export type P3394IdentityValidationResult<T = P3394AgentIdentity> =
  | { ok: true; identity: T }
  | { ok: false; error: P3394IdentityValidationError };

export type P3394RuntimeBoundaryValidationResult =
  | { ok: true }
  | { ok: false; error: P3394IdentityValidationError };

export interface P3394IdentityNormalizeOptions {
  alias?: string;
  display_name?: string;
}

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function fail(
  reason: P3394IdentityValidationReason,
  field: string,
  message: string,
): { ok: false; error: P3394IdentityValidationError } {
  return { ok: false, error: { reason, field, message } };
}

export function isValidP3394AgentId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed === value && AGENT_ID_PATTERN.test(trimmed);
}

export function assertAliasIsNotIdentity(identity: Pick<P3394AgentIdentity, 'agent_id' | 'alias'>): P3394RuntimeBoundaryValidationResult {
  const alias = typeof identity.alias === 'string' ? identity.alias.trim() : '';
  if (alias && alias === identity.agent_id) {
    return fail('alias_equals_agent_id', 'alias', 'P3394 alias is display-only and must not equal agent_id.');
  }
  return { ok: true };
}

export function normalizeP3394AgentIdentity(
  agent: Pick<Agent, 'agent_id' | 'name'>,
  options: P3394IdentityNormalizeOptions = {},
): P3394IdentityValidationResult {
  if (!agent || typeof agent !== 'object') {
    return fail('invalid_identity', 'agent', 'Expected CogSeed Agent identity source.');
  }

  const agentId = typeof agent.agent_id === 'string' ? agent.agent_id : '';
  if (!agentId.trim()) {
    return fail('missing_agent_id', 'agent_id', 'P3394 identity requires a non-empty agent_id.');
  }
  if (!isValidP3394AgentId(agentId)) {
    return fail('malformed_agent_id', 'agent_id', 'P3394 agent_id contains unsupported characters.');
  }

  const displayName = typeof options.display_name === 'string' && options.display_name.trim()
    ? options.display_name.trim()
    : (typeof agent.name === 'string' && agent.name.trim() ? agent.name.trim() : agentId);
  if (!displayName) {
    return fail('missing_display_name', 'display_name', 'P3394 identity requires a display_name.');
  }

  const identity: P3394AgentIdentity = {
    agent_id: agentId,
    display_name: displayName,
  };

  const alias = typeof options.alias === 'string' ? options.alias.trim() : '';
  if (alias) identity.alias = alias;

  const aliasResult = assertAliasIsNotIdentity(identity);
  if (aliasResult.ok === false) {
    return { ok: false, error: aliasResult.error };
  }

  return { ok: true, identity };
}

export function validateP3394AgentIdentity(value: unknown): P3394IdentityValidationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_identity', 'identity', 'Expected P3394 identity object.');
  }
  const raw = value as Record<string, unknown>;
  const agent_id = typeof raw.agent_id === 'string' ? raw.agent_id : '';
  if (!agent_id.trim()) return fail('missing_agent_id', 'identity.agent_id', 'P3394 identity requires agent_id.');
  if (!isValidP3394AgentId(agent_id)) return fail('malformed_agent_id', 'identity.agent_id', 'P3394 agent_id is malformed.');
  const display_name = typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name.trim() : '';
  if (!display_name) return fail('missing_display_name', 'identity.display_name', 'P3394 identity requires display_name.');
  const alias = typeof raw.alias === 'string' && raw.alias.trim() ? raw.alias.trim() : undefined;
  const identity: P3394AgentIdentity = { agent_id, display_name, ...(alias ? { alias } : {}) };
  const aliasResult = assertAliasIsNotIdentity(identity);
  if (aliasResult.ok === false) {
    return { ok: false, error: aliasResult.error };
  }
  return { ok: true, identity };
}

function explicitModelProfile(runtimeOrProfile: unknown): { field: string; model?: string } | null {
  if (!runtimeOrProfile || typeof runtimeOrProfile !== 'object' || Array.isArray(runtimeOrProfile)) return null;
  const raw = runtimeOrProfile as Partial<AgentRuntime> & { model?: unknown };
  if (typeof raw.model !== 'string' || !raw.model.trim()) return null;
  return { field: raw.kind === 'p3394-gateway' ? 'runtime.model' : 'model', model: raw.model.trim() };
}

export function validateIdentityRuntimeBoundary(
  identity: Pick<P3394AgentIdentity, 'agent_id'>,
  runtimeOrProfile: AgentRuntime | { model?: string } | undefined,
): P3394RuntimeBoundaryValidationResult {
  const modelProfile = explicitModelProfile(runtimeOrProfile);
  if (modelProfile?.model === identity.agent_id) {
    return fail(
      'model_profile_equals_agent_id',
      modelProfile.field,
      'Execution model profile must not be the same value as P3394 agent_id.',
    );
  }
  return { ok: true };
}
