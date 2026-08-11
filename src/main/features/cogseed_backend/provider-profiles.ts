import { pickApiKeyChatEntryForUser } from '../auth';

export interface MateProviderProfile {
  profileId: string;
  provider: 'openai-compatible';
  model: string;
  apiKey: string;
  baseUrl: string;
  maxOutputTokens?: number;
}

function assertOpenAICompatibleBaseUrl(value: string | undefined): string {
  const baseUrl = String(value || '').trim();
  if (!baseUrl) throw new Error('Mate API-key profile requires an OpenAI-compatible base URL');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Mate API-key profile requires an OpenAI-compatible base URL');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Mate API-key profile requires an OpenAI-compatible base URL');
  }
  return baseUrl.replace(/\/+$/, '');
}

export async function resolveMateApiKeyProfile(
  userId: string,
  profileId?: string,
): Promise<MateProviderProfile> {
  const choice = pickApiKeyChatEntryForUser(userId, profileId);
  if (!choice) throw new Error('Mate API-key profile not found');
  if (choice.provider !== 'openai-compatible') {
    throw new Error('Mate Native Provider requires an OpenAI-compatible API-key profile');
  }
  return {
    profileId: choice.profileId,
    provider: 'openai-compatible',
    model: choice.model,
    apiKey: choice.apiKey,
    baseUrl: assertOpenAICompatibleBaseUrl(choice.baseUrl),
    ...(choice.maxOutputTokens ? { maxOutputTokens: choice.maxOutputTokens } : {}),
  };
}
