import { createLogger } from '../../logger';
import { buildRunner } from '../../model/core-agent/runner';
import { hasConfiguredModel } from '../auth';
import type { SaveKstarReviewInput } from './review-service';
import { reconcileWorldModel } from '../recall/world-model';
import type { WorldModelForecast } from '../recall/world-model-types';
import type { KstarAttribution, KstarEpisodeRecord, KstarOutcome, KstarReviewInferenceMethod, KstarReviewState } from './types';

const log = createLogger('kstar.review-inference');
const MAX_REVIEW_TEXT = 4_000;
const MAX_REASON_TEXT = 2_000;


export interface KstarReviewInferenceResult {
  review: SaveKstarReviewInput;
  reviewState: KstarReviewState;
  inferenceMethod: KstarReviewInferenceMethod;
  needsConfirmation: boolean;
}

export interface KstarReviewInferenceOptions {
  runModel?: (input: { systemPrompt: string; message: string }) => Promise<string>;
  /** Allow closure flows to keep a provisional signal when actual output exists but model review is unavailable. */
  allowProvisionalEvidenceFallback?: boolean;
  /** World-model forecast (A_hat, R_hat) produced at task boundary. When
   *  present, its R_hat replaces the user-goal text as the expected result and
   *  drives the deltaR/deltaA reconciliation. */
  forecast?: WorldModelForecast;
}

interface ParsedModelReview {
  outcome: KstarOutcome;
  attribution: KstarAttribution;
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  reason: string;
  confidence: number;
  needsConfirmation: boolean;
}

function compactText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

function verificationSucceeded(value: unknown): boolean {
  if (value === true) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.passed === true || record.ok === true || record.success === true) return true;
  return ['passed', 'succeeded', 'success', 'ok'].includes(String(record.status || '').toLowerCase());
}

export function buildDeterministicReviewEvidence(episode: KstarEpisodeRecord): {
  expectedResult: string;
  actualResult: string;
} {
  const expectedResult = compactText(episode.t.normalizedTask || episode.t.userGoal, MAX_REVIEW_TEXT)
    || 'Complete the requested task.';
  const parts = [
    `Terminal status: ${episode.r.status}.`,
    compactText(episode.r.finalText, 2_000),
    episode.r.producedFiles.length
      ? `Produced files: ${episode.r.producedFiles.slice(0, 20).join(', ')}.`
      : undefined,
    episode.r.verification !== undefined
      ? `Verification recorded: ${compactText(JSON.stringify(episode.r.verification), 1_000) || 'yes'}.`
      : undefined,
    episode.r.failureCode ? `Failure code: ${compactText(episode.r.failureCode, 160)}.` : undefined,
    episode.r.failureKind ? `Failure kind: ${compactText(episode.r.failureKind, 160)}.` : undefined,
  ].filter((part): part is string => Boolean(part));
  return {
    expectedResult,
    actualResult: parts.join(' ').slice(0, MAX_REVIEW_TEXT),
  };
}

function reviewBase(episode: KstarEpisodeRecord, forecast?: WorldModelForecast): Pick<SaveKstarReviewInput, 'expectedResult' | 'actualResult' | 'evidenceRefs'> {
  const evidence = buildDeterministicReviewEvidence(episode);
  // Prefer the world-model predicted result when available; otherwise fall
  // back to the task text (graceful degradation without a forecast).
  const expectedResult = forecast?.rHat.summary?.trim()
    ? forecast.rHat.summary
    : evidence.expectedResult;
  return { ...evidence, expectedResult, evidenceRefs: episode.evidenceRefs };
}

function unknownInference(episode: KstarEpisodeRecord): KstarReviewInferenceResult {
  return {
    review: {
      ...reviewBase(episode),
      deltaR: 'unknown',
      deltaA: 'unknown',
      outcome: 'unclear',
      attribution: 'unclear',
      reason: 'The recorded evidence is insufficient to compare the expected and actual result.',
      confidence: 0,
    },
    reviewState: 'needs_confirmation',
    inferenceMethod: 'unknown',
    needsConfirmation: true,
  };
}

function parseDelta(value: unknown, field: string): number | 'unknown' {
  if (value === 'unknown') return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export function parseKstarReviewInference(text: string): ParsedModelReview {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) throw new Error('model output is not strict JSON');
  const value = JSON.parse(trimmed) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model output must be an object');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['outcome', 'attribution', 'deltaR', 'deltaA', 'reason', 'confidence', 'needsConfirmation']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error('model output contains unknown fields');
  const outcomes: KstarOutcome[] = ['better_than_expected', 'met_expected', 'worse_than_expected', 'unclear'];
  const attributions: KstarAttribution[] = ['knowledge_gap', 'rule_gap', 'template_gap', 'skill_gap', 'execution_gap', 'unclear'];
  if (!outcomes.includes(record.outcome as KstarOutcome)) throw new Error('invalid outcome');
  if (!attributions.includes(record.attribution as KstarAttribution)) throw new Error('invalid attribution');
  const reason = compactText(record.reason, MAX_REASON_TEXT);
  if (!reason) throw new Error('missing reason');
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
    throw new Error('invalid confidence');
  }
  if (typeof record.needsConfirmation !== 'boolean') throw new Error('invalid needsConfirmation');
  return {
    outcome: record.outcome as KstarOutcome,
    attribution: record.attribution as KstarAttribution,
    deltaR: parseDelta(record.deltaR, 'deltaR'),
    deltaA: parseDelta(record.deltaA, 'deltaA'),
    reason,
    confidence: record.confidence,
    needsConfirmation: record.needsConfirmation,
  };
}

function inferenceSystemPrompt(): string {
  return [
    'Compare one task expectation with recorded execution evidence.',
    'Return exactly one JSON object and no markdown.',
    'Schema: {"outcome":"better_than_expected|met_expected|worse_than_expected|unclear","attribution":"knowledge_gap|rule_gap|template_gap|skill_gap|execution_gap|unclear","deltaR":number_or_unknown,"deltaA":number_or_unknown,"reason":"evidence-grounded summary","confidence":0_to_1,"needsConfirmation":boolean}.',
    'Numbers must be between -1 and 1. Use "unknown" when the evidence cannot support a value.',
    'Do not invent tests, files, feedback, or external outcomes. Mark needsConfirmation=true for subjective or ambiguous success.',
  ].join('\n');
}

async function defaultRunModel(userId: string, episode: KstarEpisodeRecord): Promise<string> {
  if (!hasConfiguredModel().configured) throw new Error('review model is not configured');
  const { runner } = await buildRunner({
    sessionId: `kstar-review-${episode.id}`,
    userId,
    systemPrompt: inferenceSystemPrompt(),
    disableTools: true,
    ephemeralSession: true,
    skillList: [],
  });
  const result = await runner.run({
    message: JSON.stringify({ evidence: buildDeterministicReviewEvidence(episode), episode: {
      status: episode.r.status,
      toolCalls: episode.a.toolCalls.map((call) => ({ name: call.name, status: call.status })),
      producedFiles: episode.r.producedFiles.slice(0, 20),
      verification: episode.r.verification,
    } }),
    thinkingLevel: 'off',
    cacheRetention: 'none',
  });
  if (result.meta.aborted || result.meta.error) throw new Error('review model unavailable');
  return result.text;
}

export async function inferKstarReview(
  userId: string,
  episode: KstarEpisodeRecord,
  options: KstarReviewInferenceOptions = {},
): Promise<KstarReviewInferenceResult> {
  if (episode.ownerId !== userId) throw new Error('kstar episode owner mismatch');
  const forecast = options.forecast;
  const base = reviewBase(episode, forecast);
  if (forecast && episode.r.status === 'completed') {
    // World-model reconciliation: deltaA gates deltaR. Use the forecast's
    // predicted result as the true R_hat instead of the user-goal text.
    const reconciled = reconcileWorldModel(forecast, episode);
    return {
      review: {
        ...base,
        deltaR: reconciled.deltaR,
        deltaA: reconciled.deltaA,
        outcome: reconciled.attribution === 'execution_gap'
          ? 'worse_than_expected'
          : reconciled.deltaR === 0 ? 'met_expected' : reconciled.deltaR === 'unknown' ? 'unclear' : 'worse_than_expected',
        attribution: reconciled.attribution,
        reason: reconciled.attribution === 'execution_gap'
          ? 'The realized intervention differs from the forecast; result delta is polluted by an execution gap.'
          : reconciled.deltaR === 0
            ? 'The forecast result matched the realized result.'
            : 'The forecast result differed from the realized result.',
        confidence: reconciled.deltaA === 'unknown' && reconciled.deltaR === 'unknown' ? 0.5 : 0.9,
      },
      reviewState: 'inferred',
      inferenceMethod: 'deterministic',
      needsConfirmation: false,
    };
  }
  if (episode.r.status === 'failed' || episode.r.status === 'cancelled') {
    return {
      review: {
        ...base,
        deltaR: -1,
        deltaA: 'unknown',
        outcome: 'worse_than_expected',
        attribution: 'execution_gap',
        reason: `The task ended with terminal status ${episode.r.status}${episode.r.failureCode ? ` (${episode.r.failureCode})` : ''}.`,
        confidence: 0.95,
      },
      reviewState: 'inferred',
      inferenceMethod: 'deterministic',
      needsConfirmation: false,
    };
  }
  if (episode.r.status === 'completed' && verificationSucceeded(episode.r.verification)) {
    return {
      review: {
        ...base,
        deltaR: 0,
        deltaA: 0,
        outcome: 'met_expected',
        attribution: 'unclear',
        reason: 'The task completed with recorded verification evidence.',
        confidence: 0.95,
      },
      reviewState: 'inferred',
      inferenceMethod: 'deterministic',
      needsConfirmation: false,
    };
  }
  if (episode.r.status !== 'completed') return unknownInference(episode);

  // No model configured: report an honest 'unknown' review instead of
  // fabricating a provisional met_expected learning signal.
  if (!options.runModel && !hasConfiguredModel().configured) {
    return unknownInference(episode);
  }

  try {
    const text = options.runModel
      ? await options.runModel({ systemPrompt: inferenceSystemPrompt(), message: JSON.stringify(buildDeterministicReviewEvidence(episode)) })
      : await defaultRunModel(userId, episode);
    const parsed = parseKstarReviewInference(text);
    const needsConfirmation = parsed.needsConfirmation || parsed.confidence < 0.7;
    return {
      review: { ...base, ...parsed, evidenceRefs: episode.evidenceRefs },
      reviewState: needsConfirmation ? 'needs_confirmation' : 'inferred',
      inferenceMethod: 'model',
      needsConfirmation,
    };
  } catch (error) {
    log.warn('kstar review inference degraded', { userId, episodeId: episode.id, errorCode: 'review_inference_unavailable' });
    if (options.allowProvisionalEvidenceFallback && (episode.r.finalText?.trim() || episode.r.producedFiles.length)) {
      return {
        review: {
          ...base,
          deltaR: 0,
          deltaA: 'unknown',
          outcome: 'met_expected',
          attribution: 'unclear',
          reason: `The task completed with recorded output; actual result: ${base.actualResult || 'recorded output'}. This is a provisional R̂/R match pending user confirmation.`,
          confidence: 0.6,
        },
        reviewState: 'needs_confirmation',
        inferenceMethod: 'deterministic',
        needsConfirmation: true,
      };
    }
    return unknownInference(episode);
  }
}
