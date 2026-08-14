import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { precipitateDirectExperienceFromSource } from './direct-experience-assets';
import { readKstarEpisode } from './episode-store';
import { clearsPrecipitationGate, gapType, learningSignal, scopeForTask } from './extraction-service';
import { readKstarReview } from './review-service';
import { saveKstarCandidateProposals } from './recall-bridge';
import type { KstarRequirementRecord } from './requirement-types';
import type { KstarCandidateProposal, KstarEpisodeRecord, KstarReviewRecord } from './types';

/**
 * task-level-precipitation.ts — requirement-level delta-r aggregation.
 *
 * Single-episode closure precipitates per-episode lessons. This module
 * aggregates ALL episodes of one requirement (B5): it merges the tool chain
 * across episodes, takes the strongest review signal, and precipitates ONE
 * reusable ability asset per signal so a multi-episode task yields a coherent
 * skill_method / gap asset instead of N fragmented fragments.
 *
 * Fired from:
 *  - finish/abandon (task closure, B7)
 *  - new-task switch (upsert_state task:create while a task is open, B2)
 *
 * Precipitation is best-effort and evidence-gated: no proposal is emitted
 * unless the merged evidence clears the same gates as the episode line.
 */

const log = createLogger('kstar.task-level-precipitation');

export interface AggregateRequirementProposalsInput {
  requirement: KstarRequirementRecord;
  episodes: KstarEpisodeRecord[];
  reviews: KstarReviewRecord[];
}

export interface RequirementLevelPrecipitationResult {
  proposals: KstarCandidateProposal[];
  createdAssetIds: string[];
  candidateIds: string[];
}

export function aggregateRequirementProposals(input: AggregateRequirementProposalsInput): KstarCandidateProposal[] {
  const { requirement, episodes, reviews } = input;
  if (episodes.length === 0) return [];

  // Merged tool chain across every episode, preserving first-seen order.
  const toolChain: string[] = [];
  for (const episode of episodes) {
    for (const call of episode.a.toolCalls) {
      const name = String(call.name || '').trim();
      if (name && !toolChain.includes(name)) toolChain.push(name);
    }
  }
  const allCallsOk = episodes.every((episode) => episode.a.toolCalls.every((call) => call.status === 'ok'));
  const anyCompleted = episodes.some((episode) => episode.r.status === 'completed');
  const verifiedWorkflow = anyCompleted && toolChain.length >= 2 && allCallsOk;

  // Merged evidence: each episode execution + non-execution refs, deduped.
  const mergedRefs = normalizeCognitionSourceRefs([
    ...episodes.flatMap((episode) => [
      { kind: 'execution' as const, id: episode.id, title: 'KSTAR requirement episode' },
      ...episode.evidenceRefs.filter((ref) => ref.kind !== 'execution'),
    ]),
  ]);

  // Strongest review drives the aggregated learning signal — it must clear
  // the |ΔR| precipitation gate so noise never becomes a requirement-level
  // rule.
  const strongest = [...reviews]
    .filter((review) => clearsPrecipitationGate(review))
    .sort((a, b) => b.confidence - a.confidence)[0];

  const proposals: KstarCandidateProposal[] = [];
  const goal = requirement.goalText || requirement.title;
  if (verifiedWorkflow && strongest) {
    proposals.push({
      judgment: `For tasks like "${goal}", use the verified workflow: ${toolChain.join(' → ')}.`,
      summary: 'Verified multi-tool workflow (requirement-level)',
      uncertainty: 'Generated from a closed multi-episode requirement; confirm before treating it as durable.',
      suggestedType: 'skill_method',
      suggestedScope: scopeForTask(goal),
      sourceRefs: mergedRefs,
      learningSignal: learningSignal(strongest),
    });
  }

  // Highest-confidence gap across all episodes, only when evidence-gated.
  const gapReview = [...reviews]
    .filter((review) => review.confidence >= 0.7 && review.reason.trim().length > 0)
    .sort((a, b) => b.confidence - a.confidence)[0];
  const gapAssetType = gapReview ? gapType(gapReview) : null;
  if (gapAssetType && gapReview) {
    proposals.push({
      judgment: `For similar tasks, address this ${gapReview.attribution.replace(/_/g, ' ')}: ${gapReview.reason}`,
      summary: `KSTAR ${gapReview.attribution.replace(/_/g, ' ')} candidate (requirement-level)`,
      uncertainty: 'This proposal is based on an explicit review and still requires user confirmation.',
      suggestedType: gapAssetType,
      suggestedScope: scopeForTask(goal),
      sourceRefs: mergedRefs,
      learningSignal: learningSignal(gapReview),
    });
  }

  return proposals.slice(0, 3);
}

export interface RequirementLevelPrecipitationOptions {
  /** Overridable bridge for the candidate review line; defaults to the shared bridge. */
  candidateBridge?: (userId: string, proposals: KstarCandidateProposal[]) => Promise<Array<{ id: string }>>;
}

/**
 * Precipitate requirement-level ability assets: aggregated proposals go BOTH
 * to the direct-experience asset line (evidence-gated, no user confirmation)
 * and to the candidate review line for optional promotion.
 */
export async function precipitateRequirementLevel(
  userId: string,
  requirement: KstarRequirementRecord,
  options: RequirementLevelPrecipitationOptions = {},
): Promise<RequirementLevelPrecipitationResult> {
  if (!safeId(userId) || !safeId(requirement.id)) throw new Error('invalid requirement precipitation reference');
  const episodes = (
    await Promise.all(requirement.episodeIds.map((episodeId) => readKstarEpisode(userId, episodeId)))
  ).filter((episode): episode is KstarEpisodeRecord => Boolean(episode));
  const reviews = (
    await Promise.all(episodes.map((episode) => readKstarReview(userId, episode.id)))
  ).filter((review): review is KstarReviewRecord => Boolean(review));

  const proposals = aggregateRequirementProposals({ requirement, episodes, reviews });
  if (proposals.length === 0) return { proposals: [], createdAssetIds: [], candidateIds: [] };

  const workspaceId = episodes.map((episode) => episode.s?.workspaceId).find((id) => id && safeId(id));
  const bridge = options.candidateBridge || saveKstarCandidateProposals;

  let createdAssetIds: string[] = [];
  let candidateIds: string[] = [];
  try {
    const direct = await precipitateDirectExperienceFromSource(userId, {
      id: requirement.id,
      ...(workspaceId ? { workspaceId } : {}),
    }, proposals);
    createdAssetIds = direct.createdAssetIds;
  } catch (error) {
    // Best-effort: never break task closure or the review line.
    log.warn('requirement-level direct precipitation degraded', {
      userId,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
  }
  try {
    const candidates = await bridge(userId, proposals);
    candidateIds = candidates.map((candidate) => candidate.id);
  } catch (error) {
    log.warn('requirement-level candidate bridge degraded', {
      userId,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
  }
  return { proposals, createdAssetIds, candidateIds };
}
