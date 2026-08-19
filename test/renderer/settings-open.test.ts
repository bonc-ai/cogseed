import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

class FakeClassList {
  private classes = new Set<string>();

  constructor(initial: string[] = []) {
    initial.forEach((name) => this.classes.add(name));
  }

  add(name: string) { this.classes.add(name); }
  remove(name: string) { this.classes.delete(name); }
  contains(name: string) { return this.classes.has(name); }
  toggle(name: string, force?: boolean) {
    const enabled = force === undefined ? !this.classes.has(name) : force;
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
    return enabled;
  }
}

class FakeElement {
  classList: FakeClassList;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  value = '';
  scrollHeight = 0;
  private listeners = new Map<string, Array<(event?: any) => void>>();

  constructor(initialClasses: string[] = []) {
    this.classList = new FakeClassList(initialClasses);
  }

  addEventListener(type: string, handler: (event?: any) => void) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  querySelector() { return null; }

  click() {
    for (const handler of this.listeners.get('click') || []) {
      handler({ currentTarget: this, target: this });
    }
  }
}

function loadRendererNavigation() {
  const elements = new Map<string, FakeElement>();
  const panelIds = [
    'panel-new-chat', 'panel-auto', 'panel-agents', 'panel-skills',
    'panel-connections', 'panel-contexts', 'panel-settings',
    'panel-memory', 'panel-devtools', 'panel-project', 'panel-marketplace',
    'panel-conversation',
  ];
  for (const id of panelIds) {
    elements.set(id, new FakeElement(id === 'panel-new-chat' ? ['panel', 'active'] : ['panel']));
  }

  const documentListeners = new Map<string, Array<(event?: any) => void>>();
  const document = {
    documentElement: { classList: new FakeClassList() },
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id)!;
    },
    querySelectorAll(selector: string) {
      if (selector === '.panel') return panelIds.map((id) => elements.get(id)!);
      return [];
    },
    addEventListener(type: string, handler: (event?: any) => void) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
  };

  const loadRendererFeature = vi.fn(async () => undefined);
  const loadSettings = vi.fn(async () => undefined);
  const noop = () => undefined;
  const window = {
    addEventListener: noop,
    cogseed: { onPushEvent: noop },
    loadRendererFeature,
  } as any;
  window.window = window;

  const context: any = {
    window,
    document,
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, length: 0, key: () => null },
    performance: { now: () => 0 },
    requestAnimationFrame: (handler: () => void) => { handler(); return 1; },
    setTimeout,
    clearTimeout,
    createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    loadRendererFeature,
    loadSettings,
    renderMessageQueue: noop,
    _bindGlobalSearch: noop,
    handleNewChatSubmit: noop,
    handleChatSubmit: noop,
    toggleAgentEditMode: noop,
    deleteSelectedAgent: noop,
    clearAgentChat: noop,
    bindAgentPickers: noop,
  };

  vm.createContext(context);
  for (const file of ['state.js', 'boot.js']) {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return { context, elements, loadRendererFeature, loadSettings };
}

describe('settings sidebar navigation (merged footer panel)', () => {
  it('opens the settings panel, lazy-loads its feature, and syncs the chip highlight', async () => {
    const { context, elements, loadRendererFeature, loadSettings } = loadRendererNavigation();
    const setChipSettingsActive = vi.fn();
    // account-chip.js 提供的钩子（真实 index.html 中它晚于 boot.js 加载，
    // boot.js 在视图切换时按需调用，测试里直接预置）。
    context.window.setChipSettingsActive = setChipSettingsActive;

    context.bindStaticHandlers();
    // 融合面板「设置」项的路径：window.setView('settings')。
    context.window.setView('settings');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(elements.get('panel-settings')!.classList.contains('active')).toBe(true);
    expect(elements.get('panel-new-chat')!.classList.contains('active')).toBe(false);
    expect(setChipSettingsActive).toHaveBeenCalledWith(true);
    expect(loadRendererFeature).toHaveBeenCalledWith('settings');
    expect(loadSettings).toHaveBeenCalledOnce();

    // 离开设置视图时取消高亮。
    context.window.setView('new-chat');
    expect(setChipSettingsActive).toHaveBeenLastCalledWith(false);
  });
});
