import { describe, expect, it, vi } from 'vitest';
import { loadCognitionAssets } from './helpers/cognition-renderer';
import { nightlyFormation } from './helpers/nightly-candidate';

const module = { id: 'module-private-id', kind: 'module', name: '沟通偏好', scope: { kind: 'personal' } };
const before = { id: 'rule-private-id', kind: 'rule', moduleId: module.id, version: 2, status: 'active', access: 'task', certainty: 'confirmed', name: '复杂问题表达', requirement: '先给结论，再讲原因', strength: 'default', condition: { kind: 'task', field: 'purpose', equals: '解释复杂问题' }, effect: { kind: 'note' }, exception: '', source: { label: '表达偏好原始讨论' } };
const after = { ...before, version: 3, requirement: '排查故障时先告诉我查到了什么证据', condition: { kind: 'task', field: 'purpose', equals: '排查故障' }, exception: '紧急行动先给安全步骤', source: { label: '后续纠正讨论' } };
const plan = { schemaVersion: 1, candidateId: 'cognition-proposal', baselineRevision: 5, commandId: 'command-private-id', actions: [], refs: [], requiresTReview: false, blockedReasons: [], reason: '同一偏好在排查场景补充边界', evidence: ['故障排查先告诉我证据'], effectiveFrom: '2026-10-14', previewChanges: [{ intent: 'update', recordId: before.id, box: 'R', before, after }] };
function candidate(patch: Record<string, unknown> = {}) {
  return { id: 'cognition-proposal', ...nightlyFormation(), summary: '排查故障的表达顺序', judgment: after.requirement, suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', status: 'pending_review', createdAt: '2026-10-14T00:00:00Z', capabilities: { countsAsPending: true, canEdit: true, canPromote: true, canReject: true }, ontologyFormation: plan, ...patch };
}
const snapshot = { records: { [module.id]: module, [before.id]: before } };

describe('认知与本体共同确认的真实详情', () => {
  it('同一个保存按钮前展示R原值、新值、版本、来源、适用边界与共同保存影响', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate()], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' });
    const html = loaded.render();
    for (const text of ['一起确认的本体变化', 'R · 规则与约束', '原 v2 → 新 v3', before.requirement, after.requirement, '排查故障', after.exception, '表达偏好原始讨论', '后续纠正讨论', plan.reason, plan.evidence[0], '2026-10-14', '不会只保存其中一半', '未接入自动执行']) expect(html).toContain(text);
    expect(html.indexOf('ca-review-formation')).toBeLessThan(html.indexOf('ca-review-impact'));
    expect(html.match(/data-act="cand-adopt-with-form"/g)).toHaveLength(1);
    for (const privateId of [before.id, plan.commandId, module.id]) expect(html).not.toContain(privateId);
  });
  it('具体情况展示对象名称与有效期间，原值引用采用变更前的名称', () => {
    const subject = { id: 'person-private-id', kind: 'entity', name: '示例人员甲' };
    const relation = { id: 'relation-private-id', kind: 'definition', name: '负责' };
    const project = { id: 'project-private-id', kind: 'entity', name: '项目甲' };
    const fact = { id: 'fact-private-id', kind: 'assertion', version: 1, status: 'active', access: 'owner_only', certainty: 'inferred', subjectId: subject.id, definitionId: relation.id, object: { kind: 'entity', id: project.id }, validity: { from: '2026-09-01', until: '2026-10-14', timezone: 'Asia/Shanghai' }, source: { label: '负责人讨论' } };
    const factPlan = { ...plan, previewChanges: [{ intent: 'change', recordId: fact.id, box: 'A', before: fact, after: { ...fact, version: 2, object: { kind: 'literal', value: '示例人员乙接手' }, validity: { ...fact.validity, from: '2026-10-14', until: null } } }] };
    const html = loadCognitionAssets({ candidates: [candidate({ ontologyFormation: factPlan })], ontologySnapshot: { records: { [subject.id]: subject, [relation.id]: relation, [project.id]: project } } }, { name: 'activity', candidateId: 'cognition-proposal' }).render();
    for (const text of ['A · 具体情况与依据', '示例人员甲', '负责', '项目甲', '示例人员乙接手', '2026-09-01', '未设结束日期', '仅本人查看', '推测']) expect(html).toContain(text);
    for (const privateId of [subject.id, relation.id, project.id, fact.id]) expect(html).not.toContain(privateId);
  });
  it('T变化可以人工确认；计划阻断时正式保存禁用并显示原因，不能凭旧能力绕过', () => {
    const tPlan = { ...plan, requiresTReview: true, previewChanges: [{ intent: 'create', box: 'T', after: { id: 'definition-private-id', kind: 'definition', name: '<负责人>', description: '<script>alert(1)</script>', version: 1, status: 'active', access: 'task', definitionKind: 'relation', valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject', subjectTypes: [], objectTypes: [], source: { label: '原文说明' } } }] };
    const loaded = loadCognitionAssets({ candidates: [candidate({ ontologyFormation: tPlan })], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' });
    let html = loaded.render();
    expect(html).toContain('必须由你人工确认');
    expect(html).toContain('&lt;负责人&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    loaded.store.candidates[0].ontologyFormation.blockedReasons = ['baseline_changed', 'uncertain_ontology:definition-private-id'];
    html = loaded.render();
    expect(html).toContain('需重核版本');
    expect(html).toContain('内容仍不确定，需要人工核对');
    expect(html).not.toContain('uncertain_ontology:definition-private-id');
    expect(html).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
  });
  it('正文相同但本体变化不同的建议不合并，已处理保留变化且只读', () => {
    const first = candidate();
    const second = candidate({ id: 'another', ontologyFormation: { ...plan, candidateId: 'another', commandId: 'another-command', previewChanges: [{ ...plan.previewChanges[0], after: { ...after, exception: '另一范围' } }] } });
    const loaded = loadCognitionAssets({ candidates: [first, second], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' });
    expect(loaded.ns.activityModel().attention).toHaveLength(2);
    loaded.store.candidates = [candidate({ status: 'confirmed', promotedAssetId: 'saved-asset', processingActor: '系统自动确认', processingReason: '依据完整且无冲突' })];
    loaded.store.route.activityView = 'done';
    const html = loaded.render();
    expect(html).toContain('本次关联本体的处理内容');
    expect(html).toContain('系统自动确认');
    expect(html).toContain(after.requirement);
    expect(html).not.toContain('data-act="cand-adopt-with-form"');
    expect(html).not.toContain('data-f="judgment"');
  });
  it('关联已有对象以名称打开本体，新对象保存前不提供假入口；工程审核码不作为正文上屏', () => {
    const refs = [{ moduleId: module.id, recordId: before.id, versionPolicy: 'current', sharedBody: true }, { moduleId: module.id, recordId: 'new-private-id', versionPolicy: 'pinned', targetVersion: 1 }];
    const newRecord = { ...after, id: 'new-private-id', name: '新增偏好', version: 1 };
    const loaded = loadCognitionAssets({ candidates: [candidate({ ontologyFormation: { ...plan, refs, previewChanges: [...plan.previewChanges, { box: 'R', intent: 'create', after: newRecord }] }, autoReview: { eligible: false, reasons: ['structure_requires_individual_review', '已发现明确冲突，需要核对原文'] } })], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' });
    const html = loaded.render();
    expect(html).toContain('与认知共用正文及有效版本');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*data-act="open-ontology"[^>]*data-record-id="rule-private-id"/);
    expect(html).toMatch(/disabled[^>]*data-act="open-ontology"[^>]*data-record-id="new-private-id"/);
    expect(html).not.toContain('structure_requires_individual_review');
    expect(html).toContain('已发现明确冲突，需要核对原文');
    loaded.store.candidates[0].status = 'confirmed';
    loaded.store.candidates[0].promotedAssetId = 'saved';
    loaded.store.route.activityView = 'done';
    expect(loaded.render()).not.toMatch(/disabled[^>]*data-act="open-ontology"[^>]*data-record-id="new-private-id"/);
  });
  it('独立原文核查原因用人话说明，隐藏工程码和私有坐标且仍可人工确认', () => {
    const reasons = ['candidate_semantic_support_failed:private-source-id', 'candidate_semantic_support_unavailable', 'candidate_semantic_support_changed:private-candidate-id'];
    const loaded = loadCognitionAssets({ candidates: [candidate({ autoReview: { eligible: false, reasons } })], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' });
    const html = loaded.render();
    expect(html).toContain('原文不足以支持整条认知或关联本体变化，请人工核对。');
    expect(html).toContain('暂未完成独立原文核查，请人工核对。');
    expect(html).toContain('核查期间原文、权限或候选发生变化，请重新核对。');
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*data-act="cand-adopt-with-form"/);
    for (const privateValue of ['candidate_semantic_support_', 'private-source-id', 'private-candidate-id']) expect(html).not.toContain(privateValue);
  });
  it('认知编辑后阻断原本体计划，说明旧内容未生效并提供重新核对入口', async () => {
    const original = candidate();
    const changed = candidate({ judgment: '新的用户修改', ontologyFormation: { ...plan, blockedReasons: ['candidate_edited_requires_ontology_review'] } });
    const invoke = vi.fn(async () => ({ ok: true, candidate: changed }));
    const loaded = loadCognitionAssets({ candidates: [original], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' }, { cogseed: { invoke } });
    await loaded.ns.actions.adoptCandidate(original.id, { judgment: '新的用户修改', suggestedScope: 'general' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('recall.candidates.update', expect.objectContaining({ judgment: '新的用户修改' }));
    const html = loaded.render();
    expect(html).toContain('关联本体建议仍基于旧内容');
    expect(html).toContain('新的用户修改');
    expect(html).toContain('data-act="formation-recheck"');
    expect(html).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    expect(html).not.toContain('candidate_edited_requires_ontology_review');
  });
  it('重新核对防重复调用并显示进度，成功替换整体前后差异，仍不正式保存', async () => {
    const original = candidate({ ontologyFormation: { ...plan, blockedReasons: ['candidate_edited_requires_ontology_review'] } });
    let complete!: (value: unknown) => void;
    const invoke = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const loaded = loadCognitionAssets({ candidates: [original], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' }, { cogseed: { invoke } });
    const pending = loaded.ns.actions.recheckCandidateFormation(original.id);
    await loaded.ns.actions.recheckCandidateFormation(original.id);
    expect(invoke).toHaveBeenCalledOnce();
    const running = loaded.render();
    expect(running).toContain('正在重新核对…');
    expect(running).not.toContain('data-f="judgment"');
    expect(running).toMatch(/disabled[^>]*data-act="formation-recheck"/);
    const replacement = { ...original, ontologyFormation: { ...plan, baselineRevision: 6, previewChanges: [{ ...plan.previewChanges[0], after: { ...after, requirement: '重新核对后的关联正文' } }] } };
    complete({ ok: true, candidate: replacement });
    await pending;
    const html = loaded.render();
    expect(html).toContain('重新核对后的关联正文');
    expect(html).toContain('请阅读更新后的整体差异');
    expect(html).not.toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    expect(loaded.store.candidates[0].status).toBe('pending_review');
    expect(invoke).toHaveBeenCalledWith('recall.candidates.recheckOntologyFormation', { candidateId: original.id });
  });
  it('重新核对失败与无效响应都保留完整原建议，错误可见且可重试', async () => {
    const original = candidate({ ontologyFormation: { ...plan, blockedReasons: ['baseline_changed'] } });
    const invoke = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, candidate: { ...original, id: 'wrong-candidate' } }).mockResolvedValueOnce({ ok: true, candidate: original });
    const loaded = loadCognitionAssets({ candidates: [original], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' }, { cogseed: { invoke } });
    for (let i = 0; i < 2; i++) {
      await loaded.ns.actions.recheckCandidateFormation(original.id);
      expect(loaded.store.candidates[0]).toBe(original);
      expect(loaded.render()).toContain('原建议和已保存修改仍保留，可重试');
      expect(loaded.render()).toContain(after.requirement);
    }
    await loaded.ns.actions.recheckCandidateFormation(original.id);
    expect(loaded.store.formationRechecks[original.id].error).toBe('');
  });
  it('未保存的界面草稿不丢弃或静默用于重核，终态记录无重核入口', async () => {
    const original = candidate();
    const invoke = vi.fn();
    const alert = vi.fn();
    const loaded = loadCognitionAssets({ candidates: [original], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' }, { cogseed: { invoke }, uiAlert: alert });
    loaded.render();
    const card = { dataset: { candId: original.id, candType: 'cognition' } };
    loaded.ns.activityController.handleInput({ target: { dataset: { f: 'judgment' }, value: '未保存草稿', closest: () => card } });
    await loaded.ns.activityController.handleClick({ dataset: { act: 'formation-recheck', id: original.id }, getAttribute: () => null });
    expect(invoke).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toContain('保存修改并校验');
    expect(loaded.render()).toContain('未保存草稿');
    loaded.store.candidates[0] = { ...original, status: 'confirmed', promotedAssetId: 'asset' };
    loaded.store.route.activityView = 'done';
    expect(loaded.render()).not.toContain('data-act="formation-recheck"');
    await loaded.ns.actions.recheckCandidateFormation(original.id);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('范围越界阻断以人话和对象名称说明，未知私有ID不作为正文展示', () => {
    const loaded = loadCognitionAssets({ candidates: [candidate({ ontologyFormation: { ...plan,
      blockedReasons: ['ontology_scope_exceeds_cognition:rule-private-id', 'ontology_scope_exceeds_cognition:unknown-private-id'] } })], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' });
    const html = loaded.render();
    expect(html).toContain('关联本体的可用范围超出了这条认知的范围');
    expect(html).toContain('需重新比较并保留来源限制');
    expect(html).toContain('复杂问题表达');
    for (const hidden of ['ontology_scope_exceeds_cognition', 'unknown-private-id', 'rule-private-id']) expect(html).not.toContain(hidden);
    expect(html).toMatch(/disabled[^>]*data-act="cand-adopt-with-form"/);
    expect(html).toContain('data-act="formation-recheck"');
  });
  it('来源摘要变化被拒后保留原建议，重核错误不暴露内部原因且普通保存失败也翻成人话', async () => {
    const original = candidate();
    const invoke = vi.fn().mockResolvedValue({ ok: false, code: 'source_digest_changed', error: 'capture formation source is unavailable' });
    const loaded = loadCognitionAssets({ candidates: [original], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' }, { cogseed: { invoke } });
    await loaded.ns.actions.recheckCandidateFormation(original.id);
    expect(loaded.store.candidates[0]).toBe(original);
    const html = loaded.render();
    expect(html).toContain('原建议和已保存修改仍保留，可重试');
    expect(html).not.toContain('source_digest_changed');
    expect(html).not.toContain('capture formation source is unavailable');
    const error = { code: 'source_digest_changed', error: 'capture formation source is unavailable' };
    expect(loaded.ns.recallErrorText(error)).toContain('本次没有正式保存');
    expect(loaded.ns.captureErrorText(new Error(error.error))).toContain('原文已变化或来源暂不可用');
    expect(invoke).toHaveBeenCalledOnce();
  });
});


describe('独立本体建议的同一审阅页面', () => {
  it('展示本体变更说明与正式保存出口，不要求认知分类或伪造认知资产', () => {
    const item = candidate({ proposalTarget: 'ontology', judgment: '项目负责人从下个月改为示例人员乙。' });
    const html = loadCognitionAssets({ candidates: [item], ontologySnapshot: snapshot }, { name: 'activity', candidateId: 'cognition-proposal' }).render();
    for (const text of ['拟保存内容', '修改前', '确认保存', '修改要求', '不新建“我的认知”条目', '本体记录']) expect(html).toContain(text);
    expect(html).not.toContain('data-f="contentCategory"');
    expect(html).not.toContain('拟新建正式资产');
    expect(html.match(/data-act="cand-adopt-with-form"/g)).toHaveLength(1);
  });
});
