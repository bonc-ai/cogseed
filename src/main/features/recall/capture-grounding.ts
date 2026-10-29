/** Semantic fallback for supported paraphrases and merged revisions. Lexical
 * similarity is a shortlist, not proof that a new statement is unsupported. */
import { runRecallCaptureModel } from './capture-model-routing';
import type { CaptureModelBudgetContext } from './capture-model-budget';
import { prompts } from '../../prompts/loader';
import { createLogger } from '../../logger';
import type { RecallCaptureModelCandidate } from './capture-settings';

const log = createLogger('recall.grounding');

export type CaptureGroundingUnavailableReason = 'model_unavailable' | 'assessment_invalid' | 'context_too_large';
export class CaptureGroundingUnavailableError extends Error {
  readonly code = 'capture_grounding_unavailable';
  constructor(readonly reason: CaptureGroundingUnavailableReason) {
    super(`candidate source support could not be evaluated: ${reason}`);
    this.name = 'CaptureGroundingUnavailableError';
  }
}
function interrupted(): never { throw Object.assign(new Error('candidate support check interrupted'), { code: 'ABORT_ERR' }); }

export interface GroundingSource { label: string; text: string; approvedQuotes?: string[] }
export interface GroundingCandidate {
  judgment: string; value: string; suggestedScope: string; suggestedAction?: string; targetAssetId?: string;
  uncertainty?: string; applicableWhen?: string[]; forbiddenWhen?: string[]; ontologyChanges?: unknown;
}
export interface CaptureGroundingAssessment {
  supported: boolean; noUnsupportedClaims: boolean; scopePreserved: boolean;
  finalDecisionPreserved: boolean; priorContentPreserved: boolean;
  evidence: Array<{ label: string; quote: string }>;
}

/** Accept one explicitly delimited JSON payload plus plain explanatory prose.
 * Multiple payloads or additional structured data are ambiguous and rejected;
 * surrounding prose never becomes a field, evidence or an instruction. */
export function parseCaptureAssessmentJson(raw: string): unknown {
  const text = raw.trim();
  if (!text.startsWith('```')) return JSON.parse(text);
  const framed = /^```(?:json)?\s*([\s\S]*?)```\s*([\s\S]*)$/i.exec(text);
  if (!framed || /[{}\[\]`]/.test(framed[2])) throw new Error('ambiguous assessment framing');
  return JSON.parse(framed[1].trim());
}

export function parseCaptureGroundingAssessment(raw: string, sources: GroundingSource[]): CaptureGroundingAssessment {
  if (typeof raw !== 'string' || raw.length > 12_000) throw new Error('invalid grounding response');
  const parsed: unknown = parseCaptureAssessmentJson(raw);
  const fields = ['supported', 'noUnsupportedClaims', 'scopePreserved', 'finalDecisionPreserved', 'priorContentPreserved', 'evidence'];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).some(k => !fields.includes(k))) throw new Error('invalid grounding fields');
  const result = parsed as CaptureGroundingAssessment;
  if (fields.slice(0, 5).some(k => typeof (result as unknown as Record<string, unknown>)[k] !== 'boolean')
    || !Array.isArray(result.evidence) || result.evidence.length > 32) throw new Error('invalid grounding checks');
  if (!Array.isArray(sources) || sources.some(source => !source || typeof source.label !== 'string' || !source.label.trim()
    || typeof source.text !== 'string') || new Set(sources.map(source => source.label)).size !== sources.length) {
    throw new Error('ambiguous grounding sources');
  }
  // A reference selects an existing approved literal. It never repairs an
  // inaccurate quote or creates another source/approval identity.
  const evidence = result.evidence.map(value => {
    const ref = value as unknown as Record<string, unknown>;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)
      || Object.keys(ref).some(key => !['label', 'quote', 'approvedQuoteIndex'].includes(key))
      || typeof ref.label !== 'string') throw new Error('invalid grounding evidence');
    const source = sources.find(source => source.label === ref.label);
    const hasQuote = Object.hasOwn(ref, 'quote'), hasIndex = Object.hasOwn(ref, 'approvedQuoteIndex');
    if (!source || !hasQuote && !hasIndex) throw new Error('grounding evidence is not in approved user source');
    let quote: unknown = ref.quote;
    if (hasIndex) {
      if (!Number.isSafeInteger(ref.approvedQuoteIndex) || (ref.approvedQuoteIndex as number) < 0
        || !Array.isArray(source.approvedQuotes)) throw new Error('invalid approved quote reference');
      const selected = source.approvedQuotes[ref.approvedQuoteIndex as number];
      if (hasQuote && ref.quote !== selected) throw new Error('approved quote reference conflicts with literal');
      quote = selected;
    }
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 1000 || !source.text.includes(quote)) {
      throw new Error('grounding evidence is not in approved user source');
    }
    return { label: ref.label, quote };
  });
  result.evidence = evidence;
  if (result.supported && (!result.evidence.length || !result.evidence.some(ref => sources.some(source => source.label === ref.label
    && (source.approvedQuotes || [source.text]).some(quote => ref.quote.includes(quote) || quote.includes(ref.quote)))))) {
    throw new Error('supported grounding needs approved topic evidence');
  }
  return result;
}

export async function semanticallyGroundCaptureCandidate(userId: string, input: {
  sessionId: string; candidate: GroundingCandidate; sources: GroundingSource[];
  summary: unknown; existingTarget?: { id: string; statement: string; scope: string; version: string };
  modelCandidates: readonly RecallCaptureModelCandidate[]; signal?: AbortSignal; shouldContinue?: () => Promise<boolean>;
  budget?: CaptureModelBudgetContext;
}): Promise<boolean> {
  if (!input.sources.length || input.candidate.uncertainty?.trim()) return false;
  if (input.candidate.targetAssetId && input.existingTarget?.id !== input.candidate.targetAssetId) return false;
  const message = JSON.stringify({ candidate: input.candidate, approvedUserSources: input.sources,
    summary: input.summary, existingTarget: input.existingTarget });
  if (message.length > 96_000) throw new CaptureGroundingUnavailableError('context_too_large');
  if (input.signal?.aborted) interrupted();
  let text: string;
  try {
    const { result } = await runRecallCaptureModel(userId, { sessionId: input.sessionId,
      systemPrompt: prompts.load('cognition_capture_grounding'), message,
      modelCandidates: input.modelCandidates, signal: input.signal, shouldContinue: input.shouldContinue, budget: input.budget });
    if (result.meta.aborted || input.signal?.aborted) interrupted();
    if (result.meta.error) throw new CaptureGroundingUnavailableError('model_unavailable');
    text = result.text;
  } catch (error) {
    if (input.signal?.aborted || (error as { code?: string })?.code === 'ABORT_ERR') interrupted();
    throw error instanceof CaptureGroundingUnavailableError ? error : new CaptureGroundingUnavailableError('model_unavailable');
  }
  let check: CaptureGroundingAssessment;
  try { check = parseCaptureGroundingAssessment(text, input.sources); }
  catch (error) {
    // Never log source text or quotes; labels and object keys are enough to
    // distinguish a malformed shape from an unsupported evidence reference.
    let shape: unknown;
    try {
      const parsed = parseCaptureAssessmentJson(text) as Record<string, unknown> | null;
      const evidence = Array.isArray(parsed?.evidence) ? parsed.evidence : [];
      shape = {
        keys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : typeof parsed,
        evidenceLabels: evidence.map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>).label : undefined)),
        evidenceKeys: evidence.map(item => (item && typeof item === 'object' && !Array.isArray(item) ? Object.keys(item) : typeof item)),
      };
    } catch { /* the raw text was not a single framed JSON object */ }
    log.warn('grounding assessment invalid', {
      error: error instanceof Error ? error.message : 'unknown',
      shape,
      sourceLabels: input.sources.map(source => source.label),
    });
    throw new CaptureGroundingUnavailableError('assessment_invalid');
  }
  return check.supported && check.noUnsupportedClaims && check.scopePreserved
    && check.finalDecisionPreserved && check.priorContentPreserved;
}
