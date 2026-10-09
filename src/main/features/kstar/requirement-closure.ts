import { nowIso, safeId } from '../../storage';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { readKstarEpisode } from './episode-store';
import { inferKstarReview, type KstarReviewInferenceResult } from './review-inference';
import { readWorldModelForecast } from '../recall/world-model';
import { readKstarRequirement, replaceKstarRequirement } from './requirement-store';
import type { KstarOutcome } from './types';
import {
  KSTAR_PRM_WEIGHTS,
  type KstarAfterActionReview,
  type KstarPrmScores,
  type KstarRequirementPrmReview,
  type KstarRequirementRecord,
} from './requirement-types';

export interface CloseKstarRequirementInput {
  requirementId: string;
  userFeedback?: { verdict: 'met' | 'partial' | 'not_met' | 'skip'; text?: string };
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) throw new Error('invalid kstar prm score');
  return Math.max(0, Math.min(1, value));
}

export function computeKstarPrmWeightedScore(scores: KstarPrmScores): number {
  const weighted = clampScore(scores.accuracy) * KSTAR_PRM_WEIGHTS.accuracy
    + clampScore(scores.completeness) * KSTAR_PRM_WEIGHTS.completeness
    + clampScore(scores.usefulness) * KSTAR_PRM_WEIGHTS.usefulness
    + clampScore(scores.clarity) * KSTAR_PRM_WEIGHTS.clarity;
  return Math.max(0, Math.min(1, Number(weighted.toFixed(4))));
}

export function hasRequirementLearningSignal(review: KstarRequirementPrmReview): boolean {
  return review.deltaR !== 'unknown'
    || review.deltaA !== 'unknown'
    || review.outcome === 'better_than_expected'
    || review.outcome === 'worse_than_expected'
    || (review.confidence >= 0.7 && review.attribution !== 'unclear' && review.reason.trim().length > 0);
}

function compactFeedbackText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 2_000) : undefined;
}

function evidenceRefs(requirement: KstarRequirementRecord) {
  return normalizeCognitionSourceRefs([
    { kind: 'conversation' as const, id: requirement.conversationId, title: requirement.title },
    ...requirement.userMessageIds.map((id) => ({ kind: 'conversation' as const, id })),
    ...requirement.episodeIds.map((id) => ({ kind: 'execution' as const, id, title: 'KSTAR requirement episode' })),
  ]);
}

function scoresForOutcome(outcome: KstarOutcome): KstarPrmScores {
  if (outcome === 'met_expected' || outcome === 'better_than_expected') {
    return { accuracy: 1, completeness: 1, usefulness: 1, clarity: 1 };
  }
  if (outcome === 'worse_than_expected') {
    return { accuracy: 0, completeness: 0, usefulness: 0, clarity: 0.5 };
  }
  return { accuracy: 0.5, completeness: 0.5, usefulness: 0.5, clarity: 0.5 };
}

function prmFromInferredReview(requirement: KstarRequirementRecord, result: KstarReviewInferenceResult): KstarRequirementPrmReview {
  const review = result.review;
  const scores = scoresForOutcome(review.outcome);
  return {
    ...(review.expectedResult ? { expectedResult: review.expectedResult } : {}),
    ...(review.actualResult ? { actualResult: review.actualResult } : {}),
    scores,
    weightedScore: computeKstarPrmWeightedScore(scores),
    deltaR: review.deltaR,
    deltaA: review.deltaA,
    outcome: review.outcome,
    attribution: review.attribution,
    reason: review.reason,
    confidence: review.confidence,
    ...(review.actionDelta ? { actionDelta: review.actionDelta } : {}),
    ...(review.resultDelta ? { resultDelta: review.resultDelta } : {}),
    evidenceRefs: normalizeCognitionSourceRefs(review.evidenceRefs),
  };
}

async function latestRequirementEpisode(userId: string, requirement: KstarRequirementRecord) {
  const episodes = await Promise.all(requirement.episodeIds.map((episodeId) => readKstarEpisode(userId, episodeId)));
  return episodes
    .filter((episode): episode is NonNullable<typeof episode> => Boolean(episode))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1);
}

async function prmFromCompletionEvidence(userId: string, requirement: KstarRequirementRecord): Promise<KstarRequirementPrmReview | null> {
  const episode = await latestRequirementEpisode(userId, requirement);
  if (!episode) return null;
  const forecast = requirement.forecastId
    ? await readWorldModelForecast(userId, requirement.forecastId)
    : undefined;
  const inferred = await inferKstarReview(userId, episode, {
    allowProvisionalEvidenceFallback: true,
    ...(forecast ? {
      forecast: forecast.forecast,
      selectedAssetTypes: (forecast.input.k.abilityAssets || []).map((asset) => asset.type),
    } : {}),
  });
  if (inferred.review.deltaR === 'unknown' && inferred.review.deltaA === 'unknown') return null;
  return prmFromInferredReview(requirement, inferred);
}

function prmFromFeedback(requirement: KstarRequirementRecord, input: CloseKstarRequirementInput): KstarRequirementPrmReview {
  const verdict = input.userFeedback?.verdict || 'skip';
  const feedback = compactFeedbackText(input.userFeedback?.text);
  const refs = evidenceRefs(requirement);
  const expectedResult = requirement.rHat?.summary || requirement.goalText;
  if (verdict === 'met') {
    const scores = { accuracy: 1, completeness: 1, usefulness: 1, clarity: 1 };
    return {
      expectedResult,
      actualResult: feedback || 'The user confirmed that the requirement met the expected result.',
      scores,
      weightedScore: computeKstarPrmWeightedScore(scores),
      deltaR: 0,
      deltaA: 0,
      outcome: 'met_expected',
      attribution: 'unclear',
      reason: feedback || 'The user confirmed that the requirement met the expected result.',
      confidence: 1,
      evidenceRefs: refs,
    };
  }
  if (verdict === 'partial') {
    const scores = { accuracy: 0.8, completeness: 0.5, usefulness: 0.8, clarity: 0.8 };
    return {
      expectedResult,
      actualResult: feedback || 'The user confirmed that the requirement was only partially satisfied.',
      scores,
      weightedScore: computeKstarPrmWeightedScore(scores),
      deltaR: -0.5,
      deltaA: 'unknown',
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: feedback || 'The user confirmed that the requirement was only partially satisfied.',
      confidence: 1,
      evidenceRefs: refs,
    };
  }
  if (verdict === 'not_met') {
    const scores = { accuracy: 0, completeness: 0, usefulness: 0, clarity: 0.5 };
    return {
      expectedResult,
      actualResult: feedback || 'The user confirmed that the requirement did not meet the expected result.',
      scores,
      weightedScore: computeKstarPrmWeightedScore(scores),
      deltaR: -1,
      deltaA: 'unknown',
      outcome: 'worse_than_expected',
      attribution: 'execution_gap',
      reason: feedback || 'The user confirmed that the requirement did not meet the expected result.',
      confidence: 1,
      evidenceRefs: refs,
    };
  }
  const scores = { accuracy: 0.5, completeness: 0.5, usefulness: 0.5, clarity: 0.5 };
  return {
    expectedResult,
    ...(feedback ? { actualResult: feedback } : {}),
    scores,
    weightedScore: computeKstarPrmWeightedScore(scores),
    deltaR: 'unknown',
    deltaA: 'unknown',
    outcome: 'unclear',
    attribution: 'unclear',
    reason: feedback || 'No explicit reusable requirement outcome was confirmed.',
    confidence: 0,
    evidenceRefs: refs,
  };
}

function aarFromReview(review: KstarRequirementPrmReview): KstarAfterActionReview {
  if (hasRequirementLearningSignal(review)) {
    return {
      keep: review.outcome === 'met_expected' ? [review.reason] : [],
      change: review.outcome === 'worse_than_expected' ? [review.reason] : [],
      lesson: review.reason,
      candidateSeed: review.reason,
      evidenceRefs: review.evidenceRefs,
    };
  }
  return {
    keep: [],
    change: [],
    lesson: 'No explicit reusable lesson was confirmed for this requirement.',
    evidenceRefs: review.evidenceRefs,
  };
}

export async function closeKstarRequirement(
  userId: string,
  input: CloseKstarRequirementInput,
): Promise<KstarRequirementRecord> {
  if (!safeId(input.requirementId)) throw new Error('invalid kstar requirement id');
  const requirement = await readKstarRequirement(userId, input.requirementId);
  if (!requirement) throw new Error('kstar requirement not found');
  if (
    requirement.status === 'closed'
    && requirement.prmReview
    && requirement.aar
    && hasRequirementLearningSignal(requirement.prmReview)
  ) return requirement;
  const prmReview = input.userFeedback
    ? prmFromFeedback(requirement, input)
    : (await prmFromCompletionEvidence(userId, requirement)) || prmFromFeedback(requirement, input);
  const closed: KstarRequirementRecord = {
    ...requirement,
    status: 'closed',
    prmReview,
    aar: aarFromReview(prmReview),
    closedAt: requirement.closedAt || nowIso(),
    updatedAt: nowIso(),
  };
  return replaceKstarRequirement(userId, closed);
}
