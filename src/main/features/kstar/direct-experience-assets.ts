import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { autoApplyRecallCandidate, saveRecallCandidate } from '../recall/candidate-service';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import type { KstarCandidateProposal, KstarEpisodeRecord } from './types';

/**
 * direct-experience-assets.ts — KStar experience line (candidate-pool path).
 *
 * Design (2026-08-15-kstar-candidate-pool-unification.md §3.2.1):
 * KStar lessons that passed the closure evidence gate are precipitated into
 * the UNIFIED candidate pool (saveRecallCandidate) instead of directly into
 * ability assets. The unified promotion exit (autoApplyRecallCandidate with
 * semantic dedup + quality fusion)
 * applies semantic dedup + quality fusion, so KStar lessons and the capture
 * line share one dedup domain (no duplicate assets, no content duplication).
 *
 * The candidate record carries learningProvenance (projectionId/forecastId/
 * episodeId/attribution) marking the KStar source.
 */

const log = createLogger('kstar.direct-experience-assets');

export interface PrecipitateDirectExperienceResult {
  createdAssetIds: string[];
  candidateIds: string[];
  /** Candidates that were merged into an existing candidate/asset (dedup). */
  mergedIntoIds: string[];
  /** Candidates that became update proposals (quality-fusion, need user). */
  updateCandidateIds: string[];
}

/** Lightweight source reference for requirement-level precipitation. */
export interface DirectExperienceSource {
  id: string;
  workspaceId?: string;
}

function proposalToCandidateInput(
  userId: string,
  source: DirectExperienceSource,
  proposal: KstarCandidateProposal,
  index: number,
): import('../recall/candidate-service').SaveRecallCandidateInput {
  const evidenceRefs = normalizeCognitionSourceRefs(proposal.sourceRefs);
  return {
    judgment: String(proposal.judgment || '').replace(/\s+/g, ' ').trim().slice(0, 4_000),
    value: String(proposal.summary || proposal.judgment || '').replace(/\s+/g, ' ').trim().slice(0, 1_000),
    summary: String(proposal.summary || '').replace(/\s+/g, ' ').trim().slice(0, 1_000),
    ...(proposal.uncertainty ? { uncertainty: String(proposal.uncertainty).slice(0, 1_000) } : {}),
    suggestedType: proposal.suggestedType,
    suggestedScope: String(proposal.suggestedScope || 'general').slice(0, 500),
    suggestedAction: 'create',
    sourceRefs: evidenceRefs,
    evidenceRefs,
    ...(proposal.learningSignal ? { learningSignal: proposal.learningSignal } : {}),
    ...(proposal.learningProvenance ? { learningProvenance: proposal.learningProvenance } : {}),
    captureKey: `kstar-${source.id}-${index}`,
  };
}

export async function precipitateDirectExperienceAssets(
  userId: string,
  episode: KstarEpisodeRecord,
  proposals: KstarCandidateProposal[],
): Promise<PrecipitateDirectExperienceResult> {
  return precipitateDirectExperienceFromSource(userId, {
    id: episode.id,
    workspaceId: episode.s?.workspaceId,
  }, proposals);
}

export async function precipitateDirectExperienceFromSource(
  userId: string,
  source: DirectExperienceSource,
  proposals: KstarCandidateProposal[],
): Promise<PrecipitateDirectExperienceResult> {
  if (!safeId(userId) || !safeId(source.id)) throw new Error('invalid direct experience reference');
  const result: PrecipitateDirectExperienceResult = {
    createdAssetIds: [],
    candidateIds: [],
    mergedIntoIds: [],
    updateCandidateIds: [],
  };
  for (const [index, proposal] of proposals.slice(0, 3).entries()) {
    try {
      const evidenceRefs = normalizeCognitionSourceRefs(proposal.sourceRefs);
      if (!evidenceRefs.length) continue;
      // 1. Enter the unified candidate pool (exact-fingerprint dedup inside).
      //    saveRecallCandidate returns the EXISTING candidate when the exact
      //    fingerprint matched (merged evidence), or a fresh one otherwise.
      const candidate = await saveRecallCandidate(userId, proposalToCandidateInput(userId, source, proposal, index));
      result.candidateIds.push(candidate.id);

      // 2. Unified promotion exit: semantic dedup + quality fusion against
      //    the asset library, then promote (or generate an update candidate).
      const outcome = await autoApplyRecallCandidate(userId, candidate.id);
      if (outcome.asset) {
        result.createdAssetIds.push(outcome.asset.id);
        const workspaceId = source.workspaceId;
        if (workspaceId && safeId(workspaceId)) {
          try {
            const { addWorkspaceAssetReference } = await import('../recall/workspace-refs');
            await addWorkspaceAssetReference(userId, {
              assetId: outcome.asset.id,
              workspaceId,
              scope: proposal.suggestedScope,
            });
          } catch (error) {
            log.warn('direct experience workspace reference degraded', {
              userId,
              assetId: outcome.asset.id,
              error: (error as Error).message,
            });
          }
        }
      }
      if (outcome.mergedIntoAssetId) result.mergedIntoIds.push(outcome.mergedIntoAssetId);
      if (outcome.updateCandidate) result.updateCandidateIds.push(outcome.updateCandidate.id);
    } catch (error) {
      // Direct precipitation is best-effort: a failure must never break the
      // closure itself.
      log.warn('direct experience precipitation degraded', {
        userId,
        sourceId: source.id,
        error: (error as Error).message,
      });
    }
  }
  return result;
}
