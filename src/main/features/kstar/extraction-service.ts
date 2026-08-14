import { normalizeCognitionSourceRefs } from '../recall/source-service';
import type { KstarCandidateProposal, KstarEpisodeRecord, KstarReviewRecord } from './types';

export function scopeForTask(task: string): string {
  if (/report|summary|document|file/i.test(task)) return 'report';
  if (/code|function|bug|test/i.test(task)) return 'code';
  if (/product|decision|architecture/i.test(task)) return 'product';
  return 'general';
}

export function gapType(review: KstarReviewRecord): KstarCandidateProposal['suggestedType'] | null {
  if (review.attribution === 'knowledge_gap') return 'personal';
  if (review.attribution === 'rule_gap') return 'rule';
  if (review.attribution === 'template_gap') return 'template';
  if (review.attribution === 'skill_gap') return 'skill_method';
  return null;
}

export function hasLearningSignal(review: KstarReviewRecord): boolean {
  return review.deltaR !== 'unknown'
    || review.deltaA !== 'unknown'
    || review.outcome === 'better_than_expected'
    || review.outcome === 'worse_than_expected'
    || (review.confidence >= 0.7 && review.attribution !== 'unclear' && !!review.reason.trim());
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

  const signalAvailable = hasLearningSignal(review);
  if (verifiedWorkflow && signalAvailable) {
    proposals.push({
      judgment: `For tasks like "${episode.t.userGoal}", use the verified workflow: ${distinctTools.join(' → ')}.`,
      summary: 'Verified multi-tool workflow',
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
      judgment: `For similar tasks, address this ${review.attribution.replace('_', ' ')}: ${review.reason}`,
      summary: `KSTAR ${review.attribution.replace('_', ' ')} candidate`,
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
