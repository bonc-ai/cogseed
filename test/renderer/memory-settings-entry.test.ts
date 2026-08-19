import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/memory.js'),
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

describe('settings memory entry', () => {
  it('binds immediately when the lazy feature loads after DOMContentLoaded', async () => {
    const card = clickable();
    const dataTab = clickable();
    const desc = { textContent: '' };
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
          if (id === 'memory-entry-desc') return desc;
          return null;
        },
        querySelector(selector: string) {
          return selector === '[data-settings-tab="data"]' ? dataTab : null;
        },
        addEventListener() {},
      },
      window: { cogseed: { invoke }, addEventListener() {} },
      setView,
      t: (key: string, vars?: { n?: number }) => key === 'memory.entry_desc' ? `count:${vars?.n || 0}` : key,
      setTimeout,
      clearTimeout,
    });

    vm.runInContext(source, context, { filename: 'memory.js' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    card.click();
    expect(setView).toHaveBeenCalledWith('memory');
    expect(desc.textContent).toBe('count:5');
    expect(card.dataset.bound).toBe('1');
    expect(dataTab.dataset.memoryBound).toBe('1');
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
    vm.runInContext(source, context, { filename: 'memory.js' });
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
    vm.runInContext(source, context, { filename: 'memory.js' });
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
    vm.runInContext(source, context, { filename: 'memory.js' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await vm.runInContext(`(async () => {
      _memEditor = null;
      _memData = { user: { entries: ['hello'], usage: { current: 5, limit: 1500 }, path: 'x' } };
      await _memDelete('user', 'hello');
    })()`, context);

    expect(vm.runInContext('_memData.user.entries', context)).toEqual([]);
  });
});
