/**
 * 红队探针 r2：个人本体 v2 渲染层的并发刷新竞态（cognition:changed →
 * refreshPersonalOntology 全量重置路径）。
 *
 * 靶点（读码推演）：
 * - 主进程每次 editPoDoc 落盘都广播 ontology-groups 变更（po/store.ts:241
 *   notifyCognitionWrite），渲染层 change rail 的 'ontology' block 在面板
 *   可见时直接调 window.refreshPersonalOntology（cognition-assets/core.js:710-712）；
 * - refreshPersonalOntology（personal-ontology.js:3480-3505）同步清空全部
 *   loaded 标志与 _pocGroupEditor，再全量重拉重渲染；
 * - _pocLoadPoSnapshot（:1181-1189）对 _pocPo 的赋值**无世代/序号守卫**——
 *   两次并发刷新的 po.snapshot 响应乱序时，旧快照可覆盖新快照（stale overwrite）；
 * - 原文/模板编辑器的 textarea 是非受控 DOM（:390 value 只在渲染时设置一次，
 *   输入不写回任何 state）——编辑中途到达的后台刷新会销毁编辑器并按服务端
 *   内容重开（:3434-3437 editor 为 null 时 _pocOpenGroup 重读），未保存输入
 *   必然丢失。对照：_pocRefreshForLanguage（:3510-3544）在语言切换路径专门
 *   保存/恢复输入值与焦点——同一风险在事件刷新路径没有任何防护。
 *
 * 预言：
 * 1. 两次并发 refresh，慢的旧响应后到 → 界面回滚到旧数据；
 * 2. 编辑器打开后一次 refresh（change rail 语义）→ groups.read 重新调用、
 *    编辑器对象被换新（未保存输入丢失的机制证明）。
 *
 * 2026-09-30 r2 收尾（记账员）：用例 1 对应待议 P-r2-6（世代计数器 /
 * latest-wins 单飞 / 触发源串行化待拍板，守卫须覆盖 _pocPo 与 _pocBoxData
 * 两写入点）、用例 2 对应待议 P-r2-7（编辑器存活优先 / 草稿保存恢复 /
 * defer 刷新 / 受控化四案待拍板）→ 全部 it.skip。断言锁定的是「现状回滚/
 * 编辑器销毁」，拍板修复后按所选方案反转。见 round-2-甄别.md toPending。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

const root = resolve(__dirname, '../..');
const ontology = readFileSync(resolve(root, 'src/renderer/modules/personal-ontology.js'), 'utf8');

function snapshotOf(title: string) {
  return {
    groups: [{
      id: 'g1', title, kind: 'user',
      createdAt: '2026-09-01T10:00:00', updatedAt: '2026-09-02T10:00:00',
      fields: [{ id: 'f1', name: '常用工具', origin: 'user', valueIds: ['v1'] }],
      values: [{ id: 'v1', fieldId: 'f1', text: 'ZCode', source: '手动', createdAt: '', updatedAt: '' }],
      entries: [],
    }],
    counts: { groups: 1, facts: 1, rules: 0, entries: 0 },
    deleted: [],
  };
}

const TEMPLATE_LIST = {
  ok: true,
  templates: [{
    template_id: 'student', name: '学生', installed: true, group_id: 'g2',
    sections: [{ title: '学习背景', fields: [{ name: '教育阶段', values: [] }] }],
  }],
};

function baseChannels(snapshot: unknown) {
  return {
    'po.snapshot': snapshot,
    'personalOntology.templates.list': TEMPLATE_LIST,
    'recall.assets.list': { ok: true, assets: [] },
    'personalOntology.candidates.list': { ok: true, candidate_updates: [], blocked_items: [] },
    'personalOntology.conflicts.list': { ok: true, conflicts: [] },
    'ontology.graph.read': { ok: true, graph: { categories: [], entities: [], relations: [] } },
    'personalOntology.groups.read': { ok: true, content: '# 学生（模板）\n> 模板: student@1.0.0 | 已安装: 2026-09-01\n\n## 学习背景\n' },
  };
}

function loadSandbox(invoke: any) {
  const listeners = new Map<string, any>();
  const navHandlers: Array<() => Promise<void>> = [];
  const element = (id: string) => ({
    id,
    innerHTML: '',
    style: {},
    scrollTop: 0,
    value: '',
    listeners,
    addEventListener(event: string, handler: any) { listeners.set(event, handler); },
    querySelector: () => null,
    querySelectorAll: (sel: string) => {
      if (id === 'personal-onto-nav' && sel === '[data-poc-nav]') {
        return [{
          getAttribute: (name: string) => (name === 'data-poc-nav' ? 'template' : name === 'data-poc-id' ? 'g2' : ''),
          addEventListener: (_e: string, handler: any) => { navHandlers.push(handler); },
        }];
      }
      return [];
    },
    classList: { _set: new Set<string>(), add(c: string) { this._set.add(c); }, remove(c: string) { this._set.delete(c); }, contains(c: string) { return this._set.has(c); } },
  });
  const elements = new Map([
    ['personal-onto-nav', element('personal-onto-nav')],
    ['personal-onto-main-header', element('personal-onto-main-header')],
    ['personal-onto-main-body', element('personal-onto-main-body')],
    ['personal-onto-modal', element('personal-onto-modal')],
    ['personal-onto-modal-body', element('personal-onto-modal-body')],
  ]);
  const sandbox: any = {
    console: { log() {}, warn() {}, error() {} },
    CSS: { escape: (v: string) => String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    t: (key: string) => key.replace(/^personalOntology\./, ''),
    uiToast: vi.fn(),
    cogseed: { invoke },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['modules/icons.js', 'modules/ui-button.js', 'modules/ui-card.js', 'modules/ui-form.js', 'modules/ui-empty.js', 'modules/ui-status.js']) {
    vm.runInContext(readFileSync(resolve(root, 'src/renderer', file), 'utf8'), sandbox, { filename: file });
  }
  vm.runInContext(ontology, sandbox, { filename: 'personal-ontology.js' });
  return { sandbox, elements, navHandlers };
}

async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe('probe r2: 个人本体渲染层并发刷新竞态（待议项已 skip）', () => {
  // 待议 P-r2-6：快照加载无世代/序号守卫，旧 po.snapshot 后到覆盖 _pocPo。
  it.skip('并发两次 refresh：慢的旧 po.snapshot 后到，覆盖新快照（stale overwrite）', async () => {
    // po.snapshot 按调用序：#1 初始数据(旧)；#2 refreshA 发出、挂起(旧)；#3 refreshB 发出(新、立即返回)。
    const calls: any[] = [];
    let snapshotSeq = 0;
    let releaseSlowOld: ((v: unknown) => void) | null = null;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'po.snapshot') {
        snapshotSeq += 1;
        calls.push(snapshotSeq);
        if (snapshotSeq === 2) {
          return new Promise((resolve) => { releaseSlowOld = resolve; })
            .then(() => snapshotOf('旧组名-慢响应'));
        }
        return snapshotOf(snapshotSeq === 1 ? '初始组名' : '新组名');
      }
      return baseChannels(null)[channel] ?? { ok: true };
    });
    const { sandbox, elements } = loadSandbox(invoke);

    await sandbox.renderPersonalOntology();
    await settle();
    expect(elements.get('personal-onto-main-body').innerHTML).toContain('初始组名');

    // refreshA 先发（其 po.snapshot 挂起），refreshB 后发并快速完成。
    const pA = sandbox.refreshPersonalOntology();
    await Promise.resolve();
    const pB = sandbox.refreshPersonalOntology();
    await pB;
    await settle();
    // B 已把界面刷到新数据：
    expect(elements.get('personal-onto-main-body').innerHTML).toContain('新组名');

    // A 的旧响应此时才返回：
    (releaseSlowOld as unknown as (v: unknown) => void)(undefined);
    await pA;
    await settle();

    // 若有世代守卫，A 的旧响应应被丢弃；实际断言它覆盖了新快照：
    const html = elements.get('personal-onto-main-body').innerHTML;
    expect(html).toContain('旧组名-慢响应');
    expect(html).not.toContain('新组名');
    expect(snapshotSeq).toBe(3);
  });

  // 待议 P-r2-7：change rail 事件刷新销毁前台编辑器（textarea 非受控），
  // 编辑期间本体写广播丢失未保存输入。
  it.skip('编辑器打开后一次后台刷新（change rail 语义）销毁编辑器并按服务端内容重开——未保存输入无 state 承载', async () => {
    const invoke = vi.fn(async (channel: string) => (baseChannels(snapshotOf('工作偏好'))[channel] ?? { ok: true }));
    const { sandbox, elements, navHandlers } = loadSandbox(invoke);

    await sandbox.renderPersonalOntology();
    await settle();
    expect(navHandlers.length).toBeGreaterThanOrEqual(1);
    // 进入模板编辑器（nav 的 template 入口 → _pocOpenGroup）。
    await navHandlers[0]({ stopPropagation() {} });
    await settle();
    const readCallsAfterOpen = invoke.mock.calls.filter(([c]: any[]) => c === 'personalOntology.groups.read').length;
    expect(readCallsAfterOpen).toBe(1);
    // 编辑器已打开（表单视图；原文视图 textarea 见 :390，非受控）。
    expect(elements.get('personal-onto-main-body').innerHTML).toContain('personal-onto-group-editor');

    // 模拟 change rail：任何本体写（含主进程后台投影写）→ 页面可见时全量刷新。
    await sandbox.refreshPersonalOntology();
    await settle();

    // 编辑器被销毁重开：groups.read 重新调用（内容回到服务端版本），
    // 且 textarea 的 DOM 已重建（:390 value 只在渲染时设置，用户输入无 state 承载）。
    const readCallsAfterRefresh = invoke.mock.calls.filter(([c]: any[]) => c === 'personalOntology.groups.read').length;
    expect(readCallsAfterRefresh).toBeGreaterThanOrEqual(2);
  });
});
