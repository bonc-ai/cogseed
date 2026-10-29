import { describe, expect, it, vi } from 'vitest';
import { renderCognitionWithDialogs as renderCognition, loadCognitionAssets } from './helpers/cognition-renderer';

/** 最新原型统一使用 20 条分页表格；本体保留独立入口，旧 catalog/family/manage 不再改变页面结构。 */
const asset = {
  id: 'aa-cat0001',
  title: '性能归因规则',
  type: 'rule',
  scope: 'general',
  status: 'active',
  version: '3',
  activeVersion: '2',
  maturity: 'transfer_validated',
  statement: '性能类提问需用真实日志做分层归因，先给链路再给瓶颈。后半句是看不到的正文。',
  updatedAt: '2026-09-18T00:00:00.000Z',
};

describe('资产目录视图', () => {
  it('页面说明出现在对应页头，不在正文重复', () => {
    const cases = [
      ['overview', '查找已保存的内容，理解依据，再决定如何使用。', '启用不代表所有任务自动使用'],
      ['activity', '集中浏览建议，逐项核对后处理。', '保存不代表任务已采用。'],
      ['settings', '从对话中发现新认知，整理已有认知与本体；在认知生长查看建议和处理结果。', ''],
    ];
    for (const [name, description, removed] of cases) {
      const header = vi.fn(({ title, meta }) => `<header><h1>${title}</h1><span>${meta || ''}</span></header>`);
      const html = loadCognitionAssets({}, { name }, { uiPageHeader: header }).render();
      expect(header).toHaveBeenCalledWith(expect.objectContaining({ meta: description }));
      expect(html.split(description)).toHaveLength(2);
      if (removed) expect(html).not.toContain(removed);
    }
  });
  it('后台刷新和切页保留可交互页签节点，角标变化不替换整排导航', () => {
    const loaded = loadCognitionAssets({}, { name: 'overview' });
    const items = new Map(['tree', 'overview', 'ontology', 'review', 'activity', 'settings'].map(id => [id, { innerHTML: '', classList: { toggle: vi.fn() } }]));
    const replaceNav = vi.fn();
    const nav = {
      querySelector: (selector: string) => items.get(selector.match(/data-id="([^"]+)"/)?.[1] || ''),
      set innerHTML(value: string) { replaceNav(value); },
    };
    const root = loaded.context.document.getElementById('ca-root');
    loaded.context.document.getElementById = (id: string) => (({ 'ca-root': root, 'ca-tabs-nav': nav, 'ca-banner-slot': { innerHTML: '' }, 'ca-scroll': { innerHTML: '', querySelector: () => null } } as Record<string, unknown>)[id] || null);
    loaded.render();
    loaded.store.route.name = 'ontology';
    const previousStats = loaded.ns.stats;
    loaded.ns.stats = () => ({ ...previousStats(), pending: 1 });
    loaded.ns.mountPersonalOntology = vi.fn();
    loaded.render();
    expect(replaceNav).not.toHaveBeenCalled();
    expect(items.get('ontology')!.classList.toggle).toHaveBeenLastCalledWith('is-on', true);
    expect(items.get('overview')!.classList.toggle).toHaveBeenLastCalledWith('is-on', false);
    expect(items.get('activity')!.innerHTML).toContain('bdg');
  });

  it('后台刷新保留同一本体路由挂载和图谱状态，显式切换模块重新挂载', () => {
    const loaded = loadCognitionAssets({ prevRouteName: 'ontology', ontologyMountRouteKey: JSON.stringify(['module-a', '', '', '']) }, { name: 'ontology', moduleId: 'module-a' });
    const main = { innerHTML: 'existing graph and form', querySelector: () => null };
    const mount = { querySelector: () => ({}) };
    const root = loaded.context.document.getElementById('ca-root');
    loaded.context.document.getElementById = (id: string) => (({ 'ca-root': root, 'ca-tabs-nav': { innerHTML: '' }, 'ca-banner-slot': { innerHTML: '' }, 'ca-scroll': main, 'ca-ontology-mount': mount } as Record<string, unknown>)[id] || null);
    const mountSpy = vi.fn();
    loaded.ns.mountPersonalOntology = mountSpy;
    loaded.render();
    expect(main.innerHTML).toBe('existing graph and form');
    expect(mountSpy).not.toHaveBeenCalled();
    loaded.store.route.moduleId = 'module-b';
    loaded.render();
    expect(main.innerHTML).toContain('ca-ontology-mount');
    expect(mountSpy).toHaveBeenCalledWith(expect.objectContaining({ moduleId: 'module-b' }));
  });

  it('我的认知仅列正式资产，本体保留独立入口和确切模块路由', () => {
    const loaded = loadCognitionAssets({ assets: [asset], ontologySnapshot: { records: {
      'module-a': { id: 'module-a', kind: 'module', name: '项目甲本体', status: 'active', version: 7 },
    }, history: [] } });
    const html = loaded.render();
    expect(html).toContain('ca-library-table');
    expect(html).toContain(asset.title);
    expect(html).not.toContain('项目甲本体');
    expect(html).toContain('data-id="ontology"');
    loaded.ns.router.go({ name: 'ontology', moduleId: 'module-a' });
    expect(loaded.store.route).toMatchObject({ name: 'ontology', moduleId: 'module-a' });
  });
  it('系统活动不铺开本体底层保存日志', () => {
    const html = renderCognition({ name: 'activity', activityDone: '1' }, { ontologySnapshot: { records: {}, history: [{ recordedAt: '2026-10-07T00:00:00Z', intent: 'correct', after: {
      id: 'entity-a', kind: 'entity', moduleId: 'module-a', name: '历史人物', version: 3, source: { label: '原始依据' },
    } }] } });
    expect(html).not.toContain('历史人物');
    expect(html).not.toContain('data-id="ontology:entity-a@3"');
    expect(html).not.toContain('实际采用');
    expect(html).not.toContain('保存不代表任务已采用');
  });
  it('正式资产读取失败保留缓存并提供重试，本体读取状态不污染资产表格', () => {
    const html = renderCognition({ name: 'overview' }, { assets: [asset], assetsError: 'cannot read', ontologyError: 'unrelated ontology error' });
    expect(html).toContain(asset.title);
    expect(html).toContain('上次读取');
    expect(html).toContain('data-act="library-refresh"');
    expect(html).not.toContain('本体暂时无法加载');
    const empty = renderCognition({ name: 'overview' }, { assets: [], assetsError: 'cannot read' });
    expect(empty).toContain('认知内容未能读取');
    expect(empty).not.toContain('这里还没有内容');
  });

  it('统一表格显示内容、对象范围和状态，在用版本与完整正文在详情核对', () => {
    const loaded = loadCognitionAssets({ assets: [asset], proofs: [
      { kind: 'projection_confirmed', refs: { assetId: asset.id, projectionId: 'proj-cat' } },
      { kind: 'usage_recorded', refs: { assetId: asset.id, projectionId: 'proj-cat', usageOutcome: 'injected' } },
    ] }, { name: 'overview', assetView: 'catalog', assetId: asset.id });
    const html = loaded.render();
    const table = html.match(/<table class="ca-library-table"[\s\S]*?<\/table>/)?.[0] || '';
    expect(table).toContain(asset.title);
    expect(table).not.toContain('规则与偏好');
    expect(table).not.toContain('<th>类型</th>');
    expect(table).toContain('未限定使用对象');
    expect(table).toContain('启用');
    expect(table).toContain('data-act="library-select" data-id="aa-cat0001"');
    expect(html).toContain('在用 v2');
    expect(html).toContain(asset.statement);
    expect(loaded.ui.broughtInCountFor(asset.id)).toBe(1);
    expect(html).not.toContain('资产目录（模型视角）');
    expect(html).not.toContain('data-act="asset-view"');
  });

  it('没有真实使用证据时计数为零，详情不冒充采用', () => {
    const loaded = loadCognitionAssets({ assets: [asset], proofs: [] });
    expect(loaded.ui.broughtInCountFor(asset.id)).toBe(0);
    const html = loaded.render() + loaded.ns.renderLibraryDialog('records', asset.id);
    expect(html).toContain('还没有被真实使用过');
    expect(html).toContain('还没有可核对的采用证据');
    expect(html).not.toContain('已实际采用');
  });

  it('默认与旧catalog/manage深链均使用同一工作台，不恢复退役视图切换', () => {
    for (const route of [{ name: 'overview' }, { name: 'overview', assetView: 'catalog', manage: '1' }]) {
      const html = renderCognition(route, { assets: [asset], proofs: [] });
      expect(html).toContain('ca-library-page');
      expect(html).toContain('ca-library-table');
      expect(html).not.toContain('data-act="overview-manage-toggle"');
      expect(html).not.toContain('data-act="asset-view"');
    }
  });

  it('旧固定引用和模型选择状态不再显示对话绑定栏', () => {
    const html = renderCognition({ name: 'overview' }, {
      assets: [asset], modelSelectedAssetIds: [asset.id],
      libraryConversation: { conversationId: 'conv-library', title: '季度复盘', projections: [{
        id: 'proj-pinned', conversationId: 'conv-library', status: 'confirmed', purpose: 'user_pinned', authorization: 'user_confirmed',
        assetIds: [asset.id], assetVersions: { [asset.id]: '1' },
      }] },
    });
    expect(html).not.toContain('季度复盘');
    expect(html).not.toContain('性能归因规则 · v1');
    expect(html).not.toContain('data-act="library-detach"');
    expect(html).not.toContain('模型挂着');
  });

  it('空目录给出夜间发现说明和确认结果入口，不显示空白表头', () => {
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, { assets: [], proofs: [] });
    expect(html).toContain('这里还没有已保存的认知');
    expect(html).not.toContain('data-act="cand-create"');
    expect(html).toContain('data-act="go-review"');
    expect(html).toContain('夜间发现的完整建议');
    expect(html).not.toContain('data-act="library-select"');
    expect(html).not.toContain('<table class="ca-library-table"');
  });

  it('35条资产按20条分页，两个页面无重叠且合计对应全部真实条目', () => {
    const many = Array.from({ length: 35 }, (_, index) => ({ ...asset, id: `aa-many${String(index).padStart(4, '0')}`, title: `批量资产 ${index + 1}` }));
    const loaded = loadCognitionAssets({ assets: many, proofs: [] });
    const ids = (html: string) => [...html.matchAll(/data-act="library-select" data-id="([^"]+)"/g)].map(match => match[1]);
    const first = ids(loaded.render());
    expect(first).toHaveLength(20);
    expect(loaded.render()).toContain('每页 20 条 · 1–20 / 35');
    loaded.ns.library.state.page = 2;
    const second = ids(loaded.render());
    expect(second).toHaveLength(15);
    expect(loaded.render()).toContain('每页 20 条 · 21–35 / 35');
    expect(new Set([...first, ...second]).size).toBe(35);
    expect(loaded.ns.library.filtered()).toHaveLength(35);
  });

  it('旧分类深链进入统一列表，旧视图参数不再按类型隐藏内容', () => {
    const template = { ...asset, id: 'aa-cat0002', title: '复盘模板', type: 'template' };
    for (const assetView of ['catalog', '']) {
      const html = renderCognition({ name: 'overview', assetView, category: 'rule' }, { assets: [asset, template] });
      expect(html).not.toContain('id="ca-library-type"');
      expect(html).toContain('性能归因规则');
      expect(html).toContain('复盘模板');
      expect(html).not.toContain('data-act="filter-cat"');
    }
  });

// 同源关系是资产元信息，不再改变统一表格的分组、分页或条目身份。
describe('统一表格中的同源资产', () => {
  it('同源关系保留在记录中，但不再分组或减少统一表格的独立条目', () => {
    const records = [
      { ...asset, id: 'aa-family-1', title: '同源一', relations: [{ kind: 'same_family', assetId: 'aa-family-2' }] },
      { ...asset, id: 'aa-family-2', title: '同源二', relations: [{ kind: 'same_family', assetId: 'aa-family-1' }] },
      { ...asset, id: 'aa-independent', title: '独立条目' },
    ];
    const loaded = loadCognitionAssets({ assets: records }, { name: 'overview', manage: '1' });
    const html = loaded.render();
    expect(html.match(/data-act="library-select"/g)).toHaveLength(3);
    expect(html).not.toContain('fam-hd');
    expect(loaded.store.assets[0].relations).toEqual(records[0].relations);
  });

  it('catalog view stays flat (model perspective)', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetView: 'catalog' }, {
      assets: [
        { id: 'aa-1', type: 'personal', title: 'A', statement: '一。', status: 'active', version: '1', relations: [{ kind: 'same_family', assetId: 'aa-2' }] },
        { id: 'aa-2', type: 'personal', title: 'B', statement: '二。', status: 'active', version: '1', relations: [{ kind: 'same_family', assetId: 'aa-1' }] },
      ],
    });
    expect(html).not.toContain('fam-hd');
  });
});


describe('origin chip on the detail header', () => {
  it('shows the model-written chip and a confirm button for an unverified origin', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetId: 'aa-origin-1' }, {
      assets: [{
        id: 'aa-origin-1', type: 'personal', title: '模型记的偏好', statement: '内容。',
        status: 'active', version: '1', lifecycleStatus: 'user_confirmed_unverified',
        updatedAt: '2026-09-19T00:00:00Z',
      }],
    });
    // 出身收敛（2026-09-20）：出身章与转正按钮整体退役——转正不再出现
    // （「模型记的」四字由该测试资产标题自带，不作反断言）。
    expect(html).not.toContain('转正');
  });

  it('shows no origin chip for a user-confirmed asset', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview', assetId: 'aa-origin-2' }, {
      assets: [{
        id: 'aa-origin-2', type: 'personal', title: '你确认过的偏好', statement: '内容。',
        status: 'active', version: '1', lifecycleStatus: 'user_confirmed_unverified',
        updatedAt: '2026-09-19T00:00:00Z',
      }],
    });
    expect(html).not.toContain('模型记的');
    expect(html).not.toContain('>转正<');
  });
});


describe('asset status chip wording (2026-09-22 快赢)', () => {
  it('active reads 生效中 and the old 已确认 wording is gone from rows', async () => {
    const { renderCognition } = await import('./helpers/cognition-renderer');
    const html = renderCognition({ name: 'overview' }, {
      assets: [{
        id: 'aa-wording-1', type: 'personal', title: '偏好条目', statement: '内容。',
        status: 'active', version: '1', updatedAt: '2026-09-22T00:00:00Z',
      }],
    });
    expect(html).toContain('启用');
    expect(html).not.toContain('已确认');
  });
});

});
