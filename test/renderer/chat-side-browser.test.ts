import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const SRC = path.resolve(__dirname, '../../src/renderer/modules/chat-side-browser.js');
const HOST_SRC = path.resolve(__dirname, '../../src/renderer/modules/chat-side-host.js');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pure = require('../../src/renderer/modules/chat-side-browser.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fileViewer = require('../../src/renderer/modules/chat-file-viewer.js');

// `buildFilePreviewHtml` is loaded through require, so it reads the real global
// rather than the vm sandbox below. Provide genuine escaping so the XSS
// assertion is meaningful.
(globalThis as any).escapeHtml = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

describe('side browser — zoom maths', () => {
  it('clamps below the minimum', () => {
    expect(pure.clampSideZoom(0.1)).toBe(pure.SB_ZOOM_MIN);
  });

  it('clamps above the maximum', () => {
    expect(pure.clampSideZoom(9)).toBe(pure.SB_ZOOM_MAX);
  });

  it('keeps an in-range factor', () => {
    expect(pure.clampSideZoom(1.2)).toBeCloseTo(1.2, 5);
  });

  it('falls back to 1 for junk input', () => {
    // A NaN factor would otherwise produce `scale(NaN)` and blank the pane.
    expect(pure.clampSideZoom(Number.NaN)).toBe(1);
    expect(pure.clampSideZoom('abc' as unknown as number)).toBe(1);
    expect(pure.clampSideZoom(undefined as unknown as number)).toBe(1);
  });

  it('rounds accumulated float drift', () => {
    // Repeated +0.1 steps otherwise yield 1.0999999999999999.
    expect(pure.clampSideZoom(1.0999999999999999)).toBe(1.1);
  });

  it('formats the zoom label as a percentage', () => {
    expect(pure.formatSideZoom(1)).toBe('100%');
    expect(pure.formatSideZoom(1.5)).toBe('150%');
    expect(pure.formatSideZoom(0.5)).toBe('50%');
    expect(pure.formatSideZoom(9)).toBe('200%');
  });
});

class FakeClassList {
  classes = new Set<string>();
  add(c: string) { this.classes.add(c); }
  remove(c: string) { this.classes.delete(c); }
  contains(c: string) { return this.classes.has(c); }
  toggle(c: string, force?: boolean) {
    const next = force === undefined ? !this.classes.has(c) : force;
    if (next) this.classes.add(c); else this.classes.delete(c);
    return next;
  }
}

class FakeEl {
  id: string;
  hidden = false;
  innerHTML = '';
  textContent = '';
  title = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  attrs: Record<string, string> = {};
  private handlers: Record<string, Array<() => void>> = {};
  constructor(id: string) { this.id = id; }
  addEventListener(type: string, fn: () => void) { (this.handlers[type] ||= []).push(fn); }
  click() { for (const fn of this.handlers.click || []) fn(); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() {}
  // The pane only ever queries its own zoom wrapper.
  querySelector(sel: string) {
    if (sel === '.chat-side-browser-zoom' && this.innerHTML.includes('chat-side-browser-zoom')) {
      if (!this._zoomWrap) this._zoomWrap = new FakeEl('zoom-wrap');
      return this._zoomWrap;
    }
    return null;
  }
  _zoomWrap: FakeEl | null = null;
}

function load() {
  const ids = [
    'chat-side-host', 'chat-side-tab-browser', 'chat-side-tab-aside',
    'chat-side-wide', 'chat-side-close',
    'chat-side-browser', 'chat-side-browser-body', 'chat-side-browser-name',
    'chat-side-browser-reload', 'chat-side-browser-zoom-in', 'chat-side-browser-zoom-out',
    'chat-side-browser-zoom-reset', 'chat-side-browser-fullscreen', 'chat-side-browser-reveal',
    'chat-aside-panel',
  ];
  const els = new Map<string, FakeEl>();
  for (const id of ids) els.set(id, new FakeEl(id));
  els.get('chat-side-host')!.hidden = true;
  els.get('chat-side-tab-browser')!.hidden = true;

  const invoked: Array<{ channel: string; payload: any }> = [];
  const alerts: string[] = [];
  const docHandlers: Record<string, Array<(e: any) => void>> = {};
  const winHandlers: Record<string, Array<(e: any) => void>> = {};
  const sandbox: any = {
    document: {
      getElementById: (id: string) => els.get(id) || null,
      // bindSideHost() attaches the Escape handler here.
      addEventListener: (type: string, fn: (e: any) => void) => {
        (docHandlers[type] ||= []).push(fn);
      },
      activeElement: null as any,
    },
    console,
    applyDomI18n: () => {},
    t: (k: string) => k,
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[ch]),
    uiAlert: (m: string) => { alerts.push(String(m)); },
    // Reuse the real builder + classifier: this pane must not restate them.
    previewKindOf: fileViewer._kindOf,
    isSidePreviewableKind: fileViewer.isSidePreviewableKind,
    renderFilePreviewInto: (container: any, abs: string, name: string, o: any) => {
      const html = fileViewer.buildFilePreviewHtml(o?.kind, fileViewer._chatMediaLocalUrl(abs), name);
      if (!html) return false;
      container.innerHTML = html;
      return true;
    },
    openChatFileViewer: (...args: any[]) => { invoked.push({ channel: 'fullscreen', payload: args }); },
    window: {} as any,
    orkas: { invoke: async (channel: string, payload: any) => { invoked.push({ channel, payload }); return { ok: true }; } },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type: string, fn: (e: any) => void) => {
    (winHandlers[type] ||= []).push(fn);
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(HOST_SRC, 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
  return { els, api: sandbox, invoked, alerts };
}

describe('side browser — opening files', () => {
  it('renders an HTML file and reveals its tab', () => {
    const { els, api } = load();
    expect(api.openSideBrowser('/tmp/report.html', 'report.html')).toBe(true);

    const body = els.get('chat-side-browser-body')!;
    expect(body.innerHTML).toContain('chat-side-browser-zoom');
    expect(body._zoomWrap!.innerHTML).toContain('<iframe');
    expect(els.get('chat-side-tab-browser')!.hidden).toBe(false);
    expect(api.activeSidePane()).toBe('browser');
  });

  it('sandboxes the frame exactly like the fullscreen viewer', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/report.html', 'report.html');
    const frame = els.get('chat-side-browser-body')!._zoomWrap!.innerHTML;
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).not.toContain('allow-same-origin');
    expect(frame).not.toContain('allow-top-navigation');
  });

  it('serves the file over chat-media:// rather than file://', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/report.html', 'report.html');
    const frame = els.get('chat-side-browser-body')!._zoomWrap!.innerHTML;
    expect(frame).toContain('chat-media://local/');
    expect(frame).not.toContain('file://');
  });

  it('shows the file name in the bar', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/deep/report.html', 'report.html');
    expect(els.get('chat-side-browser-name')!.textContent).toBe('report.html');
  });

  it('derives a name when none is given', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/deep/page.html');
    expect(els.get('chat-side-browser-name')!.textContent).toBe('page.html');
  });

  it('opens pdf and image kinds too', () => {
    const { api } = load();
    expect(api.openSideBrowser('/tmp/a.pdf', 'a.pdf')).toBe(true);
    expect(api.openSideBrowser('/tmp/a.png', 'a.png')).toBe(true);
  });

  it('declines kinds it cannot render, leaving the pane closed', () => {
    // The caller falls back to the fullscreen viewer; showing an empty side
    // pane would look like the feature is broken.
    const { els, api } = load();
    for (const name of ['bundle.zip', 'notes.md', 'data.csv', 'clip.mp4']) {
      expect(api.openSideBrowser(`/tmp/${name}`, name), name).toBe(false);
    }
    expect(els.get('chat-side-tab-browser')!.hidden).toBe(true);
  });

  it('ignores an empty path', () => {
    const { api } = load();
    expect(api.openSideBrowser('', 'x.html')).toBe(false);
  });

  it('escapes a hostile file name into the frame title', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/x.html', '<img src=x onerror=alert(1)>.html');
    const frame = els.get('chat-side-browser-body')!._zoomWrap!.innerHTML;
    expect(frame).not.toContain('<img src=x');
  });
});

describe('side browser — toolbar', () => {
  it('zooms in, out and resets', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html');
    const reset = els.get('chat-side-browser-zoom-reset')!;
    expect(reset.textContent).toBe('100%');

    els.get('chat-side-browser-zoom-in')!.click();
    expect(reset.textContent).toBe('110%');
    els.get('chat-side-browser-zoom-out')!.click();
    els.get('chat-side-browser-zoom-out')!.click();
    expect(reset.textContent).toBe('90%');
    reset.click();
    expect(reset.textContent).toBe('100%');
  });

  it('stops zooming at the bounds', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html');
    for (let i = 0; i < 40; i += 1) els.get('chat-side-browser-zoom-in')!.click();
    expect(els.get('chat-side-browser-zoom-reset')!.textContent).toBe('200%');
    for (let i = 0; i < 60; i += 1) els.get('chat-side-browser-zoom-out')!.click();
    expect(els.get('chat-side-browser-zoom-reset')!.textContent).toBe('50%');
  });

  it('keeps the zoom level across a reload', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html');
    els.get('chat-side-browser-zoom-in')!.click();
    els.get('chat-side-browser-reload')!.click();
    expect(els.get('chat-side-browser-zoom-reset')!.textContent).toBe('110%');
  });

  it('reveals the current file through the validated main channel', () => {
    const { els, api, invoked } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html', { cid: 'c1', projectId: 'p1' });
    els.get('chat-side-browser-reveal')!.click();
    const call = invoked.find((c) => c.channel === 'workspace.revealPath');
    expect(call).toBeTruthy();
    expect(call!.payload).toMatchObject({ path: '/tmp/a.html', cid: 'c1', projectId: 'p1' });
  });

  it('hands the same file to the fullscreen viewer', () => {
    const { els, api, invoked } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html', { cid: 'c1' });
    els.get('chat-side-browser-fullscreen')!.click();
    const call = invoked.find((c) => c.channel === 'fullscreen');
    expect(call!.payload[0]).toBe('/tmp/a.html');
    expect(call!.payload[2]).toMatchObject({ cid: 'c1' });
  });

  it('does nothing on the toolbar with no file open', () => {
    const { els, api, invoked } = load();
    api.bindSideBrowser();
    els.get('chat-side-browser-reload')!.click();
    els.get('chat-side-browser-reveal')!.click();
    els.get('chat-side-browser-fullscreen')!.click();
    expect(invoked).toHaveLength(0);
  });
});

describe('side browser — closing', () => {
  it('drops the frame and hides the tab', () => {
    // Leaving the iframe mounted would keep the page's scripts running behind
    // a hidden pane.
    const { els, api } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html');
    api.closeSideBrowser();
    expect(els.get('chat-side-browser-body')!.innerHTML).toBe('');
    expect(els.get('chat-side-tab-browser')!.hidden).toBe(true);
  });

  it('drops the frame when the whole column closes', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html');
    api.closeSideHost();
    expect(els.get('chat-side-browser-body')!.innerHTML).toBe('');
  });

  it('reopens cleanly after closing', () => {
    const { els, api } = load();
    api.openSideBrowser('/tmp/a.html', 'a.html');
    api.closeSideBrowser();
    expect(api.openSideBrowser('/tmp/b.html', 'b.html')).toBe(true);
    expect(els.get('chat-side-browser-name')!.textContent).toBe('b.html');
  });
});
