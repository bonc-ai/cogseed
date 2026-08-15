import {
  pickRuntimeChatEntryForUser,
  type RuntimeChatProtocol,
} from '../auth';

export interface MateProviderProfile {
  profileId: string;
  provider: string;
  /** Wire protocol the runtime provider will speak to reach this profile. */
  protocol: RuntimeChatProtocol;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokens?: number;
}

/** Default endpoints for curated providers whose api_key profiles store no
 *  baseUrl. Endpoint values mirror external-providers.ts / pi-ai models. */
const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  'openai-compatible': '',
  anthropic: 'https://api.anthropic.com',
  'kimi-coding': 'https://api.kimi.com/coding',
  google: 'https://generativelanguage.googleapis.com',
  moonshot: 'https://api.moonshot.cn/v1',
  deepseek: 'https://api.deepseek.com/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
};

function assertHttpBaseUrl(value: string | undefined, provider: string): string {
  const baseUrl = String(value || '').trim();
  if (!baseUrl) throw new Error(`CogSeed profile for ${provider} requires a base URL`);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`CogSeed profile for ${provider} requires a valid base URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`CogSeed profile for ${provider} requires a valid base URL`);
  }
  return baseUrl.replace(/\/+$/, '');
}

/** Default output-token cap for Anthropic Messages requests (max_tokens is a
 *  required field). Conservative: the runtime cannot read the curated per-model
 *  table, and over-capping a relay 400s. */
const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 8192;
/** Gemini caps are optional; a sane default keeps long generations bounded. */
const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Resolve the runtime model profile for an explicit user: walks the priority
 * list and picks the first entry the CogSeed runtime can actually call
 * (openai-completions / anthropic / gemini wire protocols, any auth type),
 * then pins the concrete endpoint and protocol-dependent defaults.
 */
export async function resolveMateModelProfile(
  userId: string,
  profileId?: string,
): Promise<MateProviderProfile> {
  const choice = await pickRuntimeChatEntryForUser(userId, profileId);
  if (!choice?.protocol) throw new Error('CogSeed model profile not found');
  const baseUrl = assertHttpBaseUrl(
    choice.baseUrl || DEFAULT_BASE_URLS[choice.provider],
    choice.provider,
  );
  let maxOutputTokens: number | undefined = choice.maxOutputTokens;
  if (choice.protocol === 'anthropic' && !maxOutputTokens) {
    maxOutputTokens = ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS;
  } else if (choice.protocol === 'gemini' && !maxOutputTokens) {
    maxOutputTokens = GEMINI_DEFAULT_MAX_OUTPUT_TOKENS;
  }
  return {
    profileId: choice.profileId,
    provider: choice.provider,
    protocol: choice.protocol,
    model: choice.model,
    apiKey: choice.apiKey,
    baseUrl,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}

// Retained name for back-compat with existing callers/tests; resolves the
// full runtime profile (any supported wire protocol), not only OpenAI.
export async function resolveMateApiKeyProfile(
  userId: string,
  profileId?: string,
): Promise<MateProviderProfile> {
  return resolveMateModelProfile(userId, profileId);
}

