/**
 * Deep-link delivery for the public desktop build: connector OAuth callbacks,
 * the Hub account login callback, and the plugin-authorization callback.
 *
 * Accepted URLs:
 *   - cogseed://connectors/oauth/callback
 *   - cogseed://connectors/oauth/dcr-callback
 *   - cogseed://account/callback   (Hub account login; see features/hub_account)
 *   - cogseed://plugin/authorize/callback  (plugin auth; see features/plugin_oauth_flow)
 *
 * OAuth redirects always land on the public HTTPS Server first. Its landing page then opens one
 * of the URLs above so the exact app instance that started the flow can finish the exchange. This
 * module owns that final OS-protocol hop without restoring any account/session behavior.
 *
 * The three flows stay in separate namespaces on purpose (`AGENTS.md`: plugin/connector
 * authorization must not reuse the account-login namespace) — this dispatcher is the one
 * place where they meet, and it only routes.
 */
import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { CONNECTOR_PROTOCOL_SCHEMES, normalizeDeepLink } from '../../brand';
import { createLogger } from '../../logger';
import { safeUrlAction } from '../../util/log-redact';
import { handleCallbackUrl, handleDcrCallbackUrl } from './index';
import {
  handleAccountCallbackUrl,
  accountCallbackUrl,
  accountSwitchRequested,
  handleAccountSwitchRequested,
} from '../hub_account';
import {
  handlePluginAuthorizeCallbackUrl,
  pluginAuthorizeCallbackUrl,
} from '../plugin_oauth_flow';

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

/** Plugin-authorization callback (`cogseed://plugin/authorize/callback`). */
function _isPluginCallback(rawUrl: string): boolean {
  return pluginAuthorizeCallbackUrl(rawUrl) !== null;
}

function _extractCallback(argv: readonly string[] | undefined): string | null {
  for (const value of argv || []) {
    if (typeof value !== 'string') continue;
    if (accountCallbackUrl(value) || accountSwitchRequested(value)
        || _connectorCallbackKind(value) || _isPluginCallback(value)) return value;
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
  const href = normalized?.href || rawUrl;
  const account = normalized ? accountCallbackUrl(normalized.href) : null;
  // 「换个 CogSeed 账号登录」：与 account/callback 同族但**不带参数**的意图深链。
  // 🔴 必须在这里显式识别：本分发器只认 account / plugin / dcr / connector 四类，
  //    未登记的形状会被当作"非连接器深链"直接丢弃（下面那条 warn 分支）。
  const accountSwitch = !account && normalized ? accountSwitchRequested(normalized.href) : null;
  const isPlugin = !account && !accountSwitch && _isPluginCallback(href);
  const kind = account ? 'account'
    : accountSwitch ? 'account_switch'
      : isPlugin ? 'plugin'
        : (normalized ? _connectorCallbackKind(href) : null);
  if (!account && !kind) {
    log.warn('ignored non-connector deep link', { action: safeUrlAction(rawUrl) });
    return;
  }
  if (!app.isReady()) {
    _pending = rawUrl;
    return;
  }
  log.info('deep link received', { action: safeUrlAction(rawUrl), kind });
  _focusMainWindow();
  try {
    if (account) await handleAccountCallbackUrl(account);
    else if (kind === 'account_switch') await handleAccountSwitchRequested();
    else if (kind === 'plugin') await handlePluginAuthorizeCallbackUrl(href);
    else if (kind === 'dcr') await handleDcrCallbackUrl(href);
    else await handleCallbackUrl(href);
  } catch (err) {
    log.warn('deep link handling failed', { error: (err as Error).message, kind });
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
      if (!normalized) return;
      const href = normalized.href;
      if (!accountCallbackUrl(href) && !accountSwitchRequested(href)
          && !_connectorCallbackKind(href) && !_isPluginCallback(href)) return;
      event.preventDefault();
      void _dispatch(rawUrl);
    });

    const cold = _extractCallback(process.argv);
    if (cold) _pending = cold;
  } else {
    log.info('protocol registration disabled for this runtime');
  }

  // Window activation belongs to the single-instance contract, not protocol
  // ownership. Every runtime focuses its own existing window on a duplicate
  // launch; only the owner may consume an OAuth callback from argv.
  app.on('second-instance', (_event, argv) => {
    const rawUrl = options.owner ? _extractCallback(argv) : null;
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

export const _test = {
  connectorCallbackKind: _connectorCallbackKind,
  isPluginCallback: _isPluginCallback,
  extractCallback: _extractCallback,
  dispatch: _dispatch,
};
