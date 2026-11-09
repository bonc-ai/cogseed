/** Decide what to do when a capture candidate relates to more assets than the
 * formation comparison can carry. The overflow is a real user decision, not a
 * failed suggestion: this service lists the related identities (metadata only)
 * and records either a group merge or an explicit keep. A merge re-runs the
 * source proposal on the current pool so the decision is checked again. */
import { safeId } from '../../storage';
import { readAbilityAssets, mergeAbilityAssetGroup, type MergeAssetGroupReceipt } from './asset-service';
import {
  markRelatedOverflowResolution,
  readRecallCapture,
  readRecallNightlySweep,
  requestCaptureReformation,
  type CaptureRelatedResolution,
  type RecallCaptureRecord,
} from './capture-service';
import type { AbilityAssetType, RecallAbilityAssetRecord } from './candidate-service';
import { filterRecallAssetsForAgentRead } from './prompt-injection';

export interface RelatedOverflowAssetView {
  id: string;
  title: string;
  version: string;
  status: RecallAbilityAssetRecord['status'] | 'missing';
  type?: AbilityAssetType;
  scope?: string;
  readable: boolean;
}

export type RelatedOverflowReformationState = 'none' | 'running' | 'failed' | 'requested';

export interface RelatedOverflowItem {
  captureId: string;
  conversationId: string;
  conversationTitle?: string;
  candidateIndex: number;
  relatedAssetIds: string[];
  assets: RelatedOverflowAssetView[];
  resolution?: CaptureRelatedResolution;
  reformation: { status: RelatedOverflowReformationState; requestedAt?: string; error?: string };
  /** The owning capture carries a frozen source proposal that can be rejudged. */
  reformable: boolean;
  /** The capture record could not be read; only the receipt identities remain. */
  captureUnavailable?: boolean;
}

export interface RelatedOverflowList {
  runId: string;
  items: RelatedOverflowItem[];
  stale?: boolean;
}

type CaptureSourceScope = NonNullable<RecallCaptureRecord['formationCheckpoint']>['sourceScope'];

function activeVersionOf(asset: RecallAbilityAssetRecord): string {
  return String(asset.activeVersion || asset.version || '1');
}

function overflowItemKey(item: Pick<RelatedOverflowItem, 'captureId' | 'candidateIndex'>): string {
  return `${item.captureId}:${item.candidateIndex}`;
}

function reformationState(
  capture: RecallCaptureRecord | undefined,
  resolution: CaptureRelatedResolution | undefined,
): RelatedOverflowItem['reformation'] {
  if (!resolution || resolution.action !== 'merged') return { status: 'none' };
  const checkpoint = capture?.formationCheckpoint;
  if (checkpoint?.reformationError) {
    return { status: 'failed', requestedAt: checkpoint.reformationRequestedAt, error: checkpoint.reformationError };
  }
  if (capture && ['queued', 'extracting', 'writing'].includes(capture.status)) {
    return { status: 'running', requestedAt: checkpoint?.reformationRequestedAt };
  }
  // A merged resolution that still owns a pending overflow entry means the
  // re-check never settled. Keep it retryable instead of pretending it ran.
  return { status: 'failed', requestedAt: checkpoint?.reformationRequestedAt, error: 'reformation_not_completed' };
}

async function readableAssetIds(
  userId: string,
  records: readonly RecallAbilityAssetRecord[],
  sourceScope: CaptureSourceScope | undefined,
): Promise<Set<string>> {
  const candidates = records.filter(asset => asset.ownerId === userId && asset.status === 'active');
  if (!candidates.length) return new Set();
  const readable = await filterRecallAssetsForAgentRead(userId, candidates, sourceScope || {});
  return new Set(readable.map(asset => asset.id));
}

async function buildAssetViews(
  userId: string,
  assetIds: readonly string[],
  sourceScope: CaptureSourceScope | undefined,
): Promise<RelatedOverflowAssetView[]> {
  const ids = [...new Set(assetIds.filter(id => typeof id === 'string' && safeId(id)))];
  if (!ids.length) return [];
  // Metadata and access eligibility only; statements never leave this layer.
  const records = await readAbilityAssets(userId, ids);
  const byId = new Map(records.map(asset => [asset.id, asset]));
  const readable = await readableAssetIds(userId, records, sourceScope);
  return ids.map(id => {
    const asset = byId.get(id);
    if (!asset) return { id, title: id, version: '', status: 'missing', readable: false };
    return {
      id,
      title: String(asset.title || id),
      version: activeVersionOf(asset),
      status: asset.status,
      type: asset.type,
      scope: asset.scope,
      readable: readable.has(id),
    };
  });
}

async function readCaptureSafely(userId: string, captureId: string): Promise<RecallCaptureRecord | undefined> {
  try {
    return await readRecallCapture(userId, captureId);
  } catch {
    return undefined;
  }
}

/** List overflow decisions from the latest sweep receipt. Capture support
 * entries are authoritative for candidate index, identities and resolution. */
export async function listRelatedOverflow(
  userId: string,
  input: { runId?: string } = {},
): Promise<RelatedOverflowList> {
  const sweep = await readRecallNightlySweep(userId);
  const receipt = sweep?.receipt;
  if (!receipt) return { runId: '', items: [] };
  const runId = String(receipt.runId || '');
  if (input.runId && String(input.runId) !== runId) {
    return { runId, items: [], stale: true };
  }
  const overflowReceipts = (receipt.items || []).filter(item =>
    item.errorCode === 'related_assets_overflow'
    || (item.failures || []).some(failure => failure.reason === 'related_assets_overflow'));
  if (!overflowReceipts.length) return { runId, items: [] };

  const items: RelatedOverflowItem[] = [];
  for (const receiptItem of overflowReceipts) {
    const captureId = String(receiptItem.captureId || '');
    if (!safeId(captureId)) continue;
    const capture = await readCaptureSafely(userId, captureId);
    if (capture) {
      const support = (capture.candidateSupportUnavailable || [])
        .filter(row => row.reason === 'related_assets_overflow');
      // A capture with no overflow entry has already been re-formed on the
      // current pool; the old sweep receipt is history, not a pending task.
      for (const row of support) {
        const relatedAssetIds = [...new Set((row.relatedAssetIds || []).map(String).filter(Boolean))];
        if (!relatedAssetIds.length) continue;
        items.push({
          captureId,
          conversationId: String(capture.conversationId || receiptItem.conversationId || ''),
          ...(capture.conversationTitle ? { conversationTitle: capture.conversationTitle } : {}),
          candidateIndex: row.candidateIndex,
          relatedAssetIds,
          assets: await buildAssetViews(userId, relatedAssetIds, capture.formationCheckpoint?.sourceScope),
          ...(row.relatedResolution ? { resolution: row.relatedResolution } : {}),
          reformation: reformationState(capture, row.relatedResolution),
          // Legacy captures without the frozen proposal can accept a keep
          // decision but cannot rejudge a merge; do not offer a dead merge.
          reformable: capture.formationCheckpoint?.sourceProposalVersion === 1,
        });
      }
      continue;
    }
    // Capture gone: keep the receipt identities visible as unreadable history,
    // never as an actionable decision.
    for (const failure of receiptItem.failures || []) {
      if (failure.reason !== 'related_assets_overflow' || !failure.relatedAssetIds?.length) continue;
      const relatedAssetIds = [...new Set(failure.relatedAssetIds.map(String).filter(Boolean))];
      items.push({
        captureId,
        conversationId: String(receiptItem.conversationId || ''),
        candidateIndex: failure.candidateIndex,
        relatedAssetIds,
        assets: await buildAssetViews(userId, relatedAssetIds, undefined),
        reformation: { status: 'none' },
        reformable: false,
        captureUnavailable: true,
      });
    }
  }
  const deduped = new Map(items.map(item => [overflowItemKey(item), item]));
  return { runId, items: [...deduped.values()] };
}

export class RelatedOverflowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RelatedOverflowError';
    this.code = code;
  }
}

export interface ResolveRelatedOverflowInput {
  captureId: string;
  candidateIndex: number;
  action: 'merge' | 'keep';
  targetAssetId?: string;
}

export interface ResolveRelatedOverflowResult {
  ok: boolean;
  captureId: string;
  candidateIndex: number;
  alreadyResolved: boolean;
  resolution?: CaptureRelatedResolution;
  merge?: {
    targetAssetId: string;
    targetVersion?: string;
    receipts: MergeAssetGroupReceipt[];
    merged: number;
    skipped: number;
  };
  reformation: { status: 'none' | 'running' | 'failed'; error?: string };
}

function overflowSupport(capture: RecallCaptureRecord, candidateIndex: number) {
  return (capture.candidateSupportUnavailable || [])
    .find(row => row.candidateIndex === candidateIndex && row.reason === 'related_assets_overflow');
}

async function sourceRecords(userId: string, ids: readonly string[]): Promise<Map<string, RecallAbilityAssetRecord>> {
  const records = await readAbilityAssets(userId, [...ids]);
  return new Map(records.map(record => [record.id, record]));
}

/** Merge compatible related assets into the chosen target and re-check the
 * source proposal. Incompatible identities are reported and left untouched. */
export async function resolveRelatedOverflow(
  userId: string,
  input: ResolveRelatedOverflowInput,
): Promise<ResolveRelatedOverflowResult> {
  if (!safeId(input.captureId)) throw new RelatedOverflowError('invalid_capture', 'invalid recall capture id');
  if (!Number.isInteger(input.candidateIndex) || input.candidateIndex < 0)
    throw new RelatedOverflowError('invalid_candidate_index', 'invalid candidate index');
  if (input.action !== 'merge' && input.action !== 'keep')
    throw new RelatedOverflowError('invalid_action', 'invalid related overflow action');

  const capture = await readRecallCapture(userId, input.captureId);
  const support = overflowSupport(capture, input.candidateIndex);
  if (!support) {
    // A successful re-formation replaces the support entry. Repeating the same
    // decision must stay a no-op rather than creating a second merge.
    return {
      ok: true,
      captureId: capture.id,
      candidateIndex: input.candidateIndex,
      alreadyResolved: true,
      reformation: { status: 'none' },
    };
  }
  const relatedAssetIds = [...new Set((support.relatedAssetIds || []).map(String).filter(Boolean))];
  if (!relatedAssetIds.length)
    throw new RelatedOverflowError('related_assets_missing', 'related overflow has no asset identities');
  const existing = support.relatedResolution;

  if (input.action === 'keep') {
    if (existing?.action === 'merged')
      throw new RelatedOverflowError('already_merged', 'related overflow was already merged');
    if (existing?.action === 'kept') {
      return {
        ok: true,
        captureId: capture.id,
        candidateIndex: input.candidateIndex,
        alreadyResolved: true,
        resolution: existing,
        reformation: { status: 'none' },
      };
    }
    const resolution: CaptureRelatedResolution = { action: 'kept', at: new Date().toISOString() };
    await markRelatedOverflowResolution(userId, capture.id, input.candidateIndex, resolution);
    return {
      ok: true,
      captureId: capture.id,
      candidateIndex: input.candidateIndex,
      alreadyResolved: false,
      resolution,
      reformation: { status: 'none' },
    };
  }

  const targetAssetId = String(input.targetAssetId || '');
  if (!safeId(targetAssetId) || !relatedAssetIds.includes(targetAssetId))
    throw new RelatedOverflowError('target_not_listed', 'merge target is not in the related list');
  if (existing?.action === 'kept')
    throw new RelatedOverflowError('already_kept', 'related overflow was kept without merging');
  if (existing?.action === 'merged' && existing.targetAssetId !== targetAssetId)
    throw new RelatedOverflowError('already_merged_elsewhere', 'related overflow was merged into another target');

  if (!existing) {
    if (!['review_ready', 'completed', 'partial', 'failed', 'no_candidate'].includes(capture.status))
      throw new RelatedOverflowError('capture_not_reformable', 'capture is not in a reformable state');
    // The merge is only offered when the owning capture can rejudge the
    // suggestion from its frozen source proposal. Never merge assets into a
    // legacy capture that would then be stuck on "re-check failed" forever.
    if (capture.formationCheckpoint?.sourceProposalVersion !== 1)
      throw new RelatedOverflowError('capture_not_reformable', 'capture has no frozen source proposal to rejudge');
    const views = await buildAssetViews(userId, relatedAssetIds, capture.formationCheckpoint?.sourceScope);
    const targetView = views.find(view => view.id === targetAssetId);
    if (!targetView?.readable)
      throw new RelatedOverflowError('target_unreadable', 'merge target is not readable');
    const recordMap = await sourceRecords(userId, relatedAssetIds);
    const expectedVersions: Record<string, string> = {};
    for (const id of relatedAssetIds) {
      const record = recordMap.get(id);
      if (record) expectedVersions[id] = activeVersionOf(record);
    }
    const sourceAssetIds = relatedAssetIds.filter(id => id !== targetAssetId);
    if (!sourceAssetIds.length)
      throw new RelatedOverflowError('related_assets_missing', 'related overflow has no mergeable sources');
    const group = await mergeAbilityAssetGroup(userId, {
      sourceAssetIds,
      targetAssetId,
      expectedVersions,
      expectedTargetVersion: expectedVersions[targetAssetId],
      // Overflow cleanup never guesses across type or scope boundaries.
      allowPartial: true,
    }, { actor: 'user', reason: '合并关联超过上限的认知并重新核对' });
    const after = await sourceRecords(userId, sourceAssetIds);
    const receipts: MergeAssetGroupReceipt[] = group.receipts.map(receipt => {
      if (receipt.status === 'merged') return receipt;
      // A crash after the write but before the resolution receipt makes a retry
      // see `already_merged`. Treat a confirmed merge into this target as done.
      if (receipt.reason === 'already_merged' && after.get(receipt.sourceAssetId)?.mergedIntoAssetId === targetAssetId)
        return { ...receipt, status: 'merged' as const, targetVersion: receipt.targetVersion || group.targetVersion };
      return receipt;
    });
    const merged = receipts.filter(receipt => receipt.status === 'merged').length;
    if (!merged) {
      return {
        ok: false,
        captureId: capture.id,
        candidateIndex: input.candidateIndex,
        alreadyResolved: false,
        merge: { targetAssetId, targetVersion: group.targetVersion, receipts,
          merged: 0, skipped: receipts.filter(receipt => receipt.status !== 'merged').length },
        reformation: { status: 'none' },
      };
    }
    const resolution: CaptureRelatedResolution = {
      action: 'merged',
      targetAssetId,
      ...(group.targetVersion ? { targetVersion: group.targetVersion } : {}),
      at: new Date().toISOString(),
      receipts: receipts.map(({ sourceAssetId, status, reason, targetVersion }) => ({
        sourceAssetId, status, ...(reason ? { reason } : {}), ...(targetVersion ? { targetVersion } : {}),
      })),
    };
    await markRelatedOverflowResolution(userId, capture.id, input.candidateIndex, resolution);
    const reformation = await triggerReformation(userId, capture.id, input.candidateIndex);
    return {
      ok: true,
      captureId: capture.id,
      candidateIndex: input.candidateIndex,
      alreadyResolved: false,
      resolution,
      merge: { targetAssetId, targetVersion: group.targetVersion, receipts,
        merged, skipped: receipts.filter(receipt => receipt.status !== 'merged').length },
      reformation,
    };
  }

  // Already merged: never merge twice; retrying only re-queues the re-check.
  const reformation = await triggerReformation(userId, capture.id, input.candidateIndex);
  return {
    ok: true,
    captureId: capture.id,
    candidateIndex: input.candidateIndex,
    alreadyResolved: true,
    resolution: existing,
    reformation,
  };
}

async function triggerReformation(
  userId: string,
  captureId: string,
  candidateIndex: number,
): Promise<ResolveRelatedOverflowResult['reformation']> {
  try {
    const result = await requestCaptureReformation(userId, captureId, {
      groupIndexes: [candidateIndex],
      reason: 'related_overflow',
      runNow: false,
    });
    if (['failed', 'configuration_required', 'cancelled'].includes(result.capture.status))
      return { status: 'failed', ...(result.error ? { error: result.error } : {}) };
    return { status: 'running' };
  } catch {
    // A queued/running re-check is still success for the caller; re-clicking
    // must not turn an in-flight reformation into a failure.
    try {
      const latest = await readRecallCapture(userId, captureId);
      if (['queued', 'extracting', 'writing'].includes(latest.status)) return { status: 'running' };
    } catch { /* fall through to the recorded failure */ }
    return { status: 'failed', error: 'reformation_request_failed' };
  }
}
