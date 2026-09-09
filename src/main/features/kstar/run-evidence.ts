import { nowIso, safeId } from '../../storage';
import {
  listAbilityAssetVersions,
  type AbilityAssetVersionRecord,
} from '../recall/asset-service';
import {
  listAssetUsageReceipts,
  type AssetUsageReceipt,
} from '../recall/asset-usage-receipt';
import {
  readContextProjection,
  type ContextProjectionRecord,
  type RecallAssetMatchMethod,
} from '../recall/context-projection';
import {
  listInjectionReceipts,
  type InjectionReceipt,
} from '../recall/injection-receipt';
import {
  listEffectivenessProofs,
  listTransferProofs,
  type EffectivenessProofRecord,
  type TransferProofRecord,
} from '../recall/proof-service';
import {
  listValidationRecords,
  type ValidationRecord,
} from '../recall/validation-service';
import { readKstarEpisode } from './episode-store';
import {
  readKstarRequirement,
  readKstarTask,
} from './requirement-store';
import { readKstarReview } from './review-service';
import { usageMatchesInjection } from './receipt-relationship';
import type { KstarRequirementRecord } from './requirement-types';
import type {
  KstarEpisodeRecord,
  KstarReviewRecord,
} from './types';

export interface KstarRunEvidenceInput {
  taskId: string;
  taskRunId: string;
}

export type KstarRunEvidenceGap =
  | 'task_run_not_linked'
  | 'projection_not_recorded'
  | 'asset_version_snapshot_not_recorded'
  | 'injection_not_recorded'
  | 'usage_not_recorded'
  | 'execution_not_recorded'
  | 'review_not_recorded'
  | 'reuse_turn_ids_truncated'
  | 'effectiveness_not_recorded'
  | 'output_truncated';

export interface KstarRunEvidenceAsset {
  assetId: string;
  assetVersion: string;
  snapshot: AbilityAssetVersionRecord['snapshot'] | null;
  matches: Array<{
    projectionId: string;
    matchScore: number;
    matchMethod: RecallAssetMatchMethod;
  }>;
  injectionReceipts: InjectionReceipt[];
  usageReceipts: AssetUsageReceipt[];
}

export interface KstarRunEvidence {
  taskId: string;
  taskRunId: string;
  conversationId: string;
  requirementIds: string[];
  projections: ContextProjectionRecord[];
  injectionReceipts: InjectionReceipt[];
  usageReceipts: AssetUsageReceipt[];
  assets: KstarRunEvidenceAsset[];
  episodes: KstarEpisodeRecord[];
  reviews: KstarReviewRecord[];
  transferProofs: TransferProofRecord[];
  effectivenessProofs: EffectivenessProofRecord[];
  validations: ValidationRecord[];
  /** True when any returned collection hit the per-collection cap. */
  truncated: boolean;
  gaps: KstarRunEvidenceGap[];
  generatedAt: string;
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function uniqueById<T extends { id: string }>(records: T[]): T[] {
  const byRecordId = new Map<string, T>();
  for (const record of records) {
    if (!byRecordId.has(record.id)) byRecordId.set(record.id, record);
  }
  return [...byRecordId.values()];
}

function receiptRunIds(episode: KstarEpisodeRecord): string[] {
  return episode.reuseTurnIds !== undefined
    ? episode.reuseTurnIds
    : episode.taskRunId
      ? [episode.taskRunId]
      : [];
}

function assetVersionKey(assetId: string, assetVersion: string): string {
  return JSON.stringify([assetId, assetVersion]);
}

function compareAssetVersions(
  left: Pick<KstarRunEvidenceAsset, 'assetId' | 'assetVersion'>,
  right: Pick<KstarRunEvidenceAsset, 'assetId' | 'assetVersion'>,
): number {
  return left.assetId.localeCompare(right.assetId)
    || left.assetVersion.localeCompare(right.assetVersion);
}

/**
 * Hard cap applied to every returned collection (episodes, projections,
 * injectionReceipts, usageReceipts, assets, reviews, transferProofs,
 * effectivenessProofs, validations) so the IPC payload cannot grow without
 * bound. Real aggregate runs stay far below this. When any collection is
 * capped the result reports `truncated: true` and adds `output_truncated` to
 * gaps so callers never mistake the partial payload for complete evidence.
 */
const EVIDENCE_COLLECTION_CAP = 1000;

function capped<T>(records: T[]): { records: T[]; truncated: boolean } {
  return records.length > EVIDENCE_COLLECTION_CAP
    ? { records: records.slice(0, EVIDENCE_COLLECTION_CAP), truncated: true }
    : { records, truncated: false };
}

async function readLinkedProjection(
  userId: string,
  projectionId: string,
  logicalTaskId: string,
): Promise<ContextProjectionRecord | null> {
  try {
    const projection = await readContextProjection(userId, projectionId);
    return projection.taskRunId === logicalTaskId ? projection : null;
  } catch (error) {
    if (error instanceof Error && error.message === 'context projection not found') return null;
    throw error;
  }
}

export async function readKstarRunEvidence(
  userId: string,
  input: KstarRunEvidenceInput,
): Promise<KstarRunEvidence> {
  if (!input || !safeId(userId) || !safeId(input.taskId) || !safeId(input.taskRunId)) {
    throw new Error('invalid KSTAR run evidence reference');
  }

  const task = await readKstarTask(userId, input.taskId);
  if (!task) throw new Error('kstar task not found');

  // Authoritative Requirements are read directly per id (stable, deduplicated)
  // so a corrupt referenced record propagates instead of being silently skipped
  // by the degraded-record listing path.
  const requirements: KstarRequirementRecord[] = [];
  const seenRequirementIds = new Set<string>();
  for (const requirementId of task.requirementIds) {
    if (seenRequirementIds.has(requirementId)) continue;
    seenRequirementIds.add(requirementId);
    const requirement = await readKstarRequirement(userId, requirementId);
    if (requirement) requirements.push(requirement);
  }
  const matchingRequirementIds: string[] = [];
  const matchingEpisodes: KstarEpisodeRecord[] = [];
  const linkedProjectionIds = new Set<string>();

  for (const requirement of requirements) {
    const episodes = (
      await Promise.all(requirement.episodeIds.map((episodeId) => readKstarEpisode(userId, episodeId)))
    ).filter((episode): episode is KstarEpisodeRecord => episode?.taskRunId === input.taskRunId);
    if (!episodes.length) continue;

    matchingRequirementIds.push(requirement.id);
    matchingEpisodes.push(...episodes);
    const requirementProjectionIds = new Set([
      ...requirement.projectionIds,
      ...(requirement.projectionId ? [requirement.projectionId] : []),
    ]);
    for (const episode of episodes) {
      if (episode.projectionId && requirementProjectionIds.has(episode.projectionId)) {
        linkedProjectionIds.add(episode.projectionId);
      }
    }
  }

  const episodes = uniqueById(matchingEpisodes).sort(byId);
  const projections = (
    await Promise.all([...linkedProjectionIds]
      .sort()
      .map((projectionId) => readLinkedProjection(userId, projectionId, task.id)))
  ).filter((projection): projection is ContextProjectionRecord => Boolean(projection)).sort(byId);
  const ownedProjectionIds = new Set(projections.map((projection) => projection.id));

  const episodesByReceiptRunId = new Map<string, KstarEpisodeRecord[]>();
  for (const episode of episodes) {
    for (const runId of receiptRunIds(episode)) {
      const current = episodesByReceiptRunId.get(runId) || [];
      current.push(episode);
      episodesByReceiptRunId.set(runId, current);
    }
  }
  const receiptRunIdSet = new Set(episodesByReceiptRunId.keys());
  const loadedInjections = receiptRunIdSet.size === 0
    ? []
    : (await listInjectionReceipts(userId))
      .filter((receipt) => receiptRunIdSet.has(receipt.taskRunId));
  const injectionReceipts = uniqueById(loadedInjections.filter((receipt) => {
    const runEpisodes = episodesByReceiptRunId.get(receipt.taskRunId) || [];
    if (receipt.projectionId) {
      return ownedProjectionIds.has(receipt.projectionId)
        && runEpisodes.some((episode) => episode.projectionId === receipt.projectionId);
    }
    return runEpisodes.length > 0;
  })).sort(byId);
  const injectionsById = new Map(injectionReceipts.map((receipt) => [receipt.id, receipt]));

  const loadedUsage = receiptRunIdSet.size === 0
    ? []
    : (await listAssetUsageReceipts(userId))
      .filter((receipt) => receiptRunIdSet.has(receipt.taskRunId));
  const usageReceipts = uniqueById(loadedUsage.filter((receipt) => {
    const injection = injectionsById.get(receipt.injectionReceiptId);
    return Boolean(
      injection
      && usageMatchesInjection(receipt, injection)
      && ownedProjectionIds.has(receipt.projectionId),
    );
  })).sort(byId);
  const reviews = uniqueById((
    await Promise.all(episodes.map((episode) => readKstarReview(userId, episode.id)))
  ).filter((review): review is KstarReviewRecord => Boolean(review))).sort(byId);

  const assetVersions = new Map<string, { assetId: string; assetVersion: string }>();
  let hasMissingProjectionAssetVersion = false;
  const includeAssetVersion = (assetId: string, assetVersion: string): void => {
    const key = assetVersionKey(assetId, assetVersion);
    if (!assetVersions.has(key)) assetVersions.set(key, { assetId, assetVersion });
  };
  for (const projection of projections) {
    for (const assetId of projection.assetIds) {
      const lockedVersion = projection.assetVersions?.[assetId];
      if (lockedVersion) includeAssetVersion(assetId, lockedVersion);
      else hasMissingProjectionAssetVersion = true;
    }
  }
  for (const receipt of injectionReceipts) {
    includeAssetVersion(receipt.assetId, receipt.assetVersion);
  }
  for (const receipt of usageReceipts) {
    includeAssetVersion(receipt.assetId, receipt.assetVersion);
  }
  const requestedAssetVersions = [...assetVersions.values()].sort(compareAssetVersions);
  const snapshotsByAssetId = new Map<
    string,
    Map<string, AbilityAssetVersionRecord['snapshot']>
  >();
  await Promise.all([...new Set(requestedAssetVersions.map(({ assetId }) => assetId))]
    .map(async (assetId) => {
      const versions = await listAbilityAssetVersions(userId, assetId);
      snapshotsByAssetId.set(
        assetId,
        new Map(versions.map((record) => [record.version, record.snapshot])),
      );
    }));
  const assets = requestedAssetVersions
    .map(({ assetId, assetVersion }): KstarRunEvidenceAsset => ({
      assetId,
      assetVersion,
      snapshot: snapshotsByAssetId.get(assetId)?.get(assetVersion) ?? null,
      matches: projections
        .filter((projection) => projection.assetVersions?.[assetId] === assetVersion)
        .flatMap((projection) => (projection.assetMatches || [])
          .filter((match) => match.assetId === assetId)
          .map((match) => ({
            projectionId: projection.id,
            matchScore: match.matchScore,
            matchMethod: match.matchMethod,
          })))
        .sort((left, right) => left.projectionId.localeCompare(right.projectionId)
          || left.matchMethod.localeCompare(right.matchMethod)
          || left.matchScore - right.matchScore),
      injectionReceipts: injectionReceipts.filter((receipt) => (
        receipt.assetId === assetId && receipt.assetVersion === assetVersion
      )),
      usageReceipts: usageReceipts.filter((receipt) => (
        receipt.assetId === assetId && receipt.assetVersion === assetVersion
      )),
    }));

  const proofExecutionIdsByProjection = new Map<string, Set<string>>();
  for (const episode of episodes) {
    if (!episode.projectionId || !ownedProjectionIds.has(episode.projectionId)) continue;
    const executionIds = proofExecutionIdsByProjection.get(episode.projectionId) || new Set<string>();
    for (const executionId of [episode.executionId, episode.taskRunId, input.taskRunId]) {
      if (executionId && safeId(executionId)) executionIds.add(executionId);
    }
    proofExecutionIdsByProjection.set(episode.projectionId, executionIds);
  }
  const transferProofs = proofExecutionIdsByProjection.size === 0
    ? []
    : (await listTransferProofs(userId))
      .filter((proof) => proofExecutionIdsByProjection.get(proof.projectionId)?.has(proof.executionId))
      .sort(byId);
  const ownedTransferProofIds = new Set(transferProofs.map((proof) => proof.id));
  const effectivenessProofs = ownedTransferProofIds.size === 0
    ? []
    : (await listEffectivenessProofs(userId))
      .filter((proof) => ownedTransferProofIds.has(proof.transferProofId))
      .sort(byId);

  const ownedAssetIds = new Set(assets.map((asset) => asset.assetId));
  const transferAssetIdsByExecution = new Map<string, Set<string>>();
  for (const proof of transferProofs) {
    const assetIds = transferAssetIdsByExecution.get(proof.executionId) || new Set<string>();
    for (const asset of proof.assetVersions) {
      if (ownedAssetIds.has(asset.assetId)) assetIds.add(asset.assetId);
    }
    transferAssetIdsByExecution.set(proof.executionId, assetIds);
  }
  const validations = transferAssetIdsByExecution.size === 0
    ? []
    : (await listValidationRecords(userId))
      .filter((validation) => transferAssetIdsByExecution
        .get(validation.taskRunId)?.has(validation.assetId))
      .sort(byId);

  // Conservative per-owner gap semantics: presence of evidence for one owner
  // must not hide missing evidence for another owner of the same aggregate run.
  const ownedEpisodes = episodes.filter((episode) => (
    Boolean(episode.projectionId) && ownedProjectionIds.has(episode.projectionId)
  ));
  const reviewedEpisodeIds = new Set(reviews.map((review) => review.episodeId));
  const hasAuthoritativeReceiptRunIds = (episode: KstarEpisodeRecord): boolean => (
    episode.reuseTurnIds !== undefined
      ? episode.reuseTurnIds.length > 0
      : Boolean(episode.taskRunId)
  );
  const expectsInjections = ownedEpisodes.some(hasAuthoritativeReceiptRunIds);
  const ownedInjectionChain = injectionReceipts.filter((receipt) => Boolean(receipt.projectionId));
  const injectionWithoutUsage = ownedInjectionChain.some((injection) => (
    !usageReceipts.some((usage) => usageMatchesInjection(usage, injection))
  ));
  const transferProofWithoutEffectiveness = transferProofs.some((proof) => (
    !effectivenessProofs.some((effectiveness) => effectiveness.transferProofId === proof.id)
  ));
  // The legacy no-transfer-proof fallback is scoped to OWNED Episodes: a
  // terminal Episode whose linked Projection is missing/mismatched (unowned),
  // or a non-terminal owned Episode, must not manufacture an effectiveness
  // expectation. `ownedEpisodes` empty => expectsEffectiveness false => the
  // fallback stays silent.
  const expectsEffectiveness = ownedEpisodes.some((episode) => (
    episode.r.status === 'completed' || episode.r.status === 'failed'
  ));

  const gaps: KstarRunEvidenceGap[] = [];
  if (!episodes.length) gaps.push('task_run_not_linked');
  if (!projections.length) gaps.push('projection_not_recorded');
  if (hasMissingProjectionAssetVersion || assets.some((asset) => asset.snapshot === null)) {
    gaps.push('asset_version_snapshot_not_recorded');
  }
  if (!episodes.length) {
    // No authoritative Episode: nothing at all was recorded for this run, so
    // every evidence-type gap is reported (execution_not_recorded included).
    gaps.push('injection_not_recorded');
    gaps.push('usage_not_recorded');
    gaps.push('execution_not_recorded');
    gaps.push('review_not_recorded');
    gaps.push('effectiveness_not_recorded');
  } else {
    // injection_not_recorded is deliberately aggregate-run scoped: a single
    // user-triggered run accumulates one cumulative reuseTurnIds list and emits
    // one terminal per run, and owned Episodes of one run inherit overlapping
    // lists. Masking a hypothetical disjoint per-Episode list (one owner with
    // zero resolved injections while another resolves one) is the intended
    // contract, so the run-level signal stays a single gate on the run.
    if (expectsInjections && injectionReceipts.length === 0) gaps.push('injection_not_recorded');
    if (injectionWithoutUsage) gaps.push('usage_not_recorded');
    if (ownedEpisodes.some((episode) => !reviewedEpisodeIds.has(episode.id))) {
      gaps.push('review_not_recorded');
    }
    if (ownedEpisodes.some((episode) => episode.reuseTurnIdsTruncated === true)) {
      gaps.push('reuse_turn_ids_truncated');
    }
    if (transferProofWithoutEffectiveness || (transferProofs.length === 0 && expectsEffectiveness)) {
      gaps.push('effectiveness_not_recorded');
    }
  }

  const keptEpisodes = capped(episodes);
  const keptProjections = capped(projections);
  const keptInjectionReceipts = capped(injectionReceipts);
  const keptUsageReceipts = capped(usageReceipts);
  const keptAssets = capped(assets);
  const keptReviews = capped(reviews);
  const keptTransferProofs = capped(transferProofs);
  const keptEffectivenessProofs = capped(effectivenessProofs);
  const keptValidations = capped(validations);
  let truncated = [
    keptEpisodes,
    keptProjections,
    keptInjectionReceipts,
    keptUsageReceipts,
    keptAssets,
    keptReviews,
    keptTransferProofs,
    keptEffectivenessProofs,
    keptValidations,
  ].some((entry) => entry.truncated);
  const outputAssets = keptAssets.records.map((asset) => {
    // Cap the nested per-asset sub-lists too so one Asset cannot carry an
    // unbounded payload even when the top-level collection is capped.
    const matches = capped(asset.matches);
    const injectionReceipts = capped(asset.injectionReceipts);
    const usageReceipts = capped(asset.usageReceipts);
    if (matches.truncated || injectionReceipts.truncated || usageReceipts.truncated) {
      truncated = true;
    }
    return {
      ...asset,
      matches: matches.records,
      injectionReceipts: injectionReceipts.records,
      usageReceipts: usageReceipts.records,
    };
  });
  if (truncated) gaps.push('output_truncated');

  return {
    taskId: task.id,
    taskRunId: input.taskRunId,
    conversationId: task.conversationId,
    requirementIds: [...new Set(matchingRequirementIds)].sort(),
    projections: keptProjections.records,
    injectionReceipts: keptInjectionReceipts.records,
    usageReceipts: keptUsageReceipts.records,
    assets: outputAssets,
    episodes: keptEpisodes.records,
    reviews: keptReviews.records,
    transferProofs: keptTransferProofs.records,
    effectivenessProofs: keptEffectivenessProofs.records,
    validations: keptValidations.records,
    truncated,
    gaps,
    generatedAt: nowIso(),
  };
}
