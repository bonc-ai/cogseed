/** Tencent Survey public device authorization protocol, audited from official Skill 1.3.0.
 * No external script, provider application secret, callback listener, or account-login module.
 * Codes/nonces live only in this attempt; tokens leave only through the encrypted registry owner.
 * Provider init returns code+nonce, poll returns pending/completed+token. No refresh/revoke API
 * or token expiry/team-label contract is published by that package; never invent those values.
 */
import { shell } from 'electron';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchAndReadWithTimeout } from '../../util/abort';
import { broadcastAuthorizationUrl } from './oauth-events';
import { TENCENT_SURVEY_ID } from './catalog-tencent-survey';
import type { OAuthGrant } from './types';

const ROOT = 'https://wj.qq.com';
const pending = new Map<string, AbortController>();

// The provider contract guarantees a wjpt_ prefix, not a fixed token length.
// Validate header-safe Bearer syntax here; MCP initialize validates the actual credential.
export function isTencentSurveyToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 8192
    && /^wjpt_[A-Za-z0-9._~+\/-]+=*$/.test(value);
}
export function surveyError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
export function cancelTencentSurveyAuth(userId: string): boolean {
  const active = pending.get(userId);
  if (!active) return false;
  active.abort(surveyError('user_cancelled'));
  return true;
}
export function cancelAllTencentSurveyAuth(): void {
  for (const active of pending.values()) active.abort(surveyError('user_cancelled'));
}

async function request(path: string, method: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const { response, body } = await fetchAndReadWithTimeout(ROOT + path,
      { method, redirect: 'error', headers: { Accept: 'application/json' } },
      15_000, signal, 'survey_network_error', async r => await r.json());
    if (!response.ok || !body || String(body.code).toUpperCase() !== 'OK'
      || !body.data || typeof body.data !== 'object') throw surveyError('survey_protocol_error');
    return body.data;
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    // Never propagate provider bodies/URLs: these can echo the device code or token.
    if ((err as { code?: string })?.code === 'survey_protocol_error') throw err;
    throw surveyError('survey_network_error');
  }
}

/** Retain cancellation ownership until verification AND persistence finish. */
export async function authorizeTencentSurvey<T>(userId: string,
  install: (grant: OAuthGrant, signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!userId) throw new Error('uid required');
  pending.get(userId)?.abort(surveyError('superseded'));
  const controller = new AbortController();
  pending.set(userId, controller);
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(surveyError('flow_timeout')), 300_000);
  timer.unref?.();
  try {
    const init = await request('/api/v2/account/tokens/device-auth/init', 'POST', signal);
    if (typeof init.code !== 'string' || !/^[0-9a-f]{16,64}$/.test(init.code)
      || typeof init.nonce !== 'string' || !init.nonce || init.nonce.length > 128) throw surveyError('survey_protocol_error');
    signal.throwIfAborted();
    const url = new URL('/oauth/authorize', ROOT);
    url.searchParams.set('code', init.code);
    url.searchParams.set('nonce', init.nonce);
    broadcastAuthorizationUrl({ catalog_id: TENCENT_SURVEY_ID, url: url.href });
    // The card also offers a copyable URL if browser launch fails. Do not log the URL/error.
    void shell.openExternal(url.href).catch(() => {});
    for (;;) {
      await delay(2000, undefined, { signal });
      const data = await request('/api/v2/account/tokens/device-auth/poll?code=' + encodeURIComponent(init.code), 'GET', signal);
      signal.throwIfAborted();
      if (data.status === 'pending') continue;
      if (data.status === 'cancelled' || data.status === 'denied') throw surveyError('user_cancelled');
      if (data.status === 'expired') throw surveyError('flow_timeout');
      if (data.status !== 'completed' || !isTencentSurveyToken(data.token)) throw surveyError('survey_protocol_error');
      return await install({ access_token: data.token, refresh_token: null, expires_at: null,
        scopes: [], token_type: 'Bearer' }, signal);
    }
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    if (pending.get(userId) === controller) pending.delete(userId);
  }
}
