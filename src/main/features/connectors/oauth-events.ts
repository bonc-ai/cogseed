/** Renderer notification for OAuth work that finishes after `connectors.start_oauth` returned. */
export interface OAuthConnectOutcome {
  attempt_id: string;
  catalog_id: string;
  result: 'success' | 'failure' | 'cancelled';
  duration_ms: number;
  code?: string;
  error?: string;
}

export function broadcastOAuthConnectOutcome(outcome: OAuthConnectOutcome): void {
  try {
    // Lazy import avoids a feature → IPC initialization cycle. This runs only after the IPC
    // handler has accepted the start request and the current protocol callback finishes.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('connectors:oauth-result', outcome);
  } catch {
    // Tests and open-source builds may not have the hosted IPC bridge loaded. Registry writes still
    // broadcast `connectors:changed`, so connector state remains correct even without this UX event.
  }
}

/** How to authorize a `local_cli` connect attempt.
 *
 *  Unlike the OAuth modes, this flow is driven on the PC rather than by the Server or a deep link,
 *  so the renderer needs the details to be able to show them when opening a browser fails. Purely
 *  additive: neither field is a credential (a URL is a one-time authorization request the user is
 *  expected to visit; a QR image is the same request rendered for scanning), and the connect
 *  outcome still arrives on `connectors:oauth-result` as usual. */
export interface AuthorizationUrlNotice {
  catalog_id: string;
  /** Empty when the provider authorizes by QR scan and the CLI prints no URL. */
  url: string;
  /** Local PNG holding the scannable QR, for providers that have no URL to open (WeCom). The main
   *  process opens it with the OS viewer; carrying the path lets the renderer show it inline later
   *  without another IPC channel. */
  qrcode_path?: string;
}

export function broadcastAuthorizationUrl(notice: AuthorizationUrlNotice): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const ipc = require('../../ipc') as { broadcastToRenderer?: (channel: string, payload: unknown) => void };
    ipc.broadcastToRenderer?.('connectors:authorization-url', notice);
  } catch {
    // See above: absence of the bridge must not break the connect attempt itself.
  }
}
