/**
 * 多关联内容处置块的渲染与委托。
 *
 * 守用户可见的三件事：合并目标只列当前可核对（active）的关联条目；合并前
 * 的共享确认说清"其余条目会归档"；重判中/失败/保留状态来自主进程派生的
 * `relatedFormation`，渲染层不自行推断。动作委托与 pending 保护由
 * `cognition-action-contract` 的清单同时核对。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const root = path.join(__dirname, '../..');
const core = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/core.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/modules/cognition-assets/app.js'), 'utf8');

const ASSETS = [
  { id: 'aa-a', title: '上线范围核对', status: 'active', type: 'rule', version: '1' },
  { id: 'aa-b', title: '上线范围记录', status: 'active', type: 'rule', version: '2' },
  { id: 'aa-c', title: '上线范围复核', status: 'active', type: 'rule', version: '3' },
  { id: 'aa-d', title: '已归档的旧条目', status: 'archived', type: 'rule', version: '1' },
];

function candidate(over: Record<string, unknown> = {}) {
  return {
    id: 'cand-related-1',
    status: 'pending_review',
    judgment: '发布前先确认上线范围，再按同一套流程记录核对结果。',
    value: '合并后的旧内容仍按同一套核对流程执行。',
    summary: '合并后的发布核对',
    suggestedType: 'rule',
    suggestedScope: 'general',
    suggestedAction: 'create',
    risk: 'low',
    sourceRefs: [{ kind: 'memory', id: 'mem-related' }],
    evidenceRefs: [{ kind: 'memory', id: 'mem-related' }],
    expiresAt: '2099-01-01T00:00:00.000Z',
    formationComparison: {
      relation: 'ambiguous',
      reason: '这条建议同时涉及多条已有内容。',
      relatedAssets: [
        { assetId: 'aa-a', version: '1' },
        { assetId: 'aa-b', version: '2' },
        { assetId: 'aa-c', version: '3' },
        { assetId: 'aa-d', version: '1' },
      ],
    },
    capabilities: {
      canView: true, canEdit: true, canPromote: true, canReject: true, canDefer: true,
      isTerminal: false, countsAsPending: true, needsUserAction: true, displayState: 'needs_review',
    },
    ...over,
  };
}

function render(over: Record<string, unknown> = {}) {
  const { ns } = loadCognitionAssets({ candidates: [candidate(over)], assets: ASSETS });
  return ns.candidate.formCard(candidate(over));
}

describe('多关联内容处置块', () => {
  it('合并目标只列当前可核对的关联条目，并提供合并/保留动作', () => {
    const html = render();
    expect(html).toContain('data-related-target');
    expect(html).toContain('value="aa-a"');
    expect(html).toContain('value="aa-b"');
    expect(html).toContain('value="aa-c"');
    expect(html).not.toContain('value="aa-d"');
    expect(html).toContain('data-act="related-resolve-merge"');
    expect(html).toContain('data-act="related-resolve-keep"');
    expect(html).toContain('合并这些旧内容并重新核对');
    expect(html).toContain('保留全部');
    expect(html).toContain('已归档的旧条目');
    expect(html).toContain('当前无法核对');
  });

  it('只有一条可核对内容时不提供合并动作，只能保留全部', () => {
    const html = render({
      formationComparison: {
        relation: 'ambiguous', reason: '只关联到一条可读内容。',
        relatedAssets: [{ assetId: 'aa-a', version: '1' }, { assetId: 'aa-d', version: '1' }],
      },
    });
    expect(html).not.toContain('data-act="related-resolve-merge"');
    expect(html).toContain('data-act="related-resolve-keep"');
    expect(html).toContain('当前只有一条关联内容可以核对');
  });

  it('已归并并正在重判时展示进行中状态，不再提供二次合并', () => {
    const html = render({
      relatedResolution: { action: 'merged', targetAssetId: 'aa-a', targetVersion: '4', at: '2026-10-28T00:00:00.000Z', receipts: [] },
      relatedFormation: { captureId: 'cap-1', status: 'running', action: 'merged', targetAssetId: 'aa-a', retryable: false },
    });
    expect(html).toContain('正在按合并后的内容重新核对');
    expect(html).not.toContain('data-act="related-resolve-merge"');
    expect(html).not.toContain('data-act="related-resolve-keep"');
  });

  it('重判失败：说明原因并给出重试入口，旧建议仍在', () => {
    const html = render({
      relatedResolution: { action: 'merged', targetAssetId: 'aa-a', targetVersion: '4', at: '2026-10-28T00:00:00.000Z', receipts: [] },
      relatedFormation: { captureId: 'cap-1', status: 'failed', action: 'merged', targetAssetId: 'aa-a', error: 'model_not_configured', retryable: true },
    });
    expect(html).toContain('当前没有可用模型');
    expect(html).toContain('data-act="related-resolve-retry"');
    expect(html).toContain('重试重新核对');
  });

  it('保留全部后展示已核对状态，不再出现合并入口', () => {
    const html = render({
      relatedResolution: { action: 'kept', at: '2026-10-28T00:00:00.000Z' },
      relatedFormation: { captureId: 'cap-1', status: 'completed', action: 'kept', retryable: false },
    });
    expect(html).toContain('已核对：保留这些旧内容，没有合并。');
    expect(html).not.toContain('data-act="related-resolve-merge"');
    expect(html).not.toContain('data-act="related-resolve-keep"');
  });

  it('终态候选只读：没有处置动作', () => {
    const html = render({
      status: 'rejected',
      capabilities: { canView: true, canEdit: false, canPromote: false, canReject: false, isTerminal: true, countsAsPending: false },
      relatedResolution: { action: 'merged', targetAssetId: 'aa-a', targetVersion: '4', at: '2026-10-28T00:00:00.000Z', receipts: [] },
      relatedFormation: { captureId: 'cap-1', status: 'failed', action: 'merged', error: 'capture_reformation_failed', retryable: true },
    });
    expect(html).not.toContain('data-act="related-resolve-merge"');
    expect(html).not.toContain('data-act="related-resolve-keep"');
    expect(html).not.toContain('data-act="related-resolve-retry"');
  });
});

describe('旧内容整理方案', () => {
  const plan = {
    schemaVersion: 1, status: 'ready', assetIds: ['aa-a', 'aa-b'],
    baselineVersions: { 'aa-a': '1', 'aa-b': '2' },
    items: [{ itemId: 'old-1', action: 'merge', reasonCode: 'merge_complementary', reason: '两条要求共同约束发布核对。',
      assetIds: ['aa-a', 'aa-b'], targetAssetId: 'aa-a', expectedVersions: { 'aa-a': '1', 'aa-b': '2' },
      merged: { statement: '发布前确认上线范围，并记录核对结果。', evidenceAssetIds: ['aa-a', 'aa-b'] } }],
    unresolved: [],
  };
  it('shows the validated plan and replaces the legacy related-merge entry', () => {
    const html = render({ oldContentPlan: plan });
    expect(html).toContain('旧内容整理方案');
    expect(html).toContain('合并目标：上线范围核对');
    expect(html).toContain('查看合并后的正文');
    expect(html).toContain('会一并按方案处理旧内容');
    expect(html).not.toContain('data-act="old-content-confirm"');
    expect(html).not.toContain('data-act="related-resolve-merge"');
    expect(html).not.toContain('data-act="related-resolve-keep"');
  });
  it('does not offer execution while decisions remain unresolved', () => {
    const html = render({ oldContentPlan: { ...plan, status: 'needs_review', unresolved: [{
      reasonCode: 'needs_user_arbitration', reason: '两条结论存在冲突。', assetIds: ['aa-b'],
      baselineVersions: { 'aa-b': '2' } }] } });
    expect(html).toContain('需要你核对');
    expect(html).not.toContain('data-act="old-content-confirm"');
  });
  it('shows per-item keep and unresolved keep controls for the independent plan', () => {
    const html = render({ oldContentPlan: plan, oldContentPlanId: 'ocp-' + 'a'.repeat(24),
      oldContentPlanState: 'ready', oldContentPlanRevision: 2,
      oldContentPlanRecord: { schemaVersion: 2, ownerId: 'u', id: 'ocp-' + 'a'.repeat(24),
        groupKey: 'b'.repeat(64), revision: 2, assetIds: ['aa-a', 'aa-b'],
        baselineVersions: { 'aa-a': '1', 'aa-b': '2' }, status: 'ready', origin: 'formation',
        digest: 'c'.repeat(64), items: [{ itemId: 'old-1', modelAction: 'merge', action: 'merge', state: 'included',
          reasonCode: 'merge_complementary', reason: '两条共同约束发布。', assetIds: ['aa-a', 'aa-b'],
          targetAssetId: 'aa-a', expectedVersions: { 'aa-a': '1', 'aa-b': '2' },
          merged: { statement: '合并正文。', evidenceAssetIds: ['aa-a', 'aa-b'], bodySource: 'model' } }],
        unresolved: [{ reasonCode: 'needs_user_arbitration', reason: '需要核对。', assetIds: ['aa-a', 'aa-b'],
          baselineVersions: { 'aa-a': '1', 'aa-b': '2' } }], executions: [], finalizations: [], history: [],
        createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' } });
    expect(html).toContain('data-act="old-content-item-keep"');
    expect(html).toContain('data-act="old-content-keep-unresolved"');
    expect(html).toContain('data-old-item="old-1"');
  });

  it('shows the receipt and removes the execution entry after commit', () => {
    const html = render({ oldContentPlan: plan, oldContentReceipt: { schemaVersion: 1,
      planDigest: 'a'.repeat(64), decisionId: 'rd_synthetic-old-content', committedAt: '2026-10-28T00:00:00.000Z',
      items: [{ itemId: 'old-1', action: 'merge', status: 'applied', assetIds: ['aa-a', 'aa-b'],
        targetAssetId: 'aa-a', targetVersion: '2', archivedIds: ['aa-b'] }] } });
    expect(html).toContain('已按方案处理 1 项旧内容');
    expect(html).not.toContain('data-act="old-content-confirm"');
  });

  it('旧内容完成而新内容失败时显示两阶段状态、重试与只处理旧内容入口', () => {
    const oldContentPlan = {
      schemaVersion: 1, status: 'ready', assetIds: ['aa-a'], baselineVersions: { 'aa-a': '1' },
      unresolved: [], items: [{ itemId: 'old-1', action: 'keep', reasonCode: 'keep_independent',
        reason: '保留这条。', assetIds: ['aa-a'], expectedVersions: { 'aa-a': '1' } }],
    };
    const over = {
      oldContentPlanId: 'ocp-1',
      oldContentPlan,
      oldContentFinalization: { candidateId: 'cand-related-1', phase: 'new_failed',
        updatedAt: '2026-10-28T12:00:00.000Z' },
    };
    const { ns } = loadCognitionAssets({ candidates: [candidate(over)], assets: ASSETS });
    const html = ns.candidate.formCard(candidate(over));
    expect(html).toContain('旧内容已完成，新内容待保存');
    expect(html).toContain('old-content-finalize-retry');
    expect(html).toContain('old-content-finalize-old');
  });

  it('旧内容方案待裁定时禁用保存入口，方案就绪后恢复', () => {
    const plan = { schemaVersion: 1, status: 'needs_review', assetIds: ['aa-a', 'aa-b'],
      baselineVersions: { 'aa-a': '1', 'aa-b': '2' }, items: [],
      unresolved: [{ reasonCode: 'needs_user_arbitration', reason: '两条结论文本冲突。',
        assetIds: ['aa-a', 'aa-b'], baselineVersions: { 'aa-a': '1', 'aa-b': '2' } }] };
    const button = (html: string) => (html.match(/<button[^>]*data-act="cand-adopt-with-form"[^>]*>/) || [''])[0];
    const pending = render({ oldContentPlanId: 'ocp-1', oldContentPlanState: 'needs_review', oldContentPlan: plan });
    expect(button(pending)).toBe('');
    const ready = render({ oldContentPlanId: 'ocp-1', oldContentPlanState: 'ready',
      oldContentPlan: { ...plan, status: 'ready', unresolved: [] } });
    expect(button(ready)).toContain('data-act="cand-adopt-with-form"');
  });
});

describe('多关联内容动作委托', () => {
  it('合并前用共享确认说明其余条目会归档，并走专用 IPC', () => {
    const start = core.indexOf('async resolveRelatedFormation');
    expect(start).toBeGreaterThan(-1);
    const body = core.slice(start, start + 4_000);
    expect(body).toContain('confirmUser');
    expect(body).toContain('cognition.formation_related_merge_confirm');
    expect(body).toContain('archive.length');
    expect(body).toContain("'recall.candidates.resolveRelated'");
    expect(body).toContain("action === 'keep'");
    expect(body).toContain('cognition.formation_related_kept_toast');
    expect(body).toContain('cognition.formation_related_conflict');
  });

  it('一次保存走持久化两阶段收尾，不再先提交旧内容再单独晋升', () => {
    expect(core).toContain("'recall.candidates.finalize'");
    expect(core).toContain("finalize('old_then_new'");
    expect(core).toMatch(/finalize\('old_then_new',\s*\{\s*forceCreateSimilar: true,/);
    expect(core).toContain('...(confirmBaselineVersion ? { confirmBaselineVersion } : {})');
    expect(core).not.toContain('this.applyOldContentPlan');
    expect(core).not.toContain('async applyOldContentPlan');
    expect(app).not.toContain('old-content-confirm');
  });

  it('app.js 委托层读取目标单选并处理合并/保留/重试', () => {
    expect(app).toContain("case 'related-resolve-merge': await A.resolveRelatedFormation(id, 'merge', readRelatedTarget(el));");
    expect(app).toContain("case 'related-resolve-keep': await A.resolveRelatedFormation(id, 'keep');");
    expect(app).toContain("case 'related-resolve-retry': await A.resolveRelatedFormation(id, 'merge');");
    expect(app).toContain("querySelector('[data-related-target]')");
    for (const act of ['related-resolve-merge', 'related-resolve-keep', 'related-resolve-retry']) {
      expect(app).toContain(`'${act}'`);
    }
  });
});
