import { describe, expect, it } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';

const candidate = (id: string, extra: Record<string, unknown> = {}) => ({
  id, summary: `长期建议 ${id}`, judgment: `稳定正文 ${id}`, suggestedType: 'template',
  suggestedScope: 'general', suggestedAction: 'create', status: 'pending_review',
  createdAt: '2026-10-12T01:00:00Z', value: '可用于后续任务',
  sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'source-a' }],
  captureProvenance: { pipeline: 'nightly_conversation', captureId: 'capture-a', messageIds: ['message-a'],
    extractionCompletedAt: '2026-10-12T01:00:00Z', valueJudgment: { eligible: true, reason: '可重复使用', judgedAt: '2026-10-12T00:59:00Z', evidence: [{ messageId: 'message-a', sourceId: 'source-a', quote: '这是真实来源原文' }] } },
  capabilities: { countsAsPending: true, needsUserAction: true, canEdit: true, canPromote: true, canReject: true }, ...extra,
});

describe('系统活动真实需要关注合同', () => {
  it('已稍后处理仍可搜索找回，终态及陈旧治理镜像退出关注', () => {
    const loaded = loadCognitionAssets({
      candidates: [candidate('later', { status: 'deferred', capabilities: { countsAsPending: true, needsUserAction: true, isSnoozed: true, canEdit: true, canReject: true } }),
        ...['confirmed', 'integrated', 'rejected', 'ignored', 'expired', 'superseded'].map(status => candidate(status, { status }))],
      inbox: [{ id: 'stale', kind: 'classification_conflict', candidateId: 'confirmed', actions: ['claim'] }],
    }, { name: 'activity', activityQuery: '稍后' });
    const html = loaded.render();
    expect(loaded.ns.activityModel().attention.map((row: any) => row.key)).toEqual(['candidate:later']);
    expect(loaded.ns.activityModel().done).toHaveLength(6);
    expect(loaded.store.activityRows).toHaveLength(1);
    expect(html).toContain('长期建议 later');
    expect(html).toContain('稍后 · 待处理');
  });

  it('仅完整形成且证据真实可追溯的具体建议入列，旧记录和质量阻断保持可追溯', () => {
    const invalid = [
      candidate('legacy', { captureProvenance: undefined }),
      candidate('weak', { capabilities: { countsAsPending: true, displayState: 'weak_evidence' } }),
      candidate('blocked', { capabilities: { countsAsPending: true, eligibility: 'ineligible', ineligibleReasons: ['rule_boundary_required'] } }),
      candidate('observed', { status: 'weak_observation' }),
      candidate('missing-body', { judgment: '' }), candidate('missing-value', { value: '' }),
      candidate('missing-scope', { suggestedScope: '' }), candidate('structure', { suggestedType: 'ontology' }),
      candidate('partial-ontology', { ontologyHandoff: { status: 'in_progress' } }),
      candidate('broken', { sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'source-a', excerpt: '真实原文', degraded: true }] }),
      candidate('unmatched', { sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'different', excerpt: '真实原文' }] }),
      candidate('unfinished', { captureProvenance: { pipeline: 'nightly_conversation' } }),
    ];
    const loaded = loadCognitionAssets({ candidates: [candidate('ready'), ...invalid],
      inbox: [{ id: 'orphan', kind: 'classification_conflict', title: '孤立治理问题' }],
      poCandidates: [{ candidate_id: 'old', summary: '旧内容' }],
    }, { name: 'activity', candidateId: 'ready' });
    const html = loaded.render();
    expect(loaded.ns.activityModel().attention.map((row: any) => row.key)).toEqual(['candidate:ready']);
    expect(loaded.store.candidates).toHaveLength(13);
    expect(html).toContain('data-act="activity-edit"');
    expect(html).not.toContain('data-act="cand-organize-ontology"');
    loaded.store.route.candidateId = 'legacy';
    const legacy = loaded.render();
    expect(legacy).toContain('稳定正文 legacy');
    expect(legacy).not.toContain('data-act="activity-defer"');
    expect(legacy).not.toContain('data-act="cand-adopt-with-form"');
  });

  it('metadata-only来源可与多条价值证据相交，错误类型和范围不能冒充消息证据', () => {
    const proof = { pipeline: 'nightly_conversation', captureId: 'capture-a', messageIds: ['message-a', 'message-b'], extractionCompletedAt: '2026-10-12T01:00:00Z',
      valueJudgment: { eligible: true, reason: '两条持久规则', judgedAt: '2026-10-12T00:59:00Z', evidence: [{ messageId: 'message-a', sourceId: 'source-a', quote: '这是真实来源原文一' }, { messageId: 'message-b', sourceId: 'source-b', quote: '这是真实来源原文二' }] } };
    const loaded = loadCognitionAssets({ candidates: [
      candidate('first', { captureProvenance: proof }),
      candidate('second', { captureProvenance: proof, sourceRefs: [{ kind: 'conversation', subtype: 'message', id: 'source-b' }] }),
      candidate('unmatched', { captureProvenance: proof, sourceRefs: [] }),
      candidate('outside', { captureProvenance: { ...proof, messageIds: ['message-a'] } }),
      candidate('wrong-kind', { captureProvenance: proof, sourceRefs: [{ kind: 'artifact_file', subtype: 'artifact', id: 'source-a' }] }),
      candidate('wrong-subtype', { captureProvenance: proof, sourceRefs: [{ kind: 'conversation', subtype: 'session', id: 'source-a' }] }),
      candidate('malformed-quote', { captureProvenance: { ...proof, valueJudgment: { ...proof.valueJudgment, evidence: [{ messageId: 'message-a', sourceId: 'source-a', quote: '   ' }] } } }),
    ] }, { name: 'activity' });
    expect(loaded.ns.activityModel().attention.map((row: any) => row.key)).toEqual(['candidate:first', 'candidate:second']);
  });

  it('短而完整的来源原句不会被六字下限挡在需要关注之外', () => {
    const ready = candidate('short');
    ready.captureProvenance.valueJudgment.evidence[0].quote = '默认中文';
    const loaded = loadCognitionAssets({ candidates: [ready] }, { name: 'activity' });
    expect(loaded.ns.activityModel().attention.map((row: any) => row.key)).toEqual(['candidate:short']);
  });

  it('完整建议的用户保存失败仍保留同一决定，恢复确认后只进入已处理', () => {
    for (const failureCode of ['asset_write_failed', 'decision_write_failed']) {
      const formed = candidate('formed');
      const loaded = loadCognitionAssets({ candidates: [formed] }, { name: 'activity', candidateId: formed.id });
      expect(loaded.ns.activityModel().attention).toHaveLength(1);
      loaded.store.candidates[0] = { ...formed, status: 'failed', failureCode,
        capabilities: { ...formed.capabilities, displayState: 'failed', canRetry: true } };
      const html = loaded.render();
      expect(loaded.ns.activityModel().attention.map((row: any) => row.key)).toEqual(['candidate:formed']);
      expect(html).toContain('保存结果待核对');
      for (const act of ['cand-adopt-with-form', 'activity-edit', 'cand-decide', 'activity-defer']) expect(html).toContain(`data-act="${act}"`);
      expect(html).not.toContain('失败待重试');
      expect(html).not.toContain('data-act="capture-retry"');
      loaded.store.candidates[0] = { ...formed, status: 'confirmed', promotedAssetId: 'saved-asset' };
      expect(loaded.ns.activityModel().attention).toHaveLength(0);
      expect(loaded.ns.activityModel().done.map((row: any) => row.key)).toEqual(['candidate:formed']);
    }
  });

  it('发现和提取失败、无形成证明或其他失败码始终不进入需要关注', () => {
    const loaded = loadCognitionAssets({ candidates: [
      ...['model_failed', 'value_judgment_failed', 'candidate_save_failed', 'capture_failed'].map(failureCode => candidate(failureCode, { status: 'failed', failureCode })),
      candidate('no-proof', { status: 'failed', failureCode: 'asset_write_failed', captureProvenance: undefined }),
      candidate('unfinished', { status: 'failed', failureCode: 'decision_write_failed', captureProvenance: { pipeline: 'nightly_conversation' } }),
    ] }, { name: 'activity' });
    expect(loaded.ns.activityModel().attention).toHaveLength(0);
    expect(loaded.render()).toContain('需要关注 0');
    expect(loaded.ns.candidate).not.toHaveProperty('sourceIssuesSection');
    expect(loaded.ns.candidate).not.toHaveProperty('taskFailedSection');
  });

  it('后台整理任务、失败、配置、暂停和队列均不成为用户认知决定', () => {
    const captures = ['queued', 'running', 'waiting_idle', 'no_candidate', 'completed', 'review_ready', 'failed', 'configuration_required', 'waiting_manual', 'paused', 'cancelled', 'extracting'].map(status => ({ id: status, status, actions: ['retry', 'run_now', 'resume'], conversationTitle: `任务 ${status}` }));
    const loaded = loadCognitionAssets({ captures }, { name: 'activity' });
    const html = loaded.render();
    expect(loaded.ns.activityModel().attention).toHaveLength(0);
    expect(loaded.store.captures).toHaveLength(12);
    expect(html).toContain('需要关注 0');
    expect(html).not.toContain('查看整理详情');
  });

  for (const error of ['candidatesError', 'inboxError']) {
    it(`${error} 读取失败不能显示正常零待办或正常空态，恢复后才显示计数`, () => {
      const loaded = loadCognitionAssets({ [error]: 'unavailable' }, { name: 'activity' });
      const failed = loaded.render();
      expect(failed).toContain('待核对');
      expect(failed).toContain('清单没能读取');
      expect(failed).not.toContain('当前没有需要关注的建议');
      expect(failed).not.toContain('需要关注 0');
      loaded.store[error] = '';
      const recovered = loaded.render();
      expect(recovered).toContain('当前没有需要关注的建议');
      expect(recovered).toContain('需要关注 0');
    });
  }

  it('后台任务与旧池读取失败不污染具体建议的正常空态', () => {
    const loaded = loadCognitionAssets({ poCandidatesError: 'unavailable', capturesError: 'unavailable' }, { name: 'activity' });
    expect(loaded.render()).toContain('需要关注 0');
    expect(loaded.render()).toContain('当前没有需要关注的建议');
  });

  it('已保存只根据处理记录显示结果，缺资产结果时如实提示并保持只读', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate('saved', { status: 'confirmed', suggestedAction: 'pause' })] }, { name: 'activity', activityView: 'done', candidateId: 'saved' });
    const html = loaded.render();
    expect(html).toContain('保存结果待核对');
    expect(html).toContain('没有提供可定位的资产结果');
    expect(html).not.toContain('已停用');
    expect(html).not.toContain('data-act="cand-adopt-with-form"');
    loaded.store.candidates[0].promotedAssetId = 'saved-asset';
    expect(loaded.render()).toContain('data-act="go-inbox-asset"');
  });
});
