import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/kb-eco.js'), 'utf8');

function fakeElement(dataset: Record<string, string> = {}) {
  const listeners: Record<string, () => void> = {};
  return {
    dataset,
    hidden: false,
    innerHTML: '',
    title: '',
    classList: { toggle: vi.fn() },
    addEventListener: vi.fn((name: string, handler: () => void) => { listeners[name] = handler; }),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    _listeners: listeners,
  } as any;
}

describe('KB ecosystem navigation refresh', () => {
  it('reloads the knowledge workbench whenever the user returns from discovery', () => {
    const buttons = ['kb', 'notes', 'discover'].map((key) => fakeElement({ kbEco: key }));
    const elements: Record<string, any> = {
      'kb-view': fakeElement(),
      'kb-workbench': fakeElement(),
      'kb-notes': fakeElement(),
      'kb-discover': fakeElement(),
      'kb-eco-compact': fakeElement(),
    };
    elements['kb-view'].querySelectorAll = vi.fn((selector: string) => selector === '[data-kb-eco]' ? buttons : []);
    const renderKbWorkbench = vi.fn();
    const renderKbDiscover = vi.fn();
    const context: any = {
      window: { addEventListener: vi.fn(), uiIconHtml: vi.fn(() => ''), renderKbWorkbench, renderKbDiscover },
      document: {
        getElementById: vi.fn((id: string) => elements[id] || null),
        querySelectorAll: vi.fn((selector: string) => selector === '[data-kb-eco]' ? buttons : []),
      },
      localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
      renderKbWorkbench,
      renderKbDiscover,
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'kb-eco.js' });

    context.window.renderKbEco();
    buttons.find((button) => button.dataset.kbEco === 'discover')._listeners.click();
    buttons.find((button) => button.dataset.kbEco === 'kb')._listeners.click();

    expect(renderKbDiscover).toHaveBeenCalledOnce();
    expect(renderKbWorkbench).toHaveBeenCalledOnce();
    expect(elements['kb-workbench'].hidden).toBe(false);
  });
});
