import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function pageHarness(extraRecords: Record<string, any> = {}, customSearchResults?: Array<Record<string, unknown>>, candidateFixture?: Record<string, any>, options: { holdSnapshot?: boolean } = {}) {
  let releaseSnapshot: (() => void) | null = null;
  const snapshotGate = options.holdSnapshot ? new Promise<void>(resolve => { releaseSnapshot = resolve; }) : null;
  const file = path.join(__dirname, '../../src/renderer/modules/cognition-ontology.js');
  const source = fs.readFileSync(file, 'utf8');
  const calls: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const graphMounts: Array<{
    moduleId: string;
    records: Record<string, unknown>;
    initialSelection: any;
    onSelect: Function;
    onInspectorClose?: Function;
    onOpenModuleGraph?: Function;
  }> = [];
  const graphUpdates: Array<{ doc: any; moduleId: string }> = [];
  const buttonCalls: Array<Record<string, any>> = [];
  const toasts: Array<{ message: string; options?: Record<string, unknown> }> = [];
  let failNextGraph = false;
  let exportResponse: Record<string, unknown> = { ok: true, canceled: false, filePath: '/tmp/cogseed-ontology-export.json', bytes: 256 };
  let confirmResult = true;
  let candidate = candidateFixture ? structuredClone(candidateFixture) : null;
  let modalClick: Function | null = null;
  let nextFormValues: Record<string, string> = {};
  const module = { id: 'project-module', kind: 'module', version: 1, status: 'active', access: 'task', createdAt: null, updatedAt: null,
    source: { kind: 'user', label: '用户确认' }, name: 'CogSeed项目', description: '项目事实', scope: { kind: 'project', id: 'p-1' } };
  const doc = { schemaVersion: 1, ownerId: 'test-user', revision: 0, records: { [module.id]: module, ...extraRecords }, history: [], receipts: {} };
  const container: any = { isConnected: true, listeners: new Map<string, Function[]>(), tabGroups: [], _html: '',
    addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); },
    removeEventListener() {},
    querySelectorAll(selector: string) {
      if (selector !== '[data-ui-tabs]') return [];
      return this.tabGroups;
    },
    querySelector(selector: string) {
      if (selector === '[data-ontology-graph-mount]' && this._html.includes('data-ontology-graph-mount')) {
        const moduleId = this._html.match(/data-ontology-graph-mount data-module-id="([^"]*)"/)?.[1] || '';
        return { dataset: { moduleId } };
      }
      return null;
    },
    set innerHTML(value: string) {
      this._html = value;
      this.tabGroups = [...value.matchAll(/<div class="ui-tabs[^>]*data-ontology-tabs="([^"]+)"[^>]*>/g)].map((match: RegExpMatchArray) => {
        const handlers: Function[] = [];
        return { dataset: { ontologyTabs: match[1] }, addEventListener(_type: string, fn: Function) { handlers.push(fn); },
          fire(value: string) { handlers.forEach(fn => fn({ detail: { value } })); } };
      });
    },
    get innerHTML() { return this._html; },
  };
  const root: any = {
    listeners: new Map<string, Function[]>(),
    addEventListener(type: string, fn: Function) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); },
    removeEventListener(type: string, fn: Function) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); },
    dispatchEvent(event: { type: string }) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); return true; },
    t(key: string) { return key; },
    uiToast(message: string, options?: Record<string, unknown>) { toasts.push({ message, options }); },
    cogseed: { async invoke(channel: string, payload: Record<string, unknown> = {}) {
      calls.push({ channel, payload });
      if (channel === 'cognition.ontology.snapshot') {
        if (!snapshotGate) return { ok: true, ontology: doc };
        return snapshotGate.then(() => ({ ok: true, ontology: doc }));
      }
      if (channel === 'cognition.ontology.document.edit') {
        const record = (doc.records as Record<string, any>)[String(payload.recordId)];
        if (payload.expectedRevision !== doc.revision || payload.expectedVersion !== record.version) return { ok: false, error: 'baseline_changed', code: 'baseline_changed' };
        const changes = payload.changes as Record<string, unknown>;
        const saved = { ...record, ...changes, version: record.version + 1 };
        (doc.records as Record<string, any>)[record.id] = saved;
        doc.revision++;
        (doc.history as any[]).push({ commandId: payload.commandId, after: saved });
        return { ok: true, recordId: record.id, receipt: { commandId: payload.commandId, revision: doc.revision, changedIds: [record.id] }, ontology: structuredClone(doc) };
      }
      if (channel === 'recall.candidates.list') return { ok: true, candidates: [
        { capabilities: { countsAsPending: true } }, { capabilities: { countsAsPending: true, isSnoozed: true } },
        { capabilities: { countsAsPending: false } },
      ] };
      if (channel === 'personalOntology.candidates.list') return { ok: true, candidate_updates: [] };
      if (channel === 'cognition.ontology.export') return { ...exportResponse };
      if (channel === 'cognition.ontology.history.archive') return { ok: true, archivedHistory: 2, archivedReceipts: 1, archivePath: '/tmp/ontology.archive.jsonl' };
      if (channel === 'cognition.ontology.graph.query') {
        if (failNextGraph) { failNextGraph = false; return { ok: false, error: 'temporary graph failure' }; }
        const focusId = String(payload.focusId || '');
        const nodeId = focusId || String(payload.moduleId || module.id);
        return { ok: true, graph: { scale: payload.moduleId ? 'module' : 'modules', nodes: [{ id: nodeId, kind: focusId ? 'entity' : 'module', label: focusId ? '图谱聚焦对象' : module.name, status: 'active' }],
          edges: payload.moduleId ? [{ id: 'unknown-fact', from: nodeId, to: nodeId, label: '负责人', kind: 'assertion', truth: 'unknown', recordId: 'project-fact' }] : [],
          totalNodes: payload.moduleId ? 240 : 1, totalEdges: payload.moduleId ? 600 : 0, truncated: Boolean(payload.moduleId),
          ...(focusId ? { focusId, focusNodeId: focusId } : {}) } };
      }
      if (channel === 'cognition.ontology.search') return { ok: true, results: customSearchResults || [{ id: 'focus-person', kind: 'entity', name: '示例负责人乙', moduleId: 'project-module' }] };
      if (channel === 'cognition.ontology.module.lifecycle') return { ok: true, receipt: { changedIds: [payload.moduleId] } };
      if (channel === 'cognition.ontology.command.preview') return { ok: true, changes: [] };
      if (channel === 'cognition.ontology.history.get') return { ok: true, history: [] };
      if (channel === 'recall.candidates.save') return { ok: true, candidate: { id: 'candidate-1' } };
      if (channel === 'recall.candidates.read') return candidate ? { ok: true, candidate: structuredClone(candidate) } : { ok: false, error: 'candidate unavailable' };
      throw new Error(`unexpected channel ${channel}`);
    } },
    uiButton(options: any) {
      buttonCalls.push(options);
      const { label, attrs = {}, role = 'secondary', className = '', icon = '' } = options;
      const iconMarkup = icon ? `<svg class="ui-button__icon is-${icon}"></svg>` : '';
      return `<button class="ui-button ui-button--${role} ${className}" ${Object.entries(attrs).map(([k,v]) => `${k}="${v}"`).join(' ')}>${iconMarkup}<span>${label}</span></button>`;
    },
    uiIconHtml(name: string, className: string) { return `<svg class="${className} is-${name}"></svg>`; },
    uiIconButton() { return '<button aria-label="close">x</button>'; },
    uiInput() { return '<input />'; }, uiField({ id, control }: any) {
      const attrs = Object.entries(control?.attrs || {}).map(([key, value]) => `${key}="${String(value)}"`).join(' ');
      if (control?.kind === 'input') return `<input id="${id}" value="${control.value || ''}" ${attrs} />`;
      if (control?.kind === 'textarea') return `<textarea id="${id}" ${attrs}>${control.value || ''}</textarea>`;
      if (control?.kind === 'select') return `<div id="${id}" data-ui-select data-ui-select-config='${JSON.stringify({ value: control.value || '' })}'></div>`;
      return '<div class="ui-field"></div>';
    }, uiTextarea() { return '<textarea></textarea>'; }, uiSelect(options: any) {
      if (options?.native === true) {
        const attrs = Object.entries(options.attrs || {}).map(([key, value]) => `${key}="${String(value)}"`).join(' ');
        return `<select id="${options.id}" class="ui-native-select ${options.className || ''}" aria-label="${options.ariaLabel}" ${attrs}>${(options.options || []).map((option: any) => `<option value="${option.value}"${option.value === options.value ? ' selected' : ''}>${option.label}</option>`).join('')}</select>`;
      }
      return '<div></div>';
    },
    async uiConfirm() { return confirmResult; },
    uiModal({ bodyHtml }: any) {
      const controls = [...bodyHtml.matchAll(/data-ontology-field="([^"]+)"/g)].map(match => ({ dataset: { ontologyField: match[1] }, value: nextFormValues[match[1]] || '' }));
      const selects = [...bodyHtml.matchAll(/<div id="([^"]+)" data-ui-select data-ui-select-config='([^']*)'/g)].map(match => ({ id: match[1], dataset: { uiSelectConfig: match[2] } }));
      bodySelects.push(...selects.map(select => ({ id: select.id, value: JSON.parse(select.dataset.uiSelectConfig).value || '' })));
      const error = { hidden: true, textContent: '' };
      const form: any = { dataset: {}, querySelectorAll(selector: string) { return selector === '[data-ontology-field]' ? controls : selector === '[data-ui-select]' ? selects : []; },
        querySelector(selector: string) {
          if (selector === '.ontology-ws-form-error') return error;
          const match = selector.match(/\[data-ontology-field="([^"]+)"\]/);
          return match ? controls.find(control => control.dataset.ontologyField === match[1]) || null : null;
        } };
      const overlay: any = { querySelector() { return form; }, addEventListener(_type: string, fn: Function) { modalClick = fn; } };
      const promise: any = Promise.resolve();
      promise.overlay = overlay; promise.close = () => { modalClick = null; };
      return promise;
    },
    hydrateUiFormSelects(_form: unknown, callbacks: Record<string, (value: string) => void>) {
      for (const select of [...bodySelects]) callbacks[select.id]?.(select.value);
    },
    uiSegmentedControl({ items, ariaLabel }: any) { return `<div role="group" aria-label="${ariaLabel}">${items.map((item: any) => `<button type="button" data-ontology-action="${item.attrs['data-ontology-action']}" data-layout="${item.attrs['data-layout']}" aria-pressed="${item.value === 'radial'}">${item.label}</button>`).join('')}</div>`; },
    uiTabs({ items, attrs = {} }: any) { return `<div class="ui-tabs" data-ui-tabs ${Object.entries(attrs).map(([k,v]) => `${k}="${v}"`).join(' ')}>${items.map((item: any) => `<button data-ui-tab="${item.value}">${item.label}</button>`).join('')}</div>`; },
    hydrateUiTabs() {},
  };
  root.CogOntologyGraph = { mount(_mount: unknown, options: any) {
    graphMounts.push({
      moduleId: options.moduleId,
      records: options.doc.records,
      initialSelection: options.initialSelection,
      onSelect: options.onSelect,
      onInspectorClose: options.onInspectorClose,
      onOpenModuleGraph: options.onOpenModuleGraph,
    });
    return { update(options: any) { graphUpdates.push({ doc: options.doc, moduleId: options.moduleId }); }, destroy() {} };
  } };
  const bodySelects: Array<{ id: string; value: string }> = [];
  root.hydrateUiFormSelects = (_form: unknown, callbacks: Record<string, (value: string) => void>) => {
    for (const select of bodySelects) callbacks[select.id]?.(select.value);
    bodySelects.length = 0;
  };
  const context: any = { window: root, document: {}, console, Date, Intl, Map, Set, String, Number, Math, JSON, setTimeout, clearTimeout };
  for (const name of ['ui-card.js', 'cognition-ontology-document.js', 'cognition-ontology-editor.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', name), 'utf8'), context, { filename: name });
  }
  vm.runInNewContext(source, context, { filename: file });
  return { context, container, calls, graphMounts, graphUpdates, buttonCalls, toasts, module, doc, failNextGraph() { failNextGraph = true; }, setFormValues(values: Record<string, string>) { nextFormValues = values; },
    setConfirmResult(value: boolean) { confirmResult = value; },
    releaseSnapshot() { releaseSnapshot?.(); },
    dispatchWindowEvent(type: string) { root.dispatchEvent({ type }); },
    async saveDialog() {
      const saveControl: any = { disabled: false, dataset: { ontologyAction: 'dialog-save' } };
      if (!modalClick) throw new Error('no dialog is open');
      await modalClick({ target: { closest: () => saveControl }, preventDefault() {} });
    },
    async clickDialog(action: string) {
      const control: any = { disabled: false, dataset: { ontologyAction: action } };
      if (!modalClick) throw new Error('no dialog is open');
      await modalClick({ target: { closest: () => control }, preventDefault() {} });
    } };
}

function click(container: any, action: string, recordId = '', extra: Record<string, string> = {}) {
  const listeners = container.listeners.get('click') || [];
  const target = { dataset: { ontologyAction: action, recordId, ...extra }, closest(selector: string) {
    if (selector === '[data-ontology-node]') return null;
    return selector === '[data-ontology-action]' ? this : null;
  } };
  listeners.forEach((listener: Function) => listener({ target, preventDefault() {} }));
}
function clickCard(container: any, id: string) {
  const listeners = container.listeners.get('click') || [];
  const target: any = { dataset: { cardModule: id, recordId: id }, detail: 1, button: 0, defaultPrevented: false,
    closest(selector: string) {
      if (selector === '[data-card-module]') return this;
      if (selector === 'button,a,input,select,textarea,summary') return null;
      return null;
    } };
  listeners.forEach((listener: Function) => listener({ target, preventDefault() {}, detail: 1, button: 0 }));
}
function input(container: any, field: string, value: string) {
  const listeners = container.listeners.get('input') || [];
  const target = { value, closest(selector: string) { return selector === `[data-ontology-field="${field}"]` ? this : null; } };
  listeners.forEach((listener: Function) => listener({ target }));
}
function clickEdge(container: any, edgeId: string) {
  const listeners = container.listeners.get('click') || [];
  const target = { closest(selector: string) { return selector === '[data-ontology-edge]' ? { dataset: { ontologyEdge: edgeId } } : null; } };
  listeners.forEach((listener: Function) => listener({ target, preventDefault() {} }));
}

describe('本体工作台页面层级与接线', () => {
  it('原地切换各类详情，保留正文节点并保持点击位置和无滚动的焦点恢复', async () => {
    const base = { moduleId: 'project-module', version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '来源' }, createdAt: null, updatedAt: null };
    const records: Record<string, any> = {
      type: { ...base, id: 'type', kind: 'definition', name: '人物', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many' },
      relation: { ...base, id: 'relation', kind: 'definition', name: '协作', definitionKind: 'relation', subjectTypes: ['type'], objectTypes: ['type'], valueType: 'entity', cardinality: 'many' },
      rule: { ...base, id: 'rule', kind: 'rule', name: '规则', requirement: '需要核对', strength: 'required', effect: { kind: 'note' } },
      person: { ...base, id: 'person', kind: 'entity', name: '甲', typeId: 'type', description: '说明', aliases: [], identityStatus: 'confirmed' },
      fact: { ...base, id: 'fact', kind: 'assertion', subjectId: 'person', definitionId: 'relation', object: { kind: 'entity', id: 'person' }, validity: { from: null, until: null, precision: 'day', timezone: 'UTC' } },
    };
    const f = pageHarness(records);
    await f.context.window.mountCognitionOntology(f.container, { moduleId: 'project-module' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const originalHTML = f.container.innerHTML;
    const scrollCalls: any[] = [];
    const scroll = { scrollTop: 1000, scrollLeft: 12, scrollTo(options: any) { scrollCalls.push(options); this.scrollTop = options.top; } };
    const panels = Object.keys(records).map(id => {
      const cell = { innerHTML: '' };
      return { dataset: { ontologyPanel: id }, tagName: ['person', 'fact'].includes(id) ? 'DIV' : 'TR', hidden: true, innerHTML: '', querySelector: () => cell, cell };
    });
    const focusCalls: any[] = [];
    const controls = panels.map((panel, index) => ({
      dataset: { ontologyAction: 'document-disclosure', recordId: panel.dataset.ontologyPanel }, isConnected: true, expanded: 'false',
      classList: { contains: (name: string) => name === 'ont-record-disclosure' },
      setAttribute(_name: string, value: string) { this.expanded = value; },
      getBoundingClientRect: () => ({ top: 200 + index * 40 + panels.slice(0, index).filter(node => !node.hidden).length * 120 - scroll.scrollTop }),
      closest(selector: string) { return selector === '[data-ontology-action]' ? this : null; },
      focus(options: any) { focusCalls.push(options); },
    }));
    f.container.querySelectorAll = (selector: string) => selector === '[data-ontology-panel]' ? panels : selector === '[data-ontology-action="document-disclosure"]' ? controls : [];
    f.container.querySelector = (selector: string) => selector === '[data-ontology-scroll]' ? scroll : null;
    const dispatch = (target: any) => (f.container.listeners.get('click') || []).forEach((listener: Function) => listener({ target, preventDefault() {} }));
    for (const [index, control] of controls.entries()) {
      const top = control.getBoundingClientRect().top;
      dispatch(control);
      expect(control.getBoundingClientRect().top).toBe(top);
      expect(control.expanded).toBe('true');
      expect(panels.filter(panel => !panel.hidden)).toEqual([panels[index]]);
      const body = panels[index].tagName === 'TR' ? panels[index].cell : panels[index];
      expect(body.innerHTML).toContain('ont-inspector');
      expect(f.container.innerHTML).toBe(originalHTML);
    }
    const close = { dataset: controls.at(-1)!.dataset, closest(selector: string) { return selector === '[data-ontology-action]' ? this : selector === '[data-ontology-panel]' ? panels.at(-1) : null; } };
    dispatch(close);
    expect(panels.every(panel => panel.hidden)).toBe(true);
    expect(focusCalls).toEqual([{ preventScroll: true }]);
    expect(scrollCalls.every(call => call.behavior === 'instant' && call.left === 12)).toBe(true);
    expect(f.calls.some(call => call.channel === 'cognition.ontology.document.edit')).toBe(false);
  });

  it('文档重绘恢复滚动时绕过平滑动画', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    await new Promise(resolve => setTimeout(resolve, 0));
    const scrollCalls: any[] = [];
    const scroll = { scrollTop: 480, scrollLeft: 20, scrollTo(options: any) { scrollCalls.push(options); } };
    f.container.querySelector = (selector: string) => selector === '[data-ontology-scroll]' ? scroll : null;
    click(f.container, 'directory-scope', '', { scope: 'all' });
    expect(scrollCalls).toEqual([{ top: 480, left: 20, behavior: 'instant' }]);
  });

  it('本体页面引用的动态文案在四个语言文件中都能找到', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-ontology.js'), 'utf8');
    const documentSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/cognition-ontology-document.js'), 'utf8');
    const keys = new Set([...source.matchAll(/text\('([^']+)'/g)].map(match => `ontologyWorkspace.${match[1]}`));
    const documentKeys = new Set([...documentSource.matchAll(/t\('([A-Za-z][A-Za-z0-9_]*)'/g)].map(match => `ontologyWorkspace.${match[1]}`));
    for (const key of ['scopeNotePrivate', 'scopeNoteTask']) documentKeys.add(`ontologyWorkspace.${key}`);
    for (const kind of ['module', 'definition', 'entity', 'assertion', 'rule', 'reference', 'value', 'asset', 'candidate', 'legacy']) keys.add(`ontologyWorkspace.${kind}`);
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    const zhTable = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8'));
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/renderer/locales/${locale}.json`), 'utf8'));
      for (const key of keys) expect(table[key], `${locale}.json missing ${key}`).toBeTruthy();
      for (const key of documentKeys) {
        expect(table[key], `${locale}.json missing ${key}`).toBeTruthy();
        expect(placeholders(table[key]), `${locale}.json placeholder mismatch for ${key}`).toEqual(placeholders(zhTable[key]));
      }
      const expectedTitle = ({ zh: '本体', en: 'Ontology', ja: '本体', pt: 'Ontologia' } as const)[locale];
      expect(table['ontologyWorkspace.title'], `${locale}.json has wrong ontology page title`).toBe(expectedTitle);
      expect(table['ontologyWorkspace.viewModuleGraph'], `${locale}.json missing ontologyWorkspace.viewModuleGraph`).toBeTruthy();
    }
  });
  it('列表与全局图谱是同级视图，图谱从当前主档投影', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    expect(f.container.innerHTML).toContain('ont-module-cards');
    expect(f.container.innerHTML).toContain('data-ontology-action="directory-view"');
    click(f.container, 'directory-view', '', { view: 'graph' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.moduleId).toBe('');
    expect(f.graphMounts.at(-1)?.records['project-module']).toBeDefined();
    expect(f.calls.some(call => call.channel === 'cognition.ontology.graph.query')).toBe(false);
    expect(f.container.innerHTML).toContain('data-ontology-graph-mount');
    expect(f.container.innerHTML).toContain('data-ontology-action="directory-view"');
    expect(f.container.innerHTML).not.toContain('ont-module-cards');
  });
  it('关系图中输入搜索会回到卡片搜索结果', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'directory-view', '', { view: 'graph' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-graph-mount');
    input(f.container, 'search', '示例');
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(f.container.innerHTML).toContain('ont-search-results');
    expect(f.container.innerHTML).toContain('搜索结果');
    expect(f.container.innerHTML).not.toContain('data-ontology-graph-mount');
  });
  it('目录移除旧统计区，同时保留共同候选读取', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.some(call => call.channel === 'personalOntology.candidates.list')).toBe(true);
    expect(f.container.innerHTML).not.toContain('ontology-ws-stats');
    expect(f.container.innerHTML).toContain('ont-directory-compact');
  });
  it('v17 目录保留创建和范围筛选，资料形成入口退休，卡片只有一个可键盘访问的入口', async () => {
    const personal = { id: 'personal-module', kind: 'module', version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, name: '个人规则', description: '用途说明。第二句话', scope: { kind: 'personal' } };
    const f = pageHarness({ [personal.id]: personal });
    await f.context.window.mountCognitionOntology(f.container);
    expect(f.container.innerHTML).toContain('ont-directory-compact');
    expect(f.container.innerHTML).not.toContain('ont-library-title');
    expect(f.container.innerHTML).not.toContain('ont-library-subtitle');
    expect(f.container.innerHTML).toContain('ont-library-toolbar');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="import"');
    expect(f.container.innerHTML).toContain('data-ontology-action="create-module"');
    expect(f.container.innerHTML).toContain('role="link" tabindex="0" data-card-module="personal-module"');
    expect(f.container.innerHTML).toContain('个人规则');
    expect(f.container.innerHTML).not.toContain('第二句话');
    expect(f.container.innerHTML).not.toContain('p-1');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="module-menu"');
    click(f.container, 'directory-scope', '', { scope: 'personal' });
    expect(f.container.innerHTML).toContain('data-card-module="personal-module"');
    expect(f.container.innerHTML).not.toContain('data-card-module="project-module"');
    click(f.container, 'directory-scope', '', { scope: 'all' });
    expect(f.container.innerHTML).toContain('data-card-module="project-module"');
  });
  it('owner_only 卡片显示仅自己，普通卡片不显示', async () => {
    const privateModule = { id: 'private-module', kind: 'module', version: 1, status: 'active', access: 'owner_only', createdAt: null, updatedAt: null,
      source: { kind: 'user', label: '用户确认' }, name: '私人规则', description: '只给自己用的规则。', scope: { kind: 'personal' } };
    const f = pageHarness({ [privateModule.id]: privateModule });
    await f.context.window.mountCognitionOntology(f.container);
    const html = f.container.innerHTML;
    expect(html.match(/data-card-tag="private"/g) || []).toHaveLength(1);
    expect(html).toContain('仅自己');
    expect(html).toContain('私人规则');
  });
  it('卡片更新时间在标题行，统计行改为四等分指标带', async () => {
    const dated = { id: 'dated-module', kind: 'module', version: 1, status: 'active', access: 'task', createdAt: null, updatedAt: '2026-10-10T09:30:00.000Z',
      source: { kind: 'user', label: '用户确认' }, name: '有更新时间的本体', description: '用途说明。', scope: { kind: 'personal' } };
    const f = pageHarness({ [dated.id]: dated });
    await f.context.window.mountCognitionOntology(f.container);
    const html = f.container.innerHTML;
    expect(html).toContain('ont-card-head');
    expect(html).toContain('ont-card-head-side');
    expect(html).not.toContain('ont-card-arrow');
    expect(html).toContain('datetime="2026-10-10T09:30:00.000Z"');
    expect(html).toMatch(/<div class="ont-card-head"><h3[^>]*>有更新时间的本体<\/h3><div class="ont-card-head-side"><time datetime="2026-10-10T09:30:00.000Z">/);
    const datedCard = html.match(/<article[^>]*data-card-module="dated-module"[\s\S]*?<\/article>/)?.[0] || '';
    expect((datedCard.match(/class="ont-card-stat(?: |")/g) || [])).toHaveLength(4);
    expect(html).not.toContain('ont-card-foot');
  });
  it('打开本体后返回目录只标一个最近打开', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    await new Promise(resolve => setTimeout(resolve, 0));
    clickCard(f.container, 'project-module');
    await new Promise(resolve => setTimeout(resolve, 0));
    click(f.container, 'back-list');
    await new Promise(resolve => setTimeout(resolve, 0));
    const html = f.container.innerHTML;
    expect(html.match(/data-card-tag="recent"/g) || []).toHaveLength(1);
    expect(html).toContain('最近打开');
  });
  it('目录默认卡片、唯一创建卡、范围菜单与停用视图', async () => {
    const inactive = { id: 'inactive-module', kind: 'module', version: 1, status: 'paused', access: 'task', createdAt: null, updatedAt: null,
      source: { kind: 'user', label: '用户确认' }, name: '停用本体', description: '停用内容。', scope: { kind: 'personal' } };
    const f = pageHarness({ [inactive.id]: inactive });
    await f.context.window.mountCognitionOntology(f.container);
    const html = f.container.innerHTML;
    const header = html.match(/<header class="ont-library-heading"[\s\S]*?<\/header>/)?.[0] || '';
    expect(html).toContain('ont-module-cards');
    expect(html).not.toContain('data-ontology-graph-mount');
    expect(header).toContain('data-ontology-action="directory-view"');
    expect(header).toContain('id="view-toggle"');
    expect(header).toContain('ont-library-toolbar');
    expect(header).not.toContain('create-module');
    expect(header).not.toContain('ont-overflow');
    const mainStart = header.indexOf('ont-toolbar-main');
    const endStart = header.indexOf('ont-toolbar-end');
    expect(mainStart).toBeGreaterThan(-1);
    expect(endStart).toBeGreaterThan(mainStart);
    const toolbarMain = header.slice(mainStart, endStart);
    const toolbarEnd = header.slice(endStart);
    expect(toolbarMain).toContain('id="view-toggle"');
    expect(toolbarMain).toContain('ont-scope');
    expect(toolbarEnd).toContain('ont-search-line');
    expect(toolbarEnd).toContain('data-ontology-action="refresh-directory"');
    expect(html).not.toContain('ont-library-command');
    expect(html).not.toContain('ont-scope-tabs');
    expect(html).not.toContain('ont-sync');
    expect(html).not.toContain('ont-sort-label');
    expect(html).toContain('ont-scope');
    expect(html.match(/data-ontology-action="create-module"/g) || []).toHaveLength(1);
    expect(html).toContain('ont-create-card');
    expect(html.indexOf('ont-create-card')).toBeGreaterThan(html.indexOf('data-card-module="project-module"'));
    expect(html).toContain('data-ontology-action="archive-history"');
    expect(html).not.toContain('data-card-module="inactive-module"');
    click(f.container, 'toggle-inactive');
    expect(f.container.innerHTML).toContain('data-card-module="inactive-module"');
    expect(f.container.innerHTML).not.toContain('data-card-module="project-module"');
    expect(f.container.innerHTML).toContain('已停用本体');
    click(f.container, 'directory-scope', '', { scope: 'all' });
    expect(f.container.innerHTML).toContain('data-card-module="project-module"');
    expect(f.container.innerHTML).not.toContain('data-card-module="inactive-module"');
  });
  it('候选整理旧路由只读，陈旧完成事件不写候选也不提示成功', async () => {
    const candidate = { id: 'retired-handoff', status: 'pending_review', summary: '保留候选内容', value: '保留来源正文', capabilities: { canEdit: true } };
    const f = pageHarness({}, undefined, candidate);
    await f.context.window.mountCognitionOntology(f.container, { candidateId: candidate.id });
    expect(f.container.innerHTML).toContain('保留来源正文');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="candidate-select-module"');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="candidate-finish"');
    click(f.container, 'candidate-finish');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.some(call => /^cognition\.ontology\.candidate\.(commit|complete)$/.test(call.channel))).toBe(false);
    expect(f.toasts.some(toast => toast.options?.variant === 'success')).toBe(false);
  });
  it('旧导入动作不再打开形成表单或提交Recall建议', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'import');
    expect(f.calls.some(call => call.channel === 'cognition.ontology.import.submit')).toBe(false);
    expect(f.container.innerHTML).not.toContain('data-ontology-action="import"');
  });
  it('从全局图谱进入本体后展示同一主档文档，返回仍是全局图谱', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'directory-view', '', { view: 'graph' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.moduleId).toBe('');
    click(f.container, 'open-module', f.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-module-view="project-module"');
    expect(f.container.innerHTML).toContain('id="ontology-doc-tbox"');
    expect(f.container.innerHTML).toContain('data-ontology-action="back-list"');
    click(f.container, 'back-list');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.moduleId).toBe('');
  });
  it('keeps the graph scope filter when a document update arrives', async () => {
    const personal = { id: 'personal-module', kind: 'module', version: 1, status: 'active', access: 'task',
      createdAt: null, updatedAt: null, source: { kind: 'user', label: '用户确认' },
      name: '个人本体', description: '', scope: { kind: 'personal' } };
    const f = pageHarness({ [personal.id]: personal });
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'directory-scope', '', { scope: 'project' });
    click(f.container, 'directory-view', '', { view: 'graph' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.records['personal-module']).toBeUndefined();

    f.context.window.syncCognitionOntology({
      ...f.doc,
      revision: 1,
      records: { ...f.doc.records, [personal.id]: personal },
    });
    expect(f.graphUpdates.at(-1)?.doc.records['personal-module']).toBeUndefined();
    expect(f.graphUpdates.at(-1)?.doc.records[f.module.id]).toBeDefined();
  });

  it('外层详情卡进入本体内关系图并在返回时恢复选中', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'directory-view', '', { view: 'graph' });
    await new Promise(resolve => setTimeout(resolve, 0));
    let mount = f.graphMounts.at(-1)!;
    expect(mount.moduleId).toBe('');

    mount.onSelect({ recordId: f.module.id, kind: 'module' });
    mount.onSelect({ recordId: 'ref-x', kind: 'reference' });
    f.dispatchWindowEvent('i18n-change');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.initialSelection).toEqual({ kind: 'node', id: f.module.id });

    mount = f.graphMounts.at(-1)!;
    await mount.onOpenModuleGraph!(f.module.id);
    expect(f.container.innerHTML).toContain('data-ontology-module-view="project-module"');
    expect(f.container.innerHTML).toContain('ont-is-graph');
    expect(f.container.innerHTML).toContain('data-ontology-action="back-graph"');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="back-list"');
    expect(f.graphMounts.at(-1)?.moduleId).toBe(f.module.id);
    expect(f.graphMounts.at(-1)?.initialSelection).toBeNull();

    click(f.container, 'back-graph');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('ont-directory-graph');
    expect(f.graphMounts.at(-1)?.moduleId).toBe('');
    expect(f.graphMounts.at(-1)?.initialSelection).toEqual({ kind: 'node', id: f.module.id });

    await f.graphMounts.at(-1)!.onOpenModuleGraph!(f.module.id);
    click(f.container, 'document-view-toggle');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-action="back-list"');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="back-graph"');
    click(f.container, 'back-list');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('ont-module-cards');
    expect(f.container.innerHTML).not.toContain('data-ontology-graph-mount');
  });
  it('关闭外层详情时清掉记住的选中，下一次渲染不再打开', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'directory-view', '', { view: 'graph' });
    await new Promise(resolve => setTimeout(resolve, 0));
    f.graphMounts.at(-1)!.onSelect({ recordId: f.module.id, kind: 'module' });
    f.dispatchWindowEvent('i18n-change');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.initialSelection).toEqual({ kind: 'node', id: f.module.id });

    f.graphMounts.at(-1)!.onInspectorClose?.();
    f.dispatchWindowEvent('i18n-change');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.graphMounts.at(-1)?.initialSelection).toBeNull();
  });
  it('具体本体在单页完整展示 T/R/A，关系图谱切换使用同一份主档', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'open-module', f.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const box of ['tbox', 'rbox', 'abox']) expect(f.container.innerHTML).toContain(`id="ontology-doc-${box}"`);
    expect(f.container.tabGroups.some((group: any) => group.dataset.ontologyTabs === 'module')).toBe(false);
    click(f.container, 'document-view-toggle');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-action="back-graph"');
    expect(f.graphMounts.at(-1)?.moduleId).toBe(f.module.id);
    expect(f.graphMounts.at(-1)?.records).toBeDefined();
    expect(f.calls.some(call => call.channel === 'cognition.ontology.graph.query')).toBe(false);
    click(f.container, 'document-view-toggle');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('id="ontology-doc-abox"');
  });
  it('采用文字建议后保存到主档，切换图谱读取保存后的同一值', async () => {
    const entity = { id: 'person', kind: 'entity', moduleId: 'project-module', typeId: 'type', name: '甲', description: '旧说明', aliases: [], identityStatus: 'confirmed',
      version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    const type = { id: 'type', kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
      version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    const f = pageHarness({ person: entity, type });
    let adopt: any;
    f.context.window.CogOntologySelection = { mount(_container: any, options: any) { adopt = options.save; return { hasDraft: () => false, refresh() {}, destroy() {} }; } };
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'open-module', f.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-edit="description" data-record-id="type"');
    expect(f.calls.some(call => call.channel === 'cognition.ontology.document.edit')).toBe(false);
    await adopt('type', 'description', '新说明');
    click(f.container, 'document-view-toggle');
    await new Promise(resolve => setTimeout(resolve, 0));
    const saved = f.calls.find(call => call.channel === 'cognition.ontology.document.edit');
    expect(saved?.payload).toMatchObject({ recordId: 'type', expectedRevision: 0, expectedVersion: 1, changes: { description: '新说明' } });
    expect(f.graphMounts.at(-1)?.records.type).toMatchObject({ description: '新说明', version: 2 });
    click(f.container, 'document-view-toggle');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('>新说明</span>');
    click(f.container, 'record-details', 'person');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.some(call => call.channel === 'cognition.ontology.history.get')).toBe(true);
    expect(f.container.innerHTML).toContain('ontology-ws-history');
    expect(f.container.innerHTML).toContain('data-ontology-action="merge-identity"');
    expect(f.container.innerHTML).toContain('data-ontology-action="delete-record"');
  });
  it('旧本体保留只读内容且不再提供写入新候选的入口', async () => {
    const legacyModule = { id: 'legacy-module', kind: 'module', version: 1, status: 'active', access: 'task', createdAt: null, updatedAt: null,
      source: { kind: 'legacy', label: '旧图谱', recordId: 'graph-module' }, name: '旧项目本体', description: '', scope: { kind: 'project', id: 'project-1' } };
    const type = { id: 'legacy-person-type', kind: 'definition', moduleId: legacyModule.id, name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
      version: 1, status: 'active', access: 'task', source: { kind: 'legacy', label: '旧分类', recordId: 'person-type' }, createdAt: null, updatedAt: null };
    const entity = { id: 'legacy-person', kind: 'entity', moduleId: legacyModule.id, typeId: type.id, name: '示例负责人乙', description: '负责产品交付', aliases: ['示例乙'], identityStatus: 'confirmed',
      version: 1, status: 'active', access: 'task', source: { kind: 'legacy', label: '旧人物', recordId: 'person-17', refs: [] }, createdAt: null, updatedAt: null };
    const definition = { id: 'legacy-role', kind: 'definition', moduleId: legacyModule.id, name: '角色', description: '', definitionKind: 'attribute', subjectTypes: [type.id], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject',
      version: 1, status: 'active', access: 'task', source: { kind: 'legacy', label: '旧字段', recordId: 'role-field' }, createdAt: null, updatedAt: null };
    const shared = { kind: 'assertion', moduleId: legacyModule.id, subjectId: entity.id, definitionId: definition.id, object: { kind: 'literal', valueType: 'text', value: '项目负责人' }, validity: { from: null, until: null, precision: 'day', timezone: 'UTC' },
      version: 1, status: 'active', access: 'task', source: { kind: 'legacy', label: '旧事实', recordId: 'role-value' }, createdAt: null, updatedAt: null };
    const privateFact = { ...shared, id: 'legacy-private', object: { kind: 'literal', valueType: 'text', value: '私密值不得外送' }, access: 'owner_only', source: { kind: 'legacy', label: '旧私密事实', recordId: 'private-value' } };
    const f = pageHarness({ [legacyModule.id]: legacyModule, [type.id]: type, [entity.id]: entity, [definition.id]: definition,
      'legacy-role-value': { ...shared, id: 'legacy-role-value' }, [privateFact.id]: privateFact });
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'open-module', legacyModule.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('旧来源内容以只读方式展示');
    click(f.container, 'document-disclosure', entity.id);
    expect(f.container.innerHTML).toContain('示例负责人乙');
    expect(f.container.innerHTML).not.toContain('data-ontology-action="legacy-candidate"');
    expect(f.container.innerHTML).toContain('仅自己查看，不提供给任务');
    // Stale renderer events must not call a retired IPC or report success.
    click(f.container, 'legacy-candidate', entity.id);
    click(f.container, 'legacy-candidate', privateFact.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.filter(call => call.channel === 'recall.candidates.save')).toHaveLength(0);
    expect(f.toasts.some(toast => toast.options?.variant === 'success')).toBe(false);
  });
  it('大量本体仍分页，单页文档同时展示全部定义', async () => {
    const extra: Record<string, any> = {};
    for (let index = 0; index < 62; index++) {
      const id = `page-module-${index}`;
      extra[id] = { id, kind: 'module', version: 1, status: 'active', access: 'task', createdAt: null, updatedAt: null,
        source: { kind: 'user', label: '用户确认' }, name: `分页本体 ${index}`, description: '', scope: { kind: 'personal' } };
    }
    for (let index = 0; index < 105; index++) {
      const id = `page-definition-${index}`;
      extra[id] = { id, kind: 'definition', moduleId: 'project-module', name: `定义 ${index}`, description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [],
        valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject', version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    }
    const f = pageHarness(extra);
    await f.context.window.mountCognitionOntology(f.container);
    expect(f.container.innerHTML.match(/data-card-module=/g)).toHaveLength(20);
    click(f.container, 'change-page', '', { pageKind: 'modules', page: '1' });
    expect(f.container.innerHTML.match(/data-card-module=/g)).toHaveLength(20);
    click(f.container, 'open-module', 'project-module');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML.match(/class="ont-scan-rec" data-record-id="page-definition-/g)).toHaveLength(105);
    expect(f.container.innerHTML).toContain('<span class="ont-save-caption" data-document-save role="status" aria-live="polite"></span>');
    expect(f.container.innerHTML).not.toContain('ont-document-contents');
    expect(f.container.innerHTML).toContain('定义 104');
    expect(f.container.innerHTML).not.toContain('data-ontology-tabs="module"');
  });
  it('搜索对象直接定位到同一本体文档中的记录', async () => {
    const entity = { id: 'focus-person', kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '示例负责人乙', description: '交付负责人', aliases: [], identityStatus: 'confirmed',
      version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    const type = { id: 'person-type', kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
      version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    const f = pageHarness({ [entity.id]: entity, [type.id]: type });
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'search-result', entity.id, { moduleId: 'project-module' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-module-view="project-module"');
    expect(f.container.innerHTML).toContain('data-record-id="focus-person"');
    expect(f.container.innerHTML).toContain('交付负责人');
    expect(f.calls.some(call => call.channel === 'cognition.ontology.history.get')).toBe(false);
  });
  it('搜索结果以整宽行展示类型、摘要、所属本体与动作', async () => {
    const entity = { id: 'focus-person', kind: 'entity', moduleId: 'project-module', typeId: 'person-type', name: '示例负责人乙', description: '交付负责人', aliases: [], identityStatus: 'confirmed',
      version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    const type = { id: 'person-type', kind: 'definition', moduleId: 'project-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject',
      version: 1, status: 'active', access: 'task', source: { kind: 'user', label: '用户确认' }, createdAt: null, updatedAt: null };
    const f = pageHarness({ [entity.id]: entity, [type.id]: type });
    await f.context.window.mountCognitionOntology(f.container);
    input(f.container, 'search', 'CogSeed');
    await new Promise(resolve => setTimeout(resolve, 260));
    const html = f.container.innerHTML;
    expect(html).toContain('ont-result-type');
    expect(html).toContain('ont-result-title');
    expect(html).toContain('ont-result-snippet');
    expect(html).toContain('ont-result-source');
    expect(html).toContain('ont-result-action');
    expect(html).not.toContain('ont-result-meta');
    expect(html).not.toContain('ont-result-arrow');
    const moduleRow = html.match(/<article class="ont-search-result"[^>]*data-search-kind="module"[\s\S]*?<\/article>/)?.[0] || '';
    const entityRow = html.match(/<article class="ont-search-result"[^>]*data-search-kind="entity"[\s\S]*?<\/article>/)?.[0] || '';
    expect(moduleRow).toContain('打开本体');
    expect(moduleRow).not.toContain('所属本体');
    expect(moduleRow).not.toContain('ui-resource-card');
    expect(entityRow).toContain('打开记录');
    expect(entityRow).toContain('所属本体 · CogSeed项目');
    expect(entityRow).toContain('交付负责人');
    expect(entityRow).toContain('data-module-id="project-module"');
    expect(entityRow).not.toContain('ui-resource-card');
  });
  it('按日期浏览时正文只读，返回当前后恢复修改入口', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'open-module', f.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    f.setFormValues({ documentAt: '2020-01-01' });
    click(f.container, 'document-date');
    await f.saveDialog();
    expect(f.container.innerHTML).toContain('data-ontology-action="document-current-date"');
    expect(f.container.innerHTML).not.toContain('data-ontology-edit="name"');
    expect(f.calls.some(call => call.channel === 'cognition.ontology.document.edit')).toBe(false);
    click(f.container, 'document-current-date');
    expect(f.container.innerHTML).toContain('data-ontology-edit="name"');
  });
  it('文档工具栏添加内容保留原有创建动作', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    click(f.container, 'open-module', f.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    click(f.container, 'document-add-toggle');
    expect(f.container.innerHTML).toContain('data-ontology-action="create-definition"');
    expect(f.container.innerHTML).toContain('data-ontology-action="create-entity"');
    expect(f.container.innerHTML).toContain('data-ontology-action="create-assertion"');
    expect(f.container.innerHTML).toContain('data-ontology-action="create-rule"');
    expect(f.container.innerHTML).toContain('data-ontology-action="create-reference"');
  });

});

describe('i18n-change 在快照未落地时只重绘加载骨架（语言切换崩溃修复）', () => {
  it('doc 未加载时收到 i18n-change 不走全量 render；落地后再触发则正常重绘', async () => {
    const f = pageHarness({}, undefined, undefined, { holdSnapshot: true });
    const container = f.container;
    // 不 await：mount 已同步渲染骨架，快照仍在途（state.doc === undefined 窗口）
    const mounted = f.context.window.mountCognitionOntology(container);
    f.dispatchWindowEvent('i18n-change');
    // 修复前：此处抛 TypeError（listPage→modules 读 state.doc.records）；修复后只重绘骨架
    expect(container.innerHTML).toContain('ontology-ws-loading');
    expect(container.innerHTML).not.toContain('ontology-ws-stats');
    expect(container.innerHTML).not.toContain('ont-module-cards');
    f.releaseSnapshot();
    await mounted;
    // 数据落地后：i18n-change 走全量 render，模块网格正常回来
    f.dispatchWindowEvent('i18n-change');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(container.innerHTML).toContain('ont-module-cards');
  });
});

describe('本体导出页面接线', () => {
  it('导出收进模块更多菜单，成功后 toast 带路径', async () => {
    const f = pageHarness();
    await f.context.window.mountCognitionOntology(f.container);
    expect(f.container.innerHTML).not.toContain('data-ontology-action="export"');
    // 模块详情页收进更多菜单
    click(f.container, 'open-module', 'project-module');
    await new Promise(resolve => setTimeout(resolve, 0));
    click(f.container, 'document-add-toggle');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.container.innerHTML).toContain('data-ontology-action="export"');
    // 成功导出（模块页 → 带 moduleId）
    click(f.container, 'export');
    await new Promise(resolve => setTimeout(resolve, 0));
    const call = f.calls.find(c => c.channel === 'cognition.ontology.export');
    expect(call).toBeTruthy();
    expect(call?.payload).toEqual({ moduleId: 'project-module' });
    expect(f.toasts.some(t => String(t.message).includes('/tmp/cogseed-ontology-export.json'))).toBe(true);
  });
});

describe('本体历史归档页面接线', () => {
  it('目录菜单归档需确认，提交保留 500/500 并刷新回执', async () => {
    const h = pageHarness();
    await h.context.window.mountCognitionOntology(h.container);
    expect(h.container.innerHTML).toContain('data-ontology-action="archive-history"');
    h.setConfirmResult(false);
    click(h.container, 'archive-history');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.calls.some(c => c.channel === 'cognition.ontology.history.archive')).toBe(false);
    h.setConfirmResult(true);
    click(h.container, 'archive-history');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.calls.find(c => c.channel === 'cognition.ontology.history.archive')?.payload)
      .toEqual({ keepHistory: 500, keepReceipts: 500 });
    expect(h.calls.filter(c => c.channel === 'cognition.ontology.snapshot')).toHaveLength(2);
    expect(h.toasts.some(t => String(t.message).includes('已归档 2 条历史、1 条回执'))).toBe(true);
  });
});

describe('本体卡片操作', () => {
  it('管理动作收进模块更多菜单，删除取消不会写入', async () => {
    const h = pageHarness();
    await h.context.window.mountCognitionOntology(h.container);
    click(h.container, 'open-module', h.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.container.innerHTML).toContain('data-ontology-action="delete-module"');
    expect(h.container.innerHTML).toContain('data-ontology-action="archive-module"');
    h.setConfirmResult(false);
    click(h.container, 'delete-module', h.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.calls.some(c => c.channel === 'cognition.ontology.module.lifecycle')).toBe(false);
  });
  it.each(['archive-module', 'delete-module'])( '%s 提交模块版本和主档版本并刷新', async action => {
    const h = pageHarness();
    await h.context.window.mountCognitionOntology(h.container);
    click(h.container, action, h.module.id);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.calls.find(c => c.channel === 'cognition.ontology.module.lifecycle')?.payload).toMatchObject({
      moduleId: h.module.id, intent: action === 'delete-module' ? 'delete' : 'archive', expectedRevision: 0, expectedVersion: 1,
    });
  });
});
