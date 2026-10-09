import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * 真机 bug（9.17 知识库会议 P0「侧栏无法关闭」，会上确认属测试遗漏）：
 * 「生成测验」按钮**正上方**那个 × （`#kb-wb-right-collapse`，aria-label
 * 「关闭 AI 解析与问答」）在宽窗口下点了完全没反应。
 *
 * 根因是两层叠加：
 *  1) JS：applyRightPanel 把展开态写成 `!rightPanelNarrow || _state.rightPanelOpen`，
 *     宽屏（>1100px）下 `!rightPanelNarrow` 恒为 true → open 恒为 true →
 *     点 × 只改了 _state，DOM 状态被强制回展开，视觉零变化。
 *  2) CSS：宽屏下这个按钮本该不存在（style.css `.kb-wb-right-collapse{display:none}`），
 *     但 ui-components.css 在 index.html 里**晚于** style.css 加载，其
 *     `.ui-icon-button{display:inline-flex}` 与前者同权重（0,1,0）→ 后加载者胜，
 *     连浏览器 UA 的 `[hidden]{display:none}` 也一并被作者样式压掉
 *     （作者样式永远优先于 UA 样式）→ JS 设 hidden 同样无效 →
 *     一个永远可见、永远点不动的死按钮。
 *
 * 因此本文件既做行为回归（点 × 必须真的收起 AI 列），也钉住 CSS 权重契约。
 */

const ROOT = path.join(__dirname, '../..');
const KB_SOURCE = fs.readFileSync(
  path.join(ROOT, 'src/renderer/modules/kb-workbench.js'), 'utf8').replace(/\r\n/g, '\n');
const STYLE_CSS = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
const UI_COMPONENTS_CSS = fs.readFileSync(path.join(ROOT, 'src/renderer/ui-components.css'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((n) => values.add(n)),
    remove: (...names: string[]) => names.forEach((n) => values.delete(n)),
    contains: (n: string) => values.has(n),
    toggle: (n: string, force?: boolean) => {
      const next = force == null ? !values.has(n) : force;
      if (next) values.add(n); else values.delete(n);
      return next;
    },
  };
}

function fakeEl(id: string) {
  const listeners: Record<string, (event?: any) => void> = {};
  return {
    id,
    innerHTML: '',
    hidden: false,
    value: '',
    textContent: '',
    dataset: {},
    style: { setProperty: vi.fn(), getPropertyValue: vi.fn(() => '') },
    classList: fakeClassList(),
    addEventListener: (name: string, fn: (event?: any) => void) => { listeners[name] = fn; },
    appendChild: vi.fn(),
    append: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    focus: vi.fn(),
    click: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    _listeners: listeners,
  } as any;
}

/**
 * 把 kb-workbench.js 跑在假 DOM 里，并暴露 renderKbWorkbench()（模块挂到
 * window 上）。narrow 模拟窗口是否 ≤1100px（matchMedia）。
 */
function loadWorkbench({ narrow }: { narrow: boolean }) {
  const els: Record<string, any> = {};
  const wb = fakeEl('__kb-wb__');           // document.querySelector('.kb-wb')
  const store = new Map<string, string>();
  const documentMock: any = {
    getElementById: (id: string) => (els[id] ||= fakeEl(id)),
    querySelector: vi.fn((selector: string) => (selector === '.kb-wb' ? wb : null)),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn(),
    body: { appendChild: vi.fn(), append: vi.fn(), classList: fakeClassList() },
    createElement: vi.fn(() => fakeEl('')),
  };
  const windowMock: any = {
    innerWidth: narrow ? 900 : 1440,
    innerHeight: 900,
    addEventListener: vi.fn(),
    matchMedia: vi.fn(() => ({ matches: narrow, addEventListener: vi.fn() })),
    t: (key: string) => key,
    // kb-workbench 自 2026-09-21 起不自带原语降级模板（缺原语即抛错），这里补桩。
    uiButton: (o: any) => `<button type="button" class="btn ui-button ${o.className || ''}" id="${o.attrs?.id || ''}">${o.label}</button>`,
    uiIconButton: (o: any) => `<button type="button" class="ui-icon-button ${o.className || ''}" id="${o.attrs?.id || ''}" aria-label="${o.label}"></button>`,
    uiInput: (o: any) => `<input class="ui-input ${o.className || ''}" id="${o.id || ''}" />`,
    uiTextarea: (o: any) => `<textarea class="ui-textarea ${o.className || ''}" id="${o.id || ''}"></textarea>`,
    uiToast: vi.fn(),
    uiPrompt: vi.fn(() => Promise.resolve(null)),
    cogseed: {
      invoke: vi.fn(async () => ({})),
      stream: vi.fn(() => ({ promise: Promise.resolve() })),
    },
  };
  const context: any = {
    console,
    Promise,
    setTimeout,
    clearTimeout,
    performance,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (v: unknown) => String(v ?? ''),
    uiButton: windowMock.uiButton,
    uiIconButton: windowMock.uiIconButton,
    uiInput: windowMock.uiInput,
    uiTextarea: windowMock.uiTextarea,
    uiToast: windowMock.uiToast,
    uiPrompt: windowMock.uiPrompt,
    document: documentMock,
    window: windowMock,
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => store.clear(),
    },
  };
  vm.createContext(context);
  vm.runInContext(KB_SOURCE, context, { filename: 'kb-workbench.js' });
  context.window.renderKbWorkbench();
  return {
    els, wb, windowMock,
    collapse: els['kb-wb-right-collapse'],
    expand: els['kb-wb-right-expand'],
  };
}

describe('KB 右侧 AI 列的收起/展开（宽屏死按钮回归）', () => {
  it('宽屏下点 × 必须真的收起 AI 列，而不是毫无反应', () => {
    const { wb, collapse, expand } = loadWorkbench({ narrow: false });

    // 初始：AI 列常驻展开
    expect(wb.classList.contains('right-panel-collapsed')).toBe(false);
    expect(collapse.hidden).toBe(false);
    expect(expand.hidden).toBe(true);

    // 真机动作：点「生成测验」上方的 ×
    collapse._listeners.click();

    expect(wb.classList.contains('right-panel-collapsed')).toBe(true);
    expect(collapse.hidden).toBe(true);
    expect(expand.hidden).toBe(false);      // 收起后必须给得回展开入口
  });

  it('宽屏收起后能从中间列头部的展开按钮还原', () => {
    const { wb, collapse, expand } = loadWorkbench({ narrow: false });
    collapse._listeners.click();
    expect(wb.classList.contains('right-panel-collapsed')).toBe(true);

    expand._listeners.click();
    expect(wb.classList.contains('right-panel-collapsed')).toBe(false);
    expect(collapse.hidden).toBe(false);
    expect(expand.hidden).toBe(true);
  });

  it('窄屏抽屉行为不变：默认收起，展开后 × 可关', () => {
    const { wb, collapse, expand } = loadWorkbench({ narrow: true });

    // 窄屏默认收成抽屉，先给展开入口
    expect(wb.classList.contains('right-panel-collapsed')).toBe(true);
    expect(expand.hidden).toBe(false);
    expect(collapse.hidden).toBe(true);

    expand._listeners.click();
    expect(wb.classList.contains('right-panel-collapsed')).toBe(false);
    expect(wb.classList.contains('right-panel-open')).toBe(true);
    expect(collapse.hidden).toBe(false);

    collapse._listeners.click();
    expect(wb.classList.contains('right-panel-collapsed')).toBe(true);
    expect(wb.classList.contains('right-panel-open')).toBe(false);
  });

  it('展开态判定只认 _state.rightPanelOpen，不再被宽度短路', () => {
    // 钉子：`!rightPanelNarrow || _state.rightPanelOpen` 会让宽屏恒为展开态。
    // 只查代码本体（剥掉注释，注释里会引用旧写法做说明）。
    const apply = KB_SOURCE.match(/const applyRightPanel = \(\) => \{([\s\S]*?)\n    \};/);
    expect(apply, 'applyRightPanel 未找到').toBeTruthy();
    const body = apply![1].replace(/\/\/[^\n]*/g, '');
    expect(body).not.toMatch(/!rightPanelNarrow\s*\|\|/);
    expect(body).toMatch(/const open = _state\.rightPanelOpen;/);
  });

  it('CSS 权重契约：hidden 必须能压过 .ui-icon-button 的 display', () => {
    // 前提事实：ui-components.css 在 index.html 中晚于 style.css 加载
    const styleAt = INDEX_HTML.indexOf('href="./style.css"');
    const componentsAt = INDEX_HTML.indexOf('href="./ui-components.css"');
    expect(styleAt).toBeGreaterThan(-1);
    expect(componentsAt).toBeGreaterThan(styleAt);
    expect(UI_COMPONENTS_CSS).toMatch(/\.ui-icon-button\s*\{[^}]*display:\s*inline-flex;/);

    // 契约：这两个按钮的显隐规则必须高于单类 .ui-icon-button（用 .kb-wb 前缀），
    // 且 [hidden] 必须真的生效（否则 JS 设 hidden 也压不掉作者样式）
    expect(STYLE_CSS).toMatch(/\.kb-wb \.kb-wb-right-expand,\s*\.kb-wb \.kb-wb-right-collapse\s*\{[^}]*display:\s*inline-flex;/);
    expect(STYLE_CSS).toMatch(/\.kb-wb \.kb-wb-right-expand\[hidden\],\s*\.kb-wb \.kb-wb-right-collapse\[hidden\]\s*\{\s*display:\s*none;/);
  });

  it('宽屏收起态要有布局规则，不能留空白占位', () => {
    expect(STYLE_CSS).toMatch(/\.kb-wb\.right-panel-collapsed\s*\{[^}]*grid-template-columns:\s*var\(--kb-c1, 236px\) 4px minmax\(0, 1fr\) 0 0;/);
    expect(STYLE_CSS).toMatch(/\.kb-wb\.right-panel-collapsed \.kb-wb-right\s*\{\s*display:\s*none !important;\s*\}/);
    // 右列收起后第 2 条分隔条落在 0 宽轨道上：必须一并隐藏，
    // 否则仍会溢出约 1px 的发丝线并留下一个看不见的拖拽热区。
    expect(STYLE_CSS).toMatch(/\.kb-wb\.right-panel-collapsed \.kb-wb-divider\[data-wb-divider="2"\]\s*\{\s*visibility:\s*hidden;\s*pointer-events:\s*none;\s*\}/);
  });
});
