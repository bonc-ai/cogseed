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

  constructor(
    public dataset: Record<string, string>,
    classes: string[] = [],
    hidden = false,
  ) {
    this.classList = new FakeClassList(classes);
    this.hidden = hidden;
  }
}

function loadConnectionsModule() {
  const tabs = [
    new FakeElement({ connectionsTab: 'agents' }, ['connections-tab']),
    new FakeElement({ connectionsTab: 'mcp' }, ['connections-tab', 'is-active']),
  ];
  const panes = [
    new FakeElement({ connectionsPane: 'agents' }, ['connections-tab-pane'], true),
    new FakeElement({ connectionsPane: 'mcp' }, ['connections-tab-pane']),
  ];
  const setView = vi.fn();
  const loadAgents = vi.fn();
  const document = {
    querySelectorAll(selector: string) {
      if (selector === '.connections-tab') return tabs;
      if (selector === '.connections-tab-pane') return panes;
      return [];
    },
  };
  const context: any = { document, loadAgents, Promise, setView, window: {} };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(root, 'src/renderer/modules/connections.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'connections.js' });
  return { loadAgents, panes, setView, tabs, window: context.window };
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
});
