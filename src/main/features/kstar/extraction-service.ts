import { normalizeCognitionSourceRefs } from '../recall/source-service';
import type { KstarCandidateProposal, KstarEpisodeRecord, KstarReviewRecord } from './types';

function scopeForTask(task: string): string {
  if (/report|summary|document|file/i.test(task)) return 'report';
  if (/code|function|bug|test/i.test(task)) return 'code';
  if (/product|decision|architecture/i.test(task)) return 'product';
  return 'general';
}

function gapType(review: KstarReviewRecord): KstarCandidateProposal['suggestedType'] | null {
  if (review.attribution === 'knowledge_gap') return 'personal';
  if (review.attribution === 'rule_gap') return 'rule';
  if (review.attribution === 'template_gap') return 'template';
  if (review.attribution === 'skill_gap') return 'skill_method';
  return null;
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

  if (verifiedWorkflow) {
    proposals.push({
      judgment: `For tasks like "${episode.t.userGoal}", use the verified workflow: ${distinctTools.join(' → ')}.`,
      summary: 'Verified multi-tool workflow',
      uncertainty: 'Generated from one successful episode; confirm before treating it as a durable method.',
      suggestedType: 'skill_method',
      suggestedScope: scopeForTask(episode.t.userGoal),
      sourceRefs,
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
    });
  }

  return proposals.slice(0, 3);
}
