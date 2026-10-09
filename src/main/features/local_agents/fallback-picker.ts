/**
 * Shared "pick the best local CLI for host-side fallback execution" helper.
 *
 * Used by no-model degradation paths — session-import extraction passes and
 * project-brief distillation — so they follow the SAME selection rules as the
 * renderer's chat fallback (conversation.js `_maybeApplyCliFallback`):
 *
 *   1. Prefer an explicit `prefer` type, but ONLY when it is signed in — a
 *      non-signed-in prefer must not shadow a CLI that is actually logged in.
 *   2. Otherwise prefer a SIGNED-IN CLI (official account / API-key config).
 *   3. Otherwise honor the `prefer` (even unsigned), then the first available
 *      CLI — the credential check is file-based and can miss keychain-stored
 *      sessions, so an available CLI is still a valid fallback backend (it
 *      will surface its own login error if not logged in).
 *
 * CLIs whose configured endpoint is a LOCAL proxy that is confirmed DOWN
 * (CC Switch etc. not running) are skipped: dispatching to them is a
 * guaranteed failure. `null` probe results (no proxy / remote endpoint /
 * unreadable) pass through so we never block a CLI off an unknown state.
 *
 * This helper never mutates state and is safe to call repeatedly (each call
 * re-runs `detectAll()` with its 60s cache and probes only local endpoints).
 */

import { createLogger } from '../../logger.js';
import { detectAll, type LocalCliEntry, type LocalCliType } from './registry.js';
import { readCliModelEndpoint, probeModelEndpointReachable } from './active_config.js';

const log = createLogger('local-agents:fallback-picker');

export interface PickCliFallbackOptions {
  /** CLI types to skip (e.g. one that just failed at runtime). */
  exclude?: Set<string> | null;
  /** Preferred CLI type; honored only when it passes the usable filter. */
  prefer?: string | null;
}

export async function pickBestCliForFallback(
  options: PickCliFallbackOptions = {},
): Promise<LocalCliEntry | null> {
  const exclude = options.exclude || new Set<string>();
  const entries = await detectAll();
  const available = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && e.available && e.path,
  );
  if (!available.length) return null;

  // Local-proxy reachability (CC Switch etc.): only skip on a definitive
  // `false` probe result; `null` (no proxy / unreadable) is treated as usable
  // so we never block a CLI off an unknown endpoint. Mirrors the renderer's
  // chat fallback. Best-effort — a failed probe never rejects the pick.
  const unreachable = new Set<string>();
  for (const e of available) {
    try {
      const ep = readCliModelEndpoint(e.type as LocalCliType);
      if (ep && ep.isLocalProxy) {
        const reachable = await probeModelEndpointReachable(e.type as LocalCliType);
        if (reachable === false) unreachable.add(e.type);
      }
    } catch (err) {
      log.warn('fallback proxy probe failed', { cli: e.type, error: String(err) });
    }
  }

  const usable = (e: LocalCliEntry) => !exclude.has(e.type) && !unreachable.has(e.type);
  const candidates = available.filter(usable);
  if (!candidates.length) return null;

  // Prefer a SIGNED-IN CLI. An explicit `prefer` is honored only when that CLI
  // is signed in — a non-signed-in prefer (e.g. a stale "claude" preference)
  // must not shadow a different CLI that is actually logged in. When NOTHING
  // is signed in, the prefer (then the first available) is still used, because
  // the file-based credential check can miss keychain-stored sessions and an
  // available CLI is still a valid fallback backend (it surfaces its own
  // login error if not logged in).
  const signedIn = candidates.find((e) => e.auth && e.auth.loggedIn);

  if (options.prefer) {
    const preferred = candidates.find((e) => e.type === options.prefer);
    if (preferred && preferred.auth && preferred.auth.loggedIn) return preferred;
  }

  if (signedIn) return signedIn;

  if (options.prefer) {
    const preferred = candidates.find((e) => e.type === options.prefer);
    if (preferred) return preferred;
  }

  return candidates[0] || null;
}
