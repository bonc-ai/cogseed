/** Explicit endpoint capabilities; omitted policy adds no custom cache hints. */
export interface PromptCachePolicy {
  key: boolean;
  affinity: boolean;
  /** A supported retention value, explicitly selected by the caller. */
  retention?: 'in-memory' | '24h';
}

export interface PromptCacheHints {
  payload: {
    prompt_cache_key?: string;
    prompt_cache_retention?: 'in-memory' | '24h';
  };
  headers: Record<string, string>;
}

/**
 * Translate confirmed capabilities without inferring support from a model,
 * endpoint or `long`. The caller supplies an already scoped, privacy-safe
 * session key and applies this result after SDK defaults (removing unsupported
 * SDK cache fields/affinity headers when an explicit policy is present).
 * `none` disables all optional hints; vendor authentication/routing headers
 * such as x-opencode-session are outside this policy.
 */
export function translatePromptCachePolicy(input: {
  policy?: PromptCachePolicy;
  api: string;
  cacheRetention?: 'none' | 'short' | 'long';
  sessionId?: string;
}): PromptCacheHints {
  const { policy, api, cacheRetention, sessionId } = input;
  const hints: PromptCacheHints = { payload: {}, headers: {} };
  if (!policy || cacheRetention === 'none' || !sessionId
    || (api !== 'openai-completions' && api !== 'openai-responses')) return hints;
  if (policy.key === true) {
    hints.payload.prompt_cache_key = sessionId;
    if (policy.retention === 'in-memory' || policy.retention === '24h') {
      hints.payload.prompt_cache_retention = policy.retention;
    }
  }
  if (policy.affinity === true) {
    hints.headers.session_id = sessionId;
    hints.headers['x-client-request-id'] = sessionId;
    hints.headers['x-session-affinity'] = sessionId;
  }
  return hints;
}
