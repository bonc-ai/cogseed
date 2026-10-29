/**
 * 安装 Agent 前的「将同时安装」确认（产品第 2 条）。
 * 预览只是告知：预览失败不得挡住安装；被停用的依赖在下载前就说清楚；
 * 没有额外依赖时不多打扰用户一次。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Plan = { items: Array<{ id: string; name?: string; kind: string; action: string }>; readiness: string; appUpdateRequired: boolean; minAppVersion: string };

function load(invoke: (channel: string, payload: unknown) => Promise<unknown>, modalResult: string | null = 'install') {
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/marketplace.js'), 'utf8');
  const alerts: string[] = [];
  const modals: Array<{ title: string; bodyHtml: string }> = [];
  const strings: Record<string, string> = {
    'marketplace.agent_plan_blocked_intro': 'BLOCKED-INTRO',
    'marketplace.agent_plan_blocked_disabled': 'DISABLED',
    'marketplace.agent_plan_blocked_builtin': 'BUILTIN',
    'marketplace.agent_dep_title': 'DEP-TITLE',
    'marketplace.agent_dep_desc': 'DEP-DESC',
    'marketplace.agent_dep_group_hub': 'GROUP-HUB',
    'marketplace.agent_dep_group_bundled': 'GROUP-BUNDLED',
    'marketplace.agent_dep_state_install': 'STATE-INSTALL',
    'marketplace.agent_dep_state_reuse': 'STATE-REUSE',
    'marketplace.agent_dep_state_bundled': 'STATE-BUNDLED',
    'marketplace.agent_dep_state_disabled': 'STATE-DISABLED',
    'marketplace.agent_dep_state_builtin': 'STATE-BUILTIN',
    'marketplace.agent_dep_group_builtin': 'GROUP-BUILTIN',
    'marketplace.agent_dep_state_builtin_ok': 'STATE-BUILTIN-OK',
    'marketplace.agent_compat_title': 'COMPAT',
    'marketplace.requires_app': 'REQ {version}',
  };
  const context: any = {
    console,
    clearTimeout: () => {},
    setTimeout: () => 0,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: { hidden: false, addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [] },
    window: { addEventListener: () => {}, cogseed: { invoke } },
    escapeHtml: (v: string) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    uiAlert: async (m: string) => { alerts.push(m); },
    uiModal: async (opts: { title: string; bodyHtml: string }) => { modals.push(opts); return modalResult === null ? { value: undefined, reason: 'dismiss' } : { value: modalResult }; },
    t: (key: string) => strings[key] ?? key,
    _alerts: alerts,
    _modals: modals,
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'marketplace.js' });
  return context;
}

const item = { id: 'abcdef123456', name: '发票识别报销助手', version: '1.0.0', published_at: 1, updated_at: 2 };
const plan = (items: Plan['items'], over: Partial<Plan> = {}): Plan => ({ items, readiness: 'deps_blocked', appUpdateRequired: false, minAppVersion: '', ...over });

describe('Agent 安装前检查（S4：不再弹「将同时安装」确认）', () => {
  const check = (ctx: any) => vm.runInContext('_mpCheckAgentInstallable', ctx);

  it('有要一起装的依赖：不弹确认，直接继续（依赖清单只在详情里展示）', async () => {
    const ctx = load(async () => plan([
      { id: 'a3f09c21b7e4', name: '依据材料作答', kind: 'hub', action: 'reuse' },
      { id: '5e1c8a02d9b3', name: '发票字段抽取', kind: 'hub', action: 'install' },
      { id: 'invoice-ocr', name: 'invoice-ocr', kind: 'bundled', action: 'bundled' },
    ]));
    expect(await check(ctx)(item)).toBe(true);
    expect(ctx._modals).toEqual([]);
    expect(ctx._alerts).toEqual([]);
  });

  it('没有额外依赖：直接继续', async () => {
    const ctx = load(async () => plan([{ id: 'a3f09c21b7e4', kind: 'hub', action: 'reuse' }], { readiness: 'ready' }));
    expect(await check(ctx)(item)).toBe(true);
    expect(ctx._modals).toEqual([]);
  });

  it('依赖已被停用：下载前就说清楚原因并停止', async () => {
    const ctx = load(async () => plan([{ id: '9b27f4a1c0e6', name: '报销制度预检', kind: 'hub', action: 'blocked_disabled' }]));
    expect(await check(ctx)(item)).toBe(false);
    expect(ctx._alerts[0]).toContain('BLOCKED-INTRO');
    expect(ctx._alerts[0]).toContain('报销制度预检');
    expect(ctx._alerts[0]).toContain('DISABLED');
    expect(ctx._modals).toEqual([]);
  });

  it('引用内置能力（本期不支持）：说明原因并停止', async () => {
    const ctx = load(async () => plan([{ id: 'builtin:x', kind: 'builtin', action: 'blocked_builtin_unsupported' }]));
    expect(await check(ctx)(item)).toBe(false);
    expect(ctx._alerts[0]).toContain('BUILTIN');
  });

  it('预览失败或返回异常：不挡安装（安装路径自带检查）', async () => {
    expect(await check(load(async () => { throw new Error('offline'); }))(item)).toBe(true);
    expect(await check(load(async () => ({ nope: true })))(item)).toBe(true);
    expect(await check(load(async () => null))(item)).toBe(true);
  });

  it('客户端版本过低：交给安装路径给出本地化提示，这里不重复也不弹窗', async () => {
    const ctx = load(async () => plan([{ id: '5e1c8a02d9b3', kind: 'hub', action: 'install' }], { appUpdateRequired: true, minAppVersion: '1.4.0' }));
    expect(await check(ctx)(item)).toBe(true);
    expect(ctx._modals).toEqual([]);
    expect(ctx._alerts).toEqual([]);
  });

  it('请求预览时带上 Agent 的版本信息', async () => {
    const invoke = vi.fn(async () => plan([]));
    const ctx = load(invoke);
    await check(ctx)(item);
    expect(invoke).toHaveBeenCalledWith('marketplace.agentInstallPlan', expect.objectContaining({ id: 'abcdef123456', version: '1.0.0', published_at: 1, updated_at: 2 }));
  });
});

describe('Agent 详情页的依赖清单', () => {
  const html = (p: Plan | null) => vm.runInContext('_mpAgentDependenciesHtml', load(async () => ({})))(p) as string;

  it('分组展示：Hub 技能（将安装 / 已安装 / 已停用）与随包技能', () => {
    const out = html(plan([
      { id: 'a3f09c21b7e4', name: '依据材料作答', kind: 'hub', action: 'reuse' },
      { id: '5e1c8a02d9b3', name: '发票字段抽取', kind: 'hub', action: 'install' },
      { id: '9b27f4a1c0e6', name: '报销制度预检', kind: 'hub', action: 'blocked_disabled' },
      { id: 'invoice-ocr', name: 'invoice-ocr', kind: 'bundled', action: 'bundled' },
    ]));
    expect(out).toContain('DEP-TITLE');
    expect(out).toContain('GROUP-HUB');
    expect(out).toContain('GROUP-BUNDLED');
    expect(out).toMatch(/依据材料作答[\s\S]*STATE-REUSE/);
    expect(out).toMatch(/发票字段抽取[\s\S]*STATE-INSTALL/);
    expect(out).toMatch(/报销制度预检[\s\S]*STATE-DISABLED/);
    expect(out).toMatch(/invoice-ocr[\s\S]*STATE-BUNDLED/);
  });

  it('没有依赖 / 没有预览结果：不渲染这一区', () => {
    expect(html(plan([]))).toBe('');
    expect(html(null)).toBe('');
  });

  it('每行首个单元格是图标：文字不会被挤进 18px 的图标列', () => {
    const out = html(plan([
      { id: 'a3f09c21b7e4', name: '依据材料作答', kind: 'hub', action: 'reuse' },
      { id: 'invoice-ocr', name: 'invoice-ocr', kind: 'bundled', action: 'bundled' },
      { id: 'builtin:coding', name: 'coding', kind: 'builtin', action: 'builtin' },
    ]));
    // `.agents-detail-list-item` 是 `18px minmax(0,1fr) auto` 三列网格：行内第一个子元素
    // 必须是图标单元，否则 `agents-detail-list-text` 落进 18px 那一列，渲染成一行一两个字。
    const rows = out.match(/<div class="agents-detail-list-item"[\s\S]*?<\/div>/g) ?? [];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toMatch(/^<div class="agents-detail-list-item"[^>]*>\s*<span class="agents-detail-list-icon/);
      expect(row).toContain('agents-detail-list-icon');
      expect(row).toContain('agents-detail-list-text');
    }
  });

  it('内置能力单独一组：具备时「由 CogSeed 提供」，不具备时提示更新', () => {
    const ok = html(plan([{ id: 'builtin:coding', name: 'coding', kind: 'builtin', action: 'builtin' }]));
    expect(ok).toContain('GROUP-BUILTIN');
    expect(ok).toContain('STATE-BUILTIN-OK');
    expect(ok).not.toContain('GROUP-HUB');
    const lack = html(plan([{ id: 'builtin:coding', name: 'coding', kind: 'builtin', action: 'blocked_builtin_unsupported' }]));
    expect(lack).toContain('GROUP-BUILTIN');
    expect(lack).toContain('STATE-BUILTIN');
    expect(lack).not.toContain('STATE-BUILTIN-OK');
  });

  it('只有随包技能时不出现 Hub 分组', () => {
    const out = html(plan([{ id: 'x', name: 'x', kind: 'bundled', action: 'bundled' }]));
    expect(out).toContain('GROUP-BUNDLED');
    expect(out).not.toContain('GROUP-HUB');
  });

  it('名称中的 HTML 被转义', () => {
    const out = html(plan([{ id: 'x', name: '<b>x</b>', kind: 'hub', action: 'install' }]));
    expect(out).not.toContain('<b>x');
    expect(out).toContain('&lt;b>');
  });
});

describe('Agent 详情页的客户端兼容行', () => {
  const html = (item: unknown) => vm.runInContext('_mpAgentCompatibilityHtml', load(async () => ({})))(item) as string;

  it('声明了最低版本：显示「需 CogSeed x.y+」', () => {
    const out = html({ id: 'a', min_app_version: '1.4.0' });
    expect(out).toContain('COMPAT');
    expect(out).toContain('REQ 1.4.0');
  });

  it('兼容旧字段名', () => {
    expect(html({ id: 'a', minAppVersion: '1.2.0' })).toContain('REQ 1.2.0');
  });

  it('没有最低版本（缺席 = 无下限）或没有条目：不渲染', () => {
    expect(html({ id: 'a' })).toBe('');
    expect(html(null)).toBe('');
  });
});
