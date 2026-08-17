import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');

function loadModule(invoke: (channel: string, payload?: unknown) => Promise<unknown>) {
  const source = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/recall-projection-card.js'), 'utf8');
  const host: any = {
    className: '',
    innerHTML: '',
    dataset: {},
    disabled: false,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener(type: string, handler: unknown) { this.handler = handler; this.handlerType = type; },
  };
  const context: any = {
    window: { cogseed: { invoke } },
    document: {},
    escapeHtml: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (_key: string, varsOrFallback?: unknown) => typeof varsOrFallback === 'string' ? varsOrFallback : _key,
    uiAlert: vi.fn(),
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'recall-projection-card.js' });
  return { context, host };
}

const previewCard = {
  kind: 'recall_projection_card',
  projectionId: 'proj-a',
  status: 'preview',
  purpose: 'review',
  summary: { includedCount: 1, omittedCount: 0, sourceRefCount: 1, text: 'Found 1 asset' },
  assetSummaries: [{ assetId: 'asset-old', title: 'Old asset', type: 'rule', status: 'active', maturity: 'leaf', scope: 'review', version: '1' }],
  availableActions: ['confirm', 'add_asset', 'defer', 'reject'],
};

describe('recall projection card renderer', () => {
  it('renders a task-level editable projection card without formal delete actions', async () => {
    const calls: Array<[string, unknown]> = [];
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') return { ok: true, card: previewCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [{ id: 'asset-new', title: 'New asset', type: 'rule', status: 'active', maturity: 'leaf', scope: 'review', version: '2' }] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).toContain('Old asset');
    expect(host.innerHTML).toContain('Remove candidate');
    expect(host.innerHTML).toContain('Preload candidates');
    expect(host.innerHTML).toContain('Add candidate');
    expect(host.innerHTML).not.toContain('prediction');
    expect(host.innerHTML).not.toContain('R̂');
    expect(host.innerHTML).toContain('New asset');
    expect(host.innerHTML).not.toContain('Delete ability asset');
    expect(calls).toEqual([
      ['recall.projections.card', { projectionId: 'proj-a' }],
      ['recall.projections.availableAssets', { projectionId: 'proj-a' }],
    ]);
  });

  it('shows a retryable Forecast failure without claiming execution started', async () => {
    const calls: Array<[string, unknown]> = [];
    let failConfirm = true;
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') return { ok: true, card: { ...previewCard, status: 'preview' } };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      if (channel === 'recall.projections.confirm' && failConfirm) {
        failConfirm = false;
        throw Object.assign(new Error('model configuration is required'), { code: 'model_not_configured' });
      }
      if (channel === 'recall.projections.retryForecast') return { ok: true, forecast: { id: 'wf-a' }, resumed: true };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });
    await host.handler({ target: { closest: (selector: string) => selector === '[data-recall-projection-confirm]' ? { disabled: false } : null } });

    expect(host.textContent || host.innerHTML).toContain('Forecast failed; task has not started.');
    expect(host.innerHTML).toContain('Retry forecast');
    expect(calls.some(([channel]) => channel === 'group_chat.resume')).toBe(false);

    await host.handler({ target: { closest: (selector: string) => selector === '[data-recall-projection-retry]' ? { disabled: false } : null } });
    expect(calls).toContainEqual(['recall.projections.retryForecast', { projectionId: 'proj-a', cid: 'cid-a' }]);
  });

  it('sends add and remove edits only to projection revision IPC', async () => {
    const calls: Array<[string, unknown]> = [];
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') return { ok: true, card: previewCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [{ id: 'asset-new', title: 'New asset', type: 'rule', status: 'active', maturity: 'leaf', scope: 'review', version: '2' }] };
      if (channel === 'recall.projections.revise') return { ok: true, projection: { id: 'proj-a', status: 'preview' } };
      return { ok: true };
    });
    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    await host.handler({ target: { closest: (selector: string) => selector === '[data-recall-projection-remove]' ? { dataset: { recallProjectionRemove: 'asset-old' }, disabled: false } : null } });
    await host.handler({ target: { closest: (selector: string) => selector === '[data-recall-projection-add]' ? { dataset: { recallProjectionAdd: 'asset-new' }, disabled: false } : null } });

    expect(calls).toContainEqual(['recall.projections.revise', { projectionId: 'proj-a', removeAssetIds: ['asset-old'] }]);
    expect(calls).toContainEqual(['recall.projections.revise', { projectionId: 'proj-a', addAssetIds: ['asset-new'] }]);
    expect(calls.some(([channel]) => channel.startsWith('recall.assets.') && channel !== 'recall.assets.list')).toBe(false);
  });




  it('shows that users can add assets even when no assets match automatically', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: { ...previewCard, summary: { includedCount: 0, omittedCount: 0, sourceRefCount: 1, text: 'Found 0 assets' }, assetSummaries: [] } };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [{ id: 'asset-new', title: 'New asset', type: 'rule', status: 'active', maturity: 'leaf', scope: 'review', version: '2' }] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).toContain('No preload candidates selected.');
    expect(host.innerHTML).toContain('Add candidate');
    expect(host.innerHTML).toContain('New asset');
  });

  it('surfaces asset governance state on projection rows without adding formal asset mutations', async () => {
    const governed = {
      ...previewCard,
      assetSummaries: [{ assetId: 'asset-old', title: 'Old asset', type: 'rule', status: 'paused', maturity: 'seed', scope: 'review', version: '1', recommendedAction: 'rework', recommendationReason: 'Needs a narrower scope.' }],
    };
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: governed };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).toContain('Paused');
    expect(host.innerHTML).toContain('Rework recommended');
    expect(host.innerHTML).toContain('Needs a narrower scope.');
    expect(host.innerHTML).not.toContain('recall.assets.pause');
  });

  it('confirms the preloaded asset draft through projection confirmation IPC', async () => {
    const calls: Array<[string, unknown]> = [];
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') return { ok: true, card: previewCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      if (channel === 'recall.projections.confirm') return { ok: true, projection: { id: 'proj-a', status: 'confirmed' } };
      return { ok: true };
    });
    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).toContain('Confirm candidates');
    await host.handler({ target: { closest: (selector: string) => selector === '[data-recall-projection-confirm]' ? { dataset: { recallProjectionConfirm: '1' }, disabled: false } : null } });

    expect(calls).toContainEqual(['recall.projections.confirm', { projectionId: 'proj-a', cid: 'cid-a' }]);
    expect(calls.some(([channel]) => channel.includes('prediction'))).toBe(false);
  });

  it('renders confirmed projections as locked', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: { ...previewCard, status: 'confirmed', availableActions: [] } };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [{ id: 'asset-new', title: 'New asset' }] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).toContain('Confirmed');
    expect(host.innerHTML).not.toContain('Remove candidate');
    expect(host.innerHTML).not.toContain('Add asset to this task');
  });

  it('preserves Recall projection metadata while adapting Group Chat history messages', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/conversation.js'), 'utf8');
    const start = source.indexOf('function _groupMsgToLegacy');
    const end = source.indexOf('\nfunction _hashRenderText', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const adapterSource = source.slice(start, end);
    const sandbox = {
      _groupActorLabel: () => '',
      _normalizeCreatedAgents: () => null,
      _normalizeCreatedSkills: () => null,
      _groupMessageSystemKind: () => '',
      Date,
    };
    const adapt = vm.runInNewContext(`${adapterSource}; _groupMsgToLegacy`, sandbox);

    expect(adapt({
      id: 'msg-projection',
      ts: '2026-08-12T14:03:29',
      from: 'commander',
      text: 'Preload candidates: 0; add or remove as needed.',
      recall_projection_card: { projectionId: 'proj-a' },
    })).toMatchObject({
      role: 'assistant',
      recall_projection_card: { projectionId: 'proj-a' },
    });
  });

  it('uses localized candidate counts instead of the backend English summary text', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: previewCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).not.toContain('Found 1 asset');
    expect(host.innerHTML).toContain('1 preload candidates.');
  });

  it('conversation renderer mounts Recall projection cards carried by assistant messages', () => {
    // 9.1 重构：挂载函数在独立模块 recall-projection-card.js（window.
    // mountRecallProjectionCard），conversation.js 负责透传 recall_
    // projection_card 字段（gm. 前缀的群消息归一化对象）。
    const source = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/conversation.js'), 'utf8');
    expect(source).toContain('gm.recall_projection_card');
    const cardSource = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/recall-projection-card.js'), 'utf8');
    expect(cardSource).toContain('window.mountRecallProjectionCard');
  });

});
