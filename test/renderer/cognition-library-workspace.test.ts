import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const asset = (id: string, extra = {}) => ({ id, type: 'fact', title: `认知 ${id}`, statement: `正文 ${id}`, scope: 'general', status: 'active', version: '7', activeVersion: '7', createdAt: '2026-10-01T01:00:00Z', evidenceRefs: [], ...extra });
const click = (act: string, id = '') => ({ dataset: { act, id }, disabled: false });
const tableIds = (html: string) => [...html.matchAll(/<tr role="button"[^>]*data-act="library-select"[^>]*data-id="([^"]+)"/g)].map(match => match[1]);

describe('我的认知列表工作台', () => {
  it('通过真实输入控制器搜索标题、正文和可读范围，重置分页且不预选详情', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('title', { title: '项目验收' }), asset('body', { statement: '先检查证据链' }), asset('scope', { scopePolicy: { workspaceIds: ['ws-product'] } })], assetScopeOptions: { status: 'ready', agents: [], spaces: [{ space_id: 'ws-product', name: '产品工作区' }] } }, { name: 'overview' });
    for (const [query, expected] of [['项目验收', 'title'], ['证据链', 'body'], ['产品工作区', 'scope']]) {
      loaded.ns.library.state.page = 5;
      expect(await loaded.ns.library.handleInput({ target: { id: 'ca-library-search', value: query } })).toBe(true);
      expect(loaded.ns.library.state.page).toBe(1);
      expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual([expected]);
      expect(tableIds(loaded.render())).toEqual([expected]);
      expect(loaded.store.route.assetId).toBe('');
    }
  });

  it('新认知与历史类型混合显示，分类只是目录筛选且状态筛选保留', async () => {
    const types = ['cognition', 'personal', 'rule', 'template', 'skill_method', 'fact'];
    const assets = types.flatMap(type => ['active', 'paused', 'archived', 'deleted'].map(status => asset(`${type}-${status}`, { type, status })));
    const loaded = loadCognitionAssets({ assets: [...assets, asset('purged', { status: 'purged' }), asset('revoked', { status: 'revoked' }), asset('unsupported', { type: 'experience' })] }, { name: 'overview', category: 'fact' });
    expect(loaded.ns.library.filtered()).toHaveLength(12);
    const html = loaded.render();
    expect(html).not.toContain('data-library-filter="type"');
    expect(html).not.toContain('<th>类型</th>');
    expect(html).not.toContain('事实与知识');
    expect(html).toContain('data-library-filter-key="scope"');
    const filters = html.slice(html.indexOf('<div class="ca-library-filters"'), html.indexOf('<div class="ca-library-layout"'));
    expect(filters.match(/data-ui-select /g)).toHaveLength(4);
    expect(filters).not.toContain('<select');
    expect(filters).toContain('ca-library-filter-contentCategory');
    expect(filters).not.toContain('ca-library-filter-popover');
    for (const status of ['active', 'paused', 'archived', 'deleted']) {
      await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'status' }, value: status } });
      expect(loaded.ns.library.filtered()).toHaveLength(6);
      expect(loaded.ns.library.filtered().every((a: any) => a.status === status)).toBe(true);
    }
    await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'status' }, value: 'all' } });
    expect(loaded.ns.library.filtered()).toHaveLength(24);
  });

  it('中文输入法组合输入期间不重绘或导航，确认文字后再执行搜索', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a', { title: '项目验收' })] }, { name: 'overview' });
    const go = vi.spyOn(loaded.ns.router, 'go');
    await loaded.ns.library.handleInput({ target: { id: 'ca-library-search', value: 'xiang' }, isComposing: true });
    expect(go).not.toHaveBeenCalled();
    expect(loaded.ns.library.state.query).toBe('');
    await loaded.ns.library.handleInput({ target: { id: 'ca-library-search', value: '项目' }, isComposing: false });
    expect(go).toHaveBeenCalledOnce();
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['a']);
  });

  it('范围筛选保持明确禁止的空数组限制，并能限定真实工作区', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('open'), asset('blocked', { scopePolicy: { agentIds: [] } }), asset('workspace', { scopePolicy: { workspaceIds: ['ws-a'] } })] }, { name: 'overview' });
    await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'scope' }, value: 'restricted' } });
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['blocked', 'workspace']);
    await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'scope' }, value: 'ws-a' } });
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['workspace']);
  });

  it('最近修改、名称和真实去重带入次数排序不会将重复回执多算', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a', { title: 'A2', updatedAt: '2026-10-03' }), asset('b', { title: 'A10', updatedAt: '2026-10-05' }), asset('c', { title: 'A1', updatedAt: '2026-10-04' })], proofs: [
      { id: 'one', kind: 'projection_confirmed', occurredAt: '2026-10-01', refs: { assetId: 'a', projectionId: 'pr-one' } },
      { id: 'duplicate', kind: 'usage_recorded', occurredAt: '2026-10-02', refs: { assetId: 'a', projectionId: 'pr-one', usageOutcome: 'agent_read' } },
      { id: 'two', kind: 'projection_confirmed', occurredAt: '2026-10-03', refs: { assetId: 'b', projectionId: 'pr-two' } },
      { id: 'three', kind: 'usage_recorded', occurredAt: '2026-10-04', refs: { assetId: 'b', projectionId: 'pr-three', usageOutcome: 'injected' } },
    ] }, { name: 'overview' });
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['b', 'c', 'a']);
    await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'sort' }, value: 'name' } });
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['c', 'a', 'b']);
    await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'sort' }, value: 'used' } });
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['b', 'a', 'c']);
  });

  it('20条分页不预选详情，过滤后页码回到有效范围', async () => {
    const loaded = loadCognitionAssets({ assets: Array.from({ length: 45 }, (_, i) => asset(String(i).padStart(2, '0'))) }, { name: 'overview' });
    expect(tableIds(loaded.render())).toHaveLength(20);
    await loaded.ns.library.handleClick(click('library-page', '1'));
    expect(tableIds(loaded.render())).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 20).padStart(2, '0')));
    expect(loaded.store.route.assetId).toBe('');
    await loaded.ns.library.handleClick(click('library-page', '1'));
    expect(tableIds(loaded.render())).toEqual(['40', '41', '42', '43', '44']);
    await loaded.ns.library.handleInput({ target: { id: 'ca-library-search', value: '正文 44' } });
    expect(tableIds(loaded.render())).toEqual(['44']);
    expect(loaded.ns.library.state.page).toBe(1);
  });

  it('旧会话绑定数据不再生成状态栏或撤销入口', async () => {
    const detach = vi.fn(async () => {});
    const loaded = loadCognitionAssets({ assets: [asset('a', { title: '冻结规则' }), asset('b', { title: '冻结模板' })], libraryConversation: { conversationId: 'chat-a', title: '验收对话', projections: [{ id: 'projection-real', status: 'confirmed', purpose: 'user_pinned', authorization: 'user_confirmed', assetIds: ['a', 'b'], assetVersions: { a: '2', b: '4' } }] } }, { name: 'overview' });
    const html = loaded.render();
    expect(html).not.toContain('ca-library-conversation');
    expect(html).not.toContain('ca-library-binding');
    expect(await loaded.ns.library.handleClick(click('library-detach', 'projection-real'))).toBe(false);
    expect(detach).not.toHaveBeenCalled();
  });

  it('资产读取失败展示失败重试，保留旧列表且不冒充空库', () => {
    const failed = loadCognitionAssets({ assets: [], assetsError: 'storage unavailable' }, { name: 'overview' }).render();
    expect(failed).toContain('认知内容未能读取');
    expect(failed).toContain('data-act="library-refresh"');
    expect(failed).not.toContain('这里还没有已保存的认知');
    const cached = loadCognitionAssets({ assets: [asset('cached')], assetsError: 'storage unavailable' }, { name: 'overview' }).render();
    expect(tableIds(cached)).toEqual(['cached']);
    expect(cached).toContain('role="alert"');
    expect(cached).toContain('上次读取');
  });

  it('取消放弃草稿时选择与筛选均不导航，保留输入和当前条目', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a'), asset('b')], assetEditDrafts: { a: { statement: '未保存正文' } } }, { name: 'overview', assetId: 'a', assetEdit: '1' });
    await loaded.ns.library.handleInput({ target: { id: 'edit-body', dataset: {}, closest: () => ({}) } });
    loaded.ns.confirmUser = vi.fn(async () => false);
    loaded.ns.router.go = vi.fn();
    await loaded.ns.library.handleClick(click('library-select', 'b'));
    const search = { id: 'ca-library-search', value: '尝试切换' };
    await loaded.ns.library.handleInput({ target: search });
    expect(loaded.ns.router.go).not.toHaveBeenCalled();
    expect(loaded.ns.library.state.dirty).toBe(true);
    expect(loaded.store.assetEditDrafts.a.statement).toBe('未保存正文');
    expect(search.value).toBe('');
    expect(loaded.store.route.assetId).toBe('a');
  });

  it('窄屏选择打开抽屉，键盘边界循环且Esc关闭后恢复原行焦点', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a'), asset('b')] }, { name: 'overview' }, { matchMedia: () => ({ matches: true }) });
    expect(loaded.render()).not.toContain('is-drawer-open');
    await loaded.ns.library.handleClick(click('library-select', 'b'));
    expect(loaded.render()).toContain('role="dialog" aria-modal="true"');
    const first = { focus: vi.fn(), getClientRects: () => [1] }, last = { focus: vi.fn(), getClientRects: () => [1] };
    const row = { dataset: { act: 'library-select', id: 'b' }, focus: vi.fn() };
    loaded.context.document.querySelector = (selector: string) => selector === '.ca-library-page' ? {} : selector === '.ca-library-detail.is-drawer-open' ? { querySelectorAll: () => [first, last] } : null;
    loaded.context.document.querySelectorAll = () => [row];
    loaded.context.document.activeElement = last;
    const tab = { key: 'Tab', preventDefault: vi.fn() };
    await loaded.ns.library.handleKeydown(tab);
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalled();
    const esc = { key: 'Escape', preventDefault: vi.fn() };
    await loaded.ns.library.handleKeydown(esc);
    expect(loaded.ns.library.state.drawer).toBe(false);
    expect(row.focus).toHaveBeenCalled();
    expect(loaded.render()).not.toContain('is-drawer-open');
  });

  it('未选择时列表不含详情，展开后关闭弹窗仍留小详情，再关闭才回到全宽', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a'), asset('b')] }, { name: 'overview' });
    expect(loaded.render()).not.toContain('ca-library-detail');
    await loaded.ns.library.handleClick(click('library-select', 'a'));
    let html = loaded.render();
    expect(html).toContain('ca-library-detail');
    expect(html).toContain('aria-label="展开详情"');
    expect(html).toContain('data-act="library-expand"');
    expect(html).toContain('data-act="library-close"');
    expect(html.indexOf('data-act="library-expand"')).toBeLessThan(html.indexOf('data-act="library-close"'));
    expect(html).not.toContain('ca-detail-expand');
    await loaded.ns.library.handleClick(click('library-expand'));
    html = loaded.render();
    expect(html).toContain('class="ca-detail-expand"');
    expect(html).toContain('data-detail-mirror="true"');
    expect(html).toContain('正文 a');
    await loaded.ns.library.handleClick(click('library-expand-close'));
    html = loaded.render();
    expect(html).not.toContain('ca-detail-expand');
    expect(html).toContain('ca-library-detail');
    expect(loaded.store.route.assetId).toBe('a');
    await loaded.ns.library.handleClick(click('library-close'));
    expect(loaded.store.route.assetId).toBe('');
    expect(loaded.render()).not.toContain('ca-library-detail');
    expect(loaded.ns.library.state.query).toBe('');
  });

  it('关闭小详情保留搜索、筛选和页码，点击原行重开该条目', async () => {
    const rows = Array.from({ length: 22 }, (_, i) => {
      const id = String(i).padStart(2, '0');
      return asset(id, { title: `筛选条目 ${id}`, status: 'paused' });
    });
    const loaded = loadCognitionAssets({ assets: [
      ...rows,
      asset('active', { title: '筛选条目 启用' }),
      asset('unmatched', { title: '其他内容', status: 'paused' }),
    ] }, { name: 'overview' });
    await loaded.ns.library.handleInput({ target: { id: 'ca-library-search', value: '筛选条目' } });
    await loaded.ns.library.handleInput({ target: { dataset: { libraryFilter: 'status' }, value: 'paused' } });
    await loaded.ns.library.handleClick(click('library-page', '1'));
    expect(tableIds(loaded.render())).toEqual(['20', '21']);
    await loaded.ns.library.handleClick(click('library-select', '21'));
    expect(loaded.store.route.assetId).toBe('21');
    expect(loaded.render()).toContain('ca-library-detail');

    await loaded.ns.library.handleClick(click('library-close'));
    expect(loaded.store.route.assetId).toBe('');
    expect(loaded.ns.library.state).toMatchObject({ query: '筛选条目', status: 'paused', page: 2 });
    const closed = loaded.render();
    expect(closed).not.toContain('ca-library-detail');
    expect(tableIds(closed)).toEqual(['20', '21']);

    await loaded.ns.library.handleClick(click('library-select', '21'));
    expect(loaded.store.route.assetId).toBe('21');
    expect(loaded.ns.library.state).toMatchObject({ query: '筛选条目', status: 'paused', page: 2 });
    const reopened = loaded.render();
    expect(reopened).toContain('ca-library-detail');
    expect(reopened).toContain('正文 21');
    expect(tableIds(reopened)).toEqual(['20', '21']);
  });

  it('方向键浏览行只移动焦点，Enter选择该条目，编辑Ctrl+S点击真实保存入口', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a'), asset('b')] }, { name: 'overview' });
    const a = { ...click('library-select', 'a'), focus: vi.fn(), closest: (selector: string) => selector === '[data-act="library-select"]' ? a : null };
    const b = { ...click('library-select', 'b'), focus: vi.fn(), closest: (selector: string) => selector === '[data-act="library-select"]' ? b : null };
    const save = { click: vi.fn() };
    loaded.context.document.querySelector = (selector: string) => selector === '.ca-library-page' ? {} : selector === '[data-act="asset-edit-save"]' ? save : null;
    loaded.context.document.querySelectorAll = () => [a, b];
    await loaded.ns.library.handleKeydown({ key: 'ArrowDown', target: a, preventDefault: vi.fn() });
    expect(b.focus).toHaveBeenCalledOnce();
    await loaded.ns.library.handleKeydown({ key: 'Enter', target: b, preventDefault: vi.fn() });
    expect(loaded.store.route.assetId).toBe('b');
    loaded.store.route.assetEdit = '1';
    const key = { key: 's', ctrlKey: true, preventDefault: vi.fn() };
    await loaded.ns.library.handleKeydown(key);
    expect(key.preventDefault).toHaveBeenCalled();
    expect(save.click).toHaveBeenCalledOnce();
  });
});

describe('正式库不会将异常或读取失败伪装成已保存的正常认知', () => {
  it('缺失状态、候选状态、非法类型和无对象标识不进入任何正式筛选，深链保留只读内容', () => {
    const invalid = [asset('missing', { status: undefined }), asset('candidate', { status: 'pending_review' }), asset('bad-type', { type: 'unknown' }), asset('', { title: '没有对象标识' })];
    const loaded = loadCognitionAssets({ assets: [asset('saved'), ...invalid] }, { name: 'overview', assetId: 'missing', assetEdit: '1' });
    loaded.ns.library.state.status = 'all';
    expect(loaded.ns.library.filtered().map((a: any) => a.id)).toEqual(['saved']);
    const html = loaded.render();
    expect(html).toContain('4 条记录的信息不完整');
    expect(html).toContain('正文 missing');
    expect(html).toContain('当前仅可查看原文与记录');
    expect(html).not.toContain('data-act="asset-edit-save"');
    expect(html).not.toContain('data-act="edit-asset"');
    expect(html).not.toContain('data-action="resume"');
  });

  it('读取失败且无缓存时总数不可用，有缓存也不能编辑、暂停或删除', () => {
    const failed = loadCognitionAssets({ assets: [], assetsError: 'failed' }, { name: 'overview' }).render();
    expect(failed).toContain('总数暂不可用');
    expect(failed).not.toContain('0–0 / 0');
    const cached = loadCognitionAssets({ assets: [asset('cached')], assetsError: 'failed' }, { name: 'overview', assetId: 'cached', assetEdit: '1' }).render();
    expect(cached).toContain('当前显示上次读取的内容');
    expect(cached).not.toContain('data-act="asset-edit-save"');
    expect(cached).not.toContain('data-action="pause"');
    expect(cached).not.toContain('data-action="delete"');
    expect(cached).not.toContain('重启 CogSeed');
  });

  it('错误范围数据不导致目录渲染崩溃或显示为无使用限制', () => {
    const loaded = loadCognitionAssets({ assets: [asset('bad-scope', { scopePolicy: { workspaceIds: 'bad', agentIds: [] } })] }, { name: 'overview' });
    expect(loaded.render()).toContain('范围信息不完整，请核对');
    loaded.ns.library.state.scope = 'ws-a';
    expect(loaded.ns.library.filtered()).toHaveLength(0);
  });

  it('输入法组合期间保存快捷键不提交尚未确认的正文', async () => {
    const loaded = loadCognitionAssets({ assets: [asset('a')] }, { name: 'overview', assetId: 'a', assetEdit: '1' });
    const save = { click: vi.fn() };
    loaded.context.document.querySelector = () => save;
    await loaded.ns.library.handleKeydown({ key: 's', ctrlKey: true, isComposing: true, preventDefault: vi.fn() });
    await loaded.ns.library.handleKeydown({ key: 's', ctrlKey: true, keyCode: 229, preventDefault: vi.fn() });
    expect(save.click).not.toHaveBeenCalled();
  });

  it('深链打开不在当前列表里的条目时，不用空库引导代替列表', () => {
    const html = loadCognitionAssets({ assets: [asset('gone', { status: 'deleted' })] }, { name: 'overview', assetId: 'gone' }).render();
    expect(html).toContain('ca-library-detail');
    expect(html).toContain('当前筛选下无其他条目');
    expect(html).not.toContain('这里还没有已保存的认知');
    expect(html).not.toContain('data-act="go-review"');
  });
});
