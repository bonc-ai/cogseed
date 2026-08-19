import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';

import { cogseedRuntimeSessionToolResultsDir } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import type { CogSeedHostToolResult, CogSeedHostToolScope } from './office-adapter';
import { cogseedCapabilityArtifactRegistry, type CogSeedCapabilityArtifactRegistry } from './capability-artifact-lifecycle';

interface BrowserImageLike { toPNG(): Buffer }
interface BrowserWebContentsLike {
  getURL(): string;
  executeJavaScript(script: string, userGesture?: boolean): Promise<any>;
  capturePage(): Promise<BrowserImageLike>;
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
  on?(event: string, handler: (...args: any[]) => void): void;
  stop?(): void;
  session?: { webRequest?: { onBeforeRequest(filter: { urls: string[] }, listener: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void): void } };
}
export interface CogSeedBrowserWindowLike {
  loadURL(url: string): Promise<unknown>;
  getTitle?(): string;
  webContents: BrowserWebContentsLike;
  isDestroyed(): boolean;
  destroy(): void;
}
export interface CogSeedBrowserWindowOptions {
  show: false;
  webPreferences: { nodeIntegration: false; contextIsolation: true; sandbox: true; partition: string };
}

export interface CogSeedBrowserManagerDeps {
  createWindow?: (options: CogSeedBrowserWindowOptions) => CogSeedBrowserWindowLike | Promise<CogSeedBrowserWindowLike>;
  artifactRegistry?: CogSeedCapabilityArtifactRegistry;
}

interface BrowserSession {
  window: CogSeedBrowserWindowLike;
  refs: Map<number, { tag: string; role?: string }>;
  blockedUrl?: string;
  ownedArtifacts: Set<string>;
}

export interface CogSeedBrowserManager {
  open(scope: CogSeedHostToolScope, url: string, opts?: { signal?: AbortSignal | null }): Promise<CogSeedHostToolResult>;
  snapshot(scope: CogSeedHostToolScope, maxChars?: number): Promise<CogSeedHostToolResult>;
  click(scope: CogSeedHostToolScope, ref: number): Promise<CogSeedHostToolResult>;
  type(scope: CogSeedHostToolScope, ref: number, text: string, submit?: boolean): Promise<CogSeedHostToolResult>;
  screenshot(scope: CogSeedHostToolScope, outputPath?: string): Promise<CogSeedHostToolResult>;
  dispose(userId: string, runtimeSessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
}

const WAF_RE = /cf-browser-verification|__cf_chl|attention required|just a moment|verify (?:you are|you're)(?: a)? human|安全验证|人机验证|访问验证/i;
const MAX_SNAPSHOT_CHARS = 50_000;
const MAX_TYPE_CHARS = 20_000;

function key(userId: string, runtimeSessionId: string) { return `${userId}\0${runtimeSessionId}`; }
function fail(code: string, message: string): CogSeedHostToolResult { return { content: `[${code}] ${message}`, isError: true }; }

function publicUrl(raw: string): URL | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') return null;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (v4 && (v4.some((n) => n > 255) || v4[0] === 10 || v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254) || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168))) return null;
  if (host.includes(':') && (/^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host) || host === '::')) return null;
  return parsed;
}

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const __MATE_BROWSER_SNAPSHOT__ = true;
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0; };
  const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')).filter(visible).slice(0, 300);
  const elements = candidates.map((el, index) => { const ref = index + 1; el.setAttribute('data-cogseed-ref', String(ref)); return { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 500), type: (el.getAttribute('type') || '').toLowerCase(), value: ((el.getAttribute('type') || '').toLowerCase() === 'password' ? '' : ('value' in el ? String(el.value || '') : '')).slice(0, 1000) }; });
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 50000), elements };
})()`;

export function createCogSeedBrowserManager(deps: CogSeedBrowserManagerDeps = {}): CogSeedBrowserManager {
  const sessions = new Map<string, BrowserSession>();
  const createWindow = deps.createWindow ?? (async (options) => {
    const electron = await import('electron');
    return new electron.BrowserWindow(options) as unknown as CogSeedBrowserWindowLike;
  });
  const artifactRegistry = deps.artifactRegistry ?? cogseedCapabilityArtifactRegistry;

  async function ensure(scope: CogSeedHostToolScope): Promise<BrowserSession> {
    const id = key(scope.userId, scope.runtimeSessionId);
    const current = sessions.get(id);
    if (current && !current.window.isDestroyed()) return current;
    const partition = `cogseed-runtime-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
    const window = await createWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition } });
    const state: BrowserSession = { window, refs: new Map(), ownedArtifacts: new Set() };
    window.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    window.webContents.session?.webRequest?.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !publicUrl(details.url) }));
    const blockUnsafeNavigation = (event: { preventDefault?: () => void }, url: string) => { if (!publicUrl(url)) event.preventDefault?.(); };
    window.webContents.on?.('will-navigate', blockUnsafeNavigation);
    window.webContents.on?.('will-redirect', blockUnsafeNavigation);
    sessions.set(id, state);
    return state;
  }

  function current(scope: CogSeedHostToolScope): BrowserSession | undefined {
    const state = sessions.get(key(scope.userId, scope.runtimeSessionId));
    return state && !state.window.isDestroyed() ? state : undefined;
  }

  async function registerScreenshot(scope: CogSeedHostToolScope, output: string, owned: boolean): Promise<string> {
    const artifactId = `browser-screenshot-${randomUUID()}`;
    if (artifactRegistry) await artifactRegistry.register({ userId: scope.userId, runtimeSessionId: scope.runtimeSessionId }, { kind: 'browser-screenshot', path: output, owned }).catch(() => undefined);
    return artifactId;
  }

  async function cleanup(scope: { userId: string; runtimeSessionId: string }): Promise<void> {
    if (artifactRegistry) await artifactRegistry.cleanup({ userId: scope.userId, runtimeSessionId: scope.runtimeSessionId }).catch(() => undefined);
  }

  return {
    async open(scope, rawUrl, opts = {}) {
      const url = typeof rawUrl === 'string' ? publicUrl(rawUrl) : null;
      if (!url) return fail('E_BROWSER_URL', 'only public HTTP/HTTPS URLs without credentials are allowed');
      if (opts.signal?.aborted) return fail('E_BROWSER_ABORTED', 'browser navigation aborted');
      try {
        const state = await ensure(scope);
        state.refs.clear();
        const onAbort = () => state.window.webContents.stop?.();
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try { await state.window.loadURL(url.toString()); }
        finally { opts.signal?.removeEventListener('abort', onAbort); }
        if (opts.signal?.aborted) return fail('E_BROWSER_ABORTED', 'browser navigation aborted');
        const finalUrl = state.window.webContents.getURL();
        if (!publicUrl(finalUrl)) {
          state.window.destroy();
          return fail('E_BROWSER_URL', 'navigation left the public HTTP/HTTPS scope');
        }
        return { content: JSON.stringify({ url: finalUrl, title: state.window.getTitle?.() ?? '' }) };
      } catch (cause) {
        return fail('E_BROWSER_NAVIGATION', cause instanceof Error ? cause.message : String(cause));
      }
    },
    async snapshot(scope, maxChars = MAX_SNAPSHOT_CHARS) {
      const state = current(scope);
      if (!state) return fail('E_BROWSER_SESSION', 'open a page before taking a snapshot');
      if (state.blockedUrl === state.window.webContents.getURL()) return fail('E_BROWSER_WAF_USER_ACTION_REQUIRED', 'the current page requires manual human verification');
      try {
        const value = await state.window.webContents.executeJavaScript(SNAPSHOT_SCRIPT, true);
        const limit = Math.max(1, Math.min(Math.floor(maxChars || MAX_SNAPSHOT_CHARS), MAX_SNAPSHOT_CHARS));
        const text = String(value?.text || '').slice(0, limit);
        const title = String(value?.title || '').slice(0, 1_000);
        if (WAF_RE.test(`${title}\n${text}`)) {
          state.blockedUrl = state.window.webContents.getURL();
          return fail('E_BROWSER_WAF_USER_ACTION_REQUIRED', 'the current page requires manual human verification');
        }
        const elements = Array.isArray(value?.elements) ? value.elements.slice(0, 300).map((item: any) => ({
          ref: Number(item.ref), tag: String(item.tag || '').slice(0, 40), role: item.role ? String(item.role).slice(0, 80) : undefined,
          label: String(item.label || '').slice(0, 500), type: item.type ? String(item.type).slice(0, 40).toLowerCase() : undefined, value: item.value === undefined ? undefined : (String(item.type || '').toLowerCase() === 'password' ? '' : String(item.value).slice(0, 1_000)),
        })).filter((item: any) => Number.isInteger(item.ref) && item.ref > 0) : [];
        state.refs = new Map(elements.map((item: any) => [item.ref, { tag: item.tag, role: item.role }]));
        return { content: JSON.stringify({ url: String(value?.url || state.window.webContents.getURL()), title, text, elements }) };
      } catch (cause) { return fail('E_BROWSER_SNAPSHOT', cause instanceof Error ? cause.message : String(cause)); }
    },
    async click(scope, ref) {
      const state = current(scope); if (!state) return fail('E_BROWSER_SESSION', 'open a page before clicking');
      if (!Number.isInteger(ref) || !state.refs.has(ref)) return fail('E_BROWSER_REF', 'ref is not present in the latest snapshot');
      try {
        const result = await state.window.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-cogseed-ref="${ref}"]'); if (!el) return {ok:false}; el.click(); return {ok:true,url:location.href,title:document.title}; })()`, true);
        state.refs.clear();
        const finalUrl = String(result?.url || state.window.webContents.getURL());
        if (!publicUrl(finalUrl)) {
          state.window.destroy();
          return fail('E_BROWSER_URL', 'navigation left the public HTTP/HTTPS scope');
        }
        return result?.ok ? { content: JSON.stringify({ ...result, url: finalUrl }) } : fail('E_BROWSER_REF', 'element is no longer available');
      } catch (cause) { return fail('E_BROWSER_CLICK', cause instanceof Error ? cause.message : String(cause)); }
    },
    async type(scope, ref, text, submit = false) {
      const state = current(scope); if (!state) return fail('E_BROWSER_SESSION', 'open a page before typing');
      const meta = state.refs.get(ref);
      if (!Number.isInteger(ref) || !meta || !['input', 'textarea'].includes(meta.tag) && meta.role !== 'textbox') return fail('E_BROWSER_REF', 'ref is not a text input from the latest snapshot');
      if (typeof text !== 'string' || text.length > MAX_TYPE_CHARS) return fail('E_BROWSER_INPUT', `text must be at most ${MAX_TYPE_CHARS} characters`);
      try {
        const encoded = JSON.stringify(text); const submitFlag = submit ? 'true' : 'false';
        const result = await state.window.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-cogseed-ref="${ref}"]'); if (!el) return {ok:false}; const value=${encoded}; el.focus(); if ('value' in el) el.value=value; else el.textContent=value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); if (${submitFlag}) { el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})); if (el.form?.requestSubmit) el.form.requestSubmit(); } return {ok:true,url:location.href,title:document.title}; })()`, true);
        if (!result?.ok) return fail('E_BROWSER_REF', 'element is no longer available');
        const finalUrl = String(result?.url || state.window.webContents.getURL());
        if (!publicUrl(finalUrl)) {
          state.refs.clear();
          state.window.destroy();
          return fail('E_BROWSER_URL', 'navigation left the public HTTP/HTTPS scope');
        }
        return { content: JSON.stringify({ ...result, url: finalUrl }) };
      } catch (cause) { return fail('E_BROWSER_TYPE', cause instanceof Error ? cause.message : String(cause)); }
    },
    async screenshot(scope, rawOutput) {
      const state = current(scope); if (!state) return fail('E_BROWSER_SESSION', 'open a page before taking a screenshot');
      const output = rawOutput ? path.resolve(scope.workingDir ?? '.', rawOutput) : path.join(cogseedRuntimeSessionToolResultsDir(scope.userId, scope.runtimeSessionId), `browser-${Date.now().toString(36)}.png`);
      if (rawOutput && (!scope.writableRoots.length || !isPathAllowed(output, scope.writableRoots))) return fail('E_PATH_OUT_OF_SCOPE', 'browser screenshot path is outside writable Runtime roots');
      if (path.extname(output).toLowerCase() !== '.png') return fail('E_BROWSER_INPUT', 'browser screenshot output must be .png');
      try {
        const image = await state.window.webContents.capturePage(); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, image.toPNG());
        const artifactId = await registerScreenshot(scope, output, !rawOutput);
        if (!rawOutput) state.ownedArtifacts.add(output);
        return { content: JSON.stringify({ path: output, bytes: fs.statSync(output).size, artifactId }) };
      } catch (cause) { return fail('E_BROWSER_SCREENSHOT', cause instanceof Error ? cause.message : String(cause)); }
    },
    async dispose(userId, runtimeSessionId) {
      const scope = { userId, runtimeSessionId };
      const id = key(userId, runtimeSessionId); const state = sessions.get(id); sessions.delete(id);
      if (state && !state.window.isDestroyed()) state.window.destroy();
      if (state) for (const file of state.ownedArtifacts) { try { fs.rmSync(file, { force: true }); } catch {} }
      await cleanup(scope);
    },
    async disposeAll() {
      for (const [id, state] of sessions) { sessions.delete(id); if (!state.window.isDestroyed()) state.window.destroy(); for (const file of state.ownedArtifacts) { try { fs.rmSync(file, { force: true }); } catch {} } }
      if (artifactRegistry) {
        // Best-effort cleanup is only possible per scope; disposeAll only tears down live windows.
      }
    },
  };
}

export const cogseedBrowserManager = createCogSeedBrowserManager();
