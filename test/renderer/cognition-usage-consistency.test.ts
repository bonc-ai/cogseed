/**
 * US-602（2026-09-25 验收修复）渲染层：
 *  ① 列表「最近使用」与详情使用记录同口径——只算「真实使用」（白名单来自主进程），
 *     创建 / 版本 / 治理 / 撤销都不抬高最近使用；白名单缺失时 fail-closed；
 *  ② 「实际采用记录」只认有据回执：applied 才算采用，contradicted 单列，其余如实
 *     标「证据不足 · 未知」；宿主注入过的 usage_recorded 一律归「被带入任务」。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderCognition } from './helpers/cognition-renderer';

/* 计量词表（2026-09-28 词表统一：被任务用过 / 其中模型确认采用 / 最近一次）
 * 的词条文本随 locale 同步更新——断言按 zh.json 派生，代码只钉「用了哪个
 * 键 + 数字」，词条改文前后都成立。 */
const zh = JSON.parse(readFileSync(resolve(__dirname, '../../src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
const zhPhrase = (key: string, vars: Record<string, string> = {}) => {
  let text = zh[key] ?? key;
  for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, value);
  return text;
};
const LAST_USED_PREFIX = (zh['cognition.asset_last_used_at'] ?? '').split('{when}')[0];

const ASSET = {
  id: 'aa-use',
  title: '性能归因规则',
  type: 'rule',
  status: 'active',
  scope: 'general',
  statement: '性能类提问需用真实日志做分层归因。',
  version: '3',
  activeVersion: '3',
  updatedAt: '2026-09-18T00:00:00.000Z',
};

function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const detail = (state: Record<string, unknown>) => renderCognition(
  { name: 'overview', assetId: ASSET.id },
  { assets: [ASSET], ...state },
);

const list = (state: Record<string, unknown>) => renderCognition(
  { name: 'overview' },
  { assets: [ASSET], ...state },
);

describe('asset availability switch wording', () => {
  it('explains that enabled assets are offered through a catalog and read on demand', () => {
    const rendered = detail({});
    const html = visibleText(rendered);

    expect(rendered).toContain('aria-label="允许后续任务使用"');
    expect(html).toContain('符合当前任务、范围和来源规则时');
    expect(html).toContain('展示简短目录');
    expect(html).toContain('按需读取正文');
    expect(html).not.toContain('自动带入新任务');
  });

  it('explains that pausing removes an asset from future catalogs and reads', () => {
    const html = visibleText(detail({ assets: [{ ...ASSET, status: 'paused' }] }));

    expect(html).toContain('已暂停');
    expect(html).toContain('不会出现在后续任务的目录中');
    expect(html).toContain('也不能被读取');
    expect(html).toContain('历史和使用记录仍保留');
    expect(html).not.toContain('自动带入这条资产');
  });
});

describe('asset correction entry', () => {
  it('offers direct editing for active and paused assets above the collapsed history', () => {
    const renderedDetails = [
      detail({}),
      detail({ assets: [{ ...ASSET, status: 'paused' }] }),
    ];

    for (const rendered of renderedDetails) {
      const editActionIndex = rendered.indexOf('data-act="edit-asset"');
      const historyIndex = rendered.indexOf('class="details fold ca-detail-history"');

      expect(editActionIndex).toBeGreaterThanOrEqual(0);
      expect(visibleText(rendered)).toContain('修改内容');
      expect(historyIndex).toBeGreaterThan(editActionIndex);
      expect(rendered.slice(historyIndex, rendered.indexOf('>', historyIndex))).not.toContain('open');
    }
  });

  it('keeps the edit form save and cancel controls without a duplicate header action', () => {
    const rendered = renderCognition(
      { name: 'overview', assetId: ASSET.id, assetEdit: '1' },
      { assets: [ASSET] },
    );
    const html = visibleText(rendered);

    expect(rendered).not.toContain('data-act="edit-asset"');
    expect(rendered).toContain('data-act="asset-edit-save"');
    expect(rendered).toContain('data-act="asset-edit-cancel"');
    expect(html).toContain('保存为新版本');
  });
});

describe('cognition tree reuse count wording', () => {
  it('counts verified assets, not use events, and names that unit', () => {
    const html = visibleText(renderCognition({ name: 'tree' }, {
      assets: [
        { ...ASSET, id: 'aa-transfer', maturity: 'transfer_validated', status: 'active' },
        { ...ASSET, id: 'aa-effective', maturity: 'effectiveness_validated', status: 'active' },
        { ...ASSET, id: 'aa-unverified', maturity: 'bud', status: 'active' },
        { ...ASSET, id: 'aa-paused', maturity: 'effectiveness_validated', status: 'paused' },
      ],
    }));

    expect(html).toContain('有真实使用验证的资产 2 条');
    expect(html).toContain('至少有一次真实任务使用记录的资产数');
    expect(html).not.toContain('被真用过 2');
  });
});

describe('列表与详情同口径（US-602 AC1/AC2/AC4）', () => {
  it('新建或只改过版本：两处都显示"最近无使用记录"，版本事件不进使用记录', () => {
    const proofs = [
      { id: 'p-1', kind: 'asset_created', occurredAt: '2026-09-18T01:00:00.000Z', refs: { assetId: ASSET.id } },
      { id: 'p-2', kind: 'asset_version', occurredAt: '2026-09-18T02:00:00.000Z', refs: { assetId: ASSET.id, version: '3' } },
      { id: 'p-3', kind: 'asset_version_selected', occurredAt: '2026-09-18T03:00:00.000Z', refs: { assetId: ASSET.id, version: '2' } },
    ];

    expect(visibleText(list({ proofs }))).toContain(zhPhrase('cognition.asset_last_use'));
    const detailHtml = visibleText(detail({ proofs }));
    expect(detailHtml).toContain('还没有被真实使用过');
    expect(detailHtml).not.toContain(zhPhrase('cognition.proof_projected_times', { n: '1' }));
  });

  it('被带入后：列表显示最近使用，详情同一条事件可定位会话', () => {
    const proofs = [
      {
        id: 'p-1', kind: 'projection_confirmed', occurredAt: '2026-09-18T05:00:00.000Z',
        refs: { assetId: ASSET.id, projectionId: 'proj-1', conversationId: 'conv-a' },
      },
    ];
    const state = {
      proofs,
      sources: [{ kind: 'conversation', items: [{ id: 'conv-a', kind: 'conversation', title: '季度复盘', status: 'ready' }] }],
    };

    expect(visibleText(list(state))).toContain(LAST_USED_PREFIX);
    const detailHtml = visibleText(detail(state));
    expect(detailHtml).toContain(zhPhrase('cognition.proof_projected_times', { n: '1' }));
    expect(detailHtml).toContain('对话《季度复盘》里');
  });

  it('撤销事件进时间线但不计数；重复撤销不产生第二条', () => {
    const proofs = [
      {
        id: 'p-1', kind: 'projection_confirmed', occurredAt: '2026-09-18T05:00:00.000Z',
        refs: { assetId: ASSET.id, projectionId: 'proj-1', conversationId: 'conv-a' },
      },
      {
        id: 'p-2', kind: 'projection_revoked', occurredAt: '2026-09-18T06:00:00.000Z',
        refs: { assetId: ASSET.id, projectionId: 'proj-1', conversationId: 'conv-a' },
      },
    ];

    const detailHtml = visibleText(detail({ proofs }));
    expect(detailHtml).toContain('撤销');
    // 撤销不是使用：不抬高最近使用，也不进任何计数。
    expect(visibleText(list({ proofs }))).toContain(LAST_USED_PREFIX);
    expect(detailHtml).toContain(zhPhrase('cognition.proof_projected_times', { n: '1' }));
    expect(detailHtml).not.toContain(zhPhrase('cognition.proof_projected_times', { n: '2' }));
  });

  it('白名单缺失时 fail-closed（按空集处理，绝不回落成"不过滤"）', () => {
    const proofs = [
      { id: 'p-1', kind: 'asset_version', occurredAt: '2026-09-18T02:00:00.000Z', refs: { assetId: ASSET.id, version: '3' } },
    ];

    expect(visibleText(list({ proofs, realUsageKinds: [] }))).toContain(zhPhrase('cognition.asset_last_use'));
    expect(visibleText(detail({ proofs, realUsageKinds: [] }))).toContain('还没有被真实使用过');
  });

  it('资产详情提示仍固定在旧版的长期挂载，并可回到来源对话', () => {
    const html = detail({
      assetTimeline: {
        assetId: ASSET.id,
        loading: false,
        failed: false,
        items: [
          {
            id: 'pin-old', kind: 'projection_confirmed', occurredAt: '2026-09-20T05:00:00.000Z',
            refs: {
              assetId: ASSET.id, projectionId: 'proj-old', version: '2', conversationId: 'conv-a',
              authorization: 'user_confirmed', purpose: 'user_pinned',
            },
          },
          {
            id: 'pin-expired', kind: 'projection_confirmed', occurredAt: '2026-09-21T05:00:00.000Z',
            refs: {
              assetId: ASSET.id, projectionId: 'proj-expired', version: '1', conversationId: 'conv-b',
              authorization: 'user_confirmed', purpose: 'user_pinned', expiresAt: '2026-01-01T00:00:00.000Z',
            },
          },
          {
            id: 'pin-revoked', kind: 'projection_revoked', occurredAt: '2026-09-22T05:00:00.000Z',
            refs: { assetId: ASSET.id, projectionId: 'proj-revoked', version: '1', authorization: 'user_confirmed', purpose: 'user_pinned' },
          },
          {
            id: 'ordinary-confirmation', kind: 'projection_confirmed', occurredAt: '2026-09-23T05:00:00.000Z',
            refs: { assetId: ASSET.id, projectionId: 'proj-task', version: '1', authorization: 'user_confirmed', purpose: 'conversation_reply' },
          },
        ],
      },
      sources: [{ kind: 'conversation', items: [{ id: 'conv-a', kind: 'conversation', title: '季度复盘', status: 'ready' }] }],
    });

    expect(visibleText(html)).toContain('有 1 处长期引用仍固定使用旧版');
    expect(visibleText(html)).toContain('固定 v2 · 当前 v3');
    expect(visibleText(html)).toContain('季度复盘');
    expect(html).toContain('data-act="open-conversation" data-id="conv-a"');
    expect(visibleText(html)).not.toContain('proj-old');
  });

  it('资产完整事实链读取失败时明确显示未能核对，而不是显示没有旧版挂载', () => {
    const html = detail({
      assetTimeline: { assetId: ASSET.id, loading: false, failed: true, items: [] },
    });
    expect(visibleText(html)).toContain('暂时无法核对这条资产在对话中的引用版本');
    expect(html).toContain('data-act="asset-timeline-retry"');
  });
});

describe('实际采用记录（US-602 AC5/AC6）', () => {
  const appliedReceipt = {
    id: 'aur-1', assetVersion: '3', taskRunId: 'turn-1', status: 'applied',
    evidenceKind: 'artifact',
    evidence: [{ kind: 'artifact_file', id: 'art-1', title: '归因报告.html' }],
    boundary: 'real', createdAt: '2026-09-18T07:00:00.000Z',
  };

  it('applied 回执显示为已实际采用，带版本、时间与证据来源名', () => {
    const html = visibleText(detail({ adoptionReceipts: { assetId: ASSET.id, items: [appliedReceipt] } }));

    expect(html).toContain('实际采用记录');
    expect(html).toContain('已实际采用');
    expect(html).toContain('v3');
    expect(html).toContain('产物');
    expect(html).toContain('归因报告.html');
    expect(html).toContain(zhPhrase('cognition.asset_usage_applied', { n: '1' }));
    // 证据里的内部 id 不上屏。
    expect(html).not.toContain('art-1');
  });

  it('usage_unknown 如实标「证据不足 · 未知」且不计入实际采用', () => {
    const html = visibleText(detail({
      adoptionReceipts: {
        assetId: ASSET.id,
        items: [{ ...appliedReceipt, id: 'aur-2', status: 'usage_unknown', evidenceKind: 'none', evidence: [] }],
      },
    }));

    expect(html).toContain('证据不足 · 未知');
    expect(html).toContain('证据不足 1 次');
    expect(html).not.toContain('已实际采用');
    expect(html).not.toContain(zhPhrase('cognition.asset_usage_applied', { n: '1' }));
  });

  it('contradicted 单列为被否定，不计入采用', () => {
    const html = visibleText(detail({
      adoptionReceipts: { assetId: ASSET.id, items: [{ ...appliedReceipt, id: 'aur-3', status: 'contradicted' }] },
    }));

    expect(html).toContain('被否定');
    expect(html).toContain('被否定 1 次');
    expect(html).not.toContain('已实际采用');
  });

  it('没有回执时说明还没有可核对的采用证据；宿主注入过也不算采用', () => {
    const proofs = [
      { id: 'p-1', kind: 'usage_recorded', occurredAt: '2026-09-18T05:00:00.000Z', refs: { assetId: ASSET.id, projectionId: 'proj-1', usageOutcome: 'injected' } },
    ];
    const html = visibleText(detail({ proofs, adoptionReceipts: { assetId: ASSET.id, items: [] } }));

    expect(html).toContain('还没有可核对的采用证据');
    expect(html).toContain('带进了上下文');
    expect(html).not.toContain('已实际采用');
    expect(html).not.toContain('被实际使用');
  });
});
