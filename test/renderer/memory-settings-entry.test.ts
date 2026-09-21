import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/memory.js'),
  'utf8',
);
const uiButtonSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-button.js'), 'utf8');
const uiFormSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-form.js'), 'utf8');
const uiSegmentedControlSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/ui-segmented-control.js'), 'utf8');
const rendererCss = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

function clickable() {
  const listeners: Record<string, () => void> = {};
  return {
    dataset: {} as Record<string, string>,
    addEventListener(type: string, handler: () => void) { listeners[type] = handler; },
    click() { listeners.click?.(); },
  };
}

function loadMemoryModule(context: vm.Context) {
  vm.runInContext(uiButtonSource, context, { filename: 'ui-button.js' });
  vm.runInContext(uiFormSource, context, { filename: 'ui-form.js' });
  vm.runInContext(uiSegmentedControlSource, context, { filename: 'ui-segmented-control.js' });
  (context as any).uiButton = (context as any).window.uiButton;
  (context as any).uiIconButton = (context as any).window.uiIconButton;
  (context as any).uiTextarea = (context as any).window.uiTextarea;
  (context as any).uiSegmentedControl = (context as any).window.uiSegmentedControl;
  vm.runInContext(source, context, { filename: 'memory.js' });
}

describe('settings memory entry', () => {
  it('uses the shared page, card, field, and dialog tokens', () => {
    expect(rendererCss).toMatch(/\.memory-detail-header\s*{[^}]*min-height:\s*var\(--layout-titlebar-height\);[^}]*border-bottom:\s*1px solid var\(--line-subtle\);/s);
    expect(rendererCss).toMatch(/\.memory-col\s*{[^}]*width:\s*var\(--layout-thread-width\);[^}]*padding:\s*var\(--space-5\) var\(--space-6\) var\(--space-page\);/s);
    expect(rendererCss).toMatch(/\.memory-entry\s*{[^}]*border-radius:\s*var\(--radius-card\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
    expect(rendererCss).toMatch(/\.memory-entry-textarea\s*{[^}]*border:\s*1px solid var\(--line-field\);[^}]*border-radius:\s*var\(--radius-field\);/s);
    expect(source).toContain("host.className = 'ui-modal-overlay memory-modal-overlay'");
    expect(source).toContain('class="ui-modal memory-modal"');
    expect(source).toContain('class="ui-modal__header memory-modal-head"');
    expect(source).toContain('class="ui-modal__body memory-modal-body');
    expect(source).toContain('class="ui-modal__footer memory-modal-foot"');
    expect(rendererCss).not.toMatch(/\.memory-modal\s*\{[^}]*(?:background|border-radius|box-shadow):/s);
  });

  it('routes ordinary memory controls through shared renderer primitives', () => {
    expect(source).toContain("uiButton({ label: t('memory.import')");
    expect(source).toContain("uiIconButton({ label: t('memory.add_entry')");
    expect(source).toContain("uiTextarea({ id: 'memory-import-text'");
    expect(source).toContain('uiSegmentedControl({');
    expect(source.match(/<(?:button|input|textarea|select)\b/gi)).toHaveLength(1);
  });

  it('binds immediately when the lazy feature loads after DOMContentLoaded', async () => {
    const card = clickable();
    const setView = vi.fn();
    const invoke = vi.fn(async () => ({
      ok: true,
      files: { user: { count: 2 }, shared: { count: 3 } },
    }));
    const context = vm.createContext({
      console,
      document: {
        readyState: 'complete',
        getElementById(id: string) {
          if (id === 'memory-entry-card') return card;
          return null;
        },
        querySelector() {
          return null;
        },
        addEventListener() {},
      },
      window: { cogseed: { invoke }, addEventListener() {} },
      setView,
      t: (key: string, vars?: { n?: number }) => key,
      setTimeout,
      clearTimeout,
    });

    loadMemoryModule(context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 记忆页退役（2026-09-20）：设置卡改跳认知资产；计数填充随页面退役移除。
    card.click();
    expect(setView).toHaveBeenCalledWith('recall');
    expect(card.dataset.bound).toBe('1');
    // 导出/导入工具经 window.MemoryTools 暴露（个人本体页复用）。
    expect((context as any).window.MemoryTools).toBeTruthy();
    expect(typeof (context as any).window.MemoryTools.openExport).toBe('function');
    expect(typeof (context as any).window.MemoryTools.openImport).toBe('function');
  });
});

// Regression: the open-source strip removed the _memTrackEvent definition
// while leaving five call sites in the save/delete/import-merge flows, so a
// successful write threw ReferenceError before the UI refresh (editor stayed
// open, list stale). The module must define it (as a no-op like _memTrack)
// and the mutating flows must resolve and refresh _memData afterwards.
describe('memory page entry mutations', () => {
  function hostStub() {
    return {
      innerHTML: '',
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { contains: () => false },
    };
  }

  function makeContext(opts: { invoke: (channel: string, payload?: unknown) => Promise<any> }) {
    const textarea = { value: 'hello' };
    const editor = {
      querySelector(sel: string) {
        return sel === '.memory-entry-textarea' ? textarea : null;
      },
    };
    return vm.createContext({
      console,
      document: {
        readyState: 'complete',
        getElementById(id: string) {
          if (id === 'memory-page') return hostStub();
          if (id === 'memory-entry-desc') return { textContent: '' };
          return null;
        },
        querySelector(sel: string) {
          return sel.startsWith('[data-mem-editor=') ? editor : null;
        },
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createElement: () => ({ querySelector: () => null, querySelectorAll: () => [], addEventListener() {} }),
        body: { appendChild() {} },
      },
      window: { cogseed: { invoke: opts.invoke }, addEventListener() {}, Monitor: null },
      setView() {},
      t: (key: string) => key,
      escapeHtml: (s: unknown) => String(s),
      uiToast() {},
      uiPrompt: async () => null,
      uiConfirm: async () => true,
      uiConfirmDanger: async () => true,
      uiIconHtml: () => '',
      CSS: { escape: (s: string) => s },
      setTimeout,
      clearTimeout,
    });
  }

  it('defines _memTrackEvent so mutating flows do not throw', async () => {
    const context = makeContext({
      invoke: async () => ({ ok: true, files: { user: { count: 0 }, shared: { count: 0 } } }),
    });
    loadMemoryModule(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.runInContext('typeof _memTrackEvent', context)).toBe('function');
  });

  it('save resolves, closes the editor, and refreshes the scope data', async () => {
    const invoke = vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'memory.exportInfo') return { ok: true, files: { user: { count: 0 }, shared: { count: 0 } } };
      if (channel === 'memory.add') return { ok: true, entries: ['hello'], usage: { current: 5, limit: 1500 } };
      return { ok: true, entries: [], usage: { current: 0, limit: 1500 } };
    });
    const context = makeContext({ invoke });
    loadMemoryModule(context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vm.runInContext(`(async () => {
      _memEditor = { target: 'user', mode: 'add' };
      _memData = { user: { entries: [], usage: { current: 0, limit: 1500 }, path: 'x' } };
      await _memSaveEditor('user');
    })()`, context);

    expect(invoke).toHaveBeenCalledWith('memory.add', { target: 'user', content: 'hello' });
    expect(vm.runInContext('_memEditor', context)).toBeNull();
    expect(vm.runInContext('_memData.user.entries', context)).toEqual(['hello']);
  });

  it('delete resolves and refreshes the scope data', async () => {
    const context = makeContext({
      invoke: async (channel: string) => {
        if (channel === 'memory.exportInfo') return { ok: true, files: { user: { count: 0 }, shared: { count: 0 } } };
        if (channel === 'memory.remove') return { ok: true, entries: [], usage: { current: 0, limit: 1500 } };
        return { ok: true, entries: [], usage: { current: 0, limit: 1500 } };
      },
    });
    loadMemoryModule(context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vm.runInContext(`(async () => {
      _memEditor = null;
      _memData = { user: { entries: ['hello'], usage: { current: 5, limit: 1500 }, path: 'x' } };
      await _memDelete('user', 'hello');
    })()`, context);

    expect(vm.runInContext('_memData.user.entries', context)).toEqual([]);
  });
});
