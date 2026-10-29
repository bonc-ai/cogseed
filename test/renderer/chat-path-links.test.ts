import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-path-links.js'), 'utf8');

class FakeClassList {
  readonly items = new Set<string>();
  add(...names: string[]) { for (const n of names) this.items.add(n); }
  contains(name: string) { return this.items.has(name); }
}

// Minimal element: enough for decorate (querySelectorAll / closest) and
// activation (dataset / attributes). `ancestors` stands in for the DOM chain.
class FakeCode {
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  attrs: Record<string, string> = {};
  constructor(public textContent: string, private ancestors: string[] = [], private cid = '') {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  closest(selector: string) {
    if (selector === '[data-cid]') return this.cid ? { dataset: { cid: this.cid } } : null;
    const wanted = selector.split(',').map((s) => s.trim());
    return this.ancestors.some((a) => wanted.includes(a)) ? {} : null;
  }
  get linked() { return this.classList.contains('chat-path-link'); }
}

const rootOf = (...codes: FakeCode[]) => ({ querySelectorAll: () => codes });

// `files` = what main would resolve: hint -> absolute path.
function load(files: Record<string, string> = {}, overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  const cogseed = overrides.cogseed || {
    invoke: async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      const results: Record<string, string | null> = {};
      for (const h of payload.hints) results[h] = files[h] || null;
      return { ok: true, results };
    },
  };
  const context: any = {
    console,
    Date,
    t: (key: string) => ({ 'chat.produced_open': 'Open file' }[key] || key),
    ...overrides,
    window: { cogseed },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { ctx: context, calls };
}

describe('decorateChatPathCodes', () => {
  it('links bare names, shortened and absolute paths only once main confirms the file', async () => {
    const { ctx, calls } = load({
      '2026-10-14_下午_张浩会议_会议纪要_v001.md': '/ws/跟进-4/2026-10-14_下午_张浩会议_会议纪要_v001.md',
      '.../跟进-4/转写-纠错.md': '/ws/跟进-4/转写-纠错.md',
      '/ws/跟进-4/转写.md': '/ws/跟进-4/转写.md',
    });
    const bare = new FakeCode('2026-10-14_下午_张浩会议_会议纪要_v001.md', [], 'c1');
    const shortened = new FakeCode('.../跟进-4/转写-纠错.md', [], 'c1');
    const absolute = new FakeCode('/ws/跟进-4/转写.md', [], 'c1');
    const mentioned = new FakeCode('config.json', [], 'c1');

    await ctx.window.decorateChatPathCodes(rootOf(bare, shortened, absolute, mentioned));

    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe('workspace.resolvePathHints');
    expect(calls[0].payload.cid).toBe('c1');
    expect(bare.linked && shortened.linked && absolute.linked).toBe(true);
    expect(bare.dataset.path).toBe('/ws/跟进-4/2026-10-14_下午_张浩会议_会议纪要_v001.md');
    expect(bare.attrs).toMatchObject({ role: 'link', tabindex: '0', title: 'Open file' });
    // Not a real file → stays plain code, no dead link.
    expect(mentioned.linked).toBe(false);
  });

  it.each([
    'v002', 'v1.2', '3.14', 'state=ready', 'https://example.com/a.md',
    'cat a/b.md', 'meetings/2026-10-14-会议/', 'a/b.md\nc/d.md', 'two words.md',
  ])('never asks main about non-file inline code: %s', async (text) => {
    const { ctx, calls } = load();
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode(text)));
    expect(calls).toHaveLength(0);
  });

  it('skips block code and code already inside a link', async () => {
    const { ctx, calls } = load({ 'a.md': '/ws/a.md' });
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode('a.md', ['pre']), new FakeCode('a.md', ['a'])));
    expect(calls).toHaveLength(0);
  });

  it('re-applies cached hits synchronously on later paints without another IPC call', async () => {
    const { ctx, calls } = load({ 'a.md': '/ws/a.md' });
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode('a.md', [], 'c1')));
    const repainted = new FakeCode('a.md', [], 'c1');
    ctx.window.decorateChatPathCodes(rootOf(repainted));
    expect(repainted.linked).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('re-checks a cached miss on fresh decoration (file written after it was named)', async () => {
    const files: Record<string, string> = {};
    const { ctx, calls } = load(files);
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode('later.md', [], 'c1')));
    // Streaming repaint inside the miss window: no new call.
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode('later.md', [], 'c1')));
    expect(calls).toHaveLength(1);

    files['later.md'] = '/ws/later.md';
    const finalCode = new FakeCode('later.md', [], 'c1');
    await ctx.window.decorateChatPathCodes(rootOf(finalCode), { fresh: true });
    expect(calls).toHaveLength(2);
    expect(finalCode.dataset.path).toBe('/ws/later.md');
  });

  it('keys resolutions by conversation', async () => {
    const { ctx, calls } = load({ 'a.md': '/ws/a.md' });
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode('a.md', [], 'c1')));
    await ctx.window.decorateChatPathCodes(rootOf(new FakeCode('a.md', [], 'c2')));
    expect(calls.map((c) => c.payload.cid)).toEqual(['c1', 'c2']);
  });

  it('caches nothing when the resolve call fails, so the next paint retries', async () => {
    let fail = true;
    const { ctx } = load({}, {
      cogseed: {
        invoke: async () => {
          if (fail) throw new Error('ipc down');
          return { ok: true, results: { 'a.md': '/ws/a.md' } };
        },
      },
    });
    const first = new FakeCode('a.md');
    await ctx.window.decorateChatPathCodes(rootOf(first));
    expect(first.linked).toBe(false);
    fail = false;
    const second = new FakeCode('a.md');
    await ctx.window.decorateChatPathCodes(rootOf(second));
    expect(second.linked).toBe(true);
  });
});

describe('activateChatPathLink', () => {
  it('opens the resolved file for the owning conversation', async () => {
    const opened: any[] = [];
    const { ctx } = load({ '.../跟进-4/纪要.md': '/ws/跟进-4/纪要.md' }, {
      openSideBrowser: () => false,
      openChatFileViewer: (p: string, name: string, opts: any) => opened.push({ p, name, opts }),
    });
    const code = new FakeCode('.../跟进-4/纪要.md', [], 'c1');
    await ctx.window.decorateChatPathCodes(rootOf(code));

    expect(ctx.window.activateChatPathLink(code)).toBe(true);
    expect(opened).toEqual([{ p: '/ws/跟进-4/纪要.md', name: '纪要.md', opts: { cid: 'c1' } }]);
  });

  it('does nothing for code that never resolved', () => {
    const opened: any[] = [];
    const { ctx } = load({}, { openChatFileViewer: () => opened.push(1) });
    expect(ctx.window.activateChatPathLink(new FakeCode('a.md'))).toBe(false);
    expect(opened).toEqual([]);
  });
});
