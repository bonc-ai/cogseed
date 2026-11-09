/**
 * 旧内容整理方案独立入口：方案是独立记录，候选被拒后仍应在活动列表出现；
 * 同一方案被多条候选引用时只列一行，并显示关联建议数。
 */
import { describe, expect, it } from 'vitest';
import { renderCognition } from './helpers/cognition-renderer';

const PLAN = {
  id: 'ocp-1',
  status: 'ready',
  revision: 1,
  assetIds: ['aa-a', 'aa-b'],
  assets: [
    { id: 'aa-a', title: '报告核对要求', version: '2' },
    { id: 'aa-b', title: '报告结论要求', version: '1' },
  ],
  candidateIds: ['cand-a', 'cand-b'],
  itemCount: 1,
  unresolvedCount: 0,
  pendingCount: 1,
  executedCount: 0,
  updatedAt: '2026-10-28T12:00:00.000Z',
};

describe('旧内容整理方案独立入口', () => {
  it('在活动列表生成一行方案，并保留关联建议数', () => {
    const html = renderCognition({ name: 'activity' }, { oldContentPlans: [PLAN] });
    expect(html).toContain('报告核对要求 / 报告结论要求');
    expect(html).toContain('旧内容整理 · 待处理');
  });

  it('方案详情显示资产、方案项与关联建议', () => {
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, { oldContentPlans: [PLAN] });
    expect(html).toContain('旧内容整理方案');
    expect(html).toContain('报告核对要求');
    expect(html).toContain('报告结论要求');
    expect(html).toContain('方案项 1 · 未决 0 · 已处理 0');
    expect(html).toContain('关联建议 2 条');
  });

  it('未决项逐项给出保留、指定合并目标，全部保留单独提供', () => {
    const detail = {
      id: 'ocp-1', revision: 1, status: 'needs_review', assetIds: ['aa-a', 'aa-b'],
      baselineVersions: { 'aa-a': '1', 'aa-b': '1' }, items: [], executions: [], finalizations: [], history: [],
      candidateIds: ['cand-a'], updatedAt: '2026-10-28T12:00:00.000Z',
      unresolved: [{ itemId: 'unresolved-aa', reasonCode: 'needs_user_arbitration', reason: '两条结论冲突。',
        assetIds: ['aa-a', 'aa-b'], baselineVersions: { 'aa-a': '1', 'aa-b': '1' } }],
    };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
    });
    expect(html).toContain('两条结论冲突。');
    expect(html).toContain('保留，不执行');
    expect(html).toContain('合并到「报告核对要求」');
    expect(html).toContain('合并到「报告结论要求」');
    expect(html).toContain('全部保留，不再裁定');
  });

  it('可执行单位带勾选与执行入口，已处理单位显示回执', () => {
    const detail = {
      id: 'ocp-1', revision: 1, status: 'ready', assetIds: ['aa-a', 'aa-b'],
      baselineVersions: { 'aa-a': '1', 'aa-b': '1' }, finalizations: [], history: [],
      candidateIds: [], updatedAt: '2026-10-28T12:00:00.000Z',
      items: [{ itemId: 'old-1', modelAction: 'merge', action: 'merge', state: 'included',
        reasonCode: 'merge_complementary', reason: '合并两条要求。', assetIds: ['aa-a'],
        targetAssetId: 'aa-a', expectedVersions: { 'aa-a': '1' },
        merged: { statement: '合并后的正文。', evidenceAssetIds: ['aa-a'], bodySource: 'model' } }],
      unresolved: [{ itemId: 'unresolved-x', reasonCode: 'needs_user_arbitration', reason: '已核对。',
        assetIds: ['aa-b'], baselineVersions: { 'aa-b': '1' }, resolution: 'keep',
        resolvedAt: '2026-10-28T12:00:00.000Z' }],
      executions: [{ executionId: 'oce-1', digest: 'd', decisionId: 'rd_1', revision: 1,
        committedAt: '2026-10-28T12:00:00.000Z',
        items: [{ itemId: 'unresolved-x', action: 'keep', status: 'kept', assetIds: ['aa-b'] }] }],
    };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
    });
    expect(html).toContain('data-old-content-unit="1"');
    expect(html).toContain('执行选中');
    expect(html).toContain('已保留');
    // 合并正文来自模型，执行前必须能由人改写。
    expect(html).toContain('编辑合并正文');
    expect(html).toContain('data-old-content-merge-body="old-1"');
    expect(html).toContain('保存正文');
  });

  it('用户改写过合并正文后标明来源', () => {
    const detail = {
      id: 'ocp-1', revision: 2, status: 'ready', assetIds: ['aa-a'], baselineVersions: { 'aa-a': '1' },
      unresolved: [], finalizations: [], history: [], executions: [], candidateIds: [],
      updatedAt: '2026-10-28T12:00:00.000Z',
      items: [{ itemId: 'old-1', modelAction: 'merge', action: 'merge', state: 'included',
        reasonCode: 'merge_complementary', reason: '合并要求。', assetIds: ['aa-a'],
        targetAssetId: 'aa-a', expectedVersions: { 'aa-a': '1' },
        merged: { statement: '用户改写后的正文。', evidenceAssetIds: ['aa-a'], bodySource: 'user' } }],
    };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
    });
    expect(html).toContain('已由你修改');
    expect(html).toContain('用户改写后的正文。');
  });

  it('审阅明细展示修改前后、来源摘录与目标版本', () => {
    const detail = {
      id: 'ocp-1', revision: 1, status: 'ready', assetIds: ['aa-a'],
      baselineVersions: { 'aa-a': '1' }, unresolved: [], finalizations: [], history: [], executions: [],
      candidateIds: [], updatedAt: '2026-10-28T12:00:00.000Z',
      items: [{ itemId: 'old-1', modelAction: 'merge', action: 'merge', state: 'included',
        reasonCode: 'merge_complementary', reason: '合并要求。', assetIds: ['aa-a'],
        targetAssetId: 'aa-a', expectedVersions: { 'aa-a': '1' },
        merged: { statement: '新正文。', evidenceAssetIds: ['aa-a'], bodySource: 'model' } }],
    };
    const review = { planId: 'ocp-1', revision: 1, status: 'ready', generatedAt: '2026-10-28T12:00:00.000Z',
      units: [{ unitId: 'old-1', kind: 'item', action: 'merge', reason: '合并要求。', targetAssetId: 'aa-a',
        targetVersion: '2', blockers: [], assets: [{ id: 'aa-a', title: '报告核对要求', version: '1',
          status: 'active', before: { statement: '旧正文。' }, after: { statement: '新正文。' },
          changes: [{ kind: 'statement', field: 'statement', before: '旧正文。', after: '新正文。' }],
          excerpts: [{ state: 'available', excerpt: '来源原文。' }] }] }] };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
      oldContentPlanReviews: { 'ocp-1': { loading: false, loaded: true, review, error: '' } },
    });
    expect(html).toContain('查看修改前后与来源');
    expect(html).toContain('旧正文。');
    expect(html).toContain('新正文。');
    expect(html).toContain('来源摘录');
    expect(html).toContain('目标版本 v2');
  });

  it('已执行的方案提供整组撤销入口', () => {
    const detail = {
      id: 'ocp-1', revision: 1, status: 'applied', assetIds: ['aa-a', 'aa-b'],
      baselineVersions: { 'aa-a': '1', 'aa-b': '1' }, unresolved: [], finalizations: [], history: [],
      candidateIds: [], updatedAt: '2026-10-28T12:00:00.000Z', items: [],
      executions: [{ executionId: 'oce-1', digest: 'd', decisionId: 'rd_1', revision: 1,
        committedAt: '2026-10-28T12:00:00.000Z',
        items: [{ itemId: 'old-1', action: 'merge', status: 'applied', assetIds: ['aa-a', 'aa-b'] }] }],
    };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
    });
    expect(html).toContain('撤销本次整理');
    expect(html).not.toContain('编辑合并正文');
  });

  it('单资产未决项才提供归档', () => {
    const detail = {
      id: 'ocp-1', revision: 1, status: 'needs_review', assetIds: ['aa-a'],
      baselineVersions: { 'aa-a': '1' }, items: [], executions: [], finalizations: [], history: [],
      candidateIds: [], updatedAt: '2026-10-28T12:00:00.000Z',
      unresolved: [{ itemId: 'unresolved-a', reasonCode: 'evidence_insufficient', reason: '来源读不全。',
        assetIds: ['aa-a'], baselineVersions: { 'aa-a': '1' } }],
    };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
    });
    expect(html).toContain('归档');
    expect(html).not.toContain('合并到「');
  });

  it('方案缺失时给出刷新入口，不伪造空方案', () => {
    const html = renderCognition({ name: 'activity', planId: 'ocp-missing' }, { oldContentPlans: [] });
    expect(html).toContain('这条整理方案已处理或不可用。');
  });

  it('已撤销或不可执行的方案不再提供勾选与执行死入口', () => {
    for (const status of ['undone', 'dismissed', 'purged']) {
      const detail = {
        id: 'ocp-1', revision: 1, status, assetIds: ['aa-a', 'aa-b'],
        baselineVersions: { 'aa-a': '1', 'aa-b': '1' }, unresolved: [], finalizations: [], history: [],
        candidateIds: [], updatedAt: '2026-10-28T12:00:00.000Z',
        items: [{ itemId: 'old-1', modelAction: 'keep', action: 'keep', state: 'included',
          reasonCode: 'keep_independent', reason: '保留。', assetIds: ['aa-a', 'aa-b'],
          expectedVersions: { 'aa-a': '1', 'aa-b': '1' } }],
        executions: status === 'undone' ? [{ executionId: 'oce-1', digest: 'd', decisionId: 'rd_1', revision: 1,
          committedAt: '2026-10-28T12:00:00.000Z', undoneAt: '2026-10-28T13:00:00.000Z',
          items: [{ itemId: 'old-1', action: 'keep', status: 'kept', assetIds: ['aa-a', 'aa-b'] }] }] : [],
      };
      const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
        oldContentPlans: [PLAN],
        oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
      });
      expect(html).not.toContain('data-old-content-unit="1"');
      expect(html).not.toContain('执行选中');
      expect(html).not.toContain('撤销本次整理');
    }
  });

  it('阻塞方案说明原因，并逐项给出不能执行的理由', () => {
    const detail = {
      id: 'ocp-1', revision: 1, status: 'blocked', assetIds: ['aa-a'],
      baselineVersions: { 'aa-a': '1' }, unresolved: [], finalizations: [], history: [],
      candidateIds: [], updatedAt: '2026-10-28T12:00:00.000Z',
      blockedReason: 'mixed_execution_state',
      items: [{ itemId: 'old-1', modelAction: 'merge', action: 'merge', state: 'included',
        reasonCode: 'merge_complementary', reason: '合并要求。', assetIds: ['aa-a'],
        targetAssetId: 'aa-a', expectedVersions: { 'aa-a': '1' },
        merged: { statement: '新正文。', evidenceAssetIds: ['aa-a'], bodySource: 'model' } }],
    };
    const review = { planId: 'ocp-1', revision: 1, status: 'blocked', generatedAt: '2026-10-28T12:00:00.000Z',
      units: [{ unitId: 'old-1', kind: 'item', action: 'merge', reason: '合并要求。', targetAssetId: 'aa-a',
        blockers: ['baseline_changed:old-1:aa-a'], assets: [] }] };
    const html = renderCognition({ name: 'activity', planId: 'ocp-1' }, {
      oldContentPlans: [PLAN],
      oldContentPlanDetails: { 'ocp-1': { loading: false, loaded: true, plan: detail, error: '' } },
      oldContentPlanReviews: { 'ocp-1': { loading: false, loaded: true, review, error: '' } },
    });
    expect(html).toContain('上一次处理只完成了一部分');
    expect(html).toContain('这项现在不能执行');
    expect(html).toContain('内容已变化，需要重新核对');
    expect(html).not.toContain('执行选中');
  });
});
