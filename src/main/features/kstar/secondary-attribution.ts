import { safeId } from '../../storage';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
} from '../recall/source-service';
import type { AssetUsageReceipt } from '../recall/asset-usage-receipt';
import type { InjectionReceipt } from '../recall/injection-receipt';
import type { KstarAttributionDetail, KstarEpisodeRecord } from './types';

export const KSTAR_SECONDARY_ATTRIBUTIONS = [
  'task_interpretation_error',
  'recall_miss',
  'projection_omission',
  'injection_failure',
  'asset_not_applied',
  'asset_not_applicable',
  'asset_conflict',
  'asset_outdated',
  'execution_error',
  'environment_failure',
  'forecast_error',
  'permission_blocked',
  'user_goal_changed',
  'insufficient_evidence',
] as const;

export type KstarSecondaryAttribution = typeof KSTAR_SECONDARY_ATTRIBUTIONS[number];

const SECONDARY_ATTRIBUTION_SET = new Set<string>(KSTAR_SECONDARY_ATTRIBUTIONS);
const NON_REUSABLE_ATTRIBUTIONS = new Set<KstarSecondaryAttribution>([
  'environment_failure',
  'permission_blocked',
  'user_goal_changed',
  'insufficient_evidence',
]);
const MAX_DETAILS = 8;

export interface DeterministicAttributionContext {
  episode: KstarEpisodeRecord;
  injectionReceipts?: readonly InjectionReceipt[];
  usageReceipts?: readonly AssetUsageReceipt[];
  /** The status of the persisted Forecast stage, when one was attempted. */
  forecastStatus?: string;
  /** Current asset versions, when the caller has already loaded them. */
  currentAssetVersions?: Readonly<Record<string, string>>;
  /** Structured signal from the lifecycle, never inferred from free-form prose. */
  userGoalChanged?: boolean;
}

export function isKstarSecondaryAttribution(value: unknown): value is KstarSecondaryAttribution {
  return typeof value === 'string' && SECONDARY_ATTRIBUTION_SET.has(value);
}

function asDetail(value: unknown, allowedEvidenceRefs?: unknown[]): KstarAttributionDetail {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid attribution detail');
  const raw = value as Record<string, unknown>;
  if (!isKstarSecondaryAttribution(raw.category)) throw new Error('invalid attribution detail category');
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new Error('invalid attribution detail confidence');
  }
  if (raw.source !== 'deterministic' && raw.source !== 'model' && raw.source !== 'user') {
    throw new Error('invalid attribution detail source');
  }
  if (!Array.isArray(raw.evidenceRefs)) throw new Error('attribution detail evidence is required');
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(raw.evidenceRefs);
  if (!evidenceRefs.length) throw new Error('attribution detail evidence is required');
  if (allowedEvidenceRefs !== undefined) {
    const allowed = new Set(normalizeCognitionSourceRefs(allowedEvidenceRefs).map(cognitionSourceRefKey));
    if (evidenceRefs.some((ref) => !allowed.has(cognitionSourceRefKey(ref)))) {
      throw new Error('attribution detail evidence is not bound to the episode');
    }
  }
  return {
    category: raw.category,
    confidence: raw.confidence,
    evidenceRefs,
    source: raw.source,
  };
}

/** Normalize and validate persisted/user-provided details. The optional
 * evidence set makes it impossible for a model or UI caller to cite a source
 * that is not already part of the Episode's durable evidence. */
export function normalizeKstarAttributionDetails(
  value: unknown,
  allowedEvidenceRefs?: unknown[],
): KstarAttributionDetail[] {
  if (!Array.isArray(value)) throw new Error('attribution details must be an array');
  if (value.length > MAX_DETAILS) throw new Error('too many attribution details');
  const details = value.map((item) => asDetail(item, allowedEvidenceRefs));
  const seen = new Set<string>();
  for (const detail of details) {
    const key = `${detail.category}:${detail.source}:${detail.evidenceRefs.map(cognitionSourceRefKey).join(',')}`;
    if (seen.has(key)) throw new Error('duplicate attribution detail');
    seen.add(key);
  }
  return details;
}

/** Parse the constrained model shape. Models receive opaque `kind:id` keys,
 * while Review persists the canonical source references only after resolving
 * those keys against the Episode evidence set. */
export function parseModelKstarAttributionDetails(
  value: unknown,
  episodeEvidenceRefs: CognitionSourceRef[],
): KstarAttributionDetail[] {
  if (!Array.isArray(value)) throw new Error('attributionDetails must be an array');
  const refsByKey = new Map(episodeEvidenceRefs.map((ref) => [cognitionSourceRefKey(ref), ref]));
  return normalizeKstarAttributionDetails(value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid model attribution detail');
    const raw = item as Record<string, unknown>;
    const ids = raw.evidenceRefIds;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !safeId(id.replace(/^\w+:\/\//, '').replace(/^\w+:/, '')))) {
      throw new Error('model attribution detail evidence is required');
    }
    const refs = ids.map((id) => {
      const key = id.replace(/^([a-z0-9_]+):\/\//i, '$1:');
      const ref = refsByKey.get(key);
      if (!ref) throw new Error('model attribution detail cited unknown evidence');
      return ref;
    });
    return {
      category: raw.category,
      confidence: raw.confidence,
      evidenceRefs: refs,
      source: 'model',
    };
  }), episodeEvidenceRefs);
}

export function attributionAllowsReusableLearning(review: Pick<{ attributionDetails?: KstarAttributionDetail[] }, 'attributionDetails'>): boolean {
  const details = review.attributionDetails || [];
  // No field means a legacy Review: preserve the pre-secondary-attribution
  // behavior. An explicit list containing only blocked causes is fail-closed.
  return !details.length || details.some((detail) => !NON_REUSABLE_ATTRIBUTIONS.has(detail.category));
}

export function isNonReusableSecondaryAttribution(category: KstarSecondaryAttribution): boolean {
  return NON_REUSABLE_ATTRIBUTIONS.has(category);
}

function evidenceFor(episode: KstarEpisodeRecord): CognitionSourceRef[] {
  return normalizeCognitionSourceRefsForWrite(episode.evidenceRefs);
}

function detail(
  episode: KstarEpisodeRecord,
  category: KstarSecondaryAttribution,
  confidence: number,
): KstarAttributionDetail | undefined {
  const evidenceRefs = evidenceFor(episode);
  return evidenceRefs.length
    ? { category, confidence, evidenceRefs, source: 'deterministic' }
    : undefined;
}

function metadataText(episode: KstarEpisodeRecord): string {
  return [episode.r.failureKind, episode.r.failureCode].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
}

function matchesPermission(value: string): boolean {
  return /permission|forbidden|unauthori[sz]|access[_ -]?denied|not[_ -]?allowed|scope[_ -]?denied|policy[_ -]?blocked/.test(value);
}

function matchesEnvironment(value: string): boolean {
  return /network|connection|connect|workspace|dependency|unavailable|econn|enoent|service[_ -]?unavailable/.test(value);
}

function scopedInjections(context: DeterministicAttributionContext): InjectionReceipt[] {
  const { episode } = context;
  return (context.injectionReceipts || []).filter((receipt) => (
    (!episode.taskRunId || receipt.taskRunId === episode.taskRunId)
    && (!episode.projectionId || receipt.projectionId === episode.projectionId)
  ));
}

function scopedUsage(context: DeterministicAttributionContext): AssetUsageReceipt[] {
  const { episode } = context;
  return (context.usageReceipts || []).filter((receipt) => (
    (!episode.taskRunId || receipt.taskRunId === episode.taskRunId)
    && (!episode.projectionId || receipt.projectionId === episode.projectionId)
  ));
}

/** Derive one highest-priority secondary cause from persisted facts. This is
 * intentionally conservative: it never searches localized prose and returns
 * insufficient_evidence when the structured chain cannot explain a result. */
export function deriveDeterministicAttributionDetails(
  context: DeterministicAttributionContext,
): KstarAttributionDetail | undefined {
  const { episode } = context;
  const metadata = metadataText(episode);
  const injections = scopedInjections(context);
  const usage = scopedUsage(context);
  const assetIds = new Set(episode.k.abilityAssetRefs.filter((id) => safeId(id)));

  if (context.userGoalChanged) return detail(episode, 'user_goal_changed', 0.98);
  if (context.forecastStatus === 'failed' || context.forecastStatus === 'error') return detail(episode, 'forecast_error', 0.98);
  if (matchesPermission(metadata)) return detail(episode, 'permission_blocked', 0.98);
  if (matchesEnvironment(metadata)) return detail(episode, 'environment_failure', 0.95);
  if (assetIds.size && !episode.projectionId) return detail(episode, 'projection_omission', 0.92);

  if (assetIds.size) {
    const byAsset = new Map(injections.map((receipt) => [receipt.assetId, receipt]));
    if ([...assetIds].some((assetId) => {
      const receipt = byAsset.get(assetId);
      return !receipt || receipt.status === 'failed' || receipt.status === 'omitted';
    })) return detail(episode, 'injection_failure', 0.95);

    if (context.currentAssetVersions && [...assetIds].some((assetId) => {
      const current = context.currentAssetVersions![assetId];
      const injected = byAsset.get(assetId);
      return current !== undefined && injected !== undefined && current !== injected.assetVersion;
    })) return detail(episode, 'asset_outdated', 0.95);

    const scoped = usage.filter((receipt) => assetIds.has(receipt.assetId));
    if (scoped.some((receipt) => receipt.status === 'contradicted')) return detail(episode, 'asset_conflict', 0.9);
    if (scoped.some((receipt) => receipt.status === 'available_no_opportunity' || receipt.status === 'considered_not_applicable')) {
      return detail(episode, 'asset_not_applicable', 0.85);
    }
    if (scoped.some((receipt) => receipt.status === 'usage_unknown')) {
      const hasStructuredEvidence = scoped.some((receipt) => receipt.evidenceKind !== 'none' && receipt.evidenceRefs.length > 0);
      if (hasStructuredEvidence) return detail(episode, 'asset_not_applied', 0.8);
    }
  }

  if (episode.r.status === 'failed' || episode.r.status === 'cancelled' || episode.r.status === 'timed_out') {
    return detail(episode, 'execution_error', 0.9);
  }
  return detail(episode, 'insufficient_evidence', 0.4);
}
