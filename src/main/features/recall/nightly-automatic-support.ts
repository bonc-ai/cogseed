import { resolveRecallCaptureModelCandidates } from './capture-model-selection';
/** Independent source-support observation for automatic confirmation. A lexical
 * match, a producer's boolean, or source existence cannot authorize new meaning.
 * Receipts contain fingerprints and evidence coordinates, never private text. */
import { createHash } from 'node:crypto';
import { readJsonl } from '../../storage';
import { prompts } from '../../prompts/loader';
import { fileEditLock } from '../../util/locks';
import { conversationMessageReadFile } from '../../util/project-layout';
import type { GroupMessage } from '../group_chat/visibility';
import { readOntologyDocument } from '../cognition/ontology/service';
import { readRecallCaptureSettings } from './capture-settings';
import { captureContextSourceDigest, type CaptureContextSummary } from './capture-context-summary';
import { captureSummaryDecisionDigest, verifyCaptureProvenanceForPromotion } from './capture-provenance';
import { parseCaptureAssessmentJson, parseCaptureGroundingAssessment, type GroundingSource, type CaptureGroundingAssessment } from './capture-grounding';
import { runRecallCaptureModel } from './capture-model-routing';
import { parseCaptureUncertaintyAssessment, type CaptureUncertaintyDisposition } from './capture-uncertainty';
import { isRecallAssistantMessage, isRecallConversationMessage } from './conversation-message-policy';
import { cognitionMessageSourceId, cognitionExistingSourceIds } from './source-catalog';
import { listDisabledCognitionMessageIds } from './source-control';
import { recallJsonRecordPath } from './paths';
import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallCandidateRecord } from './candidate-service';
import type { RecallJsonRecord } from './types';
import { captureSourcePassages } from './capture-context-payload';
import { ONTOLOGY_RULE_SEMANTICS, SOURCE_RULE_CONCLUSION_PROTOCOL, formationRuleContext, formationRuleContracts, formationRuleSourceRequests,
  blindFormationRuleCandidate, parseSourceRuleConclusions, deriveFormationRuleRevisions,
  type FormationRuleRevision, type SourceRuleConclusion, type FormationRuleContext } from './ontology-rule-semantics';

export type NightlySemanticSupportOutcome = 'supported' | 'unsupported' | 'unavailable' | 'stale';
const COLLECTION = 'automatic-source-support';
const OBSERVATIONS = 'automatic-source-observations';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const digest = (value: unknown) => hash(JSON.stringify(canonical(value)));
// Operational transitions do not alter the meaning being checked. Every other
// field, including the entire plan and source/access policy, participates.
const operationalFields = new Set(['status', 'updatedAt', 'statementIssues', 'autoReview', 'promotedAssetId',
  'reviewDecisionId', 'failureCode', 'failureMessage', 'failedAt', 'validationCount', 'lastValidatedAt',
  'consecutiveFailures', 'appliedValidationIds', 'decisionNote', 'mergedInto', 'mergedIntoAssetId']);
function candidateContent(candidate: RecallCandidateRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries({ ...candidate, origin: candidate.origin || (candidate.captureProvenance ? 'capture' : undefined) })
    .filter(([key]) => !operationalFields.has(key)));
}
/** Stable semantic binding for a committed observation; excludes only the same
 * operational transitions already excluded by the pending support check. */
export function nightlySemanticCandidateDigest(candidate: RecallCandidateRecord): string { return digest(candidateContent(candidate)); }
interface SummaryUnresolved { topicIndex: number; items: string[] }
/** Select only the source-backed topics relevant to this candidate. Preserve
 * every unresolved item verbatim; the host never classifies by wording. */
export function relevantAutomaticSummaryUnresolved(candidate: RecallCandidateRecord, summary: CaptureContextSummary, conversationId: string): SummaryUnresolved[] | undefined {
  if (!summary || !Array.isArray(summary.topics)) return undefined;
  const ids = new Set(candidate.evidenceRefs.filter(ref => ref.kind === 'conversation' && ref.subtype === 'message').map(ref => ref.id));
  const relevant = summary.topics.map((topic, topicIndex) => ({ topic, topicIndex })).filter(({ topic }) =>
    Array.isArray(topic?.evidence) && topic.evidence.some(ref => ids.has(cognitionMessageSourceId(conversationId, ref.messageId))));
  if (!relevant.length || relevant.some(({ topic }) => !Array.isArray(topic.unresolved)
    || topic.unresolved.some(item => typeof item !== 'string' || !item.trim()))) return undefined;
  return relevant.filter(({ topic }) => topic.unresolved.length > 0).map(({ topic, topicIndex }) => ({ topicIndex, items: [...topic.unresolved] }));
}
interface Snapshot {
  fingerprint: string; candidate: RecallCandidateRecord; sources: GroundingSource[];
  sourceDigest: string; summaryDigest: string; message: string; ontologyRevision?: number; targetVersion?: string; unresolvedDigest?: string;
  context: Array<{ messageId: string; text: string; label: string }>;
  conversationId: string;
  ruleContracts: FormationRuleRevision[];
  ruleContext: FormationRuleContext[];
  sourceFingerprint: string;
}
interface SupportReceipt extends RecallJsonRecord {
  schemaVersion: 1; method: 'model_assisted'; policyVersion: 1; fingerprint: string;
  candidateId: string; captureId: string; policyEpoch: string; sourceDigest: string; summaryDigest: string;
  ontologyRevision?: number; targetVersion?: string; modelCompleted: true;
  checks: { supported: true; noUnsupportedClaims: true; scopePreserved: true; finalDecisionPreserved: true; priorContentPreserved: true };
  evidence: Array<{ messageId: string; start: number; end: number; quoteHash: string }>;
  ruleChecks?: Array<{ recordId: string; contractDigest: string;
    checks: { strengthPreserved: true; conditionPreserved: true; effectPreserved: true; exceptionPreserved: true };
    evidence: SupportReceipt['evidence'] }>;
  ruleSemanticsPolicyVersion?: 3; sourceObservationId?: string;
  summaryUncertainty?: { disposition: Exclude<CaptureUncertaintyDisposition, 'content_unresolved'>; unresolvedDigest: string };
  createdAt: string;
}
interface SourceObservation extends RecallJsonRecord {
  schemaVersion: 1; ruleSemanticsPolicyVersion: 3; fingerprint: string; candidateId: string; captureId: string;
  policyEpoch: string; modelCompleted: true; assessment: CaptureGroundingAssessment;
  sourceRuleConclusions: SourceRuleConclusion[]; uncertaintyDisposition?: CaptureUncertaintyDisposition; createdAt: string;
}
/** Lock-held commit callers can bind the exact already-validated observation.
 * This accessor never invokes a model and cannot validate a post-commit baseline. */
export async function readVerifiedPendingNightlySupport(userId: string, candidate: RecallCandidateRecord, epoch: string): Promise<SupportReceipt | undefined> {
  try {
    const current = await snapshot(userId, candidate, epoch);
    return verifiedReceipt(userId, current, epoch);
  } catch { return undefined; }
}
function stale(): never { throw Object.assign(new Error('automatic semantic support baseline changed'), { code: 'automatic_support_stale' }); }
async function snapshot(userId: string, expected: RecallCandidateRecord, epoch: string): Promise<Snapshot> {
  const { readRecallCandidate } = await import('./candidate-service');
  const candidate = await readRecallCandidate(userId, expected.id);
  if (digest(candidateContent(candidate)) !== digest(candidateContent(expected))
    || candidate.status !== 'pending_review' || candidate.userModifiedAt || candidate.ontologyHandoff
    || Date.parse(candidate.expiresAt) <= Date.now()) stale();
  const settings = await readRecallCaptureSettings(userId);
  if (!settings.enabled || !settings.autoApproval || settings.autoApprovalEpoch !== epoch) stale();
  const proof = await verifyCaptureProvenanceForPromotion(userId, candidate);
  const groups = new Map<import('./source-service').CognitionSourceType, string[]>();
  for (const ref of [...candidate.sourceRefs, ...candidate.evidenceRefs]) {
    if (ref.taxonomyVersion !== 2) stale();
    const kind = ref.kind as import('./source-service').CognitionSourceType;
    groups.set(kind, [...(groups.get(kind) || []), ref.id]);
  }
  for (const [kind, ids] of groups) {
    const available = await cognitionExistingSourceIds(userId, kind, ids);
    if (ids.some(id => !available.has(id))) stale();
  }
  const capture = (await readRecallJsonRecord(userId, 'captures', proof.captureId))!;
  if (capture.autoApprovalEpoch !== epoch || capture.autoApprovalEnabledAt !== settings.autoApprovalEnabledAt) stale();
  const summary = capture.contextSummary as CaptureContextSummary;
  const relevantUnresolved = relevantAutomaticSummaryUnresolved(candidate, summary, String(capture.conversationId));
  if (!relevantUnresolved) stale();
  const unresolvedDigest = relevantUnresolved.length ? digest(relevantUnresolved) : undefined;
  const wanted = new Set([...proof.messageIds, ...((capture.contextMessageIds as string[] | undefined) || [])]);
  if ((await listDisabledCognitionMessageIds(userId, String(capture.conversationId), [...wanted])).size) stale();
  const raw = (await readJsonl<GroupMessage>(conversationMessageReadFile(userId, String(capture.conversationId)), Number.MAX_SAFE_INTEGER))
    .filter(row => wanted.has(row.id) && isRecallConversationMessage(row));
  const context = raw.map((row, index) => ({ label: `m${index + 1}`, messageId: row.id,
    role: isRecallAssistantMessage(row) ? 'assistant' : 'user', text: row.text, timestamp: row.ts,
    discovery: proof.messageIds.includes(row.id) }));
  if (raw.length !== wanted.size || captureContextSourceDigest(context.map(row => ({ ...row, id: row.messageId }))) !== summary.sourceDigest) stale();
  const selected = new Set(candidate.evidenceRefs.filter(ref => ref.kind === 'conversation' && ref.subtype === 'message').map(ref => ref.id));
  const sources = context.filter(row => row.role === 'user').map(row => ({ label: row.label, text: row.text,
    approvedQuotes: proof.valueJudgment.evidence.filter(ref => ref.messageId === row.messageId
      && selected.has(cognitionMessageSourceId(String(capture.conversationId), row.messageId))).map(ref => ref.quote) }))
    .filter(row => row.approvedQuotes.length > 0);
  if (!sources.length) stale();
  let target: unknown;
  let targetVersion: string | undefined;
  if (candidate.suggestedAction === 'update') {
    const { readAbilityAsset } = await import('./asset-service');
    const asset = candidate.targetAssetId ? await readAbilityAsset(userId, candidate.targetAssetId) : undefined;
    if (!asset || asset.version !== candidate.targetVersionUsed || (asset.activeVersion || asset.version) !== candidate.targetVersionUsed
      || asset.status !== 'active') stale();
    target = asset; targetVersion = asset.version;
  }
  // Only the exact canonical dependency closure is needed. Include referenced
  // before/after identities and pinned history, without leaking unrelated records.
  let ontology: unknown;
  let ontologyRevision: number | undefined;
  if (candidate.ontologyFormation) {
    const doc = readOntologyDocument(userId);
    if (doc.revision !== candidate.ontologyFormation.baselineRevision) stale();
    const ids = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && doc.records[value] && !ids.has(value)) {
        ids.add(value); collect(doc.records[value]);
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(candidate.ontologyFormation);
    ontology = { revision: doc.revision, records: [...ids].sort().map(id => doc.records[id]),
      history: doc.history.filter(row => ids.has(row.after.id)) };
    ontologyRevision = doc.revision;
  }
  const ruleContext = formationRuleContext(ontology);
  const ruleContracts = formationRuleContracts(candidate.ontologyFormation, ruleContext);
  const original = { policyVersion: 1, ...(candidate.ontologyFormation ? { ruleSemanticsPolicyVersion: 3 } : {}), candidate: candidateContent(candidate), approvedUserSources: sources,
    completeConversationContext: context, summary, existingTarget: target, ontology,
    ...(unresolvedDigest ? { relevantSummaryUnresolved: relevantUnresolved } : {}) };
  const payload = { ...original, candidate: blindFormationRuleCandidate(original.candidate, ruleContext),
    ...(candidate.ontologyFormation ? { ruleSourceRequests: formationRuleSourceRequests(candidate.ontologyFormation, ruleContext, candidate.judgment) } : {}) };
  let message = JSON.stringify(payload);
  if (message.length > 96_000) {
    const passages = captureSourcePassages(context.map(row => ({ ...row, id: row.messageId })), summary, proof.valueJudgment.evidence);
    message = JSON.stringify({ ...payload, approvedUserSources: sources.map(source => ({ label: source.label, approvedQuotes: source.approvedQuotes })),
      completeConversationContext: passages, contextCoverage: { representation: 'complete_summary_and_original_passages', ...summary.coverage } });
  }
  if (message.length > 96_000) throw new Error('automatic support complete context too large');
  return { candidate, sources, message, context, ruleContracts, ruleContext, conversationId: String(capture.conversationId), sourceDigest: summary.sourceDigest, summaryDigest: captureSummaryDecisionDigest(summary),
    sourceFingerprint: digest({ policyVersion: 1, epoch, payload }),
    fingerprint: digest({ policyVersion: 1, epoch, payload: original }), ontologyRevision, targetVersion, unresolvedDigest };
}
function validReceipt(receipt: RecallJsonRecord | undefined, current: Snapshot, epoch: string): receipt is SupportReceipt {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.method !== 'model_assisted' || receipt.policyVersion !== 1 || receipt.modelCompleted !== true
    || receipt.fingerprint !== current.fingerprint || receipt.candidateId !== current.candidate.id
    || receipt.captureId !== current.candidate.captureProvenance!.captureId || receipt.policyEpoch !== epoch
    || receipt.sourceDigest !== current.sourceDigest || receipt.summaryDigest !== current.summaryDigest
    || receipt.ontologyRevision !== current.ontologyRevision || receipt.targetVersion !== current.targetVersion
    || typeof receipt.createdAt !== 'string' || !Number.isFinite(Date.parse(receipt.createdAt))
    || !receipt.checks || !Array.isArray(receipt.evidence) || !receipt.evidence.length || receipt.evidence.length > 32) return false;
  const classification = receipt.summaryUncertainty as Record<string, unknown> | undefined;
  if (current.unresolvedDigest && (!classification
    || classification.unresolvedDigest !== current.unresolvedDigest
    || typeof classification.disposition !== 'string'
    || !['effect_unverified', 'outside_claim_scope', 'source_attribution_only'].includes(classification.disposition))) return false;
  const checks = receipt.checks as Record<string, unknown>;
  if (!['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved'].every(key => checks[key] === true)) return false;
  const context = current.context;
  const evidenceValid = (evidence: SupportReceipt['evidence']) => Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 32 && evidence.every(ref => {
    const row = context.find(row => row.messageId === ref?.messageId);
    const source = current.sources.find(source => source.label === row?.label);
    return row && source && Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 0 && ref.end > ref.start
      && ref.end <= row.text.length && hash(row.text.slice(ref.start, ref.end)) === ref.quoteHash;
  }) && evidence.some(ref => {
    const row = context.find(row => row.messageId === ref.messageId)!;
    const source = current.sources.find(source => source.label === row.label)!;
    return source.approvedQuotes?.some(quote => quote.includes(row.text.slice(ref.start, ref.end)) || row.text.slice(ref.start, ref.end).includes(quote));
  });
  if (!evidenceValid(receipt.evidence)) return false;
  if (!current.ruleContracts.length) return receipt.ruleChecks === undefined || Array.isArray(receipt.ruleChecks) && receipt.ruleChecks.length === 0;
  if (receipt.ruleSemanticsPolicyVersion !== 3 || receipt.sourceObservationId !== `aso-${current.sourceFingerprint.slice(0, 32)}`) return false;
  if (!Array.isArray(receipt.ruleChecks) || receipt.ruleChecks.length !== current.ruleContracts.length) return false;
  const seen = new Set<string>();
  return receipt.ruleChecks.every(rule => {
    const expected = current.ruleContracts.find(contract => contract.recordId === rule?.recordId);
    if (!expected || seen.has(rule.recordId) || rule.contractDigest !== digest(expected)
      || !rule.checks || !['strengthPreserved', 'conditionPreserved', 'effectPreserved', 'exceptionPreserved'].every(key => rule.checks[key] === true)
      || !evidenceValid(rule.evidence)) return false;
    seen.add(rule.recordId); return true;
  });
}

function parseObservationBody(raw: string, current: Snapshot) {
  const { sourceRuleConclusions: rawConclusions, ...body } = parseCaptureAssessmentJson(raw) as Record<string, unknown>;
  const classification = current.unresolvedDigest ? parseCaptureUncertaintyAssessment(JSON.stringify(body), current.sources) : undefined;
  const assessment = classification ?? parseCaptureGroundingAssessment(JSON.stringify(body), current.sources);
  const sourceRuleConclusions = parseSourceRuleConclusions(rawConclusions, current.ruleContracts, current.sources);
  const { evidence, supported, noUnsupportedClaims, scopePreserved, finalDecisionPreserved, priorContentPreserved } = assessment;
  return { assessment: { evidence, supported, noUnsupportedClaims, scopePreserved, finalDecisionPreserved, priorContentPreserved },
    sourceRuleConclusions, ...(classification ? { uncertaintyDisposition: classification.uncertaintyDisposition } : {}) };
}
async function readSourceObservation(userId: string, current: Snapshot, epoch: string): Promise<SourceObservation | undefined> {
  try {
    const row = await readRecallJsonRecord(userId, OBSERVATIONS, `aso-${current.sourceFingerprint.slice(0, 32)}`);
    if (!row || row.schemaVersion !== 1 || row.ruleSemanticsPolicyVersion !== 3 || row.modelCompleted !== true
      || row.fingerprint !== current.sourceFingerprint || row.policyEpoch !== epoch || row.candidateId !== current.candidate.id
      || row.captureId !== current.candidate.captureProvenance!.captureId || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) return undefined;
    const parsed = parseObservationBody(JSON.stringify({ ...row.assessment as object,
      ...(current.unresolvedDigest ? { uncertaintyDisposition: row.uncertaintyDisposition } : {}), sourceRuleConclusions: row.sourceRuleConclusions }), current);
    return { ...row, ...parsed } as SourceObservation;
  } catch { return undefined; }
}
function observationSupported(observation: Pick<SourceObservation, 'assessment' | 'sourceRuleConclusions' | 'uncertaintyDisposition'>, current: Snapshot): boolean {
  const checks = observation.assessment;
  return observation.uncertaintyDisposition !== 'content_unresolved'
    && checks.supported && checks.noUnsupportedClaims && checks.scopePreserved && checks.finalDecisionPreserved && checks.priorContentPreserved
    && deriveFormationRuleRevisions(current.candidate.ontologyFormation, observation.sourceRuleConclusions, current.ruleContext, false).supported;
}
async function verifiedReceipt(userId: string, current: Snapshot, epoch: string): Promise<SupportReceipt | undefined> {
  const receipt = await readRecallJsonRecord(userId, COLLECTION, `ass-${current.fingerprint.slice(0, 32)}`);
  if (!validReceipt(receipt, current, epoch)) return undefined;
  if (current.ruleContracts.length) {
    const source = await readSourceObservation(userId, current, epoch);
    if (!source || !observationSupported(source, current)) return undefined;
  }
  return receipt;
}

/** Model execution is only allowed at the lock-free preflight. Locked promotion
 * boundaries require a matching persisted observation, never a caller boolean. */
export async function ensureNightlySemanticSupport(userId: string, candidate: RecallCandidateRecord,
  epoch: string, options: { cachedOnly?: boolean; signal?: AbortSignal } = {}): Promise<NightlySemanticSupportOutcome> {
  try {
    options.signal?.throwIfAborted();
    const current = await snapshot(userId, candidate, epoch);
    options.signal?.throwIfAborted();
    const id = `ass-${current.fingerprint.slice(0, 32)}`;
    if (await verifiedReceipt(userId, current, epoch)) return 'supported';
    if (options.cachedOnly) return 'unavailable';
    // Serialize duplicate model checks separately from candidate/settings locks.
    const assessmentId = current.ruleContracts.length ? `aso-${current.sourceFingerprint.slice(0, 32)}` : id;
    return await fileEditLock(`${recallJsonRecordPath(userId, COLLECTION, assessmentId)}.assessment`).runExclusive(async () => {
      options.signal?.throwIfAborted();
      if (await verifiedReceipt(userId, current, epoch)) return 'supported';
      const settings = await readRecallCaptureSettings(userId);
      const summaryInstruction = current.unresolvedDigest
        ? '\nAlso independently classify ALL relevantSummaryUnresolved items against this same complete payload, including the entire resulting cognition and A/R plan. Return the usual five boolean checks and literal user evidence, plus uncertaintyDisposition: effect_unverified | outside_claim_scope | source_attribution_only | content_unresolved. The first three mean only unknown effectiveness, facts explicitly outside this claim, or user attribution without independent external validation. Any mixed unresolved identity, source attribution, scope, conflict, final decision or meaning requires content_unresolved; do not erase unknown content or infer permission. The original summary and candidate remain unchanged. A prior extraction classification or autoReview cannot supply this observation; effectiveness and objective external facts are never confirmed here.'
        : '';
      let observation = current.ruleContracts.length ? await readSourceObservation(userId, current, epoch) : undefined;
      if (!observation) {
        const { result } = await runRecallCaptureModel(userId, { sessionId: `one-shot-automatic-support-${id}`,
          budget: { jobId: current.candidate.captureProvenance!.captureId, stage: 'automatic_support' },
          systemPrompt: `${prompts.load(current.unresolvedDigest ? 'cognition_capture_uncertainty' : 'cognition_capture_grounding')}\nFor automatic retention inspect the entire persisted cognition and visible A/T proposal. Proposed R four-field metadata is intentionally hidden at every action/after copy. Reconstruct its expected complete contract from ruleSourceRequests, the same-topic original user text and legitimate confirmed before/pinned meaning; never claim to have checked absent fields. approvedUserSources.approvedQuotes identify value-selected topics, not word-by-word human saving authorization. The same topic's complete source preserves obligations, conditions, exceptions, final corrections, people/projects and permissions; it cannot authorize an independent topic merely sharing a label. Return the usual five body/baseline checks plus sourceRuleConclusions. No lexical-overlap threshold proves meaning. Saving permission and effectiveness are not assessed here.\n${ONTOLOGY_RULE_SEMANTICS}\n${SOURCE_RULE_CONCLUSION_PROTOCOL}\nThis persisted automatic-approval check is read-only: the host only compares and holds an original mismatch; it never repairs a saved proposal.${summaryInstruction}`,
          message: current.message, signal: options.signal, modelCandidates: await resolveRecallCaptureModelCandidates(userId, settings.modelCandidates),
          cliContext: { conversationId: current.conversationId },
          shouldContinue: async () => { const now = await readRecallCaptureSettings(userId); return !options.signal?.aborted && now.enabled && now.autoApproval && now.autoApprovalEpoch === epoch; } });
        options.signal?.throwIfAborted();
        if (result.meta.aborted || result.meta.error) return 'unavailable';
        const parsed = parseObservationBody(result.text, current);
        const refreshed = await snapshot(userId, candidate, epoch);
        options.signal?.throwIfAborted();
        if (refreshed.fingerprint !== current.fingerprint) return 'stale';
        observation = { schemaVersion: 1, ruleSemanticsPolicyVersion: 3, ownerId: userId,
          id: `aso-${current.sourceFingerprint.slice(0, 32)}`, fingerprint: current.sourceFingerprint,
          candidateId: candidate.id, captureId: candidate.captureProvenance!.captureId, policyEpoch: epoch,
          modelCompleted: true, ...parsed, createdAt: new Date().toISOString() };
        // Source conclusions are reusable observations, never grant receipts.
        // Keep quoted evidence out of the existing compact receipt collection.
        if (current.ruleContracts.length) await writeRecallJsonRecord(userId, OBSERVATIONS, observation.id, observation);
      }
      if (!observationSupported(observation, current)) return 'unsupported';
      const assessment = observation.assessment, disposition = observation.uncertaintyDisposition;
      const context = current.context;
      const coordinates = (refs: typeof assessment.evidence) => refs.map(ref => {
        const row = context.find(row => row.label === ref.label)!;
        const start = row.text.indexOf(ref.quote);
        if (start < 0 || row.text.indexOf(ref.quote, start + 1) >= 0) throw new Error('ambiguous automatic support evidence');
        return { messageId: row.messageId, start, end: start + ref.quote.length, quoteHash: hash(ref.quote) };
      });
      const evidence = coordinates(assessment.evidence);
      // Source/permission/epoch/target/body/plan changes during model waiting
      // invalidate the observation before it can authorize any asset write.
      const refreshed = await snapshot(userId, candidate, epoch);
      options.signal?.throwIfAborted();
      if (refreshed.fingerprint !== current.fingerprint) return 'stale';
      const receipt: SupportReceipt = { schemaVersion: 1, ownerId: userId, id, method: 'model_assisted', policyVersion: 1,
        candidateId: candidate.id, captureId: candidate.captureProvenance!.captureId, policyEpoch: epoch,
        fingerprint: current.fingerprint, sourceDigest: current.sourceDigest, summaryDigest: current.summaryDigest,
        ...(current.ontologyRevision !== undefined ? { ontologyRevision: current.ontologyRevision } : {}),
        ...(current.targetVersion !== undefined ? { targetVersion: current.targetVersion } : {}), modelCompleted: true,
        checks: { supported: true, noUnsupportedClaims: true, scopePreserved: true, finalDecisionPreserved: true, priorContentPreserved: true },
        ...(current.ruleContracts.length ? { ruleSemanticsPolicyVersion: 3, sourceObservationId: observation.id,
          ruleChecks: current.ruleContracts.map(rule => ({ recordId: rule.recordId,
          contractDigest: digest(rule),
          checks: { strengthPreserved: true as const, conditionPreserved: true as const, effectPreserved: true as const, exceptionPreserved: true as const },
          evidence: coordinates((observation!.sourceRuleConclusions.find(row => row.recordId === rule.recordId) as Extract<SourceRuleConclusion, { status: 'resolved' }>).topicEvidence) })) } : {}),
        ...(current.unresolvedDigest && disposition && disposition !== 'content_unresolved'
          ? { summaryUncertainty: { disposition, unresolvedDigest: current.unresolvedDigest } } : {}),
        evidence, createdAt: new Date().toISOString() };
      await writeRecallJsonRecord(userId, COLLECTION, id, receipt);
      return 'supported';
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    return (error as { code?: string }).code === 'automatic_support_stale' ? 'stale' : 'unavailable';
  }
}
