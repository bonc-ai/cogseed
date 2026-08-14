import { createHash } from 'node:crypto';

import { createLogger } from '../../logger';
import { nowIso, safeId } from '../../storage';
import { createSystemAbilityAsset } from '../recall/asset-service';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { addWorkspaceAssetReference } from '../recall/workspace-refs';
import type { KstarCandidateProposal, KstarEpisodeRecord } from './types';

/**
 * direct-experience-assets.ts — KStar direct experience line.
 *
 * Experiences that passed the closure evidence gate (proposeKstarCandidates)
 * are precipitated DIRECTLY into Recall ability assets with a system actor,
 * skipping the candidate review line. The review line (pending candidate →
 * user promote) is untouched and runs in parallel from the same proposals.
 */

const log = createLogger('kstar.direct-experience-assets');
const MAX_TITLE = 120;
const MAX_STATEMENT = 4_000;
const MAX_SCOPE = 500;

function bounded(value: string | undefined, field: string, max: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`invalid direct experience ${field}`);
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

function evidenceKey(ref: { kind: string; id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

export interface PrecipitateDirectExperienceResult {
  createdAssetIds: string[];
}

export async function precipitateDirectExperienceAssets(
  userId: string,
  episode: KstarEpisodeRecord,
  proposals: KstarCandidateProposal[],
): Promise<PrecipitateDirectExperienceResult> {
  if (!safeId(userId) || !safeId(episode.id)) throw new Error('invalid direct experience reference');
  const createdAssetIds: string[] = [];
  for (const proposal of proposals.slice(0, 3)) {
    try {
      const evidenceRefs = normalizeCognitionSourceRefs(proposal.sourceRefs);
      if (!evidenceRefs.length) continue;
      const contentKey = createHash('sha256')
        .update([
          String(proposal.judgment || '').replace(/\s+/g, ' ').trim(),
          ...evidenceRefs.map(evidenceKey).sort(),
        ].join('\n'))
        .digest('hex');
      const assetId = `aa-${contentKey.slice(0, 24)}`;
      const now = nowIso();
      const asset = await createSystemAbilityAsset(userId, {
        schemaVersion: 2,
        ownerId: userId,
        id: assetId,
        candidateId: `direct-${contentKey.slice(0, 12)}`,
        title: bounded(proposal.summary, 'summary', MAX_TITLE),
        statement: bounded(proposal.judgment, 'judgment', MAX_STATEMENT),
        type: proposal.suggestedType,
        scope: bounded(proposal.suggestedScope, 'suggestedScope', MAX_SCOPE),
        evidenceRefs,
        reviewDecisionId: 'legacy-untracked',
        lifecycleStatus: 'user_confirmed_unverified',
        ...(proposal.learningSignal ? { learningSignal: proposal.learningSignal } : {}),
        status: 'active',
        maturity: 'seed',
        version: '1',
        createdAt: now,
        updatedAt: now,
      }, `kstar_direct_experience:${episode.id}`);
      createdAssetIds.push(asset.id);

      const workspaceId = episode.s?.workspaceId;
      if (workspaceId && safeId(workspaceId)) {
        try {
          await addWorkspaceAssetReference(userId, {
            assetId,
            workspaceId,
            scope: proposal.suggestedScope,
          });
        } catch (error) {
          log.warn('direct experience workspace reference degraded', {
            userId,
            assetId,
            error: (error as Error).message,
          });
        }
      }
    } catch (error) {
      // Direct precipitation is best-effort: a failure must never break the
      // review line or the closure itself.
      log.warn('direct experience precipitation degraded', {
        userId,
        episodeId: episode.id,
        error: (error as Error).message,
      });
    }
  }
  return { createdAssetIds };
}
