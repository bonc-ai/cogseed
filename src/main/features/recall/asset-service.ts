import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import { normalizeCognitionSourceRefs } from './source-service';
import { appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import { normalizeAbilityAssetOntologyRefs } from './ontology-refs';
import type { RecallAbilityAssetRecord, RecallAbilityAssetLifecycleStatus } from './candidate-service';
import { normalizeAbilityAssetScopePolicy, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';

export type AbilityAssetActor = 'user' | 'system';
export type AbilityAssetRecommendedAction = 'pause' | 'rework';

export interface AbilityAssetVersionRecord extends RecallJsonRecord {
  assetId: string;
  version: string;
  at: string;
  reason?: string;
  actor?: AbilityAssetActor;
  snapshot: Pick<RecallAbilityAssetRecord, 'title' | 'statement' | 'type' | 'scope' | 'scopePolicy' | 'evidenceRefs' | 'status' | 'maturity' | 'version' | 'learningSignal' | 'ontologyRefs'>;
}

export interface AbilityAssetAuditRecord extends RecallJsonRecord {
  assetId: string;
  action: 'created' | 'updated' | 'paused' | 'resumed' | 'revoked' | 'pause_recommended' | 'rework_recommended' | 'recommendation_cleared';
  at: string;
  actor?: AbilityAssetActor;
  note?: string;
}

export interface UpdateAbilityAssetInput {
  title?: string;
  statement?: string;
  scope?: string;
  scopePolicy?: RecallAbilityAssetScopePolicy;
  type?: RecallAbilityAssetRecord['type'];
  evidenceRefs?: RecallAbilityAssetRecord['evidenceRefs'];
  ontologyRefs?: RecallAbilityAssetRecord['ontologyRefs'];
  reason: string;
  actor: AbilityAssetActor;
  acknowledgeRecommendation?: boolean;
  reviewDecisionId?: string;
  sourceCandidateId?: string;
  id?: never;
  ownerId?: never;
}

export interface AbilityAssetUserActionInput {
  actor: AbilityAssetActor;
  reason: string;
  reviewDecisionId?: string;
  sourceCandidateId?: string;
}

export interface RecommendAbilityAssetActionInput {
  action: AbilityAssetRecommendedAction;
  reason: string;
  actor: AbilityAssetActor;
}

export interface CreateAbilityAssetInput extends RecallAbilityAssetRecord {}

function assetsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'ability-assets', 'placeholder'));
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string' ||
    (value.status !== 'active' && value.status !== 'paused' && value.status !== 'revoked')
  ) throw new Error('malformed recall ability asset');
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  if (!evidenceRefs.length) throw new Error('malformed recall ability asset evidence');
  const ontologyRefs = value.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(value.ontologyRefs);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  const recommendedAction = value.recommendedAction;
  if (recommendedAction !== undefined && recommendedAction !== 'pause' && recommendedAction !== 'rework') throw new Error('malformed recall ability asset recommendation');
  if (recommendedAction !== undefined && (typeof value.recommendationReason !== 'string' || !value.recommendationReason.trim() || typeof value.recommendationAt !== 'string')) throw new Error('malformed recall ability asset recommendation');
  const sourceCandidateIds = Array.isArray(value.sourceCandidateIds)
    ? [...new Set(value.sourceCandidateIds.filter((id): id is string => typeof id === 'string' && safeId(id)))]
    : [value.candidateId as string];
  const appliedReviewDecisionIds = Array.isArray(value.appliedReviewDecisionIds)
    ? [...new Set(value.appliedReviewDecisionIds.filter((id): id is string => typeof id === 'string' && /^rd_[A-Za-z0-9_-]{8,64}$/.test(id)))]
    : [];
  const lifecycleStatus: RecallAbilityAssetLifecycleStatus = value.lifecycleStatus === 'automatically_extracted_unverified'
    ? 'automatically_extracted_unverified'
    : 'user_confirmed_unverified';
  return {
    ...value,
    reviewDecisionId: typeof value.reviewDecisionId === 'string' ? value.reviewDecisionId : 'legacy-untracked',
    lifecycleStatus,
    sourceCandidateIds,
    appliedReviewDecisionIds,
    evidenceRefs,
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...(scopePolicy ? { scopePolicy } : {}),
  } as RecallAbilityAssetRecord;
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid ability asset ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid ability asset ${field}`);
  return text;
}

function requireAssetAction(input: unknown): AbilityAssetUserActionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('ability asset action requires an actor');
  const record = input as Record<string, unknown>;
  if (record.actor !== 'user' && record.actor !== 'system') {
    throw new Error('ability asset action requires a user actor or system actor');
  }
  return { actor: record.actor, reason: bounded(record.reason, 'reason', 1_000) };
}

function nextVersion(version: string): string {
  const current = Number(version);
  if (!Number.isSafeInteger(current) || current < 1) throw new Error('invalid ability asset version');
  return String(current + 1);
}

function snapshot(asset: RecallAbilityAssetRecord): AbilityAssetVersionRecord['snapshot'] {
  return {
    title: asset.title,
    statement: asset.statement,
    type: asset.type,
    scope: asset.scope,
    ...(asset.scopePolicy ? { scopePolicy: asset.scopePolicy } : {}),
    evidenceRefs: asset.evidenceRefs,
    ...(asset.learningSignal ? { learningSignal: asset.learningSignal } : {}),
    ...(asset.ontologyRefs ? { ontologyRefs: asset.ontologyRefs } : {}),
    status: asset.status,
    maturity: asset.maturity,
    version: asset.version,
  };
}

function asVersion(value: RecallJsonRecord): AbilityAssetVersionRecord {
  const rawSnapshot = value.snapshot;
  if (typeof value.assetId !== 'string' || typeof value.version !== 'string' || typeof value.at !== 'string' || !rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) throw new Error('malformed recall ability asset version');
  const versionSnapshot = rawSnapshot as Record<string, unknown>;
  if (!Array.isArray(versionSnapshot.evidenceRefs)) throw new Error('malformed recall ability asset version evidence');
  const scopePolicy = normalizeAbilityAssetScopePolicy(versionSnapshot.scopePolicy);
  return {
    ...value,
    snapshot: {
      ...versionSnapshot,
      ...(scopePolicy ? { scopePolicy } : {}),
      evidenceRefs: normalizeCognitionSourceRefs(versionSnapshot.evidenceRefs),
    },
  } as AbilityAssetVersionRecord;
}

async function appendVersion(userId: string, asset: RecallAbilityAssetRecord, metadata: { reason?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-versions', asset.id, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${asset.id}-v${asset.version}`,
    assetId: asset.id,
    version: asset.version,
    at,
    ...(metadata.reason ? { reason: metadata.reason } : {}),
    ...(metadata.actor ? { actor: metadata.actor } : {}),
    snapshot: snapshot(asset),
  } satisfies AbilityAssetVersionRecord);
}

async function appendAudit(userId: string, assetId: string, action: AbilityAssetAuditRecord['action'], metadata: { note?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const at = new Date().toISOString();
  await appendRecallJsonlRecord(userId, 'ability-asset-audit', assetId, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${assetId}-${action}-${at.replace(/[^A-Za-z0-9]/g, '')}`,
    assetId,
    action,
    at,
    ...(metadata.actor ? { actor: metadata.actor } : {}),
    ...(metadata.note ? { note: metadata.note } : {}),
  } satisfies AbilityAssetAuditRecord);
}

export async function initializeAbilityAsset(userId: string, asset: RecallAbilityAssetRecord, metadata: { reason?: string; actor?: AbilityAssetActor } = {}): Promise<void> {
  const current = await listAbilityAssetVersions(userId, asset.id);
  if (!current.length) await appendVersion(userId, asset, metadata);
  const audit = await listAbilityAssetAudit(userId, asset.id);
  if (!audit.length) await appendAudit(userId, asset.id, 'created', metadata.reason || metadata.actor ? { note: metadata.reason, actor: metadata.actor } : {});
}

/** Formal-asset persistence boundary used by the candidate confirmation gate. */
export async function createAbilityAsset(
  userId: string,
  input: CreateAbilityAssetInput,
  metadata: { reason: string; actor: AbilityAssetActor },
): Promise<RecallAbilityAssetRecord> {
  if (metadata.actor !== 'user' && metadata.actor !== 'system') throw new Error('invalid ability asset creation actor');
  bounded(metadata.reason, 'reason', 1_000);
  assertNotForbiddenToPersist([
    input.title,
    input.statement,
    input.scope,
    JSON.stringify(input.evidenceRefs),
    input.learningSignal ? JSON.stringify(input.learningSignal) : undefined,
  ]);
  const validated = asAsset(input);
  if (validated.ownerId !== userId) throw new Error('ability asset owner mismatch');
  if (!safeId(validated.candidateId) || !/^rd_[A-Za-z0-9_-]{8,64}$/.test(validated.reviewDecisionId)) {
    throw new Error('invalid ability asset handoff identity');
  }
  const expectedLifecycle: RecallAbilityAssetLifecycleStatus = metadata.actor === 'system'
    ? 'automatically_extracted_unverified'
    : 'user_confirmed_unverified';
  if (validated.lifecycleStatus !== expectedLifecycle || validated.maturity !== 'seed' || validated.version !== '1') {
    throw new Error('invalid initial ability asset lifecycle');
  }
  const stored = asAsset(await updateRecallJsonRecord(
    userId,
    'ability-assets',
    validated.id,
    (current) => current || validated,
  ));
  if (stored.candidateId !== validated.candidateId || stored.reviewDecisionId !== validated.reviewDecisionId) {
    throw new Error('ability asset idempotency identity mismatch');
  }
  await initializeAbilityAsset(userId, stored, metadata);
  return stored;
}

export async function readAbilityAsset(userId: string, assetId: string): Promise<RecallAbilityAssetRecord> {
  const raw = await readRecallJsonRecord(userId, 'ability-assets', assetId);
  if (!raw) throw new Error('recall ability asset not found');
  return asAsset(raw);
}

export async function listAbilityAssets(userId: string): Promise<RecallAbilityAssetRecord[]> {
  let names: string[];
  try { names = await fs.readdir(assetsDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names.filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5))).map((name) => readRecallJsonRecord(userId, 'ability-assets', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asAsset).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function updateAbilityAsset(userId: string, assetId: string, input: UpdateAbilityAssetInput): Promise<RecallAbilityAssetRecord> {
  if ('id' in input || 'ownerId' in input) throw new Error('ability asset identity is immutable');
  const action = requireAssetAction(input);
  const evidenceRefs = input.evidenceRefs === undefined ? undefined : normalizeCognitionSourceRefs(input.evidenceRefs);
  if (evidenceRefs && !evidenceRefs.length) throw new Error('ability asset evidence is required');
  const ontologyRefs = input.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(input.ontologyRefs);
  const scopePolicy = input.scopePolicy === undefined ? undefined : normalizeAbilityAssetScopePolicy(input.scopePolicy);
  const reviewDecisionId = input.reviewDecisionId;
  const sourceCandidateId = input.sourceCandidateId;
  if ((reviewDecisionId === undefined) !== (sourceCandidateId === undefined)) throw new Error('incomplete ability asset review handoff');
  if (reviewDecisionId !== undefined && !/^rd_[A-Za-z0-9_-]{8,64}$/.test(reviewDecisionId)) throw new Error('invalid ability asset review decision');
  if (sourceCandidateId !== undefined && !safeId(sourceCandidateId)) throw new Error('invalid ability asset source candidate');
  if (action.actor === 'system' && reviewDecisionId === undefined) {
    throw new Error('system asset action requires an automatic review handoff');
  }
  assertNotForbiddenToPersist([
    input.title,
    input.statement,
    input.scope,
  ]);
  let clearedRecommendation = false;
  let changed = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (current.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    changed = true;
    clearedRecommendation = Boolean(current.recommendedAction && input.acknowledgeRecommendation);
    const next: RecallAbilityAssetRecord = {
      ...current,
      ...(input.title !== undefined ? { title: bounded(input.title, 'title', 120) } : {}),
      ...(input.statement !== undefined ? { statement: bounded(input.statement, 'statement', 4_000) } : {}),
      ...(input.scope !== undefined ? { scope: bounded(input.scope, 'scope', 500) } : {}),
      ...(scopePolicy !== undefined ? { scopePolicy } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
      ...(ontologyRefs !== undefined ? { ontologyRefs } : {}),
      version: nextVersion(current.version),
      ...(reviewDecisionId ? {
        appliedReviewDecisionIds: [...new Set([...(current.appliedReviewDecisionIds || []), reviewDecisionId])],
        sourceCandidateIds: [...new Set([...(current.sourceCandidateIds || [current.candidateId]), sourceCandidateId!])],
        reviewDecisionId,
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (clearedRecommendation) {
      delete next.recommendedAction;
      delete next.recommendationReason;
      delete next.recommendationAt;
    }
    return next;
  });
  const asset = asAsset(updated);
  if (changed) {
    await appendVersion(userId, asset, { reason: action.reason, actor: action.actor });
    await appendAudit(userId, asset.id, 'updated', { note: action.reason, actor: action.actor });
    if (clearedRecommendation) await appendAudit(userId, asset.id, 'recommendation_cleared', { note: action.reason, actor: action.actor });
  }
  return asset;
}

async function setStatus(userId: string, assetId: string, status: RecallAbilityAssetRecord['status'], input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  const action = requireAssetAction(input);
  const reviewDecisionId = input.reviewDecisionId;
  const sourceCandidateId = input.sourceCandidateId;
  if ((reviewDecisionId === undefined) !== (sourceCandidateId === undefined)) throw new Error('incomplete ability asset review handoff');
  if (reviewDecisionId !== undefined && !/^rd_[A-Za-z0-9_-]{8,64}$/.test(reviewDecisionId)) throw new Error('invalid ability asset review decision');
  if (sourceCandidateId !== undefined && !safeId(sourceCandidateId)) throw new Error('invalid ability asset source candidate');
  if (action.actor === 'system' && reviewDecisionId === undefined) {
    throw new Error('system asset action requires an automatic review handoff');
  }
  let clearedRecommendation = false;
  let changed = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (current.status === 'revoked' && status !== 'revoked') throw new Error('revoked ability asset cannot be changed');
    if (reviewDecisionId && current.appliedReviewDecisionIds?.includes(reviewDecisionId)) return current;
    changed = current.status !== status || Boolean(reviewDecisionId);
    clearedRecommendation = Boolean(current.recommendedAction && (status === 'paused' || status === 'revoked'));
    const next: RecallAbilityAssetRecord = {
      ...current,
      status,
      ...(reviewDecisionId ? {
        appliedReviewDecisionIds: [...new Set([...(current.appliedReviewDecisionIds || []), reviewDecisionId])],
        sourceCandidateIds: [...new Set([...(current.sourceCandidateIds || [current.candidateId]), sourceCandidateId!])],
        reviewDecisionId,
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (clearedRecommendation) {
      delete next.recommendedAction;
      delete next.recommendationReason;
      delete next.recommendationAt;
    }
    return next;
  });
  const asset = asAsset(updated);
  if (changed) {
    await appendAudit(userId, asset.id, status === 'paused' ? 'paused' : status === 'active' ? 'resumed' : 'revoked', { note: action.reason, actor: action.actor });
    if (clearedRecommendation) await appendAudit(userId, asset.id, 'recommendation_cleared', { note: action.reason, actor: action.actor });
  }
  return asset;
}

export function pauseAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'paused', input);
}

export function revokeAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'revoked', input);
}

export function resumeAbilityAsset(userId: string, assetId: string, input: AbilityAssetUserActionInput): Promise<RecallAbilityAssetRecord> {
  return setStatus(userId, assetId, 'active', input);
}

export async function recommendAbilityAssetAction(userId: string, assetId: string, input: RecommendAbilityAssetActionInput): Promise<RecallAbilityAssetRecord> {
  if (input.action !== 'pause' && input.action !== 'rework') throw new Error('invalid ability asset recommendation');
  const reason = bounded(input.reason, 'recommendation reason', 1_000);
  const actor = input.actor === 'system' ? 'system' : input.actor === 'user' ? 'user' : undefined;
  if (!actor) throw new Error('invalid ability asset recommendation actor');
  let appended = false;
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    if (current.status === 'revoked') throw new Error('revoked ability asset cannot be changed');
    if (current.recommendedAction === input.action && current.recommendationReason === reason) return current;
    appended = true;
    return { ...current, recommendedAction: input.action, recommendationReason: reason, recommendationAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  });
  const asset = asAsset(updated);
  if (appended) await appendAudit(userId, asset.id, input.action === 'pause' ? 'pause_recommended' : 'rework_recommended', { note: reason, actor });
  return asset;
}

export async function listAbilityAssetVersions(userId: string, assetId: string): Promise<AbilityAssetVersionRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-versions', assetId, 0)).map(asVersion);
}

export async function listAbilityAssetAudit(userId: string, assetId: string): Promise<AbilityAssetAuditRecord[]> {
  return (await listRecallJsonlRecords(userId, 'ability-asset-audit', assetId, 0)) as AbilityAssetAuditRecord[];
}

export async function setAbilityAssetMaturity(userId: string, assetId: string, maturity: RecallAbilityAssetRecord['maturity']): Promise<RecallAbilityAssetRecord> {
  const updated = await updateRecallJsonRecord(userId, 'ability-assets', assetId, (raw) => {
    if (!raw) throw new Error('recall ability asset not found');
    const current = asAsset(raw);
    return { ...current, maturity, updatedAt: new Date().toISOString() };
  });
  return asAsset(updated);
}
