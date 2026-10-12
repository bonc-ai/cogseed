import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(__dirname, '../..');
const conversationSource = fs.readFileSync(path.join(ROOT, 'src/renderer/modules/conversation.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');

function loadModule(invoke: (channel: string, payload?: unknown) => Promise<unknown>, windowExtras: Record<string, unknown> = {}) {
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
    window: {
      cogseed: { invoke },
      // 新控件走共享按钮原语（shared-ui-adoption-guard 的规矩）。这里只 stub
      // 出本用例需要的最小行为：带 label 与 data-* 的按钮。
      uiButton: ({ label, attrs }: { label: string; attrs?: Record<string, string> }) => {
        const extra = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${String(value)}"`).join('');
        return `<button type="button" class="btn ui-button"${extra}><span class="ui-button__label">${String(label)}</span></button>`;
      },
      ...windowExtras,
    },
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
    // 未确认的投影草稿里只编辑本轮内容，不提供通往正式资产管理页的动作。
    expect(host.innerHTML).not.toContain('data-asset-citation');
    expect(host.innerHTML).toContain('Remove asset');
    expect(host.innerHTML).toContain('Preloaded assets');
    expect(host.innerHTML).toContain('Add asset');
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

    expect(host.innerHTML).toContain('No preloaded assets selected.');
    expect(host.innerHTML).toContain('Add asset');
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

    expect(host.innerHTML).toContain('Confirm assets');
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
    expect(host.innerHTML).not.toContain('Remove asset');
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

  it('uses localized asset counts instead of the backend English summary text', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: previewCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a' });

    expect(host.innerHTML).not.toContain('Found 1 asset');
    expect(host.innerHTML).toContain('1 preloaded assets.');
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

const staleCard = {
  kind: 'recall_projection_card',
  projectionId: 'proj-stale',
  status: 'confirmed',
  purpose: 'review',
  draftState: 'terminal',
  summary: { includedCount: 1, omittedCount: 0, sourceRefCount: 1, text: 'Found 1 asset' },
  staleAssetIds: ['asset-drift'],
  assetSummaries: [{
    assetId: 'asset-drift', title: 'Drifted asset', type: 'rule', status: 'active',
    maturity: 'leaf', scope: 'review', version: '2', confirmedVersion: '1', stale: true,
  }],
  availableActions: [],
};

describe('projection card surfaces a drifted confirmed version', () => {
  it('shows the confirmed version and says the newer one needs re-selection', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: staleCard };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-stale' }, { cid: 'cid-stale' });

    // 运行中用的是确认版本，所以显示 v1 而不是 live 的 v2。
    expect(host.innerHTML).toContain('v1');
    expect(host.innerHTML).toContain('Still running the confirmed v1');
    expect(host.innerHTML).toContain('the asset is now v2');
    expect(host.innerHTML).toContain('is-stale');
    // 只告知，不提供"就地升级"——已确认投影不可再改。
    expect(host.innerHTML).not.toContain('data-recall-projection-confirm');
  });

  it('says nothing about drift when the confirmed version is current', async () => {
    const fresh = {
      ...staleCard,
      projectionId: 'proj-fresh',
      staleAssetIds: [],
      assetSummaries: [{ ...staleCard.assetSummaries[0], version: '1', confirmedVersion: '1', stale: undefined }],
    };
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: fresh };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-fresh' }, { cid: 'cid-fresh' });

    expect(host.innerHTML).not.toContain('Still running the confirmed');
    expect(host.innerHTML).not.toContain('is-stale');
  });

  it('模型自选（2026-09-18）：标"模型自选"并给撤销；撤销走 recall.projections.revoke 并刷新为已撤销', async () => {
    const calls: Array<[string, unknown]> = [];
    let revoked = false;
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') {
        return {
          ok: true,
          card: {
            ...previewCard,
            status: revoked ? 'revoked' : 'confirmed',
            authorization: 'model_selected',
            purpose: 'model_selected',
          },
        };
      }
      if (channel === 'recall.projections.revoke') {
        revoked = true;
        return { ok: true, projection: { projectionId: 'proj-a', status: 'revoked' } };
      }
      return { ok: true, assets: [] };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });
    // 合并卡（拍板项 #8）：头部是投影状态摘要（带入 N 条），徽标区分谁做的决定。
    expect(host.innerHTML).toContain('带入 1 条');
    expect(host.innerHTML).toContain('Model-picked');
    expect(host.innerHTML).toContain('Revoke');
    // confirmed 态不发确认按钮（它已经生效了，只给撤销）。
    expect(host.innerHTML).not.toContain('Confirm assets');

    const revokeButton = { disabled: false };
    await host.handler({
      target: {
        closest: (selector: string) => (String(selector).includes('revoke') ? revokeButton : null),
      },
    });
    expect(calls.some(([channel]) => channel === 'recall.projections.revoke')).toBe(true);
    expect(host.innerHTML).toContain('Revoked: later turns no longer carry these assets.');
    expect(host.innerHTML).not.toContain('data-recall-projection-revoke');
  });

  it('模型自选卡片区分模型新挂数量、投影总数、模型点名与语义基线', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') {
        return {
          ok: true,
          card: {
            ...previewCard,
            status: 'confirmed',
            authorization: 'model_selected',
            purpose: 'model_selected',
            modelSelectedAssetIds: ['asset-model'],
            modelSelectedCount: 1,
            totalAssetCount: 2,
            assetSummaries: [
              { assetId: 'asset-model', title: 'Model rule', type: 'rule', status: 'active', scope: 'review', version: '1' },
              { assetId: 'asset-base', title: 'Semantic base', type: 'rule', status: 'active', scope: 'review', version: '1' },
            ],
          },
        };
      }
      return { ok: true, assets: [] };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });

    // 合并卡：模型新挂数量并进头部摘要（带入总数 · 其中模型挑 N 条），资产行
    // 平铺一张列表（不再分「模型自选/语义基线」两个明细小节）。
    expect(host.innerHTML).toContain('带入 2 条 · 其中模型挑 1 条');
    expect(host.innerHTML).toContain('Model rule');
    expect(host.innerHTML).toContain('Semantic base');
    expect(host.innerHTML.match(/data-recall-projection-asset=/g)).toHaveLength(2);
  });

  it('旧模型自选投影没有点名历史时显示中性总数，不编造模型新挂数量', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') {
        return {
          ok: true,
          card: {
            ...previewCard,
            status: 'confirmed',
            authorization: 'model_selected',
            purpose: 'model_selected',
            totalAssetCount: 2,
            assetSummaries: [
              { assetId: 'asset-old-a', title: 'Old A', type: 'rule', status: 'active', scope: 'review', version: '1' },
              { assetId: 'asset-old-b', title: 'Old B', type: 'rule', status: 'active', scope: 'review', version: '1' },
            ],
          },
        };
      }
      return { ok: true, assets: [] };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });

    // 没有点名历史时不编造模型新挂数量（摘要只报带入总数）。
    expect(host.innerHTML).toContain('带入 2 条');
    expect(host.innerHTML).not.toContain('其中模型挑');
    expect(host.innerHTML).toContain('Old A');
  });

  it('模型自选默认渲染低干扰回执：明细渐进展开，撤销留在摘要层', async () => {
    const assets = Array.from({ length: 8 }, (_, index) => ({
      assetId: `asset-${index + 1}`,
      title: `Asset ${index + 1}`,
      type: 'rule',
      status: 'active',
      maturity: 'leaf',
      scope: 'review',
      version: '1',
    }));
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') {
        return {
          ok: true,
          card: {
            ...previewCard,
            status: 'confirmed',
            authorization: 'model_selected',
            purpose: 'model_selected',
            assetSummaries: assets,
          },
        };
      }
      return { ok: true, assets: [] };
    });

    const prose = { hidden: false };
    host.closest = vi.fn(() => ({ querySelector: (selector: string) => selector === '.markdown-body' ? prose : null }));
    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });

    // 合并卡（拍板项 #8）：列表平铺全部带入行（旧「明细渐进展开」折叠随两卡
    // 合并退役——设计 7.4 列表＝每条资产一行），撤销留在尾部操作行。
    expect(prose.hidden).toBe(false);
    expect(host.className).toContain('chat-recall-citations');
    expect(host.innerHTML).toContain('本次使用的记忆');
    expect(host.innerHTML).toContain('带入 8 条');
    expect(host.innerHTML).toContain('Revoke');
    expect(host.innerHTML).not.toContain('<details class="chat-recall-projection-details"');
    expect(host.innerHTML.match(/data-recall-projection-asset=/g)).toHaveLength(8);
    // 反馈行与投影操作同在尾部（一条「带入 → 使用 → 反馈」线）。
    expect(host.innerHTML).toContain('data-recall-feedback');
  });

  it('旧传输 sidecar 才隐藏 fallback 正文；最终回复挂卡不隐藏正文', async () => {
    const load = async (transportSidecar: boolean) => {
      const { context, host } = loadModule(async (channel) => {
        if (channel === 'recall.projections.card') {
          return {
            ok: true,
            card: {
              ...previewCard,
              status: 'confirmed',
              authorization: 'model_selected',
              purpose: 'model_selected',
            },
          };
        }
        return { ok: true, assets: [] };
      });
      const prose = { hidden: false };
      host.closest = vi.fn(() => ({ querySelector: (selector: string) => selector === '.markdown-body' ? prose : null }));
      if (transportSidecar) host.dataset.recallProjectionTransport = 'sidecar';
      await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });
      return prose;
    };

    expect((await load(false)).hidden).toBe(false);
    expect((await load(true)).hidden).toBe(true);
  });

  it('模型自选回执撤销后保持紧凑并保留可审计明细', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') {
        return {
          ok: true,
          card: {
            ...previewCard,
            status: 'revoked',
            authorization: 'model_selected',
            purpose: 'model_selected',
          },
        };
      }
      return { ok: true, assets: [] };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });

    // 撤销后：状态与说明如实呈现（已发出那轮收不回来），不再给撤销按钮；
    // 资产行保留（可审计明细）。
    expect(host.className).toContain('is-projection-revoked');
    expect(host.innerHTML).toContain('Revoked: later turns no longer carry these assets.');
    expect(host.innerHTML).not.toContain('data-recall-projection-revoke');
    expect(host.innerHTML).toContain('data-recall-projection-asset=');
  });

  it('projection sidecar 消息隐藏传输 fallback 文本，不让治理回执伪装成模型正文', () => {
    expect(conversationSource).toContain("message?.recall_projection_card?.projectionId\n      && message.recall_projection_card.authorization === 'model_selected'\n      && !coalescedProjectionCard,");
    expect(conversationSource).toContain("suppressProjectionTransportProse\n    ? ''\n    : isHtmlSnippet");
  });

  it('revoked projection status has localized keys in all supported languages', () => {
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      const locale = JSON.parse(fs.readFileSync(path.join(ROOT, `src/renderer/locales/${lang}.json`), 'utf8'));
      expect(locale['recall.projection.status.revoked']).toBeTruthy();
    }
  });

  it('投影卡片有顶层样式，而不只有结果块内的嵌套重置', () => {
    // 6dff92a5 起家族壳/头部收口为分组选择器（`.chat-recall-projection-card,
    // .chat-recall-citations {`），顶层规则有两种形态：「S,」（分组）或
    // 「S {」（独立）——与 recall-receipt-family.test.ts 的 cssBlock 同语义。
    // 嵌套重置（.chat-result-block-body …）与修饰规则（S.is-error）不在行首
    // 以裸类名出现，仍不匹配，判别力不变。
    expect(styleSource).toMatch(/^\.chat-recall-projection-card(,| \{)/m);
    expect(styleSource).toMatch(/^\.chat-recall-projection-details(,| \{)/m);
    expect(styleSource).toMatch(/^\.chat-recall-projection-head(,| \{)/m);
    expect(fs.readFileSync(path.join(ROOT, 'src/renderer/modules/recall-projection-card.js'), 'utf8')).toContain("recall.projection.status.revoked");
  });

  it('onlyModelSelected：非模型自选的投影不挂卡（保留 2026-08-17 的"不挂预载卡"决策）', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') {
        return { ok: true, card: { ...previewCard, status: 'confirmed', authorization: 'user_confirmed' } };
      }
      return { ok: true, assets: [] };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });
    expect(host.innerHTML).toBe('');
    expect(host.className).toBe('');
    expect(host.dataset.projectionId).toBeUndefined();
  });

  it('撤销失败（可用性）：后端拒绝时给出可见提示，卡片状态不变', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') {
        return { ok: true, card: { ...previewCard, status: 'confirmed', authorization: 'model_selected', purpose: 'model_selected' } };
      }
      if (channel === 'recall.projections.revoke') return { ok: false, error: 'projection revoke failed upstream' };
      return { ok: true, assets: [] };
    });
    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-a' }, { cid: 'cid-a', onlyModelSelected: true });
    expect(host.innerHTML).toContain('Revoke');

    await host.handler({ target: { closest: (selector: string) => (String(selector).includes('revoke') ? { disabled: false } : null) } });
    // 失败要走可见提示（不静默），且卡片仍是 confirmed（没有假装成功）。
    expect(context.uiAlert).toHaveBeenCalled();
    expect(String(context.uiAlert.mock.calls[0][0])).toContain('revoke failed');
    expect(host.innerHTML).toContain('Revoke');
  });
});

describe('「本次使用的记忆」卡折叠热区与默认收起（2026-09-29 二轮）', () => {
  const confirmedModelCard = {
    kind: 'recall_projection_card',
    projectionId: 'proj-fold',
    status: 'confirmed',
    authorization: 'model_selected',
    purpose: 'model_selected',
    totalAssetCount: 1,
    assetSummaries: [{ assetId: 'asset-fold', title: '折叠测试资产', type: 'rule', status: 'active', scope: 'review', version: '1' }],
  };

  function loadWithIcons(invoke: (channel: string, payload?: unknown) => Promise<unknown>) {
    return loadModule(invoke, {
      uiIconHtml: (name: string, className: string) => `<svg class="${className} is-${name}" aria-hidden="true"></svg>`,
    });
  }

  it('默认收起：头部即热区（role=button + aria-expanded=false），计数内联标题右侧，提示句在尾行撤销左侧；箭头只是指示图标', async () => {
    const loaded = loadWithIcons(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: confirmedModelCard };
      return { ok: true };
    });
    await loaded.context.window.mountRecallProjectionCard(loaded.host, { projectionId: 'proj-fold' }, { cid: 'c1', onlyModelSelected: true });
    expect(loaded.host.className).toContain('is-collapsed');
    expect(loaded.host.innerHTML).toContain('role="button" tabindex="0" aria-expanded="false"');
    // 计数上移：标题右侧内联（不再是标题下的块级 small）。
    expect(loaded.host.innerHTML).toContain('chat-recall-citations-count');
    expect(loaded.host.innerHTML).toContain('带入 1 条');
    expect(loaded.host.innerHTML).not.toContain('data-recall-projection-summary');
    // 提示句挪到尾行、撤销左侧。
    expect(loaded.host.innerHTML).toContain('chat-recall-citations-note');
    expect(loaded.host.innerHTML.indexOf('chat-recall-citations-note'))
      .toBeLessThan(loaded.host.innerHTML.indexOf('data-recall-projection-revoke'));
    expect(loaded.host.innerHTML).not.toContain('data-recall-projection-note');
    // 箭头是指示图标不是按钮。
    expect(loaded.host.innerHTML).toContain('chat-recall-toggle');
    expect(loaded.host.innerHTML).not.toContain('data-recall-toggle');

    // 图标原语缺席：箭头整颗降级，卡照常（默认收起态不变）。
    const plain = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: confirmedModelCard };
      return { ok: true };
    });
    await plain.context.window.mountRecallProjectionCard(plain.host, { projectionId: 'proj-fold' }, { cid: 'c1', onlyModelSelected: true });
    expect(plain.host.innerHTML).not.toContain('chat-recall-toggle');
    expect(plain.host.innerHTML).toContain('本次使用的记忆');
    expect(plain.host.innerHTML).toContain('data-recall-projection-revoke');
  });

  it('翻转：默认收起→首次点击=展开；整卡重画（撤销成功刷新）后状态保持', async () => {
    const loaded = loadWithIcons(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: confirmedModelCard };
      return { ok: true };
    });
    await loaded.context.window.mountRecallProjectionCard(loaded.host, { projectionId: 'proj-fold' }, { cid: 'c1', onlyModelSelected: true });
    expect(loaded.host.dataset.recallCollapsed).toBeUndefined();

    // 首次翻转 = 展开（默认收起）。
    expect(loaded.context.window.recallCardToggleCollapsed(loaded.host)).toBe(false);
    expect(loaded.host.className).not.toContain('is-collapsed');
    expect(loaded.host.dataset.recallCollapsed).toBe('0');

    // 撤销成功走 refresh 整卡重画：展开态从 dataset 回读，不弹回收起。
    await loaded.host.handler({ target: { closest: (selector: string) => (String(selector).includes('revoke') ? { disabled: false } : null) } });
    expect(loaded.host.className).not.toContain('is-collapsed');
    expect(loaded.host.innerHTML).toContain('aria-expanded="true"');

    expect(loaded.context.window.recallCardToggleCollapsed(loaded.host)).toBe(true);
    expect(loaded.host.className).toContain('is-collapsed');
    expect(loaded.host.dataset.recallCollapsed).toBe('1');
    // 返回值 = 翻转后的折叠态（vm 宿主 querySelector 是空桩，aria 属性的
    // 即时同步只在真实 DOM 生效；重画路径的 aria 已在上面断过）。
    expect(loaded.context.window.recallCardToggleCollapsed(loaded.host)).toBe(false);
  });
});
