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
    expect(host.innerHTML).toContain('Remove from this task');
    expect(host.innerHTML).toContain('Preloaded assets for this task');
    expect(host.innerHTML).toContain('Add preloaded asset');
    expect(host.innerHTML).not.toContain('prediction');
    expect(host.innerHTML).not.toContain('R̂');
    expect(host.innerHTML).toContain('New asset');
    expect(host.innerHTML).not.toContain('Delete ability asset');
    expect(calls).toEqual([
      ['recall.projections.card', { projectionId: 'proj-a' }],
      ['recall.projections.availableAssets', { projectionId: 'proj-a' }],
    ]);
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

    expect(host.innerHTML).toContain('Confirm preloaded assets');
    await host.handler({ target: { closest: (selector: string) => selector === '[data-recall-projection-confirm]' ? { dataset: { recallProjectionConfirm: '1' }, disabled: false } : null } });

    expect(calls).toContainEqual(['recall.projections.confirm', { projectionId: 'proj-a' }]);
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
    expect(host.innerHTML).not.toContain('Remove from this task');
    expect(host.innerHTML).not.toContain('Add asset to this task');
  });

  it('conversation renderer mounts Recall projection cards carried by assistant messages', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/conversation.js'), 'utf8');
    expect(source).toContain('message.recall_projection_card');
    expect(source).toContain('window.mountRecallProjectionCard');
  });

});
