/**
 * Custom LLM provider management (CC Switch–style generic endpoints).
 *
 * A "custom provider" is a free-form, user-supplied endpoint that speaks one
 * of the three API dialects Orkas already routes (anthropic / openai /
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
  addEntry,
  loadCustomProviders,
  removeEntriesForProvider,
  saveCustomProviders,
  type CustomProvider,
} from './auth';
import { createLogger } from '../logger';

const log = createLogger('custom-providers');

export type CustomProviderProtocol = CustomProvider['protocol'];

const PROTOCOLS: readonly CustomProviderProtocol[] = ['anthropic', 'openai', 'gemini'];

let _idCounter = 0;
function nextCustomProviderId(): string {
  _idCounter = (_idCounter + 1) % 100000;
  return `cp-${Date.now().toString(36)}-${_idCounter}`;
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
  return PROTOCOLS.includes(raw as CustomProviderProtocol)
    ? (raw as CustomProviderProtocol)
    : 'anthropic';
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

function normalizeModels(models: unknown): string[] | undefined {
  if (!Array.isArray(models)) return undefined;
  const out = models
    .map((m) => String(m || '').trim())
    .filter(Boolean)
    .slice(0, 100);
  return out.length ? out : undefined;
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
): { ok: true; id: string } | { ok: false; error: string } {
  const name = sanitizeName(input.name || '');
  const baseUrl = normalizeBaseUrl(input.baseUrl || '');
  const apiKey = String(input.apiKey || '').trim();

  if (!name) return { ok: false, error: 'name required' };
  if (!baseUrl) return { ok: false, error: 'baseUrl required (http(s)://...)' };
  if (!apiKey) return { ok: false, error: 'apiKey required' };

  const models = normalizeModels(input.models);
  const provider: CustomProvider = {
    id: nextCustomProviderId(),
    name,
    protocol: normalizeProtocol(input.protocol),
    baseUrl,
    apiKey,
    ...(sanitizeNote(input.notes) ? { notes: sanitizeNote(input.notes) } : {}),
    ...(normalizeWebsiteUrl(input.websiteUrl) ? { websiteUrl: normalizeWebsiteUrl(input.websiteUrl) } : {}),
    ...(input.needsModelMapping ? { needsModelMapping: true } : {}),
    ...(models ? { models } : {}),
    source: input.source === 'ccswitch' ? 'ccswitch' : 'manual',
    ...(input.externalId ? { externalId: String(input.externalId) } : {}),
    createdAt: Date.now(),
  };

  const list = listCustomProviders(userId);
  list.unshift(provider);
  saveCustomProviders(userId, list);
  log.info('custom provider added', { id: provider.id, protocol: provider.protocol, source: provider.source });
  return { ok: true, id: provider.id };
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
  const list = listCustomProviders(userId);
  const idx = list.findIndex((p) => p.id === id);
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

  const models = input.models !== undefined ? normalizeModels(input.models) : prev.models;

  list[idx] = {
    ...prev,
    name,
    protocol: input.protocol !== undefined ? normalizeProtocol(input.protocol) : prev.protocol,
    baseUrl,
    apiKey,
    notes: input.notes !== undefined ? sanitizeNote(input.notes) : prev.notes,
    websiteUrl: input.websiteUrl !== undefined ? normalizeWebsiteUrl(input.websiteUrl) : prev.websiteUrl,
    needsModelMapping: input.needsModelMapping !== undefined ? !!input.needsModelMapping : prev.needsModelMapping,
    models,
    // A real key was supplied → the row is no longer "needs key".
    ...(apiKey ? { needsKey: false } : {}),
    updatedAt: Date.now(),
  };
  saveCustomProviders(userId, list);
  log.info('custom provider updated', { id });
  return { ok: true };
}

export function removeCustomProvider(userId: string, id: string): { ok: boolean } {
  const list = listCustomProviders(userId);
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return { ok: false };
  saveCustomProviders(userId, next);
  removeEntriesForProvider(userId, `cp:${id}`);
  log.info('custom provider removed', { id });
  return { ok: true };
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
export async function syncFromCcSwitch(userId: string, selectedExternalIds?: string[], home?: string): Promise<CcSwitchSyncResult> {
  // Lazy require to keep better-sqlite3 out of the module load path for
  // callers that never import from CC Switch.
  const { readCcSwitchImportItems } = require('./ccswitch_import') as typeof import('./ccswitch_import');
  const res = readCcSwitchImportItems(home);
  if (!res.ok) return { ok: false, reason: (res as { reason: string }).reason, added: 0, updated: 0, bound: 0, total: 0 };

  const wanted = selectedExternalIds && selectedExternalIds.length
    ? new Set(selectedExternalIds)
    : null;
  const items = res.items.filter((it) => !wanted || wanted.has(it.externalId));

  const list = listCustomProviders(userId);
  let added = 0;
  let updated = 0;

  for (const it of items) {
    // Validate base URL through the same http(s) gate as manual adds.
    const baseUrl = normalizeBaseUrl(it.baseUrl);
    if (!baseUrl) continue;
    const apiKey = it.apiKey || '';
    const needsKey = !apiKey || !!it.needsKey;

    const existingIdx = list.findIndex((p) => p.source === 'ccswitch' && p.externalId === it.externalId);
    if (existingIdx >= 0) {
      const prev = list[existingIdx];
      list[existingIdx] = {
        ...prev,
        name: it.name || prev.name,
        protocol: it.protocol,
        baseUrl,
        // Never overwrite a user-supplied key with an empty import. If CC
        // Switch still has no key but the user already filled one in, keep it.
        apiKey: apiKey || prev.apiKey,
        notes: it.notes ?? prev.notes,
        websiteUrl: it.websiteUrl ?? prev.websiteUrl,
        models: it.models?.length ? it.models : prev.models,
        ...(apiKey || prev.apiKey ? { needsKey: false } : { needsKey: true }),
        updatedAt: Date.now(),
      };
      updated++;
    } else {
      list.unshift({
        id: nextCustomProviderId(),
        name: it.name,
        protocol: it.protocol,
        baseUrl,
        apiKey,
        ...(it.notes ? { notes: it.notes } : {}),
        ...(it.websiteUrl ? { websiteUrl: it.websiteUrl } : {}),
        ...(it.models?.length ? { models: it.models } : {}),
        source: 'ccswitch',
        externalId: it.externalId,
        ...(needsKey ? { needsKey: true } : {}),
        createdAt: Date.now(),
      });
      added++;
    }
  }

  if (added || updated) saveCustomProviders(userId, list);

  const bound = await ensureCcSwitchBoundEntries(userId);

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
  const list = listCustomProviders(userId);
  let bound = 0;
  for (const p of list) {
    if (p.source !== 'ccswitch') continue;
    if (!p.apiKey) continue;
    if (!p.models?.length) continue;
    try {
      await addEntry({
        provider: `cp:${p.id}`,
        model: p.models[0],
        profileId: `cp:${p.id}`,
      });
      bound += 1;
    } catch (err) {
      log.warn('cc-switch auto-bind entry failed', { provider: p.id, error: (err as Error).message });
    }
  }
  return bound;
}

/** Preview importable CC Switch providers (no write). apiKey is masked by the
 *  IPC layer before reaching the renderer. */
export function previewCcSwitchImport(userId: string):
  | { ok: true; items: import('./ccswitch_import').CcSwitchImportItem[]; skipped: import('./ccswitch_import').CcSwitchSkippedItem[] }
  | { ok: false; reason: string } {
  const { readCcSwitchImportItems } = require('./ccswitch_import') as typeof import('./ccswitch_import');
  void userId;
  const res = readCcSwitchImportItems();
  if (!res.ok) return { ok: false, reason: (res as { reason: string }).reason };
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
