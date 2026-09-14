import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const rendererCss = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

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
  disabled = false;
  tabIndex = 0;
  focused = false;
  scrolled = false;
  attributes = new Map<string, string>();

  constructor(
    public dataset: Record<string, string>,
    classes: string[] = [],
    hidden = false,
  ) {
    this.classList = new FakeClassList(classes);
    this.hidden = hidden;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  getAttribute(name: string) {
    return this.attributes.get(name) || null;
  }

  focus() {
    this.focused = true;
  }

  scrollIntoView() {
    this.scrolled = true;
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
    getElementById() { return null; },
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
  return { context, loadAgents, panes, setView, tabs, window: context.window };
}

describe('connections navigation', () => {
  it('matches the five capability entries from the open-source design system', () => {
    const tablistStart = indexHtml.indexOf('class="connections-tabs"');
    const tablistEnd = indexHtml.indexOf('</div>', tablistStart);
    const tablist = indexHtml.slice(tablistStart, tablistEnd);
    expect([...tablist.matchAll(/data-connections-tab="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'agents', 'mcp', 'skills', 'sources', 'touchpoints',
    ]);
    expect(tablist).toMatch(/connections-tab is-active"[^>]*data-connections-tab="agents"/);
    expect(tablist).toMatch(/connections-tab is-active" role="tab" aria-selected="true"/);
    expect(tablist.match(/role="tab"/g)).toHaveLength(5);
    expect(tablist.match(/tabindex="-1"/g)).toHaveLength(4);
    expect(tablist).not.toContain('data-connections-tab="plugins"');
    expect(tablist).not.toContain('data-connections-tab="models"');
    expect(indexHtml).toContain('id="connections-tools-switcher"');
    expect(indexHtml).toContain('data-connections-tools-view="plugins"');
    expect(indexHtml).not.toContain('id="connections-pane-models"');
    expect(rendererCss).toMatch(/\.connections-tools-tab\.ui-button\.is-active\s*{[^}]*border-bottom-color:\s*var\(--color-accent\);/s);
    expect(rendererCss).toMatch(/\.connections-tools-switcher\s*{[^}]*border-bottom:\s*1px solid var\(--line-default\);/s);
  });

  it('keeps the Agent tab inside Connections', () => {
    const { panes, setView, tabs, window } = loadConnectionsModule();

    window.activateConnectionsTab('agents');

    expect(setView).not.toHaveBeenCalled();
    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(tabs[1].classList.contains('is-active')).toBe(false);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[1].tabIndex).toBe(-1);
    expect(panes[0].hidden).toBe(false);
    expect(panes[1].hidden).toBe(true);
  });

  it('moves across enabled tabs with roving focus and ignores IME composition', () => {
    const { context } = loadConnectionsModule();
    const first = new FakeElement({ connectionsTab: 'agents' });
    const disabled = new FakeElement({ connectionsTab: 'mcp' });
    const last = new FakeElement({ connectionsTab: 'skills' });
    disabled.disabled = true;
    const activate = vi.fn();
    const preventDefault = vi.fn();

    expect(context._connectionsHandleTabKey({ key: 'ArrowRight', isComposing: false, keyCode: 0, preventDefault }, [first, disabled, last], first, activate)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(last.focused).toBe(true);
    expect(last.scrolled).toBe(true);
    expect(activate).toHaveBeenCalledWith(last);

    expect(context._connectionsHandleTabKey({ key: 'ArrowLeft', isComposing: true, keyCode: 229, preventDefault }, [first, last], last, activate)).toBe(false);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('refreshes the full Agent list when the tab becomes active', () => {
    const { loadAgents, window } = loadConnectionsModule();

    window.activateConnectionsTab('agents');

    expect(loadAgents).toHaveBeenCalledWith(false);
  });

  it('keeps IM inside the capability page instead of redirecting to Settings', () => {
    const { panes, setView, tabs, window } = loadConnectionsModule();
    tabs.push(new FakeElement({ connectionsTab: 'touchpoints' }, ['connections-tab']));
    panes.push(new FakeElement({ connectionsPane: 'touchpoints' }, ['connections-tab-pane'], true));

    window.activateConnectionsTab('touchpoints');

    expect(setView).not.toHaveBeenCalled();
    expect(tabs[2].classList.contains('is-active')).toBe(true);
    expect(panes[2].hidden).toBe(false);
  });
});
