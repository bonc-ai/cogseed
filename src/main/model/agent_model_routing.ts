/**
 * Masked agent-model routing (CLI 伪装模型 ID).
 *
 * CodexHost-style transport id: a local CLI agent's model selection travels
 * as `cli/<cliType>@<modelId>` (e.g. `cli/claude@claude-sonnet-5`). The masked
 * string is the SINGLE stored form — renderer overrides (localStorage),
 * @-picker picks, and exec_meta all keep the full string; it is decoded to a
 * bare model id exactly once, right before the CLI execution path consumes
 * `execConfig.model` (bus.ts). Effort is NOT encoded — `execution_config`
 * already has a dedicated `effort` field.
 *
 * Honesty rules (fail-closed, never a silent model swap):
 *   - decode failures / unknown `cli/` prefixes are passed through untouched
 *     (a custom model id that happens to start with `cli/` keeps working);
 *   - a masked id that reaches the in-process (API) path is a recipient /
 *     config mismatch: the override is dropped with a warning instead of
 *     silently falling back to the default entry group.
 */

import { LOCAL_CLI_TYPES } from '../features/local_agents/registry.js';

export const AGENT_MODEL_PREFIX = 'cli/';
export const PSEUDO_CLI_PROVIDER_PREFIX = 'cli-';

const CLI_TYPE_SET = new Set<string>(LOCAL_CLI_TYPES);

export type AgentModelRef = { cliType: string; modelId: string };

/** CLI types that may appear in the masked prefix (canonical, lowercase). */
export function isKnownCliType(cliType: string): boolean {
  return CLI_TYPE_SET.has(String(cliType || '').trim().toLowerCase());
}

export function encodeAgentModel(cliType: string, modelId: string): string {
  const type = String(cliType || '').trim().toLowerCase();
  const model = String(modelId || '').trim();
  if (!type || !model) throw new Error('cliType and modelId required');
  return `${AGENT_MODEL_PREFIX}${type}@${model}`;
}

/** Decode `cli/<type>@<model>`. Null for anything else (no prefix, unknown
 *  cli type, empty segments, extra `@` segments) — callers treat null as
 *  "not a masked id, pass through". */
export function decodeAgentModel(id: unknown): AgentModelRef | null {
  if (typeof id !== 'string' || !id.startsWith(AGENT_MODEL_PREFIX)) return null;
  const rest = id.slice(AGENT_MODEL_PREFIX.length);
  const at = rest.indexOf('@');
  if (at <= 0) return null;
  const cliType = rest.slice(0, at).toLowerCase();
  const modelId = rest.slice(at + 1);
  if (!modelId || modelId.includes('@')) return null;
  if (!CLI_TYPE_SET.has(cliType)) return null;
  return { cliType, modelId };
}

export function isAgentModel(id: unknown): boolean {
  return decodeAgentModel(id) !== null;
}

/** Bare model id for the CLI execution path: decodes masked ids, returns
 *  everything else untouched (legacy bare overrides keep working). */
export function bareModelFor(id: unknown): string {
  const decoded = decodeAgentModel(id);
  return decoded ? decoded.modelId : String(id ?? '');
}

/** Pseudo provider id shown in pickers (`cli-claude` ↔ prefix `cli/claude@`). */
export function pseudoProviderFor(cliType: string): string {
  return `${PSEUDO_CLI_PROVIDER_PREFIX}${String(cliType || '').trim().toLowerCase()}`;
}

export function cliTypeFromPseudoProvider(provider: unknown): string | null {
  if (typeof provider !== 'string' || !provider.startsWith(PSEUDO_CLI_PROVIDER_PREFIX)) return null;
  const type = provider.slice(PSEUDO_CLI_PROVIDER_PREFIX.length).toLowerCase();
  return CLI_TYPE_SET.has(type) ? type : null;
}

export function isPseudoCliProvider(provider: unknown): boolean {
  return cliTypeFromPseudoProvider(provider) !== null;
}

// ── bus.ts composition helpers ────────────────────────────────────────────

export type MaskedExecConfig = { provider?: string; model?: string; effort?: 'off' | 'low' | 'high' };

/**
 * CLI-path rewrite: decode a masked `execConfig.model` into the bare id the
 * CLI channels (direct runner / p3394 gateway templates) consume. Returns the
 * rewritten config plus `transportModel` — the ORIGINAL masked string — when
 * a rewrite happened, so exec_meta can store the full form (single source of
 * truth) while the mismatch check compares the bare value.
 */
export function resolveMaskedCliExecConfig(config: MaskedExecConfig | undefined): {
  config: MaskedExecConfig | undefined;
  transportModel?: string;
} {
  if (!config || typeof config.model !== 'string') return { config };
  const decoded = decodeAgentModel(config.model);
  if (!decoded) return { config };
  return {
    config: { ...config, model: decoded.modelId },
    transportModel: config.model,
  };
}

/**
 * In-process-path guard (the D6 red line): a masked model / pseudo CLI
 * provider must NEVER reach `pickChatEntryGroupForModelOverride` — it has no
 * API credential, so the provider filter would swallow the override and
 * silently fall back to the default entry group. Called before the override
 * is assembled; a stripped config keeps its `effort` (that channel is
 * provider-independent).
 */
export function stripMaskedForInProcess(config: MaskedExecConfig | undefined): {
  config: MaskedExecConfig | undefined;
  stripped: boolean;
} {
  if (!config) return { config, stripped: false };
  const maskedModel = typeof config.model === 'string' && isAgentModel(config.model);
  const pseudoProvider = isPseudoCliProvider(config.provider);
  if (!maskedModel && !pseudoProvider) return { config, stripped: false };
  const next: MaskedExecConfig = { ...config };
  delete next.model;
  delete next.provider;
  if (!next.effort) return { config: undefined, stripped: true };
  return { config: { effort: next.effort }, stripped: true };
}
