import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/sidebar-resize.js'),
  'utf8',
);

class FakeClassList {
  private values = new Set<string>();

  contains(value: string) { return this.values.has(value); }
  add(value: string) { this.values.add(value); }
  remove(value: string) { this.values.delete(value); }
  toggle(value: string, force?: boolean) {
    const next = force === undefined ? !this.values.has(value) : force;
    if (next) this.values.add(value);
    else this.values.delete(value);
    return next;
  }
}

// specs/008-shell-rail-layout D13: collapse lives in the sidebar title row
// (#sidebar-collapse-btn); expand lives in every page header's shell slot.
// Both are wired by delegation on data-shell-action.
function loadSidebar(savedCollapsed = false) {
  const body = { classList: new FakeClassList() };
  const documentHandlers: Record<string, (event: any) => void> = {};
  const collapseButton = { focus: vi.fn() };
  const headerExpand = { focus: vi.fn(), getClientRects: () => [1] };
  const handle = { classList: new FakeClassList(), addEventListener: vi.fn() };
  const sidebar = {
    getBoundingClientRect: () => ({ width: body.classList.contains('sidebar-collapsed') ? 0 : 280 }),
  };
  const storage = new Map<string, string>();
  if (savedCollapsed) storage.set('cogseed:sidebar-collapsed', '1');
  const windowHandlers: Record<string, () => void> = {};
  const sandbox: any = {
    document: {
      readyState: 'complete',
      body,
      documentElement: {
        style: { setProperty: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      getElementById(id: string) {
        if (id === 'sidebar-collapse-btn') return collapseButton;
        if (id === 'sidebar-resize-handle') return handle;
        return null;
      },
      querySelector: (selector: string) => selector === '.sidebar' ? sidebar : null,
      querySelectorAll: (selector: string) => selector.includes('expand-sidebar') ? [headerExpand] : [],
      addEventListener: (type: string, handler: (event: any) => void) => { documentHandlers[type] = handler; },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
    t: (key: string) => key,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (type: string, handler: () => void) => {
    windowHandlers[type] = handler;
  };
  sandbox.window.removeEventListener = vi.fn();
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const press = (action: string) => {
    const control = { dataset: { shellAction: action } };
    documentHandlers.click({ target: { closest: () => control } });
  };
  return { body, collapseButton, headerExpand, press, sandbox, storage, windowHandlers, documentHandlers };
}

describe('sidebar shell collapse', () => {
  it('collapses from the sidebar row and expands from the page header slot', () => {
    const { body, collapseButton, headerExpand, press, storage } = loadSidebar();

    press('collapse-sidebar');
    expect(body.classList.contains('sidebar-collapsed')).toBe(true);
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(true);
    expect(storage.get('cogseed:sidebar-collapsed')).toBe('1');
    expect(headerExpand.focus).toHaveBeenCalledOnce();

    press('expand-sidebar');
    expect(body.classList.contains('sidebar-collapsed')).toBe(false);
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(false);
    expect(storage.get('cogseed:sidebar-collapsed')).toBe('0');
    expect(collapseButton.focus).toHaveBeenCalledOnce();
  });

  it('restores a saved collapse and keeps it global across sidebar-less modules', () => {
    const { body, press, sandbox, windowHandlers } = loadSidebar(true);

    expect(body.classList.contains('shell-sidebar-hidden')).toBe(true);
    body.classList.add('shell-no-sidebar');
    sandbox.window.syncSidebarShellState();
    expect(body.classList.contains('sidebar-collapsed')).toBe(true);
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(false);
    body.classList.remove('shell-no-sidebar');
    sandbox.window.syncSidebarShellState();
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(true);

    windowHandlers.load();
    press('expand-sidebar');
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(false);
  });

  it('ignores clicks outside shell controls', () => {
    const { body, documentHandlers } = loadSidebar();
    documentHandlers.click({ target: { closest: () => null } });
    expect(body.classList.contains('sidebar-collapsed')).toBe(false);
  });
});
