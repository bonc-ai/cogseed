import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the production page and its real click bindings, with controlled IPC
// completion order. No test bridge or private state is added to the renderer.
function loadWorkspace() {
  let now = Date.now();
  let html = '';
  let controls: any[] = [];
  const writes: string[] = [];
  const answers = new Map<string, any>();
  const events = new Map<string, () => void>();
  const artifactWindow = { innerHTML: '' };
  const artifactList = { getBoundingClientRect: () => ({ top: 0 }) };
  const artifactResults = { set innerHTML(_value: string) { artifactWindow.innerHTML = ''; } };
  const matches = (element: any, selector: string) => selector.split(',').some((part) => {
    const attrs = [...part.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    return attrs.length > 0 && attrs.every(([, key, value]) => key in element.attrs && (value === undefined || element.attrs[key] === value));
  });
  const root: any = {
    attributes: {} as Record<string, string>, scrollTop: 0, clientHeight: 600,
    getBoundingClientRect: () => ({ top: 0 }),
    setAttribute(name: string, value: any) { this.attributes[name] = String(value); },
    addEventListener() {},
    querySelectorAll: (selector: string) => controls.filter((el) => matches(el, selector)),
    querySelector: (selector: string) => controls.find((el) => matches(el, selector)) || null,
    get innerHTML() { return html; },
    set innerHTML(value: string) {
      html = value; writes.push(value); artifactWindow.innerHTML = '';
      controls = [...value.matchAll(/<(button|input|select|article)\b([^>]*)>/g)].map(([, , text]) => {
        const attrs = Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]));
        const dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-'))
          .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
        const listeners = new Map<string, (event: any) => any>();
        return { attrs, dataset, value: attrs.value || '', focus: vi.fn(), addEventListener: (type: string, fn: any) => listeners.set(type, fn),
          fire: (type = 'click') => listeners.get(type)?.({ preventDefault() {}, stopPropagation() {} }) };
      });
    },
  };
  const document: any = {
    activeElement: null, addEventListener() {},
    getElementById: (id: string) => id === 'ws-view' ? root : null,
    querySelector: (selector: string) => {
      if (selector === '[data-ws="art-results"]' && html.includes('data-ws="art-results"')) return artifactResults;
      if (selector === '[data-ws="art-vlist"]' && html.includes('data-ws="art-vlist"')) return artifactList;
      if (selector === '[data-ws="art-vwindow"]' && html.includes('data-ws="art-vwindow"')) return artifactWindow;
      return null;
    }, querySelectorAll: () => [],
  };
  const invoke = vi.fn(async (channel: string, payload: any) => {
    const key = `${channel}:${payload?.spaceId || ''}`;
    if (answers.has(key)) return answers.get(key);
    if (channel === 'spaces.list') return { spaces: [{ space_id: 'a', name: 'SPACE_A' }, { space_id: 'b', name: 'SPACE_B' }] };
    if (channel === 'spaces.conversations.list') return { conversations: [{ conversation_id: `task-${payload.spaceId}`, title: `TASK_${payload.spaceId}` }] };
    const fields: Record<string, string> = { 'personalOntology.templates.catalog': 'templates', 'personalOntology.scenarios.list': 'scenarios', 'skills.list': 'skills', 'agents.list': 'agents' };
    if (fields[channel]) return { [fields[channel]]: [] };
    return {};
  });
  const context: any = { document, HTMLInputElement: class {}, Element: class {}, setTimeout, clearTimeout, Date: class extends Date { static now() { return now; } }, Map, Set, Intl, URL };
  context.window = { document, cogseed: { invoke }, addEventListener: (type: string, fn: () => void) => events.set(type, fn) };
  context.setView = vi.fn((view: string) => {
    if (view === 'workspace') {
      context.window.prepareWorkspaceView?.();
      void context.window.renderWorkspace();
    } else context.window.leaveWorkspace?.();
  });
  vm.createContext(context);
  for (const name of ['ui-button', 'ui-empty', 'workspace']) vm.runInContext(read(`src/renderer/modules/${name}.js`), context, { filename: `${name}.js` });
  return {
    context, root, invoke, writes, answers, events, html: () => html, artifactHtml: () => artifactWindow.innerHTML,
    // Existing recovery tests explicitly refresh; visit models normal navigation.
    enter: () => context.window.renderWorkspace({ force: true }),
    visit: () => context.window.renderWorkspace(),
    advanceTime: (ms: number) => { now += ms; },
    open: async (id: string) => { context.window.openWorkspaceSpace(id); await flush(); },
    click: async (action: string, attribute = '', value = '') => {
      const control = controls.find((el) => el.dataset.ws === action && (!attribute || el.dataset[attribute] === value));
      expect(control, `missing real control: ${action}`).toBeTruthy();
      control.fire(); await flush();
    },
  };
}

describe('workspace navigation and asynchronous ownership', () => {
  it('shows spaces while template reads are still pending, without loading configuration catalogs', async () => {
    const h = loadWorkspace(); const response = deferred();
    h.answers.set('personalOntology.templates.catalog:', response.promise);
    const entry = h.visit(); await flush();
    const first = h.html();
    response.resolve({ templates: [] }); await entry; await flush();
    expect(first).toContain('SPACE_A'); expect(first).toContain('data-ws-catalog="templates"');
    expect(first).not.toContain('暂无可用空间模板');
    expect(h.invoke.mock.calls.some(([channel]) => ['skills.list', 'agents.list', 'localAgents.list'].includes(channel))).toBe(false);
  });

  it('starts known-space tasks immediately while its metadata refresh is pending', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred();
    h.answers.set('spaces.list:', response.promise); const refresh = h.enter();
    await h.open('a'); const visible = h.html().includes('TASK_a');
    response.resolve({ spaces: [{ space_id: 'a', name: 'SPACE_A' }] }); await refresh;
    expect(visible).toBe(true);
  });

  it('reuses recent successful metadata on navigation but refreshes after five seconds', async () => {
    const h = loadWorkspace(); await h.visit(); await flush(); h.context.window.leaveWorkspace(); h.invoke.mockClear();
    await h.visit(); await flush(); expect(h.invoke).not.toHaveBeenCalled();
    h.context.window.leaveWorkspace(); h.advanceTime(5001); await h.visit(); await flush();
    expect(h.invoke.mock.calls.map(([channel]) => channel)).toEqual(['spaces.list']);
  });

  it('keeps template failures local and retries without reloading the space list', async () => {
    const h = loadWorkspace(); h.answers.set('personalOntology.templates.catalog:', { error: 'OFFLINE' });
    await h.visit(); await flush(); expect(h.html()).toContain('SPACE_A');
    expect(h.html()).toContain('data-ws="retry-catalog"');
    h.answers.delete('personalOntology.templates.catalog:'); h.invoke.mockClear();
    await h.click('retry-catalog');
    expect(h.html()).not.toContain('data-ws="retry-catalog"');
    expect(h.invoke.mock.calls.some(([channel]) => channel === 'spaces.list')).toBe(false);
  });

  it('loads configuration only when opened and prevents submission of incomplete capability data', async () => {
    const h = loadWorkspace(); await h.visit(); await flush(); const response = deferred();
    h.answers.set('skills.list:', response.promise); await h.click('create-space');
    const pending = h.html();
    response.resolve({ skills: [] }); await flush();
    expect(pending).toContain('data-ws-catalog="configuration"');
    expect(pending).toMatch(/<button[^>]*disabled[^>]*data-ws="confirm-create"/);
    expect(h.html()).toContain('data-ws="create-name"');
    expect(h.html()).not.toMatch(/<button[^>]*disabled[^>]*data-ws="confirm-create"/);
    expect(h.invoke.mock.calls.some(([channel]) => channel === 'spaces.create')).toBe(false);
  });

  it('does not mark visible tasks busy while only an unused artifact read is pending', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred();
    h.answers.set('spaces.artifacts.list:a', response.promise); await h.open('a');
    expect(h.html()).toContain('TASK_a'); expect(h.root.attributes['aria-busy']).toBe('false');
    response.resolve({ artifacts: [] }); await flush();
  });

  it('joins pending catalogs across visits and refreshes them only after their own TTL', async () => {
    const h = loadWorkspace(); const response = deferred();
    h.answers.set('personalOntology.templates.catalog:', response.promise);
    await h.visit(); h.context.window.leaveWorkspace(); await h.visit();
    expect(h.invoke.mock.calls.filter(([channel]) => channel === 'personalOntology.templates.catalog')).toHaveLength(1);
    response.resolve({ templates: [] }); await flush();
    h.context.window.leaveWorkspace(); h.advanceTime(29000); h.invoke.mockClear(); await h.visit();
    expect(h.invoke.mock.calls.map(([channel]) => channel)).toEqual(['spaces.list']);
    h.context.window.leaveWorkspace(); h.advanceTime(1001); h.invoke.mockClear(); await h.visit(); await flush();
    expect(h.invoke.mock.calls.map(([channel]) => channel)).toEqual(['personalOntology.templates.catalog', 'personalOntology.scenarios.list']);
  });

  it('keeps configuration errors local and retries only the failed catalog', async () => {
    const h = loadWorkspace(); await h.visit(); await h.open('a');
    h.answers.set('skills.list:', { error: 'OFFLINE' }); await h.click('space-settings');
    expect(h.html()).toContain('TASK_a'); expect(h.html()).toContain('data-ws="retry-catalog"');
    expect(h.html()).not.toContain('data-ws="save-instructions"');
    h.answers.delete('skills.list:'); h.invoke.mockClear(); await h.click('retry-catalog');
    expect(h.invoke.mock.calls.map(([channel]) => channel)).toEqual(['skills.list']);
    expect(h.html()).toContain('data-ws="save-instructions"');
    expect(h.html()).not.toContain('data-ws="retry-catalog"');
  });

  it('does not reopen a canceled create dialog or repaint a hidden page when capabilities arrive late', async () => {
    const h = loadWorkspace(); await h.visit(); const skills = deferred(); const agents = deferred();
    h.answers.set('skills.list:', skills.promise); h.answers.set('agents.list:', agents.promise);
    await h.click('create-space'); await h.click('close-create');
    skills.resolve({ skills: [] }); await flush();
    expect(h.html()).not.toContain('data-ws="confirm-create"');
    h.context.window.leaveWorkspace(); h.writes.length = 0;
    agents.resolve({ agents: [] }); await flush(); expect(h.writes).toHaveLength(0);
    await h.visit(); expect(h.html()).not.toContain('data-ws="confirm-create"');
  });

  it('invalidates recent metadata after task creation and rejects a pre-mutation read', async () => {
    const h = loadWorkspace(); await h.visit(); await h.open('a'); const old = deferred();
    h.answers.set('spaces.list:', old.promise); const refresh = h.enter();
    h.answers.set('conversations.create:a', { conversation: { conversation_id: 'created-task', space_id: 'a' } });
    await h.click('new-task');
    h.answers.set('spaces.list:', { spaces: [{ space_id: 'a', name: 'AFTER_CREATION' }] });
    h.invoke.mockClear(); await h.visit();
    expect(h.invoke.mock.calls.filter(([channel]) => channel === 'spaces.list')).toHaveLength(1);
    old.resolve({ spaces: [{ space_id: 'a', name: 'BEFORE_CREATION' }] }); await refresh; await flush();
    expect(h.html()).toContain('AFTER_CREATION'); expect(h.html()).not.toContain('BEFORE_CREATION');
  });

  it('keeps a post-save metadata read single-flight when an older navigation read finishes', async () => {
    const h = loadWorkspace(); await h.visit(); await h.open('a'); await h.click('space-settings');
    const old = deferred(); const fresh = deferred();
    h.answers.set('spaces.list:', old.promise); const refresh = h.enter();
    h.answers.set('spaces.list:', fresh.promise); await h.click('save-instructions');
    expect(h.invoke.mock.calls.some(([channel]) => channel === 'spaces.instructions.set')).toBe(true);
    old.resolve({ spaces: [{ space_id: 'a', name: 'BEFORE_SAVE' }] }); await refresh; await flush();
    h.context.window.leaveWorkspace(); h.invoke.mockClear(); const revisit = h.visit(); await flush();
    expect(h.invoke.mock.calls.some(([channel]) => channel === 'spaces.list')).toBe(false);
    fresh.resolve({ spaces: [{ space_id: 'a', name: 'AFTER_SAVE' }] }); await revisit; await flush();
    expect(h.html()).toContain('AFTER_SAVE'); expect(h.html()).not.toContain('BEFORE_SAVE');
  });

  it('rejects older template and Agent catalogs after a language refresh supersedes them', async () => {
    const h = loadWorkspace(); const templates = deferred(); const agents = deferred();
    h.answers.set('personalOntology.templates.catalog:', templates.promise);
    h.answers.set('agents.list:', agents.promise); await h.visit(); await h.click('create-space');
    h.answers.set('personalOntology.templates.catalog:', { templates: [{ templateId: 'new', name: 'NEW_TEMPLATE' }] });
    h.answers.set('agents.list:', { agents: [{ agent_id: 'new-agent', name: 'NEW_AGENT' }] });
    h.events.get('i18n-change')?.(); await flush();
    templates.resolve({ templates: [{ templateId: 'old', name: 'OLD_TEMPLATE' }] });
    agents.resolve({ agents: [{ agent_id: 'old-agent', name: 'OLD_AGENT' }] }); await flush();
    expect(h.html()).toContain('NEW_TEMPLATE'); expect(h.html()).not.toContain('OLD_TEMPLATE');
    await h.click('open-ability', 'kind', 'task');
    expect(h.html()).toContain('NEW_AGENT'); expect(h.html()).not.toContain('OLD_AGENT');
  });

  it('updates visible artifact author labels when deferred Agents arrive without leaking the previous space', async () => {
    const h = loadWorkspace(); await h.visit(); const agents = deferred();
    h.answers.set('agents.list:', agents.promise);
    h.answers.set('spaces.artifacts.list:a', { artifacts: [{ name: 'A.txt', agentIds: ['alpha'] }] });
    h.answers.set('spaces.artifacts.list:b', { artifacts: [{ name: 'B.txt', agentIds: ['beta'] }] });
    await h.open('a'); await h.click('space-tab', 'tab', 'artifacts');
    expect(h.artifactHtml()).toContain('alpha');
    await h.open('b'); await h.click('space-tab', 'tab', 'artifacts');
    expect(h.artifactHtml()).toContain('beta');
    agents.resolve({ agents: [{ agent_id: 'alpha', name: 'AUTHOR_A' }, { agent_id: 'beta', name: 'AUTHOR_B' }] }); await flush();
    expect(h.artifactHtml()).toContain('AUTHOR_B'); expect(h.artifactHtml()).not.toContain('AUTHOR_A');
    expect(h.invoke.mock.calls.filter(([channel]) => channel === 'agents.list')).toHaveLength(1);
    expect(h.invoke.mock.calls.some(([channel]) => channel === 'skills.list')).toBe(false);
  });

  it('keeps a warmed center visible on revisit and joins an in-flight refresh', async () => {
    const h = loadWorkspace(); await h.enter(); await flush();
    const response = deferred(); h.answers.set('spaces.list:', response.promise);
    h.writes.length = 0; h.invoke.mockClear();
    const first = h.enter(); const second = h.enter();
    expect(h.html()).toContain('ws-center-header');
    expect(h.writes.every((html) => !html.includes('class="ws-loading"'))).toBe(true);
    expect(h.invoke.mock.calls.filter(([channel]) => channel === 'spaces.list')).toHaveLength(1);
    response.resolve({ spaces: [{ space_id: 'a', name: 'SPACE_A' }] }); await Promise.all([first, second]);
    expect(h.root.attributes['aria-busy']).toBe('false');
  });

  it('never pre-renders or navigates during data-only warmup, even when the user enters mid-flight', async () => {
    const h = loadWorkspace(); const response = deferred(); h.answers.set('spaces.list:', response.promise);
    const warm = h.context.window.warmWorkspace();
    expect(h.writes).toHaveLength(0);
    h.context.window.openWorkspaceSpace('b');
    response.resolve({ spaces: [{ space_id: 'a', name: 'SPACE_A' }, { space_id: 'b', name: 'SPACE_B' }] });
    await warm; await flush();
    expect(h.html()).toContain('<h1>SPACE_B</h1>');
    expect(h.html()).toContain('TASK_b');
    expect(h.invoke.mock.calls.filter(([channel]) => channel === 'spaces.list')).toHaveLength(1);
  });

  it('clears A data before the first B frame and shows loading instead of a false empty state', async () => {
    const h = loadWorkspace(); await h.enter(); await h.open('a');
    expect(h.html()).toContain('TASK_a');
    const response = deferred(); h.answers.set('spaces.conversations.list:b', response.promise);
    h.writes.length = 0; await h.open('b');
    expect(h.html()).toContain('<h1>SPACE_B</h1>');
    expect(h.html()).toContain('data-ws-detail-loading');
    expect(h.writes.filter((html) => html.includes('<h1>SPACE_B</h1>')).every((html) => !html.includes('TASK_a'))).toBe(true);
    response.resolve({ conversations: [{ conversation_id: 'b-2', title: 'TASK_b_NEW' }] }); await flush();
    expect(h.html()).toContain('TASK_b_NEW');
    expect(h.html()).not.toContain('data-ws-detail-loading');
  });

  it('drops late tasks from A after B has loaded', async () => {
    const h = loadWorkspace(); await h.enter();
    const response = deferred(); h.answers.set('spaces.conversations.list:a', response.promise);
    await h.open('a'); await h.open('b');
    expect(h.html()).toContain('TASK_b');
    response.resolve({ conversations: [{ conversation_id: 'a-late', title: 'LATE_A' }] }); await flush();
    expect(h.html()).toContain('<h1>SPACE_B</h1>');
    expect(h.html()).toContain('TASK_b');
    expect(h.html()).not.toContain('LATE_A');
  });

  it('rejects an old A artifact response after A -> B -> A (not only different IDs)', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred();
    h.answers.set('spaces.artifacts.list:a', response.promise); await h.open('a');
    await h.open('b'); h.answers.set('spaces.artifacts.list:a', { artifacts: [] }); await h.open('a');
    await h.click('space-tab', 'tab', 'artifacts');
    response.resolve({ artifacts: [{ name: 'STALE_A.html', path: '/fixture/STALE_A.html', ext: '.html', time: 1 }] }); await flush();
    expect(h.html()).not.toContain('STALE_A');
    expect(h.invoke.mock.calls.some(([channel, payload]) => channel === 'workspace.statPath' && payload.path === '/fixture/STALE_A.html')).toBe(false);
    expect(h.html()).toMatch(/data-tab="artifacts"[^>]*>\s*产物<span>0<\/span>/);
    expect(h.html()).toContain('<h1>SPACE_A</h1>');
  });

  it('shows an actionable missing-space state without falling back or reading another space', async () => {
    const h = loadWorkspace(); await h.enter(); h.invoke.mockClear(); await h.open('deleted');
    expect(h.html()).toContain('data-ws-space-unavailable');
    expect(h.html()).toContain('ui-empty-state--actionable');
    expect(h.html()).toContain('ws-recovery-page');
    expect(h.html()).not.toContain('<h1>SPACE_A</h1>');
    expect(h.invoke.mock.calls.some(([channel]) => channel === 'spaces.conversations.list')).toBe(false);
    await h.click('back-to-center'); expect(h.html()).toContain('ws-center-header');
  });

  it('retains the last safe center on refresh failure and offers a working local retry', async () => {
    const h = loadWorkspace(); await h.enter(); h.answers.set('spaces.list:', { error: 'OFFLINE' }); await h.enter();
    expect(h.html()).toContain('SPACE_A'); expect(h.html()).toContain('data-ws="retry-load"');
    h.answers.delete('spaces.list:'); await h.click('retry-load'); await flush();
    expect(h.html()).toContain('SPACE_A'); expect(h.html()).not.toContain('data-ws="retry-load"');
  });

  it('keeps failed detail reads retryable instead of caching them as an empty successful result', async () => {
    const h = loadWorkspace(); await h.enter(); h.answers.set('spaces.conversations.list:a', { error: 'OFFLINE' }); await h.open('a');
    expect(h.html()).toContain('data-ws="retry-detail"');
    expect(h.html()).toContain('ui-empty-state--actionable');
    h.answers.delete('spaces.conversations.list:a'); await h.click('retry-detail');
    expect(h.html()).toContain('TASK_a'); expect(h.html()).not.toContain('data-ws="retry-detail"');
  });

  it('does not repaint hidden workspace DOM after navigating away during a request', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred(); h.answers.set('spaces.conversations.list:a', response.promise);
    await h.open('a'); h.context.setView('new-chat'); h.writes.length = 0;
    response.resolve({ conversations: [{ conversation_id: 'late', title: 'LATE' }] }); await flush();
    expect(h.writes).toHaveLength(0);
    const enter = h.enter(); expect(h.html()).toContain('ws-center-header'); await enter;
    expect(h.html()).not.toContain('<h1>SPACE_A</h1>');
  });

  it('does not reset the current detail when the active sidebar entry is clicked again', async () => {
    const h = loadWorkspace(); await h.enter(); await h.open('b');
    await h.enter(); expect(h.html()).toContain('<h1>SPACE_B</h1>'); expect(h.html()).toContain('TASK_b');
  });

  it('rejects old A task and asset results after A -> B -> A', async () => {
    const h = loadWorkspace(); await h.enter(); const tasks = deferred(); const assets = deferred();
    h.answers.set('spaces.conversations.list:a', tasks.promise);
    h.answers.set('recall.assets.listForSpace:a', assets.promise);
    await h.open('a'); await h.open('b');
    h.answers.delete('spaces.conversations.list:a'); h.answers.set('recall.assets.listForSpace:a', { assets: [] });
    await h.open('a');
    tasks.resolve({ conversations: [{ conversation_id: 'old-a', title: 'OLD_A_TASK' }] });
    assets.resolve({ assets: [{ id: 'old-asset', title: 'OLD_A_ASSET', status: 'active' }] }); await flush();
    expect(h.html()).toContain('TASK_a'); expect(h.html()).not.toContain('OLD_A_TASK');
    expect(h.html()).toMatch(/data-tab="assets"[^>]*>\s*资产<span>0<\/span>/);
  });

  it('clears in-flight detail ownership when a refreshed catalog reports the space deleted', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred();
    h.answers.set('spaces.conversations.list:a', response.promise); await h.open('a');
    h.answers.set('spaces.list:', { spaces: [{ space_id: 'b', name: 'SPACE_B' }] }); await h.enter();
    expect(h.html()).toContain('data-ws-space-unavailable');
    expect(h.root.attributes['aria-busy']).toBe('false');
    response.resolve({ conversations: [{ conversation_id: 'gone', title: 'DELETED_SPACE_TASK' }] }); await flush();
    expect(h.html()).not.toContain('DELETED_SPACE_TASK'); expect(h.html()).not.toContain('<h1>SPACE_B</h1>');
  });

  it('does not let an older catalog response overwrite a newer language refresh', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred();
    h.answers.set('spaces.list:', response.promise); const old = h.enter();
    h.answers.set('spaces.list:', { spaces: [{ space_id: 'b', name: 'NEW_SPACE_B' }] });
    h.events.get('i18n-change')?.(); await flush();
    response.resolve({ spaces: [{ space_id: 'a', name: 'OLD_SPACE_A' }] }); await old; await flush();
    expect(h.html()).toContain('NEW_SPACE_B'); expect(h.html()).not.toContain('OLD_SPACE_A');
  });

  it('invalidates a cached card opened during a catalog refresh without returning to its old navigation', async () => {
    const h = loadWorkspace(); await h.enter(); const response = deferred();
    h.answers.set('spaces.list:', response.promise); const refresh = h.enter();
    await h.click('open-space', 'space', 'a'); expect(h.html()).toContain('TASK_a');
    response.resolve({ spaces: [{ space_id: 'b', name: 'SPACE_B' }] }); await refresh; await flush();
    expect(h.html()).toContain('data-ws-space-unavailable');
    expect(h.html()).not.toContain('TASK_a'); expect(h.html()).not.toContain('<h1>SPACE_B</h1>');
    expect(h.root.attributes['aria-busy']).toBe('false');
  });

  it('retains existing DOM when identical data returns, even after browser markup normalization', async () => {
    const h = loadWorkspace(); await h.enter(); await flush();
    // Browser innerHTML serialization is not identical to the renderer's
    // source string (e.g. attribute quoting and entity normalization).
    h.root.innerHTML = h.root.innerHTML.replace('data-ws="center-search"', "data-ws='center-search'");
    h.writes.length = 0; h.events.get('i18n-change')?.(); await flush();
    expect(h.writes).toHaveLength(0); expect(h.html()).toContain('SPACE_A');
  });

  it('keeps same-space safe content visible on a failed detail refresh', async () => {
    const h = loadWorkspace(); await h.enter(); await h.open('a');
    h.answers.set('spaces.conversations.list:a', { error: 'OFFLINE' });
    await h.click('space-tab', 'tab', 'assets');
    await h.click('space-tab', 'tab', 'tasks');
    expect(h.html()).toContain('TASK_a'); expect(h.html()).toContain('data-ws="retry-detail"');
  });

  it('does not navigate when task creation completes after the user leaves its space', async () => {
    const h = loadWorkspace(); await h.enter(); await h.open('a'); const response = deferred();
    h.answers.set('conversations.create:a', response.promise); await h.click('new-task');
    h.context.setView('new-chat'); h.context.setView.mockClear();
    response.resolve({ conversation: { conversation_id: 'created-task', space_id: 'a' } }); await flush();
    expect(h.context.setView).not.toHaveBeenCalled();
  });

  it('opens the exact new conversation without waiting for detail refresh IPC', async () => {
    const h = loadWorkspace(); await h.enter(); await h.open('a');
    h.answers.set('conversations.create:a', { conversation: { conversation_id: 'created-task', space_id: 'a' } });
    h.answers.set('spaces.conversations.list:a', new Promise(() => {}));
    await h.click('new-task');
    expect(h.context.setView).toHaveBeenLastCalledWith('conversation', 'created-task', { skipLoad: true });
  });

  it('does not open a pending create dialog on another page after a slow entry load', async () => {
    const h = loadWorkspace(); const response = deferred(); h.answers.set('spaces.list:', response.promise);
    const create = h.context.window.openWorkspaceCreate(); h.context.setView('new-chat'); h.writes.length = 0;
    response.resolve({ spaces: [] }); await create; await flush();
    expect(h.writes).toHaveLength(0);
  });

  it('shows a real retry state on first-load failure and recovers without a fallback space', async () => {
    const h = loadWorkspace(); h.answers.set('spaces.list:', { error: 'OFFLINE' }); await h.enter();
    expect(h.html()).toContain('ui-empty-state--actionable'); expect(h.html()).toContain('data-ws="retry-load"');
    h.answers.delete('spaces.list:'); await h.click('retry-load'); await flush();
    expect(h.html()).toContain('ws-center-header'); expect(h.html()).not.toContain('data-ws="retry-load"');
  });

  it('ignores a late lazy-module create poll after the user navigated elsewhere', async () => {
    const h = loadWorkspace(); h.context.currentView = 'new-chat';
    await h.context.window.openWorkspaceCreate();
    expect(h.writes).toHaveLength(0); expect(h.invoke).not.toHaveBeenCalled();
  });

  it('prepares the workspace destination before boot exposes the panel and normalizes the spaces alias', () => {
    const boot = read('src/renderer/modules/boot.js');
    const route = boot.slice(boot.indexOf('function setView('));
    expect(route).toContain("if (view === 'spaces') view = 'workspace';");
    expect(route.indexOf('window.prepareWorkspaceView()')).toBeLessThan(route.indexOf("classList.add('active')"));
    expect(route).toContain('window.leaveWorkspace()');
    expect(route).toContain('window.__cogseedPendingOpenSpace = null;');
    const warmupStart = boot.indexOf('const _warmWorkspaceFeature');
    const warmup = boot.slice(warmupStart, boot.indexOf('// First-run walkthrough', warmupStart));
    expect(warmup).toContain('window.warmWorkspace()');
    expect(warmup).not.toContain('window.renderWorkspace()');
  });

  it('keeps recovery actions inside the page and preserves the production shared button styles', () => {
    const css = read('src/renderer/workspace.css');
    expect(css).toMatch(/\.ws-recovery-page\s*{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*box-sizing:\s*border-box;/);
    expect(css).toContain('.ws-view button:not(.ui-button):not(.ui-icon-button)');
    expect(css).not.toMatch(/\.ws-view button\s*{/);
    expect(css).toMatch(/@media \(max-width: 560px\)\s*{\s*\.ws-dialog-foot\s*{[^}]*flex-direction: column;/);
    expect(read('src/renderer/style.css')).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?body:has\(:is\(#panel-run-center, #panel-workspace\)\.active\) \.sidebar\s*{[^}]*width:\s*48px !important;/);
  });
});
