import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

const root = resolve(__dirname, '../..');
const html = readFileSync(resolve(root, 'src/renderer/index.html'), 'utf8');
const boot = readFileSync(resolve(root, 'src/renderer/modules/boot.js'), 'utf8');
const ontology = readFileSync(resolve(root, 'src/renderer/modules/personal-ontology.js'), 'utf8');
const cognitionCore = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');
const cognitionViews = readFileSync(resolve(root, 'src/renderer/modules/cognition-assets/views.js'), 'utf8');

// ── fixtures ─────────────────────────────────────────────────────────────

const SNAPSHOT = {
  groups: [
    {
      id: 'g1',
      title: '工作偏好',
      kind: 'user',
      createdAt: '2026-09-01T10:00:00',
      updatedAt: '2026-09-02T10:00:00',
      fields: [
        { id: 'f1', name: '常用工具', origin: 'user', valueIds: ['v1'] },
        { id: 'f2', name: '部署规则', isRelation: true, origin: 'user', valueIds: ['v2'] },
      ],
      values: [
        { id: 'v1', fieldId: 'f1', text: 'ZCode', source: '手动', createdAt: '', updatedAt: '' },
        { id: 'v2', fieldId: 'f2', text: '改完 → 跑测试', source: '手动', ruleKind: 'operation', asOf: '2026-09', createdAt: '', updatedAt: '' },
      ],
      entries: [{ id: 'e1', text: '周五交周报', createdAt: '' }],
    },
    {
      id: 'g2',
      title: '学生',
      kind: 'template',
      templateId: 'student',
      templateName: '学生',
      createdAt: '2026-09-01T10:00:00',
      updatedAt: '2026-09-02T10:00:00',
      fields: [{ id: 'f3', name: '教育阶段', section: '学习背景', origin: 'schema', valueIds: ['v3'] }],
      values: [
        { id: 'v3', fieldId: 'f3', text: '大二在读', source: '智能', assetId: 'asset-9', createdAt: '', updatedAt: '' },
      ],
      entries: [],
    },
  ],
  counts: { groups: 2, facts: 1, rules: 1, entries: 1 },
  deleted: [{ groupId: 'g9', title: '旧分组', deletedAt: '2026-09-10T00:00:00', snapshotCount: 2 }],
};

function makeInvoke(overrides: Record<string, any> = {}) {
  return vi.fn(async (channel: string) => {
    if (channel in overrides) return typeof overrides[channel] === 'function' ? overrides[channel](channel) : overrides[channel];
    switch (channel) {
      case 'po.snapshot':
        return SNAPSHOT;
      case 'personalOntology.templates.list':
        return { ok: true, templates: [] };
      case 'recall.assets.list':
        return {
          ok: true,
          assets: [
            { id: 'asset-7', type: 'personal', status: 'active', statement: '用户是 CogSeed 的开发人员', title: '身份' },
            { id: 'asset-8', type: 'rule', status: 'active', statement: '回复长任务 → 先给分段结论', title: '长任务回复' },
          ],
        };
      case 'personalOntology.candidates.list':
        return { ok: true, candidate_updates: [{ candidate_id: 'c1', kind: 'rule', summary: '资产A', memory_text: 'T035 测试资产A：季度复盘先核对检查单。' }], blocked_items: [] };
      case 'personalOntology.conflicts.list':
        return { ok: true, conflicts: [] };
      case 'ontology.graph.read':
        return { ok: true, graph: { categories: [], entities: [], relations: [] } };
      default:
        return { ok: true };
    }
  });
}

function loadPersonalOntology(invoke: any, overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, (...args: any[]) => any>();
  const element = (id: string) => ({
    id,
    innerHTML: '',
    style: {},
    scrollTop: 0,
    value: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    listeners,
    addEventListener(event: string, handler: (...args: any[]) => any) {
      listeners.set(event, handler);
    },
    classList: {
      _set: new Set<string>(),
      add(cls: string) { this._set.add(cls); },
      remove(cls: string) { this._set.delete(cls); },
      contains(cls: string) { return this._set.has(cls); },
    },
  });
  const elements = new Map([
    ['personal-onto-nav', element('personal-onto-nav')],
    ['personal-onto-main-header', element('personal-onto-main-header')],
    ['personal-onto-main-body', element('personal-onto-main-body')],
    ['personal-onto-modal', element('personal-onto-modal')],
    ['personal-onto-modal-body', element('personal-onto-modal-body')],
  ]);
  const uiToast = vi.fn();
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
    cogseed: { invoke },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, overrides);
  vm.createContext(sandbox);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/ui-card.js', 'modules/ui-form.js', 'modules/ui-empty.js', 'modules/ui-status.js']) {
    vm.runInContext(readFileSync(resolve(root, 'src/renderer', file), 'utf8'), sandbox, { filename: file });
  }
  vm.runInContext(ontology, sandbox, { filename: 'personal-ontology.js' });
  return { sandbox, uiToast, elements };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function renderFacts(invoke = makeInvoke(), overrides: Record<string, unknown> = {}) {
  const loaded = loadPersonalOntology(invoke, overrides);
  await loaded.sandbox.renderPersonalOntology();
  await settle();
  return loaded;
}

const body = (loaded: { elements: Map<string, any> }) => loaded.elements.get('personal-onto-main-body').innerHTML;
const nav = (loaded: { elements: Map<string, any> }) => loaded.elements.get('personal-onto-nav').innerHTML;

// ── wiring ───────────────────────────────────────────────────────────────

describe('personal ontology v2 renderer › wiring', () => {
  it('keeps the parking section, modals, and cognition-assets mount contract', () => {
    for (const id of [
      'panel-personal-ontology', 'personal-onto-sidebar',
      'personal-onto-nav', 'personal-onto-main-header', 'personal-onto-main-body',
      'personal-onto-template-library-modal',
    ]) expect(html).toContain(`id="${id}"`);
    expect(boot).toContain("const openPersonalOntology = view === 'personal-ontology'");
    expect(cognitionViews).toContain('data-act="open-ontology"');
    expect(cognitionCore).toContain('renderPersonalOntology');
    expect(boot).toContain("_loadViewFeature('recall', 'recall'");
  });

  it('v2 调 po.snapshot 单次快照，不再逐组拉 fields/read', async () => {
    const invoke = makeInvoke();
    await renderFacts(invoke);
    const snapshotCalls = invoke.mock.calls.filter(([c]: any[]) => c === 'po.snapshot').length;
    expect(snapshotCalls).toBeGreaterThanOrEqual(1);
    expect(invoke.mock.calls.some(([c]: any[]) => c === 'personalOntology.groups.fields.list')).toBe(false);
    expect(invoke.mock.calls.some(([c]: any[]) => c === 'personalOntology.groups.read')).toBe(false);
  });
});

// ── 页面一：事实与条目 ───────────────────────────────────────────────────

describe('personal ontology v2 renderer › facts', () => {
  it('渲染分组/字段/值/流水，值行带时间锚与规则分类 chip', async () => {
    const loaded = await renderFacts();
    const html1 = body(loaded);
    expect(html1).toContain('工作偏好');
    expect(html1).toContain('常用工具');
    expect(html1).toContain('ZCode');
    expect(html1).toContain('改完 → 跑测试');
    expect(html1).toContain('rulekind_operation'); // 规则分类 chip（一等列，不再是行内标记）
    expect(html1).toContain('asof_chip'); // 时间锚 chip
    expect(html1).toContain('周五交周报');
    expect(html1).toContain('po2-menu-item'); // 值行「⋯」菜单（可编辑）
    expect(html1).toContain('data-poc-value-op="edit"');
    expect(html1).toContain('data-poc-value-op="kind:preference"'); // 分类直接设档
  });

  it('模板组以分节表单呈现，资产投影值只读并带来源跳转', async () => {
    const loaded = await renderFacts();
    const html1 = body(loaded);
    expect(html1).toContain('学生');
    expect(html1).toContain('学习背景'); // 分节标题
    expect(html1).toContain('大二在读');
    expect(html1).toContain('data-poc-asset-id="asset-9"');
    // 资产投影行：菜单只有查看来源资产，没有删除/编辑
    const rowStart = html1.indexOf('data-poc-value-id="v3"');
    const rowEnd = html1.indexOf('</div>', html1.indexOf('po2-menu', rowStart));
    const row = html1.slice(rowStart, rowEnd);
    expect(row).toContain('open_source_asset');
    expect(row).not.toContain('data-poc-value-op="delete"');
  });

  it('候选横幅：待确认 + 收下/跳过；收下走 po.candidates.confirm', async () => {
    const invoke = makeInvoke();
    const loaded = await renderFacts(invoke);
    const html1 = body(loaded);
    expect(html1).toContain('po2-candidates');
    expect(html1).toContain('T035 测试资产A');
    expect(html1).toContain('data-poc-candidate-op="confirm"');
    expect(html1).toContain('data-poc-candidate-op="reject"');
    // 侧栏徽标
    expect(nav(loaded)).toContain('backflow_badge');
  });

  it('来自认知资产的画像条目只读呈现并可跳转', async () => {
    const loaded = await renderFacts();
    const html1 = body(loaded);
    expect(html1).toContain('po2_profile_title'); // 分节标题（沙箱 t 返回键名）
    expect(html1).toContain('用户是 CogSeed 的开发人员');
    expect(html1).toContain('data-poc-asset-id="asset-7"');
    expect(html1).toContain('open_source_asset'); // 只读 + 跳转，无编辑入口
  });
});

// ── 页面二：规则 ─────────────────────────────────────────────────────────

describe('personal ontology v2 renderer › rules', () => {
  async function renderRules() {
    const loaded = loadPersonalOntology(makeInvoke());
    await loaded.sandbox.renderPersonalOntology({ box: 'rules' });
    await settle();
    return loaded;
  }

  it('筛选 chips 计数含「未分类」；规则形值（箭头）计入', async () => {
    const loaded = await renderRules();
    const html1 = body(loaded);
    // v2 根治「分类失效」：箭头值即使未分类也进规则页计数
    expect(html1).toContain('data-poc-rule-filter="all"');
    expect(html1).toContain('data-poc-rule-filter="operation"');
    expect(html1).toContain('data-poc-rule-filter="none"');
    expect(html1).toContain('改完 → 跑测试');
    expect(html1).toContain('工作偏好 · 部署规则'); // 归属面包屑
  });

  it('来自认知资产的规则资产单列一节，可跳来源', async () => {
    const loaded = await renderRules();
    const html1 = body(loaded);
    expect(html1).toContain('po2-rule-assets');
    expect(html1).toContain('回复长任务 → 先给分段结论');
    expect(html1).toContain('data-poc-asset-id="asset-8"');
  });
});

// ── 页面三：分组与模板 ───────────────────────────────────────────────────

describe('personal ontology v2 renderer › groups', () => {
  async function renderGroups() {
    const loaded = loadPersonalOntology(makeInvoke());
    await loaded.sandbox.renderPersonalOntology({ box: 'groups' });
    await settle();
    return loaded;
  }

  it('分组卡（字段清单/计数）+ 新建分组 + 已删除分组恢复 + 模板行', async () => {
    const loaded = await renderGroups();
    const html1 = body(loaded);
    expect(html1).toContain('工作偏好');
    expect(html1).toContain('data-poc-group-op="add-field"');
    expect(html1).toContain('data-poc-op="new-group"');
    expect(html1).toContain('po2-deleted'); // 回收站折叠区
    expect(html1).toContain('旧分组');
    expect(html1).toContain('data-poc-deleted-op="restore"');
    expect(html1).toContain('personal-onto-template-library-btn');
  });
});

// ── 兼容：总览与域页继续工作 ─────────────────────────────────────────────

describe('personal ontology v2 renderer › legacy domains compatibility', () => {
  it('总览六卡仍渲染，个人本体计数来自 po.snapshot', async () => {
    const loaded = loadPersonalOntology(makeInvoke());
    await loaded.sandbox.renderPersonalOntology({ view: 'overview' });
    await settle();
    const html1 = body(loaded);
    expect(html1).toContain('personal-onto-overview');
    expect(html1).toContain('nav_personal_domain');
  });

  it('关系网络页把关系字段值列为明确关系（盒数据投影兼容）', async () => {
    const loaded = loadPersonalOntology(makeInvoke());
    await loaded.sandbox.renderPersonalOntology({ view: 'relationships' });
    await settle();
    const html1 = body(loaded);
    // 关系行渲染为 起点/关系名/终点 三段（'A → B' 值不整串出现）
    expect(html1).toContain('跑测试');
    expect(html1).toContain('部署规则');
  });

  it('导航含三页行与待添加徽标；导出导入走 po.data', () => {
    expect(ontology).toContain("row('facts'");
    expect(ontology).toContain("row('rules'");
    expect(ontology).toContain("row('groups'");
    expect(ontology).toContain("'po.data.export'");
    expect(ontology).toContain("'po.data.importApply'");
    // 记忆页退役依赖断开：不再经 window.MemoryTools
    expect(ontology).not.toContain('window.MemoryTools.openExport');
  });
});
