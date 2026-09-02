/**
 * Shared types for the CogSeed Hub account feature.
 *
 * Shapes mirror the Hub account service API contract (v1.3):
 *   - response envelope: `{ ok: true, data: ... }` / `{ ok: false, error: { code, message } }`
 *   - `access_token` (opaque, ~1h) + `refresh_token` (opaque, ~30d, rotated on refresh);
 *     both are random opaque strings — no JWT
 *   - `local_identity_id` is the desktop's local uid (`users.ts::getActiveUserId`)
 */
export type HubAccountStatus = 'active' | 'suspended' | 'pending_deletion' | 'processing' | 'deleted';

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
    /** CogSeed ID（cs_xxx）：用户识别与内部支持标识；手机号注册账号同样有。 */
    login_id?: string | null;
    /** 掩码手机号（设置页展示用，服务端不下发完整号码；未绑定为 null）。 */
    phone?: { masked: string; country_code: string; verified_at: string } | null;
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

// ── 账号注销（P3394 注销与数据处理 PRD doc-v0.1；后端契约 v1.6）──

/** 注销前影响矩阵条目（服务端权威下发，客户端不硬编码）。 */
export interface HubDeletionImpactItem {
  key: string;
  title: string;
  description: string;
  immediate: string;
  final: string;
}

export interface HubDeletionImpact {
  reversal_days: number;
  items: HubDeletionImpactItem[];
}

/** 注销重新认证验证码发送结果。 */
export interface HubDeletionSendCodeResult {
  phone_masked: string;
  expires_in: number;
  resend_after: number;
  purpose: string;
}

/** 注销申请请求体（重新认证 + 二次确认）。 */
export interface HubDeleteAccountRequest {
  confirmation: 'DELETE_MY_ACCOUNT';
  reauth_method: 'sms_code' | 'password';
  code?: string;
  password?: string;
}

/** 注销一次性退出回执。 */
export interface HubDeletionResult {
  account_id: string;
  status: string;
  requested_at: string;
  reversal_deadline_at: string;
  revoked_sessions: number;
  revoked_devices: number;
  revoked_consents: number;
  message: string;
}
