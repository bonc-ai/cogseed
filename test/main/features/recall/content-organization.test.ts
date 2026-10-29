import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
const model = vi.hoisted(() => vi.fn());
const interaction = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: model }));
vi.mock('../../../../src/main/features/chat_events/interaction-hub', async original => ({ ...await original<typeof import('../../../../src/main/features/chat_events/interaction-hub')>(), requestInteraction: interaction }));
const uid = 'synthetic-organization-user';
let root: string, previous: string | undefined;
const bodyA = '提交报告前，必须核对 3 项来源；不得省略失败结果。仅当来源可读时使用；例外：离线草稿。目标：{{目标}}。';
const bodyB = '提交报告前，必须填写结论与下一步。';
const purpose = '核对报告的来源与失败结果，防止遗漏。';
beforeEach(async () => {
  vi.resetModules(); model.mockReset(); interaction.mockReset().mockResolvedValue({ interactionId: 'synthetic-review', reason: 'answered', decision: 'allow' });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-organization-')); previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  await (await import('../../../../src/main/features/cognition_bridge')).replaceCognitionSources(uid, { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
});
afterEach(async () => { await drainMainRuntimeForTest(uid); vi.restoreAllMocks(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function env() {
  return { org: await import('../../../../src/main/features/recall/content-organization'), store: await import('../../../../src/main/features/recall/store'),
    assets: await import('../../../../src/main/features/recall/asset-service'), candidates: await import('../../../../src/main/features/recall/candidate-service'),
    ontology: await import('../../../../src/main/features/cognition/ontology/service'), bridge: await import('../../../../src/main/features/cognition_bridge') };
}
async function seed(id = 'source-a', patch: Record<string, unknown> = {}) {
  const e = await env(), at = new Date().toISOString();
  const record = { schemaVersion: 1, ownerId: uid, id, candidateId: 'seed-candidate', reviewDecisionId: 'rd_syntheticseed',
    type: 'rule', title: id === 'source-a' ? '报告来源要求' : '报告结论要求', statement: id === 'source-a' ? bodyA : bodyB,
    evidenceRefs: [], origin: 'manual', scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud',
    version: '1', createdAt: at, updatedAt: at, ...patch } as any;
  await e.store.writeRecallJsonRecord(uid, 'ability-assets', id, record); await e.assets.initializeAbilityAsset(uid, record, { actor: 'user', reason: 'Synthetic seed' });
  return record;
}
function merge() { return { operation: 'merge' as const, sourceAssetIds: ['source-a', 'source-b'], reason: '将报告提交前的互补核对要求放在同一条。', outputs: [{ title: '报告提交核对要求', statement: bodyA + '\n' + bodyB,
  sourceAssetIds: ['source-a', 'source-b'], excerpts: [{ assetId: 'source-a', quote: bodyA }, { assetId: 'source-b', quote: bodyB }], ontologyRecordIds: [] as string[] }] }; }
function split() { return { operation: 'split' as const, sourceAssetIds: ['source-a'], reason: '将报告来源和结论要求分开，供两个步骤使用。', outputs: [bodyA, bodyB].map((statement, i) => ({ title: i ? '报告结论要求' : '报告来源要求', statement,
  sourceAssetIds: ['source-a'], excerpts: [{ assetId: 'source-a', quote: statement }], ontologyRecordIds: [] as string[] })) }; }
async function proposal(draft = merge()) { const e = await env(); return e.org.submitContentOrganization(uid, await e.org.prepareContentOrganization(uid, draft, 'scan')); }
async function run() { const settings = await import('../../../../src/main/features/recall/capture-settings'); return (await import('../../../../src/main/features/recall/stock-organization')).runStockOrganization(uid, await settings.readRecallCaptureSettings(uid), new AbortController().signal, async () => {}); }
function responses(draft: unknown) { model.mockImplementation(async (_user, input) => {
  if (input.budget.stage === 'extraction') return { result: { text: JSON.stringify({ outcome: 'organization', reason: 'Synthetic organization', organization: draft }), meta: {} } };
  const sources = JSON.parse(input.message).sources;
  return { result: { text: JSON.stringify({ supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label: 'stored-version', quote: sources[0].text.slice(0, 60) }] }), meta: {} } };
}); }
describe('atomic content organization', () => {
  it('keeps located-source plan bytes and identities compatible with the original version encoding', async () => {
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(uid, { conversationId: 'synthetic-plan-source', kind: 'normal', title: '合成来源' });
    vi.spyOn(chats, 'getMessagesPage').mockResolvedValue({ history: [
      { id: 'synthetic-plan-message', from: 'user', text: `${bodyA}\n${bodyB}`, ts: '2026-01-01T00:00:00Z' },
    ], nextCursor: null } as any);
    const refs = await import('../../../../src/main/features/recall/source-service');
    const catalog = await import('../../../../src/main/features/recall/source-catalog');
    const locator = { conversationId: 'synthetic-plan-source', messageId: 'synthetic-plan-message' };
    const ref = refs.normalizeCognitionSourceRef({ kind: 'conversation', subtype: 'message',
      id: catalog.cognitionMessageSourceId(locator.conversationId, locator.messageId), locator })!;
    ref.sourceVersion = (await (await import('../../../../src/main/features/recall/source-locator')).readLocatedSource(uid, ref)).sourceVersion;
    await seed('source-a', { evidenceRefs: [{ ...ref, locator: { ...locator, range: { start: 0, end: bodyA.length } } }] });
    await seed('source-b', { evidenceRefs: [{ ...ref, locator: { ...locator, range: { start: bodyA.length + 1, end: bodyA.length + 1 + bodyB.length } } }] });
    const e = await env();
    const current = await e.org.prepareContentOrganization(uid, merge(), 'scan');
    const normal = catalog.readCognitionSourceBaselines;
    const legacy = vi.spyOn(catalog, 'readCognitionSourceBaselines').mockImplementation(async (user, inputs) => {
      const result = await normal(user, inputs);
      for (const source of inputs) if (source.locator) {
        const key = refs.cognitionSourceRefKey(source);
        result.set(key, JSON.stringify({ sourceVersion: JSON.parse(result.get(key)!).sourceVersion, locator: source.locator }));
      }
      return result;
    });
    const old = await e.org.prepareContentOrganization(uid, merge(), 'scan');
    legacy.mockRestore();
    expect(current.sourceState).toEqual(old.sourceState);
    expect(current.operationId).toBe(old.operationId); expect(current.groupKey).toBe(old.groupKey);
    const row = await e.org.submitContentOrganization(uid, old);
    await e.org.confirmContentOrganization(uid, row.id);
    const undo = await e.org.previewContentOrganizationUndo(uid, row.id);
    await e.org.undoContentOrganization(uid, row.id, undo.token);
    expect((await e.assets.readAbilityAsset(uid, 'source-a')).status).toBe('active');
  });
  it('merges exact content into a new chain; archives originals and retries without another version', async () => {
    await seed(); await seed('source-b'); const e = await env(), c = await proposal();
    expect(c.value).toBeUndefined(); expect(c.origin).toBe('organization');
    const saved = await e.org.confirmContentOrganization(uid, c.id); expect(saved.assets).toHaveLength(1);
    const result = await e.assets.readAbilityAsset(uid, saved.assets[0].id);
    expect(result).toMatchObject({ statement: bodyA + '\n' + bodyB, version: '1', derivedFrom: ['source-a', 'source-b'], status: 'active' });
    expect(result.value).toBeUndefined();
    expect((await e.assets.readAbilityAsset(uid, 'source-a'))).toMatchObject({ status: 'archived', statement: bodyA, version: '1' });
    expect((await e.assets.readAbilityAssetVersionSnapshot(uid, result.id, '1'))?.statement).toBe(result.statement);
    expect((await e.assets.readAbilityAssetVersionSnapshot(uid, 'source-a', '1'))?.statement).toBe(bodyA);
    expect((await e.org.confirmContentOrganization(uid, c.id)).duplicate).toBe(true);
    await expect(e.assets.restoreAbilityAsset(uid, 'source-a', { actor: 'user', reason: 'Single restore' })).rejects.toThrow('整组');
    const undo = await e.org.previewContentOrganizationUndo(uid, c.id); await e.org.undoContentOrganization(uid, c.id, undo.token);
    expect((await e.assets.readAbilityAsset(uid, 'source-a')).status).toBe('active');
    expect((await e.assets.readAbilityAsset(uid, result.id)).status).toBe('archived');
    expect((await e.org.undoContentOrganization(uid, c.id, undo.token)).duplicate).toBe(true);
  });
  it('splits all results, saves reviewed purpose and boundaries, and blocks undo after a later edit', async () => {
    await seed('source-a', { statement: bodyA + '\n' + bodyB }); const e = await env();
    const c = await e.org.submitContentOrganization(uid, await e.org.prepareContentOrganization(uid, split(), 'scan'));
    const outputs = c.contentOrganization!.draft.outputs; outputs[0] = { ...outputs[0], value: purpose, applicableWhen: ['来源可读'], forbiddenWhen: ['离线草稿用于正式报告'] };
    const prior = structuredClone(split().outputs);
    await e.org.updateContentOrganization(uid, c.id, outputs);
    await expect(e.org.confirmContentOrganization(uid, c.id, 'user', prior)).rejects.toThrow('确认期间发生变化');
    const saved = await e.org.confirmContentOrganization(uid, c.id); expect(saved.assets).toHaveLength(2);
    const first = await e.assets.readAbilityAsset(uid, saved.assets[0].id);
    expect(first).toMatchObject({ statement: bodyA, value: purpose, applicableWhen: ['来源可读'], forbiddenWhen: ['离线草稿用于正式报告'] });
    await e.assets.updateAbilityAsset(uid, first.id, { value: '修改后的用途', actor: 'user', reason: 'Synthetic later edit' });
    await expect(e.org.previewContentOrganizationUndo(uid, c.id)).rejects.toThrow('后续变化');
  });
  it('keeps all originals when a baseline changes and refuses partial/system/legacy promotion', async () => {
    await seed(); await seed('source-b'); const e = await env(), c = await proposal();
    await e.assets.updateAbilityAsset(uid, 'source-b', { value: purpose, actor: 'user', reason: 'Synthetic concurrent edit' });
    await expect(e.org.confirmContentOrganization(uid, c.id)).rejects.toThrow('变化');
    await expect(e.org.confirmContentOrganization(uid, c.id, 'system')).rejects.toThrow('人工');
    await expect(e.candidates.promoteRecallCandidate(uid, c.id, { actor: 'user' })).rejects.toThrow('整组');
    expect((await e.assets.listAbilityAssets(uid)).filter(row => row.status === 'active')).toHaveLength(2);
    expect((await e.candidates.readRecallCandidate(uid, c.id)).status).toBe('pending_review');
  });
  it('rejects incompatible scope, fake excerpts, missing ontology destinations and overlapping proposals', async () => {
    await seed(); await seed('source-b', { scope: 'code' }); const e = await env();
    await expect(proposal()).rejects.toThrow('范围');
    await e.store.updateRecallJsonRecord(uid, 'ability-assets', 'source-b', row => ({ ...row!, scope: 'general' }));
    const fake = merge(); fake.outputs[0].excerpts[0].quote = 'invented quote'; await expect(proposal(fake)).rejects.toThrow('原文');
    const c = await proposal(); await expect(proposal({ ...merge(), reason: 'Another overlapping plan' })).rejects.toThrow('待确认');
    await e.candidates.rejectRecallCandidate(uid, c.id);
    expect((await proposal({ ...merge(), reason: 'Another rejected plan' })).id).toBe(c.id);
  });
  it('creates distinct shared rules and remaps their source, then undoes the whole ontology command', async () => {
    await seed('source-a', { statement: bodyA + '\n' + bodyB }); const e = await env();
    await e.ontology.commitOntologyCommand(uid, { commandId: 'seed-rules', expectedRevision: 0, actions: [
      { intent: 'create', recordId: 'personal', sourceLabel: 'Synthetic module', record: { kind: 'module', name: '示例模块', description: '', scope: { kind: 'personal' } } },
      { intent: 'create', recordId: 'shared-rule', sourceLabel: 'Synthetic rule', record: { kind: 'rule', moduleId: 'personal', name: '报告要求', requirement: bodyA + '\n' + bodyB, strength: 'required', condition: null, effect: { kind: 'note' }, exception: '' } } ] });
    await e.bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology!.records['shared-rule'].source.refs = [{ kind: 'asset', id: 'source-a' }]; }, () => e.store.updateRecallJsonRecord(uid, 'ability-assets', 'source-a', row => ({ ...row!, ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'shared-rule', versionPolicy: 'current', sharedBody: true }] })));
    const draft = split(); draft.outputs.forEach(row => row.ontologyRecordIds.push('shared-rule'));
    const c = await e.org.submitContentOrganization(uid, await e.org.prepareContentOrganization(uid, draft, 'scan'));
    const saved = await e.org.confirmContentOrganization(uid, c.id), doc = e.ontology.readOntologyDocument(uid);
    expect(doc.records['shared-rule'].status).toBe('archived');
    for (const row of saved.assets) { const asset = await e.assets.readAbilityAsset(uid, row.id), rule = doc.records[asset.ontologyRefs![0].recordId!]; expect(rule).toMatchObject({ requirement: asset.statement, status: 'active', source: { refs: [{ kind: 'asset', id: asset.id }] } }); }
    const undo = await e.org.previewContentOrganizationUndo(uid, c.id); await e.org.undoContentOrganization(uid, c.id, undo.token);
    expect(e.ontology.readOntologyDocument(uid).records['shared-rule']).toMatchObject({ status: 'active', source: { refs: [{ kind: 'asset', id: 'source-a' }] } });
  });
  it('has no partial writes after commit failure and recovers with the same result IDs', async () => {
    await seed(); await seed('source-b'); const e = await env(), c = await proposal();
    const original = e.bridge.withCognitionSourceDependency;
    const fail = vi.spyOn(e.bridge, 'withCognitionSourceDependency').mockImplementationOnce((uid, collection, stage, work) => original(uid, collection, (doc, row) => { stage(doc, row); throw new Error('Synthetic commit failure'); }, work));
    await expect(e.org.confirmContentOrganization(uid, c.id)).rejects.toThrow('Synthetic commit failure'); fail.mockRestore();
    expect((await e.assets.readAbilityAsset(uid, 'source-a')).status).toBe('active');
    expect((await e.candidates.readRecallCandidate(uid, c.id)).organizationReceipt).toBeUndefined();
    const saved = await e.org.confirmContentOrganization(uid, c.id); expect(saved.assets.map(row => row.id)).toEqual(c.contentOrganization!.resultIds);
  });
});
describe('scan and conversation entry points', () => {
  it('finds one merge group without conversations and suppresses overlap and rejected repeats', async () => {
    await seed(); await seed('source-b'); responses(merge());
    const progress = await run();
    expect(progress).toMatchObject({ checked: 2, proposed: 1, failed: 0, remaining: 0, phase: 'complete' });
    const e = await env(), rows = await e.candidates.listRecallCandidates(uid); expect(rows).toHaveLength(1);
    expect(Object.values(progress.items || {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'completed', candidateId: rows[0].id }),
    ]));
    await e.candidates.rejectRecallCandidate(uid, rows[0].id); await run(); expect(model).toHaveBeenCalledTimes(2);
  });
  it('resumes a split after cancellation before grounding without repeating formation', async () => {
    await seed('source-a', { statement: bodyA + '\n' + bodyB }); responses(split()); const normal = model.getMockImplementation()!;
    model.mockImplementation(async (...args) => { if (args[1].budget.stage === 'grounding') throw Object.assign(new Error('stop'), { code: 'ABORT_ERR' }); return normal(...args); });
    expect(await run()).toMatchObject({ phase: 'stopped', remaining: 1 }); responses(split()); expect(await run()).toMatchObject({ proposed: 1, remaining: 0 });
    expect(model.mock.calls.map(args => args[1].budget.stage)).toEqual(['extraction', 'grounding', 'grounding']);
  });
  it('previews without writing, honors cancel, and confirms one group with an idempotent replay', async () => {
    await seed(); await seed('source-b'); const e = await env(); const host = { cid: 'chat-synthetic', turnId: 'turn-synthetic', sourceMessageId: 'message-synthetic', sourceMessageFromUser: true, taskText: '请合并 source-a 和 source-b。' };
    const input = { ...merge(), expectedVersions: ['source-a', 'source-b'].map(assetId => ({ assetId, version: '1', activeVersion: '1' })) };
    expect((await e.org.organizeCognitionFromConversation(uid, host, { ...input, mode: 'propose' })).status).toBe('pending_confirmation');
    expect(await e.candidates.listRecallCandidates(uid)).toHaveLength(0); expect(interaction).not.toHaveBeenCalled();
    interaction.mockResolvedValueOnce({ reason: 'answered', decision: 'deny' }); expect((await e.org.organizeCognitionFromConversation(uid, host, input)).status).toBe('blocked');
    const saved = await e.org.organizeCognitionFromConversation(uid, host, input); expect(saved.status).toBe('applied');
    expect((await e.org.organizeCognitionFromConversation(uid, host, input))).toMatchObject({ status: 'applied', duplicate: true }); expect(interaction).toHaveBeenCalledTimes(2);
    await expect(e.org.organizeCognitionFromConversation(uid, { ...host, sourceMessageFromUser: false }, input)).rejects.toThrow('当前用户');
  });
});

describe('organization authority and current evidence', () => {
  it('blocks disabled sources, lost active versions, missing destinations and an unrequested operation', async () => {
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(uid, { conversationId: 'synthetic-evidence', kind: 'normal', title: '合成来源' });
    const ref = (await import('../../../../src/main/features/recall/source-service')).normalizeCognitionSourceRef({ taxonomyVersion: 2, kind: 'conversation', subtype: 'session', id: 'synthetic-evidence' });
    await seed('source-a', { evidenceRefs: [ref] }); await seed('source-b'); const e = await env(), c = await proposal();
    await (await import('../../../../src/main/features/recall/source-control')).pauseCognitionSource(uid, ref);
    await expect(e.org.confirmContentOrganization(uid, c.id)).rejects.toThrow();
    expect((await e.candidates.readRecallCandidate(uid, c.id)).organizationReceipt).toBeUndefined();
    const input = { ...merge(), expectedVersions: [] };
    await expect(e.org.organizeCognitionFromConversation(uid, { cid: 'c', turnId: 't', sourceMessageId: 'm', sourceMessageFromUser: true, taskText: '不要合并 source-a 和 source-b。' }, input)).rejects.toThrow('未授权');
    await expect(e.org.organizeCognitionFromConversation(uid, { cid: 'c', turnId: 't', sourceMessageId: 'm', sourceMessageFromUser: true, taskText: '请拆分 source-a。' }, input)).rejects.toThrow('未授权');
    await e.store.updateRecallJsonRecord(uid, 'ability-assets', 'source-b', row => ({ ...row!, activeVersion: '9' }));
    await expect(e.org.prepareContentOrganization(uid, { operation: 'split', sourceAssetIds: ['source-b'], outputs: split().outputs, reason: 'Synthetic missing version' }, 'scan')).rejects.toThrow('在用版本缺失');
  });
  it('keeps shared fact identity and validity readable through new sources, with recoverable history', async () => {
    await seed(); await seed('source-b'); const e = await env();
    const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create' as const, recordId, record, sourceLabel: 'Synthetic linked fact' });
    await e.ontology.commitOntologyCommand(uid, { commandId: 'facts-seed', expectedRevision: 0, actions: [
      create('personal', { kind: 'module', name: '合成模块', description: '', scope: { kind: 'personal' } }),
      create('type', { kind: 'definition', moduleId: 'personal', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('entity', { kind: 'entity', moduleId: 'personal', typeId: 'type', name: '合成项目', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('attribute', { kind: 'definition', moduleId: 'personal', name: '报告要求', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
      create('fact', { kind: 'assertion', moduleId: 'personal', subjectId: 'entity', definitionId: 'attribute', object: { kind: 'literal', valueType: 'text', value: bodyA }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    ] });
    await e.bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology!.records.fact.source.refs = [{ kind: 'asset', id: 'source-a' }]; }, () => e.store.updateRecallJsonRecord(uid, 'ability-assets', 'source-a', row => ({ ...row!, ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'fact', versionPolicy: 'current' }] })));
    await expect(proposal()).rejects.toThrow('缺少去向');
    const draft = merge(); draft.outputs[0].ontologyRecordIds = ['fact']; const c = await proposal(draft);
    // A candidate contains its affected ontology only, not unrelated records from the main document.
    expect(Object.keys(c.contentOrganization!.ontologyAfter.records)).toEqual(['fact']);
    const saved = await e.org.confirmContentOrganization(uid, c.id), doc = e.ontology.readOntologyDocument(uid);
    expect(doc.records.fact).toMatchObject({ id: 'fact', subjectId: 'entity', definitionId: 'attribute', object: { value: bodyA }, validity: { from: '2026-01-01', until: null }, source: { refs: [{ kind: 'asset', id: saved.assets[0].id }] } });
    expect((await (await import('../../../../src/main/features/cognition/ontology/source-admission')).assessOntologySources(uid, doc)).get('fact')).toBe('allowed');
    const preview = await e.org.previewContentOrganizationUndo(uid, c.id); await e.org.undoContentOrganization(uid, c.id, preview.token);
    expect(e.ontology.readOntologyDocument(uid).records.fact.source.refs).toEqual([{ kind: 'asset', id: 'source-a' }]);
    expect(e.ontology.readOntologyDocument(uid).history.some(row => row.commandId === c.contentOrganization!.operationId)).toBe(true);
    const nextCandidate = await proposal(draft); await e.org.confirmContentOrganization(uid, nextCandidate.id);
    const current = e.ontology.readOntologyDocument(uid);
    await e.ontology.commitOntologyCommand(uid, { commandId: 'change-definition', expectedRevision: current.revision, actions: [{ intent: 'update', recordId: 'attribute', expectedVersion: current.records.attribute.version, sourceLabel: 'Synthetic later dependency edit', patch: { description: '后续修改后的定义' } }] });
    await expect(e.org.previewContentOrganizationUndo(uid, nextCandidate.id)).rejects.toThrow('后续变化');
  });
  it('holds a group after model failures and resumes grounding; concurrent confirms share the result', async () => {
    await seed('source-a', { statement: bodyA + '\n' + bodyB }); responses(split()); const normal = model.getMockImplementation()!;
    model.mockImplementation(async (...args) => { if (args[1].budget.stage === 'grounding') throw Object.assign(new Error('Synthetic model failure hold'), { code: 'ABORT_ERR', reason: 'capture_model_failure_hold' }); return normal(...args); });
    expect(await run()).toMatchObject({ phase: 'failure_held', remaining: 1 }); responses(split()); expect(await run()).toMatchObject({ proposed: 1, remaining: 0 });
    const e = await env(), c = (await e.candidates.listRecallCandidates(uid))[0];
    const [a, b] = await Promise.all([e.org.confirmContentOrganization(uid, c.id), e.org.confirmContentOrganization(uid, c.id)]);
    expect(a.assets).toEqual(b.assets); expect(b.duplicate).toBe(true); expect((await e.assets.listAbilityAssets(uid)).filter(row => row.status === 'active')).toHaveLength(2);
    expect(model.mock.calls.map(args => args[1].budget.stage)).toEqual(['extraction', 'grounding', 'grounding']);
  });
});

it('rejects a peer changed while the model was forming a group instead of adopting its new baseline', async () => {
  await seed(); await seed('source-b'); const e = await env(); responses(merge()); const normal = model.getMockImplementation()!;
  model.mockImplementationOnce(async (...args) => {
    await e.assets.updateAbilityAsset(uid, 'source-b', { statement: bodyB + '不得省略日期。', actor: 'user', reason: 'Synthetic change during model formation' });
    return normal(...args);
  });
  expect(await run()).toMatchObject({ proposed: 0 }); expect(await e.candidates.listRecallCandidates(uid)).toHaveLength(0);
  expect(model.mock.calls.map(args => args[1].budget.stage)).toEqual(['extraction']);
});

it('does not create scan proposals for inputs occupied by a conversation group', async () => {
  await seed(); await seed('source-b'); const e = await env();
  await e.org.submitContentOrganization(uid, await e.org.prepareContentOrganization(uid, merge(), 'conversation'));
  responses(merge());
  expect(await run()).toMatchObject({ remaining: 0 }); expect(model).not.toHaveBeenCalled();
  expect(await e.candidates.listRecallCandidates(uid)).toHaveLength(1);
});

describe('organization content purge', () => {
  it.each([false, true])('clears snapshots and stops replay for a group (committed=%s)', async committed => {
    await seed(); const peer = await seed('source-b'); await seed('unrelated-asset');
    const e = await env(), candidate = await proposal();
    const output = committed ? await e.org.confirmContentOrganization(uid, candidate.id) : undefined;
    const before = (await e.store.readRecallJsonRecord(uid, 'candidates', candidate.id))!;
    const plan = candidate.contentOrganization!;
    const job = { schemaVersion: 1, ownerId: uid, id: 'synthetic-old-job', unit: { key: 'asset-source-a', asset: plan.sources[0].content },
      prepared: before, draft: { content: { statement: bodyA } }, state: 'prepared', candidateId: candidate.id };
    await e.store.writeRecallJsonRecord(uid, 'stock-organization', job.id, job);
    await e.assets.purgeAbilityAsset(uid, 'source-a', { actor: 'user', reason: 'Synthetic purge' });
    for (const [collection, id] of [['candidates', candidate.id], ['stock-organization', job.id], ['stock-organization', plan.operationId]]) {
      const cleared = await e.store.readRecallJsonRecord(uid, collection, id);
      expect(cleared?.contentPurgedAt).toEqual(expect.any(String));
      expect(JSON.stringify(cleared)).not.toContain(bodyA);
      expect(JSON.stringify(cleared)).not.toContain(plan.draft.reason);
      expect(cleared?.contentAssetIds).toContain('source-a');
    }
    const cleared = await e.candidates.readRecallCandidate(uid, candidate.id);
    expect(cleared.status).toBe(committed ? 'confirmed' : 'pending_review');
    const caps = (await import('../../../../src/main/features/recall/candidate-capabilities')).getRecallCandidateCapabilities(cleared);
    expect(caps).toMatchObject({ canEdit: false, canPromote: false, canRetry: false, countsAsPending: false, displayState: 'content_purged' });
    expect(e.candidates.isAutoCaptureEligible(cleared)).toBe(false);
    expect((await e.candidates.listRecallCandidates(uid)).some(row => row.id === candidate.id)).toBe(true);
    expect(await (await import('../../../../src/main/features/recall/review-evidence')).readReviewEvidence(uid, { candidateId: candidate.id })).toEqual([]);
    await expect(e.org.confirmContentOrganization(uid, candidate.id)).rejects.toThrow();
    await expect(e.org.previewContentOrganizationUndo(uid, candidate.id)).rejects.toThrow();
    await expect(e.store.writeRecallJsonRecord(uid, 'candidates', candidate.id, before)).rejects.toMatchObject({ code: 'recall_content_purged' });
    await expect(e.store.updateRecallJsonRecord(uid, 'stock-organization', job.id, () => job)).rejects.toMatchObject({ code: 'recall_content_purged' });
    await expect(e.store.writeRecallJsonRecord(uid, 'stock-organization', 'synthetic-late-job', { ...job, id: 'synthetic-late-job' })).rejects.toMatchObject({ code: 'recall_content_purged' });
    expect((await e.assets.readAbilityAsset(uid, 'source-b')).statement).toBe(peer.statement);
    expect((await e.assets.readAbilityAsset(uid, 'unrelated-asset')).status).toBe('active');
    if (output) expect((await e.assets.readAbilityAsset(uid, output.assets[0].id)).statement).toBe(bodyA + '\n' + bodyB);
    await e.assets.purgeAbilityAsset(uid, 'source-a', { actor: 'user', reason: 'Synthetic retry' });
  });

  it.each(['retry', 'startup'])('recovers a partial cascade through %s without a version-stream directory', async recovery => {
    await seed(); await seed('source-b'); const e = await env(), candidate = await proposal();
    const original = e.store.updateRecallJsonRecord;
    const failure = vi.spyOn(e.store, 'updateRecallJsonRecord').mockImplementation(async (userId, collection, id, updater) => {
      if (collection === 'stock-organization') throw new Error('synthetic checkpoint unavailable');
      return original(userId, collection, id, updater);
    });
    await expect(e.assets.purgeAbilityAsset(uid, 'source-a', { actor: 'user', reason: 'Synthetic purge' })).rejects.toThrow('synthetic checkpoint unavailable');
    failure.mockRestore();
    expect((await e.assets.readAbilityAsset(uid, 'source-a')).status).toBe('purged');
    const paths = await import('../../../../src/main/features/recall/paths');
    fs.rmSync(path.dirname(paths.recallJsonlPath(uid, 'ability-asset-versions', 'source-a')), { recursive: true, force: true });
    if (recovery === 'retry') await e.assets.purgeAbilityAsset(uid, 'source-a', { actor: 'user', reason: 'Synthetic retry' });
    else await e.assets.sweepPurgedAbilityAssetVersionStreams(uid);
    expect((await e.candidates.readRecallCandidate(uid, candidate.id)).contentPurgedAt).toEqual(expect.any(String));
    expect((await e.store.readRecallJsonRecord(uid, 'stock-organization', candidate.contentOrganization!.operationId))?.state).toBe('purged');
  });

  it('refuses a model result arriving after purge without rewriting a failed checkpoint', async () => {
    await seed('source-a', { statement: bodyA + '\n' + bodyB }); responses(split());
    const normal = model.getMockImplementation()!;
    model.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (args[1].budget.stage === 'grounding') await (await env()).assets.purgeAbilityAsset(uid, 'source-a', { actor: 'user', reason: 'Synthetic concurrent purge' });
      return result;
    });
    expect(await run()).toMatchObject({ phase: 'complete', proposed: 0, remaining: 0 });
    const e = await env(); expect(await e.candidates.listRecallCandidates(uid)).toEqual([]);
    const paths = await import('../../../../src/main/features/recall/paths');
    const dir = path.dirname(paths.recallJsonRecordPath(uid, 'stock-organization', 'placeholder'));
    for (const file of fs.readdirSync(dir).filter(file => file.endsWith('.json'))) {
      const job = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      expect(job.state).toBe('purged'); expect(JSON.stringify(job)).not.toContain(bodyA);
    }
  });
});
