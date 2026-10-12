/**
 * 探针 r3（边界测试员 · 契约对齐）：个人本体 v2 渲染层的空态/错误态/locale 兜底。
 *
 * 覆盖：
 *  1) po.snapshot IPC 抛异常（reject）→ 渲染层是呈现错误态还是让异常穿透（面板空白）；
 *  2) po.snapshot 返回错误对象（{ok:false,error}）→ loadError 路径；
 *  3) 空快照（groups:[] 全零计数）→ 空态占位不炸；
 *  4) t() 缺键（返回 key 本身）→ _t 回落硬编码中文 fallback（en 界面冒中文的机制验证）。
 * 手法对齐 test/renderer/personal-ontology.test.ts（vm 沙箱 + 假 DOM + invoke mock）。
 *
 * 2026-09-30 r3 收尾（记账员）：用例 1/2 对应待议 P-r3-1（错误态契约错位，
 * 治本/止血/改语义三案待拍板）、用例 4 对应待议 P-r3-2（locale 兑底语言
 * en vs zh 产品决策）→ it.skip，断言锁定的均是待议现状。用例 3（空快照
 * 空态渲染）保留 active：断言的是无争议正确行为，不依赖任何待拍板方向。
 * 见 round-3-甄别.md toPending。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';

const root = resolve(__dirname, '../..');
const ontology = readFileSync(resolve(root, 'src/renderer/modules/personal-ontology.js'), 'utf8');

const EMPTY_SNAPSHOT = {
  groups: [],
  counts: { groups: 0, facts: 0, rules: 0, entries: 0 },
  deleted: [],
};

function makeInvoke(overrides: Record<string, any> = {}) {
  return vi.fn(async (channel: string) => {
    if (channel in overrides) return typeof overrides[channel] === 'function' ? overrides[channel](channel) : overrides[channel];
    switch (channel) {
      case 'po.snapshot':
        return EMPTY_SNAPSHOT;
      case 'personalOntology.templates.list':
        return { ok: true, templates: [] };
      case 'personalOntology.candidates.list':
        return { ok: true, candidate_updates: [], blocked_items: [] };
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

const body = (loaded: { elements: Map<string, any> }) => loaded.elements.get('personal-onto-main-body').innerHTML;

describe('probe r3 › 渲染层空态/错误态/locale 兜底（待议项已 skip）', () => {
  // 待议 P-r3-1：po.snapshot 失败后错误态契约错位（真实 loadError 被 null.groups
  // TypeError 替换上屏）。错误呈现形态（横幅/空态/文案）属界面拍板。
  it.skip('po.snapshot IPC reject：与错误对象路径殊途同归——真实错误丢失、TypeError 上屏', async () => {
    const invoke = makeInvoke({ 'po.snapshot': () => Promise.reject(new Error('ipc boom')) });
    const loaded = loadPersonalOntology(invoke);
    let caught: unknown;
    await loaded.sandbox.renderPersonalOntology().catch((e: unknown) => { caught = e; });
    await settle();
    // 渲染入口 :3474-3477 顶层 catch 兜住，promise 不 reject
    expect(caught).toBeUndefined();
    const html = body(loaded);
    // _pocInvoke(:225-233) 把 reject 转成 {ok:false,error} → _pocLoadPoSnapshot
    // 置 {snapshot:null, loaded:true} → :1108 loaded?true 直通 → :1210 null.groups
    // → 顶层 catch 显示 TypeError；真实错误 'ipc boom' 全程不可见
    expect(html).toContain('Cannot read properties of null');
    expect(html).not.toContain('ipc boom');
  });

  // 待议 P-r3-1（同上）：错误对象路径同病。
  it.skip('po.snapshot 返回错误对象：loadError 被下游 TypeError 替换上屏（错误态契约错位）', async () => {
    const errors: string[] = [];
    const invoke = makeInvoke({ 'po.snapshot': { ok: false, error: 'db locked' } });
    const loaded = loadPersonalOntology(invoke, {
      console: { log() {}, warn() {}, error(...args: unknown[]) { errors.push(args.map((a: any) => String(a && a.stack ? a.stack : a)).join(' ')); } },
    });
    let caught: unknown;
    await loaded.sandbox.renderPersonalOntology().catch((e: unknown) => { caught = e; });
    await settle();
    expect(caught).toBeUndefined(); // 顶层 catch 兜住（渲染入口 :3474-3477）
    const html = body(loaded);
    // 实证：用户看到的错误是内部 TypeError 而非真实 loadError 'db locked'
    expect(html).toContain('Cannot read properties of null');
    expect(html).not.toContain('db locked');
    // 堆栈进 console.error（取证输出，帮助定位无守卫访问点）
    process.stdout.write(`[probe-r3取证] ${errors.join('\n')}\n`);
    expect(errors.join('\n')).toContain("reading 'groups'");
  });

  // 保留 active：空快照空态渲染是无争议正确行为（P-r3-12 覆盖缺口的非耦合部分），
  // 任何拍板档位下该断言方向不变。
  it('空快照（全零）：渲染不炸且出现空态占位', async () => {
    const invoke = makeInvoke(); // 默认 po.snapshot = EMPTY_SNAPSHOT
    const loaded = loadPersonalOntology(invoke);
    let caught: unknown;
    await loaded.sandbox.renderPersonalOntology().catch((e: unknown) => { caught = e; });
    await settle();
    expect(caught).toBeUndefined();
    const html = body(loaded);
    expect(html.length).toBeGreaterThan(0);
    // 空态占位存在（空态文案或 ui-empty 组件类）
    expect(/暂无|还没有|memory-empty|ui-empty/.test(html)).toBe(true);
  });

  // 待议 P-r3-2：locale 缺键兑底语言是硬编码中文（兑底改 en / 维持 zh+扩守卫 /
  // fallback 双写三案待拍板）。断言锁定「现状回落中文」，拍板后反转。
  it.skip('locale 缺键兜底：t 返回 key 时 _t 回落硬编码中文 fallback（en 界面冒中文机制）', async () => {
    const invoke = makeInvoke({ 'po.snapshot': { ok: false, error: '' } });
    const loaded = loadPersonalOntology(invoke, {
      // 覆盖 t：任何键都视为缺译（返回 key 本身）——模拟 en/ja/pt 缺键
      t: (key: string) => key,
    });
    await loaded.sandbox.renderPersonalOntology().catch(() => {});
    await settle();
    const html = body(loaded);
    // load_error 的 fallback 是硬编码中文「加载失败」——非中文界面直接冒中文
    expect(html).toContain('加载失败');
  });
});
