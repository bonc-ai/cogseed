/**
 * 标签系统渲染层退役用例（specs/012 收口）。
 *
 * 断言列表筛选条、管理弹层、批量打标、详情打标入口及旧深链参数不再出现；
 * 旧标签参数也不得暗中筛掉资产。主进程打标/批量仍由
 * test/main/features/recall/asset-tag-system.test.ts 覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const zh: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8'),
);

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

/** 装载真实 core/views/library 工作台；旧标签参数仍不得成为隐式筛选。 */
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
    'ui-button.js', 'ui-card.js', 'ui-status.js', 'ui-form.js', 'ui-empty.js', 'ui-segmented-control.js', 'ui-structure.js',
    'cognition-assets/core.js', 'cognition-assets/views.js',
    'cognition-assets/review-candidate.js', 'cognition-assets/review-views.js', 'cognition-assets/library.js',
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
    blockStatus: { assets: { loaded: true } },
    ...(options.state || {}),
  }, {
    route: {
      name: 'overview', category: '', assetId: '', candidateId: '', proofEventId: '',
      captureBucket: '', captureId: '', sourceIssueOpen: '', kstarEpisodeId: '',
      assetVersionId: '', assetEdit: '', assetVersionDiff: '', assetVersionsExpanded: '',
      assetView: '', experienceId: '',
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

describe('标签管理功能退役', () => {
  it('移除列表筛选条、管理弹层、批量打标和详情打标入口', () => {
    const list = loadCognition({ state: { tags: { items: TAG_ITEMS } }, route: { tagOverlay: 'manage', tagSelect: '1' } }).render();
    expect(list).not.toContain('data-act="tag-');
    expect(list).not.toContain('ca-tag-filter');
    expect(list).not.toContain('ca-tag-overlay-slot');
    expect(list).not.toContain('data-act="filter-tag');
    const detail = loadCognition({ route: { assetId: TAG_ASSETS[0].id } }).render();
    expect(detail).not.toContain('data-asset-tags');
    expect(detail).not.toContain('data-tag-input');
  });
  it('旧标签深链不会暗中筛掉资产，路由会移除退役参数', () => {
    const { ns, render } = loadCognition({ route: { tagFilter: '不存在', tagUntagged: '1', tagMode: 'all' } });
    const html = render();
    for (const asset of TAG_ASSETS) expect(html).toContain(asset.title);
    ns.router.go({ name: 'overview', tagOverlay: 'manage', tagFilter: '不存在', tagSelect: '1' });
    expect(ns.store.route).not.toHaveProperty('tagOverlay');
    expect(ns.store.route).not.toHaveProperty('tagFilter');
    expect(ns.actions).not.toHaveProperty('deleteTag');
  });
});
