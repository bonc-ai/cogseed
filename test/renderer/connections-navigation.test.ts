import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

class FakeClassList {
  classes = new Set<string>();

  constructor(initial: string[] = []) {
    initial.forEach((name) => this.classes.add(name));
  }

  contains(name: string) {
    return this.classes.has(name);
  }

  toggle(name: string, force?: boolean) {
    const enabled = force === undefined ? !this.classes.has(name) : force;
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
    return enabled;
  }
}

class FakeElement {
  classList: FakeClassList;
  hidden: boolean;
  listeners = new Map<string, Array<() => void>>();

  constructor(
    public dataset: Record<string, string>,
    classes: string[] = [],
    hidden = false,
  ) {
    this.classList = new FakeClassList(classes);
    this.hidden = hidden;
  }

  addEventListener(type: string, handler: () => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  click() {
    for (const handler of this.listeners.get('click') || []) handler();
  }
}

function loadConnectionsModule() {
  const tabs = [
    new FakeElement({ connectionsTab: 'agents' }, ['connections-tab']),
    new FakeElement({ connectionsTab: 'mcp' }, ['connections-tab', 'is-active']),
    new FakeElement({ connectionsTab: 'touchpoints' }, ['connections-tab']),
    new FakeElement({ connectionsTab: 'models' }, ['connections-tab']),
  ];
  const panes = [
    new FakeElement({ connectionsPane: 'agents' }, ['connections-tab-pane'], true),
    new FakeElement({ connectionsPane: 'mcp' }, ['connections-tab-pane']),
    new FakeElement({ connectionsPane: 'touchpoints' }, ['connections-tab-pane'], true),
    new FakeElement({ connectionsPane: 'models' }, ['connections-tab-pane'], true),
  ];
  const cards = [
    new FakeElement({ connectionsSubentry: 'models' }),
  ];
  const setView = vi.fn();
  const loadAgents = vi.fn();
  const loadRendererFeature = vi.fn(async () => undefined);
  const initTouchpointSettings = vi.fn();
  const document = {
    getElementById() {
      return null;
    },
    querySelector(selector: string) {
      if (selector === '.connections-tab.is-active') {
        return tabs.find((tab) => tab.classList.contains('is-active')) || null;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '.connections-tab') return tabs;
      if (selector === '.connections-tab-pane') return panes;
      if (selector === '[data-connections-subentry]') return cards;
      return [];
    },
  };
  const context: any = {
    document,
    initTouchpointSettings,
    loadAgents,
    loadRendererFeature,
    Promise,
    setView,
    window: { addEventListener: vi.fn() },
  };
  context.window.window = context.window;
  context.window.loadRendererFeature = loadRendererFeature;
  context.window.initTouchpointSettings = initTouchpointSettings;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(root, 'src/renderer/modules/connections.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'connections.js' });
  return { cards, initTouchpointSettings, loadAgents, loadRendererFeature, panes, setView, tabs, window: context.window };
}

describe('connections navigation', () => {
  it('keeps the Agent tab inside Connections', () => {
    const { panes, setView, tabs, window } = loadConnectionsModule();

    window.activateConnectionsTab('agents');

    expect(setView).not.toHaveBeenCalled();
    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(tabs[1].classList.contains('is-active')).toBe(false);
    expect(panes[0].hidden).toBe(false);
    expect(panes[1].hidden).toBe(true);
  });

  it('refreshes the full Agent list when the tab becomes active', () => {
    const { loadAgents, window } = loadConnectionsModule();

    window.activateConnectionsTab('agents');

    expect(loadAgents).toHaveBeenCalledWith(false);
  });

  it('keeps the Touchpoints tab inside Connections and loads its settings bundle', async () => {
    const { initTouchpointSettings, loadRendererFeature, panes, setView, tabs, window } = loadConnectionsModule();

    window.activateConnectionsTab('touchpoints');
    await Promise.resolve();

    expect(setView).not.toHaveBeenCalled();
    expect(tabs[2].classList.contains('is-active')).toBe(true);
    expect(panes[2].hidden).toBe(false);
    expect(loadRendererFeature).toHaveBeenCalledWith('settings');
    expect(initTouchpointSettings).toHaveBeenCalled();
  });

  it('opens Models & Quota inside Connections instead of bouncing to Settings configuration', () => {
    const { cards, panes, setView, tabs, window } = loadConnectionsModule();

    window.initConnections();
    cards[0].click();

    expect(setView).not.toHaveBeenCalled();
    expect(tabs[3].classList.contains('is-active')).toBe(true);
    expect(panes[3].hidden).toBe(false);
  });
});
