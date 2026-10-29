import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/features/kb_indexer', () => ({ enqueue: () => {}, kbEvents: { on: () => {}, off: () => {}, emit: () => {} } }));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: () => {}, dropContext: () => {} }));
let root: string, previous: string | undefined;
const uid = 'formation-user', candidateId = 'candidate-one';
const at = '2026-10-14T00:00:00Z';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-formation-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create' as const, recordId, record, sourceLabel: '用户原文证据' });
async function setup() {
  const bridge = await import('../../../src/main/features/cognition_bridge');
  const kernel = await import('../../../src/main/features/cognition_kernel/store');
  const service = await import('../../../src/main/features/cognition/ontology/service');
  const formation = await import('../../../src/main/features/recall/ontology-formation');
  const store = await import('../../../src/main/features/recall/store');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  await service.commitOntologyCommand(uid, { commandId: 'seed', expectedRevision: 0, actions: [create('personal', { kind: 'module', name: '我的本体', description: '', scope: { kind: 'personal' } })] });
  return { bridge, kernel, service, formation, store };
}
const judgment = '复杂问题先说结论，再说明关键原因。';
const rule = (text = judgment) => ({ kind: 'rule', moduleId: 'personal', name: '复杂问题表达偏好', requirement: text, strength: 'default', condition: { kind: 'task', field: 'purpose', equals: 'complex_problem' }, effect: { kind: 'note' }, exception: '故障分析先列证据' });
const proposal = (text = judgment) => ({ reason: '用户说明跨对话表达偏好', evidence: ['m1'], actions: [create('expression-rule', rule(text))], refs: [{ moduleId: 'personal', recordId: 'expression-rule', versionPolicy: 'current', sharedBody: true }] });
function asset(id = 'asset-one', text = judgment) { return { schemaVersion: 2, ownerId: uid, id, candidateId, reviewDecisionId: 'rd_12345678', type: 'cognition', title: '复杂问题表达偏好', statement: text, evidenceRefs: [], origin: 'manual', status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud', scope: 'general', version: '1', createdAt: at, updatedAt: at }; }

describe('显式共享认知正文引用 envelope', () => {
  function referenced() {
    const raw = proposal();
    delete raw.actions[0].record.requirement;
    raw.actions[0].record.requirementSource = 'cognition_body';
    return raw;
  }
  it('解析完整正文一次，剥除模型selector并同组保存canonical规则和认知', async () => {
    const { formation, service, store } = await setup();
    const complete = judgment + '\n故障排查先给证据；信息不足时保留待核，不扩大到日常问候。';
    const raw = referenced();
    const original = structuredClone(raw);
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, complete)!;
    expect(plan.blockedReasons).toEqual([]);
    expect(raw).toEqual(original);
    expect(plan.actions[0]).toMatchObject({ record: { kind: 'rule', requirement: complete } });
    expect(JSON.stringify(plan)).not.toContain('requirementSource');
    expect(plan.previewChanges[0].after).toMatchObject({ requirement: complete });
    expect(formation.normalizeOntologyFormationPlan(uid, candidateId, plan)).toEqual(plan);
    await formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset('asset-one', complete)));
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ requirement: complete,
      source: { refs: [{ kind: 'asset', id: 'asset-one' }] } });
    expect(JSON.stringify(service.readOntologyDocument(uid))).not.toContain('requirementSource');
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'asset-one'))?.statement).toBe(complete);
  });
  it('更新仅绑定现有rule的真实模块和版本，同一正文和版本历史继续保存', async () => {
    const { formation, service, store } = await setup();
    const initial = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, referenced(), judgment)!;
    await formation.withOntologyFormationPromotion(uid, initial, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()));
    const complete = judgment + '故障分析先列证据；资料不足时说明待核问题。';
    const raw = { reason: '用户补充故障例外', evidence: ['m1'],
      refs: [{ moduleId: 'personal', recordId: 'expression-rule', versionPolicy: 'current', sharedBody: true }],
      actions: [{ intent: 'update', recordId: 'expression-rule', expectedVersion: 1, sourceLabel: '用户完整新偏好',
        patch: { requirementSource: 'cognition_body', exception: '故障分析先列证据' } }] };
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, complete)!;
    expect(plan.blockedReasons).toEqual([]);
    expect(plan.previewChanges[0]).toMatchObject({ before: { requirement: judgment, version: 1 }, after: { requirement: complete, version: 2 } });
    expect(plan.actions[0]).toMatchObject({ patch: { requirement: complete, exception: '故障分析先列证据' } });
    expect(JSON.stringify(plan)).not.toContain('requirementSource');
    await formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', current => ({ ...current!, statement: complete, version: '2' })));
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ requirement: complete, version: 2 });
    expect(service.readOntologyDocument(uid).history.filter(row => row.after.id === 'expression-rule')).toHaveLength(2);
    expect(formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId,
      { ...raw, actions: [{ ...raw.actions[0], expectedVersion: 999 }] }, complete + '新增边界。')!.blockedReasons).toContain('baseline_changed');
    for (const bad of [
      { ...raw, actions: [{ ...raw.actions[0], expectedVersion: 999 }] },
      { ...raw, refs: [{ ...raw.refs[0], moduleId: 'other-module' }] },
      { ...raw, refs: [{ ...raw.refs[0], recordId: 'other-rule' }] },
      { ...raw, refs: [{ ...raw.refs[0], recordId: 'personal' }], actions: [{ ...raw.actions[0], recordId: 'personal' }] },
      { ...raw, refs: [{ ...raw.refs[0], recordId: 'missing-rule' }], actions: [{ ...raw.actions[0], recordId: 'missing-rule' }] },
    ]) expect(formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, bad, complete + '新增边界。')!.blockedReasons.length).toBeGreaterThan(0);
  });
  it.each(['create', 'update'] as const)('同时提供冲突正文时%s保留shared_body_mismatch，不覆盖字面冲突', async intent => {
    const { formation, service } = await setup();
    if (intent === 'update') await service.commitOntologyCommand(uid, { commandId: 'existing-rule', expectedRevision: 1,
      actions: [create('expression-rule', rule())] });
    const raw = intent === 'create' ? referenced() : { reason: '用户补充偏好', evidence: ['m1'], refs: proposal().refs,
      actions: [{ intent: 'update', recordId: 'expression-rule', expectedVersion: 1, sourceLabel: '用户原文',
        patch: { requirementSource: 'cognition_body', requirement: '冲突的另一份正文' } }] };
    if (intent === 'create') (raw.actions[0] as ReturnType<typeof create>).record.requirement = '冲突的另一份正文';
    const before = structuredClone(raw);
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, judgment)!;
    expect(plan.blockedReasons).toContain('shared_body_mismatch');
    expect(raw).toEqual(before);
    expect(plan.previewChanges).toEqual([]);
  });
  it('允许同时给出完全相同的正文，但不把selector放进canonical或normalize存档', async () => {
    const { formation, service } = await setup();
    const raw = referenced(); raw.actions[0].record.requirement = judgment;
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, judgment)!;
    expect(plan.blockedReasons).toEqual([]);
    expect(plan.actions[0]).toMatchObject({ record: { requirement: judgment } });
    const forged = structuredClone(plan);
    if (forged.actions[0].intent === 'create') forged.actions[0].record.requirementSource = 'cognition_body';
    // Stored canonical plans never interpret an envelope selector again.
    await expect(formation.withOntologyFormationPromotion(uid, forged, 'user', async () => undefined)).rejects.toThrow();
  });
  it.each(['missing_marker', 'unknown_marker', 'empty_body', 'no_shared_ref', 'pinned_ref', 'different_target',
    'different_module', 'ambiguous_shared_ref', 'non_rule', 'missing_kind', 'missing_kind_with_literal', 'top_level_marker'])(
    '不根据缺失或歧义信息补正文：%s', async failure => {
      const { formation, service } = await setup();
      const raw: any = referenced();
      let body = judgment;
      if (failure === 'missing_marker') delete raw.actions[0].record.requirementSource;
      if (failure === 'unknown_marker') raw.actions[0].record.requirementSource = 'some_other_body';
      if (failure === 'empty_body') body = '   ';
      if (failure === 'no_shared_ref') delete raw.refs[0].sharedBody;
      if (failure === 'pinned_ref') Object.assign(raw.refs[0], { versionPolicy: 'pinned', targetVersion: 1 });
      if (failure === 'different_target') raw.refs[0].recordId = 'unrelated-rule';
      if (failure === 'different_module') raw.refs[0].moduleId = 'other-module';
      if (failure === 'ambiguous_shared_ref') raw.refs.push({ ...raw.refs[0], moduleId: 'other-module' });
      if (failure === 'non_rule') raw.actions[0].record.kind = 'assertion';
      if (failure === 'missing_kind') delete raw.actions[0].record.kind;
      if (failure === 'missing_kind_with_literal') { delete raw.actions[0].record.kind; raw.actions[0].record.requirement = judgment; }
      if (failure === 'top_level_marker') { delete raw.actions[0].record.requirementSource; raw.actions[0].requirementSource = 'cognition_body'; }
      const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, body)!;
      expect(plan.blockedReasons.length).toBeGreaterThan(0);
      expect(plan.previewChanges).toEqual([]);
      expect(service.readOntologyDocument(uid).records['expression-rule']).toBeUndefined();
    });
  it('不可借显式正文引用将已有其它认知的共享rule转绑到新认知', async () => {
    const { formation, service, store } = await setup();
    const initial = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, referenced(), judgment)!;
    await formation.withOntologyFormationPromotion(uid, initial, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()));
    const nextCandidate = 'different-candidate';
    const complete = judgment + '新增例外。';
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), nextCandidate, {
      reason: '另一对象的提案', evidence: ['m1'], refs: proposal().refs,
      actions: [{ intent: 'update', recordId: 'expression-rule', expectedVersion: 1, sourceLabel: '另一对象的原文', patch: { requirementSource: 'cognition_body' } }],
    }, complete)!;
    expect(plan.blockedReasons).toEqual([]); // The parser has no target asset; the joint commit has its identity.
    await expect(formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-two',
      { ...asset('asset-two', complete), candidateId: nextCandidate }))).rejects.toMatchObject({ code: 'shared_body_owner_conflict' });
    expect(await store.readRecallJsonRecord(uid, 'ability-assets', 'asset-two')).toBeUndefined();
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ requirement: judgment, version: 1 });
  });
});

describe('认知与本体同组形成', () => {
  it('真实夜间候选保存和确认接通依赖；最终候选身份重绑定并同时落本体', async () => {
    const { formation, service, bridge } = await setup();
    const { createNightlyCandidateFixture } = await import('../../helpers/nightly-formation-fixture');
    const candidates = await import('../../../src/main/features/recall/candidate-service');
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), 'temporary-candidate', proposal(), judgment)!;
    const candidate = await createNightlyCandidateFixture(uid, { judgment, summary: '结论与原因顺序', value: '后续复杂问题解释可依照用户的表达偏好组织结论与原因。', suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', risk: 'low', sourceRefs: [], ontologyFormation: plan });
    expect(candidate.ontologyFormation?.candidateId).toBe(candidate.id);
    const result = await candidates.promoteRecallCandidate(uid, candidate.id, { actor: 'user', forceCreateSimilar: true });
    expect(result.candidate.status).toBe('confirmed');
    expect(result.asset.ontologyRefs?.[0]).toMatchObject({ recordId: 'expression-rule', sharedBody: true });
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ requirement: result.asset.statement,
      source: { recordId: candidate.id, refs: [{ kind: 'asset', id: result.asset.id }] } });
    expect(bridge.cognitionCompatibility(uid)?.records.candidates[candidate.id].status).toBe('confirmed');
    const newText = '复杂问题先说结论，再说明关键原因；故障分析先列证据。';
    const updatePlan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), 'temporary-update', {
      reason: '用户补充故障分析的适用范围', evidence: ['m1'], actions: [{ intent: 'update', recordId: 'expression-rule', expectedVersion: 1,
        patch: { requirement: newText, exception: '故障分析先列证据' }, sourceLabel: '用户补充表达边界' }],
      refs: [{ moduleId: 'personal', recordId: 'expression-rule', versionPolicy: 'current', sharedBody: true }],
    }, newText)!;
    const updatedCandidate = await createNightlyCandidateFixture(uid, { judgment: newText, summary: '表达顺序与故障边界', value: '后续故障分析保留证据优先的边界，避免表达偏好误用。', suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'limit_scope', targetAssetId: result.asset.id, targetVersionUsed: '1', risk: 'low', sourceRefs: [], ontologyFormation: updatePlan });
    const updated = await candidates.promoteRecallCandidate(uid, updatedCandidate.id, { actor: 'user' });
    expect(updated.asset.id).toBe(result.asset.id); expect(updated.asset.version).toBe('2');
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ requirement: newText, version: 2,
      source: { recordId: updatedCandidate.id, refs: [{ kind: 'asset', id: result.asset.id }] } });
  });
  it('同次提交规则、认知、共享来源；后续正文和回退版本同步规则且保留审计', async () => {
    const { formation, service, store, kernel } = await setup();
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, proposal(), judgment)!;
    expect(plan.blockedReasons).toEqual([]); expect(plan.requiresTReview).toBe(false);
    await formation.withOntologyFormationPromotion(uid, plan, 'system', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()));
    const saved = await store.readRecallJsonRecord(uid, 'ability-assets', 'asset-one');
    expect(saved?.ontologyRefs).toEqual([{ groupId: 'personal', moduleId: 'personal', recordId: 'expression-rule', versionPolicy: 'current', sharedBody: true }]);
    expect(service.readOntologyDocument(uid).records['expression-rule'].source.refs).toEqual([{ kind: 'asset', id: 'asset-one' }]);
    const newText = '复杂问题先说结论，故障分析先列证据，再解释原因。';
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', old => ({ ...old!, statement: newText, version: '2', ontologyRefs: [] }));
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ requirement: newText, version: 2, source: { refs: [{ kind: 'asset', id: 'asset-one' }] } });
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', old => ({ ...old!, statement: judgment, version: '3' }));
    const doc = kernel.loadCognitionStoreSync(uid);
    expect(doc.ontology!.records['expression-rule']).toMatchObject({ requirement: judgment, version: 3 });
    expect(doc.objects['asset-one'].statement).toBe(judgment);
    expect(doc.ontology!.history.filter(row => row.after.id === 'expression-rule')).toHaveLength(3);
    await expect(service.commitOntologyCommand(uid, { commandId: 'independent-edit', expectedRevision: 4, actions: [
      { intent: 'update', recordId: 'expression-rule', expectedVersion: 3, patch: { requirement: '独立改成另一份正文' }, sourceLabel: '用户编辑' },
    ] })).rejects.toMatchObject({ code: 'shared_body_requires_cognition' });
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', old => ({ ...old!, status: 'paused' }));
    expect(service.readOntologyDocument(uid).records['expression-rule'].status).toBe('paused');
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', old => ({ ...old!, status: 'active' }));
    expect(service.readOntologyDocument(uid).records['expression-rule'].status).toBe('active');
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', old => ({ ...old!, scopePolicy: { projectIds: ['project-one'] } }));
    expect(service.readOntologyDocument(uid).records['expression-rule'].access).toBe('owner_only');
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-one', old => ({ ...old!, scopePolicy: undefined }));
    expect(service.readOntologyDocument(uid).records['expression-rule'].access).toBe('owner_only');
  });
  it('并行改动后确认零落盘；不覆盖别人版本，不留只保存一半的认知', async () => {
    const { formation, service, store } = await setup();
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, proposal(), judgment)!;
    await service.commitOntologyCommand(uid, { commandId: 'concurrent', expectedRevision: 1, actions: [create('other-rule', { ...rule(), name: '另一条已确认偏好' })] });
    await expect(formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()))).rejects.toMatchObject({ code: 'baseline_changed' });
    expect(await store.readRecallJsonRecord(uid, 'ability-assets', 'asset-one')).toBeUndefined();
    expect(service.readOntologyDocument(uid).records['expression-rule']).toBeUndefined();
    expect(service.readOntologyDocument(uid).records['other-rule']).toBeDefined();
  });
  it('下游对象投影失败时本体和认知均未提交；原计划可重试并且命令不重复', async () => {
    const { formation, service, store } = await setup();
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, proposal(), judgment)!;
    await expect(formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', { ...asset(), type: 'invalid' }))).rejects.toThrow(/unsupported asset type/);
    expect(service.readOntologyDocument(uid).records['expression-rule']).toBeUndefined();
    await formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()));
    await formation.withOntologyFormationPromotion(uid, plan, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()));
    expect(service.readOntologyDocument(uid).history.filter(row => row.commandId === plan.commandId)).toHaveLength(1);
  });
  it('结构新建只走人工确认；无依据身份、共享正文不一致不能提交', async () => {
    const { formation, service, store } = await setup();
    const raw = proposal(); raw.actions.unshift(create('person-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }));
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, judgment)!;
    expect(plan.requiresTReview).toBe(true);
    await expect(formation.withOntologyFormationPromotion(uid, plan, 'system', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', asset()))).rejects.toMatchObject({ code: 't_review_required' });
    expect(formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, proposal('另一份正文'), judgment)?.blockedReasons).toContain('shared_body_mismatch');
    const uncertain = { ...raw, actions: [...raw.actions, create('person', { kind: 'entity', moduleId: 'personal', typeId: 'person-type', name: '示例同名成员', description: '', aliases: [], identityStatus: 'confirmed' })] };
    expect(formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, uncertain, judgment)?.blockedReasons).toContain('identity_evidence_required:person');
    expect(service.readOntologyDocument(uid).revision).toBe(1);
  });
  it('时间变化关闭旧区间并形成新版本；纠正保留历史，不把记录时间当生效时间', async () => {
    const { formation, service, store } = await setup();
    await service.commitOntologyCommand(uid, { commandId: 'fact-seed', expectedRevision: 1, actions: [
      create('person-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('self', { kind: 'entity', moduleId: 'personal', typeId: 'person-type', name: '用户本人', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('team', { kind: 'definition', moduleId: 'personal', name: '所在组', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      create('team-fact', { kind: 'assertion', moduleId: 'personal', subjectId: 'self', definitionId: 'team', object: { kind: 'literal', valueType: 'text', value: '甲组' }, validity: { from: '2026-09-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    ] });
    const change = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, { reason: '用户明确十月一日调组', evidence: ['m1'], refs: [], actions: [{ intent: 'change', recordId: 'team-fact', expectedVersion: 1, effectiveFrom: '2026-10-01', object: { kind: 'literal', valueType: 'text', value: '乙组' }, sourceLabel: '用户明确生效日期' }] }, '')!;
    expect(change.blockedReasons).toEqual([]); expect(change.effectiveFrom).toBe('2026-10-01');
    expect(change.previewChanges[0].after).toMatchObject({ validity: { until: '2026-10-01' } });
    expect(change.previewChanges[1].after).toMatchObject({ validity: { from: '2026-10-01' }, supersedesId: 'team-fact' });
    const correction = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, { reason: '用户纠正旧记录', evidence: ['m1'], refs: [], actions: [{ intent: 'correct', recordId: 'team-fact', expectedVersion: 1, object: { kind: 'literal', valueType: 'text', value: '丙组' }, sourceLabel: '用户明确原先说错' }] }, '')!;
    expect(correction.previewChanges[0].after.status).toBe('corrected');
    expect(correction.previewChanges[1].after).toMatchObject({ validity: { from: '2026-09-01' } });
    await service.commitOntologyCommand(uid, { commandId: 'unknown-start-seed', expectedRevision: 2, actions: [
      create('other-team', { kind: 'definition', moduleId: 'personal', name: '协作组', description: '', definitionKind: 'attribute', subjectTypes: ['person-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      create('unknown-start', { kind: 'assertion', moduleId: 'personal', subjectId: 'self', definitionId: 'other-team', object: { kind: 'literal', valueType: 'text', value: '旧协作组' }, validity: { from: null, until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    ] });
    const datedTransition = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, { reason: '原开始时间未知，但用户明确新的变化日期', evidence: ['m1'], refs: [], actions: [{ intent: 'change', recordId: 'unknown-start', expectedVersion: 1, effectiveFrom: '2026-10-01', object: { kind: 'literal', valueType: 'text', value: '新协作组' }, sourceLabel: '用户明确变化日期' }] }, '')!;
    expect(datedTransition.blockedReasons).toEqual([]);
    expect(datedTransition.previewChanges[0].after).toMatchObject({ validity: { from: null, until: '2026-10-01' } });
    expect(datedTransition.previewChanges[1].after).toMatchObject({ validity: { from: '2026-10-01' } });
    const referencedChange = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), 'temporary-fact-candidate', { reason: '明确的后续情况变化', evidence: ['m1'],
      refs: [{ moduleId: 'personal', recordId: 'team-fact', versionPolicy: 'current' }], actions: [{ intent: 'change', recordId: 'team-fact', expectedVersion: 1, effectiveFrom: '2026-10-01', object: { kind: 'literal', valueType: 'text', value: '乙组' }, sourceLabel: '用户说明确切时间' }] }, '')!;
    const bound = formation.bindOntologyFormationPlan('final-fact-candidate', referencedChange);
    const successor = bound.previewChanges.find(row => row.intent === 'change')!.after;
    expect(bound.refs[0].recordId).toBe(successor.id);
    expect(successor.source.recordId).toBe('final-fact-candidate');
    await formation.withOntologyFormationPromotion(uid, bound, 'user', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-fact', { ...asset('asset-fact'), candidateId: 'final-fact-candidate' }));
    expect(service.readOntologyDocument(uid).records[successor.id]).toMatchObject({ source: { recordId: 'final-fact-candidate' }, supersedesId: 'team-fact' });
    expect((await store.readRecallJsonRecord(uid, 'ability-assets', 'asset-fact'))?.ontologyRefs).toEqual(bound.refs);
    await store.updateRecallJsonRecord(uid, 'ability-assets', 'asset-fact', old => ({ ...old!, scopePolicy: { projectIds: ['project-one'] } }));
    const privateFact = service.readOntologyDocument(uid).records[successor.id];
    expect(privateFact).toMatchObject({ access: 'owner_only', object: { value: '乙组' }, validity: { from: '2026-10-01' } });
    await expect(service.commitOntologyCommand(uid, { commandId: 'unsafe-fact-access', expectedRevision: service.readOntologyDocument(uid).revision, actions: [
      { intent: 'update', recordId: privateFact.id, expectedVersion: privateFact.version, patch: { access: 'task' }, sourceLabel: '单独修改事实显示范围' },
    ] })).rejects.toMatchObject({ code: 'formation_blocked' });
  });
  it('精确相同的最小T复用已有身份，依赖引用一起重指；不按名称猜人物同一性', async () => {
    const { formation, service } = await setup();
    await service.commitOntologyCommand(uid, { commandId: 'type-seed', expectedRevision: 1, actions: [
      create('known-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('existing-person', { kind: 'entity', moduleId: 'personal', typeId: 'known-type', name: '示例同名成员', description: '研发成员', aliases: [], identityStatus: 'confirmed' }),
    ] });
    const raw = { reason: '用户提供另一位同名人员的独立岗位和编号', evidence: ['m1'], identityEvidence: [{ recordId: 'another-person', reason: '另一位同名人员属于客户部门，独立成员编号不同', evidence: ['m1'] }],
      actions: [create('proposed-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
        create('another-person', { kind: 'entity', moduleId: 'personal', typeId: 'proposed-type', name: '示例同名成员', description: '客户成员', aliases: [], identityStatus: 'confirmed' })],
      refs: [{ moduleId: 'personal', recordId: 'proposed-type', versionPolicy: 'current' }],
    };
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw)!;
    expect(plan.blockedReasons).toEqual([]); expect(plan.requiresTReview).toBe(false);
    expect(plan.actions).toHaveLength(1); expect(plan.refs[0].recordId).toBe('known-type');
    expect(plan.actions[0]).toMatchObject({ recordId: 'another-person', record: { typeId: 'known-type' } });
    expect(plan.previewChanges[0].after.id).not.toBe('existing-person');
  });
  it('额外本体内容里的凭据也走相同门禁，拒绝计划保存但原始对话不受改写', async () => {
    const { formation, service, kernel } = await setup();
    const { appendJsonlAtomic } = await import('../../../src/main/storage');
    const { conversationMessageFile } = await import('../../../src/main/util/project-layout');
    const file = conversationMessageFile(uid, 'synthetic-sensitive-source');
    await appendJsonlAtomic(file, { id: 'synthetic-sensitive-original', from: 'user', text: 'Synthetic credential fixture: password=not_a_real_password' });
    const beforeChat = fs.readFileSync(file, 'utf8'), beforeFormal = fs.readFileSync(kernel.cognitionStorePath(uid), 'utf8');
    const raw = proposal(); raw.actions[0].record.exception = 'password=not_a_real_password';
    expect(() => formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, judgment)).toThrow(/forbidden to persist/);
    const valid = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, proposal(), judgment)!;
    expect(() => formation.normalizeOntologyFormationPlan(uid, candidateId, { ...valid, reason: 'password=not_a_real_password' })).toThrow(/forbidden to persist/);
    const escaped = proposal(); escaped.actions[0].record.exception = 'password\n=not_a_real_password';
    expect(() => formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, escaped, judgment)).toThrow(/forbidden to persist/);
    expect(fs.readFileSync(file, 'utf8')).toBe(beforeChat);
    expect(fs.readFileSync(kernel.cognitionStorePath(uid), 'utf8')).toBe(beforeFormal);
  });
  it('真实provider遗漏kind时只恢复唯一完整shape，不猜缺少指令或混合记录', async () => {
    const { formation, service } = await setup();
    const missingKind = proposal(); delete missingKind.actions[0].record.kind;
    const valid = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, missingKind, judgment)!;
    expect(valid.blockedReasons).toEqual([]); expect(valid.actions[0]).toMatchObject({ record: { kind: 'rule' } });
    const mixed = proposal(); delete mixed.actions[0].record.kind;
    Object.assign(mixed.actions[0].record, { subjectId: 'self', definitionId: 'preference', object: { kind: 'literal', valueType: 'text', value: judgment }, validity: { from: null, until: null, precision: 'day', timezone: 'Asia/Shanghai' } });
    expect(formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, mixed, judgment)?.blockedReasons).toContain('invalid_input');
    const bare = { ...proposal(), actions: [rule()] };
    expect(formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, bare, judgment)?.blockedReasons).toContain('invalid_input');
  });
  it('来源项目/空间/角色限定不能经manual或auto确认放入全局本体；匹配模块或owner_only才可', async () => {
    const { formation, service, store, kernel } = await setup();
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, proposal(), judgment)!;
    const before = fs.readFileSync(kernel.cognitionStorePath(uid), 'utf8');
    for (const policy of [{ projectIds: ['project-one'] }, { workspaceIds: ['space-one'] }, { agentIds: ['agent-one'] }, { roleIds: [] }]) {
      const prepared = formation.validateOntologyFormationScope(uid, service.readOntologyDocument(uid), plan, policy)!;
      expect(prepared.blockedReasons).toContain('ontology_scope_exceeds_cognition:expression-rule');
      for (const actor of ['user', 'system'] as const) await expect(formation.withOntologyFormationPromotion(uid, plan, actor,
        () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', { ...asset(), scopePolicy: policy }))).rejects.toMatchObject({ code: 'formation_blocked' });
    }
    expect(fs.readFileSync(kernel.cognitionStorePath(uid), 'utf8')).toBe(before);
    const privateProposal = proposal(); privateProposal.actions[0].record.access = 'owner_only';
    const privatePlan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, privateProposal, judgment)!;
    expect(formation.validateOntologyFormationScope(uid, service.readOntologyDocument(uid), privatePlan, { agentIds: [] })?.blockedReasons).toEqual([]);
    await formation.withOntologyFormationPromotion(uid, privatePlan, 'system', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', { ...asset(), scopePolicy: { projectIds: ['project-one'] } }));
    const { queryOntologyRules } = await import('../../../src/main/features/cognition/ontology/query');
    expect(queryOntologyRules(service.readOntologyDocument(uid), { moduleId: 'personal', task: { at: '2026-10-14' } })).toEqual([]);
    await expect(service.commitOntologyCommand(uid, { commandId: 'unsafe-visibility', expectedRevision: 2, actions: [
      { intent: 'update', recordId: 'expression-rule', expectedVersion: 1, patch: { access: 'task' }, sourceLabel: '仅修改本体显示范围' },
    ] })).rejects.toMatchObject({ code: 'formation_blocked' });
  });
  it('匹配项目module可自动保存A/R；只读公共T引用不复制、不放宽范围', async () => {
    const { formation, service, store } = await setup();
    await service.commitOntologyCommand(uid, { commandId: 'project-module', expectedRevision: 1, actions: [create('project-module', { kind: 'module', name: '项目范围', description: '', scope: { kind: 'project', id: 'project-one' } })] });
    const raw = proposal(); raw.actions[0].record.moduleId = 'project-module'; raw.refs[0].moduleId = 'project-module';
    const plan = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), candidateId, raw, judgment)!;
    expect(formation.validateOntologyFormationScope(uid, service.readOntologyDocument(uid), plan, { projectIds: ['project-one'] })?.blockedReasons).toEqual([]);
    await formation.withOntologyFormationPromotion(uid, plan, 'system', () => store.writeRecallJsonRecord(uid, 'ability-assets', 'asset-one', { ...asset(), scopePolicy: { projectIds: ['project-one'] } }));
    expect(service.readOntologyDocument(uid).records['expression-rule']).toMatchObject({ moduleId: 'project-module', access: 'task' });
    const readOnly = formation.parseOntologyFormationProposal(service.readOntologyDocument(uid), 'readonly-candidate', { reason: '引用已有概念，不迁移来源事实', evidence: ['m1'], actions: [], refs: [{ moduleId: 'personal', recordId: 'personal', versionPolicy: 'current' }] })!;
    expect(formation.validateOntologyFormationScope(uid, service.readOntologyDocument(uid), readOnly, { projectIds: ['project-one'] })?.blockedReasons).toEqual([]);
  });
});
