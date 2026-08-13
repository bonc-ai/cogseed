/**
 * Connector-only deep-link delivery for the public desktop build.
 *
 * Account login is intentionally absent. The only accepted URLs are:
 *   - orkas://connectors/oauth/callback
 *   - orkas://connectors/oauth/dcr-callback
 *
 * OAuth redirects always land on the public HTTPS Server first. Its landing page then opens one
 * of the URLs above so the exact app instance that started the flow can finish the exchange. This
 * module owns that final OS-protocol hop without restoring any account/session behavior.
 */
import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { CONNECTOR_PROTOCOL_SCHEMES, normalizeDeepLink } from '../../brand';
import { createLogger } from '../../logger';
import { safeUrlAction } from '../../util/log-redact';
import { handleCallbackUrl, handleDcrCallbackUrl } from './index';

const log = createLogger('connectors:protocol');
const SERVER_CALLBACK_PATH = '/oauth/callback';
const DCR_CALLBACK_PATH = '/oauth/dcr-callback';

let _pending: string | null = null;

function _connectorCallbackKind(rawUrl: string): 'server' | 'dcr' | null {
  const normalized = normalizeDeepLink(rawUrl);
  if (!normalized) return null;
  const parsed = normalized.url;
  if (parsed.host.toLowerCase() !== 'connectors') return null;
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (pathname === SERVER_CALLBACK_PATH) return 'server';
  if (pathname === DCR_CALLBACK_PATH) return 'dcr';
  return null;
}

function _extractConnectorCallback(argv: readonly string[] | undefined): string | null {
  for (const value of argv || []) {
    if (typeof value === 'string' && _connectorCallbackKind(value)) return value;
  }
  return null;
}

function _focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function _dispatch(rawUrl: string): Promise<void> {
  const normalized = normalizeDeepLink(rawUrl);
  const kind = normalized ? _connectorCallbackKind(normalized.href) : null;
  if (!kind) {
    log.warn('ignored non-connector deep link', { action: safeUrlAction(rawUrl) });
    return;
  }
  if (!app.isReady()) {
    _pending = rawUrl;
    return;
  }
  log.info('connector deep link received', { action: safeUrlAction(rawUrl), kind });
  _focusMainWindow();
  try {
    if (kind === 'dcr') await handleDcrCallbackUrl(normalized?.href || rawUrl);
    else await handleCallbackUrl(normalized?.href || rawUrl);
  } catch (err) {
    log.warn('connector deep link handling failed', { error: (err as Error).message, kind });
  }
}

/** Register callback handling only in the runtime that owns the OS schemes. */
export function registerConnectorProtocol(options: Readonly<{ owner: boolean }>): boolean {
  if (options.owner) {
    for (const scheme of CONNECTOR_PROTOCOL_SCHEMES) {
      try {
        if (!app.isPackaged && process.argv.length >= 2) {
          app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
        } else {
          app.setAsDefaultProtocolClient(scheme);
        }
      } catch (err) {
        log.warn('connector protocol registration failed', { scheme, error: (err as Error).message });
      }

      let isDefaultHandler = false;
      try { isDefaultHandler = app.isDefaultProtocolClient(scheme); }
      catch { /* diagnostics only */ }
      log.info('connector protocol registration', { scheme, isDefaultHandler });
    }

    app.on('open-url', (event, rawUrl) => {
      const normalized = normalizeDeepLink(rawUrl);
      if (!normalized || !_connectorCallbackKind(normalized.href)) return;
      event.preventDefault();
      void _dispatch(rawUrl);
    });

    const cold = _extractConnectorCallback(process.argv);
    if (cold) _pending = cold;
  } else {
    log.info('connector protocol registration disabled for this runtime');
  }

  // Window activation belongs to the single-instance contract, not protocol
  // ownership. Every runtime focuses its own existing window on a duplicate
  // launch; only the owner may consume an OAuth callback from argv.
  app.on('second-instance', (_event, argv) => {
    const rawUrl = options.owner ? _extractConnectorCallback(argv) : null;
    if (rawUrl) void _dispatch(rawUrl);
    else _focusMainWindow();
  });
  return options.owner;
}

/** Flush a callback delivered while Electron was still starting. */
export async function consumeColdLaunchConnectorCallback(): Promise<void> {
  if (!_pending) return;
  const rawUrl = _pending;
  _pending = null;
  await _dispatch(rawUrl);
}

export const _test = { connectorCallbackKind: _connectorCallbackKind, extractConnectorCallback: _extractConnectorCallback };
