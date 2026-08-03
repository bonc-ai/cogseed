/**
 * CLI provider env resolver (phase 3, method 2A).
 *
 * Maps a stored custom provider (the `cp:<id>` synthetic providers from
 * phase 1/2) to the environment variables the external CLI agents read to
 * pick their upstream endpoint + credential. This is what "打通 external CLI"
 * means concretely: instead of the CLI silently reading its own on-disk config
 * (e.g. CC Switch's ~/.claude), Orkas injects the selected provider's endpoint
 * and key at spawn time.
 *
 * Precedence: the resolved vars are applied by `spawnCli` AFTER the inherited
 * process env, so they deterministically override the CLI's own config. This
 * is the "Orkas selection wins over CC Switch" behaviour the user approved.
 *
 * Per-CLI env conventions:
 *   - claude (Claude Code): ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 *     (Claude Code reads ANTHROPIC_AUTH_TOKEN as the bearer for custom relays;
 *      ANTHROPIC_BASE_URL redirects the API host.)
 *   - codex (OpenAI Codex): OPENAI_BASE_URL + OPENAI_API_KEY
 *
 * Only anthropic-protocol providers are meaningful for claude, and only
 * openai-protocol providers for codex; a mismatch returns undefined so we
 * never point a CLI at an incompatible endpoint.
 */

import type { LocalCliType } from './registry';
import { listCustomProviders } from '../custom_providers';

/** Resolve the env overlay for a CLI agent bound to a custom provider.
 *  `providerId` is the synthetic `cp:<id>` id. Returns undefined when the
 *  provider is unknown, has no key, or its protocol doesn't match the CLI. */
export function resolveCliProviderEnv(
  userId: string,
  cli: LocalCliType,
  providerId: string | undefined,
): Record<string, string> | undefined {
  if (!providerId || !providerId.startsWith('cp:')) return undefined;
  const rawId = providerId.slice(3);
  const cp = listCustomProviders(userId).find((p) => p.id === rawId);
  if (!cp || !cp.baseUrl || !cp.apiKey) return undefined;

  if (cli === 'claude') {
    // Claude Code speaks the Anthropic dialect; only anthropic-protocol
    // custom providers can back it.
    if (cp.protocol !== 'anthropic') return undefined;
    return {
      ANTHROPIC_BASE_URL: cp.baseUrl,
      ANTHROPIC_AUTH_TOKEN: cp.apiKey,
    };
  }

  if (cli === 'codex') {
    // Codex speaks the OpenAI dialect.
    if (cp.protocol !== 'openai') return undefined;
    return {
      OPENAI_BASE_URL: cp.baseUrl,
      OPENAI_API_KEY: cp.apiKey,
    };
  }

  // Other CLI types (openclaw / opencode / hermes / gemini) are not wired for
  // provider-env injection in this phase.
  return undefined;
}
