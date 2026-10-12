/**
 * 标签系统渲染层用例（specs/012 T014，US-201 渲染段）。
 *
 * 两条腿（照 chat-asset-approval-card.test.ts 先例）：
 *  1. **真实调用级**：vm 沙箱装载真的共享控件（ui-button/ui-status/ui-form/
 *     ui-empty/ui-segmented-control）+ 真的中文词条 + cognition-assets 的
 *     core/views——组件用错当场抛错；筛选、批量三语义与进度、管理三动作
 *     确认语、详情标签节都按输出断言。
 *  2. **源码级**：IME 组合回车不提交（app.js 委托层守卫）、管理弹层/
 *     批量清单不泄露资产正文（受限正文不进界面）。
 *
 * 主进程端到端（打标→筛选→联动→删除零改动）在
 * test/main/features/recall/asset-tag-system.test.ts（T015）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8'),
);
const appSource = fs.readFileSync(path.join(rendererRoot, 'modules/cognition-assets/app.js'), 'utf8');

const TAG_ASSETS = [
  { id: 'aa-tag-1', type: 'personal', title: '发布流程经验', statement: '正文一：走灰度发布。', status: 'active', version: '1', updatedAt: '2026-09-24T01:00:00Z', tags: ['发布'] },
  { id: 'aa-tag-2', type: 'personal', title: '发布沟通模板', statement: '正文二：周报模板。', status: 'active', version: '1', updatedAt: '2026-09-24T02:00:00Z', tags: ['发布', '沟通'] },
  { id: 'aa-tag-3', type: 'rule', title: '沟通规则', statement: '正文三：不用比喻。', status: 'active', version: '1', updatedAt: '2026-09-24T03:00:00Z', tags: ['沟通'] },
  { id: 'aa-tag-4', type: 'rule', title: '还没打标', statement: '正文四：待分类。', status: 'active', version: '1', updatedAt: '2026-09-24T04:00:00Z' },
];

const TAG_ITEMS = [
  { id: 'tg-aaaaaaaaaaa1', name: '发布', state: 'active', createdFrom: 'user', assetCount: 2, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' },
  { id: 'tg-aaaaaaaaaaa2', name: '沟通', state: 'active', createdFrom: 'user', assetCount: 2, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' },
  // retired 与零引用都不进筛选条（T012 契约）。
  { id: 'tg-aaaaaaaaaaa3', name: '旧名', state: 'merged', createdFrom: 'user', assetCount: 5, aliases: [], formerNames: [], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' },
  { id: 'tg-aaaaaaaaaaa4', name: '零引用', state: 'active', createdFrom: 'user', assetCount: 0, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' },
];

function translate(key: string, vars?: Record<string, unknown>): string {
  let raw = typeof zh[key] === 'string' ? zh[key] : key;
  for (const [name, value] of Object.entries(vars || {})) {
    raw = raw.split(`{${name}}`).join(String(value));
  }
  return raw;
}

type InvokeMock = ReturnType<typeof vi.fn>;

/** 装一份 cognition-assets（core+views）到 vm 沙箱；返回命名空间与出口。 */
function loadCognition(options: {
  route?: Record<string, unknown>;
  state?: Record<string, unknown>;
  invoke?: InvokeMock;
  windowStubs?: Record<string, unknown>;
  queryResults?: Record<string, unknown>;
} = {}) {
  const root = { innerHTML: '', hidden: false };
  const document: any = {
    getElementById: (id: string) => (id === 'ca-root' ? root : null),
    _queryResults: options.queryResults || {},
    querySelector(selector: string) { return this._queryResults[selector] || null; },
  };
  const toasts: Array<{ message: string; variant?: string }> = [];
  const confirms: string[] = [];
  const context: any = {
    console,
    document,
    window: {
      addEventListener() {},
      cogseed: { invoke: options.invoke || vi.fn(async () => ({ ok: true })) },
      t: translate,
      uiIconHtml: () => '',
      uiToast: (message: string, payload: any) => { toasts.push({ message, variant: payload && payload.variant }); },
      uiConfirm: async (message: string) => { confirms.push(message); return true; },
      uiConfirmDanger: async (payload: any) => { confirms.push(String(payload && payload.message)); return true; },
      ...(options.windowStubs || {}),
    },
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of [
    'ui-button.js', 'ui-status.js', 'ui-form.js', 'ui-empty.js', 'ui-segmented-control.js', 'ui-structure.js',
    'cognition-assets/core.js', 'cognition-assets/views.js',
    'cognition-assets/review-candidate.js', 'cognition-assets/review-views.js',
  ]) {
    vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules', file), 'utf8'), context, { filename: file });
  }
  const store = context.window.CogAssets.store;
  Object.assign(store, {
    loaded: true,
    loading: false,
    errors: [],
    assets: TAG_ASSETS,
    proofs: [],
    ...(options.state || {}),
  }, {
    route: {
      name: 'overview', category: '', assetId: '', candidateId: '', proofEventId: '',
      captureBucket: '', captureId: '', sourceIssueOpen: '', kstarEpisodeId: '',
      assetVersionId: '', assetEdit: '', assetVersionDiff: '', assetVersionsExpanded: '',
      assetView: '', familyRename: '', ontologyBox: '', experienceId: '',
      tagFilter: '', tagMode: '', tagUntagged: '', tagSelect: '', tagOverlay: '',
      ...(options.route || {}),
    },
  });
  return {
    ns: context.window.CogAssets,
    store,
    root,
    document,
    toasts,
    confirms,
    render: () => { context.window.CogAssets.render(); return root.innerHTML; },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});
/** 从 invoke 记录里按通道名取调用（reload 会插入 recall.assets.list 等快照
 *  调用，不能按下标取——只认目标通道的那一条）。 */
function callOf(invoke: InvokeMock, channel: string): any[] {
  return invoke.mock.calls.filter((entry: any[]) => entry[0] === channel);
}

describe('标签筛选条（T012）', () => {
  it('数据源只显示 assetCount>0 的 active + 「未分类」chip；计数按其它筛选生效后算', () => {
    const { render } = loadCognition({ state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } } });
    const html = render();
    expect(html).toContain('ca-tag-filter');
    // 发布/沟通（assetCount=2）在；retired「旧名」与零引用「零引用」不在。
    expect(html).toContain('发布 2');
    expect(html).toContain('沟通 2');
    expect(html).not.toContain('旧名');
    expect(html).not.toContain('零引用');
    // 「未分类」chip 计数 = 未打标资产数（aa-tag-4 一条）。
    expect(html).toContain(`${zh['cognition.tag_untagged']} 1`);
    // 交/并集切换与「管理标签」入口都在（共享 uiSegmentedControl）。
    expect(html).toContain('ui-segmented-control');
    expect(html).toContain(`data-act="filter-tag-mode"`);
    expect(html).toContain(`data-act="tag-manage"`);
  });

  it('空标签库保留管理入口，不显示无意义的筛选项', () => {
    const { render } = loadCognition({ state: { tags: { items: [], loading: false, failed: false, stale: false } } });
    const html = render();
    expect(html).toContain('data-act="tag-manage"');
    expect(html).not.toContain('data-act="filter-tag-mode"');
    expect(html).not.toContain('data-act="filter-tag-untagged"');
  });

  it('并集（默认）：命中任一标签即入选，且保持主进程顺序（渲染层不重排）', () => {
    const { render } = loadCognition({
      route: { tagFilter: '发布\u001f沟通' },
      state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
    });
    const html = render();
    expect(html).toContain('发布流程经验');
    expect(html).toContain('发布沟通模板');
    expect(html).toContain('沟通规则');
    expect(html).not.toContain('还没打标');
    // 保序：aa-tag-1 的标题先于 aa-tag-3 出现。
    expect(html.indexOf('发布流程经验')).toBeLessThan(html.indexOf('沟通规则'));
  });

  it('交集（同时具备）：两条都命中才入选', () => {
    const { render } = loadCognition({
      route: { tagFilter: '发布\u001f沟通', tagMode: 'all' },
      state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
    });
    const html = render();
    expect(html).toContain('发布沟通模板');
    expect(html).not.toContain('发布流程经验');
    expect(html).not.toContain('沟通规则');
  });

  it('「未分类」= !tags || length===0；与类型筛选 AND 叠加', () => {
    const { render } = loadCognition({
      route: { tagUntagged: '1', category: 'rule' },
      state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
    });
    const html = render();
    expect(html).toContain('还没打标');
    expect(html).not.toContain('发布流程经验');
    expect(html).not.toContain('沟通规则'); // rule 但有标签，被标签轴筛掉
  });

  it('「未分类」+「同时具备」= 空集：显示明确空态说明，不是一屏空白', () => {
    const { render } = loadCognition({
      route: { tagFilter: '发布', tagMode: 'all', tagUntagged: '1' },
      state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
    });
    const html = render();
    expect(html).toContain(zh['cognition.tag_filter_empty_all']);
  });

  it('纯判定件 matchesTagFilter：大小写不敏感、未分类语义独立', () => {
    const { ns } = loadCognition();
    const asset = { tags: ['Release'] };
    expect(ns.matchesTagFilter(asset, ['release'], false, 'any')).toBe(true);
    expect(ns.matchesTagFilter({ tags: [] }, [], true, 'any')).toBe(true);
    expect(ns.matchesTagFilter({ tags: ['a'] }, [], true, 'any')).toBe(false);
    // 交集：names 全中才算中；untagged 与 all 组合恒空。
    expect(ns.matchesTagFilter({ tags: ['a', 'b'] }, ['a', 'b'], false, 'all')).toBe(true);
    expect(ns.matchesTagFilter({ tags: ['a'] }, ['a', 'b'], false, 'all')).toBe(false);
    expect(ns.matchesTagFilter({ tags: [] }, ['a'], true, 'all')).toBe(false);
  });
});

describe('资产详情「标签」节（T010）', () => {
  it('已有标签用 uiTag + 移除；空态给「未分类」+ 引导；输入与候选下拉都是共享件', () => {
    const { render } = loadCognition({
      route: { assetId: 'aa-tag-1' },
      state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
    });
    const html = render();
    expect(html).toContain('ui-tag');
    expect(html).toContain(`data-act="tag-remove"`);
    expect(html).toContain('data-tag-input');
    expect(html).toContain(`data-act="tag-add"`);
    // 候选下拉：已有「发布」不再出现在候选里，未挂的「沟通」在。
    expect(html).toContain(zh['cognition.tag_candidates']);
    expect(html).toContain('data-preset="1"');

    const bare = loadCognition({ route: { assetId: 'aa-tag-4' } });
    const emptyHtml = bare.render();
    expect(emptyHtml).toContain(zh['cognition.tag_empty']);
    expect(emptyHtml).toContain(zh['cognition.tag_empty_hint']);
    expect(emptyHtml).not.toContain(`data-act="tag-remove"`);
  });

  it('提交走整组替换：新增时提交的是「现值 + 新名」的最终名单（真实调用级）', async () => {
    const invoke = vi.fn(async () => ({ ok: true, asset: { ...TAG_ASSETS[0] } }));
    const loaded = loadCognition({ invoke });
    await loaded.ns.actions.addAssetTag('aa-tag-1', ' 重构 ');
    const calls = callOf(invoke, 'recall.assets.tags.set');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ assetId: 'aa-tag-1', tags: ['发布', '重构'] });
  });

  it('同名标签不触发 IPC，只提示不重复添加', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const loaded = loadCognition({ invoke });
    await loaded.ns.actions.addAssetTag('aa-tag-1', '发布');
    expect(invoke).not.toHaveBeenCalled();
    expect(loaded.toasts.some((entry) => entry.message === zh['cognition.tag_duplicate_hint'])).toBe(true);
  });

  it('移除也是整组替换：把目标名字从现值里减掉', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const loaded = loadCognition({ invoke });
    await loaded.ns.actions.removeAssetTag('aa-tag-2', '发布');
    const calls = callOf(invoke, 'recall.assets.tags.set');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].tags).toEqual(['沟通']);
    expect(loaded.toasts.some((entry) => entry.message.includes('发布'))).toBe(true);
  });
});

describe('列表批量打标（T011）', () => {
  it('多选态渲染 uiCheckbox + 批量条；三选一语义分开提交（真实调用级）', async () => {
    const invoke = vi.fn(async () => ({ ok: true, report: { total: 2, updated: 2, unchanged: 0, failed: 0, items: [] } }));
    const loaded = loadCognition({
      route: { tagSelect: '1' },
      state: { tagSelectIds: ['aa-tag-1', 'aa-tag-2'], tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
      invoke,
    });
    const html = loaded.render();
    expect(html).toContain('ui-checkbox');
    expect(html).toContain(`data-act="tag-select-toggle"`);
    expect(html).toContain(zh['cognition.tag_selected_count'].replace('{n}', '2'));
    expect(html).toContain(`data-act="tag-batch-run"`);

    await loaded.ns.actions.batchTags(['发布'], 'add');
    expect(callOf(invoke, 'recall.assets.tags.batch')[0][1].op).toEqual({ add: ['发布'] });

    await loaded.ns.actions.batchTags(['沟通'], 'remove');
    expect(callOf(invoke, 'recall.assets.tags.batch')[1][1].op).toEqual({ remove: ['沟通'] });

    await loaded.ns.actions.batchTags(['重构'], 'replace');
    expect(callOf(invoke, 'recall.assets.tags.batch')[2][1].op).toEqual({ replace: ['重构'] });
  });

  it('进度可见且失败清单不截断；整批拒绝时按本地名单逐项记失败', async () => {
    const invoke = vi.fn(async () => {
      if (invoke.mock.calls.length === 1) {
        return {
          ok: true,
          report: {
            total: 2, updated: 1, unchanged: 0, failed: 1,
            items: [
              { assetId: 'aa-tag-1', title: '发布流程经验', status: 'updated' },
              { assetId: 'aa-tag-2', title: '发布沟通模板', status: 'failed', note: 'exceeds 12 tags' },
            ],
          },
        };
      }
      // 第二批（refreshTags 之外的 snapshot 读取可能多次调用其它通道），
      // 让后续 batch 调用整体抛错，覆盖「整批拒绝」路径。
      throw new Error('invalid recall asset tag batch: exceeds 200 assets, split into smaller batches');
    });
    const loaded = loadCognition({
      state: { tagSelectIds: ['aa-tag-1', 'aa-tag-2'], tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
      invoke,
    });
    await loaded.ns.actions.batchTags(['发布'], 'add');
    expect(invoke).toHaveBeenCalled();
    // 完成后：不在运行态、进度数字齐、失败清单完整（标题 + 原因都在）。
    expect(loaded.store.tagBatch.running).toBe(false);
    expect(loaded.store.tagBatch.done).toBe(2);
    expect(loaded.store.tagBatch.total).toBe(2);
    expect(loaded.store.tagBatch.failed).toHaveLength(1);
    expect(loaded.store.tagBatch.failed[0].note).toBe('exceeds 12 tags');

    // 渲染层把失败清单如实摆出来（uiProgressBar 进度 + 逐项标题）。
    loaded.store.route.tagSelect = '1';
    loaded.ns.notify();
    const html = loaded.render();
    expect(html).toContain('ui-progress');
    expect(html).toContain('发布沟通模板');
    expect(html).toContain('exceeds 12 tags');
    expect(html).toContain(zh['cognition.tag_batch_failed_note']);

    // 整批拒绝路径：第二次执行时所有调用抛错 → 本地名单逐项进失败清单。
    loaded.store.tagSelectIds = ['aa-tag-1'];
    await loaded.ns.actions.batchTags(['沟通'], 'remove');
    expect(loaded.store.tagBatch.failed.some((item: any) => item.assetId === 'aa-tag-1')).toBe(true);
  });

  it('没选资产 / 没填标签名时如实提示，不发起 IPC', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const loaded = loadCognition({ state: { tagSelectIds: [] }, invoke });
    await loaded.ns.actions.batchTags(['发布'], 'add');
    expect(invoke).not.toHaveBeenCalled();
    loaded.store.tagSelectIds = ['aa-tag-1'];
    await loaded.ns.actions.batchTags([], 'add');
    expect(invoke).not.toHaveBeenCalled();
    expect(loaded.toasts.some((entry) => entry.message === zh['cognition.tag_batch_no_tags'])).toBe(true);
  });
});

describe('标签管理弹层（T013）', () => {
  const retiredItems = [...TAG_ITEMS, {
    id: 'tg-aaaaaaaaaaa5', name: '上线流程', state: 'merged', createdFrom: 'user', assetCount: 0,
    formerNames: ['发版流程'], aliases: ['旧上线'], createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z',
  }];

  it('弹层（不新建页面）承载三动作入口 + 建议（只建议不合并）+ 已停用/已合并折叠区', () => {
    const { render } = loadCognition({
      route: { tagOverlay: 'manage' },
      state: {
        tags: { items: retiredItems, loading: false, failed: false, stale: false },
        tagSuggestions: [{ sourceName: '发布', targetName: '发版', reason: 'similar' }],
      },
    });
    const html = render();
    // 弹层 markup 落在持久壳槽位，过 uiModalController（ui-modal 形态）。
    expect(html).toContain('data-tag-overlay="manage"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain(zh['cognition.tag_manage_title']);
    // 三动作。
    expect(html).toContain(`data-act="tag-rename"`);
    expect(html).toContain(`data-act="tag-merge"`);
    expect(html).toContain(`data-act="tag-delete"`);
    // 建议区只读 + 直达按钮；折叠区显示 formerNames/aliases。
    expect(html).toContain(zh['cognition.tag_suggestions']);
    expect(html).toContain(zh['cognition.tag_suggestions_hint']);
    expect(html).toContain(`data-act="tag-suggestion-merge"`);
    expect(html).toContain(zh['cognition.tag_retired_section']);
    expect(html).toContain('发版流程');
    expect(html).toContain('旧上线');
  });

  it('渲染建议不等于合并：不发起任何写通道', () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const loaded = loadCognition({
      route: { tagOverlay: 'manage' },
      state: {
        tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false },
        tagSuggestions: [{ sourceName: '发布', targetName: '发版', reason: 'similar' }],
      },
      invoke,
    });
    loaded.render();
    expect(invoke).not.toHaveBeenCalledWith('recall.tags.merge', expect.anything());
  });

  it('重命名：确认语带影响面（N 条资产 + 新旧名）；完成 toast 数字与实际一致', async () => {
    const invoke = vi.fn(async () => ({ ok: true, report: { total: 2, updated: 2, unchanged: 0, failed: 0, items: [] } }));
    const loaded = loadCognition({
      state: {
        tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false },
        tagManageEdit: 'tg-aaaaaaaaaaa1',
      },
      queryResults: { '[data-tag-rename-input]': { value: '发版' } },
      invoke,
    });
    await loaded.ns.actions.renameTag('tg-aaaaaaaaaaa1');
    expect(loaded.confirms[0]).toContain('2 条资产');
    expect(loaded.confirms[0]).toContain('发布');
    expect(loaded.confirms[0]).toContain('发版');
    const calls = callOf(invoke, 'recall.tags.rename');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ tagId: 'tg-aaaaaaaaaaa1', name: '发版' });
    expect(loaded.toasts.some((entry) => entry.message === zh['cognition.tag_renamed_toast'].replace('{n}', '2'))).toBe(true);
  });

  it('重命名影响 0 条时不显示数字（如实）', async () => {
    const invoke = vi.fn(async () => ({ ok: true, report: { total: 0, updated: 0, unchanged: 0, failed: 0, items: [] } }));
    const loaded = loadCognition({
      state: {
        tags: { items: [{ ...TAG_ITEMS[0], assetCount: 0 }], loading: false, failed: false, stale: false },
        tagManageEdit: 'tg-aaaaaaaaaaa1',
      },
      queryResults: { '[data-tag-rename-input]': { value: '发版' } },
      invoke,
    });
    await loaded.ns.actions.renameTag('tg-aaaaaaaaaaa1');
    expect(loaded.toasts.some((entry) => entry.message === zh['cognition.tag_renamed_toast_zero'])).toBe(true);
  });

  it('合并：确认前必须显示影响面（N 条「源」改「目标」+ 源标签停用）', async () => {
    const invoke = vi.fn(async () => ({ ok: true, report: { total: 2, updated: 2, unchanged: 0, failed: 0, items: [] } }));
    const loaded = loadCognition({
      state: {
        tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false },
        tagManageMerge: { sourceId: 'tg-aaaaaaaaaaa1', targetName: '沟通' },
      },
      invoke,
    });
    await loaded.ns.actions.mergeTag('tg-aaaaaaaaaaa1', '沟通');
    expect(loaded.confirms[0]).toContain('2 条资产');
    expect(loaded.confirms[0]).toContain('发布');
    expect(loaded.confirms[0]).toContain('沟通');
    expect(loaded.confirms[0]).toContain('源标签将停用');
    expect(callOf(invoke, 'recall.tags.merge')).toEqual([
      ['recall.tags.merge', { sourceTagId: 'tg-aaaaaaaaaaa1', targetTagId: 'tg-aaaaaaaaaaa2' }],
    ]);
  });

  it('删除确认语含「只摘除标签，资产本身不受影响」', async () => {
    const invoke = vi.fn(async () => ({ ok: true, report: { total: 2, updated: 2, unchanged: 0, failed: 0, items: [] } }));
    const loaded = loadCognition({
      state: { tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false } },
      invoke,
    });
    await loaded.ns.actions.deleteTag('tg-aaaaaaaaaaa1');
    expect(loaded.confirms[0]).toContain('只摘除标签，资产本身不受影响');
    expect(loaded.confirms[0]).toContain('发布');
    expect(callOf(invoke, 'recall.tags.delete')).toEqual([
      ['recall.tags.delete', { tagId: 'tg-aaaaaaaaaaa1' }],
    ]);
  });
});

describe('族话术降级（T008）与隐私红线', () => {
  it('组头计数/无组文案已降级，不再出现「未归类」指族', () => {
    const { render } = loadCognition({
      // specs/018 T031：同源血缘分组只在「管理」模式出现——话术断言在管理态下核对。
      route: { manage: '1' },
      state: {
        assets: [
          { id: 'aa-fam-1', type: 'personal', title: '同源甲', statement: '正文甲。', status: 'active', version: '1', updatedAt: '2026-09-24T01:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-fam-2' }] },
          { id: 'aa-fam-2', type: 'personal', title: '同源乙', statement: '正文乙。', status: 'active', version: '1', updatedAt: '2026-09-24T02:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-fam-1' }] },
          { id: 'aa-fam-3', type: 'rule', title: '独一条', statement: '正文丙。', status: 'active', version: '1', updatedAt: '2026-09-24T03:00:00Z' },
        ],
      },
    });
    const html = render();
    expect(html).toContain('2 条同源');
    expect(html).toContain('无同源血缘');
    expect(html).not.toContain('条同类');
    expect(html).not.toContain('未归类');
    // 族命名三按钮已删（审计 N2，2026-09-28：0 使用）：同源分组展示保留，
    // 命名入口不再渲染；已有族名（familyName）仍作为组头标题显示。
    expect(html).not.toContain('data-act="family-rename"');
    expect(html).not.toContain('命名同源血缘');
    expect(html).not.toContain('改血缘名');
  });

  it('已命名的族仍以族名作为组头展示（familyName 数据保留、展示保留）', () => {
    const { render } = loadCognition({
      route: { manage: '1' },
      state: {
        assets: [
          { id: 'aa-fam-4', type: 'personal', title: '同源甲', statement: '正文甲。', status: 'active', version: '1', updatedAt: '2026-09-24T01:00:00Z', familyName: '我的命名族', relations: [{ kind: 'same_family', assetId: 'aa-fam-5' }] },
          { id: 'aa-fam-5', type: 'personal', title: '同源乙', statement: '正文乙。', status: 'active', version: '1', updatedAt: '2026-09-24T02:00:00Z', relations: [{ kind: 'same_family', assetId: 'aa-fam-4' }] },
        ],
      },
    });
    const html = render();
    expect(html).toContain('我的命名族');
    expect(html).toContain('2 条同源');
  });

  it('批量失败清单与管理弹层不泄露资产正文（只名字/标题/计数）', () => {
    const loaded = loadCognition({
      route: { tagOverlay: 'manage', tagSelect: '1' },
      state: {
        tags: { items: TAG_ITEMS, loading: false, failed: false, stale: false },
        tagBatch: {
          running: false, done: 4, total: 4, updated: 3, unchanged: 0,
          failed: [{ assetId: 'aa-tag-4', title: '还没打标', status: 'failed', note: 'exceeds 12 tags' }],
        },
      },
    });
    const html = loaded.render();
    expect(html).toContain('还没打标');
    expect(html).toContain('exceeds 12 tags');
    // 详情页之外的批量/管理区域不出现任何资产正文。
    expect(html).not.toContain('正文一');
    expect(html).not.toContain('正文二');
    expect(html).not.toContain('正文三');
    expect(html).not.toContain('正文四');
  });

  it('源码级：回车提交带 IME 组合守卫（isComposing / keyCode 229）', () => {
    expect(appSource).toContain("event.key !== 'Enter' || event.isComposing || event.keyCode === 229");
  });
});

describe('排序依据小节与权重入口（T020 / US-202 AC4+AC6）', () => {
  /** 资产详情路由（aa-tag-1 = active，排序小节按状态渲染）。 */
  const detail = (state: Record<string, unknown> = {}) => loadCognition({ route: { assetId: 'aa-tag-1' }, ...state });

  it('explainable：只显示在场因子（缺的不显示 0）+ 总分 + 缺席说明 + 默认权重说明', () => {
    const loaded = detail();
    loaded.ns.rankingWhy = {
      assetId: 'aa-tag-1', turnId: 'turn-rk-1',
      item: {
        taskRunId: 'turn-rk-1', assetId: 'aa-tag-1', assetVersion: '1', channel: 'projection',
        explainable: true, score: 0.63,
        factors: [
          { name: 'relevance', raw: 0.62, weight: 1, contribution: 0.62 },
          { name: 'adoption', raw: 0.85, weight: 1, contribution: 0.85 },
          { name: 'maturity', raw: 0.5, weight: 0.4, contribution: 0.2 },
        ],
        excluded: ['scene'], weightsSource: 'default',
      },
    };
    const html = loaded.render();
    expect(html).toContain(zh['cognition.ranking_why_title']);
    expect(html).toContain('ca-rank-row');
    expect(html).toContain(zh['cognition.ranking_factor_relevance']);
    expect(html).toContain(zh['cognition.ranking_factor_adoption']);
    expect(html).toContain(zh['cognition.ranking_factor_maturity']);
    // 缺的因子不显示（不是显示 0）：因子行恰好 3 行、没有「场景」行；
    // 缺席说明里出现「场景」一词是说明文案，不是因子行。
    expect((html.match(/class="ca-rank-row"/g) || []).length).toBe(3);
    expect(html).not.toContain(`ca-rank-name">${zh['cognition.ranking_factor_scene']}`);
    expect(html).toContain(zh['cognition.ranking_scene_absent_note']);
    expect(html).toContain(zh['cognition.ranking_total'].replace('{score}', '0.63'));
    expect(html).toContain(zh['cognition.ranking_source_default_note']);
    // 拆解只渲染因子名与数值，不落内部回合 id。
    expect(html).not.toContain('turn-rk-1');
  });

  it('旧回执 explainable:false → 如实说「没有记录」，不编造因子行', () => {
    const loaded = detail();
    loaded.ns.rankingWhy = { assetId: 'aa-tag-1', turnId: 'turn-rk-old', item: { taskRunId: 'turn-rk-old', assetId: 'aa-tag-1', explainable: false } };
    const html = loaded.render();
    expect(html).toContain(zh['cognition.ranking_why_title']);
    expect(html).toContain(zh['cognition.ranking_no_record']);
    expect(html).not.toContain('ca-rank-row');
  });

  it('区分本轮没有场景归属和资产没有匹配当前项目/工作空间', () => {
    const noContext = detail();
    noContext.ns.rankingWhy = {
      assetId: 'aa-tag-1', turnId: 'turn-rk-no-context',
      item: {
        taskRunId: 'turn-rk-no-context', assetId: 'aa-tag-1', explainable: true, score: 0.5,
        factors: [{ name: 'adoption', raw: 0.5, weight: 1, contribution: 0.5 }],
        excluded: ['scene'], sceneExcludedReason: 'no_scene_context',
      },
    };
    expect(noContext.render()).toContain(zh['cognition.ranking_scene_no_context_note']);

    const noMatch = detail();
    noMatch.ns.rankingWhy = {
      assetId: 'aa-tag-1', turnId: 'turn-rk-no-match',
      item: {
        taskRunId: 'turn-rk-no-match', assetId: 'aa-tag-1', explainable: true, score: 0.5,
        factors: [{ name: 'adoption', raw: 0.5, weight: 1, contribution: 0.5 }],
        excluded: ['scene'], sceneExcludedReason: 'no_matching_association',
      },
    };
    expect(noMatch.render()).toContain(zh['cognition.ranking_scene_no_match_note']);
  });

  it('使用记录里没有回合 → 「这一轮没有进入目录」；读取失败 → 如实说取不到', () => {
    const noTurn = detail();
    noTurn.ns.rankingWhy = { assetId: 'aa-tag-1' };
    const noTurnHtml = noTurn.render();
    expect(noTurnHtml).toContain(zh['cognition.ranking_not_in_catalog']);

    const failed = detail();
    failed.ns.rankingWhy = { assetId: 'aa-tag-1', failed: true, error: 'boom' };
    expect(failed.render()).toContain(zh['cognition.ranking_load_failed']);
  });

  it('weightsSource=invalid-fallback → 醒目提示「你的权重配置没生效」', () => {
    const loaded = detail();
    loaded.ns.rankingWhy = {
      assetId: 'aa-tag-1', turnId: 'turn-rk-2',
      item: {
        taskRunId: 'turn-rk-2', assetId: 'aa-tag-1', explainable: true, score: 0.5,
        factors: [{ name: 'adoption', raw: 0.5, weight: 1, contribution: 0.5 }],
        excluded: ['relevance', 'scene'], weightsSource: 'invalid-fallback',
      },
    };
    const html = loaded.render();
    expect(html).toContain(zh['cognition.ranking_weights_invalid_note']);
    expect(html).toContain('ca-rank-warn');
    // relevance 缺席同样给一句人话（不是显示 0）。
    expect(html).toContain(zh['cognition.ranking_relevance_absent_note']);
  });

  it('权重卡已彻底移除（G1 拍板项 #3）：整理设置页不再渲染任何权重编辑入口', () => {
    const loaded = loadCognition({
      route: { name: 'organize-settings' },
    });
    loaded.ns.rankingWeights = {
      weights: { relevance: 1, adoption: 3, scene: 0.8, maturity: 0.4 },
      defaults: { relevance: 1, adoption: 1, scene: 0.8, maturity: 0.4 },
      source: 'configured',
    };
    const html = loaded.render();
    // 旧排序已换 v2 引擎（6f3ff075），权重卡是旧引擎遗物：卡壳、输入框、
    // 保存/重置按钮全部不再渲染；「高级设置」折叠留给巡检卡（G2）。
    expect(html).not.toContain('data-ranking-weights');
    expect(html).not.toContain('data-w="relevance"');
    expect(html).not.toContain(`data-act="ranking-weights-reset"`);
    expect(html).not.toContain(`data-act="ranking-weights-save"`);
    expect(zh['cognition.ranking_weights_title']).toBeUndefined(); // G1 终态：四语词条已随权重卡一并移除（过渡哨兵断言到期改写）
  });

  it('源码级：app.js 只保留排序依据只读接线——ranking 按当前回合该资产取；权重保存接线已随权重卡删除', () => {
    // 详情装载：只查「该资产最近一次回合」的一条（limit 1，带 assetId）。
    expect(appSource).toContain("'recall.catalog.ranking'");
    expect(appSource).toContain('taskRunId: turnId, assetId: id, limit: 1');
    // 权重卡的保存/重置接线与数据装载已删（G1 拍板项 #3）；写通道本体后端保留。
    expect(appSource).not.toContain("'ranking-weights-save'");
    expect(appSource).not.toContain("'recall.catalog.weights.set'");
    expect(appSource).not.toContain('showWeightsError');
    expect(appSource).not.toContain('loadRankingWeights');
  });
});

describe('详情五区骨架（2026-09-28 设计五章对照表）', () => {
  const VERSION_STATE = {
    assetVersions: {
      assetId: 'aa-tag-1',
      versions: [{ version: '1', snapshot: { title: '发布流程经验', statement: '正文一：走灰度发布。' }, reason: 'created' }],
      usage: [],
      audit: [{ action: 'created', at: '2026-09-24T01:00:00Z', actor: 'user', reason: '手动保存' }],
    },
  };

  it('资产详情：版本信息归④「使用与版本」明细折叠；标签/归并/生命周期台账归⑤侧栏治理折叠（2026-09-29 重构：台账并入治理折叠体）', () => {
    const { render } = loadCognition({
      route: { assetId: 'aa-tag-1' },
      state: VERSION_STATE,
    });
    const html = render();
    // ④明细折叠（类名保留：usage-consistency 的「编辑入口在折叠之上」锚点）。
    expect(html).toContain('ca-detail-history');
    // 版本历史在④明细折叠内（版本信息归④），且治理折叠不含版本区。
    const historyStart = html.indexOf('ca-detail-history');
    const governanceStart = html.indexOf('ca-detail-governance');
    expect(historyStart).toBeGreaterThan(-1);
    expect(governanceStart).toBeGreaterThan(-1);
    // ⑤治理折叠：标签 + 归并 + 台账（生命周期记录不再自撑折叠，行并入折叠体）。
    // （「治理与历史」为新词条、四语由 locale 收尾批统一落，断言用代码内联回退文本。）
    expect(html).toContain('治理与历史');
    expect(html).toContain(zh['cognition.asset_merge_section']);
    expect(html.indexOf('data-act="tag-add"')).toBeGreaterThan(governanceStart);
    // 台账行（fixture 的 reason「手动保存」）在治理折叠体之后出现。
    expect(html.indexOf('手动保存')).toBeGreaterThan(governanceStart);
  });

  it('资产编辑表单：治理类信息（适用/禁用场景、可见范围）收进「高级选项」折叠', () => {
    const { render } = loadCognition({
      route: { assetId: 'aa-tag-1', assetEdit: '1' },
      state: VERSION_STATE,
    });
    const html = render();
    expect(html).toContain(zh['cognition.candidate_advanced']);
    expect(html).toContain('data-f="applicable"');
    expect(html).toContain('data-f="forbidden"');
    // 治理字段必须在「高级选项」折叠内（其后），不再平铺在正文之后。
    expect(html.indexOf('data-f="applicable"')).toBeGreaterThan(html.indexOf(zh['cognition.candidate_advanced']));
  });

  it('经验详情：预期/实际归②内容区；归并治理与管理台账收⑤侧栏管理卡折叠', () => {
    const experience = {
      id: 'exp-1', title: '灰度发布经验', status: 'active', experienceType: 'lesson',
      taskType: 'code', scope: 'code', body: '先小流量再全量。', expected: '指标平稳',
      actual: '回滚一次', applicableWhen: ['发布'], forbiddenWhen: [], evidenceRefs: [],
      mergedFrom: [], history: [{ action: 'paused', at: '2026-09-24T01:00:00Z', actor: 'user' }],
      verification: { state: 'unverified' }, updatedAt: '2026-09-24T01:00:00Z', createdAt: '2026-09-24T01:00:00Z',
    };
    const other = { ...experience, id: 'exp-2', title: '另一条同类经验' };
    const { render } = loadCognition({
      route: { experienceId: 'exp-1' },
      state: {
        experienceDetail: { experienceId: 'exp-1', loading: false, failed: false, experience },
        experiences: { items: [experience, other], loading: false, failed: false, stale: false },
      },
    });
    const html = render();
    // ②内容区：预期/实际与正文同区（在主栏正文卡内，先于侧栏管理卡）。
    expect(html).toContain(zh['cognition.experience_expected']);
    expect(html).toContain(zh['cognition.experience_actual']);
    // ⑤：归并治理与管理台账收进侧栏「管理」卡（在管理动作之后）。
    const manageAt = html.indexOf(zh['cognition.experience_manage_section']);
    expect(manageAt).toBeGreaterThan(-1);
    expect(html.indexOf(zh['cognition.experience_merge_section'])).toBeGreaterThan(manageAt);
    expect(html.indexOf(zh['cognition.experience_history_section'])).toBeGreaterThan(manageAt);
  });
});

describe('「记一条」（设计 7.2：手动新建候选）', () => {
  it('列表页头与空库空态都给「记一条」入口', () => {
    const withAssets = loadCognition({});
    const html = withAssets.render();
    expect(html).toContain('data-act="cand-create"');

    const emptyLib = loadCognition({ state: { assets: [] } });
    const emptyHtml = emptyLib.render();
    expect(emptyHtml).toContain('data-act="cand-create"');
    // 空态原有引导（去待我处理）保留。
    expect(emptyHtml).toContain(zh['cognition.overview_empty_go_review']);
  });

  it('candCreate=1 渲染表单卡：复用候选表单五字段与 cand-type/readCandidateForm 契约', () => {
    const { render } = loadCognition({ route: { candCreate: '1' } });
    const html = render();
    expect(html).toContain('data-manual-candidate');
    expect(html).toContain('data-cand-type="personal"');
    // readCandidateForm 就近读取的五个 [data-f] 字段齐备（summary=标题，必填提示见保存动作）。
    for (const field of ['summary', 'judgment', 'value', 'scope', 'uncertainty']) {
      expect(html).toContain(`data-f="${field}"`);
    }
    // 类型 chips 复用 cand-type（就地切换，不重画、不丢输入）。
    expect(html).toContain('data-act="cand-type"');
    expect(html).toContain('data-act="cand-create-save"');
    expect(html).toContain('data-act="cand-create-cancel"');
  });

  it('保存走 recall.candidates.save 产生候选（suggestedAction=create、空来源数组）并提示去待我处理', async () => {
    const invoke = vi.fn(async () => ({ ok: true, candidate: { id: 'cand-new' } }));
    const loaded = loadCognition({ invoke });
    await loaded.ns.actions.saveManualCandidate({
      summary: '发布走灰度', judgment: '发布前先小流量验证。', suggestedType: 'rule', suggestedScope: '',
    });
    const calls = callOf(invoke, 'recall.candidates.save');
    expect(calls).toHaveLength(1);
    const payload = calls[0][1];
    expect(payload.summary).toBe('发布走灰度');
    expect(payload.judgment).toBe('发布前先小流量验证。');
    expect(payload.suggestedType).toBe('rule');
    expect(payload.suggestedAction).toBe('create');
    // 手动创建没有对话来源：来源与证据都为空；manual 标记让主进程豁免
    // "证据不足"降级（拍板 A：手动候选的证据就是用户本人的直接输入），
    // 直接 pending_review 可确认，不直接入库。
    expect(payload.sourceRefs).toEqual([]);
    expect(payload.manual).toBe(true);
    // suggestedScope 兜底 general（通道要求字符串）。
    expect(payload.suggestedScope).toBe('general');
    expect(loaded.toasts.some((toast) => toast.message.includes('待我处理'))).toBe(true);
  });

  it('标题或内容缺一不提交，给必填提示（标题必填口径）', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const loaded = loadCognition({ invoke });
    await loaded.ns.actions.saveManualCandidate({ summary: '', judgment: '', suggestedType: 'personal' });
    expect(callOf(invoke, 'recall.candidates.save')).toHaveLength(0);
    expect(loaded.toasts.some((toast) => toast.variant === 'warning')).toBe(true);
  });
});
