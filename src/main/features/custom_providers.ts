/**
 * Custom LLM provider management (CC Switch–style generic endpoints).
 *
 * A "custom provider" is a free-form, user-supplied endpoint that speaks one
 * of the three API dialects CogSeed already routes (anthropic / openai /
 * gemini). Unlike the curated catalog providers, it carries its own base URL
 * and bearer key — think of the DeepSeek/Moonshot adapters, but declared at
 * runtime by the user instead of hard-coded.
 *
 * Phase 1 (this module): CRUD + encrypted persistence only. The stored list
 * is NOT yet consumed by chat routing or the CLI backends — those are wired
 * in phase 2 (built-in models via external-providers.ts) and phase 3 (CLI env
 * injection via features/local_agents). Keeping persistence isolated here
 * lets the settings UI ship and be verified independently.
 *
 * Storage lives in auth.ts's encrypted `auth-profiles.json` (customProviders
 * array), so keys are encrypted at rest with the same backend as every other
 * credential and never touch a plaintext file or the logs.
 */

import {
  createCustomProviderEntry,
  DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_PROVIDER_MAX_TOKENS,
  loadCustomProviders,
  MAX_CUSTOM_PROVIDER_CONTEXT_WINDOW,
  MAX_CUSTOM_PROVIDER_MAX_TOKENS,
  MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
  MAX_CUSTOM_PROVIDER_MODELS,
  mutateCustomProviders,
  type CustomProvider,
  type CustomProviderModel,
} from './auth';
import { publicContextWindowFor, publicModelAbilitiesFor } from '../model/public_model_catalog';
import { createLogger } from '../logger';

const log = createLogger('custom-providers');

export type CustomProviderProtocol = CustomProvider['protocol'];

const PROTOCOLS: readonly CustomProviderProtocol[] = ['anthropic', 'openai', 'openai-responses', 'gemini'];

let _idCounter = 0;
function nextCustomProviderId(existing: readonly CustomProvider[]): string {
  const used = new Set(existing.map((provider) => provider.id));
  for (let attempt = 0; attempt < 1000; attempt++) {
    _idCounter = (_idCounter + 1) % 100000;
    const id = `cp-${Date.now().toString(36)}-${_idCounter}`;
    if (!used.has(id)) return id;
  }
  throw new Error('could not allocate custom provider id');
}

function sanitizeName(input: string): string {
  return String(input || '').trim().slice(0, 60);
}

function sanitizeNote(input: string | undefined): string | undefined {
  const s = String(input || '').trim().slice(0, 200);
  return s || undefined;
}

/** Normalize + validate a request base URL. Only http(s) is allowed — this is
 *  a hard security boundary (see phase-1 review): a malformed or hostile entry
 *  (including anything imported from CC Switch) must never yield a non-http
 *  scheme that later gets handed to a fetch/spawn path. */
function normalizeBaseUrl(raw: string): string | null {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  let url: URL;
  try { url = new URL(s); }
  catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return s;
}

function normalizeProtocol(raw: unknown): CustomProviderProtocol {
  if (!PROTOCOLS.includes(raw as CustomProviderProtocol)) throw new Error('invalid protocol');
  return raw as CustomProviderProtocol;
}

function normalizeWebsiteUrl(raw: string | undefined): string | undefined {
  const s = String(raw || '').trim();
  if (!s) return undefined;
  try {
    const url = new URL(s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return s;
  } catch {
    return undefined;
  }
}

function normalizePositiveSafeInteger(
  value: unknown,
  field: 'contextWindow' | 'maxTokens',
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new Error(`${field} must be a positive safe integer at most ${max}`);
  }
  return value as number;
}

function normalizeModel(
  raw: unknown,
  fallback?: CustomProviderModel,
): CustomProviderModel {
  const value = typeof raw === 'string' ? { id: raw } : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model must be an object or string id');
  const candidate = value as { id?: unknown; contextWindow?: unknown; maxTokens?: unknown; vision?: unknown };
  if (typeof candidate.id !== 'string') throw new Error('model id required');
  const id = candidate.id.trim();
  if (!id) throw new Error('model id required');
  if (id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH) {
    throw new Error(`model id must be at most ${MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH} characters`);
  }
  // Window fallback chain: explicit value → catalog (known model) → default
  // guess. The catalog beat-out prevents importer rows (CC Switch hints carry
  // only ids) from silently carrying a wrong 128K default for models whose
  // real window is public knowledge.
  const contextWindow = normalizePositiveSafeInteger(
    candidate.contextWindow,
    'contextWindow',
    fallback?.contextWindow
      ?? publicContextWindowFor(id)
      ?? DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW,
    MAX_CUSTOM_PROVIDER_CONTEXT_WINDOW,
  );
  // Vision has NO guessed default: explicit > fallback > catalog, else
  // undefined (= unknown; consumers treat unknown as pass-through).
  const rawVision = candidate.vision;
  const vision = typeof rawVision === 'boolean'
    ? rawVision
    : (typeof fallback?.vision === 'boolean' ? fallback.vision : publicModelAbilitiesFor(id).vision);
  const maxTokens = normalizePositiveSafeInteger(
    candidate.maxTokens,
    'maxTokens',
    fallback?.maxTokens ?? DEFAULT_CUSTOM_PROVIDER_MAX_TOKENS,
    MAX_CUSTOM_PROVIDER_MAX_TOKENS,
  );
  if (maxTokens > contextWindow) throw new Error('maxTokens must not exceed contextWindow');
  return { id, contextWindow, maxTokens, ...(vision !== undefined ? { vision } : {}) };
}

function normalizeModels(models: unknown): CustomProviderModel[] {
  if (models === undefined) return [];
  if (!Array.isArray(models)) throw new Error('models must be an array');
  if (models.length > MAX_CUSTOM_PROVIDER_MODELS) {
    throw new Error(`models must contain at most ${MAX_CUSTOM_PROVIDER_MODELS} items`);
  }
  const out: CustomProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const model = normalizeModel(raw);
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function normalizeProviderId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.length > 120) throw new Error('invalid provider id');
  return id;
}

function removeProviderModelEntries(
  entries: import('./auth').CustomProviderEntry[],
  syntheticProviderId: string,
  modelId?: string,
): void {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const belongs = entry.provider === syntheticProviderId || entry.profileId === syntheticProviderId;
    if (belongs && (modelId === undefined || entry.model === modelId)) entries.splice(index, 1);
  }
}

export function listCustomProviders(userId: string): CustomProvider[] {
  return loadCustomProviders(userId);
}

export interface AddCustomProviderInput {
  name?: string;
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
  notes?: string;
  websiteUrl?: string;
  needsModelMapping?: boolean;
  models?: unknown;
  source?: string;
  externalId?: string;
}

export function addCustomProvider(
  userId: string,
  input: AddCustomProviderInput,
  position: 'front' | 'back' = 'front',
): { ok: true; id: string } | { ok: false; error: string } {
  const name = sanitizeName(input?.name || '');
  const baseUrl = normalizeBaseUrl(input?.baseUrl || '');
  const apiKey = String(input?.apiKey || '').trim();

  if (!name) return { ok: false, error: 'name required' };
  if (!baseUrl) return { ok: false, error: 'baseUrl required (http(s)://...)' };
  if (!apiKey) return { ok: false, error: 'apiKey required' };

  let protocol: CustomProviderProtocol;
  let models: CustomProviderModel[];
  try {
    protocol = normalizeProtocol(input.protocol);
    models = normalizeModels(input.models);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const id = mutateCustomProviders(userId, ({ customProviders, entries }) => {
    const provider: CustomProvider = {
      id: nextCustomProviderId(customProviders),
      name,
      protocol,
      baseUrl,
      apiKey,
      enabled: true,
      ...(sanitizeNote(input.notes) ? { notes: sanitizeNote(input.notes) } : {}),
      ...(normalizeWebsiteUrl(input.websiteUrl) ? { websiteUrl: normalizeWebsiteUrl(input.websiteUrl) } : {}),
      ...(input.needsModelMapping ? { needsModelMapping: true } : {}),
      models,
      source: input.source === 'ccswitch' ? 'ccswitch' : 'manual',
      ...(input.externalId ? { externalId: String(input.externalId).trim().slice(0, 160) } : {}),
      createdAt: Date.now(),
    };
    // `front` keeps the existing "newest provider becomes the primary chat
    // entry" behaviour; `back` appends so a later "connect & store" CLI does
    // not steal the primary slot from the first connected one (it becomes a
    // fallback instead — chat dispatch walks entries in order).
    if (position === 'back') {
      customProviders.push(provider);
      if (models[0]) entries.push(createCustomProviderEntry(provider.id, models[0].id));
    } else {
      customProviders.unshift(provider);
      if (models[0]) entries.unshift(createCustomProviderEntry(provider.id, models[0].id));
    }
    return provider.id;
  });
  log.info('custom provider added', { id, protocol, source: input.source === 'ccswitch' ? 'ccswitch' : 'manual' });
  return { ok: true, id };
}

export interface UpdateCustomProviderInput {
  name?: string;
  protocol?: string;
  baseUrl?: string;
  apiKey?: string; // when omitted/empty, keep the existing key
  notes?: string;
  websiteUrl?: string;
  needsModelMapping?: boolean;
  models?: unknown;
}

export function updateCustomProvider(
  userId: string,
  id: string,
  input: UpdateCustomProviderInput,
): { ok: true } | { ok: false; error: string } {
  let providerId: string;
  try { providerId = normalizeProviderId(id); }
  catch (error) { return { ok: false, error: (error as Error).message }; }
  const list = listCustomProviders(userId);
  const idx = list.findIndex((p) => p.id === providerId);
  if (idx < 0) return { ok: false, error: 'not found' };
  const prev = list[idx];

  const name = input.name !== undefined ? sanitizeName(input.name) : prev.name;
  if (!name) return { ok: false, error: 'name required' };

  let baseUrl = prev.baseUrl;
  if (input.baseUrl !== undefined) {
    const nb = normalizeBaseUrl(input.baseUrl);
    if (!nb) return { ok: false, error: 'baseUrl required (http(s)://...)' };
    baseUrl = nb;
  }

  const apiKey = String(input.apiKey || '').trim() || prev.apiKey;
  if (!apiKey) return { ok: false, error: 'apiKey required' };

  let protocol = prev.protocol;
  let models = prev.models;
  try {
    if (input.protocol !== undefined) protocol = normalizeProtocol(input.protocol);
    if (input.models !== undefined) models = normalizeModels(input.models);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  mutateCustomProviders(userId, ({ customProviders, entries }) => {
    const target = customProviders.find((provider) => provider.id === providerId);
    if (!target) throw new Error('custom provider not found during update');
    Object.assign(target, {
      name,
      protocol,
      baseUrl,
      apiKey,
      notes: input.notes !== undefined ? sanitizeNote(input.notes) : target.notes,
      websiteUrl: input.websiteUrl !== undefined ? normalizeWebsiteUrl(input.websiteUrl) : target.websiteUrl,
      needsModelMapping: input.needsModelMapping !== undefined ? !!input.needsModelMapping : target.needsModelMapping,
      models,
      needsKey: false,
      updatedAt: Date.now(),
    });
    if (input.models !== undefined) {
      const retained = new Set(models.map((model) => model.id));
      const synthetic = `cp:${providerId}`;
      for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
        const entry = entries[entryIndex];
        if ((entry.provider === synthetic || entry.profileId === synthetic) && !retained.has(entry.model)) {
          entries.splice(entryIndex, 1);
        }
      }
    }
  });
  log.info('custom provider updated', { id: providerId });
  return { ok: true };
}

export function removeCustomProvider(userId: string, id: string): { ok: boolean } {
  let providerId: string;
  try { providerId = normalizeProviderId(id); }
  catch { return { ok: false }; }
  const exists = listCustomProviders(userId).some((provider) => provider.id === providerId);
  if (!exists) return { ok: false };
  mutateCustomProviders(userId, ({ customProviders, entries }) => {
    const index = customProviders.findIndex((provider) => provider.id === providerId);
    if (index < 0) throw new Error('custom provider not found during remove');
    customProviders.splice(index, 1);
    removeProviderModelEntries(entries, `cp:${providerId}`);
  });
  log.info('custom provider removed', { id: providerId });
  return { ok: true };
}

export function setCustomProviderEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): { ok: true; enabled: boolean } | { ok: false; error: string } {
  let providerId: string;
  try { providerId = normalizeProviderId(id); }
  catch (error) { return { ok: false, error: (error as Error).message }; }
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be boolean' };
  if (!listCustomProviders(userId).some((provider) => provider.id === providerId)) {
    return { ok: false, error: 'not found' };
  }
  mutateCustomProviders(userId, ({ customProviders }) => {
    const provider = customProviders.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error('custom provider not found during enable update');
    provider.enabled = enabled;
    provider.updatedAt = Date.now();
  });
  log.info('custom provider enabled state changed', { id: providerId, enabled });
  return { ok: true, enabled };
}

export function addCustomProviderModel(
  userId: string,
  id: string,
  input: unknown,
): { ok: true; model: CustomProviderModel } | { ok: false; error: string } {
  let providerId: string;
  let model: CustomProviderModel;
  try {
    providerId = normalizeProviderId(id);
    model = normalizeModel(input);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const provider = listCustomProviders(userId).find((candidate) => candidate.id === providerId);
  if (!provider) return { ok: false, error: 'not found' };
  if (provider.models.some((candidate) => candidate.id === model.id)) return { ok: false, error: 'model already exists' };
  if (provider.models.length >= MAX_CUSTOM_PROVIDER_MODELS) {
    return { ok: false, error: `models must contain at most ${MAX_CUSTOM_PROVIDER_MODELS} items` };
  }
  mutateCustomProviders(userId, ({ customProviders }) => {
    const target = customProviders.find((candidate) => candidate.id === providerId);
    if (!target) throw new Error('custom provider not found during model add');
    target.models.push(model);
    target.updatedAt = Date.now();
  });
  return { ok: true, model };
}

export function updateCustomProviderModel(
  userId: string,
  id: string,
  modelId: string,
  input: unknown,
): { ok: true; model: CustomProviderModel } | { ok: false; error: string } {
  let providerId: string;
  let previousId: string;
  try {
    providerId = normalizeProviderId(id);
    previousId = normalizeModel({ id: modelId }).id;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const provider = listCustomProviders(userId).find((candidate) => candidate.id === providerId);
  if (!provider) return { ok: false, error: 'not found' };
  const previous = provider.models.find((candidate) => candidate.id === previousId);
  if (!previous) return { ok: false, error: 'model not found' };
  let model: CustomProviderModel;
  try { model = normalizeModel(input, previous); }
  catch (error) { return { ok: false, error: (error as Error).message }; }
  if (model.id !== previousId && provider.models.some((candidate) => candidate.id === model.id)) {
    return { ok: false, error: 'model already exists' };
  }
  mutateCustomProviders(userId, ({ customProviders, entries }) => {
    const target = customProviders.find((candidate) => candidate.id === providerId);
    const modelIndex = target?.models.findIndex((candidate) => candidate.id === previousId) ?? -1;
    if (!target || modelIndex < 0) throw new Error('custom provider model not found during update');
    target.models[modelIndex] = model;
    target.updatedAt = Date.now();
    if (model.id !== previousId) {
      const synthetic = `cp:${providerId}`;
      for (const entry of entries) {
        if ((entry.provider === synthetic || entry.profileId === synthetic) && entry.model === previousId) {
          entry.model = model.id;
        }
      }
    }
  });
  return { ok: true, model };
}

export function removeCustomProviderModel(
  userId: string,
  id: string,
  modelId: string,
): { ok: true; removed: true } | { ok: false; error: string } {
  let providerId: string;
  let targetModelId: string;
  try {
    providerId = normalizeProviderId(id);
    targetModelId = normalizeModel({ id: modelId }).id;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const provider = listCustomProviders(userId).find((candidate) => candidate.id === providerId);
  if (!provider) return { ok: false, error: 'not found' };
  if (!provider.models.some((candidate) => candidate.id === targetModelId)) return { ok: false, error: 'model not found' };
  mutateCustomProviders(userId, ({ customProviders, entries }) => {
    const target = customProviders.find((candidate) => candidate.id === providerId);
    const modelIndex = target?.models.findIndex((candidate) => candidate.id === targetModelId) ?? -1;
    if (!target || modelIndex < 0) throw new Error('custom provider model not found during remove');
    target.models.splice(modelIndex, 1);
    target.updatedAt = Date.now();
    removeProviderModelEntries(entries, `cp:${providerId}`, targetModelId);
  });
  return { ok: true, removed: true };
}

export async function testCustomProviderModel(
  userId: string,
  id: string,
  modelId: string,
): Promise<import('./auth').TestConnectionResult> {
  let providerId: string;
  let targetModelId: string;
  try {
    providerId = normalizeProviderId(id);
    targetModelId = normalizeModel({ id: modelId }).id;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const provider = listCustomProviders(userId).find((candidate) => candidate.id === providerId);
  if (!provider) return { ok: false, error: 'not found' };
  if (!provider.models.some((candidate) => candidate.id === targetModelId)) return { ok: false, error: 'model not found' };
  const auth = await import('./auth');
  return auth.testAuthorizationDraft(userId, {
    kind: 'custom_api_key',
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: targetModelId,
  });
}

/** Preset protocol choices for the add form's dialect selector. */
export function listCustomProviderProtocols(): Array<{ id: CustomProviderProtocol; label: string }> {
  return [
    { id: 'anthropic', label: 'Anthropic (Claude)' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'gemini', label: 'Gemini' },
  ];
}

// ── Third-party sync: CC Switch ───────────────────────────────────────────

export interface CcSwitchSyncResult {
  ok: boolean;
  reason?: string;
  added: number;
  updated: number;
  bound: number;
  total: number;
}

/**
 * Import (or re-sync) providers from CC Switch. Idempotent: a provider already
 * imported (matched by `source:'ccswitch'` + `externalId`) is updated in place
 * (endpoint / key / name refreshed) rather than duplicated. Manually-added
 * providers are never touched.
 *
 * `selectedExternalIds`, when provided, restricts the import to those ids
 * (the user-confirmed subset from the preview). When omitted, all importable
 * CC Switch providers are synced — used by the "re-sync" action.
 */
export async function syncFromCcSwitch(
  userId: string,
  selectedExternalIds?: string[],
  home?: string,
  modelsByExternalId?: Record<string, string[]>,
  baseUrlsByExternalId?: Record<string, string>,
  windowsByExternalId?: Record<string, Record<string, number>>,
  abilitiesByExternalId?: Record<string, Record<string, { contextWindow?: number; vision?: boolean }>>,
): Promise<CcSwitchSyncResult> {
  // Lazy require to keep better-sqlite3 out of the module load path for
  // callers that never import from CC Switch.
  const { readCcSwitchImportItems } = require('./ccswitch_import') as typeof import('./ccswitch_import');
  const res = readCcSwitchImportItems(home);
  if (!res.ok) return { ok: false, reason: (res as { reason: string }).reason, added: 0, updated: 0, bound: 0, total: 0 };

  const wanted = selectedExternalIds === undefined ? null : new Set(selectedExternalIds);
  const items = res.items.filter((it) => !wanted || wanted.has(it.externalId));

  let added = 0;
  let updated = 0;
  let bound = 0;
  if (items.length) {
    mutateCustomProviders(userId, ({ customProviders, entries }) => {
      for (const it of items) {
        // Prefer the live-probed api base (fixes bare-host base_urls).
        const baseUrl = normalizeBaseUrl(baseUrlsByExternalId?.[it.externalId] || it.baseUrl);
        if (!baseUrl) continue;
        const apiKey = String(it.apiKey || '').trim();
        const needsKey = !apiKey || !!it.needsKey;
        // Prefer the live-probed model list (passed from the preview step);
        // fall back to the config hints when probing wasn't possible.
        // Probed abilities (aggregator endpoints volunteer them) ride along
        // as the highest-priority source — normalizeModel then applies
        // explicit > probe > catalog > default per field.
        const rawModels: unknown[] = modelsByExternalId?.[it.externalId] || it.models || [];
        const probeAbilities = abilitiesByExternalId?.[it.externalId] || it.modelAbilities || {};
        const importedModels = normalizeModels(rawModels.map((m) => {
          if (typeof m !== 'string') return m;
          const a = probeAbilities[m];
          if (!a) return m;
          const out: { id: string; contextWindow?: number; vision?: boolean } = { id: m };
          const w = a.contextWindow;
          if (Number.isSafeInteger(w) && (w as number) > 0 && (w as number) <= MAX_CUSTOM_PROVIDER_CONTEXT_WINDOW) {
            out.contextWindow = w;
          }
          if (typeof a.vision === 'boolean') out.vision = a.vision;
          return out.contextWindow !== undefined || out.vision !== undefined ? out : m;
        }));
        const existing = customProviders.find((provider) => provider.source === 'ccswitch' && provider.externalId === it.externalId);
        let provider: CustomProvider;
        if (existing) {
          const existingMetadata = new Map(existing.models.map((model) => [model.id, model]));
          const mergedModels = importedModels.length
            ? importedModels.map((model) => {
              const prev = existingMetadata.get(model.id);
              if (!prev) return model;
              // A stored window equal to the default is an unconfirmed guess
              // (importers historically had no window source) — replace it
              // when this import resolved a better value (probe field or
              // catalog match inside normalizeModel). User-entered values
              // that differ from the default are deliberate: never touch.
              // Vision has no guessed default (undefined = unknown), so an
              // absent value is simply filled in when this import knows it.
              let next = prev;
              if (prev.contextWindow === DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW
                && model.contextWindow !== DEFAULT_CUSTOM_PROVIDER_CONTEXT_WINDOW) {
                next = { ...next, contextWindow: model.contextWindow };
              }
              if (prev.vision === undefined && typeof model.vision === 'boolean') {
                next = { ...next, vision: model.vision };
              }
              return next;
            })
            : existing.models;
          Object.assign(existing, {
            name: it.name || existing.name,
            protocol: it.protocol,
            baseUrl,
            apiKey: apiKey || existing.apiKey,
            notes: it.notes ?? existing.notes,
            websiteUrl: it.websiteUrl ?? existing.websiteUrl,
            models: mergedModels,
            needsKey: !(apiKey || existing.apiKey),
            updatedAt: Date.now(),
          });
          provider = existing;
          updated++;
        } else {
          provider = {
            id: nextCustomProviderId(customProviders),
            name: it.name,
            protocol: it.protocol,
            baseUrl,
            apiKey,
            enabled: true,
            ...(it.notes ? { notes: it.notes } : {}),
            ...(it.websiteUrl ? { websiteUrl: it.websiteUrl } : {}),
            models: importedModels,
            source: 'ccswitch',
            externalId: it.externalId,
            ...(needsKey ? { needsKey: true } : {}),
            createdAt: Date.now(),
          };
          // Append, never unshift: a later connect & store (or re-sync) must
          // not move CC Switch models ahead of the primary `cli:active`
          // provider that the first connect & store established.
          customProviders.push(provider);
          added++;
        }
        if (!provider.apiKey || !provider.models[0]) continue;
        const synthetic = `cp:${provider.id}`;
        const exists = entries.some((entry) => entry.provider === synthetic
          && entry.profileId === synthetic
          && entry.model === provider.models[0].id);
        if (!exists) {
          // Append (see the provider insertion above): keep primary order stable.
          entries.push(createCustomProviderEntry(provider.id, provider.models[0].id));
          bound++;
        }
      }
    });
  }

  log.info('cc-switch sync done', { added, updated, bound, total: items.length });
  return { ok: true, added, updated, bound, total: items.length };
}

/**
 * Bind the first declared model of every synced CC Switch provider to an
 * entry, so chat dispatch (pickChatEntry — which walks `store.entries` only)
 * can actually use it. A synced provider without a bound entry is invisible
 * to chat even though the UI said "connected". Idempotent via addEntry's
 * dedupe; providers without a declared model list are left unbound (we never
 * guess a model name). Runs on every sync AND at boot (via boot_init) so
 * providers synced before this fix heal themselves without a manual re-sync.
 */
export async function ensureCcSwitchBoundEntries(userId: string): Promise<number> {
  let bound = 0;
  const needsRepair = listCustomProviders(userId).some((provider) => provider.source === 'ccswitch'
    && !!provider.apiKey
    && !!provider.models[0]);
  if (!needsRepair) return 0;
  mutateCustomProviders(userId, ({ customProviders, entries }) => {
    for (const provider of customProviders) {
      if (provider.source !== 'ccswitch' || !provider.apiKey || !provider.models[0]) continue;
      const synthetic = `cp:${provider.id}`;
      const exists = entries.some((entry) => entry.provider === synthetic
        && entry.profileId === synthetic
        && entry.model === provider.models[0].id);
      if (exists) continue;
      // Append (see syncFromCcSwitch): boot-time repair must not reorder
      // existing primary/fallback slots established by connect & store.
      entries.push(createCustomProviderEntry(provider.id, provider.models[0].id));
      bound++;
    }
  });
  return bound;
}

/** Preview importable CC Switch providers (no write). apiKey is masked by the
 *  IPC layer before reaching the renderer. */
export async function previewCcSwitchImport(userId: string): Promise<
  | { ok: true; items: import('./ccswitch_import').CcSwitchImportItem[]; skipped: import('./ccswitch_import').CcSwitchSkippedItem[] }
  | { ok: false; reason: string }
> {
  const { readCcSwitchImportItems, probeProviderModels } = require('./ccswitch_import') as typeof import('./ccswitch_import');
  void userId;
  const res = readCcSwitchImportItems();
  if (!res.ok) return { ok: false, reason: (res as { reason: string }).reason };
  // Group rows by (protocol, baseUrl, apiKey): endpoints that share the same
  // URL + key point at the same backend, so one real probe covers all of
  // them (config model hints can be wrong/stale and are only a fallback).
  const groups = new Map<string, import('./ccswitch_import').CcSwitchImportItem[]>();
  for (const item of res.items) {
    const key = item.protocol + '\u0000' + item.baseUrl + '\u0000' + (item.apiKey || '');
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  const groupResults = await Promise.all([...groups.values()].map(async (group) => {
    const first = group[0];
    return { group, probe: await probeProviderModels(first.protocol, first.baseUrl, first.apiKey) };
  }));
  for (const { group, probe } of groupResults) {
    for (const item of group) {
      if (probe.ok) {
        item.models = probe.models;
        item.modelsProbe = true;
        // Abilities volunteered by the endpoint (aggregators only; sparse).
        if (probe.abilities && Object.keys(probe.abilities).length) {
          item.modelAbilities = probe.abilities;
        }
        // Pin the real API base discovered by the probe (CC Switch configs
        // often store a bare host without the /v1 segment).
        if (probe.baseUrl) item.baseUrl = probe.baseUrl;
      } else {
        // Probe failed (offline / unsupported endpoint / bad key): keep the
        // config hints and mark them as unverified in the UI.
        item.modelsProbe = false;
      }
    }
  }
  return { ok: true, items: res.items, skipped: res.skipped };
}

/** Resolve one exact CC Switch row for the unified authorization workflow.
 *  This stays main-process-only: IPC callers receive a short-lived opaque
 *  draft id instead of the raw key. */
export function getCcSwitchAuthorizationSource(
  userId: string,
  externalId: string,
  home?: string,
): { ok: true; item: import('./ccswitch_import').CcSwitchImportItem } | { ok: false; reason: string } {
  void listCustomProviders(userId); // active-user scope assertion
  const id = String(externalId || '').trim().slice(0, 160);
  if (!id) return { ok: false, reason: 'invalid_external_id' };
  const { readCcSwitchImportItems } = require('./ccswitch_import') as typeof import('./ccswitch_import');
  const result = readCcSwitchImportItems(home);
  if (!result.ok) return { ok: false, reason: (result as { ok: false; reason: string }).reason };
  const item = result.items.find((row) => row.externalId === id);
  return item ? { ok: true, item } : { ok: false, reason: 'not_found' };
}
