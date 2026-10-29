import { nightlyFormation } from './helpers/nightly-candidate';
import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';
const candidate = (id: string, extra = {}) => ({ ...nightlyFormation(), id, summary: `建议 ${id}`, judgment: `长期内容 ${id}`, suggestedType: 'template', suggestedScope: 'general', status: 'pending_review', createdAt: `2026-10-11T0${id === 'a' ? 2 : 1}:00:00Z`, capabilities: { countsAsPending: true, canEdit: true, canPromote: true, canReject: true }, ...extra });
const button = (act: string, id = '', card: any = null) => ({ dataset: { act, id }, disabled: false, getAttribute: () => null, setAttribute: vi.fn(), removeAttribute: vi.fn(), closest: () => card });
describe('系统活动列表与逐项审核', () => {
  it('筛选器保留草稿保护，并按状态和类型切换', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a'), candidate('b')] }, { name: 'activity' });
    const html = loaded.render();
    expect(html.indexOf('id="ca-activity-query"')).toBeLessThan(html.indexOf('id="ca-activity-view-filter"'));
    expect(html.indexOf('id="ca-activity-kind-filter"')).toBeLessThan(html.indexOf('data-act="refresh"'));
    expect(html).toContain('全部类型 2');
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:a'));
    const card = { dataset: { candId: 'a', candType: 'template' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '草稿正文', closest: () => card } });
    const api = { setValue: vi.fn(), destroy: vi.fn() };
    const filters = { querySelector: () => ({ _uiSelectApi: api }) };
    const root = { querySelectorAll: () => [], querySelector: (selector: string) => selector === '[data-activity-selects]' ? filters : null };
    let callbacks: Record<string, (value: string) => Promise<void>> = {};
    loaded.window._aiSelectMount = vi.fn();
    loaded.window.hydrateUiFormSelects = (_root: unknown, handlers: typeof callbacks) => { callbacks = handlers; return [api]; };
    loaded.ns.activityController.hydrateFilters(root);
    loaded.ns.router.go = vi.fn();
    loaded.ns.confirmUser = vi.fn(async () => false);
    await callbacks['ca-activity-view-filter']('done');
    expect(api.setValue).toHaveBeenCalledWith('attention');
    expect(loaded.ns.router.go).not.toHaveBeenCalled();
    loaded.ns.confirmUser = vi.fn(async () => true);
    await callbacks['ca-activity-view-filter']('done');
    expect(loaded.ns.router.go).toHaveBeenCalledWith(expect.objectContaining({ activityView: 'done', activityDone: '1', activityPage: '', activityQuery: '' }), { replace: true });
    await callbacks['ca-activity-kind-filter']('organize');
    expect(loaded.ns.router.go).toHaveBeenLastCalledWith(expect.objectContaining({ activityFilter: 'organize', activityPage: '' }), { replace: true });
    loaded.ns.activityController.closeFilters();
    expect(api.destroy).toHaveBeenCalledOnce();
  });
  it('进入时只显示列表，点开后修改入口与确认操作在固定底栏，并保留 50 条分页', async () => {
    const loaded = loadCognitionAssets({ candidates: Array.from({ length: 55 }, (_, i) => candidate(String(i))) }, { name: 'activity' });
    const html = loaded.render();
    expect(loaded.store.activityRows).toHaveLength(50);
    expect(html).toContain('每页 50 条');
    expect(html).not.toContain('ca-activity-detail');
    expect(html).not.toContain('data-f="summary"');
    expect(html).not.toContain('data-f="type"');
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:0'));
    const opened = loaded.render();
    const footer = opened.slice(opened.indexOf('<footer class="ca-activity-detail-footer ca-detail-footer">'));
    expect(footer).toContain('data-act="cand-adopt-with-form"');
    expect(footer).toContain('data-act="activity-edit"');
    await loaded.ns.activityController.handleClick(button('activity-edit', '0'));
    const editing = loaded.render();
    expect(editing).toContain('data-f="summary"');
    expect(editing).toContain('data-act="activity-save-draft"');
    expect(editing).not.toContain('data-act="cand-adopt-with-form"');
  });
  it('终态即使携带陈旧可编辑能力也只读，并展示真实处理者与依据', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a', { status: 'confirmed', processingActor: '系统自动批准', processingReason: '证据完整、低风险', promotedAssetId: 'asset-a' })] }, { name: 'activity', activityView: 'done', candidateId: 'a' });
    const html = loaded.render();
    expect(html).toContain('系统自动批准');
    expect(html).toContain('证据完整、低风险');
    expect(html).not.toContain('data-f="judgment"');
    expect(html).not.toContain('data-act="cand-adopt-with-form"');
    expect(html).not.toContain('data-act="cand-decide"');
  });
  it('未保存修改被拒绝离开时保留详情和草稿，允许离开后才更换选择', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a'), candidate('b')] }, { name: 'activity' });
    loaded.render();
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:a'));
    const card = { dataset: { candId: 'a', candType: 'template' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '新的可复用正文', closest: () => card } });
    loaded.ns.confirmUser = vi.fn(async () => false);
    loaded.ns.router.go = vi.fn();
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:b'));
    expect(loaded.ns.router.go).not.toHaveBeenCalled();
    expect(loaded.render()).toContain('新的可复用正文');
    loaded.ns.confirmUser = vi.fn(async () => true);
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:b'));
    expect(loaded.ns.router.go).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'b' }), { replace: true });
  });
  it('保存修改调用真实候选更新通道，保持证据、边界与使用授权并消费服务端校验', async () => {
    const original = candidate('a', { sourceRefs: [...nightlyFormation().sourceRefs, { kind: 'conversation', id: 'source-session' }], evidenceRefs: [{ kind: 'conversation', id: 'conversation-a' }], applicableWhen: ['报告'], forbiddenWhen: ['法律'], scopePolicy: { agentIds: ['commander'] } });
    const invoke = vi.fn(async () => ({ ok: true, candidate: { ...original, judgment: '编辑后的正文', capabilities: { ...original.capabilities, canPromote: false, ineligibleReasons: ['evidence_missing'] } } }));
    const loaded = loadCognitionAssets({ candidates: [original] }, { name: 'activity' }, { cogseed: { invoke } });
    loaded.render();
    const card = { dataset: { candId: 'a', candType: 'template' }, querySelector: (selector: string) => selector === '[data-f="judgment"]' ? { value: '编辑后的正文' } : null };
    const footerButton = button('activity-save-draft', 'a');
    footerButton.closest = (selector?: string) => selector === '.ca-candidate-detail' ? null : { querySelector: () => card };
    await loaded.ns.activityController.handleClick(footerButton);
    expect(invoke).toHaveBeenCalledWith('recall.candidates.update', expect.objectContaining({ candidateId: 'a', judgment: '编辑后的正文', sourceRefs: original.sourceRefs, evidenceRefs: original.evidenceRefs, applicableWhen: ['报告'], forbiddenWhen: ['法律'], scopePolicy: { agentIds: ['commander'] } }));
    expect(loaded.store.candidates[0].capabilities.canPromote).toBe(false);
  });
  it('稍后处理调用后端并保留需要关注，处理后选下一项而不跳资产页', async () => {
    const original = candidate('a');
    const invoke = vi.fn(async () => ({ ok: true, candidate: { ...original, activityDeferredAt: '2026-10-11T02:30:00Z' } }));
    const loaded = loadCognitionAssets({ candidates: [original, candidate('b')] }, { name: 'activity' }, { cogseed: { invoke } });
    loaded.render();
    loaded.ns.router.go = vi.fn();
    await loaded.ns.activityController.handleClick(button('activity-defer', 'a'));
    expect(invoke).toHaveBeenCalledWith('recall.candidates.defer', { candidateId: 'a' });
    expect(loaded.ns.activityModel().attention).toHaveLength(2);
    expect(loaded.ns.activityModel().attention.find((row: any) => row.key === 'candidate:a').result).toContain('稍后');
    expect(loaded.ns.router.go).toHaveBeenCalledWith(expect.objectContaining({ name: 'activity', candidateId: 'b' }), { replace: true });
  });
  it('首次窄屏不自动打开详情，宽屏选中后缩窄也不意外弹出抽屉', async () => {
    let narrow = false;
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity' }, { matchMedia: () => ({ matches: narrow }) });
    loaded.render(); narrow = true;
    expect(loaded.render()).not.toContain('is-drawer-open');
    const loadedNarrow = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity' }, { matchMedia: () => ({ matches: true }) });
    expect(loadedNarrow.render()).not.toContain('is-drawer-open');
    expect(loadedNarrow.render()).not.toContain('ca-activity-detail');
    expect(loadedNarrow.render()).not.toContain('选择一项查看详情');
  });
  it('展开与关闭小详情各自独立，切换展示时保留草稿', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity' });
    expect(loaded.render()).not.toContain('ca-activity-detail');
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:a'));
    let html = loaded.render();
    expect(html).toContain('aria-label="展开详情"');
    expect(html).toContain('data-act="activity-expand"');
    expect(html).toContain('data-act="activity-close"');
    expect(html.indexOf('data-act="activity-expand"')).toBeLessThan(html.indexOf('data-act="activity-close"'));
    expect(html).not.toContain('ca-detail-expand');
    const card = { dataset: { candId: 'a', candType: 'template' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '抽屉里的草稿', closest: () => card } });
    await loaded.ns.activityController.handleClick(button('activity-expand'));
    html = loaded.render();
    expect(html).toContain('class="ca-detail-expand"');
    expect(html).toContain('data-detail-mirror="true"');
    expect(html).toContain('抽屉里的草稿');
    expect(html).toContain('data-act="activity-expand-close"');
    const escapeExpand = { key: 'Escape', preventDefault: vi.fn(), target: {} };
    await loaded.ns.activityController.handleKeydown(escapeExpand);
    html = loaded.render();
    expect(escapeExpand.preventDefault).toHaveBeenCalled();
    expect(html).not.toContain('ca-detail-expand');
    expect(html).toContain('ca-activity-detail');
    expect(html).toContain('抽屉里的草稿');
    expect(loaded.store.route.candidateId).toBe('a');
    await loaded.ns.activityController.handleClick(button('activity-expand'));
    await loaded.ns.activityController.handleClick(button('activity-expand-close'));
    html = loaded.render();
    expect(html).not.toContain('ca-detail-expand');
    expect(html).toContain('ca-activity-detail');
    expect(html).toContain('抽屉里的草稿');
    loaded.ns.confirmUser = vi.fn(async () => true);
    loaded.ns.router.go = vi.fn();
    await loaded.ns.activityController.handleClick(button('activity-close'));
    expect(loaded.ns.router.go).toHaveBeenCalledWith(expect.objectContaining({ candidateId: '' }), { replace: true });
  });
  it('空库前往整理，搜索无匹配清空筛选，读取失败重试', () => {
    const empty = loadCognitionAssets({ candidates: [] }, { name: 'activity' }).render();
    expect(empty).toContain('前往整理');
    expect(empty).toContain('data-act="go-organize-settings"');
    expect(empty).not.toContain('data-act="nightly-scan-now"');
    const searched = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity', activityQuery: '不存在的词' }).render();
    expect(searched).toContain('清空筛选');
    expect(searched).not.toContain('前往整理');
    const failed = loadCognitionAssets({ candidates: [], candidatesError: 'failed' }, { name: 'activity' }).render();
    expect(failed).toContain('清单没能读取');
    expect(failed).toContain('data-act="refresh"');
    expect(failed).not.toContain('前往整理');
    const done = loadCognitionAssets({ candidates: [] }, { name: 'activity', activityView: 'done' }).render();
    expect(done).toContain('暂无已处理的建议');
    expect(done).not.toContain('前往整理');
    const linked = loadCognitionAssets({ candidates: [candidate('saved', { status: 'confirmed', promotedAssetId: 'asset-saved', capabilities: { isTerminal: true } })] }, { name: 'activity', candidateId: 'saved' }).render();
    expect(linked).toContain('ca-activity-detail');
    expect(linked).toContain('当前筛选下无其他条目');
    expect(linked).not.toContain('前往整理');
    expect(linked).not.toContain('data-act="go-organize-settings"');
    const unrecorded = loadCognitionAssets({ candidates: [candidate('src', { evidenceRefs: [], sourceRefs: [], stockOrganizationProvenance: { originalSourceUnrecorded: true, activeVersion: '1' } })] }, { name: 'activity', candidateId: 'src' }).render();
    const evidenceAt = unrecorded.indexOf('class="ca-review-evidence"');
    expect(evidenceAt).toBeGreaterThanOrEqual(0);
    expect(unrecorded.slice(evidenceAt, evidenceAt + 500)).toContain('原始来源未记录');
  });
  it('关闭小详情保留搜索、处理视角和页码，点击原行重开该条目', async () => {
    const rows = Array.from({ length: 52 }, (_, i) => candidate(String(i).padStart(2, '0'), { summary: `筛选条目 ${i}`, status: 'rejected' }));
    const loaded = loadCognitionAssets({ candidates: [
      ...rows,
      candidate('pending', { summary: '筛选条目 待处理' }),
      candidate('unmatched', { summary: '其他内容', status: 'rejected' }),
    ] }, { name: 'activity', activityView: 'done', activityDone: '1', activityQuery: '筛选条目' });
    loaded.render();
    await loaded.ns.activityController.handleClick(button('activity-page-select', '1'));
    loaded.render();
    expect(loaded.store.activityRows.map((row: any) => row.key)).toEqual(['candidate:50', 'candidate:51']);
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:51'));
    expect(loaded.store.route.candidateId).toBe('51');
    expect(loaded.render()).toContain('ca-activity-detail');

    await loaded.ns.activityController.handleClick(button('activity-close'));
    expect(loaded.store.route).toMatchObject({ candidateId: '', activityView: 'done', activityDone: '1', activityQuery: '筛选条目', activityPage: '1' });
    expect(loaded.render()).not.toContain('ca-activity-detail');
    expect(loaded.store.activityDetailTarget).toBeNull();
    expect(loaded.store.activityRows.map((row: any) => row.key)).toEqual(['candidate:50', 'candidate:51']);

    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:51'));
    expect(loaded.store.route).toMatchObject({ candidateId: '51', activityView: 'done', activityDone: '1', activityQuery: '筛选条目', activityPage: '1' });
    const reopened = loaded.render();
    expect(reopened).toContain('ca-activity-detail');
    expect(reopened).toContain('data-activity-key="candidate:51"');
    expect(loaded.store.activityRows.map((row: any) => row.key)).toEqual(['candidate:50', 'candidate:51']);
  });
  it('窄屏抽屉隔离列表，Tab 循环并在 Esc 关闭后恢复原行焦点', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity', candidateId: 'a' }, { matchMedia: () => ({ matches: true }) });
    const html = loaded.render();
    expect(html).toContain('role="dialog" aria-modal="true"');
    expect(html).toContain('ca-activity-list" inert');
    const first = { focus: vi.fn(), getAttribute: () => null };
    const last = { focus: vi.fn(), getAttribute: () => null };
    const row = { dataset: { id: 'candidate:a' }, focus: vi.fn() };
    loaded.context.document.querySelectorAll = (selector: string) => selector === '[data-act="activity-select"]' ? [row] : [first, last];
    loaded.ns.router.go = vi.fn();
    const tab = { key: 'Tab', target: last, preventDefault: vi.fn() };
    await loaded.ns.activityController.handleKeydown(tab);
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalled();
    const escape = { key: 'Escape', preventDefault: vi.fn() };
    await loaded.ns.activityController.handleKeydown(escape);
    expect(escape.preventDefault).toHaveBeenCalled();
    expect(row.focus).toHaveBeenCalled();
    expect(loaded.ns.router.go).toHaveBeenCalledWith(expect.objectContaining({ candidateId: '' }), { replace: true });
  });
  it('修改正文会触发脏草稿确认，拒绝丢弃时不执行拒绝操作', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity' });
    loaded.render();
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:a'));
    const card = { dataset: { candId: 'a', candType: 'template' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '修改正文', closest: () => card } });
    loaded.ns.confirmUser = vi.fn(async () => false);
    expect(await loaded.ns.activityController.handleClick(button('cand-decide', 'a'))).toBe(true);
    expect(loaded.ns.confirmUser).toHaveBeenCalledOnce();
  });
  it('新认知编辑保留正文草稿与内部类型，离开时提示未保存', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a', { suggestedType: 'cognition' })] }, { name: 'activity' });
    loaded.render();
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:a'));
    const card = { dataset: { candId: 'a', candType: 'cognition' } };
    expect(loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '保留修改正文', closest: () => card } })).toBe(true);
    expect(card.dataset.candType).toBe('cognition');
    const html = loaded.render();
    expect(html).toContain('保留修改正文');
    expect(html).not.toContain('data-f="type"');
    loaded.ns.confirmUser = vi.fn(async () => false);
    expect(await loaded.ns.activityController.handleClick(button('activity-next'))).toBe(true);
    expect(loaded.ns.confirmUser).toHaveBeenCalledOnce();
  });

  it('同一条目刷新保持阅读位置、展开状态和输入光标，切换条目重置详情但保留列表位置', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a'), candidate('b')] }, { name: 'activity' });
    function detail(key: string) {
      const field = { dataset: { f: 'judgment' }, scrollTop: 0, scrollLeft: 0, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', focus: vi.fn(), setSelectionRange: vi.fn() };
      const disclosure = { open: false };
      const body = { dataset: { activityKey: key }, scrollTop: 0, querySelectorAll: (selector: string) => selector === '[data-f]' ? [field] : [disclosure] };
      const list = { scrollTop: 0, scrollLeft: 0 };
      return { field, disclosure, body, list, querySelector: (selector: string) => selector === '.ca-activity-detail-body' ? body : list };
    }
    const old = detail('candidate:a');
    old.body.scrollTop = 120; old.field.scrollTop = 44; old.field.scrollLeft = 9;
    old.field.selectionStart = 3; old.field.selectionEnd = 8; old.disclosure.open = true;
    old.list.scrollTop = 210; old.list.scrollLeft = 6;
    loaded.context.document.activeElement = old.field;
    const state = loaded.ns.activityController.captureRenderState(old);
    const same = detail('candidate:a');
    loaded.ns.activityController.restoreRenderState(same, state);
    expect(same.body.scrollTop).toBe(120);
    expect(same.field.scrollTop).toBe(44);
    expect(same.field.scrollLeft).toBe(9);
    expect(same.field.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(same.field.setSelectionRange).toHaveBeenCalledWith(3, 8, 'none');
    expect(same.disclosure.open).toBe(true);
    const next = detail('candidate:b');
    next.body.scrollTop = 90; next.field.scrollTop = 30;
    loaded.ns.activityController.restoreRenderState(next, state);
    expect(next.body.scrollTop).toBe(0);
    expect(next.field.scrollTop).toBe(0);
    expect(next.field.focus).not.toHaveBeenCalled();
    expect(next.disclosure.open).toBe(false);
    expect(next.list).toEqual({ scrollTop: 210, scrollLeft: 6 });
  });

  it('宽屏直接缩窄后第一次选择即可打开抽屉，不要求先重画页面', async () => {
    let narrow = false;
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity' }, { matchMedia: () => ({ matches: narrow }) });
    loaded.render(); narrow = true;
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:a'));
    expect(loaded.render()).toContain('is-drawer-open');
  });

  it('处理 A 的请求期间切到 B 并编辑，A 完成时不跳离 B 或丢失 B 的草稿', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a'), candidate('b')] }, { name: 'activity' });
    loaded.render();
    const operation = loaded.ns.activityController.beginDecision();
    await loaded.ns.activityController.handleClick(button('activity-select', 'candidate:b'));
    const card = { dataset: { candId: 'b', candType: 'template' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: 'B 的新草稿', closest: () => card } });
    loaded.ns.router.go = vi.fn();
    loaded.store.candidates[0] = candidate('a', { status: 'confirmed', capabilities: { isTerminal: true } });
    expect(loaded.ns.activityController.afterDecision('a', false, operation)).toBe(false);
    expect(loaded.ns.router.go).not.toHaveBeenCalled();
    expect(loaded.render()).toContain('B 的新草稿');
  });
  it('处理期间离开系统活动，完成回执只更新数据且不强行导航', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a'), candidate('b')] }, { name: 'activity' });
    loaded.render();
    const operation = loaded.ns.activityController.beginDecision();
    loaded.store.route = { name: 'settings' };
    loaded.ns.router.go = vi.fn();
    expect(loaded.ns.activityController.afterDecision('a', false, operation)).toBe(false);
    expect(loaded.ns.router.go).not.toHaveBeenCalled();
  });

  it('实际整页 render 在刷新时保留详情阅读状态，处理后下一条从顶部打开', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a'), candidate('b')] }, { name: 'activity', candidateId: 'a' });
    function makeBody(key: string) {
      const field = { dataset: { f: 'judgment' }, scrollTop: 0, scrollLeft: 0, selectionStart: 0, selectionEnd: 0, focus: vi.fn(), setSelectionRange: vi.fn() };
      const disclosure = { open: false };
      return { dataset: { activityKey: key }, scrollTop: 0, field, disclosure, querySelectorAll: (selector: string) => selector === '[data-f]' ? [field] : [disclosure] };
    }
    let current: ReturnType<typeof makeBody> | null = null;
    let list = { scrollTop: 0, scrollLeft: 0 };
    const main = {
      scrollTop: 0, classList: { toggle() {} },
      querySelector(selector: string) { return selector === '.ca-activity-detail-body' ? current : selector === '.ca-activity-table-wrap' ? list : null; },
      set innerHTML(html: string) {
        current = makeBody(html.match(/data-activity-key="([^"]+)"/)?.[1] || '');
        list = { scrollTop: 0, scrollLeft: 0 };
      },
    };
    const root = { innerHTML: '' }, plain = { innerHTML: '' };
    loaded.context.document.getElementById = (id: string) => id === 'ca-root' ? root : id === 'ca-scroll' ? main : plain;
    loaded.ns.render();
    const old = current!;
    old.scrollTop = 160; old.field.scrollTop = 70; old.disclosure.open = true;
    old.field.selectionStart = 4; old.field.selectionEnd = 9;
    list.scrollTop = 120;
    main.scrollTop = 80;
    loaded.context.document.activeElement = old.field;
    loaded.ns.render();
    expect(current).not.toBe(old);
    expect(current!.scrollTop).toBe(160);
    expect(current!.field.scrollTop).toBe(70);
    expect(current!.disclosure.open).toBe(true);
    expect(current!.field.setSelectionRange).toHaveBeenCalledWith(4, 9, undefined);
    expect(list.scrollTop).toBe(120);
    expect(main.scrollTop).toBe(80);
    const operation = loaded.ns.activityController.beginDecision();
    loaded.store.candidates[0] = candidate('a', { status: 'confirmed', capabilities: { isTerminal: true } });
    loaded.ns.activityController.afterDecision('a', false, operation);
    loaded.ns.render();
    expect(current!.dataset.activityKey).toBe('candidate:b');
    expect(current!.scrollTop).toBe(0);
    expect(current!.field.scrollTop).toBe(0);
    expect(current!.disclosure.open).toBe(false);
    expect(list.scrollTop).toBe(120);
    expect(main.scrollTop).toBe(0);
  });

});

describe('活动详情的真实处理记录', () => {
  it.each([true, false])('阅读位置恢复不覆盖历史加载器的展开状态：%s', open => {
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity' });
    const ordinary = { open: false };
    const history = { open, querySelector: (selector: string) => selector === ':scope > summary[data-act="activity-history"]' ? {} : null };
    const body = { dataset: { activityKey: 'candidate:a' }, scrollTop: 0,
      querySelectorAll: (selector: string) => selector === 'details' ? [ordinary, history] : [] };
    loaded.ns.activityController.restoreRenderState({ querySelector: (selector: string) => selector === '.ca-activity-detail-body' ? body : null },
      { key: 'candidate:a', bodyTop: 100, disclosures: [true, !open], fields: [] });
    expect(ordinary.open).toBe(true);
    expect(history.open).toBe(open);
    expect(body.scrollTop).toBe(100);
  });
  it('展开期间复用正在读取的历史，收起再展开不重复请求', async () => {
    let finish!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const loaded = loadCognitionAssets({ candidates: [candidate('a')] }, { name: 'activity', candidateId: 'a' }, { cogseed: { invoke } });
    loaded.render();
    expect(invoke).not.toHaveBeenCalled();
    const opening = loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    expect(loaded.render()).toContain('加载中…');
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    expect(invoke).toHaveBeenCalledOnce();
    finish({ ok: true, items: [] });
    await opening;
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    expect(invoke).toHaveBeenCalledOnce();
    expect(loaded.store.activityHistory.a.open).toBe(true);
  });
  it('仅按候选 ID 读取处理记录，不依赖示例历史，并在失败后允许重试', async () => {
    const original = candidate('a');
    let fail = true;
    const invoke = vi.fn(async () => fail ? { ok: false, error: 'disk unavailable' } : { ok: true, items: [{ decision_id: 'd1', decision_type: 'modify', actor: 'user', timestamp: '2026-10-11T02:00:00Z', reason: '人工核对', outcome: 'asset_failed' }] });
    const loaded = loadCognitionAssets({ candidates: [original] }, { name: 'activity', candidateId: 'a' }, { cogseed: { invoke } });
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    expect(loaded.render()).toContain('本条处理记录暂时无法读取');
    expect(invoke).toHaveBeenCalledWith('recall.candidates.history', { candidateId: 'a' });
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    fail = false;
    await loaded.ns.activityController.handleClick(button('activity-history', 'a'));
    expect(loaded.render()).toContain('人工核对');
    expect(loaded.render()).toContain('正式保存未成功');
  });
  it('保存后的质量阻断退出关注，历史深链保留服务端校验回执', async () => {
    const original = candidate('a');
    const invoke = vi.fn(async () => ({ ok: true, candidate: { ...original, capabilities: { ...original.capabilities, canPromote: false, ineligibleReasons: ['evidence_missing'] } } }));
    const loaded = loadCognitionAssets({ candidates: [original] }, { name: 'activity', candidateId: 'a' }, { cogseed: { invoke } });
    const card = { dataset: { candId: 'a', candType: 'template' }, querySelector: () => null };
    await loaded.ns.activityController.handleClick(button('activity-save-draft', 'a', card));
    expect(loaded.render()).toContain('草稿已保存，仍有阻断项需要处理');
    expect(loaded.ns.activityModel().attention).toHaveLength(0);
    expect(loaded.store.candidates[0].capabilities.ineligibleReasons).toEqual(['evidence_missing']);
    expect(loaded.render()).not.toContain('data-act="cand-adopt-with-form"');
  });
  it('巡检发现进入需要关注，按类型筛选后可打开详情并保留、合并或稍后处理', async () => {
    const item = {
      id: 'inspection:duplicate:a+b', kind: 'inspection_finding', findingCategory: 'duplicate',
      assetIds: ['a', 'b'], title: 'a+b', detail: '这两条看字面很像，要不要合并？',
      actions: ['keep', 'merge', 'reject', 'defer'], urgency: 'low_disturbance',
    };
    const loaded = loadCognitionAssets({
      candidates: [],
      inbox: [item],
      assets: [{ id: 'a', title: '资产甲', statement: '甲正文', version: '1' }, { id: 'b', title: '资产乙', statement: '乙正文', version: '2' }],
    }, { name: 'activity' });
    const html = loaded.render();
    expect(html).toContain('资产甲 / 资产乙');
    expect(html).toContain('id="ca-activity-kind-filter"');
    expect(html).toContain('巡检发现 · 待处理');
    await loaded.ns.activityController.handleClick(button('activity-select', 'inbox:inspection:duplicate:a+b'));
    const detail = loaded.render();
    expect(detail).toContain('保留这条');
    expect(detail).toContain('合并到这条');
    expect(detail).toContain('data-action="keep"');
    expect(detail).toContain('data-target="a"');

    loaded.ns.router.go = vi.fn();
    await loaded.ns.activityController.handleClick(button('activity-filter', 'organize'));
    expect(loaded.ns.router.go).toHaveBeenCalledWith(expect.objectContaining({ name: 'activity', activityFilter: 'organize' }), { replace: true });

    const resolved = loadCognitionAssets({
      candidates: [], inbox: [],
      inboxResolved: [{
        id: 'inspection:outdated:c', kind: 'inspection_finding', findingCategory: 'outdated',
        assetIds: ['c'], title: 'c', detail: '超过 180 天没有更新', at: '2026-10-20T02:00:00Z', status: 'dismissed',
      }],
      assets: [{ id: 'c', title: '资产丙', statement: '丙正文', version: '1' }],
    }, { name: 'activity', activityView: 'done', activityDone: '1' });
    const doneHtml = resolved.render();
    expect(doneHtml).toContain('资产丙');
    expect(doneHtml).toContain('不再提醒');
  });
});
