/**
 * Per-user local overrides for **built-in provider presets** — currently the
 * model context window and max output tokens.
 *
 * Why this exists: built-in providers (deepseek / openai / anthropic / …) take
 * their model list from the shipped preset (model/public_model_catalog.ts) or
 * the Server model catalog. Those numbers are product config the user cannot
 * reach, yet the runtime budget (context compaction, max_tokens) hangs off
 * them — when a preset disagrees with what an endpoint really serves, the user
 * needs a local, per-model correction that survives restarts and is visible in
 * the model dropdown.
 *
 * Lives at `<uid>/cloud/config/model-overrides.json` (same cloud-sync policy as
 * preferences.json / permissions.json) — a window cap is an account-level
 * property, not machine-specific state.
 *
 * **Schema** (v1):
 * ```
 * {
 *   "version": 1,
 *   "providers": {
 *     "<provider_id>": { "<model_id>": { "contextWindow": 512000, "maxTokens": 65536, "updatedAt": 1710000000000 } }
 *   }
 * }
 * ```
 *
 * **Storage convention — only real overrides are stored**: a field is written
 * only when the caller provides it; clearing removes the key (and the provider
 * bucket when it empties). Reading is a pure lookup: missing = "use the preset".
 *
 * Validation mirrors the renderer/IPC guards: positive safe integers, and
 * maxTokens <= contextWindow **within the same overlay** (an overlay may omit
 * one field, in which case the preset supplies the other and the ceiling check
 * is deferred to the resolver, which knows both halves).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userModelOverridesFile } from '../paths';
import { createLogger } from '../logger';
import { setModelAbilityOverrideResolver } from '../model/model_ability_overrides';
import { getActiveUserId } from './users';

const log = createLogger('model-overrides');

const SCHEMA_VERSION = 1;
/** Same ceilings as the renderer's model editor / IPC guards. */
export const MAX_OVERRIDE_CONTEXT_WINDOW = 16_777_216;
export const MAX_OVERRIDE_OUTPUT_TOKENS = 1_048_576;
const MAX_ID_LENGTH = 200;

export interface ModelAbilityOverride {
  contextWindow?: number;
  maxTokens?: number;
  updatedAt?: number;
}

interface ModelOverridesFile {
  version: number;
  providers: Record<string, Record<string, ModelAbilityOverride>>;
}

// In-process cache: curatedModelsFor consumers (model list rendering, runtime
// budget) call the resolver per model, so a file read per call would be hot.
// Writes invalidate; the file is authoritative on a cold start.
const _cache = new Map<string, ModelOverridesFile>();

function emptyFile(): ModelOverridesFile {
  return { version: SCHEMA_VERSION, providers: {} };
}

function normalizeId(raw: unknown): string {
  return String(raw == null ? '' : raw).trim().slice(0, MAX_ID_LENGTH);
}

function sanitizeOverride(raw: unknown): ModelAbilityOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const out: ModelAbilityOverride = {};
  const contextWindow = Number(value.contextWindow);
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0 && contextWindow <= MAX_OVERRIDE_CONTEXT_WINDOW) {
    out.contextWindow = contextWindow;
  }
  const maxTokens = Number(value.maxTokens);
  if (Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= MAX_OVERRIDE_OUTPUT_TOKENS) {
    out.maxTokens = maxTokens;
  }
  if (typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)) out.updatedAt = value.updatedAt;
  return Object.keys(out).length ? out : null;
}

function readFile(uid: string): ModelOverridesFile {
  const cached = _cache.get(uid);
  if (cached) return cached;
  const file = emptyFile();
  try {
    const raw = JSON.parse(fs.readFileSync(userModelOverridesFile(uid), 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const providers = (raw as Record<string, unknown>).providers;
      if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
        for (const [providerId, models] of Object.entries(providers as Record<string, unknown>)) {
          const provider = normalizeId(providerId);
          if (!provider || !models || typeof models !== 'object' || Array.isArray(models)) continue;
          const bucket: Record<string, ModelAbilityOverride> = {};
          for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
            const model = normalizeId(modelId);
            const override = sanitizeOverride(entry);
            if (model && override) bucket[model] = override;
          }
          if (Object.keys(bucket).length) file.providers[provider] = bucket;
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('model override file unreadable; falling back to presets', {
        error: (error as Error).message,
      });
    }
  }
  _cache.set(uid, file);
  return file;
}

function writeFile(uid: string, file: ModelOverridesFile): void {
  const target = userModelOverridesFile(uid);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf-8' });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* missing/locked temporary */ }
    throw error;
  }
  _cache.set(uid, file);
}

/** Every override currently stored for this user (provider → model → patch). */
export function listModelOverrides(uid: string): Record<string, Record<string, ModelAbilityOverride>> {
  const file = readFile(uid);
  const out: Record<string, Record<string, ModelAbilityOverride>> = {};
  for (const [provider, models] of Object.entries(file.providers)) {
    out[provider] = { ...models };
  }
  return out;
}

/** The stored patch for one (provider, model), or null when the preset applies. */
export function resolveModelOverride(uid: string, provider: string, model: string): ModelAbilityOverride | null {
  const bucket = readFile(uid).providers[normalizeId(provider)];
  const override = bucket ? bucket[normalizeId(model)] : null;
  return override ? { ...override } : null;
}

export interface SetModelOverrideInput {
  contextWindow?: number | null;
  maxTokens?: number | null;
}

/**
 * Write (or partially update) the override for one model. Passing `null` for a
 * field removes it; when both fields end up empty the whole model key is
 * removed. Returns the stored patch (null = back to the preset).
 */
export function setModelOverride(
  uid: string,
  provider: string,
  model: string,
  input: SetModelOverrideInput,
  /** Preset values, used to validate the cross-field ceiling when only one half
   *  is overridden (the caller owns preset lookup; this module owns storage). */
  preset: { contextWindow?: number; maxTokens?: number } = {},
): { ok: true; override: ModelAbilityOverride | null } | { ok: false; error: string } {
  const providerId = normalizeId(provider);
  const modelId = normalizeId(model);
  if (!providerId || !modelId) return { ok: false, error: 'provider and model required' };

  const file = readFile(uid);
  const existing = file.providers[providerId]?.[modelId] || {};
  const next: ModelAbilityOverride = { ...existing };

  const applyField = (key: 'contextWindow' | 'maxTokens', value: number | null | undefined, max: number) => {
    if (value === undefined) return true;
    if (value === null) { delete next[key]; return true; }
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) return false;
    next[key] = value;
    return true;
  };
  if (!applyField('contextWindow', input.contextWindow, MAX_OVERRIDE_CONTEXT_WINDOW)) {
    return { ok: false, error: `contextWindow must be a positive safe integer at most ${MAX_OVERRIDE_CONTEXT_WINDOW}` };
  }
  if (!applyField('maxTokens', input.maxTokens, MAX_OVERRIDE_OUTPUT_TOKENS)) {
    return { ok: false, error: `maxTokens must be a positive safe integer at most ${MAX_OVERRIDE_OUTPUT_TOKENS}` };
  }

  // Cross-field ceiling: effective window = override ?? preset, and the same
  // for output — the stored pair must never exceed the effective window.
  const effectiveWindow = next.contextWindow ?? preset.contextWindow;
  const effectiveMax = next.maxTokens ?? preset.maxTokens;
  if (typeof effectiveWindow === 'number' && typeof effectiveMax === 'number' && effectiveMax > effectiveWindow) {
    return { ok: false, error: 'maxTokens must not exceed contextWindow' };
  }

  const providers = { ...file.providers };
  const bucket = { ...(providers[providerId] || {}) };
  if (typeof next.contextWindow === 'number' || typeof next.maxTokens === 'number') {
    next.updatedAt = Date.now();
    bucket[modelId] = next;
  } else {
    delete bucket[modelId];
  }
  if (Object.keys(bucket).length) providers[providerId] = bucket;
  else delete providers[providerId];
  writeFile(uid, { version: SCHEMA_VERSION, providers });
  log.info('model override written', {
    provider: providerId,
    model: modelId,
    contextWindow: next.contextWindow,
    maxTokens: next.maxTokens,
  });
  return { ok: true, override: bucket[modelId] ? { ...bucket[modelId] } : null };
}

/** Drop the override for one model (back to the shipped/Server preset). */
export function clearModelOverride(
  uid: string,
  provider: string,
  model: string,
): { ok: true; cleared: boolean } {
  const providerId = normalizeId(provider);
  const modelId = normalizeId(model);
  const file = readFile(uid);
  const bucket = file.providers[providerId];
  if (!providerId || !modelId || !bucket || !bucket[modelId]) return { ok: true, cleared: false };
  const providers = { ...file.providers };
  const nextBucket = { ...bucket };
  delete nextBucket[modelId];
  if (Object.keys(nextBucket).length) providers[providerId] = nextBucket;
  else delete providers[providerId];
  writeFile(uid, { version: SCHEMA_VERSION, providers });
  log.info('model override cleared', { provider: providerId, model: modelId });
  return { ok: true, cleared: true };
}

/**
 * Install the storage-backed resolver into the model layer (called at boot, and
 * idempotent so tests may call it directly). Wrapped in try/catch because an
 * inactive user at boot must not break startup — reads then fall back to the
 * shipped preset until a user is active.
 */
export function installModelOverrideResolver(): void {
  setModelAbilityOverrideResolver((providerId, modelId) => {
    let uid = '';
    try { uid = getActiveUserId(); } catch { return null; }
    if (!uid) return null;
    return resolveModelOverride(uid, providerId, modelId);
  });
}

export interface ModelAbilityRow {
  id: string;
  name: string;
  /** 预设（或 Server 目录）值——覆盖前的事实。 */
  preset: { contextWindow?: number; maxTokens?: number };
  /** 运行时实际使用的值（覆盖优先）。 */
  effective: { contextWindow?: number; maxTokens?: number };
  overridden: boolean;
}

/** 把「预设 vs 本地覆盖 vs 生效值」三态整理给设置页的预设详情面板。 */
export function describeModelAbilityOverrides(
  uid: string,
  providerId: string,
  presetModels: readonly { id: string; name?: string; contextWindow?: number; maxTokens?: number }[],
): ModelAbilityRow[] {
  const stored = readFile(uid).providers[normalizeId(providerId)] || {};
  const pick = (value: unknown): number | undefined =>
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ? value : undefined;
  return presetModels.map((model) => {
    const id = normalizeId(model.id);
    const override = stored[id] || null;
    const presetWindow = pick(model.contextWindow);
    const presetMax = pick(model.maxTokens);
    const overrideWindow = pick(override?.contextWindow);
    const overrideMax = pick(override?.maxTokens);
    const effectiveWindow = overrideWindow ?? presetWindow;
    const effectiveMax = overrideMax ?? presetMax;
    return {
      id,
      name: String(model.name || model.id),
      preset: {
        ...(presetWindow !== undefined ? { contextWindow: presetWindow } : {}),
        ...(presetMax !== undefined ? { maxTokens: presetMax } : {}),
      },
      effective: {
        ...(effectiveWindow !== undefined ? { contextWindow: effectiveWindow } : {}),
        ...(effectiveMax !== undefined ? { maxTokens: effectiveMax } : {}),
      },
      overridden: overrideWindow !== undefined || overrideMax !== undefined,
    };
  });
}

/** Test-only: drop the in-process cache so a fresh file read is forced. */
export function _resetModelOverridesCacheForTest(): void {
  _cache.clear();
}
