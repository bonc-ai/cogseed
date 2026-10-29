/**
 * 资产使用记录渲染层：
 *  ① 列表「最近使用」与详情使用记录同口径——只算「真实使用」（白名单来自主进程），
 *     创建 / 版本 / 治理 / 撤销都不抬高最近使用；白名单缺失时 fail-closed；
 *  ② 「实际采用记录」只认有据回执：applied 才算采用，contradicted 单列，其余如实
 *     标「证据不足 · 未知」；宿主注入过的 usage_recorded 一律归「被带入任务」。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadCognitionAssets, renderCognitionWithDialogs as renderCognition } from './helpers/cognition-renderer';

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

    expect(rendered).toContain('data-action="pause"');
    expect(html).toContain('是否使用仍取决于任务匹配、状态与来源权限');
    expect(rendered).not.toContain('data-act="asset-use-in-chat"');
    expect(html).not.toContain('自动带入新任务');
  });

  it('explains that pausing removes an asset from future catalogs and reads', () => {
    const html = visibleText(detail({ assets: [{ ...ASSET, status: 'paused' }] }));

    expect(html).toContain('暂停');
    expect(html).toContain('恢复使用');
    expect(detail({ assets: [{ ...ASSET, status: 'paused' }] })).toContain('data-action="resume"');
    expect(html).toContain('版本与比较');
    expect(html).toContain('使用与管理记录');
    expect(detail({ assets: [{ ...ASSET, status: 'paused' }] })).not.toContain('data-act="asset-use-in-chat"');
    expect(html).not.toContain('自动带入这条资产');
  });
});

describe('asset correction entry', () => {
  it('offers direct editing in the fixed footer and preserves collapsed source/version/usage sections', () => {
    const renderedDetails = [
      detail({}),
      detail({ assets: [{ ...ASSET, status: 'paused' }] }),
    ];

    for (const rendered of renderedDetails) {
      const editActionIndex = rendered.indexOf('data-act="edit-asset"');
      const footerIndex = rendered.indexOf('<footer class="ca-library-detail-footer ');
      const versionDisclosure = rendered.match(/data-act="library-show-versions"/)?.[0] || '';
      const recordsDisclosure = rendered.match(/data-act="library-show-records"/)?.[0] || '';

      expect(editActionIndex).toBeGreaterThanOrEqual(0);
      expect(visibleText(rendered)).toContain('修改');
      expect(footerIndex).toBeGreaterThanOrEqual(0);
      expect(editActionIndex).toBeGreaterThan(footerIndex);
      expect(versionDisclosure).not.toBe('');
      expect(recordsDisclosure).not.toBe('');
      expect(versionDisclosure).not.toMatch(/\sopen(?:[=\s>])/);
      expect(recordsDisclosure).not.toMatch(/\sopen(?:[=\s>])/);
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
    expect(html).toContain('保存新版本');
  });
});

describe('my cognition usage wording', () => {
  it('explains that inclusion in a task is not confirmed use or effect', () => {
    const html = visibleText(renderCognition({ name: 'overview' }, {
      assets: [
        { ...ASSET, id: 'aa-transfer', maturity: 'transfer_validated', status: 'active' },
        { ...ASSET, id: 'aa-effective', maturity: 'effectiveness_validated', status: 'active' },
        { ...ASSET, id: 'aa-unverified', maturity: 'bud', status: 'active' },
        { ...ASSET, id: 'aa-paused', maturity: 'effectiveness_validated', status: 'paused' },
      ],
    }));

    expect(html).not.toContain('启用不代表所有任务自动使用');
    expect(html).not.toContain('已实际采用');
    expect(html).not.toContain('有带入或读取记录 2 条');
    const unverified = visibleText(renderCognition(
      { name: 'overview', assetId: 'aa-unverified' },
      { assets: [
        { ...ASSET, id: 'aa-transfer', maturity: 'transfer_validated', status: 'active' },
        { ...ASSET, id: 'aa-effective', maturity: 'effectiveness_validated', status: 'active' },
        { ...ASSET, id: 'aa-unverified', maturity: 'bud', status: 'active' },
        { ...ASSET, id: 'aa-paused', maturity: 'effectiveness_validated', status: 'paused' },
      ] },
    ));
    expect(unverified).toContain('还没有可核对的采用证据');
  });
});

describe('列表与详情同口径', () => {
  it('新建或只改过版本：两处都显示"最近无使用记录"，版本事件不进使用记录', () => {
    const proofs = [
      { id: 'p-1', kind: 'asset_created', occurredAt: '2026-09-18T01:00:00.000Z', refs: { assetId: ASSET.id } },
      { id: 'p-2', kind: 'asset_version', occurredAt: '2026-09-18T02:00:00.000Z', refs: { assetId: ASSET.id, version: '3' } },
      { id: 'p-3', kind: 'asset_version_selected', occurredAt: '2026-09-18T03:00:00.000Z', refs: { assetId: ASSET.id, version: '2' } },
    ];

    expect(loadCognitionAssets({ assets: [ASSET], proofs }).ui.broughtInCountFor(ASSET.id)).toBe(0);
    expect(list({ proofs })).toContain('ca-library-table');
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

    const detailHtml = visibleText(detail(state));
    expect(detailHtml).toContain(LAST_USED_PREFIX);
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
    expect(detailHtml).toContain(LAST_USED_PREFIX);
    expect(detailHtml).toContain(zhPhrase('cognition.proof_projected_times', { n: '1' }));
    expect(detailHtml).not.toContain(zhPhrase('cognition.proof_projected_times', { n: '2' }));
  });

  it('白名单缺失时 fail-closed（按空集处理，绝不回落成"不过滤"）', () => {
    const proofs = [
      { id: 'p-1', kind: 'asset_version', occurredAt: '2026-09-18T02:00:00.000Z', refs: { assetId: ASSET.id, version: '3' } },
    ];

    expect(loadCognitionAssets({ assets: [ASSET], proofs, realUsageKinds: [] }).ui.broughtInCountFor(ASSET.id)).toBe(0);
    expect(list({ proofs, realUsageKinds: [] })).toContain('ca-library-table');
    expect(visibleText(detail({ proofs, realUsageKinds: [] }))).toContain('还没有被真实使用过');
  });

  it('资产详情不再提示旧版长期挂载，管理记录仍保留历史事实', () => {
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

    expect(visibleText(html)).not.toContain('长期引用');
    expect(visibleText(html)).not.toContain('固定 v2 · 当前 v3');
    expect(visibleText(html)).toContain('季度复盘');
    expect(html).not.toContain('ca-stale-pin-warning');
    expect(visibleText(html)).not.toContain('proj-old');
  });

  it('使用记录读取失败仍给重试，不恢复已退役的引用警告', () => {
    const html = detail({
      assetTimeline: { assetId: ASSET.id, loading: false, failed: true, items: [] },
    });
    expect(visibleText(html)).not.toContain('暂时无法核对这条资产在对话中的引用版本');
    expect(html).toContain('data-act="asset-timeline-retry"');
  });
});

describe('实际采用记录', () => {
  it.each([
    ['quote_not_found', '自报引文未匹配'], ['result_unavailable', '成果暂不可核查'], ['result_changed', '成果已变化'],
  ])('失败自报 %s 只显示人话枚举与采用未确认，不暴露引文或路径', (reportFailure, label) => {
    const html = detail({ adoptionReceipts: { assetId: ASSET.id, items: [{ id: 'failed-report', assetVersion: '3',
      status: 'usage_unknown', observationMethod: 'agent_reported', reportFailure, outputExcerpt: 'PRIVATE-QUOTE', outputPath: '/private/hidden/result.txt' }] } });
    expect(html).toContain(label);
    expect(html).toContain('采用未确认');
    expect(html).toContain('ui-tag');
    expect(html).not.toContain('PRIVATE-QUOTE');
    expect(html).not.toContain('/private/hidden');
  });
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

  it('模型辅助逐条观察显示共享标签和明确的效果证明边界，不渲染内部检查坐标', () => {
    const html = detail({ adoptionReceipts: { assetId: ASSET.id, items: [
      { ...appliedReceipt, observationMethod: 'model_assisted', outputHash: 'private-output-hash', checkID: 'private-check-id' },
      { ...appliedReceipt, id: 'legacy-observation', status: 'usage_unknown', observationMethod: 'agent_reported' },
    ] } });
    expect(html).toContain('模型辅助检查');
    expect(html).toContain('title="这是对本次回答遵守情况的观察，不是改善效果的证明。"');
    expect(html).toContain('aria-label="模型辅助检查 · 这是对本次回答遵守情况的观察，不是改善效果的证明。"');
    const tag = html.match(/<span[^>]*class="ui-tag[^>]*>模型辅助检查<\/span>/g) || [];
    expect(tag).toHaveLength(1);
    expect(html).not.toContain('private-output-hash');
    expect(html).not.toContain('private-check-id');
    expect(visibleText(html)).toContain('已实际采用');
    expect(visibleText(html)).toContain('证据不足 · 未知');
  });

  it('助手自述和没有方法标记的历史采用记录保持相同展示，不误标模型辅助', () => {
    const legacy = detail({ adoptionReceipts: { assetId: ASSET.id, items: [appliedReceipt] } });
    const reported = detail({ adoptionReceipts: { assetId: ASSET.id, items: [{ ...appliedReceipt, observationMethod: 'agent_reported' }] } });
    expect(reported).toBe(legacy);
    expect(reported).not.toContain('模型辅助检查');
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


describe('同一曝光事实计算时间与次数', () => {
  it('新目录按带入或读取次数排序，创建、反馈与同投影重复事件不能抬高排名', () => {
    const other = { ...ASSET, id: 'aa-other', title: '两次独立使用', updatedAt: '2026-09-01T00:00:00.000Z' };
    const proofs = [
      { id: 'confirm', kind: 'projection_confirmed', occurredAt: '2026-09-18T05:00:00.000Z', refs: { assetId: ASSET.id, projectionId: 'one' } },
      { id: 'inject', kind: 'usage_recorded', occurredAt: '2026-09-18T05:01:00.000Z', refs: { assetId: ASSET.id, projectionId: 'one', usageOutcome: 'injected' } },
      { id: 'feedback', kind: 'usage_recorded', occurredAt: '2026-10-08T05:00:00.000Z', refs: { assetId: ASSET.id, usageOutcome: 'feedback_positive' } },
      { id: 'version', kind: 'asset_version', occurredAt: '2026-10-09T05:00:00.000Z', refs: { assetId: ASSET.id } },
      { id: 'other1', kind: 'projection_confirmed', occurredAt: '2026-09-17T05:00:00.000Z', refs: { assetId: other.id, projectionId: 'other1' } },
      { id: 'other2', kind: 'projection_confirmed', occurredAt: '2026-09-17T06:00:00.000Z', refs: { assetId: other.id, projectionId: 'other2' } },
    ];
    const { ns, ui } = loadCognitionAssets({ assets: [ASSET, other], proofs });
    ns.library.state.sort = 'used';
    expect(ui.broughtInCountFor(ASSET.id)).toBe(1);
    expect(ui.broughtInCountFor(other.id)).toBe(2);
    expect(ns.library.filtered().map((asset: { id: string }) => asset.id)).toEqual([other.id, ASSET.id]);
  });

  it('没有投影ID的实际注入也计一次，评价不能把最近使用时间刷成今天', () => {
    const proofs = [
      { id: 'injected', kind: 'usage_recorded', occurredAt: '2026-09-18T05:00:00.000Z', refs: { assetId: ASSET.id, usageOutcome: 'injected' } },
      { id: 'feedback', kind: 'usage_recorded', occurredAt: '2026-10-08T05:00:00.000Z', refs: { assetId: ASSET.id, usageOutcome: 'feedback_positive' } },
    ];
    const loaded = loadCognitionAssets({ assets: [ASSET], proofs });
    expect(loaded.ui.broughtInCountFor(ASSET.id)).toBe(1);
    const lastUse = detail({ proofs }).match(/<div class="ca-asset-last-use">([\s\S]*?)<\/div>/)?.[1] || '';
    expect(visibleText(lastUse)).toContain(LAST_USED_PREFIX);
    expect(visibleText(lastUse)).not.toContain('2026/10/8');
    expect(visibleText(detail({ proofs }))).toContain(zhPhrase('cognition.proof_projected_times', { n: '1' }));
  });

  it('同投影的确认与多条注入只计一次，撤销仍单独保留', () => {
    const proofs = [
      { id: 'confirm', kind: 'projection_confirmed', occurredAt: '2026-09-18T05:00:00.000Z', refs: { assetId: ASSET.id, projectionId: 'projection-one' } },
      { id: 'inject1', kind: 'usage_recorded', occurredAt: '2026-09-18T05:01:00.000Z', refs: { assetId: ASSET.id, projectionId: 'projection-one', usageOutcome: 'injected' } },
      { id: 'inject2', kind: 'usage_recorded', occurredAt: '2026-09-18T05:02:00.000Z', refs: { assetId: ASSET.id, projectionId: 'projection-one', usageOutcome: 'injected' } },
    ];
    expect(visibleText(detail({ proofs }))).toContain(zhPhrase('cognition.catalog_used_times', { n: '1' }));
    expect(visibleText(detail({ proofs }))).toContain(zhPhrase('cognition.proof_projected_times', { n: '1' }));
  });
});
