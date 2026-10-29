import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const interaction = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/features/chat_events/interaction-hub', async original => ({ ...await original<typeof import('../../../src/main/features/chat_events/interaction-hub')>(), requestInteraction: interaction }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../../src/main/features/recall/store-events', () => ({ notifyCognitionWrite: vi.fn() }));
vi.mock('../../../src/main/features/kb_indexer', () => ({ enqueue: () => {}, kbEvents: { on: () => {}, off: () => {}, emit: () => {} } }));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: () => {}, dropContext: () => {}, invalidateChatDisplayCatalog: () => {} }));
const uid = 'human-create-user', cid = 'human-create-chat', mid = 'human-create-message';
const statement = '解释技术问题时先给结论，再说明依据；日常问候不要套用。';
const userText = '请新建“技术说明偏好”，供后续技术说明使用；先完整预览，确认后保存。';
let root: string, previous: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-create-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  vi.resetModules(); interaction.mockReset().mockResolvedValue({ interactionId: 'human-create-interaction', reason: 'answered', decision: 'allow' });
  vi.stubEnv('COGSEED_RECALL_BASELINE_TOP', '0'); vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '0');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
async function setup(text = userText) {
  const bridge = await import('../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(uid, { mode: 'unified', revision: 1, records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
  const chats = await import('../../../src/main/features/chats');
  await chats.createConversation(uid, { conversationId: cid, title: '本人创建认知', kind: 'normal' });
  const { conversationMessageFile } = await import('../../../src/main/util/project-layout');
  const { appendJsonlAtomic } = await import('../../../src/main/storage');
  const file = conversationMessageFile(uid, cid);
  await appendJsonlAtomic(file, { id: mid, from: 'user', to: ['commander'], text, ts: new Date().toISOString() });
  const editor = await import('../../../src/main/features/cognition/create-service');
  const assets = await import('../../../src/main/features/recall/asset-service');
  const candidates = await import('../../../src/main/features/recall/candidate-service');
  const ontology = await import('../../../src/main/features/cognition/ontology/service');
  const store = await import('../../../src/main/features/recall/store');
  return { editor, assets, candidates, ontology, store, file, host: { cid, turnId: 'human-create-turn', sourceMessageId: mid, sourceMessageFromUser: true, taskText: text } };
}
function cognition() { return { title: '技术说明偏好', statement, value: '后续技术说明遵循本人表达顺序和使用边界。', scope: 'general', contentCategory: 'preference' as const, applicableWhen: ['技术说明'], forbiddenWhen: ['日常问候'] }; }
function joint() {
  return { target: 'joint' as const, cognition: cognition(), reason: '本人明确创建偏好及共享规则', ontologyChanges: { reason: '同次建立本体与共享回答规则', actions: [
    { intent: 'create' as const, recordId: 'personal-created', sourceLabel: '本人明确新建', record: { kind: 'module' as const, name: '个人表达本体', description: '本人确认的表达要求', scope: { kind: 'personal' as const } } },
    { intent: 'create' as const, recordId: 'rule-created', sourceLabel: '本人明确新建', record: { kind: 'rule' as const, moduleId: 'personal-created', name: '技术说明顺序', requirement: statement, strength: 'default' as const, condition: null, effect: { kind: 'note' as const }, exception: '日常问候不适用' } },
  ], refs: [{ moduleId: 'personal-created', recordId: 'rule-created', versionPolicy: 'current' as const, sharedBody: true }] } };
}
describe('host-confirmed conversational creation', () => {
  it('stops a real creation approval and ignores a late allow from the cancelled turn', async () => {
    const env = await setup();
    const hub = await vi.importActual<typeof import('../../../src/main/features/chat_events/interaction-hub')>('../../../src/main/features/chat_events/interaction-hub');
    interaction.mockImplementation(hub.requestInteraction);
    const events: any[] = [];
    let requested!: (id: string) => void;
    const request = new Promise<string>(resolve => { requested = resolve; });
    hub._setBroadcastForTest((_uid, event: any) => { events.push(event); if (event.type === 'chat.interaction.requested') requested(event.interactionId); });
    const controller = new AbortController();
    const { createCognitionCreateTools } = await import('../../../src/main/model/core-agent/cognition-create-tools');
    const commitStarted = vi.fn();
    const tool = createCognitionCreateTools({ ...env.host, userId: uid })[0];
    try {
      const pending = tool.execute(joint(), { signal: controller.signal, beginAtomicCommit: commitStarted, state: {} });
      const id = await request;
      controller.abort();
      expect(hub.respondInteraction(id, { decision: 'allow' })).toBe(false);
      expect(await pending).toMatchObject({ isError: true, content: expect.stringContaining('blocked') });
      expect(events).toContainEqual(expect.objectContaining({ type: 'chat.interaction.closed', interactionId: id, reason: 'turnCancelled' }));
      expect(hub.pendingInteractionCount()).toBe(0);
      expect(commitStarted).not.toHaveBeenCalled();
      expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
      expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
      expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
    } finally { hub._setBroadcastForTest(null); }
  });
  it.each(['transition', 'candidate-save', 'store'] as const)('does not create formal content after cancellation while waiting for the %s lock', async lockKind => {
    const env = await setup();
    const { fileEditLock } = await import('../../../src/main/util/locks');
    const { userCognitionDir } = await import('../../../src/main/paths');
    const { cognitionStorePath } = await import('../../../src/main/features/cognition_kernel/store');
    const { recallJsonRecordPath } = await import('../../../src/main/features/recall/paths');
    const lock = fileEditLock(lockKind === 'store' ? cognitionStorePath(uid) : lockKind === 'candidate-save'
      ? recallJsonRecordPath(uid, 'candidate-locks', 'save') : path.join(userCognitionDir(uid), 'cognition-transition'));
    const release = await lock.acquire();
    const run = lock.runExclusive.bind(lock);
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    vi.spyOn(lock, 'runExclusive').mockImplementation((...args) => { reached(); return run(...args); });
    const controller = new AbortController();
    const result = env.editor.createCognition(uid, { ...env.host, signal: controller.signal }, joint()).catch(error => error);
    await waiting;
    controller.abort();
    release();
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
  });
  it('finishes a creation and returns the durable joint receipt when Stop follows its first committed record', async () => {
    const env = await setup();
    const bridge = await import('../../../src/main/features/cognition_bridge');
    const persist = bridge.persistCognitionSource;
    const controller = new AbortController();
    vi.spyOn(bridge, 'persistCognitionSource').mockImplementation(async (...args) => {
      await persist(...args);
      if (args[1] === 'candidates') controller.abort();
    });
    const commitStarted = vi.fn();
    const result = await env.editor.createCognition(uid, { ...env.host, signal: controller.signal, onCommitStarted: commitStarted }, joint());
    expect(commitStarted).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
    expect(result).toMatchObject({ status: 'applied', version: '1', receiptId: expect.any(String) });
    const asset = await env.assets.readAbilityAsset(uid, result.assetId!);
    const candidate = await env.candidates.readRecallCandidate(uid, result.candidateId!);
    expect(candidate).toMatchObject({ status: 'confirmed', promotedAssetId: asset.id });
    expect(env.ontology.readOntologyDocument(uid).records['rule-created']).toMatchObject({ requirement: asset.statement });
    expect(JSON.stringify(asset)).not.toContain('signal');
  });

  it('reports canonical field paths for malformed joint creation without repairing or confirming it', async () => {
    const env = await setup();
    const malformed = () => ({ target: 'joint' as const, cognition: cognition(), reason: '本人新建认知和共享规则', expectedOntologyRevision: 0,
      ontologyChanges: { reason: '同时建立同正文共享规则', actions: [{ intent: 'create' as const, recordId: 'rule-review-example', moduleId: 'personal', sourceLabel: '本人明确创建',
        record: { moduleId: 'personal', name: '示例复盘规则', description: '不属于rule记录的description', requirement: statement,
          strength: 'default', condition: null, effect: { kind: 'note' }, exception: '', scope: { kind: 'personal' } } }],
      refs: [{ moduleId: 'personal', recordId: 'rule-review-example', versionPolicy: 'current' as const, sharedBody: true }] } });
    const missingKind = await env.editor.createCognition(uid, env.host, malformed()).catch(error => error);
    expect(missingKind).toMatchObject({ code: 'invalid_input', details: { issues: expect.arrayContaining([
      expect.objectContaining({ path: 'ontologyChanges.actions.0.moduleId' }),
      expect.objectContaining({ path: 'ontologyChanges.actions.0.record.kind' }),
    ]) } });
    // Even an otherwise complete rule shape is not permission to infer kind.
    const discriminatorOnly = malformed();
    delete (discriminatorOnly.ontologyChanges.actions[0] as Record<string, unknown>).moduleId;
    delete (discriminatorOnly.ontologyChanges.actions[0].record as Record<string, unknown>).description;
    delete (discriminatorOnly.ontologyChanges.actions[0].record as Record<string, unknown>).scope;
    await expect(env.editor.createCognition(uid, env.host, discriminatorOnly)).rejects.toMatchObject({ details: { issues: expect.arrayContaining([
      expect.objectContaining({ path: 'ontologyChanges.actions.0.record.kind' }),
    ]) } });
    const wrongFields = malformed();
    Object.assign(wrongFields.ontologyChanges.actions[0].record, { kind: 'rule' });
    const extraFields = await env.editor.createCognition(uid, env.host, wrongFields).catch(error => error);
    expect(extraFields).toMatchObject({ code: 'invalid_input', details: { issues: expect.arrayContaining([
      expect.objectContaining({ path: 'ontologyChanges.actions.0.moduleId' }),
      expect.objectContaining({ path: 'ontologyChanges.actions.0.record.description' }),
      expect.objectContaining({ path: 'ontologyChanges.actions.0.record.scope' }),
    ]) } });
    expect(interaction).not.toHaveBeenCalled();
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
  });
  it('does not downgrade an explicitly requested shared-body creation to cognition only', async () => {
    const env = await setup(`请新建并保存一条“示例复盘偏好”，正文是“${statement}”。在已有“个人本体”中同时建立“示例复盘规则”，与这条认知共用同一正文。保存前请让我确认完整正文、条件、范围和关联本体。`);
    await expect(env.editor.createCognition(uid, env.host, { target: 'cognition', cognition: cognition(), reason: '联合提案失败后只保存认知' }))
      .rejects.toMatchObject({ code: 'not_authorized', details: { requiredTarget: 'joint' } });
    expect(interaction).not.toHaveBeenCalled();
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
  });
  it('keeps the explicit canonical shared-body selector and reaches the complete joint preview', async () => {
    const env = await setup();
    const input = joint();
    const rule = input.ontologyChanges.actions[1].record as Record<string, unknown>;
    delete rule.requirement;
    rule.requirementSource = 'cognition_body';
    const original = structuredClone(input);
    const result = await env.editor.createCognition(uid, env.host, { ...input, mode: 'propose' });
    expect(result).toMatchObject({ status: 'pending_confirmation', preview: expect.stringContaining(statement) });
    expect(result.preview).toContain('技术说明顺序');
    expect(input).toEqual(original);
    expect(interaction).not.toHaveBeenCalled();
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
  });
  it('creates a source-bound preference once and permits ordinary next-turn use without inventing nightly evidence', async () => {
    const env = await setup();
    const input = { target: 'cognition' as const, cognition: cognition(), reason: '本人新建长期技术说明偏好' };
    const result = await env.editor.createCognition(uid, env.host, input);
    expect(result).toMatchObject({ status: 'applied', version: '1', activeVersion: '1' });
    expect(interaction).toHaveBeenCalledTimes(1);
    expect(interaction.mock.calls[0][0]).toMatchObject({ allowAlways: false });
    expect(interaction.mock.calls[0][0].detail).toContain(statement);
    expect(interaction.mock.calls[0][0].detail).toContain('日常问候');
    const candidate = await env.candidates.readRecallCandidate(uid, result.candidateId!);
    expect(candidate).toMatchObject({ status: 'confirmed', origin: 'human_instruction', humanInstructionProvenance: { pipeline: 'human_instruction', sourceMessageId: mid } });
    expect(candidate.captureProvenance).toBeUndefined();
    const asset = await env.assets.readAbilityAsset(uid, result.assetId!);
    expect(asset).toMatchObject({ statement, maturity: 'bud', lifecycleStatus: 'user_confirmed_unverified', version: '1' });
    const { buildRecallTurnPromptContext } = await import('../../../src/main/features/recall/prompt-injection');
    const context = await buildRecallTurnPromptContext(uid, { cid: 'ordinary-create-next-turn', taskRunId: 'ordinary-create-turn', taskText: '请做技术说明：数据库索引是什么？', agentId: 'commander', conversationKind: 'normal' });
    expect(context.citations).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: result.assetId, version: '1', matchMethod: 'standing_preference' })]));
    expect(context.promptBlock).toContain(statement);
    const retry = await env.editor.createCognition(uid, env.host, input);
    expect(retry).toMatchObject({ status: 'applied', duplicate: true, assetId: result.assetId, receiptId: result.receiptId });
    expect(interaction).toHaveBeenCalledTimes(1);
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(1);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(1);
    await expect(env.candidates.saveRecallCandidate(uid, { judgment: statement, summary: cognition().title, value: cognition().value, suggestedType: 'cognition', suggestedScope: 'general', suggestedAction: 'create', sourceRefs: candidate.sourceRefs, evidenceRefs: candidate.evidenceRefs, humanInstructionProvenance: candidate.humanInstructionProvenance, captureKey: candidate.captureKey })).rejects.toThrow();
  });
  it('keeps preview-only and cancelled creation free of candidate, asset and ontology writes', async () => {
    const text = '请先预览这条新认知的草稿，暂不保存。';
    const env = await setup(text);
    const proposed = await env.editor.createCognition(uid, env.host, { target: 'cognition', cognition: cognition(), mode: 'propose', reason: '仅查看草稿' });
    expect(proposed).toMatchObject({ status: 'pending_confirmation', preview: expect.stringContaining(statement) });
    expect(interaction).not.toHaveBeenCalled();
    await expect(env.editor.createCognition(uid, env.host, { target: 'cognition', cognition: cognition(), reason: '不能借预览升级为保存' })).rejects.toThrow();
    const originalMessage = JSON.parse(fs.readFileSync(env.file, 'utf8').trim());
    fs.writeFileSync(env.file, JSON.stringify({ ...originalMessage, text: userText }) + '\n');
    interaction.mockResolvedValueOnce({ interactionId: 'cancel-create', reason: 'answered', decision: 'deny' });
    const cancelled = await env.editor.createCognition(uid, { ...env.host, taskText: userText }, joint());
    expect(cancelled.status).toBe('blocked');
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
  });
  it('commits a complete T and shared R with its asset, and supports ontology-only creation without a synthetic asset', async () => {
    const env = await setup();
    const result = await env.editor.createCognition(uid, env.host, joint());
    expect(result.status).toBe('applied');
    const asset = await env.assets.readAbilityAsset(uid, result.assetId!);
    const doc = env.ontology.readOntologyDocument(uid);
    expect(doc.records['rule-created']).toMatchObject({ requirement: asset.statement, source: { refs: expect.arrayContaining([{ kind: 'asset', id: asset.id }]) } });
    expect(asset.ontologyRefs).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: 'rule-created', sharedBody: true })]));
    expect(interaction).toHaveBeenCalledTimes(1);
    const ontologyOnly = await env.editor.createCognition(uid, env.host, { target: 'ontology', explanation: { title: '项目本体', description: '本人新建项目事实的本体模块。', value: '后续项目对象和事实有明确的归属。', scope: 'general' },
      reason: '本人单独创建本体', expectedOntologyRevision: doc.revision,
      ontologyChanges: { reason: '建立独立本体模块', actions: [{ intent: 'create', recordId: 'independent-module', sourceLabel: '本人完整确认', record: { kind: 'module', name: '独立本体', description: '后续事实归属', scope: { kind: 'personal' } } }] } });
    expect(ontologyOnly).toMatchObject({ status: 'applied', recordIds: ['independent-module'] });
    expect(ontologyOnly.assetId).toBeUndefined();
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(1);
    const { assessOntologySources } = await import('../../../src/main/features/cognition/ontology/source-admission');
    expect((await assessOntologySources(uid, env.ontology.readOntologyDocument(uid))).get('independent-module')).toBe('allowed');
  });
  it.each(['deleted', 'edited'] as const)('blocks task reads, injection, dispatch and shared rules when the source is %s without a control record', async change => {
    const env = await setup();
    const result = await env.editor.createCognition(uid, env.host, joint());
    const asset = await env.assets.readAbilityAsset(uid, result.assetId!);
    expect(asset.evidenceRefs.find(ref => ref.subtype === 'message')).toMatchObject({
      locator: { conversationId: cid, messageId: mid }, sourceVersion: expect.stringMatching(/^sha256:/),
    });
    const { listCognitionSourceControls } = await import('../../../src/main/features/recall/source-control');
    expect(await listCognitionSourceControls(uid)).toEqual([]);
    const prompt = await import('../../../src/main/features/recall/prompt-injection');
    const { assessOntologySources, ontologyWithAdmittedSources } = await import('../../../src/main/features/cognition/ontology/source-admission');
    const { checkOntologyMarkdownWrite } = await import('../../../src/main/features/cognition/ontology/operation-guard');
    const { createAssetStewardTools } = await import('../../../src/main/model/core-agent/asset-steward-tools');
    const task = { taskText: '请做技术说明', agentId: 'commander' };
    const read = createAssetStewardTools({ userId: uid, ...task }).find(tool => tool.name === 'read_ability_asset')!;
    expect((await read.execute({ assetId: asset.id })).isError).toBeUndefined();
    expect(await prompt.filterRecallAssetsForAgentRead(uid, [asset], task)).toHaveLength(1);
    expect((await prompt.buildDispatchedAssetsPromptBlock(uid, [asset.id], task)).assetIds).toEqual([asset.id]);
    expect((await checkOntologyMarkdownWrite(uid, { operation: 'write_file', path: 'synthetic.md', content: '# Example', context: task })).checks)
      .toEqual(expect.arrayContaining([expect.objectContaining({ recordId: 'rule-created' })]));
    const original = fs.readFileSync(env.file, 'utf8');
    const row = JSON.parse(original.trim());
    fs.writeFileSync(env.file, JSON.stringify(change === 'deleted' ? { ...row, deleted_at: new Date().toISOString() }
      : { ...row, text: row.text + ' 原文中的保存依据发生变化。' }) + '\n');
    expect((await prompt.evaluateRecallAssetAgentReadEligibility(uid, asset, task)).reasons).toContain('source_unavailable');
    expect((await read.execute({ assetId: asset.id })).isError).toBe(true);
    expect(await prompt.filterRecallAssetsForAgentRead(uid, [asset], task)).toEqual([]);
    expect((await prompt.buildDispatchedAssetsPromptBlock(uid, [asset.id], task)).assetIds).toEqual([]);
    const injected = await prompt.buildRecallTurnPromptContext(uid, { cid: 'source-use-chat', taskRunId: 'source-use-turn', ...task });
    expect(injected.citations).toEqual([]);
    expect(injected.promptBlock).not.toContain(statement);
    const doc = env.ontology.readOntologyDocument(uid);
    const statuses = await assessOntologySources(uid, doc, task);
    expect(statuses.get('rule-created')).toBe('disabled');
    expect(ontologyWithAdmittedSources(doc, statuses).records['rule-created']).toBeUndefined();
    expect((await checkOntologyMarkdownWrite(uid, { operation: 'write_file', path: 'synthetic.md', content: '# Example', context: task })).checks).toEqual([]);
    expect(await env.assets.readAbilityAsset(uid, asset.id)).toMatchObject({ statement, version: '1', status: 'active' });
    expect(await env.assets.listAbilityAssetVersions(uid, asset.id)).toHaveLength(1);
    // A failed edit restores the original bytes; admission needs no separate state repair.
    fs.writeFileSync(env.file, original);
    expect((await prompt.evaluateRecallAssetAgentReadEligibility(uid, asset, task)).reasons).not.toContain('source_unavailable');
    expect((await assessOntologySources(uid, doc, task)).get('rule-created')).toBe('allowed');
  });
  it('rechecks actual source and canonical baseline after approval and rejects forged origin flags', async () => {
    const env = await setup();
    const { pauseCognitionSource } = await import('../../../src/main/features/recall/source-control');
    interaction.mockImplementationOnce(async () => {
      await pauseCognitionSource(uid, { kind: 'conversation', subtype: 'session', taxonomyVersion: 2, id: cid });
      return { interactionId: 'source-revoked-during-confirm', reason: 'answered', decision: 'allow' };
    });
    await expect(env.editor.createCognition(uid, env.host, joint())).rejects.toThrow();
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    expect(env.ontology.readOntologyDocument(uid).revision).toBe(0);
    await expect(env.candidates.saveRecallCandidate(uid, { manual: true, judgment: statement, summary: '伪造人工来源', value: cognition().value, sourceRefs: [], suggestedType: 'cognition', suggestedScope: 'general' })).rejects.toThrow('retired');
  });
  it('resumes the original fully confirmed draft after a candidate-write interruption without asking again', async () => {
    const env = await setup();
    const write = env.store.updateRecallJsonRecord;
    let interrupted = false;
    const fault = vi.spyOn(env.store, 'updateRecallJsonRecord').mockImplementation(async (...args) => {
      if (!interrupted && args[1] === 'candidates') {
        interrupted = true;
        throw Object.assign(new Error('synthetic candidate write interruption'), { code: 'EIO' });
      }
      return write(...args);
    });
    const input = joint();
    await expect(env.editor.createCognition(uid, env.host, input)).rejects.toThrow('synthetic candidate');
    expect(interaction).toHaveBeenCalledTimes(1);
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(0);
    expect(await env.candidates.listRecallCandidates(uid)).toHaveLength(0);
    fault.mockRestore();
    const result = await env.editor.createCognition(uid, env.host, input);
    expect(result).toMatchObject({ status: 'applied', version: '1' });
    expect(interaction).toHaveBeenCalledTimes(1);
    expect(await env.assets.listAbilityAssets(uid)).toHaveLength(1);
    const candidate = await env.candidates.readRecallCandidate(uid, result.candidateId!);
    const { readReviewDecision } = await import('../../../src/main/features/cognition/review-decision');
    const proof = candidate.humanInstructionProvenance!;
    const reviewed = await readReviewDecision(uid, `cognition_creation:${proof.requestId}`, proof.decisionId);
    expect(JSON.parse(reviewed!.modified_content!).input.ontologyFormation).toEqual(candidate.ontologyFormation);
  });
});
