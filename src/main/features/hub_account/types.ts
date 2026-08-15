/**
 * Shared types for the CogSeed Hub account feature.
 *
 * Shapes mirror the Hub account service API contract (v1.3):
 *   - response envelope: `{ ok: true, data: ... }` / `{ ok: false, error: { code, message } }`
 *   - `access_token` (opaque, ~1h) + `refresh_token` (opaque, ~30d, rotated on refresh);
 *     both are random opaque strings — no JWT
 *   - `local_identity_id` is the desktop's local uid (`users.ts::getActiveUserId`)
 */
export type HubAccountStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';

export interface HubAccountInfo {
  account_id: string;
  auth_provider: string;
  status: HubAccountStatus;
  created_at: string;
}

export interface HubSession {
  session_id: string;
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
}

export interface HubCallbackResult {
  is_new_account: boolean;
  account: HubAccountInfo;
  session: HubSession;
}

export interface HubCallbackDeviceInfo {
  installation_id: string;
  device_name: string;
  device_os: string;
}

export interface HubRefreshResult {
  access_token: string;
  refresh_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
}

export interface HubDeviceMetadata {
  installation_id: string;
  device_name: string;
  device_os: string;
}

export interface HubDevice {
  device_id: string;
  device_name: string;
  device_os: string;
  is_current: boolean;
  first_seen_at: string;
  last_seen_at: string;
  active_sessions: number;
  status: string;
}

export interface HubConsent {
  consent_id: string;
  scope: string;
  granted: boolean;
  granted_at: string | null;
  revoked_at: string | null;
  consent_version: string;
}

export interface HubAccountMe {
  account: HubAccountInfo & {
    bound_local_identity: string | null;
    community_profile: { display_name: string | null; is_contributor: boolean };
  };
  stats: { active_device_count: number; consent_count: number };
}

export interface HubBindResult {
  binding_id: string;
  account_id: string;
  local_identity_id: string;
  device: { device_id: string; device_name: string; is_current: boolean };
  status: string;
  bound_at: string;
}

/** Error payload from the Hub service (`error.code` / `error.message`). */
export interface HubErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
