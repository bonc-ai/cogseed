/** Reviewed many-to-one / one-to-many cognition changes on the existing atomic source rail. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { t } from '../../i18n';
import { prompts } from '../../prompts/loader';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { cognitionCompatibility, withCognitionTransition, withCognitionSourceDependency } from '../cognition_bridge';
import { readOntologyDocument } from '../cognition/ontology/service';
import { applyOntologyCommand, type OntologyAction } from '../cognition/ontology/commands';
import { OntologyError, type OntologyDocument, type OntologyRecord } from '../cognition/ontology/model';
import { ontologyDependencyClosure } from '../cognition/ontology/dependencies';
import { ontologyScopeViolations } from '../cognition/ontology/cognition-scope';
import { prepareCognitionAssetEdit, assertCognitionManagementTarget, cognitionManagementAssetMatches, describeCognitionOntology, type CognitionEditHost } from '../cognition/edit-service';
import { assertCognitionManagementActive, confirmCognitionManagement } from '../cognition/management-confirmation';
import { writeReviewDecision } from '../cognition/review-decision';
import { readAbilityAssetVersionSnapshot, listAbilityAssets } from './asset-service';
import { candidateIdForCaptureKey, readRecallCandidate, listRecallCandidates, saveRecallCandidate, withRecallCandidatePromotionLock,
  type RecallAbilityAssetRecord, type RecallCandidateRecord, type SaveRecallCandidateInput } from './candidate-service';
import { assetVersionSnapshot, withPendingAssetVersion, withAssetVersionMetadata } from './asset-version-journal';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { notifyCognitionWrite } from './store-events';
import { normalizeCognitionSourceRefsForWrite, cognitionSourceRefKey } from './source-service';
import { readCognitionSourceBaselines } from './source-catalog';
import { cognitionSourceBaselineForRef } from './source-baseline';
import { cognitionSourceControlSnapshot } from './source-control';
import { validatePromotionByAssetType } from './formal-assets/promotion';

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
import { organizationOutputSchema, organizationDraftSchema, type OrganizationDraft, type OrganizationSource, type ContentOrganizationPlan, type ContentOrganizationReceipt } from './content-organization-contract';
export { organizationOutputSchema, organizationDraftSchema, type OrganizationDraft, type ContentOrganizationPlan, type ContentOrganizationReceipt } from './content-organization-contract';
const permit = new AsyncLocalStorage<SaveRecallCandidateInput>();
const clean = (row: Record<string, unknown>) => { const { pendingVersionSnapshots: _pending, ...rest } = row; return JSON.parse(JSON.stringify(rest)); };
function fail(message: string): never { throw new OntologyError('baseline_changed', message); }
function boundary(asset: RecallAbilityAssetRecord) {
  return { type: asset.type, contentCategory: asset.contentCategory, scope: asset.scope, status: asset.status, spaceId: asset.spaceId,
    policy: Object.fromEntries(Object.entries(asset.scopePolicy || {}).sort().map(([k, v]) => [k, [...v].sort()])) };
}
async function sourceState(userId: string, sources: OrganizationSource[]) {
  const refs = normalizeCognitionSourceRefsForWrite(sources.flatMap(row => row.content.evidenceRefs));
  const versions = await readCognitionSourceBaselines(userId, refs);
  return refs.map(ref => {
    const version = versions.get(cognitionSourceRefKey(ref));
    if (!version) fail(t('cognition.organization.source_unavailable'));
    return JSON.stringify([ref, cognitionSourceBaselineForRef(ref, version), cognitionSourceControlSnapshot(userId, ref)]);
  });
}
async function readSource(userId: string, assetId: string): Promise<OrganizationSource> {
  const head = await prepareCognitionAssetEdit(userId, assetId);
  if (!['active', 'paused'].includes(head.status)) fail(t('cognition.organization.inactive'));
  const active = String(head.activeVersion || head.version);
  const snapshot = active === head.version ? assetVersionSnapshot(head) : await readAbilityAssetVersionSnapshot(userId, assetId, active);
  if (!snapshot) fail(t('cognition.organization.active_missing'));
  const content = { ...head, ...snapshot, version: head.version, activeVersion: active, status: head.status,
    scope: head.scope, scopePolicy: head.scopePolicy } as RecallAbilityAssetRecord;
  if (!content.evidenceRefs.length && content.sourceSessionIds?.length) fail(t('cognition.organization.legacy_source'));
  await (await import('../cognition/edit-service')).assertAssetManagementSources(userId, content);
  return { head, rawHead: (await readRecallJsonRecord(userId, 'ability-assets', assetId)) as RecallAbilityAssetRecord, content };
}
async function assertReferenceImpact(userId: string, draft: OrganizationDraft, sources: OrganizationSource[], sharedIds: Set<string>, doc: OntologyDocument) {
  const others = (await listAbilityAssets(userId)).filter(asset => !draft.sourceAssetIds.includes(asset.id) && ['active', 'paused'].includes(asset.status));
  if (others.some(asset => asset.relations?.some(ref => draft.sourceAssetIds.includes(ref.assetId) && !['related_to', 'same_family'].includes(ref.kind)))
    || (draft.operation === 'split' && sources.some(row => row.content.relations?.some(ref => !['related_to', 'same_family'].includes(ref.kind)))))
    throw new Error(t('cognition.organization.unresolved_reference'));
  if (others.some(asset => asset.ontologyRefs?.some(ref => sharedIds.has(ref.recordId!)))
    || Object.values(doc.records).some(record => record.kind === 'reference' && record.status === 'active' && sharedIds.has(record.targetRecordId!)))
    throw new Error(t('cognition.organization.rule_referenced'));
}
export async function prepareContentOrganization(userId: string, input: OrganizationDraft, origin: ContentOrganizationPlan['origin'], reviewedOperationId?: string): Promise<ContentOrganizationPlan> {
  const draft = organizationDraftSchema.parse(input);
  if (new Set(draft.sourceAssetIds).size !== draft.sourceAssetIds.length
    || (draft.operation === 'merge' ? draft.sourceAssetIds.length < 2 || draft.outputs.length !== 1 : draft.sourceAssetIds.length !== 1 || draft.outputs.length < 2))
    throw new Error(t('cognition.organization.cardinality'));
  if (cognitionCompatibility(userId)?.mode !== 'unified') throw new Error(t('cognition.organization.migration_required'));
  const sources = await Promise.all(draft.sourceAssetIds.map(assetId => readSource(userId, assetId)));
  if (sources.some(row => !isDeepStrictEqual(boundary(row.head), boundary(sources[0].head)))) throw new Error(t('cognition.organization.incompatible'));
  const doc = readOntologyDocument(userId), state = await sourceState(userId, sources);
  const linked = new Set(sources.flatMap(row => (row.content.ontologyRefs || []).flatMap(ref => ref.recordId ? [ref.recordId] : [])));
  if (sources.some(row => row.content.ontologyRefs?.some(ref => !ref.recordId))) throw new Error(t('cognition.organization.legacy_ontology'));
  const dependencies = ontologyDependencyClosure(doc.records, [...linked]);
  if (!dependencies) fail(t('cognition.organization.missing_dependency'));
  for (const dependency of dependencies) await (await import('../cognition/edit-service')).assertOntologyManagementSources(userId, dependency);
  for (const output of draft.outputs) {
    if (output.sourceAssetIds.some(source => !draft.sourceAssetIds.includes(source)) || new Set(output.sourceAssetIds).size !== output.sourceAssetIds.length
      || output.excerpts.some(part => !output.sourceAssetIds.includes(part.assetId) || !sources.find(row => row.head.id === part.assetId)?.content.statement.includes(part.quote))
      || output.sourceAssetIds.some(source => !output.excerpts.some(part => part.assetId === source))) throw new Error(t('cognition.organization.excerpts_required'));
    if (output.ontologyRecordIds.some(recordId => !linked.has(recordId))) throw new Error(t('cognition.organization.unknown_ontology'));
    if (output.value === output.statement) throw new Error(t('cognition.organization.purpose_copy'));
    const validation = validatePromotionByAssetType({ judgment: output.statement, summary: output.title, value: output.value,
      suggestedType: sources[0].head.type, suggestedScope: sources[0].head.scope, suggestedAction: 'create',
      applicableWhen: output.applicableWhen, forbiddenWhen: output.forbiddenWhen }, { actor: 'user' });
    if (!validation.ok) throw new Error(t('cognition.organization.invalid_content'));
  }
  if (draft.sourceAssetIds.some(source => !draft.outputs.some(output => output.sourceAssetIds.includes(source)))
    || [...linked].some(recordId => !draft.outputs.some(output => output.ontologyRecordIds.includes(recordId)))) throw new Error(t('cognition.organization.missing_destination'));
  // A host identity binds the exact inputs, policy and complete result; retries do not mint new IDs.
  const operationId = reviewedOperationId || 'org-' + hash([1, origin, draft, sources.map(row => clean(row.head)), state, [...linked].map(key => doc.records[key])]).slice(0, 32);
  const resultIds = draft.outputs.map((_, index) => `aa-${operationId}-${index + 1}`);
  const now = new Date().toISOString();
  const actions: OntologyAction[] = [];
  const sharedIds = new Set(sources.flatMap(row => (row.content.ontologyRefs || []).filter(ref => ref.sharedBody).map(ref => ref.recordId!)));
  await assertReferenceImpact(userId, draft, sources, sharedIds, doc);
  for (const recordId of linked) {
    const record = doc.records[recordId];
    if (!record || record.status !== 'active') fail(t('cognition.organization.ontology_unavailable'));
    await (await import('../cognition/edit-service')).assertOntologyManagementSources(userId, record);
    if (sources.some(row => row.content.ontologyRefs?.some(ref => ref.recordId === recordId && ref.versionPolicy === 'pinned'))) throw new Error(t('cognition.organization.pinned'));
    if (sharedIds.has(recordId)) actions.push({ intent: 'update', recordId, expectedVersion: record.version, patch: { status: 'archived' }, sourceLabel: draft.reason.slice(0, 200) });
    else if (record.source.refs?.some(ref => ref.kind === 'asset' && draft.sourceAssetIds.includes(ref.id))
      || (record.source.kind === 'candidate' && sources.some(row => row.head.candidateId === record.source.recordId)))
      actions.push({ intent: 'update', recordId, expectedVersion: record.version, patch: { access: record.access }, sourceLabel: draft.reason.slice(0, 200) });
  }
  draft.outputs.forEach((output, index) => {
    const rules = output.ontologyRecordIds.filter(key => sharedIds.has(key)).map(key => doc.records[key]).filter(record => record.kind === 'rule');
    if (!rules.length) return;
    const semantics = (rule: typeof rules[number]) => ({ moduleId: rule.moduleId, strength: rule.strength, condition: rule.condition, effect: rule.effect, exception: rule.exception, access: rule.access });
    if (rules.some(rule => !isDeepStrictEqual(semantics(rule), semantics(rules[0])))) throw new Error(t('cognition.organization.rule_semantics'));
    const { id: _id, version: _version, source: _source, createdAt: _created, updatedAt: _updated, status: _status, ...base } = rules[0];
    actions.push({ intent: 'create', recordId: `${operationId}-rule-${index + 1}`, sourceLabel: draft.reason.slice(0, 200),
      record: { ...base, name: output.title, requirement: output.statement } } as OntologyAction);
  });
  const outcome = actions.length ? applyOntologyCommand(doc, { commandId: operationId, expectedRevision: doc.revision, actions }, now) : undefined;
  const next = outcome?.document || structuredClone(doc);
  for (const recordId of outcome?.receipt.changedIds || []) {
    const record = next.records[recordId];
    if (sharedIds.has(recordId)) { record.source = structuredClone(doc.records[recordId].source); continue; }
    const index = resultIds.findIndex((_, i) => recordId === `${operationId}-rule-${i + 1}`);
    const mapped = index >= 0 ? [resultIds[index]] : resultIds.filter((_, i) => draft.outputs[i].ontologyRecordIds.includes(recordId));
    const old = doc.records[recordId]?.source;
    record.source = { kind: 'user', label: draft.reason.slice(0, 200), refs: [
      ...(old?.kind === 'candidate' && old.recordId && !sources.some(row => row.head.candidateId === old.recordId) ? [{ kind: 'candidate' as const, id: old.recordId }] : []),
      ...(old?.refs || []).filter(ref => !(ref.kind === 'asset' && draft.sourceAssetIds.includes(ref.id))
        && !(ref.kind === 'candidate' && sources.some(row => row.head.candidateId === ref.id))),
      ...mapped.map(assetId => ({ kind: 'asset' as const, id: assetId }))] };
  }
  for (const row of next.history.filter(row => row.commandId === operationId)) row.after = structuredClone(next.records[row.after.id]);
  const changes = (outcome?.receipt.changedIds || []).map(key => ({ ...(doc.records[key] ? { before: doc.records[key] } : {}), after: next.records[key] }));
  if (ontologyScopeViolations(next, changes.map(row => row.after), sources[0].head.scopePolicy).length) throw new Error(t('cognition.organization.scope_expanded'));
  const groupKey = hash([draft.operation, sources.map(row => clean(row.head)).sort((a, b) => a.id.localeCompare(b.id)), state.slice().sort(), [...linked].sort().map(key => doc.records[key]), prompts.load('recall_stock_organization'), prompts.load('recall_stock_grounding')]);
  const plan: ContentOrganizationPlan = { schemaVersion: 1, operationId, groupKey, origin, draft, sources, sourceState: state,
    resultIds, ontologyRevision: doc.revision, ontologyBaseline: Object.fromEntries(dependencies.map(row => [row.id, row])), ontologyAfter: { revision: next.revision, records: Object.fromEntries(changes.map(row => [row.after.id, row.after])),
      history: next.history.filter(row => row.commandId === operationId), receipts: outcome ? { [operationId]: next.receipts[operationId] } : {} }, ontologyChanges: changes, createdAt: now };
  assertNotForbiddenToPersist([JSON.stringify(plan)]);
  return plan;
}
export async function assertContentOrganizationBaseline(userId: string, plan: ContentOrganizationPlan) {
  for (const source of plan.sources) if (!isDeepStrictEqual(clean((await readSource(userId, source.head.id)).head), clean(source.head))) fail(t('cognition.organization.baseline_changed'));
  if (!isDeepStrictEqual(await sourceState(userId, plan.sources), plan.sourceState)) fail(t('cognition.organization.permission_changed'));
  const doc = readOntologyDocument(userId);
  const sharedIds = new Set(plan.sources.flatMap(row => (row.content.ontologyRefs || []).filter(ref => ref.sharedBody).map(ref => ref.recordId!)));
  await assertReferenceImpact(userId, plan.draft, plan.sources, sharedIds, doc);
  if (doc.revision !== plan.ontologyRevision) fail(t('cognition.organization.ontology_changed'));
  for (const key of Object.keys(plan.ontologyBaseline))
    await (await import('../cognition/edit-service')).assertOntologyManagementSources(userId, doc.records[key]);
}
export async function verifyContentOrganization(userId: string, input: SaveRecallCandidateInput | RecallCandidateRecord, newWrite = false) {
  const plan = input.contentOrganization;
  if (!plan || plan.schemaVersion !== 1 || input.captureProvenance || input.stockOrganizationProvenance || input.humanInstructionProvenance || input.manual) throw new Error('invalid organization producer');
  const job = await readRecallJsonRecord(userId, 'stock-organization', plan.operationId);
  if (!job || !isDeepStrictEqual(clean((job.plan || {}) as Record<string, unknown>).sources, clean(plan as unknown as Record<string, unknown>).sources) || (job.plan as ContentOrganizationPlan)?.origin !== plan.origin || input.captureKey !== plan.operationId
    || (newWrite && permit.getStore() !== input)) throw new Error('organization requires host-prepared content');
  await assertContentOrganizationBaseline(userId, plan);
}
export async function submitContentOrganization(userId: string, plan: ContentOrganizationPlan) {
  return withRecallCandidatePromotionLock(userId, () => submitContentOrganizationUnlocked(userId, plan));
}
async function submitContentOrganizationUnlocked(userId: string, plan: ContentOrganizationPlan) {
  const candidateId = candidateIdForCaptureKey(plan.operationId);
  const existing = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (existing) return readRecallCandidate(userId, candidateId);
  for (const candidate of await listRecallCandidates(userId)) {
    if (candidate.contentOrganization?.groupKey === plan.groupKey && ['rejected', 'ignored'].includes(candidate.status)) return candidate;
    if (!['pending_review', 'deferred'].includes(candidate.status)) continue;
    const ids = candidate.contentOrganization?.draft.sourceAssetIds || (candidate.targetAssetId ? [candidate.targetAssetId] : []);
    if (ids.some(key => plan.draft.sourceAssetIds.includes(key))) fail(t('cognition.organization.overlapping'));
  }
  await assertContentOrganizationBaseline(userId, plan);
  await updateRecallJsonRecord(userId, 'stock-organization', plan.operationId, () => ({ schemaVersion: 1, ownerId: userId,
    id: plan.operationId, kind: 'content_organization', plan, candidateId, updatedAt: new Date().toISOString() }));
  const first = plan.sources[0].head;
  const refs = normalizeCognitionSourceRefsForWrite(plan.sources.flatMap(row => row.content.evidenceRefs));
  const input: SaveRecallCandidateInput = { contentOrganization: plan, captureKey: plan.operationId,
    judgment: plan.draft.reason, summary: plan.draft.outputs.map(row => row.title).join(' / ').slice(0, 1000),
    suggestedType: first.type, suggestedScope: first.scope, scopePolicy: first.scopePolicy, spaceId: first.spaceId,
    suggestedAction: 'create', risk: 'medium', sourceRefs: refs, evidenceRefs: refs, evidenceSummary: plan.draft.reason };
  return permit.run(input, () => saveRecallCandidate(userId, input));
}
function outputAsset(userId: string, candidate: RecallCandidateRecord, index: number, decisionId: string, now: string): RecallAbilityAssetRecord {
  const plan = candidate.contentOrganization!, output = plan.draft.outputs[index], first = plan.sources[0].head;
  const sourceRows = plan.sources.filter(row => output.sourceAssetIds.includes(row.head.id));
  const refs = sourceRows.flatMap(row => row.content.ontologyRefs || []).filter(ref => output.ontologyRecordIds.includes(ref.recordId!) && !ref.sharedBody);
  const rule = plan.ontologyAfter.records[`${plan.operationId}-rule-${index + 1}`];
  if (rule?.kind === 'rule') refs.push({ groupId: rule.moduleId, moduleId: rule.moduleId, recordId: rule.id, versionPolicy: 'current', sharedBody: true });
  return { schemaVersion: 1, ownerId: userId, id: plan.resultIds[index], candidateId: candidate.id, reviewDecisionId: decisionId,
    type: first.type, ...(first.contentCategory ? { contentCategory: first.contentCategory } : {}), title: output.title, statement: output.statement,
    ...(output.value !== undefined ? { value: output.value } : {}), ...(output.applicableWhen !== undefined ? { applicableWhen: output.applicableWhen } : {}),
    ...(output.forbiddenWhen !== undefined ? { forbiddenWhen: output.forbiddenWhen } : {}), scope: first.scope, scopePolicy: first.scopePolicy, spaceId: first.spaceId,
    evidenceRefs: normalizeCognitionSourceRefsForWrite(sourceRows.flatMap(row => row.content.evidenceRefs)),
    ontologyRefs: [...new Map(refs.map(ref => [ref.recordId, ref])).values()],
    relations: [...new Map(sourceRows.flatMap(row => row.content.relations || []).filter(ref => !plan.draft.sourceAssetIds.includes(ref.assetId)).map(ref => [`${ref.kind}:${ref.assetId}`, ref])).values()], derivedFrom: output.sourceAssetIds,
    contentOrganizationId: candidate.id, status: first.status, maturity: 'seed', lifecycleStatus: 'user_confirmed_unverified',
    version: '1', activeVersion: '1', createdAt: now, updatedAt: now };
}
export async function confirmContentOrganization(userId: string, candidateId: string, actor: 'user' | 'system' = 'user', reviewedOutputs?: unknown) {
  if (actor !== 'user') throw new Error(t('cognition.organization.human_required'));
  return withRecallCandidatePromotionLock(userId, () => withCognitionTransition(userId, async () => {
    const candidate = await readRecallCandidate(userId, candidateId), plan = candidate.contentOrganization;
    const rawCandidate = await readRecallJsonRecord(userId, 'candidates', candidateId);
    if (!plan) throw new Error('not an organization candidate');
    if (candidate.organizationReceipt) return { candidate, assets: candidate.organizationReceipt.assets, duplicate: true };
    if (!['pending_review', 'deferred'].includes(candidate.status) || Date.parse(candidate.expiresAt) <= Date.now()) throw new Error(t('cognition.organization.not_confirmable'));
    if (reviewedOutputs !== undefined && !isDeepStrictEqual(reviewedOutputs, plan.draft.outputs)) fail(t('cognition.organization.review_changed'));
    await verifyContentOrganization(userId, candidate);
    const decision = await writeReviewDecision(userId, { targetRef: `recall_candidate:${candidate.id}`, decisionType: 'modify',
      decision: 'organize_content', actor: 'user', reason: plan.draft.reason, idempotencyKey: plan.operationId });
    const now = new Date().toISOString();
    const outputs = plan.resultIds.map((_, index) => outputAsset(userId, candidate, index, decision.decision_id, now));
    const archived = plan.sources.map(row => ({ ...row.head, status: 'archived' as const, organizationArchivedBy: candidate.id,
      organizationResultIds: plan.resultIds, updatedAt: now }));
    const changed = [...outputs, ...archived];
    const receipt: ContentOrganizationReceipt = { operationId: plan.operationId, assets: outputs.map(row => ({ id: row.id, version: row.version })),
      archivedIds: archived.map(row => row.id), committedAt: now, afterAssets: Object.fromEntries(changed.map(row => [row.id, clean(row) as RecallAbilityAssetRecord])),
      ontologyAfter: Object.fromEntries(plan.ontologyChanges.map(row => [row.after.id, row.after])) };
    await withAssetVersionMetadata({ actor: 'user', reason: plan.draft.reason }, () => withCognitionSourceDependency(userId, 'candidates', (store, record) => {
      if (record.id !== candidateId || record.status !== 'confirmed') throw new Error('invalid organization commit');
      const records = store.compatibility!.records;
      if (!isDeepStrictEqual(records.candidates[candidateId], rawCandidate)) fail(t('cognition.organization.candidate_changed'));
      for (const source of plan.sources) if (!isDeepStrictEqual(clean(records['ability-assets'][source.head.id]), clean(source.rawHead))) fail(t('cognition.organization.source_changed_at_commit'));
      if ((store.ontology?.revision ?? 0) !== plan.ontologyRevision) fail(t('cognition.organization.ontology_changed_at_commit'));
      for (const output of outputs) if (records['ability-assets'][output.id]) fail(t('cognition.organization.occupied_id'));
      for (const asset of changed) records['ability-assets'][asset.id] = withPendingAssetVersion(records['ability-assets'][asset.id] as any, asset);
      if (plan.ontologyChanges.length) store.ontology = { ...store.ontology!, revision: plan.ontologyAfter.revision,
        records: { ...store.ontology!.records, ...structuredClone(plan.ontologyAfter.records) },
        history: [...store.ontology!.history, ...structuredClone(plan.ontologyAfter.history)],
        receipts: { ...store.ontology!.receipts, ...structuredClone(plan.ontologyAfter.receipts) } };
      if (plan.ontologyChanges.length) { store.pendingJournal ??= []; store.pendingJournal.push({ key: `ontology-${plan.operationId}`,
        line: { at: now, kind: 'ontology', receipt: store.ontology!.receipts[plan.operationId] } }); }
      return { records: { 'ability-assets': changed.map(row => row.id) } };
    }, () => updateRecallJsonRecord(userId, 'candidates', candidateId, () => ({ ...candidate, status: 'confirmed',
      organizationReceipt: receipt, reviewDecisionId: decision.decision_id, updatedAt: now }))));
    changed.forEach(row => notifyCognitionWrite(userId, 'ability-assets', 'update', row.id));
    notifyCognitionWrite(userId, 'ontology', 'update', plan.operationId);
    return { candidate: await readRecallCandidate(userId, candidateId), assets: receipt.assets };
  }));
}
export function organizationPreview(plan: ContentOrganizationPlan) {
  const missing = t('cognition.organization.unrecorded');
  const sharedIds = new Set(plan.sources.flatMap(source => (source.content.ontologyRefs || []).filter(ref => ref.sharedBody).map(ref => ref.recordId)));
  const outputOntology = (output: OrganizationDraft['outputs'][number], index: number) => {
    const names = output.ontologyRecordIds.filter(id => !sharedIds.has(id)).map(id => {
      const record = plan.ontologyAfter.records[id] || plan.ontologyBaseline[id];
      return 'name' in record ? record.name : describeCognitionOntology(record).split('\n').slice(0, 2).join('：');
    });
    if (plan.ontologyAfter.records[`${plan.operationId}-rule-${index + 1}`]) names.push(output.title);
    return names.length ? `\n${t('cognition.edit.related')}: ${names.join('、')}` : '';
  };
  const content = (row: { title: string; statement: string; value?: string; applicableWhen?: string[]; forbiddenWhen?: string[] }) =>
    `${row.title}\n${row.statement}\n${t('cognition.edit.value')}: ${row.value ?? missing}\n${t('cognition.edit.applicable')}: ${row.applicableWhen?.join('；') || missing}\n${t('cognition.edit.forbidden')}: ${row.forbiddenWhen?.join('；') || missing}`;
  return [plan.draft.reason, t('cognition.organization.originals'), ...plan.sources.map(row => `v${row.content.activeVersion} · ${content(row.content)}`),
    t('cognition.organization.results'), ...plan.draft.outputs.map((row, index) => `${index + 1}. ${content(row)}${outputOntology(row, index)}\n${t('cognition.organization.excerpts')}:\n${row.excerpts.map(part => `${plan.sources.find(source => source.head.id === part.assetId)?.head.title}: ${part.quote}`).join('\n')}`),
    `${t('cognition.edit.scope')}: ${plan.sources[0].head.scope}\n${Object.entries(plan.sources[0].head.scopePolicy || {}).map(([key, value]) => `${key}: ${value.join('、')}`).join('\n')}`,
    t('cognition.edit.related'), ...plan.ontologyChanges.map(row => [row.before ? `${t('cognition.edit.before')}\n${describeCognitionOntology(row.before)}` : '', `${t('cognition.edit.after')}\n${describeCognitionOntology(row.after)}`].filter(Boolean).join('\n'))].join('\n\n');
}
export async function organizeCognitionFromConversation(userId: string, host: Omit<CognitionEditHost, 'userId'>, input: OrganizationDraft & { mode?: string; expectedVersions: Array<{ assetId: string; version: string; activeVersion: string }> }) {
  assertCognitionManagementActive(host);
  if (host.sourceMessageFromUser !== true || !host.taskText || !host.sourceMessageId || !host.cid || !host.turnId
    || !/(合并|合成|拆分|拆成|merge|combine|split)/i.test(host.taskText)) throw new Error(t('cognition.organization.user_instruction'));
  if ((input.operation === 'merge' ? !/(合并|合成|merge|combine)/i.test(host.taskText!) : !/(拆分|拆成|split)/i.test(host.taskText!))
    || /(?:不要|别|禁止|不允许|do not|don't)\s*(?:合并|合成|拆分|拆成|merge|combine|split)/i.test(host.taskText!)) throw new Error(t('cognition.organization.operation_not_authorized'));
  const { mode, expectedVersions, ...draft } = input;
  const requestId = hash([host.cid, host.sourceMessageId, draft, expectedVersions]);
  if (mode !== 'propose') {
    const replay = (await listRecallCandidates(userId)).find(row => row.contentOrganization?.conversationRequestId === requestId && row.organizationReceipt);
    if (replay) return { status: 'applied', candidate: replay, assets: replay.organizationReceipt!.assets, duplicate: true };
  }
  if (mode !== undefined && !['propose', 'apply_if_authorized'].includes(mode)) throw new Error('invalid organization mode');
  const plan = await prepareContentOrganization(userId, draft, 'conversation');
  plan.conversationRequestId = requestId;
  for (const source of plan.sources) {
    assertCognitionManagementTarget({ ...host, userId }, source.head);
    if ((await cognitionManagementAssetMatches(userId, { ...host, userId }, source.head)).length) throw new Error(t('cognition.organization.ambiguous'));
    const expected = expectedVersions?.find(row => row.assetId === source.head.id);
    if (!expected || expected.version !== source.head.version || expected.activeVersion !== source.content.activeVersion) fail(t('cognition.organization.read_versions'));
  }
  const preview = organizationPreview(plan);
  if (mode === 'propose' || /只预览|先看|先预览|暂不保存|不要保存|preview|do not save/i.test(host.taskText!)) return { status: 'pending_confirmation', preview };
  const existing = await readRecallJsonRecord(userId, 'candidates', candidateIdForCaptureKey(plan.operationId));
  if (existing?.organizationReceipt) return { status: 'applied', ...(await confirmContentOrganization(userId, existing.id)) };
  const interaction = await confirmCognitionManagement({ ...host, userId }, preview);
  if (!interaction) return { status: 'blocked', reason: t('cognition.organization.not_saved') };
  assertCognitionManagementActive(host);
  await assertContentOrganizationBaseline(userId, plan);
  host.onCommitStarted?.();
  const candidate = await submitContentOrganization(userId, plan);
  return { status: 'applied', ...(await confirmContentOrganization(userId, candidate.id, 'user', plan.draft.outputs)) };
}

export async function updateContentOrganization(userId: string, candidateId: string, outputs: unknown) {
  return withRecallCandidatePromotionLock(userId, () => withCognitionTransition(userId, async () => {
    const candidate = await readRecallCandidate(userId, candidateId), original = candidate.contentOrganization;
    const rawCandidate = await readRecallJsonRecord(userId, 'candidates', candidateId);
    if (!original || !['pending_review', 'deferred'].includes(candidate.status)) throw new Error(t('cognition.organization.not_editable'));
    await assertContentOrganizationBaseline(userId, original);
    const plan = await prepareContentOrganization(userId, { ...original.draft, outputs: z.array(organizationOutputSchema).min(1).max(6).parse(outputs) }, original.origin, original.operationId);
    if (original.conversationRequestId) plan.conversationRequestId = original.conversationRequestId;
    const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, raw => {
      if (!isDeepStrictEqual(raw, rawCandidate)) fail(t('cognition.organization.edit_changed'));
      return { ...raw!, contentOrganization: plan, summary: plan.draft.outputs.map(row => row.title).join(' / ').slice(0, 1000), userModifiedAt: new Date().toISOString() };
    });
    return readRecallCandidate(userId, updated.id);
  }));
}
async function prepareUndo(userId: string, candidateId: string) {
  const candidate = await readRecallCandidate(userId, candidateId), plan = candidate.contentOrganization, receipt = candidate.organizationReceipt;
  if (!plan || !receipt) throw new Error(t('cognition.organization.no_undo'));
  if (receipt.undoneAt) return { candidate, plan, receipt, token: hash(receipt), assets: [], ontology: readOntologyDocument(userId) };
  const assets = [] as RecallAbilityAssetRecord[];
  for (const [assetId, after] of Object.entries(receipt.afterAssets)) {
    const current = await readRecallJsonRecord(userId, 'ability-assets', assetId) as RecallAbilityAssetRecord;
    if (!current) fail(t('cognition.organization.entry_missing', { title: after.title }));
    if (!isDeepStrictEqual(clean(current), after)) fail(t('cognition.organization.entry_changed', { title: after.title }));
    assets.push(current);
  }
  if (!isDeepStrictEqual(await sourceState(userId, plan.sources), plan.sourceState)) fail(t('cognition.organization.undo_source_changed'));
  const ontology = readOntologyDocument(userId);
  for (const [key, after] of Object.entries({ ...plan.ontologyBaseline, ...receipt.ontologyAfter })) if (!isDeepStrictEqual(ontology.records[key], after)) fail(t('cognition.organization.undo_ontology_changed'));
  const newRules = new Set(plan.ontologyChanges.filter(row => !row.before).map(row => row.after.id));
  if ((await listAbilityAssets(userId)).some(asset => !receipt.afterAssets[asset.id] && ['active', 'paused'].includes(asset.status)
    && (asset.derivedFrom?.some(key => plan.resultIds.includes(key)) || asset.relations?.some(ref => plan.resultIds.includes(ref.assetId))
      || asset.ontologyRefs?.some(ref => newRules.has(ref.recordId!))))
    || Object.values(ontology.records).some(row => row.kind === 'reference' && row.status === 'active' && newRules.has(row.targetRecordId!))) fail(t('cognition.organization.undo_referenced'));
  return { candidate, plan, receipt, assets, ontology, token: hash([receipt, assets.map(clean), ontology.revision]) };
}
export async function previewContentOrganizationUndo(userId: string, candidateId: string) {
  return withCognitionTransition(userId, async () => {
    const prepared = await prepareUndo(userId, candidateId);
    return { token: prepared.token, alreadyUndone: !!prepared.receipt.undoneAt,
      restore: prepared.plan.sources.map(row => ({ id: row.head.id, title: row.head.title, status: row.head.status })),
      archive: prepared.plan.resultIds.map((key, index) => ({ id: key, title: prepared.plan.draft.outputs[index].title })),
      ontologyChanges: prepared.plan.ontologyChanges };
  });
}
export async function undoContentOrganization(userId: string, candidateId: string, token: string) {
  return withRecallCandidatePromotionLock(userId, () => withCognitionTransition(userId, async () => {
    const p = await prepareUndo(userId, candidateId);
    if (p.receipt.undoneAt) return { candidate: p.candidate, duplicate: true };
    if (token !== p.token) fail(t('cognition.organization.undo_preview_changed'));
    const now = new Date().toISOString(), commandId = 'undo-' + p.plan.operationId;
    const decision = await writeReviewDecision(userId, { targetRef: `recall_candidate:${candidateId}`, decisionType: 'modify',
      decision: 'undo_organization', actor: 'user', reason: t('cognition.organization.undo'), idempotencyKey: commandId });
    let next = structuredClone(p.ontology);
    if (p.plan.ontologyChanges.length) next = applyOntologyCommand(next, { commandId, expectedRevision: next.revision,
      actions: [{ intent: 'undo_command', recordId: p.plan.ontologyChanges[0].after.id,
        expectedVersion: next.records[p.plan.ontologyChanges[0].after.id].version, originalCommandId: p.plan.operationId, sourceLabel: t('cognition.organization.undo') }] }, now).document;
    for (const change of p.plan.ontologyChanges) if (change.before) next.records[change.before.id].source = structuredClone(change.before.source);
    for (const row of next.history.filter(row => row.commandId === commandId)) row.after = structuredClone(next.records[row.after.id]);
    const restored = p.plan.sources.map(row => ({ ...row.rawHead, pendingVersionSnapshots: p.assets.find(asset => asset.id === row.head.id)?.pendingVersionSnapshots, updatedAt: now }));
    const rawCandidate = await readRecallJsonRecord(userId, 'candidates', candidateId);
    const archived = p.assets.filter(row => p.plan.resultIds.includes(row.id)).map(row => ({ ...row, status: 'archived' as const, updatedAt: now }));
    await withCognitionSourceDependency(userId, 'candidates', (store, row) => {
      if (row.id !== candidateId || (store.ontology?.revision ?? 0) !== p.ontology.revision
        || !isDeepStrictEqual(store.compatibility!.records.candidates[candidateId], rawCandidate)) fail(t('cognition.organization.undo_changed'));
      for (const asset of p.assets) if (!isDeepStrictEqual(clean(store.compatibility!.records['ability-assets'][asset.id]), clean(asset))) fail(t('cognition.organization.undo_changed'));
      store.ontology = next;
      for (const asset of [...restored, ...archived]) store.compatibility!.records['ability-assets'][asset.id] = asset;
      if (p.plan.ontologyChanges.length) { store.pendingJournal ??= []; store.pendingJournal.push({ key: `ontology-${commandId}`, line: { at: now, kind: 'ontology', receipt: next.receipts[commandId] } }); }
      return { records: { 'ability-assets': [...restored, ...archived].map(row => row.id) } };
    }, () => updateRecallJsonRecord(userId, 'candidates', candidateId, () => ({ ...p.candidate,
      organizationReceipt: { ...p.receipt, undoneAt: now, undoDecisionId: decision.decision_id }, updatedAt: now })));
    [...restored, ...archived].forEach(row => notifyCognitionWrite(userId, 'ability-assets', 'update', row.id));
    notifyCognitionWrite(userId, 'ontology', 'update', commandId);
    return { candidate: await readRecallCandidate(userId, candidateId) };
  }));
}
