import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const interaction = vi.hoisted(() => vi.fn());
const interactionHub = vi.hoisted(() => ({ actual: undefined as typeof import('../../../src/main/features/chat_events/interaction-hub') | undefined }));
vi.mock('../../../src/main/features/chat_events/interaction-hub', async importOriginal => {
  // resetModules reloads importActual, but not this mock factory. Keep the real
  // request and cancel functions on one hub rather than splitting pending maps.
  const actual = await importOriginal<typeof import('../../../src/main/features/chat_events/interaction-hub')>();
  interactionHub.actual = actual;
  return { ...actual, requestInteraction: interaction };
});
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/features/kb_indexer', () => ({ enqueue: () => {}, kbEvents: { on: () => {}, off: () => {}, emit: () => {} } }));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: () => {}, dropContext: () => {} }));
const uid = 'cognition-editor-user', at = '2026-10-15T00:00:00Z';
const original = '技术说明先给结论，再解释依据。故障排查先给证据。';
let root: string, previous: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-edit-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules(); interaction.mockReset().mockResolvedValue({ interactionId: 'interaction-one', reason: 'answered', decision: 'allow' });
});
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
function host(taskText: string, sourceMessageId = 'message-one') { return { userId: uid, cid: 'chat-one', turnId: 'turn-one', sourceMessageId, sourceMessageFromUser: true, taskText }; }
async function setup(unified = true) {
  const bridge = await import('../../../src/main/features/cognition_bridge');
  const store = await import('../../../src/main/features/recall/store');
  const ontology = await import('../../../src/main/features/cognition/ontology/service');
  const assets = await import('../../../src/main/features/recall/asset-service');
  const editor = await import('../../../src/main/features/cognition/edit-service');
  if (unified) await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: at });
  await store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-preference', { schemaVersion: 2, ownerId: uid, id: 'aa-preference', candidateId: 'legacy-candidate', reviewDecisionId: 'legacy-untracked',
    type: 'cognition', contentCategory: 'preference', title: '技术说明偏好', statement: original, evidenceRefs: [], origin: 'manual', status: 'active', maturity: 'seed', lifecycleStatus: 'automatically_extracted_unverified',
    scope: 'general', version: '1', applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'], createdAt: at, updatedAt: at });
  if (unified) {
    await ontology.commitOntologyCommand(uid, { commandId: 'seed-module', expectedRevision: 0, actions: [{ intent: 'create', recordId: 'personal', sourceLabel: 'fixture', record: { kind: 'module', name: '个人本体', description: '', scope: { kind: 'personal' } } }] });
    await ontology.commitOntologyCommand(uid, { commandId: 'seed-rule', expectedRevision: 1, actions: [{ intent: 'create', recordId: 'rule-one', sourceLabel: 'fixture', record: { kind: 'rule', moduleId: 'personal', name: '说明规则', requirement: original, strength: 'default', condition: null, effect: { kind: 'note' }, exception: '' } }] });
    // Bind ownership as an actual canonical relation, not a read-time mock.
    await bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology!.records['rule-one'].source.refs = [{ kind: 'asset', id: 'aa-preference' }]; },
      () => store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old!, ontologyRefs: [{ groupId: 'personal', moduleId: 'personal', recordId: 'rule-one', versionPolicy: 'current', sharedBody: true }] })));
  }
  return { bridge, store, ontology, assets, editor };
}
async function fullSave(env: Awaited<ReturnType<typeof setup>>) {
  return env.editor.editCognition(uid, host('请修改技术说明偏好，补上“结尾列出待核问题”。'), { target: { assetId: 'aa-preference' }, fields: { statement: original + '结尾列出待核问题。' }, reason: '用户要求补充' });
}

describe('host cognition edits', () => {
  it('legacy edit tool stops a real bridged approval and rejects a late allow', async () => {
    const env = await setup();
    const hub = interactionHub.actual!;
    interaction.mockImplementation(hub.requestInteraction);
    let requested!: (id: string) => void;
    const request = new Promise<string>(resolve => { requested = resolve; });
    hub._setBroadcastForTest((_uid, event: any) => { if (event.type === 'chat.interaction.requested') requested(event.interactionId); });
    const controller = new AbortController(), commitStarted = vi.fn();
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const body = original + '结尾列出待核问题。';
    const tool = createAssetStewardTools(host(`请把这条改成：${body}`, 'synthetic-legacy-stop')).find(tool => tool.name === 'edit_ability_asset')!;
    const before = env.ontology.readOntologyDocument(uid);
    try {
      const pending = tool.execute({ assetId: 'aa-preference', fields: { body }, origin: 'user_instruction', reason: '合成旧入口取消场景' },
        { signal: controller.signal, beginAtomicCommit: commitStarted, state: {} });
      const id = await request;
      controller.abort();
      expect(hub.respondInteraction(id, { decision: 'allow' })).toBe(false);
      expect(await pending).toMatchObject({ isError: true, content: expect.stringContaining('blocked') });
      expect(commitStarted).not.toHaveBeenCalled();
      expect(hub.pendingInteractionCount()).toBe(0);
      expect(await env.assets.readAbilityAsset(uid, 'aa-preference')).toMatchObject({ version: '1', statement: original });
      expect(env.ontology.readOntologyDocument(uid)).toEqual(before);
      expect((await env.store.createRecallCollectionReader(uid, 'candidates')).ids).toEqual([]);
    } finally {
      hub.cancelInteractionsForTurn('turn-one', { uid, cid: 'chat-one' });
      hub._setBroadcastForTest(null);
    }
  });
  it('legacy edit tool forwards the committed-write handshake and retains the real receipt after Stop', async () => {
    const env = await setup();
    const controller = new AbortController(), commitStarted = vi.fn();
    const update = env.store.updateRecallJsonRecord;
    vi.spyOn(env.store, 'updateRecallJsonRecord').mockImplementation(async (...args) => {
      const result = await update(...args);
      if (args[1] === 'ability-assets') {
        expect(commitStarted).toHaveBeenCalledTimes(1);
        controller.abort();
      }
      return result;
    });
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const body = original + '结尾列出待核问题。';
    const tool = createAssetStewardTools(host(`请把这条改成：${body}`, 'synthetic-legacy-committed')).find(tool => tool.name === 'edit_ability_asset')!;
    const result = await tool.execute({ assetId: 'aa-preference', fields: { body }, origin: 'user_instruction', reason: '合成旧入口已提交场景' },
      { signal: controller.signal, beginAtomicCommit: commitStarted, state: {} });
    expect(controller.signal.aborted).toBe(true);
    expect(commitStarted).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    const receipt = JSON.parse(result.content);
    expect(receipt).toMatchObject({ status: 'applied', version: '2', decisionId: expect.any(String) });
    const saved = await env.assets.readAbilityAsset(uid, 'aa-preference');
    expect(saved).toMatchObject({ statement: body, userEditDecision: { id: receipt.decisionId } });
    expect(env.ontology.readOntologyDocument(uid).records['rule-one']).toMatchObject({ requirement: body });
  });

  it('stops a real edit approval and ignores a late allow without changing the asset or shared rule', async () => {
    const env = await setup();
    const hub = interactionHub.actual!;
    interaction.mockImplementation(hub.requestInteraction);
    let requested!: (id: string) => void;
    const request = new Promise<string>(resolve => { requested = resolve; });
    hub._setBroadcastForTest((_uid, event: any) => { if (event.type === 'chat.interaction.requested') requested(event.interactionId); });
    const controller = new AbortController();
    const { createCognitionEditTools } = await import('../../../src/main/model/core-agent/cognition-edit-tools');
    const commitStarted = vi.fn();
    const tool = createCognitionEditTools(host('请修改技术说明偏好，补上“结尾列出待核问题”。'))[0];
    const before = env.ontology.readOntologyDocument(uid);
    try {
      const pending = tool.execute({ target: { assetId: 'aa-preference' }, fields: { statement: original + '结尾列出待核问题。' }, reason: '合成取消场景' }, { signal: controller.signal, beginAtomicCommit: commitStarted, state: {} });
      const id = await request;
      controller.abort();
      expect(hub.respondInteraction(id, { decision: 'allow' })).toBe(false);
      expect(await pending).toMatchObject({ isError: true, content: expect.stringContaining('blocked') });
      expect(hub.pendingInteractionCount()).toBe(0);
      expect(commitStarted).not.toHaveBeenCalled();
      expect(await env.assets.readAbilityAsset(uid, 'aa-preference')).toMatchObject({ version: '1', statement: original });
      expect(env.ontology.readOntologyDocument(uid)).toEqual(before);
      expect((await env.store.createRecallCollectionReader(uid, 'candidates')).ids).toEqual([]);
    } finally {
      hub.cancelInteractionsForTurn('turn-one', { uid, cid: 'chat-one' });
      hub._setBroadcastForTest(null);
    }
  });
  it.each(['asset-record', 'store', 'ontology-store'] as const)('does not save after cancellation while waiting for the %s lock', async lockKind => {
    const env = await setup();
    const { fileEditLock } = await import('../../../src/main/util/locks');
    const { cognitionStorePath } = await import('../../../src/main/features/cognition_kernel/store');
    const { recallJsonRecordPath } = await import('../../../src/main/features/recall/paths');
    const lock = fileEditLock(lockKind === 'asset-record' ? recallJsonRecordPath(uid, 'ability-assets', 'aa-preference') : cognitionStorePath(uid));
    const release = await lock.acquire();
    const run = lock.runExclusive.bind(lock);
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(lock, 'runExclusive').mockImplementation((...args) => { reached(); return run(...args); });
    const controller = new AbortController();
    const before = env.ontology.readOntologyDocument(uid);
    const context = { ...host(lockKind === 'ontology-store' ? '请修改个人本体的描述。' : '请修改技术说明偏好，补上“结尾列出待核问题”。'), signal: controller.signal };
    const result = env.editor.editCognition(uid, context, lockKind === 'ontology-store'
      ? { target: { ontologyRecordId: 'personal' }, fields: { description: '合成模块新描述' }, reason: '合成取消场景' }
      : { target: { assetId: 'aa-preference' }, fields: { statement: original + '结尾列出待核问题。' }, reason: '合成取消场景' }).catch(error => error);
    await waiting;
    controller.abort();
    release();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(await env.assets.readAbilityAsset(uid, 'aa-preference')).toMatchObject({ version: '1', statement: original });
    expect(env.ontology.readOntologyDocument(uid)).toEqual(before);
  });
  it.each([true, false])('keeps the real saved receipt after Stop when unified storage is %s', async unified => {
    const env = await setup(unified);
    const update = env.store.updateRecallJsonRecord;
    const controller = new AbortController();
    vi.spyOn(env.store, 'updateRecallJsonRecord').mockImplementation(async (...args) => {
      const result = await update(...args);
      if (args[1] === 'ability-assets') controller.abort();
      return result;
    });
    const result = await env.editor.editCognition(uid, { ...host('请修改技术说明偏好，补上“结尾列出待核问题”。'), signal: controller.signal }, {
      target: { assetId: 'aa-preference' }, fields: { statement: original + '结尾列出待核问题。' }, reason: '合成已提交取消场景' });
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'applied', version: '2', decisionId: expect.any(String) });
    const asset = await env.assets.readAbilityAsset(uid, 'aa-preference');
    expect(asset).toMatchObject({ version: '2', userEditDecision: { id: result.decisionId } });
    if (unified) expect(env.ontology.readOntologyDocument(uid).records['rule-one']).toMatchObject({ requirement: asset.statement });
    expect(JSON.stringify(asset)).not.toContain('signal');
  });

  it('confirms a complete new contract once, then preserves exact human patches and ordinary next-turn authority', async () => {
    const env = await setup();
    const authority = await import('../../../src/main/features/recall/standing-preference');
    const runtime = await import('../../../src/main/features/recall/prompt-injection');
    const unreviewed = await env.assets.readAbilityAsset(uid, 'aa-preference');
    expect(await authority.hasUserAuthorizedStandingPreference(uid, unreviewed)).toBe(false);
    expect(await runtime.evaluateRecallAssetRuntimeEligibility(uid, unreviewed, { operation: 'default_injection', taskText: '技术说明', scope: 'general' })).toMatchObject({ eligible: false, reasons: ['maturity_below_default_use'] });
    const first = await fullSave(env);
    expect(first).toMatchObject({ status: 'applied', version: '2' });
    expect(interaction).toHaveBeenCalledTimes(1);
    expect(interaction.mock.calls[0][0].detail).toContain('日常问候');
    let current = await env.assets.readAbilityAsset(uid, 'aa-preference');
    expect(current).toMatchObject({ maturity: 'seed', lifecycleStatus: 'user_confirmed_unverified', standingPreferenceAuthority: { rootKind: 'edit', method: 'human_instruction_edit' } });
    expect(await authority.hasUserAuthorizedStandingPreference(uid, current)).toBe(true);
    const withoutProof = { ...current, standingPreferenceAuthority: undefined };
    expect(await authority.hasUserAuthorizedStandingPreference(uid, withoutProof)).toBe(false);
    expect(await runtime.evaluateRecallAssetRuntimeEligibility(uid, withoutProof, { operation: 'default_injection', taskText: '技术说明', scope: 'general' })).toMatchObject({ eligible: false, reasons: ['maturity_below_default_use'] });
    const input = { target: { assetId: current.id }, replaceText: { before: '先给结论', after: '先列结论' }, expectedVersion: current.version, expectedActiveVersion: current.version, reason: '本人精确修改' };
    const request = host('请把技术说明偏好中的“先给结论”改成“先列结论”，其他条件不变。', 'message-two');
    const second = await env.editor.editCognition(uid, request, input);
    expect(second).toMatchObject({ status: 'applied', version: '3' });
    expect(interaction).toHaveBeenCalledTimes(1);
    current = await env.assets.readAbilityAsset(uid, current.id);
    expect(current.maturity).toBe('seed');
    expect(current.statement).toContain('先列结论');
    expect(current.forbiddenWhen).toEqual(['日常问候']);
    expect(await authority.hasUserAuthorizedStandingPreference(uid, current)).toBe(true);
    expect(env.ontology.readOntologyDocument(uid).records['rule-one']).toMatchObject({ requirement: current.statement });
    const retry = await env.editor.editCognition(uid, request, input);
    expect(retry).toMatchObject({ status: 'applied', duplicate: true });
    expect((await env.assets.readAbilityAsset(uid, current.id)).version).toBe('3');
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const body = current.statement.replace('先列结论', '先概述结论');
    const legacy = createAssetStewardTools(host(`请把技术说明偏好改成：${body}`, 'legacy-editor')).find(tool => tool.name === 'edit_ability_asset')!;
    const legacyResult = await legacy.execute({ assetId: current.id, fields: { body }, origin: 'user_instruction', reason: '旧工具不传新增版本字段' }) as any;
    expect(JSON.parse(legacyResult.content)).toMatchObject({ status: 'applied', version: '4' });
    expect(interaction).toHaveBeenCalledTimes(1);
    current = await env.assets.readAbilityAsset(uid, current.id);
    expect(current.maturity).toBe('seed');
    expect(await authority.hasUserAuthorizedStandingPreference(uid, current)).toBe(true);
    expect((await env.assets.listAbilityAssetVersions(uid, current.id)).every(row => row.snapshot.maturity === 'seed')).toBe(true);
    // The ordinary injection gate, not an explicit pin, accepts the new body.
    expect(await runtime.evaluateRecallAssetRuntimeEligibility(uid, current, { operation: 'default_injection', taskText: '解释技术方案', scope: 'general' })).toMatchObject({ eligible: true });
  });

  it('does not treat a background target or same-name asset as direct authorization', async () => {
    const env = await setup(); await fullSave(env);
    const before = await env.assets.readAbilityAsset(uid, 'aa-preference');
    interaction.mockResolvedValueOnce({ interactionId: 'wrong-target-denied', reason: 'answered', decision: 'deny' });
    const wrong = await env.editor.editCognition(uid, host('技术说明偏好目前是先给结论，请将资产B改为先给证据。', 'background-message'), {
      target: { assetId: before.id }, fields: { statement: '先给证据' }, reason: '模型选错目标' });
    expect(wrong.status).toBe('blocked');
    expect((await env.assets.readAbilityAsset(uid, before.id)).statement).toBe(before.statement);
    interaction.mockResolvedValueOnce({ interactionId: 'wrong-value-denied', reason: 'answered', decision: 'deny' });
    const wrongValue = await env.editor.editCognition(uid, host('请把技术说明偏好改为“先给结论”。资产B的旧正文是“先给证据”。', 'background-value'), {
      target: { assetId: before.id }, fields: { statement: '先给证据' }, reason: '模型从背景抽取了错误新值' });
    expect(wrongValue.status).toBe('blocked');
    expect((await env.assets.readAbilityAsset(uid, before.id)).statement).toBe(before.statement);
    interaction.mockResolvedValueOnce({ interactionId: 'partial-value-denied', reason: 'answered', decision: 'deny' });
    const partialValue = await env.editor.editCognition(uid, host('请把技术说明偏好改为先给结论或先给证据。', 'partial-value'), {
      target: { assetId: before.id }, fields: { statement: '先给证据' }, reason: '不能把完整新值中的尾部当作用户精确改文' });
    expect(partialValue.status).toBe('blocked');
    expect((await env.assets.readAbilityAsset(uid, before.id)).statement).toBe(before.statement);
    interaction.mockResolvedValueOnce({ interactionId: 'wrong-field-denied', reason: 'answered', decision: 'deny' });
    const wrongField = await env.editor.editCognition(uid, host('请把技术说明偏好的标题改成“简明说明”。', 'wrong-field'), {
      target: { assetId: before.id }, fields: { statement: '简明说明' }, reason: '模型不能把改标题换成改正文' });
    expect(wrongField.status).toBe('blocked');
    expect((await env.assets.readAbilityAsset(uid, before.id)).statement).toBe(before.statement);
    await env.store.writeRecallJsonRecord(uid, 'ability-assets', 'aa-same-name', { ...before, id: 'aa-same-name', candidateId: 'same-name-candidate', ontologyRefs: [], standingPreferenceAuthority: undefined, userEditDecision: undefined });
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const read = createAssetStewardTools(host('请查看技术说明偏好。')).find(tool => tool.name === 'read_ability_asset')!;
    const result = await read.execute({ assetId: before.id, mode: 'manage' }) as any;
    expect(result.content).toContain('ambiguous'); expect(result.content).not.toContain(original);
    await expect(env.editor.editCognition(uid, host('请把技术说明偏好改成先给证据。'), { target: { assetId: before.id }, fields: { statement: '先给证据' }, reason: '同名未选定' })).rejects.toMatchObject({ code: 'ambiguous_identity' });
  });

  it('routes a shared R edit back to its asset and saves R fields and body atomically', async () => {
    const env = await setup(); await fullSave(env);
    const doc = env.ontology.readOntologyDocument(uid);
    const result = await env.editor.editCognition(uid, host('请修改说明规则：正文改为“技术说明先展示关键证据，再给结论。”，强度调整为required。', 'message-rule'), {
      target: { ontologyRecordId: 'rule-one' }, fields: { requirement: '技术说明先展示关键证据，再给结论。', strength: 'required' }, expectedVersion: doc.records['rule-one'].version,
      expectedOntologyRevision: doc.revision, reason: '本人修改共享规则' });
    expect(result.status).toBe('applied');
    expect(env.ontology.readOntologyDocument(uid).records['rule-one']).toMatchObject({ requirement: '技术说明先展示关键证据，再给结论。', strength: 'required' });
    expect((await env.assets.readAbilityAsset(uid, 'aa-preference')).statement).toBe('技术说明先展示关键证据，再给结论。');
    const beforeTags = await env.assets.readAbilityAsset(uid, 'aa-preference');
    const rule = env.ontology.readOntologyDocument(uid).records['rule-one'];
    const tagsAndRule = await env.editor.editCognition(uid, host('请修改技术说明偏好的标签，并把说明规则的强度调整为suggestion。', 'message-rule-tags'), {
      target: { assetId: beforeTags.id }, fields: { tags: ['技术说明'] }, reason: '同次调整标签元数据和已有关联规则',
      ontologyChanges: [{ intent: 'update', recordId: rule.id, expectedVersion: rule.version, patch: { strength: 'suggestion' }, sourceLabel: '用户调整规则强度' }] });
    expect(tagsAndRule).toMatchObject({ status: 'applied', version: beforeTags.version });
    expect((await env.assets.readAbilityAsset(uid, beforeTags.id)).userEditDecision).toMatchObject({ id: tagsAndRule.decisionId, committedVersion: beforeTags.version });
    expect(env.ontology.readOntologyDocument(uid).receipts[tagsAndRule.decisionId!].userEditDecision).toMatchObject({ id: tagsAndRule.decisionId, committedVersion: beforeTags.version });
  });

  it('allows named paused/owner-only management without ordinary use, and refuses revoked text', async () => {
    const env = await setup(); await fullSave(env);
    await env.assets.pauseAbilityAsset(uid, 'aa-preference', { actor: 'user', reason: '暂停' });
    const steward = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const read = steward.createAssetStewardTools(host('请查看技术说明偏好。')).find(t => t.name === 'read_ability_asset')!;
    expect((await read.execute({ assetId: 'aa-preference', mode: 'manage' }) as any).content).toContain(original);
    const authority = await import('../../../src/main/features/recall/standing-preference');
    expect(await authority.hasUserAuthorizedStandingPreference(uid, await env.assets.readAbilityAsset(uid, 'aa-preference'))).toBe(false);
    await env.ontology.commitOntologyCommand(uid, { commandId: 'private-rule', expectedRevision: env.ontology.readOntologyDocument(uid).revision, actions: [{ intent: 'update', recordId: 'rule-one', expectedVersion: env.ontology.readOntologyDocument(uid).records['rule-one'].version, patch: { access: 'owner_only' }, sourceLabel: 'private' }] });
    const { createOntologyTools } = await import('../../../src/main/model/core-agent/ontology-tools');
    const query = createOntologyTools(host('请查看说明规则。'))[0];
    expect((await query.execute({ mode: 'manage', recordId: 'rule-one' }) as any).content).toContain('owner_only');
    await env.store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old!, status: 'revoked' }));
    const denied = await read.execute({ assetId: 'aa-preference', mode: 'manage' }) as any;
    expect(denied.isError).toBe(true); expect(denied.content).not.toContain(original);
  });

  it('does not borrow an unrelated target, overwrite a concurrent winner, or save after rejection', async () => {
    const env = await setup();
    await expect(env.editor.editCognition(uid, host('请修改另一条偏好。'), { target: { assetId: 'aa-preference' }, fields: { statement: '新的内容' }, reason: '冒用目标' })).rejects.toMatchObject({ code: 'not_authorized' });
    interaction.mockResolvedValueOnce({ interactionId: 'deny', reason: 'answered', decision: 'deny' });
    expect((await fullSave(env)).status).toBe('blocked');
    expect((await env.assets.readAbilityAsset(uid, 'aa-preference')).version).toBe('1');
    interaction.mockImplementationOnce(async () => {
      await env.assets.updateAbilityAsset(uid, 'aa-preference', { statement: '并行修改保留。', actor: 'user', reason: '另一个编辑' });
      return { interactionId: 'stale', reason: 'answered', decision: 'allow' };
    });
    await expect(fullSave(env)).rejects.toMatchObject({ code: 'baseline_changed' });
    expect((await env.assets.readAbilityAsset(uid, 'aa-preference')).statement).toBe('并行修改保留。');
    expect(env.ontology.readOntologyDocument(uid).records['rule-one']).toMatchObject({ requirement: '并行修改保留。' });
  });

  it('retains sources and factual correction history without adding a candidate', async () => {
    const env = await setup();
    const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'fixture' });
    await env.ontology.commitOntologyCommand(uid, { commandId: 'facts', expectedRevision: env.ontology.readOntologyDocument(uid).revision, actions: [
      create('type', { kind: 'definition', moduleId: 'personal', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('entity', { kind: 'entity', moduleId: 'personal', typeId: 'type', name: '示例项目', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('attribute', { kind: 'definition', moduleId: 'personal', name: '人数', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'number', cardinality: 'one', cardinalityAnchor: 'subject' }),
      create('fact', { kind: 'assertion', moduleId: 'personal', subjectId: 'entity', definitionId: 'attribute', object: { kind: 'literal', valueType: 'number', value: 2 }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
    ] });
    const result = await env.editor.editCognition(uid, host('请把示例项目的人数更正为3。', 'fact-message'), { target: { ontologyRecordId: 'fact' }, fields: { object: { kind: 'literal', valueType: 'number', value: 3 } }, factIntent: 'correct', reason: '用户更正' });
    expect(result.status).toBe('applied');
    const doc = env.ontology.readOntologyDocument(uid);
    expect(doc.records.fact).toMatchObject({ status: 'corrected', object: { value: 2 } });
    expect(Object.values(doc.records).find((row: any) => row.supersedesId === 'fact')).toMatchObject({ object: { value: 3 }, status: 'active' });
    const { applyOntologyCommand } = await import('../../../src/main/features/cognition/ontology/commands');
    const cloned = structuredClone(doc); cloned.records.entity.source = { kind: 'candidate', recordId: 'old-candidate', label: 'source', refs: [{ kind: 'asset', id: 'aa-preference' }] };
    const edited = applyOntologyCommand(cloned, { commandId: 'source-preserving', expectedRevision: cloned.revision, actions: [{ intent: 'update', recordId: 'entity', expectedVersion: 1, patch: { name: '项目新名' }, sourceLabel: '用户更名' }] }, at);
    expect(edited.document.records.entity.source.refs).toEqual(expect.arrayContaining([{ kind: 'candidate', id: 'old-candidate' }, { kind: 'asset', id: 'aa-preference' }]));
    expect((await env.store.createRecallCollectionReader(uid, 'candidates')).ids).toEqual([]);
  });

  it('never discloses a revoked merge target through an ontology-only propose preview', async () => {
    const env = await setup();
    const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'fixture' });
    await env.ontology.commitOntologyCommand(uid, { commandId: 'merge-fixture', expectedRevision: env.ontology.readOntologyDocument(uid).revision, actions: [
      create('identity-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('identity-a', { kind: 'entity', moduleId: 'personal', typeId: 'identity-type', name: '甲', description: '', aliases: [], identityStatus: 'confirmed' }),
      create('identity-b', { kind: 'entity', moduleId: 'personal', typeId: 'identity-type', name: '撤权人物机密名', description: '', aliases: ['撤权别名'], identityStatus: 'confirmed' }),
    ] });
    await env.bridge.withCognitionSourceDependency(uid, 'ability-assets', doc => { doc.ontology!.records['identity-b'].source.refs = [{ kind: 'asset', id: 'aa-preference' }]; },
      () => env.store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => old!));
    await env.store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old!, status: 'revoked' }));
    await expect(env.editor.editCognition(uid, host('请修改甲：合并这条重复人物身份。', 'merge-message'), {
      target: { ontologyRecordId: 'identity-a' }, mode: 'propose', reason: '用户说明两个身份重复',
      ontologyChanges: [{ intent: 'merge', recordId: 'identity-a', expectedVersion: 1, targetId: 'identity-b', expectedTargetVersion: 1, sourceLabel: '用户说明两个身份为同一人' }],
    })).rejects.toMatchObject({ code: 'not_authorized' });
    expect(interaction).not.toHaveBeenCalled();
    expect(env.ontology.readOntologyDocument(uid).records['identity-a'].status).toBe('active');
  });

  it('reports an authoritative saved edit when its recoverable version append is interrupted', async () => {
    const env = await setup();
    const append = env.store.appendRecallJsonlRecord;
    let interrupted = false;
    vi.spyOn(env.store, 'appendRecallJsonlRecord').mockImplementation(async (...args) => {
      if (!interrupted && args[1] === 'ability-asset-versions') { interrupted = true; throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); }
      return append(...args);
    });
    const result = await fullSave(env);
    expect(result).toMatchObject({ status: 'applied', version: '2' });
    const saved = await env.assets.readAbilityAsset(uid, 'aa-preference');
    expect(saved.pendingVersionSnapshots).toEqual(expect.arrayContaining([expect.objectContaining({ version: '2', actor: 'user', snapshot: expect.objectContaining({ userEditDecision: expect.objectContaining({ id: result.decisionId }) }) })]));
    const authority = await import('../../../src/main/features/recall/standing-preference');
    expect(await authority.hasUserAuthorizedStandingPreference(uid, saved)).toBe(true);
    expect((await fullSave(env)).duplicate).toBe(true);
    expect((await env.assets.readAbilityAsset(uid, saved.id)).version).toBe('2');
  });

  it('keeps the existing standalone asset save usable before unified migration', async () => {
    const env = await setup(false);
    expect((await fullSave(env)).status).toBe('applied');
    const authority = await import('../../../src/main/features/recall/standing-preference');
    expect(await authority.hasUserAuthorizedStandingPreference(uid, await env.assets.readAbilityAsset(uid, 'aa-preference'))).toBe(true);
  });

  it('saves metadata edits without laundering an unreviewed intermediate body into standing authority', async () => {
    const env = await setup(); await fullSave(env);
    const previousRevision = env.ontology.readOntologyDocument(uid).revision;
    const unreviewed = await env.assets.updateAbilityAsset(uid, 'aa-preference', { statement: '未经本人审阅的新正文。', actor: 'ai', reason: '普通更新不授予默认使用' });
    const syncReceipts = Object.values(env.ontology.readOntologyDocument(uid).receipts).filter(receipt => receipt.revision > previousRevision);
    expect(syncReceipts.length).toBeGreaterThan(0);
    expect(syncReceipts.every(receipt => receipt.userEditDecision === undefined)).toBe(true);
    const authority = await import('../../../src/main/features/recall/standing-preference');
    expect(await authority.hasUserAuthorizedStandingPreference(uid, unreviewed)).toBe(false);
    const result = await env.editor.editCognition(uid, host('请把技术说明偏好的标题改成“简明说明”。', 'metadata-message'), {
      target: { assetId: unreviewed.id }, fields: { title: '简明说明' }, reason: '本人只要求改标题' });
    expect(result).toMatchObject({ status: 'applied', version: '4' });
    expect(interaction).toHaveBeenCalledTimes(1);
    const current = await env.assets.readAbilityAsset(uid, unreviewed.id);
    expect(current).toMatchObject({ title: '简明说明', statement: unreviewed.statement });
    expect(await authority.hasUserAuthorizedStandingPreference(uid, current)).toBe(false);
    const runtime = await import('../../../src/main/features/recall/prompt-injection');
    expect((await runtime.evaluateRecallAssetRuntimeEligibility(uid, current, { operation: 'default_injection', taskText: '解释技术方案', scope: 'general' })).eligible).toBe(false);
  });

  it('keeps every legacy editor branch behind the live source gate without changing enabled aliases or proposals', async () => {
    const env = await setup();
    const source = { kind: 'conversation' as const, taxonomyVersion: 2 as const, subtype: 'message' as const, id: 'private-source' };
    await env.store.updateRecallJsonRecord(uid, 'ability-assets', 'aa-preference', old => ({ ...old!, evidenceRefs: [source] }));
    const controls = await import('../../../src/main/features/recall/source-control');
    await controls.pauseCognitionSource(uid, source);
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const body = '技术说明先列依据，再给结论。';
    const edit = createAssetStewardTools({ userId: uid, taskText: `请把这条改成：${body}`, sourceMessageFromUser: true }).find(tool => tool.name === 'edit_ability_asset')!;
    const titleResult = await edit.execute({ assetId: 'aa-preference', fields: { title: '简明说明' }, origin: 'ai_initiated', reason: '命名调整' }) as any;
    const proposalResult = await edit.execute({ assetId: 'aa-preference', fields: { body }, origin: 'ai_initiated', reason: '正文改进提议' }) as any;
    expect(titleResult.isError).toBe(true); expect(proposalResult.isError).toBe(true);
    expect(titleResult.content + proposalResult.content).not.toContain(original);
    const approvals = await import('../../../src/main/features/recall/asset-approval-service');
    expect(await approvals.listAssetChangeProposals(uid)).toEqual([]);
    expect(await env.assets.readAbilityAsset(uid, 'aa-preference')).toMatchObject({ version: '1', title: '技术说明偏好', statement: original });
    expect(interaction).not.toHaveBeenCalled();
    await controls.resumeCognitionSource(uid, source);
    expect((await edit.execute({ assetId: 'aa-preference', fields: { body }, origin: 'user_instruction', reason: '旧正文别名和省略新参数仍可用' }) as any).isError).toBeUndefined();
    expect((await env.assets.readAbilityAsset(uid, 'aa-preference')).statement).toBe(body);
    expect((await edit.execute({ assetId: 'aa-preference', fields: { title: '简明说明' }, origin: 'ai_initiated', reason: '旧命名路径仍可用' }) as any).isError).toBeUndefined();
    await edit.execute({ assetId: 'aa-preference', fields: { body: '技术说明应保留完整证据。' }, mode: 'propose', reason: '旧审批提议仍可用' });
    expect(await approvals.listAssetChangeProposals(uid)).toEqual([expect.objectContaining({ state: 'pending', beforeValues: { statement: body } })]);
  });

  it('records an empty tags baseline so the approval CAS can tell "no tags" from "not recorded"', async () => {
    await setup();
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const edit = createAssetStewardTools({ userId: uid, taskText: '按建议给这条加标签' })
      .find(tool => tool.name === 'edit_ability_asset')!;
    await edit.execute({ assetId: 'aa-preference', fields: { tags: ['模板'] }, mode: 'propose', origin: 'ai_initiated', reason: '打标' });
    const approvals = await import('../../../src/main/features/recall/asset-approval-service');
    expect(await approvals.listAssetChangeProposals(uid)).toEqual([
      expect.objectContaining({ state: 'pending', payload: { tags: ['模板'] }, beforeValues: { tags: [] } }),
    ]);
  });

  it('distinguishes preserved conditions from a cancelled edit and confirms extra fields bundled with an exact patch', async () => {
    const env = await setup(); await fullSave(env);
    const before = await env.assets.readAbilityAsset(uid, 'aa-preference');
    interaction.mockResolvedValueOnce({ interactionId: 'preservation-preview-denied', reason: 'answered', decision: 'deny' });
    const rewrite = await env.editor.editCognition(uid, host('请再次优化技术说明偏好，把说明写得更详细一些，但不要改变适用和禁用条件。', 'preservation-message'), {
      target: { assetId: before.id }, fields: { statement: before.statement + '补充必要证据。' }, reason: '改写正文而非改变条件' });
    expect(rewrite.status).toBe('blocked');
    expect(interaction).toHaveBeenCalledTimes(2);
    for (const text of ['请不要修改技术说明偏好。', '请先别编辑技术说明偏好。'])
      await expect(env.editor.editCognition(uid, host(text), { target: { assetId: before.id }, fields: { statement: '不应保存' }, reason: '没有编辑授权' })).rejects.toMatchObject({ code: 'not_authorized' });
    expect(interaction).toHaveBeenCalledTimes(2);
    interaction.mockResolvedValueOnce({ interactionId: 'extra-fields-denied', reason: 'answered', decision: 'deny' });
    const extra = await env.editor.editCognition(uid, host('请把技术说明偏好正文中的“先给结论”改成“先列结论”，其他条件不变。', 'patch-extra-fields'), {
      target: { assetId: before.id }, replaceText: { before: '先给结论', after: '先列结论' }, fields: { forbiddenWhen: [] }, reason: '不能借精确正文补丁夹带清空禁用条件' });
    expect(extra.status).toBe('blocked');
    expect(interaction).toHaveBeenCalledTimes(3);
    expect(await env.assets.readAbilityAsset(uid, before.id)).toMatchObject({ version: before.version, statement: before.statement, forbiddenWhen: before.forbiddenWhen });
  });
});


it('edits future use without changing the body, then proposes against the selected content and latest counter', async () => {
  const env = await setup(false);
  const value = '用于技术说明的编排与核对。';
  const result = await env.editor.editCognition(uid, host('请修改技术说明偏好的未来用途'), { target: { assetId: 'aa-preference' }, fields: { value }, reason: 'synthetic future use' });
  expect(result.status).toBe('applied');
  expect(interaction.mock.calls[0][0].detail).toContain(value);
  const saved = await env.assets.readAbilityAsset(uid, 'aa-preference');
  expect(saved).toMatchObject({ value, statement: original, applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'] });
  await env.assets.selectAbilityAssetVersion(uid, saved.id, '1', { actor: 'user', reason: 'synthetic selection' });
  const selected = await env.assets.readAbilityAsset(uid, saved.id);
  const { proposal } = await env.editor.proposePreparedCognitionAssetEdit(uid, selected, { fields: ['value'], payload: { value: '旧版的用途' }, reason: 'synthetic proposal' });
  expect(proposal).toMatchObject({ baselineVersion: saved.version, baselineActiveVersion: '1', payload: { value: '旧版的用途' } });
});


it.each([
  '请把技术说明偏好的用途改为“核对技术说明中的证据与待办”。',
  'Change the purpose of 技术说明偏好 to "核对技术说明中的证据与待办".',
  'Altere a finalidade de 技术说明偏好 para "核对技术说明中的证据与待办".',
])('binds the purpose label to the value field: %s', async taskText => {
  const env = await setup(false);
  const result = await env.editor.editCognition(uid, host(taskText), {
    target: { assetId: 'aa-preference' }, fields: { value: '核对技术说明中的证据与待办' }, reason: 'synthetic purpose edit',
  });
  expect(result.status).toBe('applied');
  expect(interaction).not.toHaveBeenCalled();
  expect(await env.assets.readAbilityAsset(uid, 'aa-preference')).toMatchObject({
    value: '核对技术说明中的证据与待办', statement: original, applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'],
  });
});
