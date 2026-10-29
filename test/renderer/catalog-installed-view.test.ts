/**
 * S4 已安装页、停用依赖确认、未登录 / 断网横幅（specs/009 FR-014～016、FR-023/024、FR-027）。
 * catalog.js 的纯渲染与确认逻辑，用最小 ui* 桩。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/catalog.js'), 'utf8');

function load(invoke: (channel: string, payload?: any) => Promise<any> = async () => ({})): any {
  const modals: any[] = [];
  const confirms: any[] = [];
  const context: any = {
    console, setTimeout, clearTimeout, modals, confirms, modalValue: 'go', confirmValue: false,
    window: { cogseed: { invoke, onPushEvent: () => () => {} } },
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    escapeHtml: (v: string) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    uiButton: (o: any) => `<button ${Object.entries(o.attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ')}>${o.label}</button>`,
    uiSwitch: (o: any) => `<button role="switch" aria-checked="${o.checked}"${o.disabled ? ' disabled' : ''} ${Object.entries(o.attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ')}></button>`,
    uiStatusPill: (o: any) => `<span class="pill">${o.label}</span>`,
  };
  context.uiModal = async (opts: any) => { modals.push(opts); return { value: context.modalValue }; };
  context.uiConfirm = async (opts: any) => { confirms.push(opts); return context.confirmValue; };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'catalog.js' });
  return context;
}

describe('已安装页（2026-10-20 改版：一行头部、状态筛选、一行三个卡片、卸载收进「⋯」、需要处理的排前面）', () => {
  const rows = [
    { id: 'b', name: 'Beta', enabled: true },
    { id: 'u', name: 'Update Me', enabled: true, updateVersion: '1.2.0' },
    { id: 'a', name: 'Alpha', enabled: true },
    { id: 'o', name: 'Off One', enabled: false },
    { id: 'x', name: 'Blocked', enabled: true, blocked: true },
  ];

  it('需要处理的（有更新 / 被阻断 / 已停用）排前面，各组按名字', () => {
    expect(load().catalogInstalledSort(rows).map((r: any) => r.id)).toEqual(['x', 'o', 'u', 'a', 'b']);
  });

  it('状态筛选与计数', () => {
    const ctx = load();
    expect(ctx.catalogInstalledFilter(rows, 'update').map((r: any) => r.id)).toEqual(['u']);
    expect(ctx.catalogInstalledFilter(rows, 'off').map((r: any) => r.id)).toEqual(['o']);
    expect(ctx.catalogInstalledFilter(rows, '')).toHaveLength(5);
    expect(ctx.catalogInstalledSummary(rows)).toEqual({ total: 5, off: 1, update: 1 });
  });

  it('一行三个的卡片：开关 + 「⋯」，没有直接露出的「卸载」；停用的变暗', () => {
    const ctx = load();
    ctx.uiIconButton = (o: any) => `<button aria-label="${o.label}" ${Object.entries(o.attrs || {}).map(([k, v]) => `${k}="${v}"`).join(' ')}></button>`;
    const html = ctx.catalogInstalledGridHtml([
      { id: 'a', name: '报销助手', desc: 'd', category: '财务', version: '1.0.0', enabled: true, pills: [{ label: '有更新' }] },
      { id: 'b', name: 'B', enabled: false },
    ], 'agent') as string;
    expect(html).toContain('catalog-installed-grid');
    expect(html.match(/data-catalog-row="/g)).toHaveLength(2);
    expect(html.match(/data-catalog-row-action="toggle"/g)).toHaveLength(2);
    expect(html.match(/data-catalog-row-action="more"/g)).toHaveLength(2);
    expect(html).not.toContain('data-catalog-row-action="uninstall"');
    expect(html).toContain('catalog-installed-card is-off');
    expect(html).toMatch(/报销助手[\s\S]*有更新/);
    expect(html).toContain('catalog.no_desc'); // 没有说明时有占位
  });

  it('被 Hub 停用的行：开关置灰不可拨，显示为关', () => {
    const ctx = load();
    ctx.uiIconButton = () => '';
    const html = ctx.catalogInstalledGridHtml([
      { id: 'h', name: 'HubOff', enabled: false, hubDisabled: true },
      { id: 'u', name: 'UserOff', enabled: false },
    ], 'skill') as string;
    const card = (id: string) => html.slice(html.indexOf(`data-catalog-row="${id}"`), html.indexOf('</div>', html.indexOf(`data-catalog-row="${id}"`)) + 200);
    expect(card('h')).toMatch(/role="switch" aria-checked="false" disabled/);
    expect(card('u')).not.toMatch(/role="switch" aria-checked="false" disabled/);
  });

  it('名字里的 HTML 被转义', () => {
    const ctx = load();
    ctx.uiIconButton = () => '';
    const html = ctx.catalogInstalledGridHtml([{ id: 'x', name: '<img src=x>' }], 'skill') as string;
    const name = html.slice(html.indexOf('catalog-installed-card__name'), html.indexOf('</strong>'));
    expect(name).toContain('&lt;img');
    expect(name).not.toContain('<img');
  });

  it('摘要只写有的项', () => {
    const ctx = load();
    const html = ctx.catalogInstalledSummaryHtml('skill', { total: 80, off: 0, update: 3 }) as string;
    expect(html).toContain('installed_summary_skills');
    expect(html).toContain('installed_summary_update');
    expect(html).not.toContain('installed_summary_off');
  });
});

describe('停用 / 卸载被引用的技能前先提示（FR-027）', () => {
  it('没人在用：不弹窗直接继续', async () => {
    const ctx = load();
    expect(await ctx.catalogConfirmDependents('disable', 'S', [])).toBe(true);
    expect(ctx.modals).toHaveLength(0);
  });

  it('有人在用：列出智能体名；确认继续、取消不继续', async () => {
    const ctx = load();
    expect(await ctx.catalogConfirmDependents('disable', '发票抽取', ['报销助手', '审单助手'])).toBe(true);
    expect(ctx.modals[0].bodyHtml).toContain('报销助手');
    expect(ctx.modals[0].bodyHtml).toContain('审单助手');
    ctx.modalValue = 'cancel';
    expect(await ctx.catalogConfirmDependents('uninstall', '发票抽取', ['报销助手'])).toBe(false);
    expect(ctx.modals[1].title).toContain('dependents_uninstall_title');
  });
});

describe('未登录与断网（FR-023、FR-024）', () => {
  const signedOut = async (channel: string) => (channel === 'hub-account.status'
    ? { ok: true, status: { signed_in: false, release_enabled: true } }
    : { list: [], total: 0 });

  it('未登录：横幅提示登录；安装先请登录，拒绝则不安装', async () => {
    const ctx = load(signedOut);
    let installs = 0;
    ctx._mpInstall = async () => { installs++; return true; };
    await ctx.catalogLoad('agent');
    expect(ctx.catalogStatus('agent').signedOut).toBe(true);
    expect(ctx.catalogHomeBannerHtml('agent')).toContain('data-catalog-banner="login"');
    expect(await ctx.catalogInstall('agent', { id: 'a1', name: 'A1' })).toBe(false);
    expect(ctx.confirms).toHaveLength(1);
    expect(installs).toBe(0);
  });

  it('登录 Gate 关闭：不算未登录，不挡安装', async () => {
    const ctx = load(async (channel) => (channel === 'hub-account.status'
      ? { ok: true, status: { signed_in: false, release_enabled: false } } : { list: [], total: 0 }));
    ctx._mpInstall = async () => true;
    await ctx.catalogLoad('skill');
    expect(ctx.catalogStatus('skill').signedOut).toBe(false);
    expect(await ctx.catalogInstall('skill', { id: 's1' })).toBe(true);
  });

  it('连不上平台：横幅可重试，不是空白', async () => {
    const ctx = load(async (channel) => {
      if (channel === 'hub-account.status') return { ok: true, status: { signed_in: true } };
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });
    await ctx.catalogLoad('agent');
    expect(ctx.catalogStatus('agent').error).toContain('ERR_CONNECTION_REFUSED');
    expect(ctx.catalogHomeBannerHtml('agent')).toContain('data-catalog-banner-action="retry"');
  });

  it('已登录且在线：没有横幅', async () => {
    const ctx = load(async (channel) => (channel === 'hub-account.status' ? { ok: true, status: { signed_in: true } } : { list: [], total: 0 }));
    await ctx.catalogLoad('agent');
    expect(ctx.catalogHomeBannerHtml('agent')).toBe('');
  });
});

describe('平台组尾部：加载骨架 / 暂无更多（FR-025）', () => {
  const online = async (channel: string) => (channel === 'hub-account.status' ? { ok: true, status: { signed_in: true } } : { list: [], total: 0 });

  it('首次加载中：两张骨架卡，没有说明', () => {
    const ctx = load(() => new Promise(() => {})); // 永不返回 = 一直在加载
    ctx.uiSkeleton = (o: any) => `<div role="status" aria-label="${o.ariaLabel}"></div>`;
    void ctx.catalogLoad('agent');
    const tail = ctx.catalogPlatformTail('agent', 0, false);
    expect(tail.cards.match(/catalog-skeleton-card/g)).toHaveLength(2);
    expect(tail.note).toBe('');
  });

  it('加载完且没有可装的：显示「平台暂时没有更多」；搜索 / 分类筛选时不显示', async () => {
    const ctx = load(online);
    await ctx.catalogLoad('skill');
    expect(ctx.catalogPlatformTail('skill', 0, false).note).toContain('catalog.platform_no_more');
    expect(ctx.catalogPlatformTail('skill', 0, true).note).toBe('');
    expect(ctx.catalogPlatformTail('skill', 3, false).note).toBe('');
  });

  it('未登录或断网：不出骨架也不说「没有更多」（顶部横幅负责说明）', async () => {
    const out = load(async (channel) => (channel === 'hub-account.status'
      ? { ok: true, status: { signed_in: false, release_enabled: true } } : { list: [], total: 0 }));
    await out.catalogLoad('agent');
    expect(out.catalogPlatformTail('agent', 0, false)).toEqual({ cards: '', note: '' });
    const offline = load(async (channel) => {
      if (channel === 'hub-account.status') return { ok: true, status: { signed_in: true } };
      throw new Error('offline');
    });
    await offline.catalogLoad('agent');
    expect(offline.catalogPlatformTail('agent', 0, false)).toEqual({ cards: '', note: '' });
  });
});
