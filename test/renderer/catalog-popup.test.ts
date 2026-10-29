/**
 * S4 统一详情弹窗（specs/009-agent-skill-pages FR-006～009、FR-026）。
 * 用最小 uiModal / uiButton 桩记录渲染参数，不依赖真实 DOM。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/catalog.js'), 'utf8');

function load(): any {
  const buttons: any[] = [];
  const modals: any[] = [];
  const fakeEl = () => ({
    classList: { add() {} }, appendChild() {}, addEventListener() {}, querySelector: () => null, innerHTML: '', className: '',
  });
  const context: any = {
    window: {}, console, setTimeout, clearTimeout, buttons, modals,
    document: { createElement: () => fakeEl() },
    t: (key: string, vars?: Record<string, string>) => (vars && vars.name ? `${key}:${vars.name}` : key),
    escapeHtml: (v: string) => String(v),
    uiButton: (opts: any) => { buttons.push(opts); return `<button data-label="${opts.label}">`; },
    uiModal: (opts: any) => {
      const modal: any = { dialog: fakeEl(), then() {}, opts };
      modals.push(modal);
      return modal;
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'catalog.js' });
  return context;
}

describe('底部按钮（FR-007）', () => {
  const actions = (origin: string, state: Record<string, unknown> = {}) => load().catalogPopupActions(origin, { installed: true, ...state });

  it('主智能体只有使用', () => {
    expect(actions('commander')).toEqual({ primary: 'use', secondary: [] });
  });
  it('外接：管理、停用', () => {
    expect(actions('external')).toEqual({ primary: 'use', secondary: ['manage', 'disable'] });
  });
  it('自建：可贡献时 贡献、管理、停用', () => {
    expect(actions('own', { contributable: true })).toEqual({ primary: 'use', secondary: ['contribute', 'manage', 'disable'] });
    expect(actions('own')).toEqual({ primary: 'use', secondary: ['manage', 'disable'] });
  });
  it('已安装平台：只有停用（卸载只在「已安装」页）；未安装只有安装', () => {
    expect(actions('platform')).toEqual({ primary: 'use', secondary: ['disable'] });
    expect(actions('platform', { installed: false })).toEqual({ primary: 'install', secondary: [] });
  });
  it('外部包：停用、移除；全局文件夹：停用', () => {
    expect(actions('package')).toEqual({ primary: 'use', secondary: ['disable', 'remove'] });
    expect(actions('global')).toEqual({ primary: 'use', secondary: ['disable'] });
  });
  it('安装失败：主按钮变「重试」；有新版本：多一个「更新」（FR-013、FR-013a）', () => {
    expect(actions('platform', { installed: false, failed: 'x' })).toEqual({ primary: 'retry', secondary: [] });
    expect(actions('platform', { updateAvailable: true })).toEqual({ primary: 'use', secondary: ['update', 'disable'] });
  });
  it('已停用时切换按钮变成启用（FR-009）', () => {
    expect(actions('platform', { enabled: false }).secondary).toContain('enable');
  });
  it('随包内容（2026-10-21 定）：只有使用，不给停用 / 更新；已被停用时只留启用', () => {
    expect(actions('platform', { bundled: true })).toEqual({ primary: 'use', secondary: [] });
    expect(actions('platform', { bundled: true, updateAvailable: true })).toEqual({ primary: 'use', secondary: [] });
    expect(actions('platform', { bundled: true, enabled: false })).toEqual({ primary: 'use', secondary: ['enable'] });
  });
  it('随包内容被 Hub 停用：不给「启用」（用户的启用改不动 Hub 的停用）', () => {
    expect(actions('platform', { bundled: true, enabled: false, hubDisabled: true })).toEqual({ primary: 'use', secondary: [] });
  });
  it('平台内容被 Hub 停用：不放开关、也不给更新（与智能体行菜单同一口径）', () => {
    expect(actions('platform', { enabled: false, hubDisabled: true })).toEqual({ primary: 'use', secondary: [] });
    expect(actions('platform', { enabled: false, hubDisabled: true, updateAvailable: true })).toEqual({ primary: 'use', secondary: [] });
  });
});

describe('示例（FR-026）', () => {
  const examples = (item: unknown, generic = '') => load().catalogExamples(item, generic);

  it('有示例用内容自带的，最多 5 条，兼容对象写法', () => {
    expect(examples({ examples: ['a', { prompt: 'b' }, { text: 'c' }, '', 'd', 'e', 'f'] })).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('缺示例时用一条通用示例', () => {
    expect(examples({}, '请用 X 帮我处理这项工作')).toEqual(['请用 X 帮我处理这项工作']);
    expect(examples(null)).toEqual([]);
  });
});

describe('弹窗渲染', () => {
  const open = (view: Record<string, unknown>) => {
    const ctx = load();
    ctx.openCatalogPopup({ kind: 'agent', id: 'a1', name: 'A1', ...view }, {});
    return ctx;
  };
  const byAction = (ctx: any, action: string) => ctx.buttons.find((b: any) => b.attrs && b.attrs['data-catalog-action'] === action);
  const exampleButtons = (ctx: any) => ctx.buttons.filter((b: any) => b.attrs && 'data-catalog-example' in b.attrs);

  it('缺示例时渲染通用示例按钮', () => {
    const ctx = open({ origin: 'platform', installed: true });
    expect(exampleButtons(ctx).map((b: any) => b.label)).toEqual(['“catalog.generic_example:A1”']);
  });

  it('停用时「使用」与示例置灰，并提供「启用」（FR-009）', () => {
    const ctx = open({ origin: 'platform', installed: true, enabled: false, examples: ['hi'] });
    expect(byAction(ctx, 'use').disabled).toBe(true);
    expect(exampleButtons(ctx).every((b: any) => b.disabled)).toBe(true);
    expect(byAction(ctx, 'enable')).toBeTruthy();
  });

  it('依赖被停用时同样阻断使用', () => {
    const ctx = open({ origin: 'platform', installed: true, blockedReason: 'deps', examples: ['hi'] });
    expect(byAction(ctx, 'use').disabled).toBe(true);
    expect(exampleButtons(ctx)[0].disabled).toBe(true);
  });

  it('未安装：主按钮是安装，示例可点（点了先装再发）', () => {
    const ctx = open({ origin: 'platform', installed: false, examples: ['hi'] });
    expect(byAction(ctx, 'install').disabled).toBe(false);
    expect(byAction(ctx, 'use')).toBeUndefined();
    expect(exampleButtons(ctx)[0].disabled).toBe(false);
  });

  it('安装失败：显示原因，主按钮「重试」可点', () => {
    const ctx = open({ origin: 'platform', installed: false, failed: '安装失败：网络不可用' });
    expect(byAction(ctx, 'retry').disabled).toBe(false);
    expect(ctx.modals[0].opts.bodyHtml).toContain('安装失败：网络不可用');
  });

  it('安装中：主按钮显示安装中且不可点', () => {
    const ctx = open({ origin: 'platform', installed: false, installing: true });
    const primary = byAction(ctx, 'install');
    expect(primary.label).toBe('catalog.installing');
    expect(primary.disabled).toBe(true);
  });
});

describe('会用到的技能的状态标签', () => {
  it('本机不具备的依赖标「本机不可用」，其余按原规则', () => {
    const ctx = load();
    ctx.openCatalogPopup({
      kind: 'agent', origin: 'platform', id: 'a', name: 'A', installed: false,
      skills: [
        { name: 'coding', ready: false, unavailable: true },
        { name: 'bundled', ready: false },
        { name: 'off', ready: true, off: true },
        { name: 'ok', ready: true },
      ],
    }, {});
    const body = ctx.modals[0].opts.bodyHtml as string;
    const pillOf = (name: string) => {
      const at = body.indexOf(`>${name} `);
      return body.slice(at, body.indexOf('</span>', at + name.length + 2));
    };
    expect(pillOf('coding')).toContain('catalog.skill_unavailable');
    expect(pillOf('bundled')).toContain('catalog.skill_with_install');
    expect(pillOf('off')).toContain('catalog.skill_off');
    expect(pillOf('ok')).toContain('catalog.skill_ready');
  });
});

describe('未安装时点示例：弹窗里安装（FR-008）', () => {
  function openWithDom(sendExample: () => Promise<unknown>) {
    const ctx = load();
    let onClick: any = null;
    let closed = false;
    const examples = [{ dataset: { catalogExample: '0' }, disabled: false }];
    const footerButtons: string[] = [];
    let failedNote: any = null;
    const primaryEl = {
      insertAdjacentHTML: (_where: string, html: string) => { footerButtons.push(html); },
      remove() {},
    };
    const content = {
      querySelector: () => failedNote,
      prepend: (el: any) => { failedNote = el; },
    };
    ctx.document.createElement = () => ({ classList: { add() {} }, appendChild() {}, innerHTML: '', className: '', textContent: '' });
    ctx.uiModal = (opts: any) => {
      const modal: any = {
        opts,
        dialog: {
          classList: { add() {} },
          appendChild() {},
          addEventListener: (_type: string, fn: any) => { onClick = fn; },
          querySelector: (sel: string) => (sel.includes('footer') ? primaryEl : sel.includes('content') ? content : null),
          querySelectorAll: () => examples,
        },
        close: () => { closed = true; },
        then() {},
      };
      ctx.modals.push(modal);
      return modal;
    };
    ctx.catalogInstallFailure = () => '安装失败：网络不可用';
    vm.runInContext('catalogInstallFailure = globalThis.catalogInstallFailure || catalogInstallFailure', ctx);
    ctx.openCatalogPopup({ kind: 'agent', origin: 'platform', id: 'p', name: 'P', installed: false, examples: ['试一下'] }, { sendExample });
    const click = () => onClick({ target: { closest: (sel: string) => (sel === '[data-catalog-example]' ? examples[0] : null) } });
    return { ctx, click, examples, footerButtons, isClosed: () => closed, failedNote: () => failedNote };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('点了不关弹窗：主按钮变「安装中…」，示例变灰', async () => {
    let resolve: (v: boolean) => void = () => {};
    const h = openWithDom(() => new Promise((r) => { resolve = r; }));
    h.click();
    expect(h.isClosed()).toBe(false);
    expect(h.footerButtons.at(-1)).toContain('catalog.installing');
    expect(h.examples[0].disabled).toBe(true);
    resolve(true);
    await flush();
    expect(h.isClosed()).toBe(true);
  });

  it('装失败：留在弹窗，显示原因，主按钮变「重试」，示例恢复可点', async () => {
    const h = openWithDom(async () => false);
    h.click();
    await flush();
    expect(h.isClosed()).toBe(false);
    expect(h.footerButtons.at(-1)).toContain('catalog.retry');
    expect(h.examples[0].disabled).toBe(false);
    expect(h.failedNote().textContent).toBe('安装失败：网络不可用');
  });
});
