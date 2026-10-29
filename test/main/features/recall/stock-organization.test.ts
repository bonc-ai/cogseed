import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
const model = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/main/features/recall/capture-model-routing', () => ({ runRecallCaptureModel: model }));
const user = 'stock-test-user';
let root: string, previous: string | undefined;
const oldBody = '提交报告前，必须核对 3 项来源；不得省略失败结果。仅当来源可读时使用；例外：离线草稿。目标：{{目标}}。';
const newBody = '提交报告前，必须核对 3 项来源。不得省略失败结果。\n仅当来源可读时使用；例外：离线草稿。\n目标：{{目标}}。';
const purpose = '编写报告时核对来源和失败结果，检查目标字段是否填写。';
beforeEach(async () => {
  vi.resetModules(); model.mockReset();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-organization-'));
  previous = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root;
  const bridge = await import('../../../../src/main/features/cognition_bridge');
  await bridge.replaceCognitionSources(user, { mode: 'unified', revision: 1,
    records: { 'ability-assets': {}, candidates: {} }, po: { groups: [], trash: [] }, pendingProjection: false, migratedAt: new Date().toISOString() });
});
afterEach(async () => {
  await drainMainRuntimeForTest(user);
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
async function seed(patch: Record<string, unknown> = {}) {
  const assets = await import('../../../../src/main/features/recall/asset-service');
  const now = new Date().toISOString();
  const record = { schemaVersion: 1, ownerId: user, id: 'stock-asset', candidateId: 'seed-candidate',
    reviewDecisionId: 'rd_stockseed123', type: 'rule', title: '报告核对要求', statement: oldBody, origin: 'manual',
    evidenceRefs: [], scope: 'general', status: 'active', lifecycleStatus: 'user_confirmed_unverified', maturity: 'bud',
    version: '1', createdAt: now, updatedAt: now, ...patch } as any;
  // A pre-existing record, not a request to bypass the current creation gate.
  await (await import('../../../../src/main/features/recall/store')).writeRecallJsonRecord(user, 'ability-assets', record.id, record);
  await assets.initializeAbilityAsset(user, record, { actor: 'user', reason: 'Synthetic legacy fixture' });
  return record;
}
function responses(proposal: unknown = { outcome: 'proposal', reason: '将报告核对条件按段落整理，保留数值、否定、例外和模板字段。',
  content: { title: '报告核对要求', statement: newBody } }, supported = true) {
  model.mockImplementation(async (_user, input) => {
    if (input.budget.stage === 'extraction') return { result: { text: JSON.stringify(proposal), meta: {} } };
    const sources = JSON.parse(input.message).sources;
    return { result: { text: JSON.stringify({ supported, noUnsupportedClaims: supported, scopePreserved: true,
      finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label: 'stored-version', quote: sources[0].text.slice(0, 60) }] }), meta: {} } };
  });
}
async function run(controller = new AbortController(), retryFailed = false, excludeRefs?: ReadonlySet<string>) {
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  return stock.runStockOrganization(user, await settings.readRecallCaptureSettings(user), controller.signal, async () => {}, async () => true, { retryFailed, excludeRefs });
}
async function candidate() {
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  return (await candidates.listRecallCandidates(user))[0];
}
function stockJobs(): Array<Record<string, any>> {
  const dir = path.join(root, user, 'cloud', 'recall', 'records', 'stock-organization');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<string, any>);
}
const proposal = { outcome: 'proposal', reason: '将报告核对条件按段落整理，保留数值、否定、例外和模板字段。',
  content: { title: '报告核对要求', statement: newBody } };
function groundingResponse(input: { message: string }) {
  const sources = JSON.parse(input.message).sources;
  return { result: { text: JSON.stringify({ supported: true, noUnsupportedClaims: true, scopePreserved: true,
    finalDecisionPreserved: true, priorContentPreserved: true, evidence: [{ label: 'stored-version', quote: sources[0].text.slice(0, 60) }] }), meta: {} } };
}
describe('stored cognition organization', () => {
  it('keeps an asset with a missing recorded source out of organization', async () => {
    await seed();
    const evidence = await import('../../../../src/main/features/recall/review-evidence');
    const read = vi.spyOn(evidence, 'readReviewEvidence').mockResolvedValue([{ state: 'missing',
      ref: { kind: 'conversation', subtype: 'message', scope: 'conversation', id: 'missing-message' } }]);
    try {
      const stock = await import('../../../../src/main/features/recall/stock-organization');
      expect(await stock.inventoryStockOrganization(user)).toEqual([]);
    } finally { read.mockRestore(); }
  });
  it('retries failed jobs in the same window only on an explicit scan', async () => {
    await seed(); model.mockRejectedValue(new Error('Synthetic connection failure'));
    const first = await run();
    expect(first).toMatchObject({ failed: 1, proposed: 0 });
    expect(Object.values(first.items || {})).toEqual([expect.objectContaining({ status: 'failed', errorCode: 'stock_model_unavailable' })]);
    const failed = stockJobs().find((job) => job.state === 'failed');
    expect(failed).toMatchObject({ failureCode: 'stock_model_unavailable' });
    expect(failed?.failureMessage).toContain('Synthetic connection failure');
    responses();
    expect(await run()).toMatchObject({ failed: 1, proposed: 0 });
    const retried = await run(new AbortController(), true);
    expect(retried).toMatchObject({ proposed: 1, failed: 0 });
    expect(Object.values(retried.items || {})).toEqual([expect.objectContaining({ status: 'completed', candidateId: expect.any(String) })]);
    expect(stockJobs().find((job) => job.state === 'proposed')?.failureCode).toBeUndefined();
  });
  it('skips targets already claimed by the nightly discovery', async () => {
    await seed({ id: 'stock-claimed', candidateId: 'seed-claimed', reviewDecisionId: 'rd_stockclaimed',
      title: '已认领', statement: '已认领的正文，保持原样。' });
    await seed({ id: 'stock-open', candidateId: 'seed-open', reviewDecisionId: 'rd_stockopen',
      title: '未认领', statement: '未认领的正文，保持原样。' });
    responses();
    const progress = await run(new AbortController(), false, new Set(['stock-claimed']));
    expect(progress).toMatchObject({ skippedClaimed: 1 });
    expect(stockJobs().some(job => job.unit?.asset?.id === 'stock-claimed')).toBe(false);
    expect(stockJobs().some(job => job.unit?.asset?.id === 'stock-open')).toBe(true);
  });
  it('keeps an existing suggestion on the round receipt without creating another', async () => {
    await seed();
    const now = new Date().toISOString();
    const store = await import('../../../../src/main/features/recall/store');
    await store.writeRecallJsonRecord(user, 'candidates', 'cand-existing', {
      schemaVersion: 1, ownerId: user, id: 'cand-existing', status: 'pending_review',
      judgment: oldBody, summary: '已有整理建议', suggestedType: 'rule', suggestedScope: 'general',
      suggestedAction: 'update', risk: 'low', sourceRefs: [], createdAt: now, updatedAt: now,
      contentOrganization: { schemaVersion: 1, draft: { operation: 'merge', sourceAssetIds: ['stock-asset'], outputs: [], reason: '已有合并建议' } },
    });
    const progress = await run();
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    expect(progress.candidateIds).toEqual(['cand-existing']);
    expect(progress.items?.['asset-stock-asset']).toMatchObject({ status: 'skipped', errorCode: 'already_has_suggestion', candidateId: 'cand-existing' });
    expect(await candidates.listRecallCandidates(user)).toEqual([expect.objectContaining({ id: 'cand-existing' })]);
    expect(model).not.toHaveBeenCalled();
  });
  it('repairs one invalid extraction output with a bounded contract restatement', async () => {
    await seed();
    let extractions = 0;
    let repairSeen = false;
    model.mockImplementation(async (_user: string, input: any) => {
      if (input.budget.stage === 'extraction') {
        extractions += 1;
        if (extractions === 1) return { result: { text: JSON.stringify({ outcome: 'proposal' }), meta: {} } };
        repairSeen = input.systemPrompt.includes('上一次输出不符合 stock organization');
        return { result: { text: JSON.stringify(proposal), meta: {} } };
      }
      return groundingResponse(input);
    });
    expect(await run()).toMatchObject({ proposed: 1, failed: 0 });
    expect(extractions).toBe(2);
    expect(repairSeen).toBe(true);
  });

  it('repairs one invalid grounding output with a bounded contract restatement', async () => {
    await seed();
    let groundings = 0;
    let repairSeen = false;
    model.mockImplementation(async (_user: string, input: any) => {
      if (input.budget.stage === 'extraction') return { result: { text: JSON.stringify(proposal), meta: {} } };
      groundings += 1;
      if (groundings === 1) return { result: { text: 'not json', meta: {} } };
      repairSeen = input.systemPrompt.includes('上一次输出不符合 grounding');
      return groundingResponse(input);
    });
    expect(await run()).toMatchObject({ proposed: 1, failed: 0 });
    expect(groundings).toBe(2);
    expect(repairSeen).toBe(true);
  });

  it('holds the sweep after three consecutive model failures', async () => {
    await seed();
    await seed({ id: 'stock-asset-2', candidateId: 'seed-candidate-2', reviewDecisionId: 'rd_stockseed1234' });
    await seed({ id: 'stock-asset-3', candidateId: 'seed-candidate-3', reviewDecisionId: 'rd_stockseed1235' });
    model.mockRejectedValue(new Error('network timeout'));
    expect(await run()).toMatchObject({ phase: 'failure_held', failed: 3 });
    const failed = stockJobs().filter((job) => job.state === 'failed');
    expect(failed).toHaveLength(3);
    expect(failed.every((job) => job.failureCode === 'stock_model_unavailable')).toBe(true);
  });

  it('stops organization when the shared discovery switch is off', async () => {
    await seed(); responses();
    const settings = await import('../../../../src/main/features/recall/capture-settings');
    await settings.updateRecallCaptureSettings(user, { enabled: false });
    expect(await run()).toMatchObject({ phase: 'stopped', proposed: 0, remaining: 1 });
    expect(model).not.toHaveBeenCalled();
    await settings.updateRecallCaptureSettings(user, { enabled: true });
    expect(await run()).toMatchObject({ proposed: 1, remaining: 0 });
  });

  it('forms without a conversation, preserves absent purpose, confirms exact text and replays no new version', async () => {
    await seed({ origin: undefined }); responses();
    const result = await run(); expect(result).toMatchObject({ checked: 1, proposed: 1, remaining: 0 });
    const row = await candidate(); expect(row.origin).toBe('stock_organization'); expect(row.value).toBeUndefined();
    expect(row.stockOrganizationProvenance).toMatchObject({ originalSourceUnrecorded: true, activeVersion: '1' });
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const caps = (await import('../../../../src/main/features/recall/candidate-capabilities')).getRecallCandidateCapabilities(row);
    expect(caps.canPromote).toBe(true);
    const saved = await candidates.promoteRecallCandidate(user, row.id, { actor: 'user' });
    expect(saved.asset).toMatchObject({ statement: newBody, version: '2', evidenceRefs: [] });
    expect(saved.asset.value).toBeUndefined();
    expect((await candidates.promoteRecallCandidate(user, row.id, { actor: 'user' })).asset.version).toBe('2');
    expect(model).toHaveBeenCalledTimes(2);
    const snapshot = await (await import('../../../../src/main/features/recall/asset-service')).readAbilityAssetVersionSnapshot(user, 'stock-asset', '2');
    expect(snapshot?.statement).toBe(newBody);
  });
  it('stores supported purposes and boundaries with the reviewed version', async () => {
    await seed({ value: purpose, applicableWhen: ['来源可读'], forbiddenWhen: ['离线草稿用于正式报告'] });
    responses({ outcome: 'proposal', reason: '保留核对条件并整理段落。', content: { title: '报告核对要求', statement: newBody,
      value: purpose, applicableWhen: ['来源可读'], forbiddenWhen: ['离线草稿用于正式报告'] } });
    await run(); const row = await candidate();
    const saved = await (await import('../../../../src/main/features/recall/candidate-service')).promoteRecallCandidate(user, row.id, { actor: 'user' });
    expect(saved.asset).toMatchObject({ value: purpose, applicableWhen: ['来源可读'], forbiddenWhen: ['离线草稿用于正式报告'], statement: newBody });
  });
  it('records no-change and waits 30 days without treating age as expiry', async () => {
    await seed(); responses({ outcome: 'no_change', reason: '内容包含所需条件与例外，无整理收益。' });
    expect(await run()).toMatchObject({ noChange: 1, proposed: 0 });
    await run(); expect(model).toHaveBeenCalledTimes(1); expect(await candidate()).toBeUndefined();
    const paths = await import('../../../../src/main/features/recall/paths');
    const dir = path.dirname(paths.recallJsonRecordPath(user, 'stock-organization', 'placeholder'));
    const id = fs.readdirSync(dir).find(name => name.endsWith('.json'))!.slice(0, -5);
    await (await import('../../../../src/main/features/recall/store')).updateRecallJsonRecord(user, 'stock-organization', id,
      raw => ({ ...raw!, checkedAt: new Date(Date.now() - 31 * 86400_000).toISOString() }));
    await run(); expect(model).toHaveBeenCalledTimes(2);
    expect((await (await import('../../../../src/main/features/recall/asset-service')).readAbilityAsset(user, 'stock-asset')).status).toBe('active');
  });
  it('rejects unsupported additions and does not create a half-finished review task', async () => {
    await seed(); responses(undefined, false);
    expect(await run()).toMatchObject({ insufficient: 1, proposed: 0 }); expect(await candidate()).toBeUndefined();
  });
  it('deduplicates pending and rejected proposals without another model call', async () => {
    await seed(); responses(); await run(); await run();
    const row = await candidate();
    await (await import('../../../../src/main/features/recall/candidate-service')).rejectRecallCandidate(user, row.id);
    await run(); expect(model).toHaveBeenCalledTimes(2);
  });
  it('blocks stale head, active-version changes, and automatic confirmation', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await seed(); responses(); await run(); const row = await candidate();
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(candidates.promoteRecallCandidate(user, row.id, { actor: 'system' })).rejects.toThrow('individual review');
    await assets.updateAbilityAsset(user, 'stock-asset', { value: purpose, actor: 'user', reason: 'Synthetic concurrent edit' });
    await expect(candidates.promoteRecallCandidate(user, row.id, { actor: 'user' })).rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
    await expect(candidates.promoteRecallCandidate(user, row.id, { actor: 'user', confirmBaselineVersion: '2' })).rejects.toThrow('reviewed contract');
    expect((await assets.readAbilityAsset(user, 'stock-asset')).version).toBe('2');
  });
  it('resumes the generated draft after interruption without generating it again', async () => {
    await seed(); responses(); const normal = model.getMockImplementation()!;
    model.mockImplementation(async (...args) => {
      if ((args[1] as any).budget.stage === 'grounding') throw Object.assign(new Error('stop'), { code: 'ABORT_ERR' });
      return normal(...args);
    });
    expect(await run()).toMatchObject({ phase: 'stopped', remaining: 1 });
    responses(); expect(await run()).toMatchObject({ proposed: 1, remaining: 0 });
    expect(model.mock.calls.map(call => call[1].budget.stage)).toEqual(['extraction', 'grounding', 'grounding']);
  });
  it('refuses a forged stock producer, preserving the conversation producer contract', async () => {
    await seed(); responses(); await run(); const row = await candidate();
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await expect(candidates.saveRecallCandidate(user, row as any)).rejects.toThrow('host preparation');
    await expect(candidates.saveRecallCandidate(user, { judgment: newBody, suggestedType: 'rule', suggestedScope: 'general', sourceRefs: [] })).rejects.toThrow();
  });
  it('excludes paused and scope-restricted assets before any model call', async () => {
    await seed(); const assets = await import('../../../../src/main/features/recall/asset-service');
    await assets.pauseAbilityAsset(user, 'stock-asset', { actor: 'user', reason: 'Synthetic pause' });
    expect(await run()).toMatchObject({ total: 0 }); expect(model).not.toHaveBeenCalled();
  });
});
async function ontologyFixture() {
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  await ontology.commitOntologyCommand(user, { commandId: 'seed-ontology', expectedRevision: 0, actions: [
    { intent: 'create', recordId: 'personal', sourceLabel: 'Synthetic module', record: { kind: 'module', name: '示例模块', description: '', scope: { kind: 'personal' } } },
    { intent: 'create', recordId: 'report-rule', sourceLabel: 'Synthetic rule', record: { kind: 'rule', moduleId: 'personal', name: '报告核对要求',
      requirement: oldBody, strength: 'required', condition: null, effect: { kind: 'note' }, exception: '离线草稿' } },
  ] });
  return ontology;
}
async function independentSuggestions() {
  const ontology = await ontologyFixture();
  await ontology.commitOntologyCommand(user, { commandId: 'second-rule', expectedRevision: 1, actions: [
    { intent: 'create', recordId: 'other-rule', sourceLabel: 'Synthetic independent rule', record: {
      kind: 'rule', moduleId: 'personal', name: '附件核对要求', requirement: oldBody,
      strength: 'required', condition: null, effect: { kind: 'note' }, exception: '离线草稿' } },
  ] });
  model.mockImplementation(async (_user: string, input: any) => {
    if (input.budget.stage !== 'extraction') return groundingResponse(input);
    const target = JSON.parse(input.message).primary.editableOntologyIds[0];
    return { result: { text: JSON.stringify({ outcome: 'proposal', reason: '按条件与例外分段。',
      ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
        actions: [{ intent: 'update', recordId: target, patch: { requirement: newBody } }] } }), meta: {} } };
  });
  expect(await run()).toMatchObject({ proposed: 2 });
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  return { ontology, candidates, rows: await candidates.listRecallCandidates(user) };
}
async function unrelatedUpdate(ontology: Awaited<ReturnType<typeof ontologyFixture>>, id = 'unrelated-module') {
  await ontology.commitOntologyCommand(user, { commandId: id, expectedRevision: ontology.readOntologyDocument(user).revision,
    actions: [{ intent: 'create', recordId: id, sourceLabel: 'Synthetic unrelated update', record: {
      kind: 'module', name: '独立模块', description: '', scope: { kind: 'personal' } } }] });
}
describe('checked stock confirmation revisions', () => {
  it.each([false, true])('confirms independent suggestions after an unrelated write (concurrent=%s)', async concurrent => {
    const { ontology, candidates, rows } = await independentSuggestions();
    await unrelatedUpdate(ontology);
    const calls = model.mock.calls.length;
    if (concurrent) await Promise.all(rows.map(row => candidates.confirmRecallOntologyCandidate(user, row.id)));
    else for (const row of rows) await candidates.confirmRecallOntologyCandidate(user, row.id);
    const doc = ontology.readOntologyDocument(user);
    expect(doc.revision).toBe(5);
    expect(doc.records['report-rule'].version).toBe(2); expect(doc.records['other-rule'].version).toBe(2);
    for (const row of rows) {
      const saved = await candidates.readRecallCandidate(user, row.id);
      expect(saved.ontologyFormation).toEqual(row.ontologyFormation);
      expect(saved.ontologyHandoff?.ontologyRevision).toBe(doc.receipts[row.ontologyFormation!.commandId].revision);
      await candidates.confirmRecallOntologyCandidate(user, row.id);
    }
    expect(ontology.readOntologyDocument(user).revision).toBe(5);
    expect(model).toHaveBeenCalledTimes(calls);
  });
  it.each(['report-rule', 'personal'])('rejects a changed target or dependency: %s', async recordId => {
    const { ontology, candidates, rows } = await independentSuggestions();
    const row = rows.find(row => row.ontologyFormation!.actions[0].recordId === 'report-rule')!;
    await ontology.commitOntologyCommand(user, { commandId: 'conflicting-edit', expectedRevision: 2, actions: [
      { intent: 'update', recordId, expectedVersion: 1, sourceLabel: 'Synthetic concurrent edit', patch: { name: '修改后的名称' } },
    ] });
    const before = ontology.readOntologyDocument(user);
    await expect(candidates.confirmRecallOntologyCandidate(user, row.id)).rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
    expect(ontology.readOntologyDocument(user)).toEqual(before);
    expect((await candidates.readRecallCandidate(user, row.id)).ontologyFormation).toEqual(row.ontologyFormation);
    expect((await candidates.readRecallCandidate(user, row.id)).status).toBe('pending_review');
  });
  it('refuses edited actions and missing preparation instead of granting a current revision', async () => {
    const { ontology, candidates, rows } = await independentSuggestions();
    const store = await import('../../../../src/main/features/recall/store');
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    const row = rows[0];
    const altered = formation.parseOntologyFormationProposal(ontology.readOntologyDocument(user), row.id, {
      reason: 'Synthetic altered action', evidence: ['stored-version'], actions: [{ intent: 'update',
        recordId: row.ontologyFormation!.actions[0].recordId, expectedVersion: 1, sourceLabel: 'Synthetic altered action', patch: { requirement: '不同的正文。' } }],
    }, '', undefined, 'ontology')!;
    await store.updateRecallJsonRecord(user, 'candidates', row.id, raw => ({ ...raw!, ontologyFormation: altered }));
    await unrelatedUpdate(ontology);
    await expect(candidates.confirmRecallOntologyCandidate(user, row.id)).rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
    await store.updateRecallJsonRecord(user, 'stock-organization', rows[1].stockOrganizationProvenance!.jobId, raw => ({ ...raw!, prepared: undefined }));
    await expect(candidates.confirmRecallOntologyCandidate(user, rows[1].id)).rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
    expect(ontology.readOntologyDocument(user).revision).toBe(3);
  });
  it('replays the rebased request from its receipt without changing the command identity', async () => {
    const { ontology, candidates, rows } = await independentSuggestions();
    await unrelatedUpdate(ontology);
    const row = rows[0], saved = await candidates.confirmRecallOntologyCandidate(user, row.id);
    await unrelatedUpdate(ontology, 'later-module');
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    const store = await import('../../../../src/main/features/recall/store');
    const before = ontology.readOntologyDocument(user);
    await formation.withOntologyOnlyFormation(user, row.ontologyFormation!, () => store.updateRecallJsonRecord(user, 'candidates', row.id, raw => raw!));
    expect(ontology.readOntologyDocument(user)).toEqual(before);
    expect((await candidates.readRecallCandidate(user, row.id)).ontologyHandoff).toEqual(saved.ontologyHandoff);
  });
});
describe('stock ontology and joint persistence', () => {
  it('repairs an ontology-only draft that wrongly includes cognition content', async () => {
    await ontologyFixture();
    const ontologyProposal = { outcome: 'proposal', reason: '按条件与例外分段，保留规则强度。',
      ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
        actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } };
    let extractions = 0;
    let repairSeen = false;
    model.mockImplementation(async (_user: string, input: any) => {
      if (input.budget.stage === 'extraction') {
        extractions += 1;
        if (extractions === 1) return { result: { text: JSON.stringify({
          ...ontologyProposal, content: { title: '不应出现的认知正文', statement: oldBody } }), meta: {} } };
        repairSeen = input.systemPrompt.includes('独立本体记录');
        return { result: { text: JSON.stringify(ontologyProposal), meta: {} } };
      }
      return groundingResponse(input);
    });
    expect(await run()).toMatchObject({ proposed: 1, failed: 0 });
    expect(extractions).toBe(2);
    expect(repairSeen).toBe(true);
    const row = await candidate();
    expect(row.proposalTarget).toBe('ontology');
    expect(await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets(user)).toHaveLength(0);
  });

  it('uses an independent ontology suggestion and saves no second cognition', async () => {
    const ontology = await ontologyFixture();
    responses({ outcome: 'proposal', reason: '按条件与例外分段，保留规则强度。', ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
      actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
    expect(await run()).toMatchObject({ proposed: 1 });
    const row = await candidate(); expect(row.proposalTarget).toBe('ontology'); expect(row.value).toBeUndefined();
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    await candidates.confirmRecallOntologyCandidate(user, row.id);
    expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ requirement: newBody, strength: 'required', exception: '离线草稿' });
    expect(await (await import('../../../../src/main/features/recall/asset-service')).listAbilityAssets(user)).toHaveLength(0);
    await candidates.confirmRecallOntologyCandidate(user, row.id);
    expect(ontology.readOntologyDocument(user).records['report-rule'].version).toBe(2);
  });
  it('makes one joint proposal, rolls back a failed asset write, and retries without duplicate versions', async () => {
    const ontology = await ontologyFixture();
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    const refs = [{ moduleId: 'personal', recordId: 'report-rule', versionPolicy: 'current', sharedBody: true }];
    const binding = formation.parseOntologyFormationProposal(ontology.readOntologyDocument(user), 'seed-candidate',
      { reason: 'Synthetic existing binding', evidence: ['synthetic'], actions: [], refs }, oldBody)!;
    await formation.withOntologyFormationPromotion(user, binding, 'user', () => seed({ ontologyRefs: refs }));
    responses(); expect(await run()).toMatchObject({ total: 1, proposed: 1 });
    const row = await candidate(); expect(row.proposalTarget).toBe('joint');
    await unrelatedUpdate(ontology);
    const assets = await import('../../../../src/main/features/recall/asset-service');
    const candidates = await import('../../../../src/main/features/recall/candidate-service');
    const failure = vi.spyOn(assets, 'updateAbilityAsset').mockRejectedValueOnce(new Error('Synthetic joint write failure'));
    await expect(candidates.promoteRecallCandidate(user, row.id, { actor: 'user' })).rejects.toThrow('Synthetic');
    expect((await assets.readAbilityAsset(user, 'stock-asset')).version).toBe('1');
    expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ version: 1, requirement: oldBody });
    failure.mockRestore();
    const decisions = await import('../../../../src/main/features/cognition/review-decision');
    const receiptFailure = vi.spyOn(decisions, 'recordReviewDecisionOutcome').mockRejectedValueOnce(new Error('Synthetic receipt interruption'));
    await expect(candidates.promoteRecallCandidate(user, row.id, { actor: 'user' })).rejects.toThrow('Synthetic receipt interruption');
    receiptFailure.mockRestore();
    expect((await assets.readAbilityAsset(user, 'stock-asset')).statement).toBe(newBody);
    expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ version: 2, requirement: newBody });
    await candidates.promoteRecallCandidate(user, row.id, { actor: 'user' });
    expect((await assets.readAbilityAsset(user, 'stock-asset')).version).toBe('2');
    expect(ontology.readOntologyDocument(user).revision).toBe(3);
    expect((await candidates.readRecallCandidate(user, row.id)).status).toBe('confirmed');
  });
  it('blocks a revoked source of a joint suggestion before changing either body', async () => {
    const ontology = await ontologyFixture();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(user, { conversationId: 'synthetic-joint-source', kind: 'normal', title: '合成联合来源' });
    const ref = (await import('../../../../src/main/features/recall/source-service')).normalizeCognitionSourceRef({ kind: 'conversation', subtype: 'session', id: 'synthetic-joint-source' });
    const formation = await import('../../../../src/main/features/recall/ontology-formation');
    const refs = [{ moduleId: 'personal', recordId: 'report-rule', versionPolicy: 'current', sharedBody: true }];
    const binding = formation.parseOntologyFormationProposal(ontology.readOntologyDocument(user), 'seed-candidate',
      { reason: 'Synthetic existing binding', evidence: ['synthetic'], actions: [], refs }, oldBody)!;
    await formation.withOntologyFormationPromotion(user, binding, 'user', () => seed({ ontologyRefs: refs, evidenceRefs: [ref] }));
    responses(); await run(); const row = await candidate();
    await unrelatedUpdate(ontology);
    await (await import('../../../../src/main/features/recall/source-control')).pauseCognitionSource(user, ref);
    await expect((await import('../../../../src/main/features/recall/candidate-service')).promoteRecallCandidate(user, row.id, { actor: 'user' }))
      .rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
    expect(ontology.readOntologyDocument(user).records['report-rule'].version).toBe(1);
    expect((await (await import('../../../../src/main/features/recall/asset-service')).readAbilityAsset(user, 'stock-asset')).version).toBe('1');
  });
  it('blocks disabled sources and restricted saved content without treating them as source-less', async () => {
    const assets = await import('../../../../src/main/features/recall/asset-service');
    await seed({ scopePolicy: { projectIds: ['synthetic-project'] } }); responses();
    expect(await run()).toMatchObject({ total: 0 }); expect(model).not.toHaveBeenCalled();
    await assets.updateAbilityAsset(user, 'stock-asset', { scopePolicy: undefined, actor: 'user', reason: 'Synthetic boundary unchanged' });
    // The existing restriction remains; omitting it must not grant a broader scope.
    expect(await run()).toMatchObject({ total: 0 });
  });
});
it('excludes a paused original source and blocks approval after source revocation', async () => {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(user, { conversationId: 'synthetic-stock-source', kind: 'normal', title: '合成来源' });
  const ref = (await import('../../../../src/main/features/recall/source-service')).normalizeCognitionSourceRef({ taxonomyVersion: 2, kind: 'conversation', subtype: 'session', id: 'synthetic-stock-source' });
  await seed({ evidenceRefs: [ref] }); responses();
  const sources = await import('../../../../src/main/features/recall/source-control');
  await sources.pauseCognitionSource(user, ref);
  expect(await run()).toMatchObject({ total: 0 }); expect(model).not.toHaveBeenCalled();
  await sources.resumeCognitionSource(user, ref); await run(); const row = await candidate();
  expect(row.stockOrganizationProvenance?.originalSourceUnrecorded).toBe(false);
  await sources.pauseCognitionSource(user, ref);
  await expect((await import('../../../../src/main/features/recall/candidate-service')).promoteRecallCandidate(user, row.id, { actor: 'user' })).rejects.toThrow('source');
});
it('detects an active version switch even when the head version has not changed', async () => {
  await seed(); const assets = await import('../../../../src/main/features/recall/asset-service');
  await assets.updateAbilityAsset(user, 'stock-asset', { statement: oldBody + '\n附件另行核对。', actor: 'user', reason: 'Synthetic head' });
  responses(); await run(); const row = await candidate();
  await assets.selectAbilityAssetVersion(user, 'stock-asset', '1', { actor: 'user', reason: 'Synthetic selection' });
  expect((await assets.readAbilityAsset(user, 'stock-asset')).version).toBe('2');
  await expect((await import('../../../../src/main/features/recall/candidate-service')).promoteRecallCandidate(user, row.id, { actor: 'user' }))
    .rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
});
it('detects changed and removed original sources without relying on a source-control tombstone', async () => {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(user, { conversationId: 'synthetic-stock-source', kind: 'normal', title: '合成来源' });
  const ref = (await import('../../../../src/main/features/recall/source-service')).normalizeCognitionSourceRef({ taxonomyVersion: 2, kind: 'conversation', subtype: 'session', id: 'synthetic-stock-source' });
  await seed({ evidenceRefs: [ref] }); responses(); await run(); const row = await candidate();
  await chats.updateConversation(user, ref.id, { title: '修改后的合成来源' });
  await expect((await import('../../../../src/main/features/recall/candidate-service')).promoteRecallCandidate(user, row.id, { actor: 'user' }))
    .rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
  await run(); expect(model).toHaveBeenCalledTimes(4);
  await chats.deleteConversation(user, ref.id);
  expect(await (await import('../../../../src/main/features/recall/stock-organization')).inventoryStockOrganization(user)).toEqual([]);
});
it('allows expanded context for the same versioned anchor but rejects changed source bytes', async () => {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(user, { conversationId: 'synthetic-stock-source', kind: 'normal', title: '合成来源' });
  const page = vi.spyOn(chats, 'getMessagesPage').mockResolvedValue({ history: [
    { id: 'synthetic-message', from: 'user', text: oldBody, ts: '2026-01-01T00:00:00Z' },
  ], nextCursor: null } as any);
  try {
    const { cognitionMessageSourceId } = await import('../../../../src/main/features/recall/source-identity');
    const { readLocatedSource } = await import('../../../../src/main/features/recall/source-locator');
    const { normalizeCognitionSourceRef } = await import('../../../../src/main/features/recall/source-service');
    const ref = normalizeCognitionSourceRef({ kind: 'conversation', subtype: 'message',
      id: cognitionMessageSourceId('synthetic-stock-source', 'synthetic-message'),
      locator: { conversationId: 'synthetic-stock-source', messageId: 'synthetic-message' } })!;
    ref.sourceVersion = (await readLocatedSource(user, ref)).sourceVersion;
    await seed({ evidenceRefs: [ref] });
    const stock = await import('../../../../src/main/features/recall/stock-organization');
    const unit = (await stock.inventoryStockOrganization(user))[0];
    unit.evidence[0].excerpt = oldBody.slice(0, 8);
    unit.evidence[0].location = { startLine: 1, endLine: 1 };
    await expect(stock.assertStockOrganizationBaseline(user, unit)).resolves.toBeUndefined();
    page.mockResolvedValue({ history: [
      { id: 'synthetic-message', from: 'user', text: oldBody + '新增条件。', ts: '2026-01-01T00:00:00Z' },
    ], nextCursor: null } as any);
    await expect(stock.assertStockOrganizationBaseline(user, unit))
      .rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
  } finally { page.mockRestore(); }
});
it('does not repeat a rejected ontology suggestion because an unrelated module changed', async () => {
  const ontology = await ontologyFixture();
  responses({ outcome: 'proposal', reason: '按条件与例外分段。', ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
  await run(); const row = await candidate();
  await (await import('../../../../src/main/features/recall/candidate-service')).rejectRecallCandidate(user, row.id);
  await ontology.commitOntologyCommand(user, { commandId: 'unrelated-module', expectedRevision: ontology.readOntologyDocument(user).revision,
    actions: [{ intent: 'create', recordId: 'other-module', sourceLabel: 'Synthetic unrelated module', record: { kind: 'module', name: '其他模块', description: '', scope: { kind: 'personal' } } }] });
  await run(); expect(model).toHaveBeenCalledTimes(2);
});
it('reports model failure without claiming the unit was checked or completed', async () => {
  await seed(); model.mockRejectedValue(new Error('Synthetic model unavailable'));
  expect(await run()).toMatchObject({ phase: 'failed', checked: 0, failed: 1, remaining: 1, proposed: 0 });
  expect(await candidate()).toBeUndefined();
});
it('organizes a text fact through the existing correction history without changing validity', async () => {
  const ontology = await ontologyFixture();
  const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'Synthetic fact' });
  await ontology.commitOntologyCommand(user, { commandId: 'seed-facts', expectedRevision: 1, actions: [
    create('type', { kind: 'definition', moduleId: 'personal', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('entity', { kind: 'entity', moduleId: 'personal', typeId: 'type', name: '合成项目', description: '', aliases: [], identityStatus: 'confirmed' }),
    create('attribute', { kind: 'definition', moduleId: 'personal', name: '核对说明', description: '', definitionKind: 'attribute', subjectTypes: ['type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
    create('fact', { kind: 'assertion', moduleId: 'personal', subjectId: 'entity', definitionId: 'attribute', object: { kind: 'literal', valueType: 'text', value: oldBody }, validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
  ] });
  responses({ outcome: 'proposal', reason: '分段保留原文含义。', ontologyChanges: { reason: '分段整理', actions: [
    { intent: 'correct', recordId: 'fact', object: { kind: 'literal', valueType: 'text', value: newBody } } ] } });
  const normal = model.getMockImplementation()!;
  model.mockImplementation(async (...args) => {
    const input = args[1] as any;
    if (input.budget.stage === 'extraction' && JSON.parse(input.message).primary.editableOntologyIds[0] !== 'fact')
      return { result: { text: JSON.stringify({ outcome: 'no_change', reason: '无需修改。' }), meta: {} } };
    return normal(...args);
  });
  expect(await run()).toMatchObject({ proposed: 1 }); const row = await candidate();
  await (await import('../../../../src/main/features/recall/candidate-service')).confirmRecallOntologyCandidate(user, row.id);
  const records = Object.values(ontology.readOntologyDocument(user).records);
  expect(records.find(record => record.kind === 'assertion' && record.status === 'active')).toMatchObject({
    object: { value: newBody }, subjectId: 'entity', definitionId: 'attribute',
    validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' },
  });
});
it('settles unresolved fact and entity actions as insufficient and keeps sweeping', async () => {
  const ontology = await ontologyFixture();
  const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create', recordId, record, sourceLabel: 'Synthetic unresolved fact' });
  await ontology.commitOntologyCommand(user, { commandId: 'seed-unresolved-facts', expectedRevision: 1, actions: [
    create('unresolved-type', { kind: 'definition', moduleId: 'personal', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
    create('unresolved-entity', { kind: 'entity', moduleId: 'personal', typeId: 'unresolved-type', name: '未确认人员', description: '', aliases: [], identityStatus: 'unresolved' }),
    create('unresolved-attribute', { kind: 'definition', moduleId: 'personal', name: '身份说明', description: '', definitionKind: 'attribute', subjectTypes: ['unresolved-type'], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' }),
    create('unresolved-fact', { kind: 'assertion', moduleId: 'personal', subjectId: 'unresolved-entity', definitionId: 'unresolved-attribute', object: { kind: 'literal', valueType: 'text', value: '不是某个已知参会人；确切姓名未确认' }, certainty: 'unknown', validity: { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } }),
  ] });
  const correct = { outcome: 'proposal', reason: '补充声音推断的依据，姓名仍未确认。', ontologyChanges: {
    reason: '补充声音推断依据，保留姓名未确认。', evidence: ['stored-version'],
    actions: [{ intent: 'correct', recordId: 'unresolved-fact', object: { kind: 'literal', valueType: 'text', value: '根据声音推断不是某个已知参会人，而是另一个人；确切姓名未确认' } }],
  } };
  const updateEntity = { outcome: 'proposal', reason: '补充实体说明。', ontologyChanges: {
    reason: '补充实体说明。', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'unresolved-entity', patch: { description: '补充说明' } }],
  } };
  model.mockImplementation(async (_userId: string, input: any) => {
    if (input.budget.stage !== 'extraction') return groundingResponse(input);
    const editable = JSON.parse(input.message).primary.editableOntologyIds as string[];
    if (editable.includes('unresolved-entity')) return { result: { text: JSON.stringify(updateEntity), meta: {} } };
    if (!editable.includes('unresolved-fact')) return { result: { text: JSON.stringify({ outcome: 'no_change', reason: '无需修改。' }), meta: {} } };
    return { result: { text: JSON.stringify(correct), meta: {} } };
  });

  expect(await run()).toMatchObject({ insufficient: 2, noChange: 3, proposed: 0, failed: 0, checked: 5, remaining: 0, phase: 'complete' });
  expect(model.mock.calls.filter(call => (call[1] as any).budget.stage === 'extraction')).toHaveLength(5);
  expect(model.mock.calls.every(call => (call[1] as any).budget.stage === 'extraction')).toBe(true);
  const factJob = stockJobs().find(row => (row.unit?.editableIds || []).includes('unresolved-fact'));
  const entityJob = stockJobs().find(row => (row.unit?.editableIds || []).includes('unresolved-entity'));
  expect(factJob).toMatchObject({ state: 'insufficient', reason: 'target_certainty_unresolved' });
  expect(entityJob).toMatchObject({ state: 'insufficient' });
  expect(['target_certainty_unresolved', 'target_identity_unresolved']).toContain(entityJob?.reason);
  expect(factJob?.failureCode).toBeUndefined();
  expect(entityJob?.failureCode).toBeUndefined();
});
it('keeps a failure-held draft for grounding on the next allowed run', async () => {
  await seed(); responses(); const normal = model.getMockImplementation()!;
  model.mockImplementation(async (...args) => {
    if ((args[1] as any).budget.stage === 'grounding') throw Object.assign(new Error('Host model failure hold'), { code: 'ABORT_ERR', reason: 'capture_model_failure_hold' });
    return normal(...args);
  });
  expect(await run()).toMatchObject({ phase: 'failure_held', checked: 0, remaining: 1 });
  responses(); expect(await run()).toMatchObject({ proposed: 1, remaining: 0 });
  expect(model.mock.calls.map(call => call[1].budget.stage)).toEqual(['extraction', 'grounding', 'grounding']);
});
it('rechecks an unchanged ontology unit against a new document revision without duplicating the proposal', async () => {
  const ontology = await ontologyFixture();
  responses({ outcome: 'proposal', reason: '按条件与例外分段。', ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
  await run(); const row = await candidate();
  await ontology.commitOntologyCommand(user, { commandId: 'other-module', expectedRevision: ontology.readOntologyDocument(user).revision,
    actions: [{ intent: 'create', recordId: 'other-module', sourceLabel: 'Synthetic module', record: { kind: 'module', name: '其他模块', description: '', scope: { kind: 'personal' } } }] });
  const rechecked = await (await import('../../../../src/main/features/recall/ontology-formation-recheck')).recheckOntologyFormation(user, row.id);
  expect(rechecked.ontologyFormation?.baselineRevision).toBe(2);
  await (await import('../../../../src/main/features/recall/candidate-service')).confirmRecallOntologyCandidate(user, row.id);
  expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ requirement: newBody, version: 2 });
  expect(model.mock.calls.map(call => call[1].budget.stage)).toEqual(['extraction', 'grounding', 'grounding']);
});

it('regenerates edited ontology instructions, retains the revised preview on recheck and saves the reviewed result', async () => {
  const ontology = await ontologyFixture();
  const proposal = (body: string) => ({ outcome: 'proposal', reason: '按核对步骤整理，保留条件。', ontologyChanges: { reason: '调整段落', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: body } }] } });
  responses(proposal(newBody)); await run(); const row = await candidate();
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const request = '将目标字段列为独立段落，不增加检查项目。';
  await candidates.updateRecallCandidate(user, row.id, { ...row, judgment: request });
  const revisedBody = newBody.replace('目标：', '\n目标：'); responses(proposal(revisedBody));
  const recheck = (await import('../../../../src/main/features/recall/ontology-formation-recheck')).recheckOntologyFormation;
  const revised = await recheck(user, row.id);
  expect(revised.value).toBeUndefined();
  expect(JSON.parse(model.mock.calls[2][1].message).reviewInstructions).toBe(request);
  expect(model.mock.calls.map(call => call[1].budget.stage)).toEqual(['extraction', 'grounding', 'extraction', 'grounding']);
  expect(revised.ontologyFormation?.previewChanges[0].after).toMatchObject({ requirement: revisedBody });
  expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ requirement: oldBody, version: 1 });
  const checked = await recheck(user, row.id);
  expect(checked.ontologyFormation?.previewChanges[0].after).toMatchObject({ requirement: revisedBody });
  expect(model.mock.calls.at(-1)![1].budget.stage).toBe('grounding');
  await candidates.confirmRecallOntologyCandidate(user, row.id);
  expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ requirement: revisedBody, version: 2 });
});

it('keeps the old preview blocked when revised ontology instructions produce an unsupported change', async () => {
  const ontology = await ontologyFixture();
  responses({ outcome: 'proposal', reason: '分段整理。', ontologyChanges: { reason: '整理', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
  await run(); const row = await candidate();
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  await candidates.updateRecallCandidate(user, row.id, { ...row, judgment: '改成其他检查项目。' });
  const baseline = await candidate();
  responses({ outcome: 'proposal', reason: '合成无依据修改。', ontologyChanges: { reason: '调整', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: '新增 99 项检查。' } }] } }, false);
  await expect((await import('../../../../src/main/features/recall/ontology-formation-recheck')).recheckOntologyFormation(user, row.id)).rejects.toThrow('preserve');
  expect((await candidate()).ontologyFormation?.previewChanges).toEqual(baseline.ontologyFormation?.previewChanges);
  expect((await candidate()).ontologyFormation?.actions).toEqual(baseline.ontologyFormation?.actions);
  expect((await candidate()).ontologyFormation?.blockedReasons).toEqual(
    expect.arrayContaining(['candidate_edited_requires_ontology_review', 'stock_recheck_failed']));
  expect(stockJobs().find(job => job.replacesJobId === row.stockOrganizationProvenance?.jobId))
    .toMatchObject({ state: 'failed', reviewKind: 'content' });
  expect(ontology.readOntologyDocument(user).records['report-rule']).toMatchObject({ requirement: oldBody, version: 1 });
});

it('switches the stock proof and source snapshot together without a model call or clearing a content hold', async () => {
  await ontologyFixture();
  responses({ outcome: 'proposal', reason: '按核对步骤分段。', ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
  await run(); const row = await candidate();
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  const held = await stock.holdStockOntologyCandidate(user, row, 'content_review_required');
  const result = await stock.refreshStockOntologyCandidate(user, held, 'sources');
  expect(result.id).toBe(row.id); expect(result.captureKey).not.toBe(row.captureKey);
  expect(result.ontologyFormation?.actions).toEqual(row.ontologyFormation?.actions);
  expect(result.ontologyFormation?.previewChanges[0].after).toMatchObject({ requirement: newBody, version: 2 });
  expect(result.ontologyFormation?.previewChanges[0].before).toEqual(row.ontologyFormation?.previewChanges[0].before);
  expect(result.ontologyFormation?.blockedReasons).toContain('content_review_required');
  expect(result.userModifiedAt).toBeUndefined(); expect(model).toHaveBeenCalledTimes(2);
  await expect((await import('../../../../src/main/features/recall/stock-organization-provenance')).verifyStockOrganizationCandidate(user, result)).resolves.toBeTruthy();
  expect(stockJobs().find(job => job.id === row.stockOrganizationProvenance?.jobId)?.state).toBe('proposed');
  expect(stockJobs().find(job => job.id === result.stockOrganizationProvenance?.jobId))
    .toMatchObject({ state: 'proposed', replacesJobId: row.stockOrganizationProvenance?.jobId, candidateId: row.id });
  const reviewReason = '分开核对数量与来源条件，保留离线草稿的例外。';
  const copyRepaired = await stock.refreshStockOntologyCandidate(user, result, 'sources', { reviewReason });
  expect(copyRepaired.ontologyFormation?.reason).toBe(reviewReason);
  expect(copyRepaired.evidenceSummary).toBe(reviewReason);
  expect(copyRepaired.ontologyFormation?.previewChanges[0].after).toMatchObject({ requirement: newBody, version: 2 });
  expect(copyRepaired.ontologyFormation?.previewChanges[0].before).toEqual(row.ontologyFormation?.previewChanges[0].before);
  expect(copyRepaired.ontologyFormation?.blockedReasons).toContain('content_review_required');
  expect(copyRepaired.userModifiedAt).toBeUndefined(); expect(model).toHaveBeenCalledTimes(2);
});

it('refuses to overwrite a user edit made while the model is checking', async () => {
  await ontologyFixture();
  responses({ outcome: 'proposal', reason: '按核对步骤分段。', ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
  await run(); const row = await candidate();
  const service = await import('../../../../src/main/features/recall/candidate-service');
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  model.mockImplementation(async (_uid, input) => {
    await service.updateRecallCandidate(user, row.id, { ...row, judgment: '用户在核对期间修改的要求。' });
    return groundingResponse(input);
  });
  await expect(stock.refreshStockOntologyCandidate(user, row, 'content'))
    .rejects.toMatchObject({ code: 'ontology_recheck_candidate_changed' });
  const current = await candidate();
  expect(current.judgment).toBe('用户在核对期间修改的要求。');
  expect(current.captureKey).toBe(row.captureKey);
  expect(current.ontologyFormation?.previewChanges).toEqual(row.ontologyFormation?.previewChanges);
  expect(current.ontologyFormation?.blockedReasons).not.toContain('stock_recheck_failed');
});

it.each(['extra target', 'processing copy'])('repairs one invalid recheck (%s) before grounding', async invalid => {
  await ontologyFixture();
  const proposal = { outcome: 'proposal', reason: '按核对步骤分段。', ontologyChanges: { reason: '保留条件与例外，分段呈现步骤。', evidence: ['stored-version'],
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } };
  responses(proposal); await run();
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  const held = await stock.holdStockOntologyCandidate(user, await candidate(), 'content_review_required');
  let extractions = 0;
  model.mockImplementation(async (_uid, input) => {
    if (input.budget.stage === 'extraction') {
      expect(input.systemPrompt).not.toContain('## Candidate content contract');
      expect(JSON.parse(input.message).previousProposal).toEqual(held.ontologyFormation?.actions);
      extractions++;
      if (extractions === 1) return { result: { text: JSON.stringify(invalid === 'extra target'
        ? { ...proposal, content: { title: '多余目标', statement: newBody } }
        : { ...proposal, ontologyChanges: { ...proposal.ontologyChanges, reason: '改为结构化中文表述，不改变实体身份和权限。' } }), meta: {} } };
      expect(input.systemPrompt).toContain('上一次输出不符合独立本体记录的契约');
      return { result: { text: JSON.stringify(proposal), meta: {} } };
    }
    return groundingResponse(input);
  });
  const refreshed = await stock.refreshStockOntologyCandidate(user, held, 'content');
  expect(extractions).toBe(2);
  expect(refreshed.ontologyFormation?.blockedReasons).toEqual([]);
  expect(refreshed.ontologyFormation?.previewChanges[0].after).toMatchObject({ requirement: newBody });
});

it('rejects a metadata-only recheck without replacing the old preview or calling grounding', async () => {
  await ontologyFixture();
  responses({ outcome: 'proposal', reason: '按核对步骤分段。', ontologyChanges: { reason: '保留条件与例外，分段呈现步骤。',
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: newBody } }] } });
  await run();
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  const held = await stock.holdStockOntologyCandidate(user, await candidate(), 'content_review_required');
  model.mockClear();
  responses({ outcome: 'proposal', reason: '整理核对步骤。', ontologyChanges: { reason: '整理核对步骤。',
    actions: [{ intent: 'update', recordId: 'report-rule', patch: { requirement: oldBody } }] } });
  await expect(stock.refreshStockOntologyCandidate(user, held, 'content')).rejects.toMatchObject({ code: 'stock_no_change' });
  expect(model).toHaveBeenCalledTimes(1);
  expect((await candidate()).ontologyFormation?.previewChanges).toEqual(held.ontologyFormation?.previewChanges);
  expect((await candidate()).ontologyFormation?.blockedReasons).toContain('stock_recheck_failed');
});

async function locatedOntologyUnits() {
  const chats = await import('../../../../src/main/features/chats');
  await chats.createConversation(user, { conversationId: 'synthetic-range-source', kind: 'normal', title: '合成来源' });
  const text = `${oldBody}\n另一条规则：${oldBody}`;
  const page = vi.spyOn(chats, 'getMessagesPage').mockResolvedValue({ history: [
    { id: 'synthetic-range-message', from: 'user', text, ts: '2026-01-01T00:00:00Z' },
  ], nextCursor: null } as any);
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  await ontology.commitOntologyCommand(user, { commandId: 'seed-ranges', expectedRevision: 0, actions: [
    { intent: 'create', recordId: 'personal', sourceLabel: 'Synthetic module', record: { kind: 'module', name: '合成模块', description: '', scope: { kind: 'personal' } } },
    ...['rule-a', 'rule-b'].map((recordId, i) => ({ intent: 'create' as const, recordId,
      sourceLabel: `会话 synthetic-range-source/synthetic-range-message · 已确认 · ${i ? '另一条规则：' + oldBody : oldBody + '\n另一条规则：'}`,
      record: { kind: 'rule' as const, moduleId: 'personal', name: recordId, requirement: oldBody, strength: 'required' as const,
        condition: null, effect: { kind: 'note' as const }, exception: '离线草稿' } })),
  ] });
  const stock = await import('../../../../src/main/features/recall/stock-organization');
  return { stock, ontology, page, units: await stock.inventoryStockOrganization(user) };
}

function legacyRangeJob(unit: any, other: any) {
  const oldUnit = structuredClone(unit);
  oldUnit.sourceVersions[0] = JSON.stringify({ ...JSON.parse(oldUnit.sourceVersions[0]), locator: other.sourceRefs[0].locator });
  // Historical on-disk identity: the embedded range was not normalized.
  const evidence = oldUnit.evidence.map((item: any) => {
    if (!item.ref.locator || !item.ref.sourceVersion) return item;
    const { excerpt: _excerpt, location: _location, ...identity } = item; return identity;
  });
  const identity = { key: oldUnit.key, asset: undefined, headVersion: undefined, activeVersion: undefined,
    records: oldUnit.records, evidence, sourceControls: oldUnit.sourceControls, sourceVersions: oldUnit.sourceVersions,
    sourceRefs: oldUnit.sourceRefs, policyVersion: 1, legacySourcesResolved: oldUnit.legacySourcesResolved, sourceIssues: oldUnit.sourceIssues,
    contract: '' };
  return { oldUnit, identity };
}

describe('located source baseline compatibility', () => {
  it('keeps ranges on their references and checks batch units against the same source version', async () => {
    const { stock, units, page } = await locatedOntologyUnits();
    try {
      expect(units).toHaveLength(2);
      expect(units[0].sourceRefs![0].locator!.range).not.toEqual(units[1].sourceRefs![0].locator!.range);
      for (const unit of units) {
        expect(JSON.parse(unit.sourceVersions![0]).locator).toEqual(unit.sourceRefs![0].locator);
        await expect(stock.assertStockOrganizationBaseline(user, unit)).resolves.toBeUndefined();
      }
      const { readCognitionSourceBaselines } = await import('../../../../src/main/features/recall/source-catalog');
      const refs = units.flatMap(unit => unit.sourceRefs!);
      const forward = await readCognitionSourceBaselines(user, refs), backward = await readCognitionSourceBaselines(user, [...refs].reverse());
      expect(forward).toEqual(backward);
      expect(JSON.parse([...forward.values()][0]).locator.range).toBeUndefined();
      const { oldUnit } = legacyRangeJob(units[0], units[1]);
      await expect(stock.assertStockOrganizationBaseline(user, oldUnit)).resolves.toBeUndefined();
      for (const change of ['version', 'identity', 'reference-range', 'record']) {
        const altered = structuredClone(oldUnit);
        if (change === 'reference-range') altered.sourceRefs[0].locator.range = units[1].sourceRefs![0].locator!.range;
        else if (change === 'record') altered.records[0].name += ' changed';
        else { const stamp = JSON.parse(altered.sourceVersions[0]);
          if (change === 'version') stamp.sourceVersion = 'changed-version'; else stamp.locator.messageId = 'other-message';
          altered.sourceVersions[0] = JSON.stringify(stamp); }
        await expect(stock.assertStockOrganizationBaseline(user, altered)).rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
      }
    } finally { page.mockRestore(); }
  });

  it('resumes a legacy failed identity next window without its old draft or a duplicate rejected proposal', async () => {
    const { units, page } = await locatedOntologyUnits();
    try {
      const { oldUnit, identity } = legacyRangeJob(units[0], units[1]);
      const prompts = (await import('../../../../src/main/prompts/loader')).prompts;
      const grammar = (await import('../../../../src/main/features/recall/ontology-formation')).ontologyFormationGrammar;
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
      identity.contract = digest([prompts.load('recall_candidate_contract'), prompts.load('recall_stock_organization'), prompts.load('recall_stock_grounding'), grammar]);
      const fingerprint = digest([identity, []]), id = `stock-${digest([oldUnit.key, fingerprint])}`;
      const candidates = await import('../../../../src/main/features/recall/candidate-service');
      const candidateId = candidates.candidateIdForCaptureKey(id);
      const store = await import('../../../../src/main/features/recall/store');
      const settings = await (await import('../../../../src/main/features/recall/capture-settings')).readRecallCaptureSettings(user);
      const window = (await import('../../../../src/main/features/recall/capture-model-budget')).captureBudgetWindowKey(new Date(), settings.nightlyStart);
      await store.writeRecallJsonRecord(user, 'stock-organization', id, { schemaVersion: 1, ownerId: user, id, unit: oldUnit, fingerprint,
        candidateId, state: 'failed', lastWindow: window, failureCode: 'stock_organization_baseline_changed', updatedAt: new Date().toISOString(),
        draft: { outcome: 'no_change', reason: 'Stale draft must not be restored.' }, prepared: { invalid: true }, organizationPlan: { invalid: true } });
      model.mockImplementation(async (_uid, input) => {
        if (input.budget.stage !== 'extraction') return groundingResponse(input);
        const target = JSON.parse(input.message).primary.editableOntologyIds[0];
        return { result: { text: JSON.stringify(target === 'rule-a' ? { outcome: 'proposal', reason: '按条件与例外分段。', ontologyChanges: {
          reason: '分段整理', evidence: ['stored-version'], actions: [{ intent: 'update', recordId: target, patch: { requirement: newBody } }] } }
          : { outcome: 'no_change', reason: '无需修改。' }), meta: {} } };
      });
      expect(await run()).toMatchObject({ failed: 1, noChange: 1, proposed: 0 });
      expect(model).toHaveBeenCalledTimes(1);
      const correctIdentity = legacyRangeJob(units[1], units[1]).identity;
      correctIdentity.contract = identity.contract;
      const correctFingerprint = digest([correctIdentity, []]);
      expect(stockJobs().find(job => job.unit?.key === units[1].key)?.id).toBe(`stock-${digest([units[1].key, correctFingerprint])}`);
      await store.updateRecallJsonRecord(user, 'stock-organization', id, raw => ({ ...raw!, lastWindow: '2000-01-01' }));
      expect(await run()).toMatchObject({ failed: 0, proposed: 1, noChange: 1 });
      expect(model.mock.calls.map(call => call[1].budget.stage)).toEqual(['extraction', 'extraction', 'grounding']);
      expect(await candidate()).toMatchObject({ id: candidateId, stockOrganizationProvenance: { jobId: id } });
      const savedJob = await store.readRecallJsonRecord(user, 'stock-organization', id);
      expect(savedJob).toMatchObject({ id, candidateId, state: 'proposed' });
      expect(savedJob?.organizationPlan).toBeUndefined();
      expect(stockJobs().filter(job => job.unit?.key === oldUnit.key)).toHaveLength(1);
      await candidates.rejectRecallCandidate(user, candidateId);
      await store.updateRecallJsonRecord(user, 'stock-organization', id, raw => ({ ...raw!, unit: oldUnit }));
      await run(); expect(model).toHaveBeenCalledTimes(3);
      expect(await candidates.listRecallCandidates(user)).toHaveLength(1);
      expect((await candidates.readRecallCandidate(user, candidateId)).status).toBe('rejected');
    } finally { page.mockRestore(); }
  });

  it.each([
    { case: 'changed record keeps the old failed job isolated', state: 'failed', change: 'record', range: true, reuse: false },
    { case: 'changed contract retries a range-mismatched failure with its original identity', state: 'failed', change: 'contract', range: true, reuse: true },
    { case: 'changed contract retries an equal-range failure with its original identity', state: 'failed', change: 'contract', range: false, reuse: true },
    { case: 'unchanged contract discards the exact failed job preparation', state: 'failed', change: 'none', range: false, reuse: true },
    { case: 'changed contract does not borrow an old prepared job', state: 'prepared', change: 'contract', range: true, reuse: false },
  ])('$case', async scenario => {
    const { stock, ontology, units, page } = await locatedOntologyUnits();
    try {
      const { oldUnit, identity } = legacyRangeJob(units[0], units[scenario.range ? 1 : 0]);
      const prompts = (await import('../../../../src/main/prompts/loader')).prompts;
      const grammar = (await import('../../../../src/main/features/recall/ontology-formation')).ontologyFormationGrammar;
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
      const currentContract = digest([prompts.load('recall_candidate_contract'), prompts.load('recall_stock_organization'), prompts.load('recall_stock_grounding'), grammar]);
      identity.contract = scenario.change === 'contract' ? digest(['previous extraction contract']) : currentContract;
      const fingerprint = digest([identity, []]), id = `stock-${digest([oldUnit.key, fingerprint])}`;
      const store = await import('../../../../src/main/features/recall/store');
      const candidateId = (await import('../../../../src/main/features/recall/candidate-service')).candidateIdForCaptureKey(id);
      const original = { schemaVersion: 1, ownerId: user, id, unit: oldUnit, fingerprint,
        candidateId, state: scenario.state, lastWindow: '2000-01-01', failureCode: 'stock_organization_baseline_changed', updatedAt: new Date().toISOString(),
        draft: { outcome: 'no_change', reason: 'Stale draft must not be restored.' }, prepared: { invalid: true }, organizationPlan: { invalid: true } };
      await store.writeRecallJsonRecord(user, 'stock-organization', id, original);
      if (scenario.change === 'record') {
        await ontology.commitOntologyCommand(user, { commandId: 'changed-record', expectedRevision: 1, actions: [
          { intent: 'update', recordId: 'rule-a', expectedVersion: 1, sourceLabel: 'Synthetic later edit', patch: { name: '后续名称' } },
        ] });
        await expect(stock.assertStockOrganizationBaseline(user, oldUnit)).rejects.toMatchObject({ code: 'stock_organization_baseline_changed' });
      }
      model.mockImplementation(async (_uid, input) => {
        if (input.budget.stage !== 'extraction') return groundingResponse(input);
        const target = JSON.parse(input.message).primary.editableOntologyIds[0];
        return { result: { text: JSON.stringify(scenario.reuse && target === 'rule-a'
          ? { outcome: 'proposal', reason: '按条件与例外分段。', ontologyChanges: { reason: '分段整理', evidence: ['stored-version'],
            actions: [{ intent: 'update', recordId: target, patch: { requirement: newBody } }] } }
          : { outcome: 'no_change', reason: '当前内容无需修改。' }), meta: {} } };
      });
      if (scenario.reuse) {
        expect(await run()).toMatchObject({ proposed: 1, noChange: 1, failed: 0 });
        expect(model.mock.calls.map(call => call[1].budget.stage)).toEqual(['extraction', 'grounding', 'extraction']);
        expect(await candidate()).toMatchObject({ id: candidateId, stockOrganizationProvenance: { jobId: id } });
        const correctIdentity = legacyRangeJob(units[0], units[0]).identity; correctIdentity.contract = currentContract;
        const savedJob = await store.readRecallJsonRecord(user, 'stock-organization', id);
        expect(savedJob).toMatchObject({ id, candidateId, fingerprint: digest([correctIdentity, []]), state: 'proposed',
          unit: { sourceVersions: units[0].sourceVersions }, draft: { outcome: 'proposal' } });
        expect(savedJob?.organizationPlan).toBeUndefined();
        expect(savedJob?.prepared).not.toEqual(original.prepared);
        expect(stockJobs().filter(job => job.unit?.key === oldUnit.key)).toHaveLength(1);
      } else {
        expect(await run()).toMatchObject({ noChange: 2, failed: 0 });
        expect(model).toHaveBeenCalledTimes(2);
        expect(await store.readRecallJsonRecord(user, 'stock-organization', id)).toEqual(original);
        expect(stockJobs().filter(job => job.unit?.key === oldUnit.key)).toHaveLength(2);
        expect(await candidate()).toBeUndefined();
      }
    } finally { page.mockRestore(); }
  });
});
