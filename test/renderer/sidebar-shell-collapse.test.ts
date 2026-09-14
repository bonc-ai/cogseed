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

function loadSidebar(savedCollapsed = false) {
  const body = { classList: new FakeClassList() };
  const buttonHandlers: Record<string, () => void> = {};
  const button = {
    title: '',
    attributes: {} as Record<string, string>,
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    addEventListener(type: string, handler: () => void) { buttonHandlers[type] = handler; },
  };
  const handle = { classList: new FakeClassList(), addEventListener: vi.fn() };
  const sidebar = {
    getBoundingClientRect: () => ({ width: body.classList.contains('sidebar-collapsed') ? 0 : 280 }),
  };
  const storage = new Map<string, string>();
  if (savedCollapsed) storage.set('cogseed:sidebar-collapsed', '1');
  const windowHandlers: Record<string, () => void> = {};
  const closeRunCenterGlobal = vi.fn();
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
        if (id === 'sidebar-collapse-btn') return button;
        if (id === 'sidebar-resize-handle') return handle;
        return null;
      },
      querySelector: (selector: string) => selector === '.sidebar' ? sidebar : null,
      addEventListener: vi.fn(),
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
  sandbox.window.closeRunCenterGlobal = closeRunCenterGlobal;
  sandbox.window.addEventListener = (type: string, handler: () => void) => {
    windowHandlers[type] = handler;
  };
  sandbox.window.removeEventListener = vi.fn();
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return { body, button, buttonHandlers, closeRunCenterGlobal, storage, windowHandlers };
}

describe('sidebar shell collapse', () => {
  it('collapses to the shell recovery state and expands with the same button', () => {
    const { body, button, buttonHandlers, closeRunCenterGlobal, storage } = loadSidebar();

    expect(button.attributes['aria-expanded']).toBe('true');
    buttonHandlers.click();
    expect(body.classList.contains('sidebar-collapsed')).toBe(true);
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(true);
    expect(button.title).toBe('展开侧边栏');
    expect(button.attributes['aria-expanded']).toBe('false');
    expect(button.attributes['data-i18n-title']).toBe('sidebar.expand_title');
    expect(storage.get('cogseed:sidebar-collapsed')).toBe('1');
    expect(closeRunCenterGlobal).toHaveBeenCalledTimes(1);

    buttonHandlers.click();
    expect(body.classList.contains('sidebar-collapsed')).toBe(false);
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(false);
    expect(button.title).toBe('收起侧边栏');
    expect(button.attributes['aria-expanded']).toBe('true');
    expect(storage.get('cogseed:sidebar-collapsed')).toBe('0');
  });

  it('restores a saved collapse without losing the expand entry', () => {
    const { body, button, buttonHandlers, windowHandlers } = loadSidebar(true);

    expect(body.classList.contains('shell-sidebar-hidden')).toBe(true);
    expect(button.attributes['aria-label']).toBe('展开侧边栏');
    windowHandlers.load();
    buttonHandlers.click();
    expect(body.classList.contains('shell-sidebar-hidden')).toBe(false);
  });
});
