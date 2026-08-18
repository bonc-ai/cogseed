/**
 * Renderer notification for Hub login that finishes after the deep link
 * returns — i.e. work the renderer never awaits.
 *
 * `hub-account.start_login` resolves as soon as the browser opens; the actual
 * login completes later, when the OS delivers `cogseed://account/callback` to
 * the main process. Without this broadcast the renderer has no way to learn
 * that the session was written, and the account pane keeps showing the
 * signed-out state until the user happens to re-focus the window while the
 * pane is visible.
 */
export interface HubLoginOutcome {
  result: 'success' | 'failure';
  account_id?: string;
  is_new_account?: boolean;
  code?: string;
  error?: string;
}

export function broadcastHubLoginOutcome(outcome: HubLoginOutcome): void {
  try {
    // Lazy import avoids a feature → IPC initialization cycle; mirrors
    // features/connectors/oauth-events.ts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('hub-account:login-result', outcome);
  } catch {
    // Tests and builds without the hosted IPC bridge: the session is already
    // persisted, so state stays correct — only the live UI refresh is lost.
  }
}

/**
 * Renderer notification for Hub account state changes initiated from any
 * surface (sign-out / account deletion). Without this broadcast the sidebar
 * account chip and the Settings › 账号 pane can drift apart: e.g. signing out
 * from the chip never tells the settings pane to refresh, and vice versa.
 * `hub-account:` is already in the preload push-channel allow-list, so no
 * preload change is needed.
 */
export interface HubStateChange {
  reason: 'signed_out' | 'account_deleted';
}

export function broadcastHubStateChanged(change: HubStateChange): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('hub-account:state-changed', change);
  } catch {
    // Same as above: state is already persisted; only the live UI refresh is lost.
  }
}
