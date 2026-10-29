import { describe, expect, it } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';
import { nightlyFormation } from './helpers/nightly-candidate';

const candidate = (id: string, summary: string) => ({ ...nightlyFormation(), id, summary, judgment: summary,
  suggestedType: 'cognition', suggestedScope: 'general', status: 'pending_review',
  capabilities: { countsAsPending: true, needsUserAction: true, canPromote: true, canEdit: true, canReject: true } });
const receipt = { runId: 'run-1', candidateIds: ['in-run'], findingKeys: ['duplicate:a:b'], captureIds: [], items: [] };

describe('本轮处理结果', () => {
  it('本轮只展示回执关联的候选和巡检发现，不按创建时间包含其他建议', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('in-run', '本轮会议要求'), candidate('other', '其他对话要求')],
      inbox: [{ id: 'inspection:duplicate:a:b', kind: 'inspection_finding', title: '本轮重复', assetIds: ['a', 'b'] },
        { id: 'inspection:duplicate:c:d', kind: 'inspection_finding', title: '其他重复', assetIds: ['c', 'd'] }],
      captureStats: { sweep: { receipt } } }, { name: 'activity', activityRunId: 'run-1' });
    const html = loaded.render();
    expect(html).toContain('本轮会议要求');
    expect(html).toContain('本轮重复');
    expect(html).not.toContain('其他对话要求');
    expect(html).not.toContain('其他重复');
    expect(html).toContain('查看全部建议');
  });
  it('空回执和旧轮次失配都不回退到全部建议', () => {
    for (const runId of ['run-1', 'older']) {
      const loaded = loadCognitionAssets({ candidates: [candidate('other', '不属于本轮')],
        captureStats: { sweep: { receipt: { ...receipt, candidateIds: [], findingKeys: [] } } } },
      { name: 'activity', activityRunId: runId });
      const html = loaded.render();
      expect(html).not.toContain('不属于本轮');
      expect(html).toContain(runId === 'older' ? '本轮记录暂不可用' : '本轮没有此类建议');
    }
  });
  it('设置页展示部分完成、单项原因和续做方式，不将进入处理数说成建议数', () => {
    const loaded = loadCognitionAssets({ captureSettings: { enabled: true }, assets: [{ id: 'a', title: '旧会议要求' }, { id: 'b', title: '未查的要求' }, { id: 'c', title: '不可读取的要求' }],
      captures: [{ id: 'failed-1', conversationTitle: '会议讨论' }],
      captureStats: { sweep: { phase: 'partial_complete', discovery: { ranges: 3, queued: 2 },
        lastResult: { scanned: 3, queued: 2, failed: 1 }, inspection: { error: 'inspection_baseline_stale', coverage: { total: 10, evaluated: 4, remaining: 6, unavailable: 1 },
          coveredAssetIds: ['a'], evaluatedAssetIds: ['a'], pendingAssetIds: ['b', 'c'], unavailableAssetIds: ['c'] },
        stock: { total: 1, checked: 0, proposed: 0, saved: 0, noChange: 0, insufficient: 0, failed: 1, remaining: 1,
          items: { 'asset-a': { status: 'failed', errorCode: 'stock_model_unavailable' } } },
        receipt: { ...receipt, items: [{ captureId: 'failed-1', status: 'failed', errorCode: 'invalid_model_output' },
          { captureId: 'ok', status: 'completed' }, { captureId: 'later', status: 'pending' }] } } } }, { name: 'settings' });
    const html = loaded.render();
    for (const text of ['部分完成', '完成 1，失败 1，待处理 1', '会议讨论', '模型结果无法识别', '立即扫描', '检查期间内容发生变化', '累计检查 4/10 条', '剩余 6 条', '其中 1 条不可读取', '旧会议要求', '未查的要求', '累计已检查', '本次检查', '尚未检查', '未显示名称', '模型连接失败', '2 段进入处理', '查看本轮建议', '查看全部建议']) expect(html).toContain(text);
    expect(html).not.toContain('不可读取的要求');
    expect(html).not.toContain('生成 2 条建议');
  });
  it('实际路由在选择、切换视图、筛选、翻页与搜索后保留本轮范围', async () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('in-run', '本轮会议要求'), candidate('other', '其他对话要求')],
      captureStats: { sweep: { receipt } } }, { name: 'activity', activityRunId: 'run-1' }, { setTimeout, clearTimeout });
    loaded.render();
    const button = (act: string, id: string) => ({ dataset: { act, id }, disabled: false, getAttribute: () => null });
    for (const [act, id] of [['activity-select', 'candidate:in-run'], ['activity-tab', 'done'], ['activity-tab', 'attention'],
      ['activity-filter', 'add'], ['activity-page-select', '1'], ['activity-clear', '']]) {
      await loaded.ns.activityController.handleClick(button(act, id));
      expect(loaded.store.route.activityRunId).toBe('run-1');
    }
    loaded.ns.activityController.handleInput({ target: { id: 'ca-activity-query', value: '会议', selectionStart: 2 }, isComposing: false });
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(loaded.store.route.activityRunId).toBe('run-1');
    expect(loaded.store.route.activityQuery).toBe('会议');
    expect(loaded.render()).not.toContain('其他对话要求');
  });
  it.each([
    ['summary_output_invalid', '对话摘要未通过检查'],
    ['summary_budget_exhausted', '对话摘要过长'],
    ['extraction_context_too_large', '对话内容过长'],
    ['candidate_save_failed', '建议未能保存'],
    ['formation_baseline_unavailable', '相关认知或版本不可读取'],
    ['related_assets_overflow', '关联认知超过当前处理上限'],
  ])('失败原因 %s 显示对应说明和处理方式', (errorCode, message) => {
    const loaded = loadCognitionAssets({ captureSettings: { enabled: true }, captureStats: { sweep: {
      phase: 'partial_complete', reconcile: { error: 'reconcile_failed' }, lastResult: { failed: 1 },
      receipt: { ...receipt, items: [{ captureId: 'failure', status: 'failed', errorCode }] },
    } } }, { name: 'settings' });
    const html = loaded.render();
    expect(html).toContain(message);
    expect(html).toContain('结果汇总未完成');
    expect(html).toContain('点击“立即扫描”继续');
  });
  it('单场对话部分完成时保留已形成建议，并逐项说明失败原因', () => {
    const partial = { captureId: 'partial-1', status: 'partial', candidateIds: ['in-run'], failures: [
      { candidateIndex: 0, stage: 'grounding', reason: 'related_assets_overflow' },
      { candidateIndex: 2, stage: 'uncertainty', reason: 'uncertainty_model_unavailable' },
    ] };
    const loaded = loadCognitionAssets({ captureSettings: { enabled: true }, candidates: [candidate('in-run', '已保留的建议')],
      captures: [{ id: 'partial-1', conversationTitle: '会议记录' }], captureStats: { sweep: { phase: 'partial_complete',
        receipt: { ...receipt, items: [partial] }, lastResult: { failed: 1 } } } }, { name: 'settings' });
    const html = loaded.render();
    for (const text of ['部分完成 1', '会议记录：部分完成', '已保留 1 条建议', '第 1 项 · 依据核对', '关联认知超过当前处理上限', '第 3 项 · 不确定内容核对', '模型暂不可用', '点击“立即扫描”继续']) expect(html).toContain(text);
    loaded.ns.router.go({ name: 'activity', activityRunId: 'run-1' });
    expect(loaded.render()).toContain('已保留的建议');
  });
  it('关联旧内容需要核对时显示版本，不回显未经当前权限核对的旧片段', () => {
    const related = candidate('in-run', '会议要求');
    (related as any).formationComparison = { relation: 'ambiguous', reason: '相关内容需核对', relatedAssets: [
      { assetId: 'a', version: '2', quote: '不得显示的旧正文一' },
      { assetId: 'b', version: '4', quote: '不得显示的旧正文二' },
    ] };
    const loaded = loadCognitionAssets({ assets: [{ id: 'a', title: '会议规则', status: 'active' }], candidates: [related] },
      { name: 'activity', candidateId: 'in-run' });
    const html = loaded.render();
    for (const text of ['这条建议涉及多条已有内容', '合并由你决定', '会议规则', '判断时使用 v2', '判断时使用 v4', '当前无法核对']) expect(html).toContain(text);
    expect(html).not.toContain('不得显示的旧正文');
    loaded.store.assetsError = 'failed';
    const failed = loaded.render();
    expect(failed).not.toContain('会议规则');
    expect(failed).not.toContain('不得显示的旧正文');
  });
});

it('只把确认缺失的来源显示为缺失，不展示旧摘录或操作入口', () => {
  const ref = { kind: 'conversation', id: 'source-a', title: '讨论', locator: { conversationId: 'chat-a', messageId: 'msg-a' } };
  const key = 'asset:asset-a';
  const loaded = loadCognitionAssets({ reviewEvidence: { [key]: { loaded: true, items: [{ ref, state: 'missing', excerpt: '不应显示旧内容' }] } } }, { name: 'overview' });
  const missing = loaded.ui.cognitionSources([ref], key, { fold: true });
  expect(missing).toContain('来源缺失，等待补充资料');
  expect(missing).not.toContain('不应显示旧内容');
  expect(missing).not.toContain('data-act="open-review-source"');
  const asset = { id: 'asset-a', type: 'cognition', status: 'active', scope: 'general', version: '1',
    activeVersion: '1', title: '检查要求', statement: '保留记录。', evidenceRefs: [ref] };
  loaded.store.assets = [asset];
  expect(loaded.ns.renderLibraryAssetDetail(asset)).toContain('来源缺失，等待补充资料');
  expect(loaded.ns.renderLibraryDialog('sources', asset.id)).toContain('来源缺失，等待补充资料');
  for (const state of ['unavailable', 'read_failed', 'changed']) {
    loaded.store.reviewEvidence[key].items[0].state = state;
    expect(loaded.ui.cognitionSources([ref], key, { fold: true })).not.toContain('来源缺失');
  }
});

it('历史详情的部分完成保留已保存资产，并给出继续处理入口', () => {
  const record = { id: 'capture-partial', conversationId: 'chat-a', conversationTitle: '会议', status: 'review_ready',
    displayStatus: 'partial', displayReason: 'partial_support', candidateIds: ['in-run'],
    candidateOutcomes: [{ ...candidate('in-run', '已保留的建议'), status: 'confirmed' }],
    confirmedAssetReceipts: [{ assetId: 'asset-a', assetType: 'rule', version: '1' }],
    reviewSummary: { total: 1, promoted: 1, pending: 0, rejected: 0 }, createdAt: '2026-10-27T08:00:00Z' };
  const loaded = loadCognitionAssets({ captures: [record], assets: [{ id: 'asset-a', title: '已保存的规则', statement: '需要检查。' }] },
    { name: 'activity', captureId: 'capture-partial' });
  const html = loaded.render();
  for (const text of ['部分完成', '部分建议已保留', '已保存的规则', 'data-act="open-asset"', '前往资产设置继续']) expect(html).toContain(text);
  expect(html).not.toContain('没有发现值得留存的内容');
  expect(html).not.toContain('已完成 · 已保存');
});
