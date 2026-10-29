import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
}
const asset = { id: 'asset-fast', type: 'cognition', contentCategory: 'rule', title: '首屏认知', statement: '确认来源与边界。', status: 'active', version: '1', scope: 'review' };
function setup(invoke: any) {
  const loaded = loadCognitionAssets({ loaded: false, blockStatus: {}, assetScopeOptions: { status: 'ready', agents: [], spaces: [] } }, {}, { cogseed: { invoke } });
  // Install the real app's route/detail hooks, without starting a second DOM boot.
  loaded.context.document.readyState = 'loading';
  loaded.context.document.addEventListener = () => {};
  loaded.context.document.querySelector = () => null;
  loaded.context.requestAnimationFrame = () => 0;
  runInContext(readFileSync(resolve(__dirname, '../../src/renderer/modules/cognition-assets/app.js'), 'utf8'), loaded.context);
  return loaded;
}

describe('认知资产按页签加载', () => {
  it('首屏只等资产；真实详情钩子不预读历史、本体、候选或隐藏目录', async () => {
    const assets = deferred();
    const invoke = vi.fn((channel: string) => channel === 'recall.assets.list' ? assets.promise : new Promise(() => {}));
    const loaded = setup(invoke);
    const pending = loaded.ns.loadRoute();
    expect(loaded.render()).toContain('ca-loading');
    await Promise.resolve();
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['recall.assets.list']);
    assets.resolve({ ok: true, assets: [asset] });
    await pending;
    expect(loaded.render()).toContain('首屏认知');
    expect(loaded.render()).not.toContain('ca-loading');
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['recall.assets.list']);
    await loaded.ns.loadRoute();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('本体读取在自己的页签显示加载/错误，不阻塞已就绪的资产页', async () => {
    const ontology = deferred();
    const invoke = vi.fn(async channel => channel === 'recall.assets.list' ? { assets: [asset] } : ontology.promise);
    const loaded = setup(invoke);
    await loaded.ns.loadRoute();
    loaded.store.route = { name: 'ontology' };
    const pending = loaded.ns.loadRoute();
    expect(loaded.render()).toContain('ca-loading');
    loaded.store.route = { name: 'overview' };
    expect(loaded.render()).toContain('首屏认知');
    ontology.resolve({ ok: false, error: 'ontology disk unavailable' });
    await pending;
    loaded.store.route = { name: 'ontology' };
    expect(loaded.render()).not.toContain('ca-loading');
    expect(loaded.store.ontologyError).toBe('ontology disk unavailable');
    expect(loaded.store.assets).toEqual([asset]);
  });

  it('未访问页签的变更延迟读取，进入页签后读取最新数据', async () => {
    let changed!: (notice: any) => void;
    const invoke = vi.fn(async channel => channel === 'recall.assets.list' ? { assets: [asset] }
      : channel === 'recall.candidates.list' ? { candidates: [{ id: 'candidate-latest' }] } : { ok: true });
    const loaded = setup(invoke);
    loaded.window.cogseed.onPushEvent = (_channel: string, callback: any) => { changed = callback; };
    await loaded.ns.loadRoute();
    loaded.ns.setupChangeRail(() => true);
    changed({ collection: 'candidates' });
    await loaded.ns.flushPendingRefresh();
    expect(invoke).toHaveBeenCalledOnce();
    loaded.store.route = { name: 'activity' };
    await loaded.ns.loadRoute();
    expect(loaded.store.candidates).toEqual([{ id: 'candidate-latest' }]);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'recall.candidates.list')).toHaveLength(1);
  });

  it('详情按需读取期间给出忙状态，重复点击不重复打开且保留焦点返回目标', async () => {
    const loaded = setup(vi.fn(async () => ({ ok: true })));
    const read = deferred();
    loaded.ns.showLibraryDialog = vi.fn(() => read.promise);
    const button = { dataset: { act: 'library-show-versions', id: asset.id } as Record<string, string>,
      classList: { add: vi.fn(), remove: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn() };
    const pending = loaded.ns.library.handleClick(button);
    expect(button.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');
    expect(button.setAttribute).not.toHaveBeenCalledWith('disabled', expect.anything());
    await loaded.ns.library.handleClick(button);
    expect(loaded.ns.showLibraryDialog).toHaveBeenCalledOnce();
    read.resolve(null); await pending;
    expect(button.removeAttribute).toHaveBeenCalledWith('aria-busy');
    expect(button.dataset.pendingRead).toBeUndefined();
  });
  it('资产读取失败可见且重试可恢复，不把读取失败显示成空库', async () => {
    const invoke = vi.fn(async () => ({ ok: false, error: 'disk unavailable' }));
    const loaded = setup(invoke);
    await loaded.ns.loadRoute();
    expect(loaded.render()).toContain('认知内容未能读取');
    invoke.mockImplementation(async channel => channel === 'recall.assets.list' ? { assets: [asset] } : { ok: true });
    await loaded.ns.reload();
    expect(loaded.render()).toContain('首屏认知');
    expect(loaded.store.assetsError).toBe('');
  });
});


it('activity loads ontology names through the existing cached read without changing the library route', async () => {
  const invoke = vi.fn(async (channel: string) => channel === 'cognition.ontology.snapshot' ? { ontology: { records: { synthetic: { name: '设备' } } } } : { ok: true });
  const loaded = setup(invoke);
  await loaded.ns.loadActivityOntology(); await loaded.ns.loadActivityOntology();
  expect(loaded.store.ontologySnapshot.records.synthetic.name).toBe('设备');
  expect(invoke).toHaveBeenCalledOnce();
});

it('统一收件箱只在展示页读取，离开期间的变化回到展示页时补读', async () => {
  let changed!: (notice: any) => void;
  const invoke = vi.fn(async (channel: string) => channel === 'recall.assets.list' ? { assets: [asset] }
    : channel === 'cognition.inbox.list' ? { ok: true, items: [] } : { ok: true });
  const loaded = setup(invoke);
  loaded.window.cogseed.onPushEvent = (_channel: string, callback: any) => { changed = callback; };
  loaded.ns.setupChangeRail(() => true);
  const inboxReads = () => invoke.mock.calls.filter(([channel]) => channel === 'cognition.inbox.list').length;
  await loaded.ns.loadRoute();
  changed({ collection: 'candidates', generation: 1 });
  await loaded.ns.flushPendingRefresh();
  expect(inboxReads()).toBe(0);
  loaded.store.route = { name: 'activity' };
  await loaded.ns.loadRoute();
  expect(inboxReads()).toBe(1);
  loaded.store.route = { name: 'overview' };
  await loaded.ns.loadRoute();
  changed({ collection: 'candidates', generation: 2 });
  await loaded.ns.flushPendingRefresh();
  expect(inboxReads()).toBe(1);
  loaded.store.route = { name: 'activity' };
  await loaded.ns.loadRoute();
  expect(inboxReads()).toBe(2);
});
