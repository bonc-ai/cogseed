/**
 * 引用回执卡（2026-09-25 验收修复 US-601 AC3）：用户 @ 钉住的资产必须有回执，
 * 且回执可撤销。修复前这张卡被 `onlyModelSelected` 挡掉（只放行模型自选），
 * 于是"我引用过什么、怎么撤"在界面上无处可见。
 *
 * 边界同时守住：其它授权（如用户确认的语义投影 conversation_reply）仍不挂卡，
 * 模型自选的既有行为（文案 / 撤销口）不变。
 */
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
    window: {
      cogseed: { invoke },
      uiButton: ({ label, attrs }: { label: string; attrs?: Record<string, string> }) => {
        const extra = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${String(value)}"`).join('');
        return `<button type="button" class="btn ui-button"${extra}><span class="ui-button__label">${String(label)}</span></button>`;
      },
    },
    document: {},
    escapeHtml: (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (_key: string, varsOrFallback?: unknown) => (typeof varsOrFallback === 'string' ? varsOrFallback : _key),
    uiAlert: vi.fn(),
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'recall-projection-card.js' });
  return { context, host };
}

const pinnedCard = {
  kind: 'recall_projection_card',
  projectionId: 'proj-pin',
  status: 'confirmed',
  authorization: 'user_confirmed',
  purpose: 'user_pinned',
  totalAssetCount: 1,
  assetSummaries: [{ assetId: 'as-1', title: '配色规范', type: 'rule', status: 'active', scope: 'review', version: '3', confirmedVersion: '3' }],
};

const modelCard = {
  kind: 'recall_projection_card',
  projectionId: 'proj-model',
  status: 'confirmed',
  authorization: 'model_selected',
  purpose: 'model_selected',
  totalAssetCount: 1,
  assetSummaries: [{ assetId: 'as-2', title: '模型挑的规则', type: 'rule', status: 'active', scope: 'review', version: '1', confirmedVersion: '1' }],
};

const semanticCard = {
  ...pinnedCard,
  projectionId: 'proj-sem',
  purpose: 'conversation_reply',
  assetSummaries: [{ assetId: 'as-3', title: '语义投影的资产', type: 'rule', status: 'active', scope: 'review', version: '1', confirmedVersion: '1' }],
};

function fakeClickEvent(attr: string) {
  const button: any = { disabled: false };
  return { target: { closest: (selector: string) => (selector === attr ? button : null) } };
}

describe('用户 @ 钉住的引用回执卡', () => {
  it('在 onlyModelSelected 场景下也渲染（引用回执不再被吞）', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: pinnedCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-pin' }, { cid: 'c1', onlyModelSelected: true });

    expect(host.innerHTML).toContain('配色规范');
    expect(host.innerHTML).toContain('You referenced');
    expect(host.innerHTML).toContain('data-recall-projection-revoke="1"');
    expect(host.dataset.projectionId).toBe('proj-pin');
  });

  it('撤销走 revokePinned 通道（挂载级撤销，不动模型自选线）', async () => {
    const calls: Array<[string, unknown]> = [];
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') return { ok: true, card: pinnedCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });
    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-pin' }, { cid: 'c1', onlyModelSelected: true });

    await host.handler(fakeClickEvent('[data-recall-projection-revoke]'));

    const revoke = calls.find(([channel]) => channel.startsWith('recall.projections.revoke'));
    expect(revoke?.[0]).toBe('recall.projections.revokePinned');
    expect(revoke?.[1]).toMatchObject({ projectionId: 'proj-pin' });
    expect(calls.some(([channel]) => channel === 'recall.projections.revoke')).toBe(false);
  });

  it('模型自选的卡与撤销口保持原样（不回归）', async () => {
    const calls: Array<[string, unknown]> = [];
    const { context, host } = loadModule(async (channel, payload) => {
      calls.push([channel, payload]);
      if (channel === 'recall.projections.card') return { ok: true, card: modelCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });
    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-model' }, { cid: 'c1', onlyModelSelected: true });

    expect(host.innerHTML).toContain('Model-picked');
    expect(host.innerHTML).toContain('模型挑的规则');

    await host.handler(fakeClickEvent('[data-recall-projection-revoke]'));

    expect(calls.some(([channel]) => channel === 'recall.projections.revoke')).toBe(true);
    expect(calls.some(([channel]) => channel === 'recall.projections.revokePinned')).toBe(false);
  });

  it('撤销后的卡如实说明已生效范围（已发出的收不回来）', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: { ...pinnedCard, status: 'revoked' } };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      if (channel === 'recall.injections.omissions') return { ok: true, omissions: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-pin' }, { cid: 'c1', onlyModelSelected: true });

    // AC8：撤销不是"当作没发生过"——已发出那一轮收不回来，后续回合不再带上。
    expect(host.innerHTML).toContain('cannot be recalled');
    expect(host.innerHTML).toContain('later turns will not carry it');
    // 已撤销不再给撤销按钮（幂等语义由主进程保证，界面不重复提供入口）。
    expect(host.innerHTML).not.toContain('data-recall-projection-revoke');
  });

  it('其它授权的投影仍不挂卡（边界不放宽）', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: semanticCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-sem' }, { cid: 'c1', onlyModelSelected: true });

    expect(host.innerHTML).toBe('');
    expect(host.dataset.projectionId).toBeUndefined();
  });

  it('被拦的引用在卡上说明「本轮未带入 + 哪条规则」；没有留痕时不渲染该行', async () => {
    const { context, host } = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: pinnedCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      if (channel === 'recall.injections.omissions') {
        return {
          ok: true,
          omissions: [{ assetId: 'as-1', title: '配色规范', reason: 'paused', taskRunId: 'turn-1', createdAt: '2026-09-25T00:00:00.000Z' }],
        };
      }
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-pin' }, { cid: 'c1', onlyModelSelected: true });

    expect(host.innerHTML).toContain('Not carried this turn');
    expect(host.innerHTML).toContain('配色规范');
    expect(host.innerHTML).toContain('Paused by you');
    // 可见文案里只给标题与规则名——内部 id 不上屏（资产行自己的 data 属性不算文案）。
    expect(host.innerHTML.replace(/<[^>]+>/g, ' ')).not.toContain('as-1');

    const clean = loadModule(async (channel) => {
      if (channel === 'recall.projections.card') return { ok: true, card: pinnedCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      if (channel === 'recall.injections.omissions') return { ok: true, omissions: [] };
      return { ok: true };
    });
    await clean.context.window.mountRecallProjectionCard(clean.host, { projectionId: 'proj-pin' }, { cid: 'c1', onlyModelSelected: true });
    expect(clean.host.innerHTML).not.toContain('Not carried this turn');
  });

  it('模型自选的卡不查用户引用留痕（不多余请求、不串台）', async () => {
    const calls: string[] = [];
    const { context, host } = loadModule(async (channel) => {
      calls.push(channel);
      if (channel === 'recall.projections.card') return { ok: true, card: modelCard };
      if (channel === 'recall.projections.availableAssets') return { ok: true, assets: [] };
      return { ok: true };
    });

    await context.window.mountRecallProjectionCard(host, { projectionId: 'proj-model' }, { cid: 'c1', onlyModelSelected: true });

    expect(calls).not.toContain('recall.injections.omissions');
  });
});
