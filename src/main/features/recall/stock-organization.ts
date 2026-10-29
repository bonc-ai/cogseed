import { ontologyDependencyClosure } from '../cognition/ontology/dependencies';
import { organizationDraftSchema, type ContentOrganizationPlan } from './content-organization-contract';
import { prepareContentOrganization, submitContentOrganization } from './content-organization';
/** Resumable single-unit organization inside the existing discovery sweep.
 * Jobs own checkpoints and provenance; candidates own review and joint commits. */
import { resolveRecallCaptureModelCandidates } from './capture-model-selection';
import { readCognitionSourceBaselines } from './source-catalog';
import { cognitionSourceBaselineForRef } from './source-baseline';
import { isContentCategory } from './content-category';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { createLogger } from '../../logger';
import { prompts } from '../../prompts/loader';
import { readOntologyDocument } from '../cognition/ontology/service';
import { assessOntologySources, ontologyWithAdmittedSources } from '../cognition/ontology/source-admission';
import type { OntologyDocument, OntologyRecord } from '../cognition/ontology/model';
import { listAbilityAssets, readAbilityAssetVersionSnapshot } from './asset-service';
import { assetVersionSnapshot } from './asset-version-journal';
import { readRecallCaptureSettings, type RecallCaptureSettingsRecord } from './capture-settings';
import { captureBudgetWindowKey } from './capture-model-budget';
import { RECALL_TEXT_LIMITS } from './content-contract';
import { runRecallCaptureModel } from './capture-model-routing';
import { parseCaptureAssessmentJson, parseCaptureGroundingAssessment } from './capture-grounding';
import { resolveLegacyOntologySource } from './source-locator';
import { readReviewEvidenceRefs, readReviewEvidence, type ReviewEvidenceItem } from './review-evidence';
import { cognitionSourceControlSnapshot } from './source-control';
import { cognitionSourceRefKey, normalizeCognitionSourceRefs, normalizeCognitionSourceRefsForWrite, type CognitionSourceRef } from './source-service';
import { isAssetScopeAllowed } from './scope-policy';
import { parseOntologyFormationProposal, ontologyFormationGrammar } from './ontology-formation';
import { candidateIdForCaptureKey, listRecallCandidates, readRecallCandidate, saveRecallCandidate,
  type RecallAbilityAssetRecord, type RecallCandidateRecord, type SaveRecallCandidateInput } from './candidate-service';
import { withStockOrganizationWrite } from './stock-organization-provenance';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import { contentPurgedError } from './organization-content-lifecycle';
import { recallJsonRecordPath } from './paths';
import { safeId } from '../../storage';

const POLICY_VERSION = 1;
const RECHECK_MS = 30 * 24 * 60 * 60_000;
const log = createLogger('recall.stockOrganization');
const fields = ['title', 'statement', 'value', 'applicableWhen', 'forbiddenWhen'] as const;
export interface StockOrganizationUnit {
  key: string;
  asset?: RecallAbilityAssetRecord;
  headVersion?: string;
  activeVersion?: string;
  ontologyRevision?: number;
  records: OntologyRecord[];
  editableIds: string[];
  evidence: ReviewEvidenceItem[];
  sourceControls: string[];
  sourceVersions?: string[];
  sourceRefs?: CognitionSourceRef[];
  legacySourcesResolved?: boolean;
  sourceIssues?: string[];
}
export interface StockOrganizationJob extends RecallJsonRecord {
  unit: StockOrganizationUnit;
  fingerprint: string;
  state: 'queued' | 'checking' | 'prepared' | 'proposed' | 'no_change' | 'insufficient' | 'failed' | 'purged';
  candidateId: string;
  draft?: StockDraft;
  organizationPlan?: ContentOrganizationPlan;
  prepared?: SaveRecallCandidateInput;
  reason?: string;
  failureCode?: string;
  failureReasonCode?: string;
  failureMessage?: string;
  checkedAt?: string;
  lastWindow?: string;
  updatedAt: string;
  replacesJobId?: string;
  reviewKind?: 'sources' | 'content';
}
export interface StockOrganizationProgress {
  phase: 'inventory' | 'organizing' | 'checking' | 'complete' | 'stopped' | 'budget_held' | 'failure_held' | 'failed';
  total: number; checked: number; proposed: number; saved: number; remaining: number; noChange: number; insufficient: number; failed: number; candidateIds: string[];
  /** Units skipped because discovery already has a suggestion for the same target. */
  skippedClaimed?: number;
  /** Per-unit outcome is durable in the sweep receipt; no model or source text is stored here. */
  items?: Record<string, { status: 'completed' | 'failed' | 'pending' | 'skipped'; errorCode?: string; candidateId?: string }>;
  unitKey?: string;
}

/** Fixed host-side classification for stock failures. Messages never include
 *  provider diagnostics; reasonCode is a bounded provider failure kind. */
class StockJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly repairable = false,
    readonly modelFailure = false,
    readonly reasonCode?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'StockJobError';
  }
}

/** One bounded contract restatement for repairable model output. Never quotes
 *  user text or the previous model output. */
const STOCK_EXTRACTION_REPAIR = '上一次输出不符合 stock organization 的封闭 JSON 契约。规则：只输出一个 JSON 对象，outcome 只能是 proposal、organization、no_change 或 insufficient；proposal 必须带完整的 content（title、statement，可带 value/applicableWhen/forbiddenWhen）或合法的 ontologyChanges（actions 只允许 update 定义/实体的 description，或 update/correct 断言；不得对实体使用 correct，不得引用不可编辑或不在输入中的 recordId）；若 update/correct 的目标记录 certainty 为 inferred/unknown，或其 entity/assertion 身份未解析，不要编辑，返回 insufficient。请对同一输入重新输出完整 JSON。';
/** Ontology-only units have no cognition asset; a content block is an invalid
 *  extra target, not a second proposal. */
const STOCK_ONTOLOGY_EXTRACTION_REPAIR = '上一次输出不符合独立本体记录的契约。本次输入是独立本体记录，没有认知资产。规则：outcome 为 proposal 时不得输出 content；只输出 reason 和合法的 ontologyChanges（actions 只能 update 定义/实体的 description，或 update/correct 断言；不得对实体使用 correct，不得引用不可编辑或不在输入中的 recordId）；若 update/correct 的目标记录 certainty 为 inferred/unknown，或其 entity/assertion 身份未解析，不要编辑，返回 insufficient。两个 reason 都应说明业务内容的具体变化，不得出现字段名、内部 ID、“结构化表述”“唯一可编辑”或“不改变身份、权限”等执行说明。例如：“区分网络连通与待测试状态，测试后的可用性保留为预期。”请对同一输入重新输出完整 JSON。';
const STOCK_GROUNDING_REPAIR = '上一次输出不符合 grounding 的封闭评估契约。规则：只输出一个 JSON 对象，必须包含 supported、noUnsupportedClaims、scopePreserved、finalDecisionPreserved、priorContentPreserved 五个布尔值和 evidence 数组；evidence 每项只包含 label 与逐字 quote。请对同一输入重新输出完整 JSON。';

function stockExtractionPrompt(unit: StockOrganizationUnit): string {
  // Independent ontology has no cognition envelope. Supplying that contract
  // gives the model a competing target even when a later rule forbids it.
  return [
    ...(unit.asset ? [prompts.load('recall_candidate_contract')] : []),
    ontologyFormationGrammar,
    prompts.load('recall_stock_organization'),
    ...(unit.asset ? [] : [
      'This input is independent ontology, not cognition. A proposal has exactly outcome, reason and ontologyChanges; no content or organization. Review instructions and previousProposal are revision context, not evidence. Write both reasons as concrete changes a reader can judge, not an account of editing fields.',
    ]),
  ].join('\n');
}

function classifyStockFailure(error: unknown): { code: string; reasonCode?: string; detail?: string; message: string; modelFailure: boolean } {
  if (error instanceof StockJobError) {
    return { code: error.code, ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
      ...(error.detail ? { detail: error.detail } : {}), message: error.message, modelFailure: error.modelFailure };
  }
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = (error as { code?: unknown } | undefined)?.code;
  if (typeof rawCode === 'string' && rawCode !== 'ABORT_ERR') {
    return { code: rawCode, message, modelFailure: rawCode.startsWith('stock_model_') || rawCode === 'stock_output_invalid' };
  }
  if (/connection|network|fetch|timeout|ECONN|unavailable|socket|disconnected/i.test(message)) {
    return { code: 'stock_model_unavailable', reasonCode: 'transport', message, modelFailure: true };
  }
  if (/not strict json|unexpected token|invalid.*(assessment|grounding)|json/i.test(message)) {
    return { code: 'stock_output_invalid', message, modelFailure: true };
  }
  if (/not reviewable|organization cannot change|invalid stock result target|dropped a recorded field|must not duplicate|stock ontology version mismatch/i.test(message)) {
    return { code: 'stock_action_invalid', message, modelFailure: true };
  }
  if (/baseline|version mismatch/i.test(message)) {
    return { code: 'stock_baseline_changed', message, modelFailure: false };
  }
  return { code: 'organization_failed', message, modelFailure: false };
}

const content = z.object({ title: z.string().trim().min(1).max(1000), statement: z.string().min(1).max(RECALL_TEXT_LIMITS.statement),
  value: z.string().min(1).max(RECALL_TEXT_LIMITS.value).optional(), applicableWhen: z.array(z.string().min(1)).max(32).optional(),
  forbiddenWhen: z.array(z.string().min(1)).max(32).optional() }).strict();
const draftSchema = z.object({ outcome: z.enum(['proposal', 'organization', 'no_change', 'insufficient']), reason: z.string().trim().min(1).max(RECALL_TEXT_LIMITS.statement),
  organization: organizationDraftSchema.optional(), content: content.optional(), ontologyChanges: z.unknown().optional(),
  reviewIssues: z.array(z.object({ assetIds: z.array(z.string().min(1).max(160)).length(2),
    reason: z.string().trim().min(1).max(600),
    evidence: z.array(z.object({ assetId: z.string().min(1).max(160), quote: z.string().min(1).max(1000) }).strict()).length(2),
  }).strict()).max(5).optional() }).strict();
type StockDraft = z.infer<typeof draftSchema>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const aborted = () => Object.assign(new Error('stock organization interrupted'), { code: 'ABORT_ERR' });

export async function inventoryStockOrganization(userId: string, options: { resolveLegacy?: boolean; unitKey?: string } = {}): Promise<StockOrganizationUnit[]> {
  const doc = readOntologyDocument(userId);
  const readable = ontologyWithAdmittedSources(doc, await assessOntologySources(userId, doc));
  const all = await listAbilityAssets(userId);
  // Bound records never get a second independent suggestion, including when
  // their owning cognition is paused, restricted or source-disabled.
  const bound = new Set(all.flatMap(asset => (asset.ontologyRefs || []).flatMap(ref => ref.recordId ? [ref.recordId] : [])));
  const { filterRecallAssetsForAgentRead } = await import('./prompt-injection');
  const admitted = await filterRecallAssetsForAgentRead(userId, all.filter(asset => asset.ownerId === userId
    && asset.status === 'active' && isAssetScopeAllowed(asset.scopePolicy, {})));
  const units: StockOrganizationUnit[] = [];
  for (const head of admitted) {
    const activeVersion = String(head.activeVersion || head.version);
    const snapshot = activeVersion === String(head.version) ? assetVersionSnapshot(head)
      : await readAbilityAssetVersionSnapshot(userId, head.id, activeVersion);
    if (!snapshot?.statement) continue;
    const asset = { ...head, ...snapshot, scope: head.scope, scopePolicy: head.scopePolicy, status: head.status,
      version: head.version, activeVersion } as RecallAbilityAssetRecord;
    if (!(await filterRecallAssetsForAgentRead(userId, [asset])).length) continue;
    // A recorded legacy source identity is not the never-recorded case.
    // Preserve fail-closed behavior until its canonical evidence can be resolved.
    if (!asset.evidenceRefs.length && asset.sourceSessionIds?.length) continue;
    const editableIds = (asset.ontologyRefs || []).flatMap(ref => ref.recordId ? [ref.recordId] : []);
    const records = ontologyDependencyClosure(readable.records, editableIds); if (!records) continue;
    // Do not rewrite a pinned historical ontology version as though it were current.
    if ((asset.ontologyRefs || []).some(ref => ref.versionPolicy === 'pinned')) continue;
    const evidence = await readReviewEvidence(userId, { assetId: asset.id });
    if (evidence.some(item => item.state === 'unavailable' || item.state === 'missing' || item.state === 'read_failed')) continue;
    units.push({ key: `asset-${asset.id}`, asset, headVersion: String(head.version), activeVersion,
      ...(records.length ? { ontologyRevision: doc.revision } : {}), records, editableIds, evidence,
      sourceControls: asset.evidenceRefs.map(ref => cognitionSourceControlSnapshot(userId, ref)) });
  }
  for (const record of Object.values(readable.records)) {
    if (bound.has(record.id) || record.kind === 'module' || record.kind === 'reference') continue;
    const records = ontologyDependencyClosure(readable.records, [record.id]); if (!records) continue;
    units.push({ key: `ontology-${record.id}`, ontologyRevision: doc.revision, records, editableIds: [record.id], evidence: [], sourceControls: [] });
  }
  // Include provenance inherited by ontology dependencies. Their recorded
  // source must not become an apparent source-less exception after organization.
  const inherited = new Map<string, { refs: CognitionSourceRef[]; evidence: ReviewEvidenceItem[] }>();
  const prepared: StockOrganizationUnit[] = [];
  const legacy = new Map<string, Awaited<ReturnType<typeof resolveLegacyOntologySource>>>();
  for (const unit of units.filter(row => !options.unitKey || row.key === options.unitKey)) {
    const refs = [...(unit.asset?.evidenceRefs || [])];
    const evidence = [...unit.evidence];
    const dependencies = unit.records.flatMap(record => [...(record.source.refs || []),
      ...(record.source.kind === 'candidate' && record.source.recordId ? [{ kind: 'candidate', id: record.source.recordId }] : [])]);
    let unavailable = false;
    for (const ref of dependencies) {
      if (ref.kind !== 'asset' && ref.kind !== 'candidate') continue;
      const key = `${ref.kind}:${ref.id}`;
      if (!inherited.has(key)) {
        const row = ref.kind === 'asset' ? all.find(asset => asset.id === ref.id) : await readRecallCandidate(userId, ref.id);
        if (!row || (!row.evidenceRefs.length && Array.isArray(row.sourceSessionIds) && row.sourceSessionIds.length)) { unavailable = true; break; }
        inherited.set(key, { refs: normalizeCognitionSourceRefs([...row.evidenceRefs, ...(Array.isArray(row.sourceRefs) ? row.sourceRefs : [])]),
          evidence: await readReviewEvidence(userId, ref.kind === 'asset' ? { assetId: ref.id } : { candidateId: ref.id }) });
      }
      const source = inherited.get(key)!; refs.push(...source.refs); evidence.push(...source.evidence);
    }
    if (unavailable || evidence.some(item => item.state === 'unavailable' || item.state === 'missing' || item.state === 'read_failed')) continue;
    if (options.resolveLegacy !== false) {
      const issues: string[] = [];
      for (const record of unit.records) {
        if (record.source.kind !== 'user') continue;
        if (!legacy.has(record.source.label)) legacy.set(record.source.label, await resolveLegacyOntologySource(userId, record.source.label));
        const recovered = legacy.get(record.source.label)!;
        if (!recovered.recorded) continue;
        unit.legacySourcesResolved = true;
        if (recovered.issue) issues.push(recovered.issue);
        refs.push(...recovered.refs);
      }
      if (issues.length) unit.sourceIssues = [...new Set(issues)];
      if (unit.legacySourcesResolved) evidence.push(...await readReviewEvidenceRefs(userId, normalizeCognitionSourceRefs(refs)));
    }
    unit.sourceRefs = normalizeCognitionSourceRefs(refs);
    unit.evidence = [...new Map(evidence.map(item => [cognitionSourceRefKey(item.ref), item])).values()];
    prepared.push(unit);
  }
  const versions = await readCognitionSourceBaselines(userId, prepared.flatMap(unit => unit.sourceRefs!));
  return prepared.filter(unit => {
    if (unit.sourceRefs!.some(ref => !versions.has(cognitionSourceRefKey(ref)))) return false;
    unit.sourceVersions = unit.sourceRefs!.map(ref => cognitionSourceBaselineForRef(ref, versions.get(cognitionSourceRefKey(ref))!));
    unit.sourceControls = unit.sourceRefs!.map(ref => cognitionSourceControlSnapshot(userId, ref));
    return true;
  }).sort((a, b) => a.key.localeCompare(b.key));
}
function unitIdentity(unit: StockOrganizationUnit, legacyRanges = false): unknown {
  const evidence = unit.evidence.map(item => {
    if (!item.ref.locator || !item.ref.sourceVersion) return item;
    // Versioned source bytes and anchors define the baseline. Expanding its
    // readable context must not invalidate an otherwise unchanged old proof.
    const { excerpt: _excerpt, location: _location, ...identity } = item;
    return identity;
  });
  if (unit.sourceVersions && unit.sourceVersions.length !== unit.sourceRefs?.length)
    throw new Error('stock source baseline count mismatch');
  const sourceVersions = unit.sourceVersions?.map((version, index) => cognitionSourceBaselineForRef(unit.sourceRefs![index], version));
  return { key: unit.key, asset: unit.asset ? assetVersionSnapshot(unit.asset) : undefined,
    headVersion: unit.headVersion, activeVersion: unit.activeVersion,
    records: unit.records, evidence, sourceControls: unit.sourceControls, sourceVersions: legacyRanges ? unit.sourceVersions : sourceVersions,
    sourceRefs: unit.sourceRefs, policyVersion: POLICY_VERSION,
    legacySourcesResolved: unit.legacySourcesResolved, sourceIssues: unit.sourceIssues,
    contract: digest([prompts.load('recall_candidate_contract'), prompts.load('recall_stock_organization'), prompts.load('recall_stock_grounding'), ontologyFormationGrammar]) };
}
export async function assertStockOrganizationBaseline(userId: string, unit: StockOrganizationUnit): Promise<void> {
  const current = (await inventoryStockOrganization(userId, { resolveLegacy: unit.legacySourcesResolved === true, unitKey: unit.key }))[0];
  let matches = false;
  try { matches = !!current && isDeepStrictEqual(unitIdentity(current), unitIdentity(unit)); } catch { /* Invalid saved metadata grants no compatibility. */ }
  if (!matches)
    throw Object.assign(new Error('stock organization baseline or source changed; scan again'), { code: 'stock_organization_baseline_changed' });
}

/** Old ontology jobs may have copied another reference's range into their
 * version stamp. Their task/candidate identity survives that encoding repair.
 * Asset jobs are excluded: their fingerprint also binds unstored peer inputs. */
async function readOntologyJobsByBaseline(userId: string): Promise<Map<string, StockOrganizationJob[]>> {
  const index = new Map<string, StockOrganizationJob[]>();
  let names: string[];
  try { names = await fs.readdir(path.dirname(recallJsonRecordPath(userId, 'stock-organization', 'placeholder'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return index; throw error; }
  for (const name of names) {
    if (!name.endsWith('.json') || !safeId(name.slice(0, -5))) continue;
    try {
      const job = await readRecallJsonRecord(userId, 'stock-organization', name.slice(0, -5)) as StockOrganizationJob | undefined;
      if (!job?.unit || job.unit.asset || !job.unit.key?.startsWith('ontology-') || !safeId(job.candidateId)) continue;
      const key = digest([unitIdentity(job.unit), []]);
      // A failed job can retain its identity across extraction-contract changes:
      // recovery discards its preparation and checks the current inputs again.
      // Other states need their original or repaired fingerprint to match.
      if (job.state !== 'failed' && job.fingerprint !== key && job.fingerprint !== digest([unitIdentity(job.unit, true), []])) continue;
      const rows = index.get(key) || []; rows.push(job); index.set(key, rows);
    } catch (error) {
      if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
      log.warn('stock ontology job metadata unreadable', { jobId: name.slice(0, -5) });
    }
  }
  return index;
}
function sourceText(unit: StockOrganizationUnit): string {
  const asset = unit.asset;
  return JSON.stringify({ ...(asset ? { cognition: { id: asset.id, version: unit.activeVersion,
    title: asset.title, statement: asset.statement, value: asset.value, applicableWhen: asset.applicableWhen,
    forbiddenWhen: asset.forbiddenWhen, scope: asset.scope, scopePolicy: asset.scopePolicy, ontologyRefs: asset.ontologyRefs } } : {}),
    ontology: unit.records, editableOntologyIds: unit.editableIds, evidence: unit.evidence,
    originalSourceUnrecorded: !unit.sourceRefs?.length && !unit.legacySourcesResolved });
}

/** Stock actions cannot edit a record whose certainty or identity is still
 *  open; the parser would reject the inherited uncertainty afterwards. */
function unresolvedActionTarget(
  unit: StockOrganizationUnit,
  raw: Record<string, unknown> | undefined,
): { recordId: string; point: string; reason: string } | undefined {
  const actions = raw?.actions;
  if (!Array.isArray(actions)) return undefined;
  for (const action of actions as Array<Record<string, unknown>>) {
    const recordId = typeof action?.recordId === 'string' ? action.recordId : undefined;
    const record = recordId ? unit.records.find(row => row.id === recordId) : undefined;
    if (!record) continue;
    if (record.kind === 'entity' && record.identityStatus === 'unresolved')
      return { recordId: record.id, point: 'identityStatus:unresolved', reason: 'target_identity_unresolved' };
    if (record.certainty === 'inferred' || record.certainty === 'unknown')
      return { recordId: record.id, point: `certainty:${record.certainty}`, reason: 'target_certainty_unresolved' };
    if (record.kind === 'assertion') {
      const subject = unit.records.find(row => row.id === record.subjectId);
      if (subject?.kind === 'entity' && subject.identityStatus === 'unresolved')
        return { recordId: record.id, point: 'subject_identity:unresolved', reason: 'target_identity_unresolved' };
    }
  }
  return undefined;
}
function prepare(userId: string, job: StockOrganizationJob, draft: StockDraft, options: { preserveLegacyCopy?: boolean } = {}): SaveRecallCandidateInput {
  const unit = job.unit, asset = unit.asset;
  if (unit.sourceIssues?.length) throw new Error('stock source requires review');
  if (draft.outcome !== 'proposal' || (asset && !draft.content) || (!asset && draft.content)) throw new Error('invalid stock result target');
  if (asset && (['value', 'applicableWhen', 'forbiddenWhen'] as const).some(field =>
    asset[field] !== undefined && draft.content![field] === undefined)) throw new Error('organization dropped a recorded field');
  if (draft.content?.value === draft.content?.statement && draft.content?.value !== undefined)
    throw new Error('organization purpose must not duplicate the body');
  const refs = normalizeCognitionSourceRefsForWrite(unit.sourceRefs || asset?.evidenceRefs || []);
  const body = draft.content?.statement || draft.reason;
  let raw = draft.ontologyChanges as Record<string, unknown> | undefined;
  // Reject observable contract leakage, not domain-specific wording. The
  // grounding stage still judges meaning and the quality of concrete changes.
  if (!options.preserveLegacyCopy && [draft.reason, raw?.reason].some(text => typeof text === 'string'
    && /\b(?:ont|cand|msg|att)[_-][a-f0-9]{12,}\b|\b(?:recordId|sourceLabel|expectedVersion|description)\b|结构化(?:中文)?(?:描述|表述)|唯一可编辑|不(?:改变|改动|修改|改)[^。；;\n]{0,16}(?:身份|作用域|权限)/i.test(text)))
    throw new StockJobError('stock_action_invalid', 'stock reason contains internal processing instructions', true);
  const actions = raw?.actions;
  if (raw && (!Array.isArray(actions) || actions.some((action: any) => {
    const record = unit.records.find(row => row.id === action?.recordId);
    if (!record || !unit.editableIds.includes(record.id)) return true;
    if (action.intent === 'correct') return record.kind !== 'assertion' || record.object.kind !== 'literal'
      || record.object.valueType !== 'text' || action.object?.kind !== 'literal' || action.object.valueType !== 'text'
      || Object.keys(action).some(key => !['intent', 'recordId', 'object', 'expectedVersion', 'sourceLabel'].includes(key));
    if (action.intent !== 'update' || !action.patch || typeof action.patch !== 'object') return true;
    const allowed = record.kind === 'definition' ? ['name', 'description'] : record.kind === 'entity' ? ['description']
      : record.kind === 'rule' ? ['name', 'requirement', 'requirementSource', 'condition', 'exception'] : [];
    return Object.keys(action.patch).some(key => !allowed.includes(key));
  }))) throw new Error('organization cannot change identities, permissions or lifecycle');
  const unresolved = unresolvedActionTarget(unit, raw);
  if (unresolved) {
    log.warn('stock action target is unresolved', { jobId: job.id, recordId: unresolved.recordId });
    throw new StockJobError('stock_unit_unresolved',
      `stock record ${unresolved.point}; stock organization cannot resolve identity or certainty`, false, false, unresolved.reason);
  }
  // The host owns links and evidence labels; model output cannot expand them.
  if (raw) raw = { ...raw, refs: asset?.ontologyRefs || [], evidence: ['stored-version'] };
  const shared = (asset?.ontologyRefs || []).filter(ref => ref.sharedBody);
  if (shared.length && draft.content?.statement !== asset?.statement) {
    const merged = [...(Array.isArray(actions) ? actions : [])] as any[];
    for (const ref of shared) {
      const index = merged.findIndex(action => action.recordId === ref.recordId);
      const action = { intent: 'update', recordId: ref.recordId, patch: { ...(index >= 0 ? merged[index].patch : {}), requirementSource: 'cognition_body' } };
      delete action.patch.requirement;
      if (index >= 0) merged[index] = action; else merged.push(action);
    }
    raw = { reason: draft.reason, ...raw, actions: merged, refs: asset!.ontologyRefs, evidence: ['stored-version'] };
  }
  if (raw && Array.isArray(raw.actions)) raw.actions = raw.actions.map((action: any) => {
    const record = unit.records.find(row => row.id === action.recordId)!;
    if (action.expectedVersion !== undefined && action.expectedVersion !== record.version) throw new Error('stock ontology version mismatch');
    return { ...action, expectedVersion: record.version, sourceLabel: draft.reason.slice(0, 200) };
  });
  const doc = readOntologyDocument(userId);
  const plan = parseOntologyFormationProposal(doc, job.candidateId, raw, body, new Date().toISOString(), asset ? 'cognition' : 'ontology');
  if (plan?.blockedReasons.length || (!asset && !plan?.actions.length)) {
    const detail = (plan?.blockedReasons || []).map(reason => reason.split(':')[0]).sort().join(',');
    throw new StockJobError('stock_action_invalid', 'stock ontology proposal is not reviewable', false, true, undefined, detail || undefined);
  }
  if (!asset && plan?.previewChanges.every(change => {
    if (!change.before) return false;
    const { source: _oldSource, version: _oldVersion, updatedAt: _oldTime, ...before } = change.before;
    const { source: _newSource, version: _newVersion, updatedAt: _newTime, ...after } = change.after;
    return isDeepStrictEqual(before, after);
  })) throw new StockJobError('stock_no_change', 'stock proposal changes only source metadata');
  if (asset && !plan?.actions.length && fields.every(field => isDeepStrictEqual(draft.content![field], asset[field])))
    throw new Error('stock proposal has no change');
  const checkedAt = new Date().toISOString();
  return { proposalTarget: asset ? plan?.actions.length ? 'joint' : 'cognition' : 'ontology',
    captureKey: job.id, judgment: body, summary: draft.content?.title || ontologyTitle(unit),
    ...(draft.content?.value !== undefined ? { value: draft.content.value } : {}),
    ...(draft.content?.applicableWhen !== undefined ? { applicableWhen: draft.content.applicableWhen } : {}),
    ...(draft.content?.forbiddenWhen !== undefined ? { forbiddenWhen: draft.content.forbiddenWhen } : {}),
    evidenceSummary: draft.reason, suggestedType: asset?.type || 'cognition', suggestedScope: asset?.scope || 'general',
    ...(asset?.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}), ...(asset?.spaceId ? { spaceId: asset.spaceId } : {}),
    ...(isContentCategory(asset?.contentCategory) ? { contentCategory: asset.contentCategory } : {}),
    suggestedAction: asset ? 'update' : 'create', risk: 'low', sourceRefs: refs, evidenceRefs: refs,
    ...(asset ? { targetAssetId: asset.id, targetVersionUsed: unit.activeVersion } : {}),
    ...(plan ? { ontologyFormation: plan } : {}),
    stockOrganizationProvenance: { kind: 'stock_organization', schemaVersion: 1, ownerId: userId,
      jobId: job.id, unitKey: unit.key, policyVersion: POLICY_VERSION, checkedAt,
      ...(asset ? { assetId: asset.id, headVersion: unit.headVersion, activeVersion: unit.activeVersion } : {}),
      originalSourceUnrecorded: !refs.length && !unit.legacySourcesResolved } };
}
function ontologyTitle(unit: StockOrganizationUnit): string {
  const record = unit.records.find(row => row.id === unit.editableIds[0]);
  return record && 'name' in record ? record.name : '本体事实整理';
}
export async function runStockOrganization(userId: string, settings: RecallCaptureSettingsRecord,
  signal: AbortSignal, report: (progress: StockOrganizationProgress) => Promise<void>, canRun: () => Promise<boolean> = async () => true,
  options: { retryFailed?: boolean; excludeRefs?: ReadonlySet<string> } = {}): Promise<StockOrganizationProgress> {
  const progress: StockOrganizationProgress = { phase: 'inventory', total: 0, checked: 0, proposed: 0, saved: 0,
    remaining: 0, noChange: 0, insufficient: 0, failed: 0, candidateIds: [], skippedClaimed: 0 };
  await report({ ...progress });
  const allUnits = await inventoryStockOrganization(userId);
  const isClaimed = (unit: StockOrganizationUnit): boolean => Boolean(options.excludeRefs && (
    (unit.asset && options.excludeRefs.has(unit.asset.id))
    || unit.editableIds.some(id => options.excludeRefs!.has(id))
    || unit.records.some(record => options.excludeRefs!.has(record.id))));
  const units = allUnits.filter(unit => !isClaimed(unit));
  progress.items = Object.fromEntries(allUnits.map(unit => [unit.key, { status: isClaimed(unit) ? 'skipped' : 'pending' }]));
  const mark = (key: string, status: 'completed' | 'failed' | 'pending' | 'skipped', errorCode?: string, candidateId?: string) => {
    progress.items![key] = { status, ...(errorCode ? { errorCode } : {}), ...(candidateId ? { candidateId } : {}) };
  };
  progress.skippedClaimed = allUnits.length - units.length;
  const window = captureBudgetWindowKey(new Date(), settings.nightlyStart);
  const jobs: StockOrganizationJob[] = [];
  const existingCandidates = await listRecallCandidates(userId);
  let ontologyJobs: Promise<Map<string, StockOrganizationJob[]>> | undefined;
  const openSuggestions = existingCandidates.filter(candidate => ['pending_review', 'deferred'].includes(candidate.status));
  const occupied = new Set(openSuggestions.flatMap(candidate => candidate.contentOrganization?.draft.sourceAssetIds || []));
  const reusedSuggestionIds = (assetId: string) => openSuggestions
    .filter(candidate => (candidate.contentOrganization?.draft.sourceAssetIds || []).includes(assetId))
    .map(candidate => candidate.id);
  const rememberSuggestions = (ids: string[]) => {
    for (const id of ids) if (!progress.candidateIds.includes(id)) progress.candidateIds.push(id);
  };
  const peers = new Map<string, StockOrganizationUnit[]>();
  // Reuse the existing complete-content local search; it only selects comparisons.
  for (const unit of units) {
    if (signal.aborted) { progress.phase = 'stopped'; await report({ ...progress }); return progress; }
    if (!unit.asset) continue;
    const matches = await (await import('./capture-existing-assets')).selectCaptureExistingAssets(userId, {
      approvedEvidence: [{ quote: unit.asset.statement }], targetAssetIds: [unit.asset.id, ...(unit.asset.relations || []).map(ref => ref.assetId)], maxAssets: 6, maxChars: 128_000 });
    peers.set(unit.key, matches.assets.flatMap(match => {
      const other = units.find(row => row.asset?.id === match.id);
      return other && other.key !== unit.key && other.asset?.type === unit.asset!.type
        && other.asset?.scope === unit.asset!.scope && other.asset?.spaceId === unit.asset!.spaceId
        && isDeepStrictEqual(other.asset?.scopePolicy, unit.asset!.scopePolicy) ? [other] : [];
    }));
  }
  for (const unit of units) {
    const pending = existingCandidates.find(row => row.proposalTarget === 'ontology' && row.stockOrganizationProvenance?.unitKey === unit.key
      && ['pending_review', 'deferred'].includes(row.status));
    if (pending) { mark(unit.key, 'completed', undefined, pending.id); progress.checked++; progress.proposed++; progress.candidateIds.push(pending.id); continue; }
    const fingerprint = digest([unitIdentity(unit), (peers.get(unit.key) || []).map(peer => unitIdentity(peer))]), id = `stock-${digest([unit.key, fingerprint])}`;
    let existing = await readRecallJsonRecord(userId, 'stock-organization', id) as StockOrganizationJob | undefined;
    if (!existing && !unit.asset) {
      ontologyJobs ||= readOntologyJobsByBaseline(userId);
      const compatible = (await ontologyJobs).get(fingerprint) || [];
      // Prefer the job referenced by a recorded decision over an abandoned
      // preparation; never reopen a rejected or already published proposal.
      const referenced = compatible.filter(job => existingCandidates.some(candidate => candidate.id === job.candidateId
        && candidate.stockOrganizationProvenance?.jobId === job.id));
      existing = [...(referenced.length ? referenced : compatible)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
      if (existing && referenced.includes(existing)) existing = { ...existing, state: 'proposed' };
    }
    let job: StockOrganizationJob = existing || { schemaVersion: 1, ownerId: userId, id, unit, fingerprint, state: 'queued',
      candidateId: candidateIdForCaptureKey(id), updatedAt: new Date().toISOString() };
    if (job.contentPurgedAt) { mark(unit.key, 'skipped', 'source_removed'); progress.checked++; continue; }
    if (job.state === 'proposed') {
      const candidate = await readRecallCandidate(userId, job.candidateId);
      mark(unit.key, 'completed', undefined, candidate.id);
      progress.checked++; progress.proposed++; progress.candidateIds.push(candidate.id);
      candidate.contentOrganization?.draft.sourceAssetIds.forEach(id => occupied.add(id));
      if (candidate.status === 'confirmed' || candidate.status === 'integrated') progress.saved += candidate.organizationReceipt?.assets.length || 1;
      continue;
    }
    if ((job.state === 'no_change' || job.state === 'insufficient') && job.checkedAt && Date.now() - Date.parse(job.checkedAt) < RECHECK_MS) {
      mark(unit.key, 'completed', job.state === 'insufficient' ? 'review_needed' : undefined);
      progress.checked++; progress[job.state === 'no_change' ? 'noChange' : 'insufficient']++; continue;
    }
    if (job.state === 'failed' && job.lastWindow === window && !options.retryFailed) { mark(unit.key, 'failed', job.failureCode || 'organization_failed'); progress.failed++; continue; }
    if (existing && ((!unit.asset && job.state === 'failed') || !isDeepStrictEqual(existing.unit.sourceVersions, unit.sourceVersions))) {
      // The old bytes only prove the baseline, not a reviewed proposal. Retry
      // from current inputs while retaining the existing job and candidate IDs.
      job = { ...job, unit, fingerprint, state: 'queued', draft: undefined, prepared: undefined, organizationPlan: undefined };
    }
    if (job.state === 'no_change' || job.state === 'insufficient') job = { ...job, state: 'queued', draft: undefined };
    jobs.push(job);
  }
  progress.total = units.length; progress.remaining = jobs.length + progress.failed;
  const shouldContinue = async () => !signal.aborted && await canRun() && (await readRecallCaptureSettings(userId)).enabled;
  let modelFailureStreak = 0;
  for (let job of jobs) {
    if (job.unit.asset && occupied.has(job.unit.asset.id)) {
      // The round keeps the suggestion already waiting for review. Skipping
      // must not hide it or create a second one for the same asset.
      const reused = reusedSuggestionIds(job.unit.asset.id);
      rememberSuggestions(reused);
      mark(job.unit.key, 'skipped', 'already_has_suggestion', reused[0]);
      progress.checked++; progress.remaining--; continue;
    }
    if (!await shouldContinue()) { progress.phase = 'stopped'; break; }
    const persist = async (patch: Partial<StockOrganizationJob>) => {
      job = { ...job, ...patch, updatedAt: new Date().toISOString() };
      if (job.state !== 'failed') {
        delete job.failureCode;
        delete job.failureReasonCode;
        delete job.failureMessage;
        // Only a completed outcome breaks the consecutive model-failure
        // streak; queued/checking are still part of the same attempt.
        if (['no_change', 'insufficient', 'prepared', 'proposed'].includes(job.state)) modelFailureStreak = 0;
      }
      await updateRecallJsonRecord(userId, 'stock-organization', job.id, () => job);
      const status = job.state === 'failed' ? 'failed' : job.state === 'purged' ? 'skipped'
        : ['proposed', 'no_change', 'insufficient'].includes(job.state) ? 'completed' : 'pending';
      const errorCode = job.state === 'failed' ? (job.failureCode || 'organization_failed')
        : job.state === 'insufficient' ? 'review_needed' : undefined;
      mark(job.unit.key, status, errorCode, job.state === 'proposed' ? job.candidateId : undefined);
    };
    const call = async (stage: 'extraction' | 'grounding', systemPrompt: string, message: string) => {
      const { result } = await runRecallCaptureModel(userId, { sessionId: `${job.id}-${stage}`, jobContext: { jobId: job.id },
        systemPrompt, message, modelCandidates: await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates), signal, shouldContinue, responseFormat: 'json_object',
        maxOutputTokens: 8192, budget: { jobId: job.id, stage, source: 'stock_organization' } });
      if (signal.aborted || result.meta.aborted) throw aborted();
      if (result.meta.error) throw new StockJobError('stock_model_unavailable', 'stock model unavailable', false, true,
        String((result.meta.error as { kind?: unknown }).kind || 'unknown').slice(0, 40));
      return result.text;
    };
    try {
      await assertStockOrganizationBaseline(userId, job.unit);
      if (job.unit.sourceIssues?.length) { await persist({ state: 'insufficient', reason: 'source_requires_review', checkedAt: new Date().toISOString() });
        progress.insufficient++; progress.checked++; progress.remaining--; continue; }
      const related = (peers.get(job.unit.key) || []).filter(row => !occupied.has(row.asset!.id));
      const source = JSON.stringify({ primary: JSON.parse(sourceText(job.unit)), related: related.map(row => JSON.parse(sourceText(row))) });
      assertNotForbiddenToPersist([source]);
      if (source.length > 128_000) { await persist({ state: 'insufficient', reason: 'context_too_large', checkedAt: new Date().toISOString() });
        progress.insufficient++; progress.checked++; progress.remaining--; continue; }
      progress.unitKey = job.unit.key;
      const extractionPrompt = stockExtractionPrompt(job.unit);
      const extractionRepairInstruction = job.unit.asset ? STOCK_EXTRACTION_REPAIR : STOCK_ONTOLOGY_EXTRACTION_REPAIR;
      const extractDraft = async (repairInstruction?: string): Promise<StockDraft> => {
        const response = await call('extraction', extractionPrompt + (repairInstruction ? `\n\n${repairInstruction}` : ''), source);
        let draft: StockDraft;
        try {
          draft = draftSchema.parse(parseCaptureAssessmentJson(response));
          if (draft.reviewIssues?.length) {
            if (!job.unit.asset) throw new Error('independent ontology cannot issue an asset comparison');
            const inputs = [job.unit, ...related].filter(unit => unit.asset);
            for (const issue of draft.reviewIssues) {
              const ids = new Set(issue.assetIds);
              if (ids.size !== 2 || !ids.has(job.unit.asset.id) || issue.evidence.length !== ids.size)
                throw new Error('inspection comparison must include the primary asset');
              const evidenced = new Set<string>();
              for (const item of issue.evidence) {
                const unit = inputs.find(row => row.asset?.id === item.assetId);
                if (!ids.has(item.assetId) || evidenced.has(item.assetId) || !unit?.asset?.statement.includes(item.quote))
                  throw new Error('inspection comparison quote is not from a supplied asset');
                evidenced.add(item.assetId);
              }
              assertNotForbiddenToPersist([issue.reason]);
            }
          }
        } catch { throw new StockJobError('stock_output_invalid', 'stock output incomplete, invalid, or beyond output limits', true, true); }
        if (job.unit.asset && draft.reviewIssues) {
          const inputs = [job.unit, ...related].filter(unit => unit.asset);
          const observations = draft.reviewIssues.map(issue => ({
            assetVersions: Object.fromEntries(issue.assetIds.map(id => [id, String(inputs.find(unit => unit.asset!.id === id)!.activeVersion)])),
          }));
          const { recordSemanticInspectionFindings } = await import('./asset-inspection-service');
          await recordSemanticInspectionFindings(userId, job.unit.asset.id, inputs.map(unit => unit.asset!.id), observations, async () => {
            for (const unit of inputs) await assertStockOrganizationBaseline(userId, unit);
          });
        }
        // The review report stores only IDs and versions. Model-supplied
        // quotations and reasoning must not become a second content copy in a job.
        const { reviewIssues: _reviewIssues, ...safeDraft } = draft;
        return safeDraft;
      };
      const assessGrounding = async (proposed: unknown, repairInstruction?: string) => {
        const systemPrompt = prompts.load('recall_stock_grounding') + (repairInstruction ? `\n\n${repairInstruction}` : '');
        try {
          const text = await call('grounding', systemPrompt,
            JSON.stringify({ sources: [{ label: 'stored-version', text: source }], proposed }));
          return parseCaptureGroundingAssessment(text, [{ label: 'stored-version', text: source }]);
        } catch (error) {
          if (error instanceof StockJobError) throw error;
          // ABORT_ERR / model-hold codes must survive to the sweep circuit.
          if (typeof (error as { code?: unknown } | undefined)?.code === 'string') throw error;
          throw new StockJobError('stock_output_invalid', 'stock grounding output invalid', true, true);
        }
      };
      const assessGroundingWithRepair = async (proposed: unknown) => {
        try { return await assessGrounding(proposed); }
        catch (error) {
          if (!(error instanceof StockJobError && error.repairable)) throw error;
          return assessGrounding(proposed, STOCK_GROUNDING_REPAIR);
        }
      };
      if (!job.draft && !job.prepared) {
        progress.phase = 'organizing'; await report({ ...progress }); await persist({ state: 'queued', lastWindow: window });
        let draft: StockDraft;
        try { draft = await extractDraft(); }
        catch (error) {
          if (!(error instanceof StockJobError && error.repairable)) throw error;
          draft = await extractDraft(extractionRepairInstruction);
        }
        if (draft.outcome === 'no_change' || draft.outcome === 'insufficient') {
          await persist({ state: draft.outcome, reason: draft.reason, checkedAt: new Date().toISOString() });
          progress[draft.outcome === 'no_change' ? 'noChange' : 'insufficient']++; progress.checked++; progress.remaining--; await report({ ...progress }); continue;
        }
        assertNotForbiddenToPersist([JSON.stringify(draft)]);
        await persist({ draft, state: 'checking' });
      }
      if (job.draft?.outcome === 'organization') {
        if (!job.draft.organization || !job.unit.asset || !job.draft.organization.sourceAssetIds.includes(job.unit.asset.id)
          || job.draft.organization.sourceAssetIds.some(id => ![job.unit, ...related].some(row => row.asset?.id === id)))
          throw new Error('organization exceeded the admitted comparison set');
        if (!job.organizationPlan) {
          const plan = await prepareContentOrganization(userId, job.draft.organization, 'scan');
          // Bind every model input, not just the primary job, to the inventory read.
          for (const sourceId of job.draft.organization.sourceAssetIds)
            await assertStockOrganizationBaseline(userId, [job.unit, ...related].find(unit => unit.asset?.id === sourceId)!);
          progress.phase = 'checking'; await report({ ...progress });
          const assessment = await assessGroundingWithRepair(plan.draft);
          if (![assessment.supported, assessment.noUnsupportedClaims, assessment.scopePreserved, assessment.finalDecisionPreserved, assessment.priorContentPreserved].every(Boolean)) {
            await persist({ state: 'insufficient', reason: 'meaning_not_preserved', checkedAt: new Date().toISOString(), draft: undefined });
            progress.insufficient++; progress.checked++; progress.remaining--; continue;
          }
          await persist({ organizationPlan: plan, state: 'prepared' });
        }
        if (!await shouldContinue()) throw aborted();
        const candidate = await submitContentOrganization(userId, job.organizationPlan!);
        await persist({ state: 'proposed', candidateId: candidate.id });
        candidate.contentOrganization!.draft.sourceAssetIds.forEach(id => occupied.add(id));
        mark(job.unit.key, 'completed', undefined, candidate.id);
        progress.checked++; progress.proposed++; progress.candidateIds.push(candidate.id); progress.remaining--;
        await report({ ...progress }); continue;
      }
      if (!job.prepared) {
        let proposed: SaveRecallCandidateInput;
        try { proposed = prepare(userId, job, job.draft!); }
        catch (error) {
          const failure = classifyStockFailure(error);
          if (failure.code === 'stock_unit_unresolved') {
            await persist({ state: 'insufficient', reason: failure.reasonCode || 'target_certainty_unresolved',
              checkedAt: new Date().toISOString(), draft: undefined });
            progress.insufficient++; progress.checked++; progress.remaining--;
            await report({ ...progress }); continue;
          }
          if (failure.code !== 'stock_action_invalid') throw error;
          // One bounded repair: the invalid draft is discarded and the same
          // frozen source is re-extracted with a fixed contract restatement.
          const repaired = await extractDraft(extractionRepairInstruction);
          if (repaired.outcome === 'no_change' || repaired.outcome === 'insufficient') {
            await persist({ state: repaired.outcome, reason: repaired.reason, checkedAt: new Date().toISOString(), draft: undefined });
            progress[repaired.outcome === 'no_change' ? 'noChange' : 'insufficient']++;
            progress.checked++; progress.remaining--; await report({ ...progress }); continue;
          }
          if (repaired.outcome !== 'proposal') throw new StockJobError('stock_action_invalid', 'stock repair returned a different target', false, true);
          job = { ...job, draft: repaired, prepared: undefined };
          await persist({ draft: repaired, prepared: undefined, state: 'checking' });
          proposed = prepare(userId, job, repaired);
        }
        progress.phase = 'checking'; await report({ ...progress });
        const assessment = await assessGroundingWithRepair(proposed);
        if (![assessment.supported, assessment.noUnsupportedClaims, assessment.scopePreserved, assessment.finalDecisionPreserved, assessment.priorContentPreserved].every(Boolean)) {
          await persist({ state: 'insufficient', reason: 'meaning_not_preserved', checkedAt: new Date().toISOString(), draft: undefined });
          progress.insufficient++; progress.checked++; progress.remaining--; await report({ ...progress }); continue;
        }
        await persist({ state: 'prepared', prepared: proposed, checkedAt: new Date().toISOString() });
      }
      if (!await shouldContinue()) throw aborted();
      await withStockOrganizationWrite(userId, job.prepared!, () => saveRecallCandidate(userId, job.prepared!));
      await persist({ state: 'proposed' }); progress.checked++; progress.proposed++; progress.candidateIds.push(job.candidateId); progress.remaining--;
      await report({ ...progress });
    } catch (error) {
      const e = error as { code?: string; reason?: string };
      if (e.code === 'recall_content_purged') {
        mark(job.unit.key, 'skipped', 'source_removed');
        progress.checked++; progress.remaining--;
        continue;
      }
      if (e.code === 'ABORT_ERR' || signal.aborted) {
        progress.phase = e.reason === 'capture_model_failure_hold' ? 'failure_held'
          : e.reason === 'capture_budget_exhausted' ? 'budget_held' : 'stopped'; break;
      }
      const failure = classifyStockFailure(error);
      if (failure.code === 'stock_unit_unresolved') {
        await persist({ state: 'insufficient', reason: failure.reasonCode || 'target_certainty_unresolved',
          checkedAt: new Date().toISOString(), draft: undefined });
        progress.insufficient++; progress.checked++; progress.remaining--;
        await report({ ...progress }); continue;
      }
      log.warn('stock organization job failed', {
        jobId: job.id,
        unitKey: job.unit?.key,
        code: failure.code,
        ...(failure.reasonCode ? { reasonCode: failure.reasonCode } : {}),
        ...(failure.detail ? { detail: failure.detail } : {}),
        error: failure.message.slice(0, 300),
      });
      await persist({ state: 'failed', reason: failure.code, failureCode: failure.code,
        ...(failure.reasonCode ? { failureReasonCode: failure.reasonCode } : {}),
        failureMessage: failure.message.slice(0, 1_000), lastWindow: window });
      progress.failed++;
      if (failure.modelFailure) {
        modelFailureStreak += 1;
        if (modelFailureStreak >= 3) { progress.phase = 'failure_held'; break; }
      } else {
        modelFailureStreak = 0;
      }
    }
  }
  if (!['stopped', 'budget_held', 'failure_held'].includes(progress.phase)) progress.phase = progress.failed ? 'failed' : 'complete';
  delete progress.unitKey; await report({ ...progress }); return progress;
}

export async function readStockOrganizationSavedCount(userId: string, progress: StockOrganizationProgress): Promise<number> {
  let saved = 0;
  for (const id of progress.candidateIds || []) {
    const candidate = await readRecallCandidate(userId, id);
    if (candidate.status === 'confirmed' || candidate.status === 'integrated') saved += candidate.organizationReceipt?.undoneAt ? 0 : candidate.organizationReceipt?.assets.length || 1;
  }
  return saved;
}

/** Existing explicit recheck action, with the same failure circuit and frozen source. */
export async function recheckStockOrganization(userId: string, candidate: RecallCandidateRecord, signal?: AbortSignal): Promise<RecallCandidateRecord> {
  if (candidate.contentPurgedAt) throw contentPurgedError();
  if (candidate.proposalTarget === 'ontology') return refreshStockOntologyCandidate(userId, candidate, 'content');
  const { verifyStockOrganizationCandidate } = await import('./stock-organization-provenance');
  await verifyStockOrganizationCandidate(userId, candidate);
  const job = await readRecallJsonRecord(userId, 'stock-organization', candidate.stockOrganizationProvenance!.jobId) as StockOrganizationJob;
  if (!job?.draft || !candidate.ontologyFormation || ['confirmed', 'integrated', 'rejected', 'ignored', 'expired'].includes(candidate.status))
    throw new Error('stock organization recheck unavailable');
  let draft: StockDraft = { ...job.draft, ...(!job.unit.asset ? { ontologyChanges: { reason: candidate.ontologyFormation.reason,
    evidence: candidate.ontologyFormation.evidence, actions: candidate.ontologyFormation.actions } } : {}), ...(job.unit.asset ? { content: { title: candidate.summary, statement: candidate.judgment,
    ...(candidate.value ? { value: candidate.value } : {}),
    ...(candidate.applicableWhen !== undefined ? { applicableWhen: candidate.applicableWhen } : {}),
    ...(candidate.forbiddenWhen !== undefined ? { forbiddenWhen: candidate.forbiddenWhen } : {}) } } : {}) };
  const settings = await readRecallCaptureSettings(userId);
  const source = sourceText(job.unit);
  // Independent ontology edits are review instructions, not record content.
  // Regenerate the proposal before grounding; replaying the old draft would
  // ignore the user's edit while clearing its review block.
  if (!job.unit.asset && candidate.ontologyFormation.blockedReasons.includes('candidate_edited_requires_ontology_review')) {
    const message = JSON.stringify({ primary: JSON.parse(source), related: [], reviewInstructions: candidate.judgment,
      previousProposal: candidate.ontologyFormation.actions });
    assertNotForbiddenToPersist([message]);
    if (message.length > 128_000) throw Object.assign(new Error('complete stock recheck input exceeds context limit'), { code: 'ontology_recheck_input_too_large' });
    const { result: revised } = await runRecallCaptureModel(userId, { sessionId: `${job.id}-revise`, jobContext: { jobId: job.id },
      modelCandidates: await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates), signal,
      systemPrompt: `${prompts.load('recall_candidate_contract')}\n${ontologyFormationGrammar}\n${prompts.load('recall_stock_organization')}\nThe reviewInstructions field requests a revision of this proposal. It is not source evidence and cannot authorize new identities, facts, permissions or changes outside editableOntologyIds. Form the complete revised proposal from the supplied stored content and evidence.`,
      message, responseFormat: 'json_object', maxOutputTokens: 8192,
      budget: { jobId: job.id, stage: 'extraction', source: 'stock_organization' } });
    if (revised.meta.aborted) throw aborted();
    if (revised.meta.error) throw new Error('stock revision model unavailable');
    draft = draftSchema.parse(parseCaptureAssessmentJson(revised.text));
    if (draft.outcome !== 'proposal') throw Object.assign(new Error('revision did not produce a complete supported proposal'), { code: 'ontology_recheck_invalid_output' });
  }
  const prepared = prepare(userId, job, draft);
  assertNotForbiddenToPersist([source, JSON.stringify(prepared)]);
  const { result } = await runRecallCaptureModel(userId, { sessionId: `${job.id}-recheck`, jobContext: { jobId: job.id },
    modelCandidates: await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates), signal, systemPrompt: prompts.load('recall_stock_grounding'),
    message: JSON.stringify({ sources: [{ label: 'stored-version', text: source }], proposed: prepared }),
    responseFormat: 'json_object', maxOutputTokens: 8192, budget: { jobId: job.id, stage: 'grounding', source: 'stock_organization' } });
  if (result.meta.aborted) throw aborted();
  if (result.meta.error) throw new Error('stock recheck model unavailable');
  const check = parseCaptureGroundingAssessment(result.text, [{ label: 'stored-version', text: source }]);
  if (![check.supported, check.noUnsupportedClaims, check.scopePreserved, check.finalDecisionPreserved, check.priorContentPreserved].every(Boolean))
    throw new Error('stock recheck cannot preserve the recorded meaning');
  await assertStockOrganizationBaseline(userId, job.unit);
  return (await import('./candidate-service')).replaceRecallCandidateOntologyFormation(userId, candidate.id, prepared.ontologyFormation!, candidate);
}

/** Read-only assessment for an explicit repair selection; never scans unrelated
 * conversations or silently rewrites a saved ontology record. */
export async function inspectStockOntologyCandidate(userId: string, candidate: RecallCandidateRecord) {
  const { verifyStockOrganizationCandidate } = await import('./stock-organization-provenance');
  await verifyStockOrganizationCandidate(userId, candidate);
  if (candidate.proposalTarget !== 'ontology') throw new Error('independent ontology candidate required');
  const unit = (await inventoryStockOrganization(userId, { unitKey: candidate.stockOrganizationProvenance!.unitKey }))[0];
  if (!unit) throw new Error('stock baseline is unavailable');
  const plan = candidate.ontologyFormation!;
  const readerText = [plan.reason, candidate.evidenceSummary, ...plan.previewChanges.map(row =>
    'description' in row.after ? row.after.description : row.after.kind === 'rule' ? row.after.requirement : '')].join('\n');
  const technical = /\bont-[a-f0-9]+\b|\b(?:description|recordId|sourceLabel|expectedVersion)\b|唯一可编辑|结构化描述/.test(readerText);
  const strengthened = plan.previewChanges.some(row => {
    const before = row.before && 'description' in row.before ? row.before.description : '';
    const after = 'description' in row.after ? row.after.description : '';
    return /应该|预计|可能|也许/.test(before) && !/应该|预计|可能|也许/.test(after);
  });
  return { sourceIssues: unit.sourceIssues || [], sourceRepairNeeded: !isDeepStrictEqual(unit.sourceRefs, candidate.sourceRefs),
    contentReviewSuggested: technical || strengthened, sourceCount: unit.sourceRefs?.length || 0 };
}

export async function holdStockOntologyCandidate(userId: string, candidate: RecallCandidateRecord,
  reason: 'content_review_required' | 'stock_source_requires_review' | 'stock_recheck_failed'): Promise<RecallCandidateRecord> {
  if (!candidate.stockOrganizationProvenance || candidate.proposalTarget !== 'ontology' || !candidate.ontologyFormation)
    throw new Error('stock ontology candidate required');
  if (candidate.ontologyFormation.blockedReasons.includes(reason)) return candidate;
  return (await import('./candidate-service')).replaceRecallCandidateOntologyFormation(userId, candidate.id,
    { ...candidate.ontologyFormation, blockedReasons: [...candidate.ontologyFormation.blockedReasons, reason] }, candidate, { actor: 'system' });
}

/** Source-only repair changes no content. Content review uses the existing
 * extraction + grounding pair. Publish a prepared job before the candidate's
 * atomic pointer switch, retaining the old job for committed history/recovery. */
export async function refreshStockOntologyCandidate(userId: string, expected: RecallCandidateRecord,
  mode: 'sources' | 'content', options: { reviewReason?: string } = {}): Promise<RecallCandidateRecord> {
  if (expected.contentPurgedAt) throw contentPurgedError();
  // A host-reviewed explanation can be repaired without regenerating an
  // unchanged body. It shares the source/proof transaction and candidate CAS.
  const reviewReason = options.reviewReason?.trim();
  if (options.reviewReason !== undefined && (mode !== 'sources' || !reviewReason || reviewReason.length > 2000))
    throw new Error('invalid source review explanation');
  if (reviewReason) assertNotForbiddenToPersist([reviewReason]);
  const { verifyStockOrganizationCandidate } = await import('./stock-organization-provenance');
  await verifyStockOrganizationCandidate(userId, expected);
  const oldJob = await readRecallJsonRecord(userId, 'stock-organization', expected.stockOrganizationProvenance!.jobId) as StockOrganizationJob;
  if (!oldJob?.draft || expected.proposalTarget !== 'ontology' || !expected.ontologyFormation
    || !['pending_review', 'deferred'].includes(expected.status)) throw new Error('stock ontology recheck unavailable');
  // Concurrent rechecks must not overwrite each other's prepared proof before
  // the candidate CAS chooses a winner.
  const id = `stock-${randomUUID().replace(/-/g, '')}`;
  let job: StockOrganizationJob = { ...oldJob, id, state: 'checking',
    replacesJobId: oldJob.id, reviewKind: mode, prepared: undefined, updatedAt: new Date().toISOString(),
    reason: undefined, failureCode: undefined, failureReasonCode: undefined, failureMessage: undefined };
  try {
    const unit = (await inventoryStockOrganization(userId, { unitKey: oldJob.unit.key }))[0];
    if (!unit || unit.sourceIssues?.length) throw Object.assign(new Error('recorded source requires review'), { code: 'stock_source_requires_review' });
    job = { ...job, unit, fingerprint: digest(unitIdentity(unit)) };
    await updateRecallJsonRecord(userId, 'stock-organization', id, () => job);
    let draft: StockDraft = { ...oldJob.draft, reason: reviewReason || expected.evidenceSummary || oldJob.draft.reason,
      ontologyChanges: { reason: reviewReason || expected.ontologyFormation.reason, evidence: expected.ontologyFormation.evidence,
        actions: expected.ontologyFormation.actions } };
    const source = sourceText(unit);
    if (mode === 'content') {
      const settings = await readRecallCaptureSettings(userId);
      const modelCandidates = await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates);
      const call = async (stage: 'extraction' | 'grounding', systemPrompt: string, message: string) => {
        const { result } = await runRecallCaptureModel(userId, { sessionId: `${id}-${stage}`, jobContext: { jobId: id }, modelCandidates,
          systemPrompt, message, responseFormat: 'json_object', maxOutputTokens: 8192,
          budget: { jobId: id, stage, source: 'stock_organization' } });
        if (result.meta.aborted) throw aborted();
        if (result.meta.error) throw new StockJobError('stock_model_unavailable', 'stock recheck model unavailable');
        return result.text;
      };
      const edited = expected.ontologyFormation.blockedReasons.includes('candidate_edited_requires_ontology_review');
      const regenerate = edited || expected.ontologyFormation.blockedReasons.some(reason =>
        reason === 'content_review_required' || reason === 'stock_recheck_failed');
      const message = JSON.stringify({ primary: JSON.parse(source), related: [], previousProposal: expected.ontologyFormation.actions,
        ...(edited ? { reviewInstructions: expected.judgment } : {}) });
      assertNotForbiddenToPersist([message]);
      if (message.length > 128_000) throw new Error('complete stock recheck input exceeds context limit');
      const extract = async (repair = false) => {
        const text = await call('extraction', stockExtractionPrompt(unit) + (repair ? `\n\n${STOCK_ONTOLOGY_EXTRACTION_REPAIR}` : ''), message);
        try { draft = draftSchema.parse(parseCaptureAssessmentJson(text)); }
        catch { throw new StockJobError('stock_output_invalid', 'stock revision output invalid', true); }
        if (draft.outcome !== 'proposal') throw new StockJobError(draft.outcome === 'no_change' ? 'stock_no_change' : 'stock_evidence_insufficient',
          'revision did not produce a complete supported proposal');
        job.draft = draft;
        return prepare(userId, job, draft);
      };
      let prepared: SaveRecallCandidateInput;
      if (regenerate) {
        try { prepared = await extract(); }
        catch (error) {
          // Match the existing sweep: one contract repair, not another judge or
          // a retry of a semantic rejection. The same frozen input is reused.
          if (!(error instanceof StockJobError && error.repairable) && classifyStockFailure(error).code !== 'stock_action_invalid') throw error;
          prepared = await extract(true);
        }
      } else {
        prepared = prepare(userId, job, draft);
      }
      const assess = async (repair = false) => {
        const text = await call('grounding', prompts.load('recall_stock_grounding') + (repair ? `\n\n${STOCK_GROUNDING_REPAIR}` : ''),
          JSON.stringify({ sources: [{ label: 'stored-version', text: source }], proposed: prepared }));
        try { return parseCaptureGroundingAssessment(text, [{ label: 'stored-version', text: source }]); }
        catch { throw new StockJobError('stock_output_invalid', 'stock grounding output invalid', true); }
      };
      let check;
      try { check = await assess(); }
      catch (error) {
        if (!(error instanceof StockJobError && error.repairable)) throw error;
        check = await assess(true);
      }
      if (![check.supported, check.noUnsupportedClaims, check.scopePreserved, check.finalDecisionPreserved, check.priorContentPreserved].every(Boolean))
        throw new Error('stock recheck cannot preserve the recorded meaning');
      job.prepared = prepared;
    } else {
      job.prepared = prepare(userId, job, draft, { preserveLegacyCopy: !reviewReason });
      // A source repair never clears a content/user-edit review requirement.
      job.prepared.ontologyFormation!.blockedReasons = expected.ontologyFormation.blockedReasons.filter(reason => reason !== 'stock_source_requires_review');
      job.prepared.judgment = reviewReason || expected.judgment;
      job.prepared.evidenceSummary = reviewReason || expected.evidenceSummary;
    }
    await assertStockOrganizationBaseline(userId, unit);
    job = { ...job, draft, state: 'prepared', updatedAt: new Date().toISOString() };
    await updateRecallJsonRecord(userId, 'stock-organization', id, () => job);
    const result = await withStockOrganizationWrite(userId, job.prepared!,
      () => import('./candidate-service').then(service => service.replaceStockOntologyCandidate(userId, expected, job.prepared!)));
    await updateRecallJsonRecord(userId, 'stock-organization', id, current => ({ ...current!, state: 'proposed' }));
    return result;
  } catch (error) {
    const failure = classifyStockFailure(error);
    await updateRecallJsonRecord(userId, 'stock-organization', id, () => ({ ...job,
      state: failure.code === 'stock_no_change' ? 'no_change'
        : failure.code === 'stock_evidence_insufficient' || failure.code === 'stock_unit_unresolved' ? 'insufficient'
        : 'failed',
      reason: failure.code, failureCode: failure.code, failureReasonCode: failure.reasonCode,
      // Provider diagnostics are not review copy; retain the bounded failure code.
      failureMessage: undefined, updatedAt: new Date().toISOString() }));
    try {
      await holdStockOntologyCandidate(userId, expected,
        failure.code === 'stock_source_requires_review' ? 'stock_source_requires_review' : 'stock_recheck_failed');
    } catch (holdError) {
      if ((holdError as { code?: string }).code !== 'ontology_recheck_candidate_changed') throw holdError;
    }
    throw error;
  }
}
