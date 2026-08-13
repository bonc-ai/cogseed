import * as fs from 'node:fs/promises';
import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { genId12, safeId } from '../../storage';
import { assertNotForbiddenToPersist } from '../../util/cognition-sensitivity';
import { recallJsonRecordPath } from './paths';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
  writeRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import type { KstarLearningSignal } from '../kstar/types';
import { normalizeAbilityAssetOntologyRefs, type AbilityAssetOntologyRef } from './ontology-refs';
import {
  readAbilityAssetRelationContract,
  type AbilityAssetRelation,
  type AbilityAssetRelationContract,
} from './asset-relations';
import { normalizeAbilityAssetScopePolicy, type RecallAbilityAssetScopePolicy } from './scope-policy';
import {
  createAbilityAsset,
  pauseAbilityAsset,
  readAbilityAsset,
  updateAbilityAsset,
} from './asset-service';
import { isCognitionSourceEnabled } from './source-control';
import {
  recordReviewDecisionOutcome,
  writeReviewDecision,
  type ReviewDecision,
} from '../cognition/review-decision';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
  type CognitionSourceType,
} from './source-service';

export type RecallCandidateStatus =
  | 'observed'
  | 'weak_observation'
  | 'pending_review'
  | 'deferred'
  | 'confirmed'
  | 'rejected'
  | 'ignored'
  | 'expired'
  | 'failed';
export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method';
export type RecallCandidateAction = 'create' | 'update' | 'limit_scope' | 'pause' | 'keep_current' | 'reject';
export type RecallCandidateRisk = 'low' | 'medium' | 'high';

const DEFAULT_CANDIDATE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_DEFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1_000;


export interface RecallCandidateRecord extends RecallJsonRecord {
  id: string;
  taxonomyVersion: 2;
  status: RecallCandidateStatus;
  judgment: string;
  /** Why retaining this cognition will be useful in later work. */
  value: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: CognitionSourceRef[];
  evidenceRefs: CognitionSourceRef[];
  suggestedAction: RecallCandidateAction;
  risk: RecallCandidateRisk;
  learningSignal?: KstarLearningSignal;
  captureKey?: string;
  promotedAssetId?: string;
  reviewDecisionId?: string;
  decisionNote?: string;
  cooldownUntil?: string;
  expiresAt: string;
  taskRunId?: string;
  targetAssetId?: string;
  failureCode?: 'asset_write_failed' | 'source_unavailable' | 'candidate_expired' | 'evidence_insufficient';
  failureMessage?: string;
  failedAt?: string;
  userModifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallAbilityAssetRecord extends RecallJsonRecord {
  id: string;
  candidateId: string;
  sourceCandidateIds?: string[];
  appliedReviewDecisionIds?: string[];
  reviewDecisionId: string;
  type: AbilityAssetType;
  title: string;
  statement: string;
  evidenceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  ontologyRefs?: AbilityAssetOntologyRef[];
  relations?: AbilityAssetRelation[];
  derivedFrom?: string[];
  scope: string;
  scopePolicy?: RecallAbilityAssetScopePolicy;
  recommendedAction?: 'pause' | 'rework';
  recommendationReason?: string;
  recommendationAt?: string;
  status: 'active' | 'paused' | 'archived' | 'deleted' | 'purged' | 'revoked';
  lifecycleStatus: 'user_confirmed_unverified';
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated' | 'stable';
  deletedAt?: string;
  purgedAt?: string;
  version: string;
  /** Provenance for assets learned from conversation sources. */
  sourceSessionIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveRecallCandidateInput {
  judgment: string;
  value?: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: unknown[];
  evidenceRefs?: unknown[];
  suggestedAction?: RecallCandidateAction;
  risk?: RecallCandidateRisk;
  expiresAt?: string;
  taskRunId?: string;
  targetAssetId?: string;
  learningSignal?: KstarLearningSignal;
  captureKey?: string;
}

export interface RecallAssetHandoffReceipt {
  assetId: string;
  assetType: AbilityAssetType;
  version: string;
  lifecycleStatus: 'user_confirmed_unverified';
  scope: string;
  sourceRefs: CognitionSourceRef[];
  reviewDecisionId: string;
}

interface StoredRecallAssetHandoffReceipt extends RecallJsonRecord, RecallAssetHandoffReceipt {
  id: string;
  candidateId: string;
  createdAt: string;
}

export interface PromoteRecallCandidateOptions {
  actor?: 'user';
  ontologyRefs?: AbilityAssetOntologyRef[];
  scopePolicy?: RecallAbilityAssetScopePolicy;
  decisionType?: 'accept' | 'modify';
  decisionId?: string;
  decisionReason?: string;
  riskAcknowledged?: boolean;
}

const MAX_SOURCE_SESSION_IDS = 50;

function sourceSessionIdsFrom(refs: CognitionSourceRef[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    if (ref.kind !== 'conversation' || ids.includes(ref.id)) continue;
    ids.push(ref.id);
    if (ids.length >= MAX_SOURCE_SESSION_IDS) break;
  }
  return ids;
}

function boundedText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (typeof value !== 'string') {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new Error(`missing ${field}`);
    return undefined;
  }
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}

function requireAssetType(value: unknown): AbilityAssetType {
  if (value === 'personal' || value === 'rule' || value === 'template' || value === 'skill_method') return value;
  throw new Error('invalid suggested type');
}

function requireCandidateAction(value: unknown): RecallCandidateAction {
  if (value === undefined) return 'create';
  if (value === 'create' || value === 'update' || value === 'limit_scope' || value === 'pause' || value === 'keep_current' || value === 'reject') return value;
  throw new Error('invalid suggested action');
}

function requireCandidateRisk(value: unknown): RecallCandidateRisk {
  if (value === undefined) return 'low';
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error('invalid candidate risk');
}

function normalizeCandidateStatus(value: unknown): RecallCandidateStatus {
  if (value === 'pending') return 'pending_review';
  if (value === 'promoted') return 'confirmed';
  if (value === 'observed' || value === 'weak_observation' || value === 'pending_review'
    || value === 'deferred' || value === 'confirmed' || value === 'rejected'
    || value === 'ignored' || value === 'expired' || value === 'failed') return value;
  throw new Error('malformed recall candidate');
}

function isTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'confirmed' || status === 'rejected' || status === 'ignored' || status === 'expired';
}

function isSuppressedTerminalCandidate(status: RecallCandidateStatus): boolean {
  return status === 'rejected' || status === 'ignored' || status === 'expired';
}

export function isRecallCandidateReviewable(candidate: Pick<RecallCandidateRecord, 'status'>): boolean {
  return candidate.status === 'pending_review' || candidate.status === 'failed';
}

function requireIsoTimestamp(value: unknown, field: string, fallback?: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!text || !Number.isFinite(Date.parse(text))) throw new Error(`invalid ${field}`);
  return new Date(text).toISOString();
}


function normalizeLearningSignal(value: unknown): KstarLearningSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('malformed candidate learning signal');
  const signal = value as Record<string, unknown>;
  if (
    (signal.expectedResult !== undefined && typeof signal.expectedResult !== 'string') ||
    (signal.actualResult !== undefined && typeof signal.actualResult !== 'string') ||
    (signal.deltaR !== 'unknown' && (typeof signal.deltaR !== 'number' || !Number.isFinite(signal.deltaR))) ||
    (signal.deltaA !== 'unknown' && (typeof signal.deltaA !== 'number' || !Number.isFinite(signal.deltaA))) ||
    !['better_than_expected', 'met_expected', 'worse_than_expected', 'unclear'].includes(String(signal.outcome)) ||
    typeof signal.confidence !== 'number' || !Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1 ||
    signal.source !== 'review'
  ) throw new Error('malformed candidate learning signal');
  return signal as unknown as KstarLearningSignal;
}

function asCandidate(value: RecallJsonRecord): RecallCandidateRecord {
  if (
    typeof value.judgment !== 'string' ||
    typeof value.suggestedType !== 'string' ||
    typeof value.suggestedScope !== 'string' ||
    !Array.isArray(value.sourceRefs) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) throw new Error('malformed recall candidate');
  const storedStatus = normalizeCandidateStatus(value.status);
  const cooldownUntil = value.cooldownUntil === undefined
    ? undefined
    : requireIsoTimestamp(value.cooldownUntil, 'candidate cooldown');
  const status = storedStatus === 'deferred' && cooldownUntil !== undefined && Date.parse(cooldownUntil) <= Date.now()
    ? 'pending_review'
    : storedStatus;
  const sourceRefs = normalizeCognitionSourceRefs(value.sourceRefs);
  const evidenceRefs = Array.isArray(value.evidenceRefs)
    ? normalizeCognitionSourceRefs(value.evidenceRefs)
    : sourceRefs;
  if ((!sourceRefs.length || !evidenceRefs.length) && status !== 'observed' && status !== 'weak_observation') {
    throw new Error('malformed recall candidate evidence');
  }
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const createdAt = requireIsoTimestamp(value.createdAt, 'candidate created at');
  const candidateValue = Object.prototype.hasOwnProperty.call(value, 'value')
    ? (boundedText(value.value, 'candidate value', 1_000) || '')
    : (boundedText(value.summary, 'candidate summary', 1_000) || value.judgment);
  return {
    ...value,
    taxonomyVersion: 2,
    status,
    value: candidateValue,
    suggestedType: requireAssetType(value.suggestedType),
    suggestedAction: requireCandidateAction(value.suggestedAction),
    risk: requireCandidateRisk(value.risk),
    sourceRefs,
    evidenceRefs,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    expiresAt: requireIsoTimestamp(value.expiresAt, 'candidate expiry', new Date(Date.parse(createdAt) + DEFAULT_CANDIDATE_TTL_MS).toISOString()),
    ...(learningSignal ? { learningSignal } : {}),
  } as RecallCandidateRecord;
}

function asAsset(value: RecallJsonRecord): RecallAbilityAssetRecord {
  if (
    typeof value.candidateId !== 'string' || typeof value.title !== 'string' ||
    typeof value.statement !== 'string' || !Array.isArray(value.evidenceRefs) ||
    typeof value.scope !== 'string' || typeof value.version !== 'string'
  ) throw new Error('malformed recall ability asset');
  const evidenceRefs = normalizeCognitionSourceRefs(value.evidenceRefs);
  if (!evidenceRefs.length) throw new Error('malformed recall ability asset evidence');
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  const ontologyRefs = value.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(value.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(value, value.id);
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  return {
    ...value,
    reviewDecisionId: typeof value.reviewDecisionId === 'string' ? value.reviewDecisionId : 'legacy-untracked',
    lifecycleStatus: 'user_confirmed_unverified',
    evidenceRefs,
    ...(learningSignal ? { learningSignal } : {}),
    ...(ontologyRefs ? { ontologyRefs } : {}),
    ...relationContract,
    ...(scopePolicy ? { scopePolicy } : {}),
  } as RecallAbilityAssetRecord;
}

function candidateDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'candidates', 'placeholder'));
}

function fingerprint(input: Pick<RecallCandidateRecord, 'judgment' | 'value' | 'suggestedType' | 'suggestedScope' | 'suggestedAction' | 'targetAssetId'>): string {
  return [input.judgment, input.value, input.suggestedType, input.suggestedScope, input.suggestedAction, input.targetAssetId || '']
    .map((part) => part.trim().toLocaleLowerCase()).join('\n');
}

function mergeSourceRefs(left: CognitionSourceRef[], right: CognitionSourceRef[]): CognitionSourceRef[] {
  return normalizeCognitionSourceRefsForWrite([...left, ...right]);
}

function hasNewSourceRefs(existing: CognitionSourceRef[], incoming: CognitionSourceRef[]): boolean {
  const existingKeys = new Set(existing.map(cognitionSourceRefKey));
  return incoming.some((ref) => !existingKeys.has(cognitionSourceRefKey(ref)));
}

function maxCandidateRisk(left: RecallCandidateRisk, right: RecallCandidateRisk): RecallCandidateRisk {
  const rank: Record<RecallCandidateRisk, number> = { low: 0, medium: 1, high: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function isCandidateContentReviewReady(candidate: Pick<
  RecallCandidateRecord,
  'value' | 'sourceRefs' | 'evidenceRefs' | 'suggestedScope' | 'suggestedAction' | 'targetAssetId'
>): boolean {
  return Boolean(candidate.value) && candidate.sourceRefs.length > 0 && candidate.evidenceRefs.length > 0
    && Boolean(candidate.suggestedScope)
    && (candidate.suggestedAction === 'create' || Boolean(candidate.targetAssetId));
}

function candidateIdForCaptureKey(captureKey: string): string {
  return `cand-${createHash('sha256').update(captureKey).digest('hex').slice(0, 24)}`;
}

export async function listRecallCandidates(userId: string): Promise<RecallCandidateRecord[]> {
  let names: string[];
  try { names = await fs.readdir(candidateDirectory(userId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => readRecallJsonRecord(userId, 'candidates', name.slice(0, -5))));
  return records.filter((record): record is RecallJsonRecord => Boolean(record)).map(asCandidate)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const record = await readRecallJsonRecord(userId, 'candidates', candidateId);
  if (!record) throw new Error('recall candidate not found');
  return asCandidate(record);
}

export async function importPersonalOntologyCandidate(userId: string, legacyCandidateId: string): Promise<RecallCandidateRecord> {
  if (!safeId(legacyCandidateId)) throw new Error('invalid personal ontology candidate id');
  const data = await personalOntologyCandidates.listCandidates(userId);
  const legacy = (data.candidate_updates || []).find((candidate) => candidate.candidate_id === legacyCandidateId);
  if (!legacy) throw new Error('personal ontology candidate not found');
  const suggestedType: AbilityAssetType = legacy.kind === 'preference' ? 'personal' : legacy.kind === 'rule' ? 'rule' : 'personal';
  return saveRecallCandidate(userId, {
    judgment: legacy.memory_text || legacy.summary,
    summary: legacy.summary,
    suggestedType,
    suggestedScope: legacy.memory_scope === 'user' ? 'global' : 'project',
    sourceRefs: legacy.source_memory_refs.map((id) => ({ kind: 'memory', id })),
  });
}

export async function saveRecallCandidate(userId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const value = boundedText(input.value, 'value', 1_000);
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500) || '';
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const suggestedType = requireAssetType(input.suggestedType);
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(input, 'value');
  const hasExplicitAction = Object.prototype.hasOwnProperty.call(input, 'suggestedAction');
  const suggestedAction = requireCandidateAction(input.suggestedAction);
  const risk = requireCandidateRisk(input.risk);
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  assertNotForbiddenToPersist([
    judgment,
    value,
    summary,
    uncertainty,
    JSON.stringify(sourceRefs),
    JSON.stringify(evidenceRefs),
    learningSignal ? JSON.stringify(learningSignal) : undefined,
  ]);
  const captureKey = input.captureKey === undefined
    ? undefined
    : boundedText(input.captureKey, 'capture key', 160, true);
  if (captureKey && !safeId(captureKey)) throw new Error('invalid capture key');
  if (captureKey) {
    const captured = (await listRecallCandidates(userId)).find((candidate) => candidate.captureKey === captureKey);
    if (captured) return captured;
  }
  const now = new Date().toISOString();
  const resolvedValue = hasExplicitValue ? (value || '') : (summary || judgment);
  const expiresAt = requireIsoTimestamp(input.expiresAt, 'candidate expiry', new Date(Date.parse(now) + DEFAULT_CANDIDATE_TTL_MS).toISOString());
  const taskRunId = input.taskRunId === undefined ? undefined : boundedText(input.taskRunId, 'task run id', 160, true);
  if (taskRunId && !safeId(taskRunId)) throw new Error('invalid task run id');
  const targetAssetId = input.targetAssetId === undefined ? undefined : boundedText(input.targetAssetId, 'target asset id', 160, true);
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
  const candidateDraft = { judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId };
  const reviewReady = Boolean(resolvedValue) && sourceRefs.length > 0 && evidenceRefs.length > 0
    && Boolean(suggestedScope) && (hasExplicitAction || !hasExplicitValue)
    && (suggestedAction === 'create' || Boolean(targetAssetId));
  const existing = (await listRecallCandidates(userId)).find((candidate) => {
    if (fingerprint(candidate) !== fingerprint(candidateDraft)) return false;
    const hasNewEvidence = hasNewSourceRefs(candidate.evidenceRefs, evidenceRefs);
    const riskIncreased = maxCandidateRisk(candidate.risk, risk) !== candidate.risk;
    if (isSuppressedTerminalCandidate(candidate.status)) return !hasNewEvidence && !riskIncreased;
    if (candidate.status === 'confirmed') return !riskIncreased;
    return true;
  });
  if (existing) {
    const merged = await updateRecallJsonRecord(userId, 'candidates', existing.id, (current) => {
      if (!current) return existing;
      const candidate = asCandidate(current);
      const hasNewEvidence = hasNewSourceRefs(candidate.evidenceRefs, evidenceRefs);
      const riskIncreased = maxCandidateRisk(candidate.risk, risk) !== candidate.risk;
      const shouldReopen = (hasNewEvidence || riskIncreased) && (
        candidate.status === 'observed'
        || candidate.status === 'weak_observation'
        || candidate.status === 'deferred'
        || candidate.status === 'failed'
      );
      return {
        ...candidate,
        sourceRefs: mergeSourceRefs(candidate.sourceRefs, sourceRefs),
        evidenceRefs: mergeSourceRefs(candidate.evidenceRefs, evidenceRefs),
        risk: maxCandidateRisk(candidate.risk, risk),
        ...(shouldReopen ? {
          status: reviewReady ? 'pending_review' : 'weak_observation',
          cooldownUntil: undefined,
          failureCode: undefined,
          failureMessage: undefined,
          failedAt: undefined,
        } : {}),
        updatedAt: now,
      };
    });
    return asCandidate(merged);
  }
  const record: RecallCandidateRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id: captureKey ? candidateIdForCaptureKey(captureKey) : `cand-${genId12()}`,
    status: reviewReady ? 'pending_review' : 'weak_observation',
    judgment,
    value: resolvedValue,
    ...(summary ? { summary } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    suggestedType,
    suggestedScope,
    sourceRefs,
    evidenceRefs,
    suggestedAction,
    risk,
    ...(learningSignal ? { learningSignal } : {}),
    ...(captureKey ? { captureKey } : {}),
    ...(taskRunId ? { taskRunId } : {}),
    ...(targetAssetId ? { targetAssetId } : {}),
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  if (captureKey) {
    return asCandidate(await updateRecallJsonRecord(
      userId,
      'candidates',
      record.id,
      (current) => current || record,
    ));
  }
  await writeRecallJsonRecord(userId, 'candidates', record.id, record);
  return record;
}

export async function updateRecallCandidate(userId: string, candidateId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const value = boundedText(input.value, 'value', 1_000);
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500) || '';
  const suggestedType = requireAssetType(input.suggestedType);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  const evidenceRefs = normalizeCognitionSourceRefsForWrite(input.evidenceRefs || input.sourceRefs);
  const currentCandidate = await readRecallCandidate(userId, candidateId);
  const suggestedAction = input.suggestedAction === undefined
    ? currentCandidate.suggestedAction
    : requireCandidateAction(input.suggestedAction);
  const risk = input.risk === undefined ? currentCandidate.risk : requireCandidateRisk(input.risk);
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  assertNotForbiddenToPersist([
    judgment,
    value,
    summary,
    uncertainty,
    JSON.stringify(sourceRefs),
    JSON.stringify(evidenceRefs),
    learningSignal ? JSON.stringify(learningSignal) : undefined,
  ]);
  const duplicates = await listRecallCandidates(userId);
  const hasExplicitValue = Object.prototype.hasOwnProperty.call(input, 'value');
  const resolvedValue = hasExplicitValue ? (value || '') : (summary || currentCandidate.value || judgment);
  const expiresAt = input.expiresAt === undefined
    ? currentCandidate.expiresAt
    : requireIsoTimestamp(input.expiresAt, 'candidate expiry');
  const taskRunId = input.taskRunId === undefined
    ? currentCandidate.taskRunId
    : boundedText(input.taskRunId, 'task run id', 160, true);
  if (taskRunId && !safeId(taskRunId)) throw new Error('invalid task run id');
  const targetAssetId = input.targetAssetId === undefined
    ? currentCandidate.targetAssetId
    : boundedText(input.targetAssetId, 'target asset id', 160, true);
  if (targetAssetId && !safeId(targetAssetId)) throw new Error('invalid target asset id');
  const nextFingerprint = fingerprint({ judgment, value: resolvedValue, suggestedType, suggestedScope, suggestedAction, targetAssetId });
  if (duplicates.some((candidate) => candidate.id !== candidateId && fingerprint(candidate) === nextFingerprint)) throw new Error('duplicate recall candidate');
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (raw) => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (isTerminalCandidate(current.status)) throw new Error('recall candidate is terminal');
    const reviewReady = Boolean(resolvedValue) && sourceRefs.length > 0 && evidenceRefs.length > 0
      && Boolean(suggestedScope) && (suggestedAction === 'create' || Boolean(targetAssetId));
    const now = new Date().toISOString();
    return {
      ...current,
      judgment,
      value: resolvedValue,
      ...(summary ? { summary } : {}),
      ...(uncertainty ? { uncertainty } : {}),
      suggestedType,
      suggestedScope,
      sourceRefs,
      evidenceRefs,
      suggestedAction,
      risk,
      expiresAt,
      ...(taskRunId ? { taskRunId } : {}),
      ...(targetAssetId ? { targetAssetId } : {}),
      status: reviewReady ? 'pending_review' : 'weak_observation',
      failureCode: undefined,
      failureMessage: undefined,
      failedAt: undefined,
      promotionErrorCode: undefined,
      promotionErrorMessage: undefined,
      promotionFailedAt: undefined,
      userModifiedAt: now,
      ...(learningSignal ? { learningSignal } : current.learningSignal ? { learningSignal: current.learningSignal } : {}),
      updatedAt: now,
    };
  });
  return asCandidate(updated);
}

export function deferRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'defer', 'deferred', note);
}

export async function resumeRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate not found');
    const storedStatus = normalizeCandidateStatus(current.status);
    const candidate = asCandidate(current);
    if (isTerminalCandidate(storedStatus)) throw new Error('recall candidate is terminal');
    if (storedStatus !== 'deferred') throw new Error('only a deferred recall candidate can be resumed');
    if (!isCandidateContentReviewReady(candidate)) throw new Error('candidate evidence is insufficient for review');
    return {
      ...candidate,
      status: 'pending_review',
      cooldownUntil: undefined,
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

export function rejectRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'reject', 'rejected', note);
}

export function ignoreRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'ignore', 'ignored', note);
}

export function keepCurrentRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return decideWithoutAsset(userId, candidateId, 'keep_current', 'ignored', note);
}

async function decideWithoutAsset(
  userId: string,
  candidateId: string,
  decisionType: 'defer' | 'reject' | 'ignore' | 'keep_current',
  status: 'deferred' | 'rejected' | 'ignored',
  note?: string,
): Promise<RecallCandidateRecord> {
  const decisionNote = boundedText(note, 'decision note', 1_000);
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (isTerminalCandidate(candidate.status)) return candidate;
    if (candidate.status === 'observed' || candidate.status === 'weak_observation') {
      throw new Error('candidate evidence is insufficient for review');
    }
    await writeReviewDecision(userId, {
      targetRef: `recall_candidate:${candidate.id}`,
      decisionType,
      decision: decisionType,
      antecedentRef: candidate.id,
      scope: candidate.suggestedScope,
      reason: decisionNote,
      idempotencyKey: `${decisionType}-${candidate.updatedAt}`,
    });
    return {
      ...candidate,
      status,
      ...(decisionNote ? { decisionNote } : {}),
      ...(status === 'deferred'
        ? { cooldownUntil: new Date(Date.now() + DEFAULT_DEFER_COOLDOWN_MS).toISOString() }
        : { cooldownUntil: undefined }),
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

export async function batchPromoteRecallCandidates(
  userId: string,
  candidateIds: string[],
): Promise<{ succeeded: Array<{ candidateId: string; assetId: string; reviewDecisionId: string }>; failed: Array<{ candidateId: string; error: string }> }> {
  const succeeded: Array<{ candidateId: string; assetId: string; reviewDecisionId: string }> = [];
  const failed: Array<{ candidateId: string; error: string }> = [];
  for (const candidateId of [...new Set(candidateIds)]) {
    try {
      const candidate = await readRecallCandidate(userId, candidateId);
      if (candidate.status !== 'pending_review') {
        failed.push({ candidateId, error: 'candidate is not pending review' });
        continue;
      }
      const result = await promoteRecallCandidate(userId, candidateId, { actor: 'user' });
      succeeded.push({ candidateId, assetId: result.asset.id, reviewDecisionId: result.decision.decision_id });
    } catch (error) {
      failed.push({ candidateId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { succeeded, failed };
}

async function unavailableCandidateSources(
  userId: string,
  refs: CognitionSourceRef[],
): Promise<CognitionSourceRef[]> {
  const checks = await Promise.all(refs.map(async (ref) => {
    if (ref.taxonomyVersion !== 2) return undefined;
    const enabled = await isCognitionSourceEnabled(userId, {
      kind: ref.kind as CognitionSourceType,
      id: ref.id,
    });
    return enabled ? undefined : ref;
  }));
  return checks.filter((ref): ref is CognitionSourceRef => Boolean(ref));
}

function confirmationIdempotencyKey(candidate: RecallCandidateRecord): string {
  return `confirm-${createHash('sha256').update(JSON.stringify({
    candidateId: candidate.id,
    judgment: candidate.judgment,
    value: candidate.value,
    type: candidate.suggestedType,
    scope: candidate.suggestedScope,
    action: candidate.suggestedAction,
    targetAssetId: candidate.targetAssetId,
    evidence: candidate.evidenceRefs.map(cognitionSourceRefKey).sort(),
  })).digest('hex').slice(0, 32)}`;
}

function handoffReceipt(asset: RecallAbilityAssetRecord): RecallAssetHandoffReceipt {
  return {
    assetId: asset.id,
    assetType: asset.type,
    version: asset.version,
    lifecycleStatus: asset.lifecycleStatus,
    scope: asset.scope,
    sourceRefs: asset.evidenceRefs,
    reviewDecisionId: asset.reviewDecisionId,
  };
}

async function persistHandoffReceipt(
  userId: string,
  candidateId: string,
  receipt: RecallAssetHandoffReceipt,
): Promise<void> {
  const id = `handoff-${createHash('sha256').update(`${candidateId}\n${receipt.reviewDecisionId}`).digest('hex').slice(0, 24)}`;
  const now = new Date().toISOString();
  await updateRecallJsonRecord(userId, 'asset-handoff-receipts', id, (current) => current || ({
    schemaVersion: 2,
    ownerId: userId,
    id,
    candidateId,
    ...receipt,
    createdAt: now,
  } satisfies StoredRecallAssetHandoffReceipt));
}

export async function promoteRecallCandidate(
  userId: string,
  candidateId: string,
  options: PromoteRecallCandidateOptions & AbilityAssetRelationContract = {},
): Promise<{ candidate: RecallCandidateRecord; asset: RecallAbilityAssetRecord; decision: ReviewDecision; receipt: RecallAssetHandoffReceipt }> {
  if (options.actor !== 'user') throw new Error('recall candidate promotion requires a user actor');
  const ontologyRefs = options.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(options.ontologyRefs);
  const relationContract = readAbilityAssetRelationContract(options as Record<string, unknown>);
  const scopePolicy = normalizeAbilityAssetScopePolicy(options.scopePolicy);
  let decision: ReviewDecision | undefined;
  let updated: RecallJsonRecord;
  try {
    updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (candidate.status === 'confirmed') return candidate;
    if (isTerminalCandidate(candidate.status)) throw new Error('recall candidate is terminal');
    if (candidate.status === 'weak_observation' || candidate.status === 'observed') {
      throw new Error('candidate evidence is insufficient for review');
    }
    if (candidate.risk === 'high' && options.riskAcknowledged !== true) {
      throw new Error('high-risk candidate requires an independent risk gate');
    }
    if (candidate.suggestedAction === 'keep_current' || candidate.suggestedAction === 'reject') {
      throw new Error('candidate action must use its non-asset review decision');
    }
    if (Date.parse(candidate.expiresAt) <= Date.now()) {
      return {
        ...candidate,
        status: 'expired',
        failureCode: 'candidate_expired',
        failureMessage: 'candidate expired before confirmation',
        failedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const unavailableSources = await unavailableCandidateSources(userId, candidate.sourceRefs);
    if (unavailableSources.length || !candidate.evidenceRefs.length) {
      return {
        ...candidate,
        status: 'failed',
        failureCode: unavailableSources.length ? 'source_unavailable' : 'evidence_insufficient',
        failureMessage: unavailableSources.length
          ? 'candidate source is paused, removed, or no longer authorized'
          : 'candidate has no usable evidence',
        failedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    const idempotencyKey = confirmationIdempotencyKey(candidate);
    decision = await writeReviewDecision(userId, {
      targetRef: `recall_candidate:${candidate.id}`,
      decisionType: options.decisionType || (candidate.userModifiedAt ? 'modify' : 'accept'),
      decision: options.decisionType === 'modify' || candidate.userModifiedAt ? 'modify and save' : 'accept',
      antecedentRef: candidate.id,
      scope: candidate.suggestedScope,
      reason: options.decisionReason,
      modifiedContent: candidate.userModifiedAt ? candidate.judgment : undefined,
      idempotencyKey,
      decisionId: options.decisionId,
    });
    const now = new Date().toISOString();
    let stored: RecallAbilityAssetRecord;
    const handoffReason = `review_decision:${decision.decision_id}`;
    if (candidate.suggestedAction === 'create') {
      const assetId = `aa-${createHash('sha256').update(`${candidate.id}\n${decision.decision_id}`).digest('hex').slice(0, 24)}`;
      const sourceSessionIds = sourceSessionIdsFrom(candidate.sourceRefs);
      stored = await createAbilityAsset(userId, {
        schemaVersion: 2,
        ownerId: userId,
        id: assetId,
        candidateId: candidate.id,
        sourceCandidateIds: [candidate.id],
        reviewDecisionId: decision.decision_id,
        type: candidate.suggestedType,
        title: candidate.summary || candidate.judgment.slice(0, 120),
        statement: candidate.judgment,
        evidenceRefs: candidate.evidenceRefs,
        ...(candidate.learningSignal ? { learningSignal: candidate.learningSignal } : {}),
        ...(ontologyRefs?.length ? { ontologyRefs } : {}),
        ...relationContract,
        scope: candidate.suggestedScope,
        ...(scopePolicy ? { scopePolicy } : {}),
        status: 'active',
        lifecycleStatus: 'user_confirmed_unverified',
        maturity: 'seed',
        version: '1',
        ...(sourceSessionIds.length ? { sourceSessionIds } : {}),
        createdAt: now,
        updatedAt: now,
      }, { actor: 'user', reason: handoffReason });
    } else {
      if (!candidate.targetAssetId) throw new Error('candidate target asset is required');
      const target = await readAbilityAsset(userId, candidate.targetAssetId);
      if (target.type !== candidate.suggestedType) throw new Error('candidate target asset type mismatch');
      if (candidate.suggestedAction === 'pause') {
        stored = await pauseAbilityAsset(userId, target.id, {
          actor: 'user',
          reason: handoffReason,
          reviewDecisionId: decision.decision_id,
          sourceCandidateId: candidate.id,
        });
      } else if (candidate.suggestedAction === 'update' || candidate.suggestedAction === 'limit_scope') {
        stored = await updateAbilityAsset(userId, target.id, {
          title: candidate.summary || candidate.judgment.slice(0, 120),
          statement: candidate.judgment,
          scope: candidate.suggestedScope,
          evidenceRefs: candidate.evidenceRefs,
          ...(ontologyRefs?.length ? { ontologyRefs } : {}),
          ...relationContract,
          ...(scopePolicy ? { scopePolicy } : {}),
          actor: 'user',
          reason: handoffReason,
          reviewDecisionId: decision.decision_id,
          sourceCandidateId: candidate.id,
        });
      } else {
        throw new Error('candidate action does not create or change an asset');
      }
    }
    await persistHandoffReceipt(userId, candidate.id, handoffReceipt(stored));
    await recordReviewDecisionOutcome(userId, `recall_candidate:${candidate.id}`, decision.decision_id, { assetId: stored.id });
    return {
      ...candidate,
      status: 'confirmed',
      promotedAssetId: stored.id,
      reviewDecisionId: decision.decision_id,
      failureCode: undefined,
      failureMessage: undefined,
      failedAt: undefined,
      updatedAt: now,
    };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (decision) {
      await recordReviewDecisionOutcome(
        userId,
        `recall_candidate:${candidateId}`,
        decision.decision_id,
        { failureCode: 'asset_write_failed' },
      ).catch(() => undefined);
      await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
        if (!current) throw error;
        const candidate = asCandidate(current);
        if (candidate.status === 'confirmed' || isTerminalCandidate(candidate.status)) return candidate;
        const now = new Date().toISOString();
        return {
          ...candidate,
          status: 'failed',
          failureCode: 'asset_write_failed',
          failureMessage: message.slice(0, 1_000),
          failedAt: now,
          reviewDecisionId: decision.decision_id,
          updatedAt: now,
        };
      }).catch(() => undefined);
    }
    throw error;
  }
  const candidate = asCandidate(updated);
  if (candidate.status === 'expired') throw new Error('recall candidate expired');
  if (candidate.status === 'failed') throw new Error(candidate.failureMessage || 'recall candidate confirmation failed');
  if (!candidate.promotedAssetId) throw new Error('promoted candidate has no ability asset');
  const storedAsset = await readRecallJsonRecord(userId, 'ability-assets', candidate.promotedAssetId);
  if (!storedAsset) throw new Error('promoted ability asset not found');
  const asset = asAsset(storedAsset);
  if (!decision) {
    const decisions = await import('../cognition/review-decision');
    decision = await decisions.readReviewDecision(userId, `recall_candidate:${candidate.id}`, asset.reviewDecisionId);
  }
  if (!decision) throw new Error('review decision not found for promoted asset');
  return { candidate, asset, decision, receipt: handoffReceipt(asset) };
}
