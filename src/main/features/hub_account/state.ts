/**
 * Machine-private Hub account state for a local identity.
 *
 * File: `<uid>/local/config/hub-account.json` (deliberately under
 * `local/`, never synced). Holds only non-sensitive metadata — account id,
 * bound device id, binding state — plus the encrypted session blob
 * (`session_enc`) written by `tokens.ts`. Tokens never appear in plaintext
 * here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalConfigDir } from '../../paths';
import { createLogger } from '../../logger';

const log = createLogger('hub_account:state');
const STATE_FILE_NAME = 'hub-account.json';

export interface HubAccountState {
  /** Hub account id once signed in (`cogseed_acc_*`). */
  account_id?: string;
  auth_provider?: string;
  /** Device id assigned by the Hub service on bind; identifies this machine in device lists. */
  device_id?: string;
  /** Stable per-installation id used to reuse the same Hub device row. */
  installation_id?: string;
  device_name?: string;
  /** Local identity is bound to the Hub account. */
  bound: boolean;
  bound_at?: string;
  /** Last known account lifecycle status (active / suspended / pending_deletion / processing / deleted). */
  account_status?: 'active' | 'suspended' | 'pending_deletion' | 'processing' | 'deleted';
  /** Encrypted HubSession blob (see tokens.ts). */
  session_enc?: string;
  /** Pending OAuth state for an in-flight login (survives app restart). */
  pending_login?: { state: string; started_at: string };
}

const EMPTY: HubAccountState = { bound: false };

function stateFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), STATE_FILE_NAME);
}

export function readHubAccountState(uid: string): HubAccountState {
  try {
    const file = stateFile(uid);
    if (!fs.existsSync(file)) return { ...EMPTY };
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HubAccountState>;
    return {
      bound: typeof raw.bound === 'boolean' ? raw.bound : false,
      ...(typeof raw.account_id === 'string' ? { account_id: raw.account_id } : {}),
      ...(typeof raw.auth_provider === 'string' ? { auth_provider: raw.auth_provider } : {}),
      ...(typeof raw.device_id === 'string' ? { device_id: raw.device_id } : {}),
      ...(typeof raw.installation_id === 'string' ? { installation_id: raw.installation_id } : {}),
      ...(typeof raw.device_name === 'string' ? { device_name: raw.device_name } : {}),
      ...(typeof raw.bound_at === 'string' ? { bound_at: raw.bound_at } : {}),
      ...(typeof raw.account_status === 'string' ? { account_status: raw.account_status as HubAccountState['account_status'] } : {}),
      ...(typeof raw.session_enc === 'string' ? { session_enc: raw.session_enc } : {}),
      ...(raw.pending_login && typeof raw.pending_login.state === 'string' ? { pending_login: raw.pending_login } : {}),
    };
  } catch (err) {
    log.warn('failed to read hub account state', { uid: mask(uid), error: (err as Error).message });
    return { ...EMPTY };
  }
}

function mask(uid: string): string {
  return uid.length <= 4 ? '****' : `${uid.slice(0, 2)}****${uid.slice(-2)}`;
}

export function writeHubAccountState(uid: string, patch: Partial<HubAccountState>): HubAccountState {
  const next: HubAccountState = { ...readHubAccountState(uid), ...patch };
  try {
    const file = stateFile(uid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (err) {
    log.error('failed to write hub account state', { uid: mask(uid), error: (err as Error).message });
  }
  return next;
}

export function clearHubAccountState(uid: string): void {
  try {
    fs.rmSync(stateFile(uid), { force: true });
  } catch (err) {
    log.warn('failed to remove hub account state', { uid: mask(uid), error: (err as Error).message });
  }
}

export const _test = { stateFile };
