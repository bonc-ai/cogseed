import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

// Exercise the public uiSelect → hydrateUiFormSelects → page callback contract.
// Browser layout and body-portal coordinates require separate Electron evidence.
function filterFixture() {
  const mounts: any[] = [];
  const loaded = loadCognitionAssets({ assets: [{ id: 'a', type: 'cognition', status: 'active', title: '规则', contentCategory: 'rule' }, { id: 'b', type: 'cognition', status: 'active', title: '方法', contentCategory: 'method' }] }, { name: 'overview' }, {
    _aiSelectMount: (host: any, options: any) => {
      const trigger = { setAttribute: vi.fn(), focus: vi.fn() };
      const label = { id: '' };
      const api = { el: { querySelector: (selector: string) => selector === '.ai-select-trigger' ? trigger : label, closest: () => ({ dataset: { libraryFilterKey: host.key } }) }, close: vi.fn(), destroy: vi.fn(), setValue: vi.fn(), options, trigger };
      mounts.push(api); return api;
    },
  });
  const html = loaded.render();
  const hosts = Array.from(html.matchAll(/id="(ca-library-filter-[^"]+)" data-ui-select data-ui-select-config="([^"]+)"/g)).map((match: any) => ({
    id: match[1], key: match[1].replace('ca-library-filter-', ''), dataset: { uiSelectConfig: match[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') },
  }));
  const root = { querySelectorAll: () => hosts };
  loaded.ns.library.hydrateFilters(root);
  return { ...loaded, mounts, html };
}

describe('我的认知复用共享选择组件', () => {
  it('四个筛选从页面配置挂载共享组件，公开选择回调重置分页和当前选择', async () => {
    const loaded = filterFixture();
    expect(loaded.mounts).toHaveLength(4);
    expect(loaded.html).not.toContain('ca-library-filter-popover');
    expect(loaded.mounts.map(api => api.options.options.length)).toEqual([6, 7, 2, 3]);
    loaded.ns.library.state.page = 5;
    await loaded.mounts[1].options.onChange('method');
    expect(loaded.ns.library.state).toMatchObject({ contentCategory: 'method', page: 1 });
    expect(loaded.ns.library.filtered().map((item: any) => item.id)).toEqual(['b']);
    expect(loaded.store.route.assetId).toBe('');
  });

  it('选择后等新页面挂载再返回筛选焦点，不停留在已移除的旧按钮', async () => {
    const loaded = filterFixture();
    const freshTrigger = { focus: vi.fn() };
    await loaded.mounts[1].options.onChange('method');
    const oldGet = loaded.context.document.getElementById;
    loaded.context.document.getElementById = (id: string) => id === 'ca-library-filter-contentCategory'
      ? { querySelector: () => freshTrigger } : oldGet(id);
    loaded.context.document.querySelector = () => null;
    const page = { dataset: { librarySelected: 'b' }, querySelector: () => null, querySelectorAll: () => [] };
    loaded.ns.library.restoreRenderState({ querySelector: () => page }, null);
    expect(freshTrigger.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(loaded.mounts[1].trigger.focus).not.toHaveBeenCalled();
    loaded.ns.library.restoreRenderState({ querySelector: () => page }, { key: 'b', field: { filterKey: 'contentCategory' } });
    expect(freshTrigger.focus).toHaveBeenCalledTimes(2);
  });

  it('未保存编辑取消离开会恢复共享选择值，保留分类和详情草稿', async () => {
    const loaded = filterFixture();
    loaded.ns.library.state.dirty = true;
    loaded.store.assetEditDrafts = { a: { statement: '未保存内容', contentCategory: 'rule' } };
    loaded.store.route.assetId = 'a';
    loaded.ns.confirmUser = vi.fn(async () => false);
    await loaded.mounts[1].options.onChange('method');
    expect(loaded.mounts[1].setValue).toHaveBeenCalledWith('');
    expect(loaded.ns.library.state.contentCategory).toBe('');
    expect(loaded.store.route.assetId).toBe('a');
    expect(loaded.store.assetEditDrafts.a.statement).toBe('未保存内容');
  });

  it('数据刷新或导航重绘前关闭共享弹层，避免body留下旧listbox或事件监听', () => {
    const loaded = filterFixture();
    loaded.render();
    for (const api of loaded.mounts) expect(api.destroy).toHaveBeenCalledOnce();
    loaded.ns.library.closeFilters();
    for (const api of loaded.mounts) expect(api.destroy).toHaveBeenCalledOnce();
  });
});
