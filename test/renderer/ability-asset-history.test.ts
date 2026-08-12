/**
 * N4: the asset detail page shows usage records — "这条认知真的被带进过哪几次任务" —
 * alongside version history.
 *
 * Structure note (develop merge): version history, its fetch, and the panel
 * open/close now belong to develop's `_renderRecallAssetHistory` +
 * `assetHistoryById`, driven by an explicit button in skills-bindings.js and
 * covered by `recall-cognition-flow.test.ts`. Usage was migrated into that same
 * panel rather than keeping a second, competing history panel, so these tests
 * seed the panel state and assert on what the usage block renders. Fetching is
 * no longer render-triggered, so there is nothing to assert about fetch counts
 * here.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const root = path.join(__dirname, '../..');
const statusSource = fs.readFileSync(path.join(root, 'src/renderer/modules/ability-asset-status.js'), 'utf8');
const skillsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills.js'), 'utf8');
const bindingsSource = fs.readFileSync(path.join(root, 'src/renderer/modules/skills-bindings.js'), 'utf8');
const zhLocale = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/locales/zh.json'), 'utf8'));

interface Harness {
  ctx: any;
  host: { innerHTML: string };
  render: () => void;
  /** Seed the history panel the way skills-bindings.js does after its fetches. */
  seed: (entry: Record<string, unknown>) => void;
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

function harness(): Harness {
  // The asset render path touches only getElementById + innerHTML, so a
  // two-property stub is enough and keeps jsdom out of the dependency list.
  const host = { innerHTML: '' };
  const invoke = vi.fn(async () => ({ ok: true }));

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
    Number,
    JSON,
    Date,
  };
  ctx.globalThis = ctx;
  ctx.window = { cogseed: { invoke }, addEventListener() {}, removeEventListener() {} };
  ctx.cogseed = ctx.window.cogseed;
  ctx.addEventListener = () => {};
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
    host,
    render: () => ctx.renderSkillsCognitionAssets(),
    seed: (entry) => {
      ctx.__cognitionState.visibleAssetHistoryId = ASSET.id;
      ctx.__cognitionState.assetHistoryById[ASSET.id] = entry;
    },
  };
}

const VERSIONS = [
  { assetId: ASSET.id, version: '1', at: '2026-08-01T00:00:00.000Z', snapshot: { title: 'First title' } },
  { assetId: ASSET.id, version: '2', at: '2026-08-02T00:00:00.000Z', snapshot: { title: 'Second title' } },
];

const USAGE = [
  { id: 'usage-1', assetId: ASSET.id, assetVersion: '1', taskRunId: 'run-alpha', outcome: 'better', boundary: 'real', createdAt: '2026-08-03T00:00:00.000Z' },
  { id: 'usage-2', assetId: ASSET.id, assetVersion: '2', taskRunId: 'run-beta', outcome: 'no_improvement', boundary: 'test-double', createdAt: '2026-08-04T00:00:00.000Z' },
];

describe('N4 usage records in the history panel', () => {
  it('renders usage rows newest first with run id and outcome', () => {
    const h = harness();
    h.seed({ loading: false, versions: VERSIONS, usageLoading: false, usage: USAGE });
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain('使用记录');
    expect(html).toContain('run-beta');
    expect(html).toContain('better');
    expect(html.indexOf('run-beta')).toBeLessThan(html.indexOf('run-alpha'));
  });

  it('flags a non-real boundary so mock runs are not read as evidence', () => {
    const h = harness();
    h.seed({ loading: false, versions: VERSIONS, usageLoading: false, usage: USAGE });
    h.render();

    // run-beta was recorded with boundary 'test-double'.
    expect(h.host.innerHTML).toContain(zhLocale['cognition.usage_boundary_test-double']);
  });

  it('shows the empty state when the asset has never been used', () => {
    const h = harness();
    h.seed({ loading: false, versions: VERSIONS, usageLoading: false, usage: [] });
    h.render();

    expect(h.host.innerHTML).toContain(zhLocale['cognition.no_usage_records']);
  });

  it('shows loading while the usage call is still in flight', () => {
    const h = harness();
    h.seed({ loading: false, versions: VERSIONS, usageLoading: true, usage: [] });
    h.render();

    expect(h.host.innerHTML).toContain(zhLocale['cognition.loading']);
  });

  it('surfaces a failed usage call without blanking versions', () => {
    // A usage-service failure must not make the version list look empty —
    // that would read as "这条从没被改过", a different and wrong claim.
    const h = harness();
    h.seed({ loading: false, versions: VERSIONS, usageLoading: false, usageError: 'usage unavailable' });
    h.render();

    const html = h.host.innerHTML;
    expect(html).toContain('usage unavailable');
    expect(html).toContain('Second title');
  });

  it('hides the whole panel until the user opens it for this asset', () => {
    const h = harness();
    h.ctx.__cognitionState.assetHistoryById[ASSET.id] = { loading: false, versions: VERSIONS, usageLoading: false, usage: USAGE };
    h.ctx.__cognitionState.visibleAssetHistoryId = '';
    h.render();

    expect(h.host.innerHTML).not.toContain('使用记录');
  });
});

describe('scope guard', () => {
  it('fetches usage independently of versions so one outage cannot blank the other', () => {
    // The usage fetch must not sit inside the awaited versions chain.
    const opener = bindingsSource.slice(
      bindingsSource.indexOf("if (actionName === 'versions')"),
      bindingsSource.indexOf("if (actionName === 'revoke')"),
    );
    expect(opener).toContain("invoke('recall.usage.list'");
    expect(opener).toContain("invoke('recall.assets.versions'");
    expect(opener).not.toContain("await window.cogseed.invoke('recall.usage.list'");
  });

  it('adds no new main-side handler, reusing the registered channels', () => {
    const ipc = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');
    expect(ipc).toContain("'recall.assets.versions'");
    expect(ipc).toContain("'recall.usage.list'");
  });
});
