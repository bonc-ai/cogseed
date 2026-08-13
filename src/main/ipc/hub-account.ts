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

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid ${name}`);
  return value.trim();
}

export const invokeHandlers = {
  'hub-account.status': async (_payload: unknown, ctx: { userId: string }) => ({
    status: await hubAccount.getHubStatus(ctx.userId),
  }),

  'hub-account.start_login': async (_payload: unknown, ctx: { userId: string }) => {
    const { authorize_url } = await hubAccount.startLogin(ctx.userId);
    await hubAccount.openAuthorizeUrl(authorize_url);
    return { started: true };
  },

  'hub-account.logout': async (_payload: unknown, ctx: { userId: string }) => {
    await hubAccount.logout(ctx.userId);
    return { signed_out: true };
  },

  'hub-account.me': async (_payload: unknown, ctx: { userId: string }) => ({
    me: await hubAccount.getAccountMe(ctx.userId),
  }),

  'hub-account.devices': async (_payload: unknown, ctx: { userId: string }) => ({
    devices: await hubAccount.listDevices(ctx.userId),
  }),

  'hub-account.revoke_device': async (payload: { device_id?: unknown }, ctx: { userId: string }) => {
    const deviceId = assertString(payload?.device_id, 'device_id');
    const result = await hubAccount.revokeDevice(ctx.userId, deviceId);
    return { revoked_sessions: result.revoked_sessions };
  },

  'hub-account.consents': async (_payload: unknown, ctx: { userId: string }) => ({
    consents: await hubAccount.listConsents(ctx.userId),
  }),

  'hub-account.set_consent': async (payload: { scope?: unknown }, ctx: { userId: string }) => {
    const scope = assertString(payload?.scope, 'scope');
    return { consent: await hubAccount.setConsent(ctx.userId, scope) };
  },

  'hub-account.revoke_consent': async (payload: { scope?: unknown }, ctx: { userId: string }) => {
    const scope = assertString(payload?.scope, 'scope');
    return { consent: await hubAccount.revokeConsent(ctx.userId, scope) };
  },

  'hub-account.delete_account': async (payload: { confirmation?: unknown }, ctx: { userId: string }) => {
    const confirmation = assertString(payload?.confirmation, 'confirmation');
    return { deletion: await hubAccount.deleteHubAccount(ctx.userId, confirmation) };
  },
};

export { HubApiError };
