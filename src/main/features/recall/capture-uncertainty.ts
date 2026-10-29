/** Separates unknown effectiveness or excluded facts from unknown content.
 * An independent model observes the original complete proposal; it cannot
 * rewrite it, authorize storage, confirm objective facts or prove effectiveness. */
import { createHash } from 'node:crypto';
import { parseCaptureAssessmentJson, parseCaptureGroundingAssessment, type CaptureGroundingAssessment, type GroundingCandidate, type GroundingSource } from './capture-grounding';

export type CaptureUncertaintyDisposition = 'effect_unverified' | 'outside_claim_scope' | 'source_attribution_only' | 'content_unresolved';
export interface CaptureUncertaintyContextMessage { label: string; id?: string; role: 'user' | 'assistant'; text: string; timestamp?: string }
export interface CaptureUncertaintyAssessment {
  method: 'model_assisted'; modelCompleted: boolean; nonBlocking: boolean;
  /** Host interruption metadata, never supplied by the checking model. */
  interrupted?: true;
  uncertaintyDisposition: CaptureUncertaintyDisposition;
  checks: Omit<CaptureGroundingAssessment, 'evidence'>;
  candidateHash?: string; sourceHash?: string; summaryHash?: string; targetHash?: string; inputHash?: string;
  evidence: Array<{ label: string; messageId?: string; start: number; end: number; quoteHash: string }>;
  reason?: 'uncertainty_missing' | 'uncertainty_context_unavailable' | 'uncertainty_context_too_large'
    | 'uncertainty_target_unavailable' | 'uncertainty_model_unavailable' | 'uncertainty_assessment_invalid'
    | 'uncertainty_content_unresolved' | 'uncertainty_semantic_support_failed';
}
const DISPOSITIONS = new Set<CaptureUncertaintyDisposition>(['effect_unverified', 'outside_claim_scope', 'source_attribution_only', 'content_unresolved']);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const digest = (value: unknown) => hash(JSON.stringify(canonical(value)));
type UncertaintyObservationInput = {
  candidate: GroundingCandidate; sources: GroundingSource[];
  contextMessages: CaptureUncertaintyContextMessage[]; summary: unknown;
  existingTarget?: { id: string; statement: string; scope: string; version: string };
};
const blockedAssessment = (): CaptureUncertaintyAssessment => ({ method: 'model_assisted', modelCompleted: false, nonBlocking: false,
  uncertaintyDisposition: 'content_unresolved', checks: { supported: false, noUnsupportedClaims: false,
    scopePreserved: false, finalDecisionPreserved: false, priorContentPreserved: false }, evidence: [] });
function uncertaintySnapshot(input: UncertaintyObservationInput) {
  const original = { candidate: input.candidate, approvedUserSources: input.sources,
    completeConversationContext: input.contextMessages, summary: input.summary, existingTarget: input.existingTarget };
  const message = JSON.stringify(original);
  const payload = JSON.parse(message) as typeof original;
  const held: CaptureUncertaintyAssessment = { ...blockedAssessment(), candidateHash: digest(payload.candidate),
    sourceHash: digest({ sources: payload.approvedUserSources, context: payload.completeConversationContext }), summaryHash: digest(payload.summary),
    ...(payload.existingTarget ? { targetHash: digest(payload.existingTarget) } : {}), inputHash: digest({ policyVersion: 1, payload }) };
  return { message, payload, held };
}
function completedObservation(payload: ReturnType<typeof uncertaintySnapshot>['payload'],
  parsed: ReturnType<typeof parseCaptureUncertaintyAssessment>, held: CaptureUncertaintyAssessment): CaptureUncertaintyAssessment {
  const { evidence: literalEvidence, uncertaintyDisposition, ...checks } = parsed;
  const evidence: CaptureUncertaintyAssessment['evidence'] = [];
  for (const ref of literalEvidence) {
    const row = payload.completeConversationContext.find(row => row.label === ref.label && row.role === 'user');
    const start = row?.text.indexOf(ref.quote) ?? -1;
    if (!row || start < 0 || row.text.indexOf(ref.quote, start + 1) >= 0) return { ...held, reason: 'uncertainty_assessment_invalid' };
    evidence.push({ label: ref.label, ...(row.id ? { messageId: row.id } : {}), start, end: start + ref.quote.length, quoteHash: hash(ref.quote) });
  }
  const nonBlocking = uncertaintyDisposition !== 'content_unresolved' && Object.values(checks).every(value => value === true) && evidence.length > 0;
  return { ...held, modelCompleted: true, nonBlocking, uncertaintyDisposition, checks, evidence,
    ...(!nonBlocking ? { reason: uncertaintyDisposition === 'content_unresolved'
      ? 'uncertainty_content_unresolved' as const : 'uncertainty_semantic_support_failed' as const } : {}) };
}

/** Strict classifications never substitute for independently checked meaning.
 * Literal evidence must resolve in a USER source and overlap an approved topic. */
export function parseCaptureUncertaintyAssessment(raw: string, sources: GroundingSource[]): CaptureGroundingAssessment & { uncertaintyDisposition: CaptureUncertaintyDisposition } {
  if (typeof raw !== 'string' || raw.length > 12_000) throw new Error('invalid uncertainty assessment size');
  const parsed: unknown = parseCaptureAssessmentJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid uncertainty assessment');
  const { uncertaintyDisposition, ...checks } = parsed as Record<string, unknown>;
  if (!DISPOSITIONS.has(uncertaintyDisposition as CaptureUncertaintyDisposition)) throw new Error('invalid uncertainty disposition');
  const assessment = parseCaptureGroundingAssessment(JSON.stringify(checks), sources);
  if (assessment.supported && !assessment.evidence.some(ref => sources.some(source => source.label === ref.label
    && source.approvedQuotes?.some(quote => quote.includes(ref.quote) || ref.quote.includes(quote))))) {
    throw new Error('uncertainty assessment requires approved topic evidence');
  }
  return { ...assessment, uncertaintyDisposition: uncertaintyDisposition as CaptureUncertaintyDisposition };
}

/** Reuse the merged batch's independent verdict without another model call.
 * The audit binds the original proposal and exact evidence; `none` cannot clear
 * a nonempty uncertainty, and ambiguous evidence offsets remain unavailable. */
export function observeCaptureBatchUncertainty(input: UncertaintyObservationInput,
  assessment?: { checks: CaptureGroundingAssessment; uncertaintyDisposition: string },
  unavailableReason?: CaptureUncertaintyAssessment['reason']): CaptureUncertaintyAssessment {
  const { payload, held } = uncertaintySnapshot(input);
  if (!assessment) return { ...held, reason: unavailableReason || 'uncertainty_assessment_invalid' };
  try {
    const parsed = parseCaptureUncertaintyAssessment(JSON.stringify({ ...assessment.checks,
      uncertaintyDisposition: assessment.uncertaintyDisposition }), payload.approvedUserSources);
    return completedObservation(payload, parsed, held);
  } catch { return { ...held, reason: 'uncertainty_assessment_invalid' }; }
}
