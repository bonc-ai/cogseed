import { z } from 'zod';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createLogger } from '../../logger';
/** One ambiguity check for the complete formation batch, not one call per item.
 * Keeps attribution, target identity, merged content and uncertainty together. */
import { prompts } from '../../prompts/loader';
import { runRecallCaptureModel } from './capture-model-routing';
import { parseCaptureAssessmentJson, parseCaptureGroundingAssessment, type GroundingCandidate, type GroundingSource, type CaptureGroundingAssessment } from './capture-grounding';
import { validateFormationComparison, type FormationComparison } from './formation-comparison';
import { RECALL_TEXT_LIMITS } from './content-contract';
import type { CaptureExistingAssetsResult } from './capture-existing-assets';
import type { RecallCaptureModelCandidate } from './capture-settings';
import type { CaptureModelBudgetContext } from './capture-model-budget';
import type { CaptureContextSummary } from './capture-context-summary';
import { captureSourcePassages } from './capture-context-payload';
import { ONTOLOGY_RULE_SEMANTICS, SOURCE_RULE_CONCLUSION_PROTOCOL, formationRuleContext, formationRuleContracts, formationRuleSourceRequests,
  blindFormationRuleCandidate, parseSourceRuleConclusions, deriveFormationRuleRevisions,
  type FormationRuleRevision, type SourceRuleConclusion } from './ontology-rule-semantics';
const log = createLogger('recall.formation-assessment');
export interface FormationBatchItem { index: number; candidate: GroundingCandidate; sources: GroundingSource[];
  /** Host-validated extraction comparison. When present, the host owns the
   * target identity/version/quote and the model must not copy them. */
  comparison?: FormationComparison;
  /** Source-only extraction leaves identity and action to this batch. */
  sourceProposal?: boolean }
const revisionSchema = z.object({ judgment: z.string().trim().min(1).max(RECALL_TEXT_LIMITS.statement),
  applicableWhen: z.array(z.string().trim().min(1).max(500)).max(32).optional(),
  forbiddenWhen: z.array(z.string().trim().min(1).max(500)).max(32).optional(),
}).strict();
export interface FormationBatchResult { revision?: z.infer<typeof revisionSchema>; ruleRevisions?: FormationRuleRevision[];
  sourceRuleConclusions?: SourceRuleConclusion[];
  /** Independent body/baseline verdict, before the host compares R metadata.
   * Cache replay must not reuse a previous host-derived mismatch or repair. */
  sourceChecks?: CaptureGroundingAssessment;
  index: number; checks: CaptureGroundingAssessment; uncertaintyDisposition: string; comparison?: FormationComparison }
export interface FormationBatchCheckpoint { ruleSemanticsPolicyVersion?: 3; sourceFingerprint?: string; fingerprint: string; assessments: FormationBatchResult[];
  itemFailures?: Array<{ index: number; reason: 'assessment_invalid' | 'dependency_unavailable' | 'related_assets_overflow'; relatedAssetIds?: string[] }> }

/** Connect only actual writes/references, not shared source messages. A joint
 * proposal is already one item; cross-item writes to the same identity or a
 * reference to another item's write cannot be committed independently. */
export function analyzeFormationDependencies(items: Array<{ index: number; candidate: GroundingCandidate }>): {
  groups: number[][]; invalidIndexes: number[];
} {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const invalidIndexes: number[] = [];
  const referenceKeys = new Set(['moduleId', 'typeId', 'subjectId', 'definitionId', 'entityId',
    'targetModuleId', 'targetRecordId', 'recordId', 'targetId', 'supersedesId', 'subjectTypes', 'objectTypes']);
  const references = (value: unknown, output = new Set<string>(), key = ''): Set<string> => {
    if (typeof value === 'string' && referenceKeys.has(key)) output.add(`ontology:${value}`);
    else if (Array.isArray(value)) value.forEach(child => references(child, output, key));
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (object.kind === 'entity' && typeof object.id === 'string') output.add(`ontology:${object.id}`);
      if (object.kind === 'task' && object.field === 'entityId' && typeof object.equals === 'string') output.add(`ontology:${object.equals}`);
      Object.entries(object).forEach(([field, child]) => references(child, output, field));
    }
    return output;
  };
  const footprints = items.map(item => {
    const raw = item.candidate.ontologyChanges;
    const plan = object(raw) ? raw : undefined;
    // These are still untrusted extraction values. Canonical ontology validation
    // remains at materialization; this boundary only makes analysis safe and
    // keeps malformed items out of rule readers and model assessment.
    const safeRows = (value: unknown) => value === undefined || Array.isArray(value) && value.every(row => object(row)
      && ['recordId', 'targetId'].every(key => row[key] === undefined || typeof row[key] === 'string' && !!row[key].trim())
      && ['record', 'patch'].every(key => row[key] === undefined || object(row[key])));
    if (raw != null && (!plan || !safeRows(plan.actions) || !safeRows(plan.refs))) invalidIndexes.push(item.index);
    // Preserve recognizable identities even in malformed containers, so their
    // known dependants are held too. Never synthesize an identity for bad data.
    const actions = Array.isArray(plan?.actions) ? plan.actions : object(plan?.actions) ? [plan.actions] : [];
    return { index: item.index, writes: new Set([
      ...(item.candidate.targetAssetId ? [`asset:${item.candidate.targetAssetId}`] : []),
      ...actions.filter(object).flatMap(action => [action.recordId, action.targetId]
        .flatMap(id => typeof id === 'string' && id ? [`ontology:${id}`] : [])),
    ]), reads: references([plan?.actions, plan?.refs]) };
  });
  const remaining = new Set(footprints.map(row => row.index)), groups: number[][] = [];
  for (const seed of footprints) {
    if (!remaining.delete(seed.index)) continue;
    const group = [seed.index];
    for (let i = 0; i < group.length; i++) {
      const current = footprints.find(row => row.index === group[i])!;
      for (const other of footprints) if (remaining.has(other.index)
        && ([...current.writes].some(id => other.writes.has(id) || other.reads.has(id))
          || [...other.writes].some(id => current.reads.has(id)))) {
        remaining.delete(other.index); group.push(other.index);
      }
    }
    groups.push(group);
  }
  return { groups, invalidIndexes };
}
export class FormationBatchUnavailableError extends Error {
  readonly code = 'formation_batch_unavailable';
  constructor(readonly reason: 'context_too_large' | 'source_unavailable' | 'model_not_configured' | 'model_unavailable' | 'assessment_invalid') {
    super(`formation assessment unavailable: ${reason}`);
  }
}
export async function assessFormationBatch(userId: string, input: {
  sessionId: string; items: FormationBatchItem[]; contextMessages: unknown[]; summary: unknown;
  existing: CaptureExistingAssetsResult; ontology: unknown; feedback: unknown;
  /** Findings computed from the same admitted asset snapshot as `existing`. */
  relatedFindings?: Array<{ category: 'duplicate' | 'conflict' | 'outdated'; assetIds: string[]; detail: string }>;
  modelCandidates: readonly RecallCaptureModelCandidate[]; budget?: CaptureModelBudgetContext;
  signal?: AbortSignal; shouldContinue?: () => Promise<boolean>;
  checkpoint?: FormationBatchCheckpoint;
  conversationId?: string;
  contextSummary?: CaptureContextSummary;
}): Promise<FormationBatchCheckpoint> {
  if (!input.items.length) return { fingerprint: '', assessments: [] };
  const ontologyRecords = formationRuleContext(input.ontology);
  const { groups, invalidIndexes } = analyzeFormationDependencies(input.items);
  const failures = new Map<number, 'assessment_invalid' | 'dependency_unavailable' | 'related_assets_overflow'>(invalidIndexes.map(index => [index, 'assessment_invalid']));
  const overflowAssets = new Map<number, string[]>();
  const candidates = input.items.flatMap(item => {
    if (failures.has(item.index)) return [];
    try { return [{ index: item.index, sources: item.sources,
      ...(item.sourceProposal ? { sourceProposal: true } : {}),
      candidate: blindFormationRuleCandidate(item.candidate, ontologyRecords),
      ...(item.comparison ? { comparison: item.comparison } : {}),
      ruleSourceRequests: formationRuleSourceRequests(item.candidate.ontologyChanges, ontologyRecords, item.candidate.judgment) }]; }
    catch { failures.set(item.index, 'assessment_invalid'); return []; }
  });
  const holdFailedGroups = () => {
    for (const group of groups) if (group.some(index => failures.has(index)))
      for (const index of group) if (!failures.has(index)) failures.set(index, 'dependency_unavailable');
  };
  holdFailedGroups();
  const envelope = { ruleSemanticsPolicyVersion: 3, candidates, completeConversationContext: input.contextMessages,
    summary: input.contextSummary?.topics || input.summary, existingAssets: input.existing.assets, comparisonCoverage: input.existing.coverage,
    ...(input.relatedFindings?.length ? { relatedFindings: input.relatedFindings.slice(0, 80),
      relatedFindingsTruncated: input.relatedFindings.length > 80 } : {}),
    ontology: input.ontology, feedback: input.feedback };
  let message = JSON.stringify(envelope);
  if (message.length > 128_000 && input.contextSummary) {
    const messages = input.contextMessages as Array<{ id: string; label: string; text: string }>;
    try {
      const approved = input.items.flatMap(item => item.sources.flatMap(source => (source.approvedQuotes || []).map(quote => {
        const original = messages.find(message => message.label === source.label);
        if (!original) throw new Error('approved source message missing');
        return { messageId: original.id, quote };
      })));
      const context = captureSourcePassages(messages, input.contextSummary, approved);
      // Per-item source text duplicates the full user message. The parser still
      // checks returned evidence against the original, unmodified sources.
      message = JSON.stringify({ ...envelope, candidates: candidates.map(item => ({ ...item,
        sources: item.sources.map(source => ({ label: source.label, approvedQuotes: source.approvedQuotes })) })),
        completeConversationContext: context,
        contextCoverage: { representation: 'complete_summary_and_original_passages', sourceDigest: input.contextSummary.sourceDigest,
          ...input.contextSummary.coverage } });
    } catch (error) {
      log.warn('formation batch source unavailable', { reason: (error as Error)?.message?.slice(0, 300) || String(error).slice(0, 300) });
      throw new FormationBatchUnavailableError('source_unavailable');
    }
  }
  if (message.length > 128_000) throw new FormationBatchUnavailableError('context_too_large');
  const sourceFingerprint = createHash('sha256').update(message).digest('hex');
  // A reusable source observation is not a grant for a different full draft.
  const fingerprint = createHash('sha256').update(JSON.stringify({ sourceFingerprint,
    ...(input.relatedFindings?.length ? { relatedFindings: input.relatedFindings } : {}),
    proposals: input.items.map(item => ({ index: item.index, candidate: item.candidate })) })).digest('hex');
  const parseRow = (value: unknown, replay = false): FormationBatchResult => {
    const row = value as FormationBatchResult;
    const item = input.items.find(item => item.index === row?.index);
    if (!item || !row || Object.keys(row).some(key => !['index', 'checks', 'uncertaintyDisposition', 'comparison', 'revision', 'sourceRuleConclusions'].includes(key))
      || !['effect_unverified', 'outside_claim_scope', 'source_attribution_only', 'content_unresolved', 'none'].includes(row.uncertaintyDisposition)) throw new Error('invalid formation assessment');
    // Some providers place the complete revision inside comparison. Move it
    // only when it has a single unambiguous value; never rewrite its content.
    let rawComparison = row.comparison as unknown;
    let rawRevision = row.revision as unknown;
    if (rawComparison && typeof rawComparison === 'object' && !Array.isArray(rawComparison)) {
      const comparisonObject = { ...rawComparison as Record<string, unknown> };
      if (Object.hasOwn(comparisonObject, 'revision')) {
        const nested = comparisonObject.revision;
        delete comparisonObject.revision;
        if (nested != null && rawRevision != null && !isDeepStrictEqual(nested, rawRevision)) throw new Error('conflicting formation revisions');
        if (rawRevision == null) rawRevision = nested;
      }
      rawComparison = comparisonObject;
    }
    if (rawRevision && typeof rawRevision === 'object' && !Array.isArray(rawRevision)) {
      const revisionObject = { ...rawRevision as Record<string, unknown> };
      for (const key of ['applicableWhen', 'forbiddenWhen']) if (revisionObject[key] === null) delete revisionObject[key];
      rawRevision = revisionObject;
    }
    const checks = parseCaptureGroundingAssessment(JSON.stringify(row.checks), item.sources);
    const sourceChecks = structuredClone(checks);
    // The host owns a resolved target identity. The extraction comparison was
    // already validated against the complete target; never ask the assessment
    // model to retype an asset ID or an exact quote it can only corrupt.
    const hostComparison = item.comparison && (
      item.sourceProposal && item.comparison.relation === 'new' && !item.candidate.targetAssetId
      || item.candidate.targetAssetId && item.comparison.targetAssetId === item.candidate.targetAssetId
    ) ? item.comparison : undefined;
    let comparison = hostComparison
      ? validateFormationComparison(Object.fromEntries(Object.entries(hostComparison).filter(([key]) => key !== 'coverage')), input.existing.assets, input.existing.coverage, { allowReferenceOnly: replay })
      : rawComparison ? validateFormationComparison(rawComparison, input.existing.assets, input.existing.coverage, { allowReferenceOnly: replay }) : undefined;
    if (item.sourceProposal && !comparison) throw new Error('missing source proposal comparison');
    if (!item.sourceProposal && item.candidate.targetAssetId && comparison?.targetAssetId !== item.candidate.targetAssetId) throw new Error('formation target identity unresolved');
    if (!item.sourceProposal && item.candidate.targetAssetId && !comparison) throw new Error('missing target comparison');
    let revision = rawRevision == null ? undefined : revisionSchema.parse(rawRevision);
    if (revision && (!(item.sourceProposal ? comparison?.targetAssetId : item.candidate.targetAssetId) || !comparison || !['evidence', 'exception', 'correction', 'changed'].includes(comparison.relation))) throw new Error('revision has no resolved existing target');
    if (item.sourceProposal && comparison && ['evidence', 'exception', 'correction', 'changed'].includes(comparison.relation) && !revision) throw new Error('update requires a complete merged revision');
    // A single-target update cannot safely stand in for a review of multiple
    // related assets. Retain exact, snapshot-validated references and hold the
    // proposal for human review; do not persist a model-produced merge as an update.
    if (item.sourceProposal && comparison && comparison.relation !== 'new') {
      const related = new Map((comparison.relatedAssets || []).map(row => [row.assetId, row]));
      if (comparison.targetAssetId && comparison.targetVersion && comparison.targetQuote) related.set(comparison.targetAssetId,
        { assetId: comparison.targetAssetId, version: comparison.targetVersion, quote: comparison.targetQuote });
      let changed = true;
      while (changed) {
        changed = false;
        for (const finding of input.relatedFindings || []) {
          if (!['duplicate', 'conflict'].includes(finding.category) || !finding.assetIds.some(id => related.has(id))) continue;
          for (const id of finding.assetIds) {
            const asset = input.existing.assets.find(asset => asset.id === id);
            if (asset && !related.has(id)) {
              related.set(id, { assetId: id, version: asset.version, quote: asset.statement.slice(0, 1000) });
              changed = true;
            }
          }
        }
      }
      if (related.size > 6) throw Object.assign(new Error('related asset group exceeds review limit'),
        { code: 'related_assets_overflow', relatedAssetIds: [...related.keys()] });
      if (related.size > 1) {
        const validated = validateFormationComparison({ relation: 'ambiguous',
          reason: '多条相关旧内容需要结合新来源核对，合并或删除由你决定。',
          relatedAssets: [...related.values()] }, input.existing.assets, input.existing.coverage,
          { allowReferenceOnly: replay });
        // Excerpts prove the model's comparison at formation time but are not
        // carried into a candidate, checkpoint, logs, or a later IPC response.
        comparison = { ...validated, relatedAssets: validated.relatedAssets!.map(({ assetId, version }) => ({ assetId, version })) };
        revision = undefined;
      }
    }
    const contracts = formationRuleContracts(item.candidate.ontologyChanges, ontologyRecords);
    const sourceRuleConclusions = parseSourceRuleConclusions(row.sourceRuleConclusions, contracts, item.sources);
    const rules = deriveFormationRuleRevisions(item.candidate.ontologyChanges, sourceRuleConclusions, ontologyRecords, true);
    if (!rules.supported) { checks.supported = false; checks.finalDecisionPreserved = false; }
    return { index: row.index, checks, uncertaintyDisposition: row.uncertaintyDisposition, ...(comparison ? { comparison } : {}),
      sourceChecks, ...(revision ? { revision } : {}), ...(rules.ruleRevisions.length ? { ruleRevisions: rules.ruleRevisions } : {}),
      ...(contracts.length ? { sourceRuleConclusions } : {}) };
  };
  const assessments = new Map<number, FormationBatchResult>();
  if (input.checkpoint?.ruleSemanticsPolicyVersion === 3 && input.checkpoint.sourceFingerprint === sourceFingerprint
    && input.checkpoint.fingerprint === fingerprint) {
    for (const row of input.checkpoint.assessments) try {
      if (failures.has(row.index)) continue;
      // Replay source observations, not an old host-derived approval/repair.
      const comparison = row.comparison ? Object.fromEntries(Object.entries(row.comparison).filter(([key]) => key !== 'coverage')) : undefined;
      const parsed = parseRow({ index: row.index, checks: row.sourceChecks || row.checks,
        uncertaintyDisposition: row.uncertaintyDisposition,
        ...(comparison ? { comparison } : {}),
        ...(row.revision ? { revision: row.revision } : {}),
        ...(row.sourceRuleConclusions ? { sourceRuleConclusions: row.sourceRuleConclusions } : {}) }, true);
      assessments.set(parsed.index, parsed);
    } catch { /* Invalid cached rows require a fresh verdict, never a default. */ }
  }
  const pending = input.items.filter(item => !assessments.has(item.index) && !failures.has(item.index));
  if (pending.length) {
    const originalPayload = JSON.parse(message);
    const invoke = async (items: FormationBatchItem[], repair: boolean) => {
      if (input.signal?.aborted || input.shouldContinue && !await input.shouldContinue())
        throw Object.assign(new Error('formation assessment interrupted'), { code: 'ABORT_ERR' });
      const payload = repair
        ? { ...originalPayload, expectedResponseIndexes: items.map(item => item.index) }
        : { ...originalPayload, candidates: originalPayload.candidates.filter(
          (item: { index: number }) => items.some(row => row.index === item.index)) };
      const repairInstruction = '\nThe previous response was not a complete parseable assessment envelope. Re-read the same complete candidate batch and its original context. All candidates remain available for comparison, but return exactly one JSON object with an assessments array containing one row for each index in expectedResponseIndexes and no other rows. Return no extra fields or prose; preserve the original source, target version and exact quote requirements.';
      let result: Awaited<ReturnType<typeof runRecallCaptureModel>>['result'];
      try { ({ result } = await runRecallCaptureModel(userId, { sessionId: input.sessionId,
        systemPrompt: `${prompts.load('cognition_formation_batch')}\n${ONTOLOGY_RULE_SEMANTICS}\n${SOURCE_RULE_CONCLUSION_PROTOCOL}${repair ? repairInstruction : ''}`,
        message: JSON.stringify(payload), modelCandidates: input.modelCandidates,
        signal: input.signal, shouldContinue: input.shouldContinue, budget: input.budget,
        ...(input.conversationId ? { cliContext: { conversationId: input.conversationId } } : {}) })); }
      catch (error) {
        if ((error as { code?: string }).code === 'ABORT_ERR' || input.signal?.aborted) throw error;
        if (repair) throw new FormationBatchUnavailableError('assessment_invalid');
        throw new FormationBatchUnavailableError((error as { code?: string }).code === 'capture_model_not_configured' ? 'model_not_configured' : 'model_unavailable');
      }
      if (result.meta.aborted || input.signal?.aborted || input.shouldContinue && !await input.shouldContinue())
        throw Object.assign(new Error('formation assessment interrupted'), { code: 'ABORT_ERR' });
      if (result.meta.error) throw new FormationBatchUnavailableError(repair ? 'assessment_invalid' : 'model_unavailable');
      return result.text;
    };
    const readEnvelope = (text: string, items: FormationBatchItem[]) => {
      const raw = parseCaptureAssessmentJson(text) as { assessments?: unknown[] };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'assessments')
        || !Array.isArray(raw.assessments)) throw new Error('invalid formation assessment envelope');
      const counts = new Map<number, number>();
      for (const value of raw.assessments) {
        const index = (value as { index?: number } | null)?.index;
        if (typeof index !== 'number' || !items.some(item => item.index === index))
          throw new Error('unknown formation assessment identity');
        counts.set(index, (counts.get(index) || 0) + 1);
      }
      const complete = raw.assessments.length === items.length && raw.assessments.every(value => {
        const index = (value as { index?: number } | null)?.index;
        return typeof index === 'number' && counts.get(index) === 1;
      });
      const unique = raw.assessments.filter(value => {
        const index = (value as { index?: number } | null)?.index;
        return typeof index === 'number' && counts.get(index) === 1;
      });
      return { complete, unique };
    };
    const acceptRows = (rows: unknown[]) => {
      for (const value of rows) {
        const index = (value as { index: number }).index;
        try { assessments.set(index, parseRow(value)); }
        catch (error) {
          log.warn('formation batch row invalid', { index, error: error instanceof Error ? error.message : 'unknown' });
          const failure = error as { code?: string; relatedAssetIds?: string[] };
          if (failure.code === 'related_assets_overflow' && failure.relatedAssetIds?.length) {
            failures.set(index, 'related_assets_overflow');
            overflowAssets.set(index, failure.relatedAssetIds);
          } else failures.set(index, 'assessment_invalid');
        }
      }
    };
    const firstText = await invoke(pending, false);
    let first: ReturnType<typeof readEnvelope> | undefined;
    try { first = readEnvelope(firstText, pending); } catch { /* only format repair may retry */ }
    if (first?.complete) acceptRows(first.unique);
    else {
      // Preserve every independently valid row; only missing or duplicate rows
      // enter the one format-repair call. Invalid existing rows are not retried.
      if (first) acceptRows(first.unique);
      const missing = pending.filter(item => !assessments.has(item.index) && !failures.has(item.index));
      if (missing.length) {
        try {
          const repaired = readEnvelope(await invoke(missing, true), missing);
          acceptRows(repaired.unique);
          if (!repaired.complete) for (const item of missing)
            if (!assessments.has(item.index) && !failures.has(item.index)) failures.set(item.index, 'assessment_invalid');
        } catch (error) {
          if ((error as { code?: string }).code === 'ABORT_ERR' || input.signal?.aborted) throw error;
          log.warn('formation batch format repair failed', { expected: missing.length });
          for (const item of missing) failures.set(item.index, 'assessment_invalid');
        }
      }
    }
  }
  holdFailedGroups();
  for (const index of failures.keys()) assessments.delete(index);
  if (!assessments.size && failures.size && !overflowAssets.size) throw new FormationBatchUnavailableError('assessment_invalid');
  return { ruleSemanticsPolicyVersion: 3, sourceFingerprint, fingerprint,
    assessments: input.items.flatMap(item => assessments.has(item.index) ? [assessments.get(item.index)!] : []),
    ...(failures.size ? { itemFailures: [...failures].map(([index, reason]) => ({ index, reason,
      ...(overflowAssets.has(index) ? { relatedAssetIds: overflowAssets.get(index)! } : {}) })) } : {}) };
}
