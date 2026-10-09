/**
 * Encrypted persistence for Hub authentication sessions.
 *
 * Session credentials (`access_token` / `refresh_token`) are secrets — they
 * live in `util/local-secret-store.ts` (crypto-vault in the open-source
 * build) bound to the local uid, mirroring the connectors per-instance
 * pattern (`connectors/registry.ts::_secretContext`). Only the opaque
 * ciphertext touches disk; the non-sensitive metadata (account id, device
 * id, binding state) lives in `state.ts` as plaintext JSON.
 *
 * One session per local identity — a later login replaces the previous one.
 */
import * as localSecrets from '../../util/local-secret-store';
import { readHubAccountState, writeHubAccountState } from './state';
import type { HubSession } from './types';

const HUB_SECRET_NAMESPACE = 'hub-account';
const HUB_SESSION_RECORD = 'session';

function _secretContext(uid: string): localSecrets.LocalSecretContext {
  return { namespace: HUB_SECRET_NAMESPACE, ownerId: uid, recordId: HUB_SESSION_RECORD };
}

export function saveHubSession(uid: string, session: HubSession): void {
  const ciphertext = localSecrets.encryptLocalSecret(_secretContext(uid), JSON.stringify(session));
  writeSessionCiphertext(uid, ciphertext);
}

export function loadHubSession(uid: string): HubSession | null {
  // The ciphertext lives inside the state file, not in a sidecar — read it
  // from the persisted state so decrypt stays a single source of truth.
  const state = readSessionCiphertext(uid);
  if (!state) return null;
  try {
    const decrypted = localSecrets.decryptLocalSecret(_secretContext(uid), state);
    const parsed = JSON.parse(decrypted) as Partial<HubSession>;
    if (
      typeof parsed.session_id !== 'string' ||
      typeof parsed.access_token !== 'string' ||
      typeof parsed.refresh_token !== 'string' ||
      typeof parsed.access_expires_at !== 'string' ||
      typeof parsed.refresh_expires_at !== 'string'
    ) {
      return null;
    }
    return parsed as HubSession;
  } catch {
    return null;
  }
}

export function clearHubSession(uid: string): void {
  writeSessionCiphertext(uid, null);
}

// ── ciphertext storage (piggy-backs on the state file's JSON) ─────────────

function readSessionCiphertext(uid: string): string | null {
  return readHubAccountState(uid).session_enc ?? null;
}

function writeSessionCiphertext(uid: string, ciphertext: string | null): void {
  writeHubAccountState(uid, { session_enc: ciphertext ?? undefined });
}
