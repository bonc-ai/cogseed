import { describe, expect, it } from 'vitest';
import { renderCognition, loadCognitionAssets } from './helpers/cognition-renderer';
import { getRecallCandidateCapabilities, projectReviewQueueCandidates } from '../../src/main/features/recall/candidate-capabilities';
const candidate = (id: string, status = 'pending_review') => ({ id, status, judgment: '以后方案比较优先使用表格。', value: '便于反复比较方案差异。', summary: '方案比较格式', suggestedScope: '方案比较', suggestedType: 'personal', suggestedAction: 'create', captureProvenance: { pipeline: 'nightly_conversation', captureId: 'capture-a', messageIds: ['message-a'], extractionCompletedAt: '2026-10-12T01:00:00Z', valueJudgment: { eligible: true, reason: '可重复使用', judgedAt: '2026-10-12T00:59:00Z', evidence: [{ messageId: 'message-a', sourceId: 'source-a', quote: '这是真实来源原文' }] } }, sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'source-a', excerpt: '真实原文' }], capabilities: getRecallCandidateCapabilities({ status: status as never }), updatedAt: '2026-10-08T01:00:00Z' });
describe('认知收敛后的单一治理入口', () => {
  it('五个入口；旧待处理深链进入系统活动并保留建议身份', () => {
    const { ns } = loadCognitionAssets();
    expect(ns.TABS.map((tab: { id: string }) => tab.id)).toEqual(['tree', 'overview', 'ontology', 'activity', 'settings']);
    ns.router.go({ name: 'review', candidateId: 'c1' });
    expect(ns.store.route).toMatchObject({ name: 'activity', candidateId: 'c1' });
  });
  it('我的认知使用新目录工作台，默认在库只含启用和暂停，授权范围显示真实目录名称', () => {
    const asset = { id: 'asset-active', type: 'rule', title: '交付核对规则', statement: '交付前核对真实来源与适用范围。', status: 'active', scope: 'review', version: '1', scopePolicy: { workspaceIds: ['space-private'] } };
    const { ns, render } = loadCognitionAssets({
      assets: [asset, { ...asset, id: 'asset-paused', status: 'paused' }, { ...asset, id: 'asset-archived', status: 'archived' }, { ...asset, id: 'asset-deleted', status: 'deleted' }],
      assetScopeOptions: { status: 'ready', spaces: [{ space_id: 'space-private', name: '个人核对空间' }], agents: [] },
    });
    const html = render();
    expect(html).toContain('ca-library-page');
    expect(html).toContain('ca-library-table');
    expect(html).toContain('个人核对空间');
    expect(html).not.toContain('data-act="overview-manage-toggle"');
    expect(html).not.toContain('data-act="filter-cat"');
    expect(ns.library.filtered().map((entry: { id: string }) => entry.id)).toEqual(['asset-active', 'asset-paused']);
    ns.library.state.status = 'all';
    expect(ns.library.filtered()).toHaveLength(4);
  });

  it('普通聊天和后台队列不成为需要关注，重复候选治理行只显示一次', () => {
    const html = renderCognition({ name: 'activity' }, { candidates: [candidate('c1')], inbox: [{ id: 'candidate:c1', kind: 'candidate_pending_review', candidateId: 'c1', title: '不应重复' }], captures: [{ id: 'low', conversationTitle: '无营养闲聊', status: 'queued' }], sources: [{ title: '全部聊天历史' }] });
    expect(html).toContain('方案比较格式');
    expect(html).not.toContain('不应重复');
    expect(html).not.toContain('无营养闲聊');
    expect(html).not.toContain('全部聊天历史');
  });
  it('已保存或拒绝的建议移入已处理，列表不直接放确认按钮', () => {
    const records = [candidate('c1'), { ...candidate('c2', 'confirmed'), promotedAssetId: 'asset-c2' }, candidate('c3', 'rejected')];
    expect(renderCognition({ name: 'activity' }, { candidates: records })).not.toContain('data-act="candidate-promote"');
    const done = renderCognition({ name: 'activity', activityView: 'done', candidateId: 'c2' }, { candidates: records });
    expect(done).toContain('已保存');
    expect(done).toContain('已拒绝');
    expect(done).toContain('data-act="go-inbox-asset"');
    const { ns } = loadCognitionAssets({ candidates: records });
    expect(ns.activityModel().attention.map((row: any) => row.key)).toEqual(['candidate:c1']);
    expect(ns.activityModel().done).toHaveLength(2);
    expect(done).toContain('data-act="activity-select"');
    expect(done).toContain('ca-activity-detail');
  });
  it('读取失败的建议详情给出重试，不伪装成记录不存在', () => {
    const html = renderCognition({ name: 'activity', candidateId: 'c1' }, { candidatesError: 'offline', candidates: [] });
    expect(html).toContain('data-act="refresh"');
    expect(html).toContain('部分变化未能读取，请重试');
    expect(html).not.toContain('这条建议已不在');
  });
  it('设置保留夜间发现主线，确认规则默认人工且能力未读到时禁用自动确认', () => {
    const html = renderCognition({ name: 'settings' }, { captureSettings: { enabled: true, executionPolicy: 'nightly' }, captureModel: { configured: true } });
    expect(html).toContain('夜间发现');
    expect(html).toMatch(/aria-checked="false"[^>]*disabled[^>]*data-act="auto-approval-toggle"/);
    expect(html).toContain('完整建议进入');
    expect(html).toContain('data-act="nightly-toggle"');
    expect(html).not.toContain('data-act="nightly-time"');
    expect(html).not.toContain('KSTAR');
    expect(html).not.toContain('定期检查');
  });
  it('活动历史投影不沿用旧待处理队列的五条历史截断', () => {
    const records = Array.from({ length: 12 }, (_, index) => candidate('done-'+index, 'confirmed'));
    expect(projectReviewQueueCandidates(records)).toHaveLength(5);
    expect(projectReviewQueueCandidates(records, true)).toHaveLength(12);
  });
  it('标题和说明分层、搜索框可读，范围与决策使用用户语言', () => {
    const html = renderCognition({ name: 'activity', candidateId: 'c1' }, { candidates: [{ ...candidate('c1'), suggestedScope: 'general' }] });
    expect(html).toContain('<strong>方案比较格式</strong>');
    expect(html).toContain('<p>以后方案比较优先使用表格。</p>');
    expect(html).toContain('placeholder="搜索标题、摘要或适用范围"');
    expect(html).toContain('跨任务通用');
    expect(html).toContain('保存');
    expect(html).toContain('<h2>方案比较格式</h2>');
    expect(html).toContain('ca-activity-detail-footer');
  });
  it('临时记录退出待办，重复建议合并且计数与顶部一致，孤立治理不入列', () => {
    const { ns } = loadCognitionAssets({ candidates: [candidate('c1'), candidate('c2'), { ...candidate('test'), activityExclusionReason: 'task_local' }], inbox: [{ id: 'test-inbox', kind: 'candidate_pending_review', candidateId: 'test' }, { id: 'conflict', kind: 'type_conflict', title: '需要判断类型' }] });
    const model = ns.activityModel();
    expect(model.attention).toHaveLength(1);
    expect(model.attention[0].candidateIds).toHaveLength(2);
    expect(ns.stats().pending).toBe(model.attention.length);
    expect(ns.viewActivity({ name: 'activity', candidateId: 'c1' })).toContain('相同建议已在列表合并');
    expect(ns.viewActivity({ name: 'activity' })).not.toContain('data-id="candidate:test"');
  });
  it('不同适用范围或版本的建议不合并；已处理不铺开对象保存日志', () => {
    const { ns } = loadCognitionAssets({ candidates: [candidate('c1'), { ...candidate('c2'), suggestedScope: 'report' }, { ...candidate('c3'), targetVersionUsed: 'v2' }], ontologySnapshot: { history: [{ recordedAt: '2026-10-09', after: { id: 'test', name: '验收身份副本', version: 2, kind: 'entity' } }], records: {} } });
    expect(ns.activityModel().attention).toHaveLength(3);
    expect(ns.viewActivity({ name: 'activity', activityView: 'done' })).not.toContain('验收身份副本');
  });
  it('同一次决定合并结果、不同决定分别保留，空搜索不伪装成没有活动', () => {
    const records = [{ ...candidate('c1', 'confirmed'), reviewDecisionId: 'd1' }, { ...candidate('c2', 'confirmed'), reviewDecisionId: 'd1' }, { ...candidate('c3', 'confirmed'), reviewDecisionId: 'd2' }];
    const { ns } = loadCognitionAssets({ candidates: records });
    expect(ns.activityModel().done).toHaveLength(2);
    expect(ns.viewActivity({ name: 'activity', activityView: 'done', activityQuery: '不存在的词' })).toContain('没有匹配的变化');
  });

  it('治理镜像不独立入列，完整稍后建议仍可找回且只出现一次', () => {
    const { ns } = loadCognitionAssets({ candidates: [candidate('c1'), { ...candidate('snoozed'), capabilities: { countsAsPending: true, isSnoozed: true } }], inbox: [{ id: 'conflict1', kind: 'type_conflict', candidateId: 'c1' }, { id: 'conflict2', kind: 'version_conflict', candidateId: 'c1' }] });
    const rows = ns.activityModel().attention;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row: any) => row.route.inboxId).map((row: any) => row.route.inboxId)).toEqual([]);
    const later = rows.filter((row: any) => row.candidateIds.includes('snoozed'));
    expect(later).toHaveLength(1);
    expect(later[0].route).toEqual({ candidateId: 'snoozed' });
    expect(later[0].result).toContain('稍后');
    expect(ns.stats().pending).toBe(rows.length);
  });

});
