/**
 * Credential-first model discovery for the unified Settings authorization flow.
 * Raw API keys exist only in the main process during a request or in a bounded,
 * short-lived CC Switch draft. This module never persists credentials.
 */

import { randomBytes } from 'node:crypto';

import { createLogger } from '../logger';
import { getActiveUserId } from './users';
import * as auth from './auth';
import { getCcSwitchAuthorizationSource } from './custom_providers';
import type { CcSwitchImportItem } from './ccswitch_import';

const log = createLogger('model-authorization-discovery');
const DRAFT_TTL_MS = 10 * 60_000;
const MAX_DRAFTS_PER_USER = 20;
const DISCOVERY_TIMEOUT_MS = 20_000;

type Protocol = 'openai' | 'anthropic' | 'gemini';

interface CcSwitchDraft {
  userId: string;
  item: CcSwitchImportItem;
  createdAt: number;
  expiresAt: number;
}

const ccSwitchDrafts = new Map<string, CcSwitchDraft>();

export type AuthorizationDiscoveryInput =
  | { kind: 'builtin'; providerId: string }
  | { kind: 'custom_api_key'; protocol: Protocol; baseUrl: string; apiKey: string }
  | { kind: 'ccswitch_draft'; draftId: string };

export interface DiscoveredModel {
  id: string;
  name: string;
}

export type AuthorizationDiscoveryResult =
  | { ok: true; source: 'catalog' | 'live'; models: DiscoveredModel[] }
  | {
      ok: false;
      errorCode: 'auth_failed' | 'unsupported_discovery' | 'network_error' | 'provider_error' | 'invalid_request' | 'draft_not_found' | 'draft_expired';
      retryable: boolean;
      manualAllowed: boolean;
    };

interface DiscoveryDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface PrepareDraftDeps {
  home?: string;
  now?: () => number;
  randomId?: () => string;
}

function assertUser(userId: string): void {
  if (!userId || getActiveUserId() !== userId) throw new Error('user scope mismatch');
}

function normalizeBaseUrl(raw: unknown): string {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('baseUrl required');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('invalid baseUrl'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('invalid baseUrl');
  }
  return value;
}

function appendModelsPath(baseUrl: string, protocol: Protocol): string {
  const base = normalizeBaseUrl(baseUrl);
  if (protocol === 'openai') return `${base}/models`;
  if (protocol === 'anthropic') return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  return /\/v\d+(?:beta\d*)?$/i.test(base) ? `${base}/models` : `${base}/v1beta/models`;
}

function normalizeModels(rows: Array<{ id?: unknown; name?: unknown }>): DiscoveredModel[] {
  const out: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row?.id || '').trim().replace(/^models\//, '').slice(0, 200);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = String(row?.name || '').trim().slice(0, 240) || id;
    out.push({ id, name });
    if (out.length >= 500) break;
  }
  return out;
}

function evictDrafts(userId: string, now: number): void {
  for (const [id, draft] of ccSwitchDrafts) {
    if (draft.expiresAt <= now) ccSwitchDrafts.delete(id);
  }
  const userDrafts = [...ccSwitchDrafts.entries()]
    .filter(([, draft]) => draft.userId === userId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (userDrafts.length >= MAX_DRAFTS_PER_USER) {
    const oldest = userDrafts.shift();
    if (oldest) ccSwitchDrafts.delete(oldest[0]);
  }
}

export function prepareCcSwitchAuthorization(
  userId: string,
  externalId: string,
  deps: PrepareDraftDeps = {},
):
  | { ok: true; draft: { draftId: string; externalId: string; name: string; protocol: Protocol; baseUrl: string; declaredModels: string[] } }
  | { ok: false; errorCode: 'invalid_external_id' | 'not_found' | 'not_installed' | 'unreadable' | 'bad_schema' | 'missing_key' } {
  assertUser(userId);
  const source = getCcSwitchAuthorizationSource(userId, externalId, deps.home);
  if (!source.ok) return { ok: false, errorCode: (source as { ok: false; reason: string }).reason as any };
  if (!String(source.item.apiKey || '').trim() || source.item.needsKey) return { ok: false, errorCode: 'missing_key' };
  const now = (deps.now || Date.now)();
  evictDrafts(userId, now);
  const draftId = String(deps.randomId ? deps.randomId() : randomBytes(24).toString('base64url')).slice(0, 120);
  ccSwitchDrafts.set(draftId, {
    userId,
    item: source.item,
    createdAt: now,
    expiresAt: now + DRAFT_TTL_MS,
  });
  return {
    ok: true,
    draft: {
      draftId,
      externalId: source.item.externalId,
      name: source.item.name,
      protocol: source.item.protocol,
      baseUrl: source.item.baseUrl,
      declaredModels: source.item.models || [],
    },
  };
}

export function resolveCcSwitchAuthorizationDraft(
  userId: string,
  draftId: string,
  options: { now?: () => number; consume?: boolean } = {},
): { ok: true; item: CcSwitchImportItem } | { ok: false; errorCode: 'draft_not_found' | 'draft_expired' } {
  assertUser(userId);
  const id = String(draftId || '').trim();
  const draft = ccSwitchDrafts.get(id);
  if (!draft || draft.userId !== userId) return { ok: false, errorCode: 'draft_not_found' };
  const now = (options.now || Date.now)();
  if (draft.expiresAt <= now) {
    ccSwitchDrafts.delete(id);
    return { ok: false, errorCode: 'draft_expired' };
  }
  if (options.consume) ccSwitchDrafts.delete(id);
  return { ok: true, item: draft.item };
}

export function __resetAuthorizationDraftsForTests(): void {
  ccSwitchDrafts.clear();
}

function discoveryFailure(status: number): AuthorizationDiscoveryResult {
  if (status === 401 || status === 403) {
    return { ok: false, errorCode: 'auth_failed', retryable: false, manualAllowed: false };
  }
  if (status === 404 || status === 405) {
    return { ok: false, errorCode: 'unsupported_discovery', retryable: false, manualAllowed: true };
  }
  return { ok: false, errorCode: 'provider_error', retryable: status >= 500, manualAllowed: false };
}

async function discoverLiveModels(
  protocol: Protocol,
  baseUrl: string,
  apiKey: string,
  deps: DiscoveryDeps,
): Promise<AuthorizationDiscoveryResult> {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, errorCode: 'invalid_request', retryable: false, manualAllowed: false };
  let endpoint: string;
  try { endpoint = appendModelsPath(baseUrl, protocol); }
  catch { return { ok: false, errorCode: 'invalid_request', retryable: false, manualAllowed: false }; }

  const headers: Record<string, string> = { accept: 'application/json' };
  if (protocol === 'openai') headers.authorization = `Bearer ${key}`;
  else if (protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else headers['x-goog-api-key'] = key;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl || fetch)(endpoint, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) {
      log.warn('model discovery provider response', { protocol, status: response.status });
      return discoveryFailure(response.status);
    }
    const payload = await response.json() as any;
    const raw = protocol === 'gemini'
      ? (Array.isArray(payload?.models) ? payload.models.map((row: any) => ({ id: row?.name, name: row?.displayName || row?.name })) : [])
      : (Array.isArray(payload?.data) ? payload.data.map((row: any) => ({ id: row?.id, name: row?.name || row?.display_name || row?.id })) : []);
    return { ok: true, source: 'live', models: normalizeModels(raw) };
  } catch (error) {
    log.warn('model discovery request failed', {
      protocol,
      error_kind: (error as Error)?.name === 'AbortError' ? 'timeout' : 'network',
    });
    return { ok: false, errorCode: 'network_error', retryable: true, manualAllowed: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverAuthorizationModels(
  userId: string,
  input: AuthorizationDiscoveryInput,
  deps: DiscoveryDeps = {},
): Promise<AuthorizationDiscoveryResult> {
  assertUser(userId);
  if (input.kind === 'builtin') {
    const providerId = String(input.providerId || '').trim();
    if (!providerId) return { ok: false, errorCode: 'invalid_request', retryable: false, manualAllowed: false };
    const result = await auth.listModels(providerId);
    return { ok: true, source: 'catalog', models: normalizeModels(result.models) };
  }
  if (input.kind === 'ccswitch_draft') {
    const draft = resolveCcSwitchAuthorizationDraft(userId, input.draftId);
    if (!draft.ok) return {
      ok: false,
      errorCode: (draft as { ok: false; errorCode: 'draft_not_found' | 'draft_expired' }).errorCode,
      retryable: false,
      manualAllowed: false,
    };
    return discoverLiveModels(draft.item.protocol, draft.item.baseUrl, draft.item.apiKey, deps);
  }
  return discoverLiveModels(input.protocol, input.baseUrl, input.apiKey, deps);
}
