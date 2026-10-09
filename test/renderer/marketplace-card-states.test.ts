/**
 * Phase 12：目录页卡片状态与本地过滤（specs/010 FR-067 / FR-068 / FR-069 / FR-070）。
 *
 * 渲染层没有模块系统，沿用 `marketplace-install-error.test.ts` 的 vm 装载法：
 * 把脚本跑进一个带桩的上下文，顶层函数即上下文属性，`let` 绑定用 `runInContext` 赋值。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const LABELS: Record<string, string> = {
  'marketplace.state_update_available': '有更新',
  'marketplace.category_uncategorized': '未分类',
  'marketplace.category_unknown': '未知',
  'marketplace.detail_published_at': '发布于 {date}',
  'marketplace.detail_published_unknown': '发布时间未知',
  'marketplace.detail_min_app': '最低兼容 CogSeed {version}',
  'marketplace.detail_min_app_none': '无版本下限',
  'marketplace.action_failed_retry_later': '市场暂时不可用，请稍后重试。',
  'marketplace.load_failed': '加载失败',
  'marketplace.empty': '暂无内容',
  'marketplace.install': '安装',
  'marketplace.installed': '已安装',
  'marketplace.update': '更新',
  'marketplace.version': 'v{version}',
};

function loadMarketplaceRenderer(): any {
  const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '../../src/renderer', rel), 'utf8');
  const invoked: Array<{ channel: string; payload: unknown }> = [];
  const storage = new Map<string, string>();
  const context: any = {
    console,
    clearTimeout: () => {},
    setTimeout: () => 0,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    document: {
      hidden: false,
      activeElement: null,
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: () => {},
      cogseed: {
        invoke: async (channel: string, payload: unknown) => {
          invoked.push({ channel, payload });
          return { list: [], total: 0 };
        },
      },
      Monitor: { error: () => {} },
    },
    Monitor: { error: () => {} },
    _invoked: invoked,
    t: (key: string) => LABELS[key] || key,
    getLang: () => 'zh',
    escapeHtml: (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
    )),
    pickDesc: (item: any) => item?.description_zh || item?.description_en || '',
    pickLocalizedName: (c: any) => c?.name_zh || c?.code || '',
    renderAvatarHtml: () => '<span class="avatar"></span>',
    compareDisplayNames: (a: string, b: string) => a.localeCompare(b),
    normalizeCatalogSource: (s: string) => (s === 'builtin' || s === 'platform' ? 'marketplace' : s),
  };
  vm.createContext(context);
  vm.runInContext(read('modules/user-error.js'), context, { filename: 'user-error.js' });
  vm.runInContext(read('modules/marketplace.js'), context, { filename: 'marketplace.js' });
  return context;
}

/** 最小可用的面板替身：只提供 `_mpRender` 在错误分支前会摸到的选择器。 */
function fakePanel(): { panel: any; body: { innerHTML: string } } {
  const body = { innerHTML: '' };
  const cats = { innerHTML: '', querySelectorAll: () => [] };
  const panel: any = {
    classList: { toggle: () => {} },
    querySelectorAll: () => [],
    querySelector: (sel: string) => {
      if (sel === '[data-mp-body]') return body;
      if (sel === '[data-mp-categories]') return cats;
      return null;
    },
  };
  return { panel, body };
}

function setState(ctx: any, patch: Record<string, unknown>): void {
  const base = {
    view: 'grid',
    tab: 'skill',
    category: '',
    status: '',
    q: '',
    loading: false,
    error: '',
    agents: [],
    skills: [],
    categories: [],
    installing: new Set(),
    installedAgentIds: new Set(),
    installedSkillIds: new Set(),
    installedAgentMeta: new Map(),
    installedSkillMeta: new Map(),
    appVersion: '9.9.9',
  };
  ctx.__nextState = { ...base, ...patch };
  vm.runInContext('_mpState = globalThis.__nextState', ctx, { filename: 'set-state.js' });
}

const SKILL = {
  id: 'a1b2c3d4e5f6',
  name: 'fixture-skill',
  version: '2.0.0',
  category: 'creation',
  published_at: Date.UTC(2026, 8, 1),
  description_zh: '合成夹具',
};

describe('Phase 12 目录页卡片状态与本地过滤', () => {
  describe('⭐ T102 卡片状态「有更新」（FR-067）', () => {
    it('本机实际版本低于目录版本 → 出现「有更新」状态', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {
        installedSkillIds: new Set([SKILL.id]),
        installedSkillMeta: new Map([[SKILL.id, { id: SKILL.id, version: '1.0.0' }]]),
      });

      const html = ctx._mpCardHtml(SKILL, 'zh');

      expect(html).toContain('data-mp-state="update-available"');
      expect(html).toContain('有更新');
    });

    it('本机实际版本已是目录版本 → 没有该状态', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {
        installedSkillIds: new Set([SKILL.id]),
        installedSkillMeta: new Map([[SKILL.id, {
          id: SKILL.id, version: '2.0.0', published_at: SKILL.published_at,
        }]]),
      });

      const html = ctx._mpCardHtml(SKILL, 'zh');

      expect(html).not.toContain('data-mp-state="update-available"');
      expect(html).toContain('已安装');
    });

    it('⚠️ 判不出本机实际版本时不显示「有更新」——不拿目录版本当已装版本', () => {
      const ctx = loadMarketplaceRenderer();
      // 主进程 `installed-version.ts` 判不出时 `version` 缺席（落盘未完成 / 标记损坏）。
      setState(ctx, {
        installedSkillIds: new Set([SKILL.id]),
        installedSkillMeta: new Map([[SKILL.id, { id: SKILL.id }]]),
      });

      const html = ctx._mpCardHtml(SKILL, 'zh');

      expect(html).not.toContain('data-mp-state="update-available"');
    });

    it('未安装的内容不显示「有更新」', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpCardHtml(SKILL, 'zh')).not.toContain('data-mp-state="update-available"');
    });

    it('⚠️ FR-070：Agents tab 的卡片不带该状态', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {
        tab: 'agent',
        installedAgentIds: new Set([SKILL.id]),
        installedAgentMeta: new Map([[SKILL.id, { id: SKILL.id, version: '1.0.0' }]]),
      });

      const html = ctx._mpCardHtml(SKILL, 'zh');

      expect(html).not.toContain('data-mp-state="update-available"');
      // 但「更新」按钮这一既有行为仍在——本轮没有改动 Agents tab。
      expect(html).toContain('更新');
    });
  });

  describe('⭐ T104 搜索与分类只做本地过滤（FR-068）', () => {
    it('Skill 目录的取行请求不携带 q 与 category', async () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, { category: 'creation', q: '报告' });

      await ctx._mpLoadListingsPage('skill', { append: false, page: 1 });

      const call = ctx._invoked.find((x: any) => x.channel === 'marketplace.listSkills');
      expect(call).toBeTruthy();
      expect(call.payload.q).toBeNull();
      expect(call.payload.category).toBeNull();
    });

    it('⚠️ FR-070：Agents 的取行请求照旧带 q 与 category', async () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, { tab: 'agent', category: 'creation', q: '报告' });

      await ctx._mpLoadListingsPage('agent', { append: false, page: 1 });

      const call = ctx._invoked.find((x: any) => x.channel === 'marketplace.listAgents');
      expect(call.payload.q).toBe('报告');
      expect(call.payload.category).toBe('creation');
    });

    it('搜索词在本地按名称 / ID / 说明过滤', () => {
      const ctx = loadMarketplaceRenderer();
      const rows = [
        { id: 'aaa', name: '周报助手', category: 'creation' },
        { id: 'bbb', name: 'translator', description_zh: '翻译长文', category: 'creation' },
        { id: 'ccc', name: 'other', category: 'creation' },
      ];
      setState(ctx, { skills: rows, q: '翻译' });
      expect(ctx._mpVisibleItems().map((x: any) => x.id)).toEqual(['bbb']);

      setState(ctx, { skills: rows, q: '周报' });
      expect(ctx._mpVisibleItems().map((x: any) => x.id)).toEqual(['aaa']);

      setState(ctx, { skills: rows, q: 'CCC' });
      expect(ctx._mpVisibleItems().map((x: any) => x.id)).toEqual(['ccc']);
    });

    it('分类在本地过滤，且缺分类的条目只在「全部」下出现', () => {
      const ctx = loadMarketplaceRenderer();
      const rows = [
        { id: 'aaa', name: 'a', category: 'creation' },
        { id: 'bbb', name: 'b' },
      ];
      setState(ctx, { skills: rows, category: 'creation' });
      expect(ctx._mpVisibleItems().map((x: any) => x.id)).toEqual(['aaa']);

      setState(ctx, { skills: rows, category: '' });
      expect(ctx._mpVisibleItems().map((x: any) => x.id)).toEqual(['aaa', 'bbb']);
    });

    it('本地过滤不改变缓存键：换分类 / 换搜索词仍指向同一份目录', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, { category: '', q: '' });
      const bare = ctx._mpCacheKeyFor('skill');
      setState(ctx, { category: 'creation', q: '报告' });
      expect(ctx._mpCacheKeyFor('skill')).toBe(bare);
      // agent 仍按 (kind, cat, status, q) 分槽。
      expect(ctx._mpCacheKeyFor('agent')).not.toBe(ctx._mpCacheKeyFor('agent', { cat: '', q: '' }));
    });
  });

  describe('⭐ T104 详情页版本 / 发布时间 / 最低兼容版本（FR-068）', () => {
    it('三项都有取值时各自成文', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpPublishedAtLabel(SKILL)).toContain('发布于');
      expect(ctx._mpMinAppLabel({ min_app_version: '1.2.0' })).toBe('最低兼容 CogSeed 1.2.0');
    });

    it('⚠️ 最低兼容版本**字段缺席 = 无下限**，不是留空（FR-005）', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpMinAppLabel({})).toBe('无版本下限');
    });

    it('⚠️ 没有发布时间就说未知，不猜一个日期', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpPublishedAtLabel({})).toBe('发布时间未知');
      expect(ctx._mpPublishedAtLabel({ published_at: 0 })).toBe('发布时间未知');
    });

    it('published_at 缺席时退到 updated_at', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpPublishedAtLabel({ updated_at: Date.UTC(2026, 0, 2) })).toContain('发布于');
    });
  });

  describe('⭐ T104 category 缺省列为未分类（FR-068）', () => {
    it('Skill 目录下缺分类显示「未分类」', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpCategoryLabel('', 'zh')).toBe('未分类');
    });

    it('⚠️「字段缺席」与「取值不认得」是两句话，不共用', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, { categories: [] });
      expect(ctx._mpCategoryLabel('', 'zh')).toBe('未分类');
      expect(ctx._mpCategoryLabel('no-such-code', 'zh')).toBe('未知');
    });

    it('⚠️ FR-070：Agents tab 的既有留空行为不变', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, { tab: 'agent' });
      expect(ctx._mpCategoryLabel('', 'zh')).toBe('');
    });
  });

  describe('⭐ T105 Hub 不可达时显示「市场暂时不可用」（FR-069，C7）', () => {
    it('Skill 目录显示该文案，且不把原始错误抛给用户', () => {
      const ctx = loadMarketplaceRenderer();
      const { panel, body } = fakePanel();
      ctx.document.getElementById = () => panel;
      setState(ctx, { error: 'FetchError: connect ECONNREFUSED 10.0.0.1:443' });

      ctx._mpRender();

      expect(body.innerHTML).toContain('市场暂时不可用');
      expect(body.innerHTML).not.toContain('ECONNREFUSED');
      expect(body.innerHTML).not.toContain('10.0.0.1');
    });

    it('面板不可用不影响已安装内容：渲染不触碰安装状态', () => {
      const ctx = loadMarketplaceRenderer();
      const { panel } = fakePanel();
      ctx.document.getElementById = () => panel;
      const installed = new Set(['a1b2c3d4e5f6']);
      setState(ctx, { error: 'hub down', installedSkillIds: installed });

      ctx._mpRender();

      expect(vm.runInContext('_mpState.installedSkillIds.size', ctx)).toBe(1);
      expect(installed.has('a1b2c3d4e5f6')).toBe(true);
    });

    it('⚠️ FR-070：Agents tab 的既有「加载失败: 原因」不变', () => {
      const ctx = loadMarketplaceRenderer();
      const { panel, body } = fakePanel();
      ctx.document.getElementById = () => panel;
      setState(ctx, { tab: 'agent', error: 'boom' });

      ctx._mpRender();

      expect(body.innerHTML).toContain('加载失败');
      expect(body.innerHTML).toContain('boom');
    });
  });

  describe('⭐ T106 Agents / 开源项目两个 tab 未被改动（FR-070）', () => {
    it('本地过滤只挂 Skill：agent 与 oss 都不走这条', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      expect(ctx._mpUsesLocalFilter('skill')).toBe(true);
      expect(ctx._mpUsesLocalFilter('agent')).toBe(false);
      expect(ctx._mpUsesLocalFilter('oss')).toBe(false);
    });

    it('开源项目仍用自己的状态与自己的取行路径', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, { tab: 'oss', ossQ: 'x', q: '' });
      // oss 的搜索词存在 ossQ 上，与 agent/skill 的 q 互不影响（既有隔离）。
      expect(vm.runInContext('_mpState.ossQ', ctx)).toBe('x');
      expect(ctx._mpCacheKeyFor('skill')).not.toContain('x');
    });

    it('⚠️ 新增的卡片状态不会渗进 oss 卡片：它根本不经过 _mpCardHtml', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../src/renderer/modules/marketplace.js'), 'utf8',
      );
      const oss = src.slice(src.indexOf('function _mpRenderOss'));
      const ossBody = oss.slice(0, oss.indexOf('\nfunction ', 10));
      expect(ossBody).not.toContain('_mpCardHtml');
      expect(ossBody).not.toContain('update-available');
    });
  });

  describe('⭐ FR-034 打开目录页也是一个检查触发时机', () => {
    it('打开面板会转达一次检查请求，且不带任何参数', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});

      ctx._mpRequestServerCheck();

      const call = ctx._invoked.find((x: any) => x.channel === 'marketplace.requestCheck');
      expect(call).toBeTruthy();
      expect(call.payload).toBeUndefined();
    });

    it('⚠️ 检查失败不打断用户：通道抛错也不向外传播', () => {
      const ctx = loadMarketplaceRenderer();
      setState(ctx, {});
      ctx.window.cogseed.invoke = () => Promise.reject(new Error('hub down'));

      expect(() => ctx._mpRequestServerCheck()).not.toThrow();

      ctx.window.cogseed.invoke = () => { throw new Error('channel missing'); };
      expect(() => ctx._mpRequestServerCheck()).not.toThrow();
    });
  });
});
