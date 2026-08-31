import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...n: string[]) => n.forEach((x) => values.add(x)),
    remove: (...n: string[]) => n.forEach((x) => values.delete(x)),
    contains: (n: string) => values.has(n),
    toggle: (n: string, f?: boolean) => { const a = f == null ? !values.has(n) : f; if (a) values.add(n); else values.delete(n); return a; },
  };
}
function fakeEl(id: string) {
  const listeners: Record<string, any> = {};
  const el: any = {
    id, innerHTML: '', hidden: false, value: '', textContent: '', dataset: {}, style: {},
    classList: fakeClassList(),
    addEventListener: vi.fn((n: string, fn: any) => { listeners[n] = fn; }),
    appendChild: vi.fn(), querySelector: vi.fn(() => null), querySelectorAll: vi.fn(() => []),
    focus: vi.fn(), scrollTop: 0, scrollHeight: 0, insertAdjacentHTML: vi.fn(), remove: vi.fn(),
    _listeners: listeners,
  };
  return el;
}

const TREE_WITH_NOTES = {
  tree: [
    { name: 'lib', path: 'lib', type: 'dir', children: [] },
    { name: 'notes', path: 'notes', type: 'dir', children: [
      { name: '周记.md', path: 'notes/周记.md', type: 'file', bytes: 10, mtime: 1 },
      { name: '复盘.md', path: 'notes/复盘.md', type: 'file', bytes: 8, mtime: 1 },
    ] },
  ],
};

function loadScript() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-notes.js'), 'utf8');
  const els: Record<string, any> = {};
  const created: any[] = [];
  const invokeCalls: Array<{ ch: string; payload: any }> = [];
  const documentMock: any = {
    getElementById: vi.fn((id: string) => { if (!els[id]) els[id] = fakeEl(id); return els[id]; }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    createElement: vi.fn(() => { const el = fakeEl(''); created.push(el); return el; }),
    execCommand: vi.fn(),
    body: {},
  };
  const windowMock: any = {
    addEventListener: vi.fn(),
    uiToast: vi.fn(),
    uiConfirm: vi.fn(() => Promise.resolve(true)),
    uiPrompt: vi.fn(() => Promise.resolve('新笔记')),
    cogseed: {
      invoke: vi.fn(async (ch: string, payload: any) => {
        invokeCalls.push({ ch, payload });
        if (ch === 'contexts.tree') return TREE_WITH_NOTES;
        if (ch === 'contexts.read') return { ok: true, content: '# 周记\n内容' };
        if (ch === 'contexts.mkdir') return { ok: true };
        if (ch === 'contexts.write') return { ok: true };
        if (ch === 'contexts.delete') return { ok: true };
        return {};
      }),
      stream: vi.fn(() => ({ promise: Promise.resolve() })),
    },
  };
  const context: any = {
    console, Promise, setTimeout, clearTimeout, performance,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (v: unknown) => String(v ?? ''),
    uiToast: windowMock.uiToast, uiPrompt: windowMock.uiPrompt, uiConfirm: windowMock.uiConfirm,
    document: documentMock, window: windowMock,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'kb-notes.js' });
  return { windowMock, els, invokeCalls, created };
}

describe('KB notes panel (S4)', () => {
  it('renders the notes list from the contexts notes/ dir', async () => {
    const { windowMock, els } = loadScript();
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].appendChild).toHaveBeenCalled();
    });
    // 列表项来自 notes/ 目录（周记/复盘 两个文件）
    expect(els['kb-notes-items'].appendChild).toHaveBeenCalledTimes(2);
  });

  it('creates a new note: ensures notes/ dir then writes the file', async () => {
    const { windowMock, els, invokeCalls } = loadScript();
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].appendChild).toHaveBeenCalled();
    });
    els['kb-notes-new']._listeners.click();
    await vi.waitFor(() => {
      expect(invokeCalls.some((c) => c.ch === 'contexts.write' && c.payload.path === 'notes/新笔记.md')).toBe(true);
    });
    // notes 目录已存在 → 不应重复 mkdir
    expect(invokeCalls.some((c) => c.ch === 'contexts.mkdir')).toBe(false);
  });

  it('opens a note and reads its content', async () => {
    const { windowMock, els, invokeCalls, created } = loadScript();
    windowMock.renderKbNotes();
    await vi.waitFor(() => {
      expect(els['kb-notes-items'].appendChild).toHaveBeenCalled();
    });
    // 第一个列表项（周记）触发 open：直接调用其 click 监听器
    const items = els['kb-notes-items'].appendChild.mock.calls.map((c: any[]) => c[0]);
    const first = items.find((el: any) => el._listeners && el._listeners.click);
    expect(first).toBeDefined();
    first._listeners.click();
    await vi.waitFor(() => {
      expect(els['kb-notes-edit'].innerHTML).toContain('周记');
    });
    expect(invokeCalls.some((c) => c.ch === 'contexts.read' && c.payload.path === 'notes/周记.md')).toBe(true);
  });
});
