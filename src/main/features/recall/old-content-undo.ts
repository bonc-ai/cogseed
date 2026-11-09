/** Whole-plan undo: reverse every applied unit in one write, keeping history.
 * The execution receipts carry the before/after fingerprints and the reference
 * set observed at execution time; any later change blocks the undo. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withCognitionSourceDependency, withCognitionTransition } from '../cognition_bridge';
import { writeReviewDecision } from '../cognition/review-decision';
import { createLogger } from '../../logger';
import { listAbilityAssets, readAbilityAsset, readAbilityAssetVersionSnapshot,
  reconcilePersonalProfileProjection } from './asset-service';
import { withAssetVersionMetadata, withPendingAssetVersion } from './asset-version-journal';
import { collectOldContentReferences, oldContentAssetFingerprint, readOldContentPlan,
  saveOldContentPlan } from './old-content-plan-service';
import { type OldContentAssetFingerprint, type OldContentPlanRecord,
  type OldContentPlanStatus } from './old-content-plan-contract';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { notifyCognitionWrite } from './store-events';
import type { RecallAbilityAssetRecord } from './candidate-service';
import type { RecallJsonRecord } from './types';

const log = createLogger('recall.old-content-undo');
const clean = (row: Record<string, unknown>) => {
  const { pendingVersionSnapshots: _pending, ...rest } = row;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface AffectedAsset {
  assetId: string;
  before: OldContentAssetFingerprint;
  after: OldContentAssetFingerprint;
  referencedBy: string[];
}
interface PreparedUndo {
  token: string;
  effects: Array<{ assetId: string; title: string; before: OldContentAssetFingerprint; after: OldContentAssetFingerprint }>;
  blockers: string[];
  alreadyUndone: boolean;
}
export interface OldContentUndoPreview {
  planId: string;
  token: string;
  effects: PreparedUndo['effects'];
  blockers: string[];
  alreadyUndone: boolean;
}
export interface OldContentUndoResult {
  plan: OldContentPlanRecord;
  undone: boolean;
  duplicate?: boolean;
  blockers?: string[];
}

function affectedAssets(plan: OldContentPlanRecord): AffectedAsset[] {
  const affected = new Map<string, AffectedAsset>();
  for (const execution of plan.executions) {
    if (execution.undoneAt || !execution.snapshot) continue;
    for (const [assetId, before] of Object.entries(execution.snapshot.before)) {
      const after = execution.snapshot.after[assetId];
      if (!after) continue;
      affected.set(assetId, { assetId, before, after,
        referencedBy: execution.snapshot.referencedBy[assetId] || [] });
    }
  }
  return [...affected.values()];
}

async function prepareUndo(userId: string, plan: OldContentPlanRecord): Promise<PreparedUndo> {
  const assets = affectedAssets(plan);
  const titles = new Map((await listAbilityAssets(userId)).map(asset => [asset.id, asset.title]));
  const blockers: string[] = [];
  const effects: PreparedUndo['effects'] = [];
  const observedAt: Record<string, unknown> = {};
  let allBefore = true;
  for (const asset of assets) {
    let head: RecallAbilityAssetRecord;
    try {
      head = await readAbilityAsset(userId, asset.assetId);
    } catch {
      blockers.push(`asset_missing:${asset.assetId}`);
      allBefore = false;
      continue;
    }
    if (head.status === 'purged') {
      blockers.push(`asset_purged:${asset.assetId}`);
      allBefore = false;
      continue;
    }
    const current = oldContentAssetFingerprint(head);
    // `same_family` is system-attached on ingest (for example by the new
    // suggestion saved after the cleanup); it never blocks restoring content.
    const references = (await collectOldContentReferences(userId, asset.assetId))
      .filter(reference => reference.relationKind !== 'same_family')
      .map(reference => `${reference.kind}:${reference.id}`).sort();
    observedAt[asset.assetId] = { current, references };
    const atAfter = isDeepStrictEqual(current, asset.after);
    const atBefore = isDeepStrictEqual(current, asset.before);
    if (!atAfter && !atBefore) { blockers.push(`changed_since:${asset.assetId}`); allBefore = false; }
    else if (atAfter && references.some(reference => !asset.referencedBy.includes(reference)))
      blockers.push(`referenced_since:${asset.assetId}`);
    if (!atBefore) allBefore = false;
    effects.push({ assetId: asset.assetId, title: titles.get(asset.assetId) || asset.assetId,
      before: asset.before, after: asset.after });
  }
  if (plan.status === 'undone') allBefore = true;
  return { token: hash({ planId: plan.id, executions: plan.executions.map(execution => execution.executionId),
    observedAt, status: plan.status }), effects, blockers, alreadyUndone: allBefore };
}

export async function previewOldContentUndo(userId: string, planId: string): Promise<OldContentUndoPreview> {
  const plan = await readOldContentPlan(userId, planId);
  if (!['applied', 'ready', 'needs_review'].includes(plan.status))
    throw new Error(`old-content plan cannot be undone: ${plan.status}`);
  const prepared = await prepareUndo(userId, plan);
  if (!prepared.effects.length && plan.status !== 'applied')
    throw new Error('old-content plan has nothing to undo');
  return { planId: plan.id, token: prepared.token, effects: prepared.effects,
    blockers: prepared.blockers, alreadyUndone: prepared.alreadyUndone };
}

function nextVersion(version: string): string {
  const value = Number(version);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid old-content undo version');
  return String(value + 1);
}

export async function undoOldContentPlan(userId: string, planId: string, token: string): Promise<OldContentUndoResult> {
  return withCognitionTransition(userId, async () => {
    const plan = await readOldContentPlan(userId, planId);
    if (plan.status === 'undone') return { plan, undone: true, duplicate: true };
    if (['dismissed', 'purged', 'superseded'].includes(plan.status))
      throw new Error(`old-content plan cannot be undone: ${plan.status}`);
    const prepared = await prepareUndo(userId, plan);
    if (!prepared.effects.length && plan.status !== 'applied')
      throw new Error('old-content plan has nothing to undo');
    if (prepared.blockers.length) return { plan, undone: false, blockers: prepared.blockers };
    if (token !== prepared.token) throw new Error('old-content undo preview changed');
    const decision = await writeReviewDecision(userId, {
      targetRef: `old_content_plan:${plan.id}`, decisionType: 'modify', decision: 'undo_old_content_plan',
      actor: 'user', reason: '用户撤销旧内容整理。',
      idempotencyKey: `undo-old-content-${plan.id}-${prepared.token}`,
    });
    const now = new Date().toISOString();
    if (!prepared.alreadyUndone) {
      const rawHeads = new Map<string, RecallJsonRecord>();
      const nextRecords = new Map<string, RecallJsonRecord>();
      for (const asset of affectedAssets(plan)) {
        const raw = await readRecallJsonRecord(userId, 'ability-assets', asset.assetId);
        if (!raw) throw new Error('old-content undo asset missing');
        const head = await readAbilityAsset(userId, asset.assetId);
        if (!isDeepStrictEqual(oldContentAssetFingerprint(head), asset.after))
          throw new Error('old-content undo changed since preview');
        rawHeads.set(asset.assetId, raw);
        if (asset.before.version !== asset.after.version) {
          const snapshot = await readAbilityAssetVersionSnapshot(userId, asset.assetId, asset.before.activeVersion);
          if (!snapshot) throw new Error('old-content undo version unavailable');
          const next = { ...head, ...snapshot, version: nextVersion(String(head.version)),
            activeVersion: nextVersion(String(head.version)), status: asset.before.status, updatedAt: now };
          delete (next as Record<string, unknown>).pendingVersionSnapshots;
          nextRecords.set(asset.assetId,
            withPendingAssetVersion(raw, next as unknown as RecallJsonRecord) as unknown as RecallJsonRecord);
        } else {
          const next = { ...head, status: asset.before.status, updatedAt: now } as RecallAbilityAssetRecord & Record<string, unknown>;
          if (asset.before.status !== 'deleted') delete next.deletedAt;
          // A paused source restored to paused must not keep pointing at the
          // merge target, or later merges treat it as already merged.
          if (asset.before.status !== 'archived') delete next.mergedIntoAssetId;
          nextRecords.set(asset.assetId, next as unknown as RecallJsonRecord);
        }
      }
      const anchorId = [...nextRecords.keys()][0];
      const anchorAfter = nextRecords.get(anchorId);
      const anchorRaw = rawHeads.get(anchorId);
      if (!anchorId || !anchorAfter || !anchorRaw) throw new Error('old-content undo has no anchor');
      await withAssetVersionMetadata({ actor: 'user', reason: '撤销旧内容整理' }, () =>
        withCognitionSourceDependency(userId, 'ability-assets', (store) => {
          const records = store.compatibility!.records['ability-assets'];
          for (const [assetId, raw] of rawHeads) {
            if (!isDeepStrictEqual(clean(records[assetId] || {}), clean(raw)))
              throw new Error('old-content undo asset changed at commit');
          }
          for (const [assetId, next] of nextRecords) records[assetId] = next;
          return { records: { 'ability-assets': [...nextRecords.keys()] } };
        }, () => updateRecallJsonRecord(userId, 'ability-assets', anchorId, current => {
          if (!current || !isDeepStrictEqual(clean(current), clean(anchorRaw)))
            throw new Error('old-content undo asset changed at commit');
          return anchorAfter as RecallJsonRecord;
        })));
      for (const assetId of nextRecords.keys()) notifyCognitionWrite(userId, 'ability-assets', 'update', assetId);
    }
    // Undo already restored business state; a projection failure must not turn
    // a completed undo into an error, but it must still be repaired now.
    for (const asset of affectedAssets(plan)) {
      try {
        const head = await readAbilityAsset(userId, asset.assetId);
        if (head.type === 'personal') await reconcilePersonalProfileProjection(userId, head);
      } catch (error) {
        log.warn('old-content undo profile projection degraded', { assetId: asset.assetId,
          error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
      }
    }
    const executions = plan.executions.map(execution => execution.undoneAt ? execution
      : { ...execution, undoneAt: now, undoDecisionId: decision.decision_id,
        ...(execution.snapshot ? { audit: { state: 'pending' as const, attempts: 0 } } : {}) });
    const status: OldContentPlanStatus = plan.status === 'applied' ? 'undone'
      : plan.unresolved.some(item => !item.resolution) ? 'needs_review' : 'ready';
    const saved = await saveOldContentPlan(userId, { ...plan, executions, status,
      prepared: undefined, blockedReason: undefined, updatedAt: now });
    try {
      const { reconcileOldContentAudit } = await import('./old-content-audit');
      return { plan: await reconcileOldContentAudit(userId, plan.id), undone: true };
    } catch {
      // Business state is already undone; audit replay retries on the next read.
      return { plan: saved, undone: true };
    }
  });
}
