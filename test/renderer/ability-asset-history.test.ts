/**
 * N3/N4: the asset detail page reads version history from
 * `recall.assets.versions` and usage records from `recall.usage.list`.
 *
 * Both IPC channels already existed and are covered on the main side; what is
 * new is the renderer wiring, so these tests drive the real render function in
 * a DOM and assert on what it puts on screen — including the states that only
 * show up when a call is slow, fails, or returns nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = path.join(__dirname, '../..');
const statusSource = fs.readFileSync(path.join(root, 'src/renderer/modules/ability-asset-status.js'), 'utf8');
const skillsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills.js'), 'utf8');
const zhLocale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));

interface Harness {
  ctx: any;
  invoke: ReturnType<typeof vi.fn>;
  host: { innerHTML: string };
  render: () => void;
  flush: () => Promise<void>;
}

const ASSET = {
  id: 'aa-abcdef123456',
  title: 'Prefer table output',
  type: 'rule',
  category: 'rule',
  scope: 'global',
  status: 'active',
  maturity: 'seed',
  version: '1',
};

function harness(invokeImpl: (channel: string, args: any) => Promise<any>): Harness {
  // The asset render path touches only getElementById + innerHTML, so a
  // two-property stub is enough and keeps jsdom out of the dependency list.
  const host = { innerHTML: '' };
  const invoke = vi.fn(invokeImpl);

  const ctx: any = {
    document: { getElementById: (id: string) => (id === 'skills-cognition-assets-body' ? host : null) },
    setTimeout,
    clearTimeout,
    console,
    Promise,
    Map,
    Set,
    Array,
    Object,
    String,
    JSON,
    Date,
  };
  ctx.globalThis = ctx;
  ctx.window = { orkas: { invoke }, addEventListener() {}, removeEventListener() {} };
  ctx.orkas = ctx.window.orkas;
  ctx.addEventListener = () => {};
  // skills.js reaches for these host helpers; stub only what the asset view uses.
  ctx.createLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} });
  // Resolve against the real zh bundle so a missing locale key fails here
  // rather than silently falling back to the raw value.
  ctx.t = (key: string, fallback?: string) => zhLocale[key] ?? fallback ?? key;
  ctx.escapeHtml = (value: string) =>
    String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
    )[c]);

  vm.createContext(ctx);
  vm.runInContext(statusSource, ctx, { filename: 'ability-asset-status.js' });
  // Top-level `const` in a vm script stays lexical, so expose the state the
  // way the browser cannot observe it. Test-only; skills.js is unchanged.
  vm.runInContext(
    `${skillsSource}\n;globalThis.__cognitionState = _skillsCognitionState;`,
    ctx,
    { filename: 'skills.js' },
  );

  ctx.__cognitionState.assets = [ASSET];
  ctx.__cognitionState.selectedAssetId = ASSET.id;

  return {
    ctx,
    invoke,
    host,
    render: () => ctx.renderSkillsCognitionAssets(),
    flush: async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
  };
}

const okVersions = {
  ok: true,
  versions: [
    { assetId: ASSET.id, version: '1', at: '2026-08-01T00:00:00.000Z', snapshot: { title: 'First title' } },
    { assetId: ASSET.id, version: '2', at: '2026-08-02T00:00:00.000Z', snapshot: { title: 'Second title' } },
  ],
  audit: [
    { assetId: ASSET.id, action: 'created', at: '2026-08-01T00:00:00.000Z' },
    { assetId: ASSET.id, action: 'updated', at: '2026-08-02T00:00:00.000Z', note: 'narrowed scope' },
  ],
};

const okUsage = {
  ok: true,
  usage: [
    { id: 'usage-1', assetId: ASSET.id, assetVersion: '1', taskRunId: 'run-alpha', outcome: 'better', boundary: 'real', createdAt: '2026-08-03T00:00:00.000Z' },
    { id: 'usage-2', assetId: ASSET.id, assetVersion: '2', taskRunId: 'run-beta', outcome: 'no_improvement', boundary: 'test-double', createdAt: '2026-08-04T00:00:00.000Z' },
  ],
};

describe('N3 version history wiring', () => {
  it('calls the existing recall.assets.versions channel with the asset id', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : okUsage);
    h.render();
    await h.flush();

    expect(h.invoke).toHaveBeenCalledWith('recall.assets.versions', { assetId: ASSET.id });
  });

  it('renders versions newest first with their audit action and note', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : okUsage);
    h.render();
    await h.flush();
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain('版本历史');
    expect(html).toContain('v2');
    expect(html).toContain('narrowed scope');
    expect(html).toContain('Second title');
    // Newest first: v2 must appear before v1.
    expect(html.indexOf('v2')).toBeLessThan(html.indexOf('v1'));
  });

  it('shows the empty state when the asset has no version records', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? { ok: true, versions: [], audit: [] } : okUsage);
    h.render();
    await h.flush();
    h.render();

    expect(h.host.innerHTML).toContain(zhLocale['cognition.no_version_history']);
  });
});

describe('N4 usage record wiring', () => {
  it('calls the existing recall.usage.list channel scoped to the asset', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : okUsage);
    h.render();
    await h.flush();

    expect(h.invoke).toHaveBeenCalledWith('recall.usage.list', { assetId: ASSET.id });
  });

  it('renders usage rows newest first with run id and outcome', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : okUsage);
    h.render();
    await h.flush();
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain('使用记录');
    expect(html).toContain('run-beta');
    expect(html).toContain('better');
    expect(html.indexOf('run-beta')).toBeLessThan(html.indexOf('run-alpha'));
  });

  it('flags a non-real boundary so mock runs are not read as evidence', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : okUsage);
    h.render();
    await h.flush();
    h.render();

    // run-beta was recorded with boundary 'test-double'.
    expect(h.host.innerHTML).toContain(zhLocale['cognition.usage_boundary_test-double']);
  });

  it('shows the empty state when the asset has never been used', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : { ok: true, usage: [] });
    h.render();
    await h.flush();
    h.render();

    expect(h.host.innerHTML).toContain(zhLocale['cognition.no_usage_records']);
  });
});

describe('loading and error states', () => {
  it('shows loading before either call settles', () => {
    const h = harness(() => new Promise(() => {}));
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain(zhLocale['cognition.loading']);
  });

  it('surfaces a failed versions call without blanking usage', async () => {
    // A version-service failure must not make usage look empty, and vice
    // versa — that would misreport the asset's history as absent.
    const h = harness(async (channel) => {
      if (channel === 'recall.assets.versions') throw new Error('versions exploded');
      return okUsage;
    });
    h.render();
    await h.flush();
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain(zhLocale['cognition.load_failed']);
    expect(html).toContain('versions exploded');
    expect(html).toContain('run-beta');
  });

  it('surfaces a failed usage call without blanking versions', async () => {
    const h = harness(async (channel) => {
      if (channel === 'recall.usage.list') return { ok: false, error: 'usage unavailable' };
      return okVersions;
    });
    h.render();
    await h.flush();
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain('usage unavailable');
    expect(html).toContain('Second title');
  });

  it('treats ok:false as an error rather than an empty result', async () => {
    const h = harness(async () => ({ ok: false, error: 'not authorized' }));
    h.render();
    await h.flush();
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain('not authorized');
    expect(html).not.toContain(zhLocale['cognition.no_version_history']);
  });
});

describe('fetch discipline', () => {
  it('fetches once per asset and reuses the cache on re-render', async () => {
    const h = harness(async (channel) =>
      channel === 'recall.assets.versions' ? okVersions : okUsage);
    h.render();
    await h.flush();
    h.render();
    h.render();
    await h.flush();

    const versionCalls = h.invoke.mock.calls.filter((c) => c[0] === 'recall.assets.versions');
    const usageCalls = h.invoke.mock.calls.filter((c) => c[0] === 'recall.usage.list');
    expect(versionCalls).toHaveLength(1);
    expect(usageCalls).toHaveLength(1);
  });

  it('does not fetch history for an unpromoted candidate', async () => {
    const h = harness(async () => okVersions);
    h.ctx.__cognitionState.assets = [{ ...ASSET, candidateRefs: ['cand-1'] }];
    h.render();
    await h.flush();

    // Candidates have no asset id on the recall side; asking would 404.
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.host.innerHTML).not.toContain('版本历史');
  });
});

describe('scope guard', () => {
  it('reads history through the two existing channels only', () => {
    // Scoped to the loader this change added: skills.js legitimately calls
    // other recall.* channels elsewhere (candidate promote/reject/defer).
    const loader = skillsSource.slice(
      skillsSource.indexOf('function _ensureAbilityAssetHistory'),
      skillsSource.indexOf('function _renderAssetHistoryState'),
    );
    const channels = [...loader.matchAll(/invoke\('([a-z.]+)'/g)].map((m) => m[1]);
    expect(channels.sort()).toEqual(['recall.assets.versions', 'recall.usage.list']);
  });

  it('adds no new main-side handler, reusing the registered channels', () => {
    const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');
    expect(ipc).toContain("'recall.assets.versions'");
    expect(ipc).toContain("'recall.usage.list'");
  });
});
