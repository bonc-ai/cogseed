import { normalizeCognitionSourceRefs } from '../recall/source-service';
import type { KstarCandidateProposal, KstarEpisodeRecord, KstarReviewRecord } from './types';

export function scopeForTask(task: string): string {
  // Short ASCII tags by design (retrieval matches scope tokens whole-word /
  // bidirectional + cross-language aliases); CJK keywords keep Chinese tasks
  // out of the weak 'general' fallback.
  if (/report|summary|document|file|报告|总结|文档|文件/i.test(task)) return 'report';
  if (/code|function|bug|test|代码|函数|缺陷|测试/i.test(task)) return 'code';
  if (/review|audit|审查|审计|检查|评审/i.test(task)) return 'review';
  if (/product|decision|architecture|产品|决策|架构/i.test(task)) return 'product';
  return 'general';
}

export function gapType(review: KstarReviewRecord): KstarCandidateProposal['suggestedType'] | null {
  if (review.attribution === 'knowledge_gap') return 'personal';
  if (review.attribution === 'rule_gap') return 'rule';
  if (review.attribution === 'template_gap') return 'template';
  if (review.attribution === 'skill_gap') return 'skill_method';
  return null;
}

/** Minimum |ΔR| for precipitation (learning-reflex gate). Tiny deltas are
 *  measurement noise, not lessons: only evidence that actually moved the
 *  result by at least this much becomes a reusable rule. */
export const MIN_PRECIPITATION_DELTA_R = 0.15;

export function hasLearningSignal(review: KstarReviewRecord): boolean {
  return review.deltaR !== 'unknown'
    || review.deltaA !== 'unknown'
    || review.outcome === 'better_than_expected'
    || review.outcome === 'worse_than_expected'
    || (review.confidence >= 0.7 && review.attribution !== 'unclear' && !!review.reason.trim());
}

/** Evidence gate for precipitation (learning-reflex): a review precipitates
 *  only when it carries a NON-TRIVIAL lesson —
 *   1. a numeric ΔR/ΔA at or above MIN_PRECIPITATION_DELTA_R (measured
 *      deviation), or
 *   2. an explicit better/worse-than-expected outcome (deviated by
 *      definition, numeric delta may be unknown), or
 *   3. a high-confidence review that names a concrete gap (knowledge/rule/
 *      template/skill gap with a reason) — a gap lesson is a signal even
 *      when the numeric delta is tiny.
 *  "Met expected" with a ~0 delta is NO lesson (the world behaved as
 *  predicted) and does not precipitate — that is the noise gate. */
export function clearsPrecipitationGate(review: KstarReviewRecord): boolean {
  if (!hasLearningSignal(review)) return false;
  const numericDeltaR = typeof review.deltaR === 'number' && Number.isFinite(review.deltaR) ? review.deltaR : 0;
  const numericDeltaA = typeof review.deltaA === 'number' && Number.isFinite(review.deltaA) ? review.deltaA : 0;
  if (Math.abs(numericDeltaR) >= MIN_PRECIPITATION_DELTA_R || Math.abs(numericDeltaA) >= MIN_PRECIPITATION_DELTA_R) {
    return true;
  }
  if (review.outcome === 'better_than_expected' || review.outcome === 'worse_than_expected') return true;
  // Numeric deltas are in the noise band — a lesson survives only if it
  // names a concrete gap with a reason.
  return gapType(review) !== null && review.reason.trim().length > 0;
}

export function learningSignal(review: KstarReviewRecord): KstarCandidateProposal['learningSignal'] {
  return {
    ...(review.expectedResult ? { expectedResult: review.expectedResult } : {}),
    ...(review.actualResult ? { actualResult: review.actualResult } : {}),
    deltaR: review.deltaR,
    deltaA: review.deltaA,
    outcome: review.outcome,
    confidence: review.confidence,
    source: 'review',
  };
}

export function proposeKstarCandidates(
  episode: KstarEpisodeRecord,
  review: KstarReviewRecord,
): KstarCandidateProposal[] {
  const sourceRefs = normalizeCognitionSourceRefs([
    { kind: 'execution', id: episode.id, title: 'KSTAR episode' },
    ...episode.evidenceRefs.filter((ref) => ref.kind !== 'execution'),
  ]);
  const proposals: KstarCandidateProposal[] = [];
  const distinctTools = [...new Set(episode.a.toolCalls.map((call) => call.name).filter(Boolean))];
  const verifiedWorkflow = episode.r.status === 'completed' &&
    distinctTools.length >= 2 &&
    episode.a.toolCalls.every((call) => call.status === 'ok');

  const signalAvailable = clearsPrecipitationGate(review);
  if (verifiedWorkflow && signalAvailable) {
    proposals.push({
      // A model-reasoned lesson (cause + reusable guidance) wins over the
      // fixed workflow template — the difference IS the lesson.
      judgment: review.lesson?.trim()
        ? review.lesson
        : `For tasks like "${episode.t.userGoal}", use the verified workflow: ${distinctTools.join(' → ')}.`,
      summary: review.lesson?.trim() ? 'Reusable workflow lesson' : 'Verified multi-tool workflow',
      uncertainty: 'Generated from a verified workflow with an explicit learning signal; confirm before treating it as durable.',
      suggestedType: 'skill_method',
      suggestedScope: scopeForTask(episode.t.userGoal),
      sourceRefs,
      learningSignal: learningSignal(review),
    });
  }

  const type = review.confidence >= 0.7 ? gapType(review) : null;
  if (type && review.reason) {
    proposals.push({
      // Same for gap lessons: the reasoned judgment replaces the template.
      judgment: review.lesson?.trim()
        ? review.lesson
        : `For similar tasks, address this ${review.attribution.replace('_', ' ')}: ${review.reason}`,
      summary: review.lesson?.trim() ? `Reusable ${review.attribution.replace('_', ' ')} lesson` : `KSTAR ${review.attribution.replace('_', ' ')} candidate`,
      uncertainty: 'This proposal is based on an explicit review and still requires user confirmation.',
      suggestedType: type,
      suggestedScope: scopeForTask(episode.t.userGoal),
      sourceRefs,
      learningSignal: learningSignal(review),
    });
  }

  return proposals.slice(0, 3);
}


export interface KstarDetectionHints {
  /** Natural-language hints for the LLM extraction prompt. */
  hints: string[];
  /** Whether a verified multi-tool workflow was detected. */
  hasVerifiedWorkflow: boolean;
  /** Whether the verified workflow has an explicit expected/actual learning signal. */
  hasWorkflowLearningSignal: boolean;
  /** Whether a review gap with high confidence was detected. */
  hasReviewGap: boolean;
}

export function buildKstarDetectionHints(
  episode: KstarEpisodeRecord,
  review: KstarReviewRecord,
): KstarDetectionHints {
  const hints: string[] = [];
  const distinctTools = [...new Set(episode.a.toolCalls.map((call) => call.name).filter(Boolean))];
  const verifiedWorkflow = episode.r.status === 'completed' &&
    distinctTools.length >= 2 &&
    episode.a.toolCalls.every((call) => call.status === 'ok');

  const workflowLearningSignal = hasLearningSignal(review);
  if (verifiedWorkflow && workflowLearningSignal) {
    hints.push(
      `DETECTED WORKFLOW: The assistant completed task "${
        episode.t.userGoal.slice(0, 120)
      }" using tools ${distinctTools.join(' → ')} (all successful), and review recorded an expected-versus-actual learning signal. ` +
      'Transform this into a reusable "skill_method" candidate describing the verified approach.',
    );
  }

  if (review.confidence >= 0.7 && review.reason) {
    const gapLabel = review.attribution.replace(/_/g, ' ');
    hints.push(
      `DETECTED GAP: Review found a ${gapLabel} — ${review.reason.slice(0, 200)}. ` +
      'Transform this into a candidate addressing what was missing.',
    );
  }

  return {
    hints,
    hasVerifiedWorkflow: verifiedWorkflow,
    hasWorkflowLearningSignal: workflowLearningSignal,
    hasReviewGap: review.confidence >= 0.7 && !!review.reason,
  };
}
