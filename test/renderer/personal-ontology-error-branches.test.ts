import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

// 回归测试：个人本体渲染层 IPC 失败分支（op_failed 提示，不得伪装成空态/静默）。
// _pocInvoke（personal-ontology.js:225-232）永不抛异常，失败统一返回 {ok:false,error}，
// 因此每个 IPC 调用点必须自带失败分支——这里逐点钉死。

const root = resolve(__dirname, '../..');
const ontology = readFileSync(resolve(root, 'src/renderer/modules/personal-ontology.js'), 'utf8');

// ── fixtures ─────────────────────────────────────────────────────────────

const SNAPSHOT = {
  groups: [
    {
      id: 'g1',
      title: '工作偏好',
      kind: 'user',
      createdAt: '2026-09-01T10:00:00',
      updatedAt: '2026-09-02T10:00:00',
      fields: [{ id: 'f1', name: '常用工具', origin: 'user', valueIds: ['v1'] }],
      values: [
        { id: 'v1', fieldId: 'f1', text: 'ZCode', source: '手动', createdAt: '', updatedAt: '' },
      ],
      entries: [],
    },
  ],
  counts: { groups: 1, facts: 1, rules: 0, entries: 0 },
  deleted: [],
};

function makeInvoke(overrides: Record<string, any> = {}) {
  return vi.fn(async (channel: string, payload: any) => {
    if (channel in overrides) {
      const override = overrides[channel];
      return typeof override === 'function' ? override(channel, payload) : override;
    }
    switch (channel) {
      case 'po.snapshot':
        return SNAPSHOT;
      case 'personalOntology.templates.list':
        return { ok: true, templates: [] };
      case 'recall.assets.list':
        return { ok: true, assets: [] };
      case 'personalOntology.candidates.list':
        return { ok: true, candidate_updates: [{ candidate_id: 'c1', kind: 'rule', summary: '候选A', memory_text: '周五先跑全量测试再合入。' }], blocked_items: [] };
      case 'personalOntology.conflicts.list':
        return { ok: true, conflicts: [] };
      case 'ontology.graph.read':
        return { ok: true, graph: { categories: [], entities: [], relations: [] } };
      default:
        return { ok: true };
    }
  });
}

/** 可点击假元素：属性驱动（data-poc-*），监听器可捕获后手动触发。 */
function clickTarget(attrs: Record<string, string>) {
  const listeners = new Map<string, (...args: any[]) => any>();
  return {
    attrs,
    listeners,
    getAttribute(name: string) { return attrs[name] != null ? String(attrs[name]) : null; },
    addEventListener(event: string, handler: (...args: any[]) => any) { listeners.set(event, handler); },
    closest() { return null; },
  };
}

function makeElement(id: string, options: { qs?: Map<string, any[]>; value?: string } = {}) {
  const qs = options.qs || new Map<string, any[]>();
  return {
    id,
    innerHTML: '',
    style: {},
    scrollTop: 0,
    value: options.value || '',
    querySelector: () => null,
    querySelectorAll: (selector: string) => (qs.get(selector) || []).slice(),
    addEventListener() {},
    classList: {
      _set: new Set<string>(),
      add(cls: string) { this._set.add(cls); },
      remove(cls: string) { this._set.delete(cls); },
      contains(cls: string) { return this._set.has(cls); },
    },
  };
}

function loadPersonalOntology(
  invoke: any,
  options: { navTargets?: any[]; bodyTargets?: Map<string, any[]>; documentElements?: any[]; uiConfirmResult?: boolean } = {},
) {
  const navTargets = options.navTargets || [];
  const bodyTargets = options.bodyTargets || new Map<string, any[]>();
  const elements = new Map([
    ['personal-onto-nav', makeElement('personal-onto-nav', { qs: new Map([['[data-poc-nav]', navTargets]]) })],
    ['personal-onto-main-header', makeElement('personal-onto-main-header')],
    ['personal-onto-main-body', makeElement('personal-onto-main-body', { qs: bodyTargets })],
    ['personal-onto-modal', makeElement('personal-onto-modal')],
    ['personal-onto-modal-body', makeElement('personal-onto-modal-body')],
  ]);
  for (const el of options.documentElements || []) elements.set(el.id, el);
  const uiToast = vi.fn();
  const uiModal = vi.fn(async () => ({ value: 'save' }));
  const uiConfirm = vi.fn(async () => (options.uiConfirmResult == null ? true : options.uiConfirmResult));
  const sandbox: any = {
    console: { log() {}, warn() {}, error() {} },
    CSS: { escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    t: (key: string, vars?: Record<string, unknown>) => {
      const raw = key.startsWith('personalOntology.') ? key.slice('personalOntology.'.length) : key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_m, n: string) => String(vars[n] ?? `{${n}}`));
    },
    uiToast,
    uiModal,
    uiConfirm,
    cogseed: { invoke },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/ui-card.js', 'modules/ui-form.js', 'modules/ui-empty.js', 'modules/ui-status.js']) {
    vm.runInContext(readFileSync(resolve(root, 'src/renderer', file), 'utf8'), sandbox, { filename: file });
  }
  vm.runInContext(ontology, sandbox, { filename: 'personal-ontology.js' });
  return { sandbox, uiToast, uiModal, uiConfirm, elements };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function boot(invoke: any, options: Parameters<typeof loadPersonalOntology>[1] = {}) {
  const loaded = loadPersonalOntology(invoke, options);
  await loaded.sandbox.renderPersonalOntology();
  await settle();
  return loaded;
}

async function click(target: any) {
  const handler = target.listeners.get('click');
  expect(handler).toBeTypeOf('function');
  await handler({ stopPropagation() {} });
  await settle();
}

function hasToast(uiToast: any, message: string, variant: string) {
  return uiToast.mock.calls.some(([msg, opts]: any[]) => msg === message && opts && opts.variant === variant);
}

// ── F-r1-5：po.history.list 失败不得伪装成「还没有历史版本」空态 ──────────

describe('personal ontology v2 renderer › IPC 失败分支', () => {
  it('F-r1-5 历史版本：po.history.list 失败时提示 op_failed，不再误报空态', async () => {
    const invoke = makeInvoke({ 'po.history.list': { ok: false, error: 'db_locked' } });
    const historyBtn = clickTarget({ 'data-poc-group-op': 'history', 'data-poc-gid': 'g1' });
    const loaded = await boot(invoke, { bodyTargets: new Map([['[data-poc-group-op]', [historyBtn]]]) });
    await click(historyBtn);
    expect(invoke.mock.calls.some(([c]: any[]) => c === 'po.history.list')).toBe(true);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(true);
    expect(hasToast(loaded.uiToast, 'po2_history_empty', 'info')).toBe(false);
    expect(loaded.uiModal).not.toHaveBeenCalled();
  });

  it('F-r1-5 历史版本：成功且无历史仍走原空态提示；有历史正常弹窗', async () => {
    const emptyInvoke = makeInvoke({ 'po.history.list': { ok: true, history: [] } });
    const emptyBtn = clickTarget({ 'data-poc-group-op': 'history', 'data-poc-gid': 'g1' });
    const emptyLoaded = await boot(emptyInvoke, { bodyTargets: new Map([['[data-poc-group-op]', [emptyBtn]]]) });
    await click(emptyBtn);
    expect(hasToast(emptyLoaded.uiToast, 'po2_history_empty', 'info')).toBe(true);
    expect(hasToast(emptyLoaded.uiToast, 'op_failed', 'error')).toBe(false);

    const listInvoke = makeInvoke({
      'po.history.list': { ok: true, history: [{ id: 'h1', savedAt: '2026-09-01T00:00:00', bytes: 128, preview: '早期版本' }] },
    });
    const listBtn = clickTarget({ 'data-poc-group-op': 'history', 'data-poc-gid': 'g1' });
    const listLoaded = await boot(listInvoke, { bodyTargets: new Map([['[data-poc-group-op]', [listBtn]]]) });
    await click(listBtn);
    expect(listLoaded.uiModal).toHaveBeenCalledTimes(1);
    expect(String(listLoaded.uiModal.mock.calls[0][0].bodyHtml)).toContain('po2-history-list');
    expect(hasToast(listLoaded.uiToast, 'op_failed', 'error')).toBe(false);
  });

  it('F-r1-6 导出：po.data.export 失败时提示 op_failed，不再弹空文档', async () => {
    const invoke = makeInvoke({ 'po.data.export': { ok: false, error: 'fs_denied' } });
    const exportBtn = clickTarget({ 'data-poc-nav': 'memory-export' });
    const loaded = await boot(invoke, { navTargets: [exportBtn] });
    await click(exportBtn);
    expect(invoke.mock.calls.some(([c]: any[]) => c === 'po.data.export')).toBe(true);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(true);
    expect(loaded.uiModal).not.toHaveBeenCalled();
  });

  it('F-r1-6 导出：成功仍弹全文文档', async () => {
    const invoke = makeInvoke({ 'po.data.export': { ok: true, markdown: '# 个人本体导出\n\n## 工作偏好\n' } });
    const exportBtn = clickTarget({ 'data-poc-nav': 'memory-export' });
    const loaded = await boot(invoke, { navTargets: [exportBtn] });
    await click(exportBtn);
    expect(loaded.uiModal).toHaveBeenCalledTimes(1);
    expect(String(loaded.uiModal.mock.calls[0][0].bodyHtml)).toContain('个人本体导出');
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(false);
  });

  it('F-r1-6 导入预览：失败时提示 op_failed，不再误报「没有解析出可导入的内容」', async () => {
    const invoke = makeInvoke({ 'po.data.importPreview': { ok: false, error: 'parse_failed' } });
    const importBtn = clickTarget({ 'data-poc-nav': 'memory-import' });
    const loaded = await boot(invoke, {
      navTargets: [importBtn],
      documentElements: [makeElement('po2-import-text', { value: '## 工作偏好\n- 周五交周报' })],
    });
    await click(importBtn);
    expect(invoke.mock.calls.some(([c]: any[]) => c === 'po.data.importPreview')).toBe(true);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(true);
    expect(hasToast(loaded.uiToast, 'po2_import_nothing', 'error')).toBe(false);
    expect(loaded.uiModal).toHaveBeenCalledTimes(1); // 只有粘贴弹窗，没有确认弹窗
  });

  it('F-r1-6 导入预览：成功但解析为空仍提示「没有解析出可导入的内容」', async () => {
    const invoke = makeInvoke({ 'po.data.importPreview': { ok: true, items: [] } });
    const importBtn = clickTarget({ 'data-poc-nav': 'memory-import' });
    const loaded = await boot(invoke, {
      navTargets: [importBtn],
      documentElements: [makeElement('po2-import-text', { value: '空空如也' })],
    });
    await click(importBtn);
    expect(hasToast(loaded.uiToast, 'po2_import_nothing', 'error')).toBe(true);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(false);
  });

  it('F-r1-6 导入：预览有内容走确认弹窗，应用成功提示已导入', async () => {
    const invoke = makeInvoke({
      'po.data.importPreview': {
        ok: true,
        items: [{ title: '工作偏好', mergeIntoExisting: false, fields: [{ name: '常用工具', values: [{ value: 'ZCode' }] }], entries: ['周五交周报'] }],
      },
      'po.data.importApply': { ok: true, applied: 2 },
    });
    const importBtn = clickTarget({ 'data-poc-nav': 'memory-import' });
    const loaded = await boot(invoke, {
      navTargets: [importBtn],
      documentElements: [makeElement('po2-import-text', { value: '## 工作偏好\n- 周五交周报' })],
    });
    await click(importBtn);
    expect(loaded.uiModal).toHaveBeenCalledTimes(2); // 粘贴弹窗 + 确认弹窗
    expect(String(loaded.uiModal.mock.calls[1][0].bodyHtml)).toContain('po2-import-list');
    expect(hasToast(loaded.uiToast, 'po2_import_done', 'success')).toBe(true);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(false);
  });

  it('F-r1-7 候选冲突：「仍要写入」重试失败时提示 op_failed，不再零反馈', async () => {
    const confirmImpl = vi.fn(async (_channel: string, payload: any) => (
      payload && payload.acknowledgeConflict ? { ok: false, error: 'db_busy' } : { ok: false, error: 'conflict_detected' }
    ));
    const invoke = makeInvoke({ 'po.candidates.confirm': confirmImpl });
    const confirmBtn = clickTarget({ 'data-poc-candidate-op': 'confirm', 'data-poc-candidate-id': 'c1' });
    const loaded = await boot(invoke, {
      bodyTargets: new Map([['[data-poc-candidate-op]', [confirmBtn]]]),
      documentElements: [makeElement('po2-candidate-group', { value: 'g1' })],
    });
    await click(confirmBtn);
    expect(confirmImpl).toHaveBeenCalledTimes(2);
    expect(confirmImpl.mock.calls[1][1].acknowledgeConflict).toBe(true);
    expect(loaded.uiConfirm).toHaveBeenCalledTimes(1);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(true);
    expect(hasToast(loaded.uiToast, 'po2_candidate_accepted', 'success')).toBe(false);
  });

  it('F-r1-7 候选冲突：重试成功仍提示「已收下」', async () => {
    const confirmImpl = vi.fn(async (_channel: string, payload: any) => (
      payload && payload.acknowledgeConflict ? { ok: true } : { ok: false, error: 'conflict_detected' }
    ));
    const invoke = makeInvoke({ 'po.candidates.confirm': confirmImpl });
    const confirmBtn = clickTarget({ 'data-poc-candidate-op': 'confirm', 'data-poc-candidate-id': 'c1' });
    const loaded = await boot(invoke, {
      bodyTargets: new Map([['[data-poc-candidate-op]', [confirmBtn]]]),
      documentElements: [makeElement('po2-candidate-group', { value: 'g1' })],
    });
    await click(confirmBtn);
    expect(hasToast(loaded.uiToast, 'po2_candidate_accepted', 'success')).toBe(true);
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(false);
  });

  it('F-r1-7 候选冲突：确认框点取消不重试、不提示错误（行为不变）', async () => {
    const confirmImpl = vi.fn(async () => ({ ok: false, error: 'conflict_detected' }));
    const invoke = makeInvoke({ 'po.candidates.confirm': confirmImpl });
    const confirmBtn = clickTarget({ 'data-poc-candidate-op': 'confirm', 'data-poc-candidate-id': 'c1' });
    const loaded = await boot(invoke, {
      bodyTargets: new Map([['[data-poc-candidate-op]', [confirmBtn]]]),
      documentElements: [makeElement('po2-candidate-group', { value: 'g1' })],
      uiConfirmResult: false,
    });
    await click(confirmBtn);
    expect(confirmImpl).toHaveBeenCalledTimes(1); // 未带 acknowledgeConflict 重试
    expect(hasToast(loaded.uiToast, 'op_failed', 'error')).toBe(false);
    expect(hasToast(loaded.uiToast, 'po2_candidate_accepted', 'success')).toBe(false);
  });
});
