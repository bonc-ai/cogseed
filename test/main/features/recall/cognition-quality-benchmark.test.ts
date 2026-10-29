/** Opt-in labelled evaluation, not a unit test with perfect vectors.
 * Local run: COGSEED_QUALITY_BENCHMARK=1 npm run test:js -- <this file> -t 'production retrieval'
 * Funded formation is separately opt-in and always uses the configured shared
 * HTTP budget/proxy. A default test run cannot make a model request. */
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { ACCESS_CASES, FORMATION_CASES, QUALITY_BENCHMARK_VERSION, QUALITY_TARGETS, RETRIEVAL_ASSETS, RETRIEVAL_CASES, SECURITY_CASES } from './cognition-quality-benchmark-fixture';
import { scoreFormationContract, scoreFormationOutputs, type FormationBenchmarkProposal } from './cognition-quality-benchmark-score';

const model = vi.hoisted(() => ({ calls: 0, attempts: [] as string[], fixedResponse: undefined as { text: string; meta: unknown } | undefined }));
vi.mock('../../../../src/main/features/auth', () => ({ listEntriesForUser: async () => ({ entries: [{ provider: 'live', model: 'configured' }] }),
  hasConfiguredModelForUser: () => ({ configured: true }), hasConfiguredModel: () => ({ configured: true }),
  getConfiguredModelOAuthExpiredMessageForUser: () => null, getConfiguredModelOAuthExpiredMessage: () => null }));
vi.mock('../../../../src/main/model/core-agent/runner', () => ({ buildRunner: async (options: { sessionId: string; systemPrompt: string }) => ({ runner: {
  run: async (input: { message: string; signal?: AbortSignal }) => {
    model.attempts.push(options.sessionId);
    // Explicit deterministic playback of a retained adverse real response.
    // Never reaches auth, the live proxy, a domain store or model billing.
    if (model.fixedResponse) return model.fixedResponse;
    if (process.env.COGSEED_QUALITY_BENCHMARK_LIVE !== '1') throw new Error('benchmark prohibits unapproved model calls');
    if (!process.env.COGSEED_RECALL_LIVE_BUDGET_ROOT) throw new Error('benchmark requires an explicit live billing context');
    const dir = path.join(process.env.COGSEED_WORKSPACE_ROOT!, 'benchmark-model-transcripts');
    await fs.mkdir(dir, { recursive: true });
    const request = { systemPrompt: options.systemPrompt, message: input.message,
      ...(process.env.COGSEED_QUALITY_BENCHMARK_RULE_AUDIT === '1'
        && process.env.COGSEED_RECALL_LIVE_BILLING_MODE !== 'coding-plan' ? { maxOutputTokens: 8192 } : {}) };
    for (const name of await fs.readdir(dir)) {
      const prior = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      if (prior.response && prior.request.systemPrompt === request.systemPrompt && prior.request.message === request.message) return prior.response;
    }
    // Format recovery and grounding are separate required stages. Retain both
    // in the ceiling; never retry merely to replace an unfavorable verdict.
    // A diagnosed continuation may consume cached earlier responses and pay
    // only for the one previously unfinished grounding request.
    if (process.env.COGSEED_QUALITY_BENCHMARK_RESUME_GROUNDING === '1'
      && (!options.sessionId.startsWith('memory-formation-') || model.calls >= 1))
      throw new Error('benchmark continuation permits only one uncached grounding call');
    if (model.calls >= 5) throw new Error('benchmark five-call ceiling reached');
    model.calls += 1;
    const file = path.join(dir, `${model.calls}-${options.sessionId.replace(/[^a-z0-9_-]/gi, '_')}.json`);
    await fs.writeFile(file, JSON.stringify({ request }));
    const response = await new Promise<any>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('test/helpers/recall-live-model-proxy.cjs')],
        { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', error = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
      child.on('error', reject); child.on('close', code => {
        const marker = output.lastIndexOf('@@RECALL_LIVE@@');
        if (code !== 0 || marker < 0) reject(new Error(`benchmark model adapter failed (${code}): ${error.slice(-1200)}`));
        else try { resolve(JSON.parse(output.slice(marker + '@@RECALL_LIVE@@'.length).trim())); } catch (error) { reject(error); }
      });
      const abort = () => child.kill('SIGTERM'); input.signal?.addEventListener('abort', abort, { once: true });
      child.once('close', () => input.signal?.removeEventListener('abort', abort));
      if (input.signal?.aborted) abort();
      child.stdin.end(JSON.stringify(request));
    }).catch(async error => {
      await fs.writeFile(file, JSON.stringify({ request, failure: { message: String(error.message) } }));
      throw error;
    });
    await fs.writeFile(file, JSON.stringify({ request, response }));
    return response;
  },
} }) }));

const uid = 'quality-benchmark-user';
let root = '', needsDrain = false, stop: (() => void) | undefined;
afterEach(async () => { stop?.(); stop = undefined; vi.useRealTimers(); if (needsDrain) await drainMainRuntimeForTest(uid); root = ''; needsDrain = false; model.fixedResponse = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function isolatedRoot() {
  vi.resetModules(); model.calls = 0; model.attempts = [];
  root = process.env.COGSEED_QUALITY_BENCHMARK_ROOT || await fs.mkdtemp(path.join(os.tmpdir(), 'cogseed-quality-benchmark-'));
  if (!(await fs.realpath(root)).startsWith((await fs.realpath(os.tmpdir())) + path.sep)) throw new Error('benchmark requires OS temporary isolation');
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
  vi.stubEnv('COGSEED_SEMANTICA_ENABLED', '0');
  needsDrain = true;
  await fs.writeFile('/tmp/cogseed-quality-benchmark-root', root);
  return root;
}
async function writeReport(name: string, data: unknown) {
  const file = path.join(root, name);
  const previous = name === 'quality-formation-result.json'
    ? await fs.readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined) : undefined;
  const report = previous ? { ...data as object, priorAttempts: [...(previous.priorAttempts || []), { ...previous, priorAttempts: undefined }] } : data;
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  process.stdout.write(`\nQUALITY_BENCHMARK_RESULT ${file}\n`);
}
const ratio = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;

it('holds all nine real prose-only rule repairs when replayed without complete field-level proof', async () => {
  vi.resetModules(); model.calls = 0; model.attempts = [];
  vi.stubEnv('COGSEED_QUALITY_BENCHMARK_LIVE', '0');
  const retained = JSON.parse(await fs.readFile(path.resolve('test/main/features/recall/cognition-quality-benchmark-rule-audit-negative.json'), 'utf8'));
  model.fixedResponse = retained.response;
  const { assessFormationBatch } = await import('../../../../src/main/features/recall/formation-batch-assessment');
  const { formationRuleContracts, validateFormationRuleChecks } = await import('../../../../src/main/features/recall/ontology-rule-semantics');
  const payload = retained.input;
  const assessments = JSON.parse(retained.response.text).assessments;
  const blocked = payload.candidates.flatMap(item => {
    const contracts = formationRuleContracts(item.candidate.ontologyChanges, payload.ontology.records);
    if (!contracts.length) return [];
    const row = assessments.find(row => row.index === item.index);
    expect(row.checks.finalDecisionPreserved).toBe(true); // original adverse verdict retained
    expect(row.ruleRevisions).toBeUndefined();
    expect(() => validateFormationRuleChecks(row.ruleChecks, contracts, item.sources)).toThrow();
    return contracts.map(contract => contract.recordId);
  });
  expect(new Set(blocked).size).toBe(9);
  const result = await assessFormationBatch(uid, { sessionId: 'memory-formation-retained-negative-replay', items: payload.candidates,
    contextMessages: payload.completeConversationContext, summary: payload.summary,
    existing: { assets: payload.existingAssets, coverage: payload.comparisonCoverage }, ontology: payload.ontology, feedback: payload.feedback,
    modelCandidates: [{ provider: 'retained-fixture', model: 'no-network' }] });
  // The original nine unsafe R rows remain blocked. Partial isolation keeps
  // the three independent non-rule facts rather than rejecting them as well.
  const ruleIndexes = payload.candidates.filter(item => formationRuleContracts(item.candidate.ontologyChanges, payload.ontology.records).length)
    .map(item => item.index);
  expect(result.assessments.map(row => row.index).sort()).toEqual(payload.candidates.map(item => item.index)
    .filter(index => !ruleIndexes.includes(index)).sort());
  expect(result.itemFailures?.map(row => row.index).sort()).toEqual(ruleIndexes.sort());
  expect(model.calls).toBe(0);
  expect(model.attempts).toEqual(['memory-formation-retained-negative-replay']);
});

it('distinguishes wrong positive assertions from negation and forbidden fields in the fixed correction score', () => {
  const unit = FORMATION_CASES.find(row => row.id === 'f11')!;
  const good = { judgment: 'QA-Nova 测试联系人是陈工，林工不是联系人。', forbiddenWhen: ['不要联系林工'] };
  expect(scoreFormationContract(unit, good).semantic).toBe(true);
  expect(scoreFormationContract(unit, { ...good, judgment: 'QA-Nova 请不要联系林工，应联系陈工。' }).semantic).toBe(true);
  expect(scoreFormationContract(unit, { ...good, judgment: 'QA-Nova 的联系人是林工，陈工另有安排。' }).semantic).toBe(false);
  expect(scoreFormationContract(unit, { ...good, applicableWhen: ['安排 QA-Nova 测试时联系林工'] }).semantic).toBe(false);
  expect(scoreFormationContract(unit, { ...good, forbiddenWhen: ['联系陈工'] }).semantic).toBe(false);
});

it.skipIf(process.env.COGSEED_QUALITY_BENCHMARK_RESCORE !== '1')('rescores persisted original proposals without model or domain writes', async () => {
  vi.resetModules(); model.calls = 0; model.attempts = [];
  vi.stubEnv('COGSEED_QUALITY_BENCHMARK_LIVE', '0');
  root = process.env.COGSEED_QUALITY_BENCHMARK_ROOT || '';
  if (!root || !(await fs.realpath(root)).startsWith((await fs.realpath(os.tmpdir())) + path.sep)) throw new Error('rescore requires original OS temporary root');
  const originalFile = path.join(root, 'quality-formation-result.json');
  const original = JSON.parse(await fs.readFile(originalFile, 'utf8'));
  if (original.version !== QUALITY_BENCHMARK_VERSION || original.stageStatus !== 'review_ready') throw new Error('rescore requires a completed original formation');
  const dir = path.join(root, uid, 'cloud', 'recall', 'records', 'candidates');
  // Original fixture records are deliberately readable JSON. Never call the
  // candidate API here: its migration/recovery hooks are writes, not rescore.
  const rows = await Promise.all((await fs.readdir(dir)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))));
  const formed = rows.filter(row => row.ownerId === uid && row.captureProvenance?.captureId === original.captureId && row.status === 'pending_review') as FormationBenchmarkProposal[];
  const sourceIds = Object.fromEntries(original.unitChecks.map((row: { id: string; sourceId: string }) => [row.id, row.sourceId]));
  const metrics = scoreFormationOutputs(formed, sourceIds, 'benchmark-project');
  const report = { version: QUALITY_BENCHMARK_VERSION, mode: 'read_only_original_candidate_rescore', originalFile,
    reason: 'Field-polarity scorer defect: a correct forbiddenWhen prohibition was treated as a positive wrong assertion. Fixed labels, source IDs, proposals and thresholds unchanged.',
    targets: QUALITY_TARGETS, modelCalls: model.calls, domainWrites: 0, ...metrics };
  await writeReport('quality-formation-rescore.json', report);
  expect(model.attempts).toEqual([]);
  expect(formed).toHaveLength(original.proposalChecks.length);
  expect(report.recall.value).toBeGreaterThanOrEqual(QUALITY_TARGETS.formationRecall);
  expect(report.precision.value).toBeGreaterThanOrEqual(QUALITY_TARGETS.formationPrecision);
});

it.skipIf(process.env.COGSEED_QUALITY_BENCHMARK_RULE_AUDIT !== '1')('audits all persisted original rule contracts once without re-extraction or saving', async () => {
  vi.resetModules(); model.calls = 0; model.attempts = [];
  root = process.env.COGSEED_QUALITY_BENCHMARK_ROOT || '';
  if (!root || !(await fs.realpath(root)).startsWith((await fs.realpath(os.tmpdir())) + path.sep)) throw new Error('rule audit requires original OS temporary root');
  vi.stubEnv('COGSEED_WORKSPACE_ROOT', root);
  const original = JSON.parse(await fs.readFile(path.join(root, 'quality-formation-result.json'), 'utf8'));
  const dir = path.join(root, uid, 'cloud', 'recall', 'records', 'candidates');
  const stored = await Promise.all((await fs.readdir(dir)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))));
  const formed = stored.filter(row => row.ownerId === uid && row.captureProvenance?.captureId === original.captureId && row.status === 'pending_review');
  const transcripts = path.join(root, 'benchmark-model-transcripts');
  const groundingFile = (await fs.readdir(transcripts)).find(name => name.includes('memory-formation-recall-'))!;
  const prior = JSON.parse(JSON.parse(await fs.readFile(path.join(transcripts, groundingFile), 'utf8')).request.message);
  const proof = formed[0].captureProvenance;
  const items = formed.map((row, index) => {
    const selected = new Set(row.evidenceRefs.filter(ref => ref.subtype === 'message').map(ref => ref.id));
    const sources = prior.completeConversationContext.filter(message => message.role === 'user').flatMap(message => {
      const approvedQuotes = proof.valueJudgment.evidence.filter(ref => ref.messageId === message.id && selected.has(ref.sourceId)).map(ref => ref.quote);
      return approvedQuotes.length ? [{ label: message.label, text: message.text, approvedQuotes }] : [];
    });
    const plan = row.ontologyFormation;
    return { index, sources, candidate: { judgment: row.judgment, value: row.value, suggestedScope: row.suggestedScope,
      suggestedAction: row.suggestedAction, scopePolicy: row.scopePolicy, applicableWhen: row.applicableWhen, forbiddenWhen: row.forbiddenWhen,
      ...(plan ? { ontologyChanges: { actions: plan.actions, refs: plan.refs, reason: plan.reason, evidence: plan.evidence } } : {}) } };
  });
  const { assessFormationBatch } = await import('../../../../src/main/features/recall/formation-batch-assessment');
  const { reviseFormationRuleSemantics } = await import('../../../../src/main/features/recall/ontology-rule-semantics');
  const { readOntologyDocument } = await import('../../../../src/main/features/cognition/ontology/service');
  const { parseOntologyFormationProposal, validateOntologyFormationScope } = await import('../../../../src/main/features/recall/ontology-formation');
  const canonical = structuredClone(readOntologyDocument(uid));
  const result = await assessFormationBatch(uid, { sessionId: 'memory-formation-original-rule-source-audit-v3', items,
    contextMessages: prior.completeConversationContext, summary: prior.summary, existing: { assets: prior.existingAssets, coverage: prior.comparisonCoverage },
    ontology: prior.ontology, feedback: prior.feedback, modelCandidates: [{ provider: 'live', model: 'configured' }] });
  const audited = result.assessments.map(assessment => {
    const row = formed[assessment.index];
    const owned = items[assessment.index].candidate.ontologyChanges;
    const originalRules = row.ontologyFormation?.previewChanges.filter(change => change.after.kind === 'rule').map(change => change.after) || [];
    let correctedPreview: ReturnType<typeof parseOntologyFormationProposal>;
    if (assessment.ruleRevisions?.length) {
      const revised = reviseFormationRuleSemantics(owned, assessment.ruleRevisions, Object.values(canonical.records));
      const plan = validateOntologyFormationScope(uid, canonical, parseOntologyFormationProposal(structuredClone(canonical), row.id, revised, row.judgment), row.scopePolicy)!;
      expect(plan.blockedReasons).toEqual([]);
      correctedPreview = plan;
    }
    const resultingRules = correctedPreview?.previewChanges.filter(change => change.after.kind === 'rule').map(change => change.after) || originalRules;
    const bodyUnchanged = resultingRules.every(rule => rule.requirement === row.judgment);
    expect(bodyUnchanged).toBe(true);
    const metadataChanges = originalRules.map(before => {
      const after = resultingRules.find(rule => rule.id === before.id)!;
      const fields = ['strength', 'condition', 'effect', 'exception'];
      return { recordId: before.id, before: Object.fromEntries(fields.map(key => [key, before[key]])),
        after: Object.fromEntries(fields.map(key => [key, after[key]])) };
    });
    return { candidateId: row.id, units: original.proposalChecks.find(item => item.candidateId === row.id)?.citedUnits,
      originalRules, assessment, metadataChanges, bodyUnchanged, originalSourceIds: row.evidenceRefs.map(ref => ref.id),
      previewScope: correctedPreview ? { checkedInMemory: true, blockedReasons: correctedPreview.blockedReasons } : { checkedInMemory: false }, correctedPreview };
  });
  const report = { version: QUALITY_BENCHMARK_VERSION, mode: 'one_new_rule_semantics_batch_over_original_candidates',
    originalCaptureId: original.captureId, originalCandidates: formed.length, originalRuleCount: audited.reduce((sum, row) => sum + row.originalRules.length, 0),
    newProxyCalls: model.calls, domainWrites: 0, bodyResampling: false, itemFailures: result.itemFailures || [],
    originalCompleteContractReview: { numerator: 4, denominator: 12, value: 4 / 12,
      method: 'independent attributed-source review, not the model self-verdict or body-only scorer',
      faithfulUnits: ['f01', 'f09', 'f10', 'f11'], downgradedObligationUnits: ['f02', 'f03', 'f04', 'f05', 'f06', 'f07', 'f08', 'f12'],
      note: 'f01 default retains a defeasible expression preference; a source-supported required interpretation must be reviewed separately, not mechanically rejected. Original results are not overwritten by a hypothetical corrected preview.' }, audited };
  await writeReport('quality-original-rule-source-audit-v3.json', report);
  expect(formed).toHaveLength(12);
  expect(model.calls).toBeLessThanOrEqual(1);
  expect(result.itemFailures || []).toEqual([]);
  expect(audited).toHaveLength(12);
  expect(report.originalRuleCount).toBe(9);
  for (const row of audited) {
    expect(Object.entries(row.assessment.checks).filter(([key]) => key !== 'evidence').every(([, value]) => value === true)).toBe(true);
    for (const change of row.metadataChanges) {
      expect(change.after.condition).toBeNull(); // corpus has no exact machine predicate
      expect(change.after.effect).toEqual({ kind: 'note' }); // no exact heading/action binding
      if (row.units.includes('f01')) expect(['default', 'required']).toContain(change.after.strength);
      else expect(change.after.strength).toBe('required');
      if (row.units.includes('f03')) expect(change.after.exception).toMatch(/闲聊/);
      if (row.units.includes('f12')) expect(change.after.exception).toMatch(/普通(例会|会议)/);
    }
  }
}, 180_000);

it.skipIf(process.env.COGSEED_QUALITY_BENCHMARK !== '1')('measures production retrieval with real bundled embeddings and twenty source/access counterexamples', async () => {
  await isolatedRoot();
  const store = await import('../../../../src/main/features/recall/store');
  const chats = await import('../../../../src/main/features/chats');
  const source = await chats.createConversation(uid, { conversationId: 'benchmark-source', title: 'Synthetic labelled retrieval corpus' });
  const hidden = await chats.createConversation(uid, { conversationId: 'benchmark-paused-source', title: 'Synthetic disabled source' });
  const at = new Date().toISOString();
  const seed = async (asset: { id: string; title: string; statement: string }, extra = {}) => store.writeRecallJsonRecord(uid, 'ability-assets', asset.id,
    { schemaVersion: 2, ownerId: uid, id: asset.id, title: asset.title, statement: asset.statement,
      candidateId: `fixture-${asset.id}`, sourceCandidateIds: [], reviewDecisionId: `fixture-${asset.id}`,
      type: 'cognition', contentCategory: 'unclassified', status: 'active', maturity: 'bud', lifecycleStatus: 'automatically_extracted_unverified',
      scope: 'general', version: '1', evidenceRefs: [{ taxonomyVersion: 2, kind: 'conversation', subtype: 'session', scope: 'conversation', id: source.conversation_id }],
      sourceSessionIds: [source.conversation_id], createdAt: at, updatedAt: at, ...extra });
  for (const asset of RETRIEVAL_ASSETS) await seed(asset);
  for (const asset of SECURITY_CASES) await seed(asset, {
    ...(asset.policy ? { scopePolicy: asset.policy } : {}),
    ...(['paused', 'revoked'].includes(asset.family) ? { status: asset.family } : {}),
    ...(asset.family === 'source' ? { evidenceRefs: [{ taxonomyVersion: 2, kind: 'conversation', subtype: 'session', scope: 'conversation', id: hidden.conversation_id }] } : {}),
  });
  await (await import('../../../../src/main/features/recall/source-control')).pauseCognitionSource(uid,
    { taxonomyVersion: 2, kind: 'conversation', subtype: 'session', scope: 'conversation', id: hidden.conversation_id });
  // Observe the actual retrieval channel; no synthetic vectors or model answer
  // substitutes are injected. Missing embeddings fail availability explicitly.
  const relevance = await import('../../../../src/main/features/recall/catalog-relevance');
  const actualMatches = relevance.catalogMatches;
  const semanticCoverage: Array<{ query: string; eligible: number; embedded: number }> = [];
  vi.spyOn(relevance, 'catalogMatches').mockImplementation(async (...args) => {
    const result = await actualMatches(...args);
    semanticCoverage.push({ query: args[1], eligible: args[2].length, embedded: [...result.values()].filter(row => row.semantic !== undefined).length });
    return result;
  });
  const { createRecallToolSuite } = await import('../../../../src/main/model/core-agent/recall-tools');
  const rows: Array<{ id: string; stratum: string; query: string; expected: string[]; rankedIds: string[]; hit: boolean; unauthorized: string[] }> = [];
  for (const item of [...RETRIEVAL_CASES, ...ACCESS_CASES]) {
    const tool = createRecallToolSuite({ userId: uid, cid: source.conversation_id, agentId: 'commander', projectId: 'public-project',
      spaceId: 'public-workspace', taskText: item.query }).tools.find(tool => tool.name === 'search_ability_assets')!;
    const result = await tool.execute({ query: item.query, k: 5 }, {} as never);
    const content = String((result as { content?: unknown }).content || '');
    const rankedIds = [...content.matchAll(/^\d+\. \[asset:([^\]]+)\]/gm)].map(match => match[1]);
    const expected = 'relevantId' in item ? [item.relevantId] : [];
    const forbidden = 'forbiddenId' in item ? item.forbiddenId : undefined;
    rows.push({ id: item.id, stratum: 'stratum' in item ? item.stratum : `access:${item.family}`, query: item.query,
      expected, rankedIds, hit: expected.length ? expected.every(id => rankedIds.includes(id)) : !rankedIds.includes(forbidden!),
      unauthorized: rankedIds.filter(id => SECURITY_CASES.some(asset => asset.id === id)) });
    if ((result as { isError?: boolean }).isError) rows.at(-1)!.hit = false;
  }
  const retrieval = rows.filter(row => row.expected.length);
  const access = rows.filter(row => !row.expected.length);
  const strata = Object.fromEntries([...new Set(retrieval.map(row => row.stratum))].map(stratum => {
    const items = retrieval.filter(row => row.stratum === stratum);
    return [stratum, { numerator: items.filter(row => row.hit).length, denominator: items.length, recallAt5: ratio(items.filter(row => row.hit).length, items.length) }];
  }));
  const result = { version: QUALITY_BENCHMARK_VERSION, sampleOrigin: 'authored_synthetic_not_user_data',
    scope: 'production search_ability_assets ranking and current source/access admission; not model formation or answer application',
    targets: QUALITY_TARGETS, localEmbedding: 'actual bundled bge-small-zh-v1.5; no embedding/model response mock',
    retrieval: { numerator: retrieval.filter(row => row.hit).length, denominator: retrieval.length, recallAt5: ratio(retrieval.filter(row => row.hit).length, retrieval.length), strata },
    access: { unauthorizedHits: rows.reduce((sum, row) => sum + row.unauthorized.length, 0), counterexamples: access.length, evaluatedQueries: rows.length },
    semanticCoverage, modelAttempts: model.attempts, failures: rows.filter(row => !row.hit || row.unauthorized.length), rows };
  await writeReport('quality-retrieval-result.json', result);
  expect(semanticCoverage).toHaveLength(100);
  expect(semanticCoverage.every(row => row.embedded === row.eligible && row.embedded > 0)).toBe(true);
  expect(model.attempts).toEqual([]);
  expect(result.retrieval.recallAt5).toBeGreaterThanOrEqual(QUALITY_TARGETS.recallAt5);
  for (const stratum of Object.values(strata)) expect(stratum.recallAt5).toBeGreaterThanOrEqual(QUALITY_TARGETS.recallAt5);
  expect(result.access.unauthorizedHits).toBe(0);
}, 120_000);

it.skipIf(process.env.COGSEED_QUALITY_BENCHMARK_LIVE !== '1')('measures fixed multi-topic formation through real production capture stages without judging the model by its own verdict', async () => {
  await isolatedRoot();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 15, 3));
  const chats = await import('../../../../src/main/features/chats');
  const storage = await import('../../../../src/main/storage');
  const layout = await import('../../../../src/main/util/project-layout');
  const capture = await import('../../../../src/main/features/recall/capture-service');
  const settings = await import('../../../../src/main/features/recall/capture-settings');
  const store = await import('../../../../src/main/features/recall/store');
  const candidates = await import('../../../../src/main/features/recall/candidate-service');
  const { cognitionMessageSourceId } = await import('../../../../src/main/features/recall/source-catalog');
  const cid = 'benchmark-formation', projectId = 'benchmark-project';
  // The supported legacy project layout enumerates project.json, not bare
  // directories. Seed that labelled temporary metadata before chat creation so
  // the real all-conversation inventory can discover this scoped source.
  const { projectMetaFile } = await import('../../../../src/main/paths');
  await storage.writeJson(projectMetaFile(uid, projectId), { id: projectId, ownerId: uid, name: 'Synthetic quality project' });
  // Reuse an ordinary minimal scoped T and the known synthetic account owner.
  // No assertion, rule, candidate, expected formation or model decision is
  // preseeded; the real extractor still owns every supported A/R proposal.
  const ontology = await import('../../../../src/main/features/cognition/ontology/service');
  if (!ontology.readOntologyDocument(uid).records['benchmark-module']) {
    const create = (recordId: string, record: Record<string, unknown>) => ({ intent: 'create' as const, recordId, sourceLabel: 'Synthetic pre-existing test ontology', record });
    await ontology.commitOntologyCommand(uid, { commandId: 'benchmark-existing-structure', expectedRevision: ontology.readOntologyDocument(uid).revision, actions: [
      create('benchmark-module', { kind: 'module', name: '合成项目工作知识', description: '隔离评估既有结构', scope: { kind: 'project', id: projectId } }),
      create('benchmark-person-type', { kind: 'definition', moduleId: 'benchmark-module', name: '人物', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('benchmark-project-type', { kind: 'definition', moduleId: 'benchmark-module', name: '项目', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' }),
      create('benchmark-self', { kind: 'entity', moduleId: 'benchmark-module', typeId: 'benchmark-person-type', name: '本合成测试账号', description: '本次对话的已知用户；仅为隔离测试账号', aliases: ['用户', '自己'], identityStatus: 'confirmed' }),
      create('benchmark-preference', { kind: 'definition', moduleId: 'benchmark-module', name: '已表达偏好与要求', description: '保留每条完整适用条件，允许多条独立表达', definitionKind: 'attribute', subjectTypes: ['benchmark-person-type'], objectTypes: [], valueType: 'text', cardinality: 'many', cardinalityAnchor: 'subject' }),
    ] as never });
  }
  if (!await chats.getConversation(uid, cid)) await chats.createConversation(uid, { conversationId: cid, title: '合成工作回顾：独立话题、反例与纠正', projectId });
  // Interleave positive and negative units to prevent a valuable prefix from
  // being mistaken for the entire run. No cross-group executable dependency.
  const order = [0, 12, 1, 13, 2, 14, 3, 15, 4, 16, 5, 17, 6, 18, 7, 19, 8, 9, 10, 11];
  const existingMessages = await storage.readJsonl<{ id: string }>(layout.conversationMessageFile(uid, cid));
  let minute = 0;
  for (const index of order) for (const [part, message] of FORMATION_CASES[index].messages.entries()) {
    const id = `${FORMATION_CASES[index].id}-m${part + 1}`;
    const ts = new Date(2026, 9, 14, 12, minute++).toISOString();
    if (!existingMessages.some(row => row.id === id)) await storage.appendJsonlAtomic(layout.conversationMessageFile(uid, cid), {
      id, ts, from: message.role === 'user' ? 'user' : 'commander',
      to: [message.role === 'user' ? 'commander' : 'user'], text: message.text,
    });
  }
  await settings.updateRecallCaptureSettings(uid, { autoApproval: false });
  stop = capture.startRecallCaptureOrchestrator();
  await capture.runNightlyCaptureSweep(uid, new Date().toISOString(), await settings.readRecallCaptureSettings(uid));
  const capturePaths = await import('../../../../src/main/features/recall/paths');
  const captureDir = path.dirname(capturePaths.recallJsonRecordPath(uid, 'captures', 'placeholder'));
  const all = await Promise.all((await fs.readdir(captureDir)).filter(name => name.endsWith('.json'))
    .map(name => capture.readRecallCapture(uid, name.slice(0, -5))));
  let record = all.find(row => row.conversationId === cid)!;
  expect(record).toBeDefined();
  if (record.status === 'failed') record = await store.updateRecallJsonRecord(uid, 'captures', record.id, current => ({ ...current!, status: 'queued' }));
  if (record.status === 'queued') record = await capture.runRecallCapture(uid, record.id);
  if (record.status === 'extracting') await vi.waitFor(async () => {
    record = await capture.readRecallCapture(uid, record.id); expect(record.status).not.toBe('extracting');
  }, { interval: 250, timeout: 300_000 });
  const formed = (await candidates.listRecallCandidates(uid)).filter(row => row.captureProvenance?.captureId === record.id && row.status === 'pending_review');
  const sourceIds = Object.fromEntries(FORMATION_CASES.map(unit => [unit.id, cognitionMessageSourceId(cid, `${unit.id}-m${unit.messages.length}`)]));
  const metrics = scoreFormationOutputs(formed as unknown as FormationBenchmarkProposal[], sourceIds, projectId);
  const result = { version: QUALITY_BENCHMARK_VERSION, sampleOrigin: 'fixed_authored_synthetic',
    scope: 'one real production multi-topic capture; not independent conversations or a population guarantee',
    scoring: 'source-ID plus fixed action/scope; new understanding checked in body, scope/exception and counterassertions checked in complete body+applicableWhen+forbiddenWhen contract; complete content retained for independent audit; model supported=true is not a label',
    targets: QUALITY_TARGETS, stageStatus: record.status, errorCode: record.errorCode,
    ...metrics,
    newProxyCalls: model.calls, attemptedStages: model.attempts, captureId: record.id };
  await writeReport('quality-formation-result.json', result);
  expect(record.status).toBe('review_ready');
  expect(result.recall.value).toBeGreaterThanOrEqual(QUALITY_TARGETS.formationRecall);
  expect(result.precision.value).toBeGreaterThanOrEqual(QUALITY_TARGETS.formationPrecision);
}, 600_000);
