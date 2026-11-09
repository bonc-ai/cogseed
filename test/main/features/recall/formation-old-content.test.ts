import { describe, expect, it } from 'vitest';
import {
  unavailableFormationOldContentPlan,
  validateFormationOldContentPlan,
} from '../../../../src/main/features/recall/formation-old-content';
import type { CaptureExistingAsset } from '../../../../src/main/features/recall/capture-existing-assets';

const assets: CaptureExistingAsset[] = [
  { id: 'asset-a', title: '报告来源要求', statement: '提交报告前核对来源。', type: 'rule', scope: 'general', version: '2', evidenceRefs: [] },
  { id: 'asset-b', title: '报告结论要求', statement: '提交报告前写结论与下一步。', type: 'rule', scope: 'general', version: '3', evidenceRefs: [] },
  { id: 'asset-c', title: '离线草稿', statement: '离线草稿不进入正式流程。', type: 'cognition', scope: 'general', version: '1', evidenceRefs: [] },
];
const relatedAssets = assets.map(asset => ({ assetId: asset.id, version: asset.version }));

describe('formation old-content plan contract', () => {
  it('accepts a source-covered merge, binds versions, and strips raw quotes', () => {
    const plan = validateFormationOldContentPlan({
      items: [{
        action: 'merge', reasonCode: 'merge_complementary', reason: '两条要求共同约束报告提交。',
        assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
        merged: {
          statement: '提交报告前核对来源，并写结论与下一步。',
          applicableWhen: ['正式报告'],
          excerpts: [
            { assetId: 'asset-a', quote: '核对来源' },
            { assetId: 'asset-b', quote: '写结论与下一步' },
          ],
        },
      }],
    }, { relatedAssets: relatedAssets.slice(0, 2), assets });
    expect(plan).toMatchObject({
      status: 'ready',
      assetIds: ['asset-a', 'asset-b'],
      baselineVersions: { 'asset-a': '2', 'asset-b': '3' },
      items: [{
        itemId: 'old-1', action: 'merge', targetAssetId: 'asset-a',
        expectedVersions: { 'asset-a': '2', 'asset-b': '3' },
        merged: { evidenceAssetIds: ['asset-a', 'asset-b'] },
      }],
    });
    expect(plan.items[0].merged).not.toHaveProperty('excerpts');
    expect(plan.items[0].merged?.evidenceAssetIds).toEqual(['asset-a', 'asset-b']);
  });

  it('keeps conflict as an unresolved host-visible reason rather than an action', () => {
    const plan = validateFormationOldContentPlan({
      items: [{
        action: 'keep', reasonCode: 'keep_independent', reason: '两条服务不同场景。', assetIds: ['asset-c'],
      }],
      unresolved: [{
        reasonCode: 'needs_user_arbitration', reason: '两条结论存在冲突。', assetIds: ['asset-a', 'asset-b'],
      }],
    }, { relatedAssets, assets });
    expect(plan.status).toBe('needs_review');
    expect(plan.items[0]).toMatchObject({ action: 'keep', assetIds: ['asset-c'] });
    expect(plan.unresolved[0]).toMatchObject({ reasonCode: 'needs_user_arbitration' });
  });

  it('rejects invented actions, mismatched reasons, duplicate ownership and unreviewed assets', () => {
    const base = { reason: '合成原因', assetIds: ['asset-a'] };
    expect(() => validateFormationOldContentPlan({
      items: [{ ...base, action: 'needs_user_arbitration', reasonCode: 'keep_independent' }],
    }, { relatedAssets, assets })).toThrow();
    expect(() => validateFormationOldContentPlan({
      items: [{ ...base, action: 'archive', reasonCode: 'delete_unsuitable' }],
    }, { relatedAssets, assets })).toThrow('reason does not match action');
    expect(() => validateFormationOldContentPlan({
      items: [{ ...base, action: 'keep', reasonCode: 'keep_independent' },
        { ...base, action: 'archive', reasonCode: 'archive_obsolete' }],
    }, { relatedAssets, assets })).toThrow('outside the reviewed group');
    expect(() => validateFormationOldContentPlan({
      items: [{ ...base, action: 'keep', reasonCode: 'keep_independent', assetIds: ['asset-x'] }],
    }, { relatedAssets, assets })).toThrow('outside the reviewed group');
    expect(() => validateFormationOldContentPlan({
      items: [{ ...base, action: 'keep', reasonCode: 'keep_independent' }],
    }, { relatedAssets, assets })).toThrow('does not cover the reviewed group');
  });

  it('refuses a merge across incompatible scope boundaries', () => {
    const splitScope = assets.map(asset => asset.id === 'asset-b' ? { ...asset, scope: 'code' } : asset);
    expect(() => validateFormationOldContentPlan({
      items: [{ action: 'merge', reasonCode: 'merge_complementary', reason: '看似相关。',
        assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
        merged: { statement: '合并正文。', excerpts: [
          { assetId: 'asset-a', quote: '核对来源' }, { assetId: 'asset-b', quote: '写结论与下一步' }] } }],
    }, { relatedAssets: relatedAssets.slice(0, 2), assets: splitScope })).toThrow('boundaries are incompatible');
  });

  it('requires complete exact-quote coverage for a merge', () => {
    const item = {
      action: 'merge', reasonCode: 'merge_complementary', reason: '互补。',
      assetIds: ['asset-a', 'asset-b'], targetAssetId: 'asset-a',
      merged: { statement: '合并正文。', excerpts: [{ assetId: 'asset-a', quote: '提交报告前核对来源。' }] },
    };
    expect(() => validateFormationOldContentPlan({ items: [item] }, { relatedAssets, assets }))
      .toThrow('evidence from every source');
    item.merged.excerpts.push({ assetId: 'asset-b', quote: '不存在的原文' });
    expect(() => validateFormationOldContentPlan({ items: [item] }, { relatedAssets, assets }))
      .toThrow('excerpt unavailable');
  });

  it('fails closed for incomplete evidence without manufacturing an executable item', () => {
    const plan = unavailableFormationOldContentPlan(['asset-a', 'asset-b'], assets, 'insufficient');
    expect(plan).toMatchObject({
      status: 'insufficient', items: [],
      unresolved: [{ reasonCode: 'evidence_insufficient', assetIds: ['asset-a', 'asset-b'] }],
    });
    expect(() => unavailableFormationOldContentPlan(['asset-a'], assets, 'unavailable'))
      .toThrow('outside review bounds');
  });
});
