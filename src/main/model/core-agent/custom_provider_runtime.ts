/**
 * Custom provider runtime — turn a stored `CustomProvider` (phase 1) into a
 * pi-ai `Model` object so the built-in chat path can route to it.
 *
 * Mirrors the hand-built-Model pattern in `external-providers.ts`
 * (buildMoonshotModel / buildDeepSeekModel / buildDoubaoModel), but generic:
 * the base URL, protocol dialect, and model id all come from the user's
 * stored record instead of a hard-coded table.
 *
 * ## Synthetic provider id
 *
 * A custom provider surfaces to the rest of the auth/runner machinery under
 * the synthetic provider id `cp:<customProviderId>`. This keeps it distinct
 * from every pi-ai catalog id and every EXTERNAL_API_PROVIDERS id, so the
 * `if (isCustomProviderId(...))` branches added to auth.ts / runner.ts never
 * collide with a real provider. The id round-trips through `entries[]`,
 * `ChatEntryChoice`, cooldown keys, and the model catalog untouched.
 *
 * ## Protocol → pi-ai api dialect
 *
 *   anthropic → 'anthropic-messages'
 *   openai    → 'openai-completions'
 *   gemini    → 'google-generative-ai'
 *
 * We use `openai-completions` (not `openai-responses`) for the OpenAI dialect
 * because third-party OpenAI-compatible relays (the common CC Switch case)
 * implement the classic `/chat/completions` surface, not OpenAI's newer
 * Responses API.
 */

import type { LLMProvider } from '#core-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { listCustomProviders } from '../../features/custom_providers';
import type { CustomProvider } from '../../features/auth';

type CA = typeof import('#core-agent');
let _caPromise: Promise<CA> | null = null;
function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  return _caPromise;
}

const CUSTOM_PROVIDER_PREFIX = 'cp:';

/** Default context window / max output tokens for a hand-built custom model.
 *  We can't know the real limits of an arbitrary third-party endpoint, so we
 *  pick conservative, widely-safe values. 131072 context is the same lower
 *  bound external-providers.ts uses for unknown ids; 8192 output avoids 400s
 *  on relays that cap low. Users can refine per-model later if needed. */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** True when a provider id addresses a custom provider (synthetic `cp:` id). */
export function isCustomProviderId(providerId: string): boolean {
  return typeof providerId === 'string' && providerId.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/** Build the synthetic provider id for a stored custom provider. */
export function customProviderId(id: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${id}`;
}

/** Extract the stored CustomProvider.id from a synthetic `cp:<id>` provider id. */
export function customProviderRawId(providerId: string): string {
  return isCustomProviderId(providerId)
    ? providerId.slice(CUSTOM_PROVIDER_PREFIX.length)
    : providerId;
}

/** Look up the stored record behind a synthetic `cp:<id>` provider id. */
export function findCustomProvider(userId: string, providerId: string): CustomProvider | undefined {
  if (!isCustomProviderId(providerId)) return undefined;
  const rawId = customProviderRawId(providerId);
  return listCustomProviders(userId).find((p) => p.id === rawId);
}

function apiForProtocol(protocol: CustomProvider['protocol']): Api {
  switch (protocol) {
    case 'openai':
      return 'openai-completions' as Api;
    case 'openai-responses':
      return 'openai-responses' as Api;
    case 'gemini':
      return 'google-generative-ai' as Api;
    case 'anthropic':
    default:
      return 'anthropic-messages' as Api;
  }
}

/**
 * Hand-build a pi-ai Model for one (custom provider, model id) pair.
 * `baseUrl` is baked into the Model so createPiProvider routes there
 * directly. Cost is left at 0 (local stat display only — the real bill
 * comes from the third-party endpoint).
 */
export function buildCustomProviderModel(cp: CustomProvider, modelId: string): Model<Api> {
  const api = apiForProtocol(cp.protocol);
  const metadata = buildCustomProviderModelMeta(cp, modelId);
  const model: Model<Api> = {
    id: modelId,
    name: modelId,
    api,
    // pi-ai's Provider type accepts arbitrary strings; the synthetic id keeps
    // us clear of catalog collisions.
    provider: customProviderId(cp.id) as any,
    baseUrl: cp.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
  };
  return model;
}

/** Metadata slice (window sizes) for the runner's model catalog. */
export function buildCustomProviderModelMeta(
  cp: CustomProvider,
  modelId: string,
): { contextWindow: number; maxTokens: number } {
  const id = String(modelId || '').trim();
  const model = cp.models.find((candidate) => candidate.id === id);
  return model
    ? { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
    : { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_OUTPUT_TOKENS };
}

/**
 * Build an LLMProvider wired to a custom provider's endpoint. Async because
 * core-agent is loaded on demand (ESM from CJS main). Does not touch the
 * network — the first request is deferred to the provider's stream/complete.
 */
export async function createCustomProvider(
  userId: string,
  providerId: string,
  apiKey: string,
  modelId: string,
): Promise<LLMProvider> {
  const cp = findCustomProvider(userId, providerId);
  if (!cp) throw new Error(`custom provider not found: ${providerId}`);
  if (!apiKey) throw new Error(`custom provider ${providerId}: apiKey required`);
  if (!modelId) throw new Error(`custom provider ${providerId}: modelId required`);
  const mod = await ca();
  const model = buildCustomProviderModel(cp, modelId);
  return mod.createPiProvider({
    provider: customProviderId(cp.id),
    apiKey,
    customModel: model,
  });
}

/** Default model id to offer when a custom provider has no explicit model
 *  list. Falls back to a protocol-appropriate placeholder the user can edit. */
export function defaultCustomProviderModel(cp: CustomProvider): string {
  if (cp.models.length) return cp.models[0].id;
  return '';
}
