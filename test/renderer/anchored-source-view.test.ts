import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/anchored-source-view.js'),
  'utf8',
);

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    toggle: (name: string, force?: boolean) => {
      const enabled = force == null ? !values.has(name) : force;
      if (enabled) values.add(name);
      else values.delete(name);
      return enabled;
    },
  };
}

function loadViewer() {
  let toggleHandler: (() => void) | null = null;
  const makeElement = () => ({
    textContent: '',
    hidden: false,
    dataset: {} as Record<string, string>,
    innerHTML: '',
    classList: fakeClassList(),
    appendChild: vi.fn(),
    addEventListener: vi.fn((name: string, handler: () => void) => {
      if (name === 'click') toggleHandler = handler;
    }),
    querySelector: vi.fn((selector: string) => selector === '[data-anchor-view-toggle]'
      ? { addEventListener: (_name: string, handler: () => void) => { toggleHandler = handler; } }
      : selector === 'mark'
        ? { scrollIntoView: vi.fn() }
        : null),
  });
  const elements: Record<string, any> = {
    '[data-anchor-view-meta]': makeElement(),
    '[data-anchor-view-actions]': makeElement(),
    '[data-anchor-view-status]': makeElement(),
    '[data-anchor-view-text]': makeElement(),
    '[data-anchor-view-note]': makeElement(),
    '.ui-modal__title': makeElement(),
    '.ui-modal__description': makeElement(),
  };
  const dialog = {
    classList: fakeClassList(),
    querySelector: vi.fn((selector: string) => elements[selector] || null),
  };
  const overlay = {};
  const modal = Object.assign(new Promise(() => {}), { dialog, overlay });
  const invoke = vi.fn(async (_channel: string, payload: any) => payload.view === 'document'
    ? {
        resolved: true,
        displayPath: payload.path,
        textStart: 0,
        text: 'prefix cited passage suffix',
        charStart: 7,
        charEnd: 20,
        totalChars: 27,
      }
    : {
        resolved: true,
        displayPath: payload.path,
        textStart: 0,
        text: 'prefix cited passage suffix',
        charStart: 7,
        charEnd: 20,
        totalChars: 27,
      });
  const uiModal = vi.fn(() => modal);
  const uiButton = vi.fn(({ label }: { label: string }) => `<span data-anchor-view-toggle>${label}</span>`);
  const windowMock: any = {
    addEventListener: vi.fn(),
    cogseed: { invoke },
    uiModal,
    uiButton,
    uiToast: vi.fn(),
    t: (key: string) => key,
  };
  const documentMock: any = {
    body: { contains: vi.fn(() => true) },
    createTextNode: vi.fn((text: string) => ({ textContent: text })),
    createElement: vi.fn(() => makeElement()),
  };
  const context: any = {
    window: windowMock,
    document: documentMock,
    globalThis: windowMock,
    module: { exports: {} },
    Promise,
    requestAnimationFrame: (callback: () => void) => callback(),
    createLogger: () => ({ warn: vi.fn() }),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'anchored-source-view.js' });
  return { windowMock, uiModal, uiButton, invoke, getToggleHandler: () => toggleHandler };
}

describe('anchored source viewer', () => {
  it('opens files through the shared modal and reuses the active viewer', async () => {
    const viewer = loadViewer();

    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 1, view: 'document',
    });
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/b.md', chunkIdx: 1, view: 'document',
    });

    expect(viewer.uiModal).toHaveBeenCalledOnce();
    expect(viewer.uiButton).toHaveBeenCalled();
    expect(viewer.invoke).toHaveBeenLastCalledWith('cogseed.anchor.resolve', expect.objectContaining({
      path: 'notes/b.md',
      view: 'document',
    }));
  });

  it('switches from full source back to the highlighted citation', async () => {
    const viewer = loadViewer();
    await viewer.windowMock.__openAnchorViewer({
      source: 'library', scope: 'global', path: 'notes/a.md', chunkIdx: 1, view: 'document',
    });

    viewer.getToggleHandler()?.();

    await vi.waitFor(() => expect(viewer.invoke).toHaveBeenLastCalledWith(
      'cogseed.anchor.resolve',
      expect.objectContaining({ view: 'anchor' }),
    ));
  });

  it('contains no page-local raw buttons or literal z-index values', () => {
    expect(source).not.toMatch(/<button\b/i);
    expect(source).not.toMatch(/z-index\s*:/i);
    expect(source).toContain('root.uiModal');
    expect(source).toContain('root.uiButton');
  });
});
