/**
 * S4 智能体 / 技能首页分组（specs/009-agent-skill-pages FR-001～005）。
 * 只测纯判定：平台组的「已安装在前、未安装在后」拆分与智能体归属判定；
 * 三组的 DOM 顺序与文案由真实客户端验证。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const catalogSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/catalog.js'), 'utf8');
const agentsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');

function loadCatalog(extra: Record<string, unknown> = {}): any {
  const window: any = {};
  const context: any = { window, console, setTimeout, clearTimeout, ...extra };
  vm.createContext(context);
  vm.runInContext(catalogSource, context, { filename: 'catalog.js' });
  return context;
}

function loadAgents(): any {
  const window: any = { addEventListener() {}, removeEventListener() {}, cogseed: { invoke() {} } };
  window.window = window;
  const context: any = {
    window, document: {}, console, setTimeout, clearTimeout,
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
    t: (key: string) => key,
    escapeHtml: (v: string) => String(v),
    normalizeCatalogSource: (s: string) => {
      const v = String(s || '').trim().toLowerCase();
      return v === 'builtin' || v === 'platform' ? 'marketplace' : v;
    },
  };
  vm.createContext(context);
  vm.runInContext(agentsSource, context, { filename: 'agents.js' });
  return context;
}

describe('平台组拆分', () => {
  const split = (installed: unknown, rows: unknown, ctx = loadCatalog()) => ctx.catalogSplitPlatform(installed, rows);

  it('已安装在前；目录里已装过的不再出现在未安装', () => {
    const r = split(
      [{ agent_id: 'a', source: 'marketplace' }],
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    );
    expect(r.installed.map((x: any) => x.agent_id)).toEqual(['a']);
    expect(r.notInstalled.map((x: any) => x.id)).toEqual(['b', 'c']);
  });

  it('原随包内置（seed_source: builtin）的已安装项和普通安装一样算已安装', () => {
    const r = split([{ agent_id: 'doc', source: 'marketplace', seed_source: 'builtin' }], [{ id: 'doc' }]);
    expect(r.installed).toHaveLength(1);
    expect(r.notInstalled).toHaveLength(0);
  });

  it('目录重复、缺 id、被平台停用的行不出现', () => {
    const ctx = loadCatalog({
      HubContentStatus: { isHubContentDisabled: (row: any) => row.hub_status === 'disabled' },
    });
    const r = split([], [{ id: 'x' }, { id: 'x' }, { name: 'no-id' }, { id: 'off', hub_status: 'disabled' }], ctx);
    expect(r.notInstalled.map((x: any) => x.id)).toEqual(['x']);
  });

  it('空输入不抛错', () => {
    const r = split(undefined, null);
    expect(r.installed).toEqual([]);
    expect(r.notInstalled).toEqual([]);
    expect(r.tail).toEqual([]);
  });

  it('本次进页后刚装的留在目录原位，不跳到已安装区（FR-002）', () => {
    const ctx = loadCatalog();
    const r = ctx.catalogSplitPlatform(
      [{ agent_id: 'a' }, { agent_id: 'b' }],
      [{ id: 'c' }, { id: 'b' }, { id: 'd' }, { id: 'a' }],
      (x: any) => x.agent_id,
      new Set(['b']),
    );
    expect(r.installed.map((x: any) => x.agent_id)).toEqual(['a']);
    expect(r.tail.map((x: any) => x.id)).toEqual(['c', 'b', 'd']);
    expect(r.notInstalled.map((x: any) => x.id)).toEqual(['c', 'd']);
    expect(r.kept.get('b')).toEqual({ agent_id: 'b' });
  });
});

describe('刚安装记录', () => {
  const withInstall = (result: boolean) => loadCatalog({
    _mpInstall: async () => result,
    catalogEnsureSignedIn: async () => true,
  });

  it('安装成功记一次高亮；更新不记；离开页面清空', async () => {
    const ctx = withInstall(true);
    vm.runInContext('catalogEnsureSignedIn = async () => true', ctx);
    expect(await ctx.catalogInstall('agent', { id: 'x' })).toBe(true);
    expect(await ctx.catalogInstall('agent', { id: 'u' }, { update: true })).toBe(true);
    expect([...ctx.catalogJustInstalledIds('agent')]).toEqual(['x']);
    expect([...ctx.catalogJustInstalledIds('skill')]).toEqual([]);
    expect(ctx.catalogTakeJustInstalledFlash('agent', 'x')).toBe(true);
    expect(ctx.catalogTakeJustInstalledFlash('agent', 'x')).toBe(false);
    ctx.catalogResetJustInstalled();
    expect(ctx.catalogJustInstalledIds('agent').size).toBe(0);
  });

  it('安装失败不记', async () => {
    const ctx = withInstall(false);
    vm.runInContext('catalogEnsureSignedIn = async () => true', ctx);
    expect(await ctx.catalogInstall('skill', { id: 's' })).toBe(false);
    expect(ctx.catalogJustInstalledIds('skill').size).toBe(0);
  });
});

describe('智能体首页归属', () => {
  const ctx = loadAgents();
  const origin = (a: unknown) => vm.runInContext('_agentCatalogOrigin', ctx)(a) as string;
  const ownedByUser = (a: unknown) => vm.runInContext('_isAgentCustomOwned', ctx)(a) as boolean;

  it('主智能体、外接、平台、自建各归其类', () => {
    expect(origin({ agent_id: 'commander' })).toBe('commander');
    expect(origin({ agent_id: 'cli', source: 'custom', runtime: { kind: 'cli', cli: 'codex' } })).toBe('external');
    expect(origin({ agent_id: 'p', source: 'marketplace' })).toBe('platform');
    expect(origin({ agent_id: 'p2', source: 'builtin' })).toBe('platform');
    expect(origin({ agent_id: 'mine', source: 'custom' })).toBe('own');
  });

  it('只有自建的普通智能体进「我的智能体」，首页不出现', () => {
    expect(ownedByUser({ agent_id: 'mine', source: 'custom' })).toBe(true);
    expect(ownedByUser({ agent_id: 'commander' })).toBe(false);
    expect(ownedByUser({ agent_id: 'p', source: 'marketplace' })).toBe(false);
    expect(ownedByUser({ agent_id: 'cli', source: 'custom', runtime: { kind: 'cli', cli: 'codex' } })).toBe(false);
  });
});

describe('技能页「我的贡献」只在「我的技能」出现（不闪）', () => {
  it('按子视图用样式隐藏，挂载早晚都不影响', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    expect(css).toContain('#skills-grid-view:not([data-catalog-view="mine"]) [data-contribution-mine] { display: none; }');
  });
});
