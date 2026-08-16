/**
 * IPC handlers for the Hub account feature. Renderer reaches these via
 * `window.cogseed.invoke('hub-account.*', payload)`.
 *
 *   hub-account.status         → { status }              (renderer-safe snapshot, no tokens)
 *   hub-account.start_login    → { started, authorize_url }
 *   hub-account.logout         → { signed_out }
 *   hub-account.me             → { me }
 *   hub-account.devices        → { devices }
 *   hub-account.revoke_device  → { revoked_sessions }
 *   hub-account.consents       → { consents }
 *   hub-account.set_consent    → { consent }
 *   hub-account.revoke_consent → { consent }
 *   hub-account.delete_account → { deletion }
 *
 * Errors surface as `HubApiError` with the Hub service error `code`
 * (e.g. `AUTH_REQUIRED`, `BINDING_ALREADY_EXISTS`); the IPC envelope
 * forwards `code` + message to the renderer.
 */
import * as hubAccount from '../features/hub_account';
import { HubApiError } from '../features/hub_account';
import { assertHubAccountReleaseEnabled } from '../features/hub_account/gate';
import { broadcastHubStateChanged } from '../features/hub_account/account-events';

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${name}`);
  return value.trim();
}

function requireReleaseGate(): void {
  assertHubAccountReleaseEnabled();
}

export const invokeHandlers = {
  'hub-account.status': async (_payload: unknown, ctx: { userId: string }) => ({
    status: await hubAccount.getHubStatus(ctx.userId),
  }),

  'hub-account.start_login': async (_payload: unknown, ctx: { userId: string }) => {
    requireReleaseGate();
    const { authorize_url } = await hubAccount.startLogin(ctx.userId);
    await hubAccount.openAuthorizeUrl(authorize_url);
    return { started: true };
  },

  'hub-account.logout': async (_payload: unknown, ctx: { userId: string }) => {
    requireReleaseGate();
    await hubAccount.logout(ctx.userId);
    // 状态已落盘；广播让所有 renderer 表面（左下角账号区 / 设置-账号页）
    // 立即刷新，避免两处显示不一致。
    broadcastHubStateChanged({ reason: 'signed_out' });
    return { signed_out: true };
  },

  'hub-account.me': async (_payload: unknown, ctx: { userId: string }) => {
    requireReleaseGate();
    return { me: await hubAccount.getAccountMe(ctx.userId) };
  },

  'hub-account.devices': async (_payload: unknown, ctx: { userId: string }) => {
    requireReleaseGate();
    return { devices: await hubAccount.listDevices(ctx.userId) };
  },

  'hub-account.revoke_device': async (payload: { device_id?: unknown }, ctx: { userId: string }) => {
    requireReleaseGate();
    const deviceId = assertString(payload?.device_id, 'device_id');
    const result = await hubAccount.revokeDevice(ctx.userId, deviceId);
    return { revoked_sessions: result.revoked_sessions };
  },

  'hub-account.consents': async (_payload: unknown, ctx: { userId: string }) => {
    requireReleaseGate();
    return { consents: await hubAccount.listConsents(ctx.userId) };
  },

  'hub-account.set_consent': async (payload: { scope?: unknown }, ctx: { userId: string }) => {
    requireReleaseGate();
    const scope = assertString(payload?.scope, 'scope');
    return { consent: await hubAccount.setConsent(ctx.userId, scope) };
  },

  'hub-account.revoke_consent': async (payload: { scope?: unknown }, ctx: { userId: string }) => {
    requireReleaseGate();
    const scope = assertString(payload?.scope, 'scope');
    return { consent: await hubAccount.revokeConsent(ctx.userId, scope) };
  },

  'hub-account.delete_account': async (payload: { confirmation?: unknown }, ctx: { userId: string }) => {
    requireReleaseGate();
    const confirmation = assertString(payload?.confirmation, 'confirmation');
    const result = await hubAccount.deleteHubAccount(ctx.userId, confirmation);
    broadcastHubStateChanged({ reason: 'account_deleted' });
    return { deletion: result };
  },
};

export { HubApiError };
