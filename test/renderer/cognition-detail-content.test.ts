import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const asset = { id: 'synthetic-detail', title: '来源核对规则', type: 'cognition', contentCategory: 'rule', statement: '评审前核对来源，演练除外。', value: '用于正式评审的来源核对。', scope: 'review', applicableWhen: ['正式评审'], forbiddenWhen: ['演练'], status: 'active', version: '2', activeVersion: '2', evidenceRefs: [] };
const proposal = { id: 'synthetic-proposal', assetId: asset.id, baselineVersion: '2', state: 'pending', fields: ['value'], payload: { value: '用于正式评审和交付检查。' }, beforeValues: { value: asset.value }, reason: 'Synthetic evidence', createdAt: '2026-01-01T00:00:00Z' };

describe('shared complete cognition content', () => {
  it('shows untouched fields in a value-only approval and uses the same template after saving', () => {
    const loaded = loadCognitionAssets({ assets: [asset], assetApprovals: [proposal] }, { name: 'activity', approvalId: proposal.id });
    const html = loaded.render();
    for (const value of [asset.statement, proposal.payload.value, ...asset.applicableWhen, ...asset.forbiddenWhen]) expect(html).toContain(value);
    const merged = { ...asset, ...proposal.payload };
    expect(html).toContain(loaded.ui.cognitionContentFields(merged, { part: 'body' }));
    expect(html).toContain(loaded.ui.cognitionContentFields(merged, { part: 'boundary', omitUseHint: true }));
    expect(html).toContain('版本与使用记录');
    loaded.store.assets = [{ ...asset, ...proposal.payload, version: '3', activeVersion: '3' }];
    loaded.store.route = { name: 'overview', assetId: asset.id };
    const library = loaded.render();
    expect(library).toContain(loaded.ui.cognitionContentFields(merged, { part: 'body' }));
    expect(library).toContain(loaded.ui.cognitionContentFields(merged, { part: 'boundary', omitUseHint: true }));
  });
  it('uses a frozen baseline rather than a changed live body, and blocks confirmation', async () => {
    const live = { ...asset, statement: '后续修改的正文', value: '后续用途', version: '3', activeVersion: '3' };
    const loaded = loadCognitionAssets({ assets: [live], assetApprovals: [proposal], assetVersions: { assetId: asset.id, versions: [{ version: '2', snapshot: asset }] } }, { name: 'activity', approvalId: proposal.id });
    const html = loaded.render();
    expect(html).toContain(asset.statement);
    expect(html).not.toContain(live.statement);
    loaded.ns.api.call = vi.fn();
    await loaded.ns.activityController.handleClick({ dataset: { act: 'activity-approval', id: proposal.id, decision: 'confirm' }, getAttribute: () => null });
    expect(loaded.ns.api.call).not.toHaveBeenCalled();
  });
  it('keeps a missing baseline unavailable and retains defer/reject actions', () => {
    const loaded = loadCognitionAssets({ assets: [{ ...asset, version: '3', activeVersion: '3' }], assetApprovals: [proposal], assetVersions: { assetId: asset.id, failed: true } }, { name: 'activity', approvalId: proposal.id });
    const html = loaded.render();
    expect(html).toContain('原版本内容不可用');
    expect(html).toContain('data-decision="defer"');
    expect(html).toContain('data-decision="reject"');
    expect(html).not.toContain(asset.statement);
  });
  it('shows absent purpose and boundaries without borrowing another version or inventing permission', () => {
    const loaded = loadCognitionAssets({ assets: [asset] });
    const html = loaded.ui.cognitionContentFields({ statement: '旧内容' });
    expect(html).toContain('用途');
    expect(html).not.toContain('未来用途');
    expect(html).toContain('使用边界');
    expect(html).toContain('未记录');
    expect(html).not.toContain(asset.value);
    expect(html).not.toContain('无限制');
    expect(loaded.ui.cognitionContentFields({ statement: '本体定义' }, { ontologyOnly: true })).toContain('不适用');
  });
  it('reads the saved approval version instead of recomputing it from the proposal or latest asset', () => {
    const frozen = { ...asset, value: '确认时的用途', version: '3' };
    const loaded = loadCognitionAssets({ assets: [{ ...asset, statement: '后续正文', version: '4', activeVersion: '4' }],
      assetApprovals: [{ ...proposal, state: 'confirmed', appliedVersion: '3' }],
      assetVersions: { assetId: asset.id, versions: [{ version: '3', snapshot: frozen }] } }, { name: 'activity', approvalId: proposal.id });
    const html = loaded.render();
    expect(html).toContain(loaded.ui.cognitionContentFields(frozen, { part: 'body' }));
    expect(html).toContain(loaded.ui.cognitionContentFields(frozen, { part: 'boundary', omitUseHint: true }));
    expect(html).toContain('已保存 v3');
    expect(html).not.toContain('后续正文');
  });
  it('blocks an unchanged version counter when the active content has switched', async () => {
    const loaded = loadCognitionAssets({ assets: [{ ...asset, activeVersion: '1' }], assetApprovals: [proposal],
      assetVersions: { assetId: asset.id, versions: [{ version: '2', snapshot: asset }] } }, { name: 'activity', approvalId: proposal.id });
    loaded.ns.api.call = vi.fn();
    await loaded.ns.activityController.handleClick({ dataset: { act: 'activity-approval', id: proposal.id, decision: 'confirm' }, getAttribute: () => null });
    expect(loaded.ns.api.call).not.toHaveBeenCalled();
  });
  it('shows a saved candidate from its decision snapshot, with the same source and boundary sections', () => {
    const candidate = { id: 'synthetic-candidate', status: 'confirmed', summary: '旧候选标题', judgment: '未保存草案', value: '草案用途',
      suggestedType: 'cognition', suggestedScope: 'review', suggestedAction: 'create', reviewDecisionId: 'synthetic-decision', promotedAssetId: asset.id,
      capabilities: { isTerminal: true }, evidenceRefs: [] };
    const loaded = loadCognitionAssets({ assets: [{ ...asset, value: '后续用途', version: '3', activeVersion: '3' }], candidates: [candidate],
      assetVersions: { assetId: asset.id, versions: [{ version: '2', reason: 'review_decision:synthetic-decision', snapshot: asset }] } }, { name: 'activity', candidateId: candidate.id });
    const saved = loaded.render();
    expect(saved).toContain(loaded.ui.cognitionContentFields(asset, { part: 'body' }));
    expect(saved).toContain(loaded.ui.cognitionContentFields(asset, { part: 'boundary', omitUseHint: true }));
    expect(loaded.render()).toContain('已保存 v2');
    expect(loaded.render()).not.toContain('后续用途');
    const source = { kind: 'conversation', id: 'synthetic-source', degraded: true, excerpt: '不可展示原文' };
    expect(loaded.ui.cognitionSources([source])).not.toContain('不可展示原文');
  });

});

it('keeps both drawer controllers and scrims on the width-or-height breakpoint', () => {
  const root = path.resolve(__dirname, '../../src/renderer/modules');
  for (const file of ['cognition-assets/library.js', 'cognition-assets/review-views.js']) {
    expect(fs.readFileSync(path.join(root, file), 'utf8')).toContain("(max-width: 1100px), (max-height: 500px)");
  }
  for (const file of ['cognition-assets/library.css', 'cognition-activity.css']) {
    const css = fs.readFileSync(path.join(root, file), 'utf8').replace(/\s+/g, '');
    const constrained = css.split('@media(max-width:1100px),(max-height:500px){')[1]?.split('@media')[0] || '';
    expect(constrained).toContain('scrim{display:block;');
    expect(constrained).toContain('width:min(480px,94vw)');
  }
});

it('does not replace an unavailable version read with the live record', async () => {
  for (const state of [{ failed: true }, { versions: [] }]) {
    const loaded = loadCognitionAssets({ assets: [asset], assetApprovals: [proposal],
      assetVersions: { assetId: asset.id, ...state } }, { name: 'activity', approvalId: proposal.id });
    expect(loaded.render()).toContain('原版本内容不可用');
    loaded.ns.api.call = vi.fn();
    await loaded.ns.activityController.handleClick({ dataset: { act: 'activity-approval', id: proposal.id, decision: 'confirm' }, getAttribute: () => null });
    expect(loaded.ns.api.call).not.toHaveBeenCalled();
  }
});
