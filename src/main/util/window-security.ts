import type { BrowserWindowConstructorOptions, Session, WebPreferences } from 'electron';

/**
 * Security baseline for every BrowserWindow we create. Callers may add
 * functional preferences (preload, session, plugins, etc.), but cannot
 * override the four isolation controls through the overrides object.
 */
export function hardenedWebPreferences(overrides: Partial<WebPreferences> = {}): WebPreferences {
  return {
    ...overrides,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  };
}

/** Return a normalized external-browser URL, or null for unsafe input. */
export function safeExternalHttpUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const WECOM_QUICK_CREATE_ORIGIN = 'https://work.weixin.qq.com';
const WECOM_QUICK_CREATE_PATH = '/ai/qc/gen';

/**
 * The Enterprise WeCom quick-create page is the sole remote page permitted
 * to open inside Electron. It has its own no-bridge preload and communicates
 * back only through a browser postMessage checked by the renderer.
 */
export function isOfficialWecomQuickCreateUrl(raw: unknown): boolean {
  const normalized = safeExternalHttpUrl(raw);
  if (!normalized || normalized.length > SAFE_EXTERNAL_LINK_MAX_LENGTH) return false;
  try {
    const url = new URL(normalized);
    return url.origin === WECOM_QUICK_CREATE_ORIGIN
      && url.pathname === WECOM_QUICK_CREATE_PATH
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

const SAFE_EXTERNAL_LINK_MAX_LENGTH = 2048;
const SAFE_MAIL_QUERY_KEYS = new Set(['subject', 'body', 'cc', 'bcc']);

function decodeOpaquePath(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function isSafeMailbox(value: string): boolean {
  const mailbox = value.trim();
  if (!mailbox || mailbox.length > 254 || /[\u0000-\u0020\u007f<>()\[\]\\,;:"]/u.test(mailbox)) return false;
  const at = mailbox.lastIndexOf('@');
  if (at <= 0 || at >= mailbox.length - 1) return false;
  const local = mailbox.slice(0, at);
  const domain = mailbox.slice(at + 1);
  if (local.length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  if (domain.length > 253 || !domain.includes('.')) return false;
  return domain.split('.').every((label) => (
    !!label
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function safeMailtoUrl(url: URL): string | null {
  if (url.hash || url.host || url.username || url.password) return null;
  const path = decodeOpaquePath(url.pathname);
  if (!path) return null;
  const recipients = path.split(',').map((value) => value.trim());
  if (!recipients.length || recipients.some((value) => !isSafeMailbox(value))) return null;
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase();
    if (!SAFE_MAIL_QUERY_KEYS.has(normalizedKey)) return null;
    if (value.length > 1000 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
    if ((normalizedKey === 'cc' || normalizedKey === 'bcc')
      && value.split(',').some((mailbox) => !isSafeMailbox(mailbox))) return null;
  }
  return url.toString();
}

function safePhoneUrl(url: URL): string | null {
  if (url.search || url.hash || url.host || url.username || url.password) return null;
  const target = decodeOpaquePath(url.pathname);
  if (!target || target.length > 64 || !/[0-9]/.test(target)) return null;
  return /^\+?[0-9*#()., -]+$/.test(target) ? url.toString() : null;
}

function safeXmppUrl(url: URL): string | null {
  if (url.search || url.hash || url.host || url.username || url.password) return null;
  const jid = decodeOpaquePath(url.pathname);
  return jid && isSafeMailbox(jid) ? url.toString() : null;
}

/**
 * Validate a link opened from an explicit renderer click. Keep this narrower
 * than the schemes Chromium/DOMPurify understand: `shell.openExternal` hands
 * the URL to an OS application, so every non-HTTP shape is strictly parsed.
 */
export function safeExternalUserActionUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > SAFE_EXTERNAL_LINK_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const http = safeExternalHttpUrl(value);
  if (http) return http;
  try {
    const url = new URL(value);
    if (url.protocol === 'mailto:') return safeMailtoUrl(url);
    if (url.protocol === 'tel:' || url.protocol === 'sms:' || url.protocol === 'callto:') {
      return safePhoneUrl(url);
    }
    if (url.protocol === 'xmpp:') return safeXmppUrl(url);
    return null;
  } catch {
    return null;
  }
}

interface NavigationEvent {
  preventDefault(): void;
}

type WindowOpenResult =
  | { action: 'deny' }
  | { action: 'allow'; overrideBrowserWindowOptions?: BrowserWindowConstructorOptions };

interface GuardedWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenResult): void;
  on(event: 'will-navigate', handler: (event: NavigationEvent, url: string) => void): void;
}

interface WecomQuickCreatePopupWebContents {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  on(event: 'will-navigate', handler: (event: NavigationEvent, url: string) => void): void;
  on(event: 'will-redirect', handler: (event: NavigationEvent, url: string) => void): void;
}

interface ExternalNavigationGuardOptions {
  /**
   * A deliberately tiny exception for a remote authorization page which must
   * retain a browser opener in order to return an official postMessage.
   */
  allowWindowOpen?: (url: string) => boolean;
  allowedWindowOpenOptions?: BrowserWindowConstructorOptions;
}

/**
 * Keep the application renderer on its original local document. HTTP(S)
 * destinations are handed to the OS browser; every in-app navigation,
 * including file/data/javascript/custom schemes, is denied. Explicit user
 * clicks for tightly validated mail/phone links use the IPC link router
 * instead of weakening this last-resort navigation guard.
 */
export function installExternalNavigationGuard(
  webContents: GuardedWebContents,
  openExternal: (url: string) => Promise<unknown>,
  warn: (error: unknown) => void = () => {},
  options: ExternalNavigationGuardOptions = {},
): void {
  const open = (raw: unknown): void => {
    const url = safeExternalHttpUrl(raw);
    if (!url) return;
    Promise.resolve()
      .then(() => openExternal(url))
      .catch((error) => warn(error));
  };

  webContents.setWindowOpenHandler(({ url }) => {
    if (options.allowWindowOpen?.(url)) {
      return {
        action: 'allow',
        ...(options.allowedWindowOpenOptions ? { overrideBrowserWindowOptions: options.allowedWindowOpenOptions } : {}),
      };
    }
    open(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    open(url);
  });
}

/**
 * The official quick-create document must retain its opener to return the
 * documented postMessage, but it is otherwise treated as untrusted remote
 * content. In particular, a server-side redirect is cancellable separately
 * from `will-navigate` and must not turn this window into a general browser.
 */
export function installWecomQuickCreatePopupGuard(webContents: WecomQuickCreatePopupWebContents): void {
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockUnexpectedNavigation = (event: NavigationEvent, url: string): void => {
    if (!isOfficialWecomQuickCreateUrl(url)) event.preventDefault();
  };
  webContents.on('will-navigate', blockUnexpectedNavigation);
  webContents.on('will-redirect', blockUnexpectedNavigation);
}

/**
 * A remote authorization page never needs an Electron permission. It runs in
 * an isolated, non-persistent session so its permission decisions cannot
 * inherit the main renderer's copy/paste grants.
 */
export function installDenyAllRemotePermissionGate(
  remoteSession: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>,
): void {
  remoteSession.setPermissionCheckHandler(() => false);
  remoteSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}
