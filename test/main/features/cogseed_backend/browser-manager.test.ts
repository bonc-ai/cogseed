import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMateBrowserManager } from '../../../../src/main/features/cogseed_backend/browser-manager';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const scope = (root?: string) => ({ userId: 'browser-user', requestId: 'req-browser', runtimeSessionId: 'mruntime-browser', readOnlyRoots: root ? [root] : [], writableRoots: root ? [root] : [], workingDir: root });

function harness() {
  const scripts: string[] = [];
  const win: any = {
    url: 'about:blank', destroyed: false,
    async loadURL(url: string) { win.url = url; },
    getTitle: () => 'Example',
    webContents: {
      getURL: () => win.url,
      executeJavaScript: vi.fn(async (script: string) => {
        scripts.push(script);
        if (script.includes('__MATE_BROWSER_SNAPSHOT__')) return { url: win.url, title: 'Example', text: 'Hello', elements: [{ ref: 1, tag: 'button', role: 'button', label: 'Go' }, { ref: 2, tag: 'input', role: 'textbox', label: 'Name', value: '' }, { ref: 3, tag: 'input', role: 'textbox', type: 'password', label: 'Password', value: 'secret' }] };
        return { ok: true, url: win.url, title: 'Example' };
      }),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('png') })),
      session: { webRequest: { onBeforeRequest: vi.fn() } },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      stop: vi.fn(),
    },
    isDestroyed: () => win.destroyed,
    destroy: vi.fn(() => { win.destroyed = true; }),
  };
  const createWindow = vi.fn(() => win);
  return { manager: createMateBrowserManager({ createWindow }), createWindow, win, scripts };
}

describe('Mate browser manager', () => {
  it('creates a sandboxed hidden session and rejects unsafe URLs', async () => {
    const h = harness();
    const opened = await h.manager.open(scope(), 'https://example.com'); expect(JSON.parse(opened.content)).toMatchObject({ title: 'Example' });
    expect(h.win.webContents.session.webRequest.onBeforeRequest).toHaveBeenCalled();
    expect(h.createWindow).toHaveBeenCalledWith(expect.objectContaining({ show: false, webPreferences: expect.objectContaining({ nodeIntegration: false, contextIsolation: true, sandbox: true }) }));
    await expect(h.manager.open(scope(), 'file:///etc/passwd')).resolves.toMatchObject({ isError: true, content: expect.stringContaining('E_BROWSER_URL') });
    await expect(h.manager.open(scope(), 'http://127.0.0.1/private')).resolves.toMatchObject({ isError: true });
  });

  it('uses snapshot numeric refs and invalidates them after navigation', async () => {
    const h = harness(); await h.manager.open(scope(), 'https://example.com');
    const snap = await h.manager.snapshot(scope());
    const snapshot = JSON.parse(snap.content); expect(snapshot.elements).toHaveLength(3); expect(snapshot.elements[2].value).toBe('');
    const typed = await h.manager.type(scope(), 2, 'Ada', false); expect(typed.isError).toBeFalsy();
    const clicked = await h.manager.click(scope(), 1); expect(clicked.isError).toBeFalsy();
    await h.manager.open(scope(), 'https://example.org');
    await expect(h.manager.click(scope(), 1)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('E_BROWSER_REF') });
  });

  it('rejects unsafe post-submit navigation when typing with submit=true', async () => {
    const h = harness();
    h.win.webContents.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__MATE_BROWSER_SNAPSHOT__')) {
        return { url: h.win.url, title: 'Example', text: 'Hello', elements: [{ ref: 2, tag: 'input', role: 'textbox', label: 'Search', value: '' }] };
      }
      if (script.includes('requestSubmit')) return { ok: true, url: 'http://127.0.0.1/private', title: 'Private' };
      return { ok: true, url: h.win.url, title: 'Example' };
    });
    await h.manager.open(scope(), 'https://example.com');
    await h.manager.snapshot(scope());
    await expect(h.manager.type(scope(), 2, 'query', true)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('E_BROWSER_URL') });
    expect(h.win.destroy).toHaveBeenCalled();
  });

  it('writes screenshots only under writable roots and disposes the session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-browser-')); dirs.push(dir);
    const h = harness(); await h.manager.open(scope(dir), 'https://example.com');
    const output = path.join(dir, 'shot.png');
    const shot = await h.manager.screenshot(scope(dir), output); expect(shot.isError).toBeFalsy();
    expect(fs.readFileSync(output, 'utf8')).toBe('png');
    await expect(h.manager.screenshot(scope(dir), path.join(os.tmpdir(), 'escape.png'))).resolves.toMatchObject({ isError: true });
    await h.manager.dispose(scope(dir).userId, scope(dir).runtimeSessionId);
    expect(h.win.destroy).toHaveBeenCalled();
  });
});
