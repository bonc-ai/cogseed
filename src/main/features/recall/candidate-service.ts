import * as fs from 'node:fs/promises';
import * as personalOntologyCandidates from '../personal_ontology_candidates';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { genId12, safeId } from '../../storage';
import { recallJsonRecordPath } from './paths';
import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
  writeRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';
import type { KstarLearningSignal } from '../kstar/types';
import { normalizeAbilityAssetOntologyRefs, type AbilityAssetOntologyRef } from './ontology-refs';
import { normalizeAbilityAssetScopePolicy, type RecallAbilityAssetScopePolicy } from './scope-policy';
import { initializeAbilityAsset } from './asset-service';
import {
  cognitionSourceRefKey,
  normalizeCognitionSourceRefs,
  normalizeCognitionSourceRefsForWrite,
  type CognitionSourceRef,
} from './source-service';

export type RecallCandidateStatus = 'pending' | 'deferred' | 'rejected' | 'promoted';
export type AbilityAssetType = 'personal' | 'rule' | 'template' | 'skill_method';


export interface RecallCandidateRecord extends RecallJsonRecord {
  id: string;
  taxonomyVersion: 2;
  status: RecallCandidateStatus;
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  captureKey?: string;
  promotedAssetId?: string;
  decisionNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecallAbilityAssetRecord extends RecallJsonRecord {
  id: string;
  candidateId: string;
  type: AbilityAssetType;
  title: string;
  statement: string;
  evidenceRefs: CognitionSourceRef[];
  learningSignal?: KstarLearningSignal;
  ontologyRefs?: AbilityAssetOntologyRef[];
  scope: string;
  scopePolicy?: RecallAbilityAssetScopePolicy;
  recommendedAction?: 'pause' | 'rework';
  recommendationReason?: string;
  recommendationAt?: string;
  status: 'active' | 'paused' | 'revoked';
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
  version: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveRecallCandidateInput {
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  sourceRefs: unknown[];
  learningSignal?: KstarLearningSignal;
  captureKey?: string;
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
    (value.status !== 'pending' && value.status !== 'deferred' && value.status !== 'rejected' && value.status !== 'promoted') ||
    typeof value.judgment !== 'string' ||
    typeof value.suggestedType !== 'string' ||
    typeof value.suggestedScope !== 'string' ||
    !Array.isArray(value.sourceRefs) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) throw new Error('malformed recall candidate');
  const sourceRefs = normalizeCognitionSourceRefs(value.sourceRefs);
  if (!sourceRefs.length) throw new Error('malformed recall candidate evidence');
  const learningSignal = normalizeLearningSignal(value.learningSignal);
  return { ...value, taxonomyVersion: 2, sourceRefs, ...(learningSignal ? { learningSignal } : {}) } as RecallCandidateRecord;
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
  const scopePolicy = normalizeAbilityAssetScopePolicy(value.scopePolicy);
  return { ...value, evidenceRefs, ...(learningSignal ? { learningSignal } : {}), ...(ontologyRefs ? { ontologyRefs } : {}), ...(scopePolicy ? { scopePolicy } : {}) } as RecallAbilityAssetRecord;
}

function candidateDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'candidates', 'placeholder'));
}

function fingerprint(input: Pick<RecallCandidateRecord, 'judgment' | 'sourceRefs'>): string {
  return `${input.judgment.toLocaleLowerCase()}\n${input.sourceRefs.map(cognitionSourceRefKey).sort().join('\n')}`;
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
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500, true)!;
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  if (!sourceRefs.length) throw new Error('candidate evidence is required');
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  const captureKey = input.captureKey === undefined
    ? undefined
    : boundedText(input.captureKey, 'capture key', 160, true);
  if (captureKey && !safeId(captureKey)) throw new Error('invalid capture key');
  if (captureKey) {
    const captured = (await listRecallCandidates(userId)).find((candidate) => candidate.captureKey === captureKey);
    if (captured) return captured;
  }
  const candidateDraft = { judgment, sourceRefs } as Pick<RecallCandidateRecord, 'judgment' | 'sourceRefs'>;
  const existing = (await listRecallCandidates(userId)).find((candidate) => fingerprint(candidate) === fingerprint(candidateDraft));
  if (existing) return existing;

  const now = new Date().toISOString();
  const record: RecallCandidateRecord = {
    schemaVersion: 1,
    taxonomyVersion: 2,
    ownerId: userId,
    id: captureKey ? candidateIdForCaptureKey(captureKey) : `cand-${genId12()}`,
    status: 'pending',
    judgment,
    ...(summary ? { summary } : {}),
    ...(uncertainty ? { uncertainty } : {}),
    suggestedType: requireAssetType(input.suggestedType),
    suggestedScope,
    sourceRefs,
    ...(learningSignal ? { learningSignal } : {}),
    ...(captureKey ? { captureKey } : {}),
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

async function transitionCandidate(
  userId: string,
  candidateId: string,
  nextStatus: RecallCandidateStatus,
  decisionNote?: string,
): Promise<RecallCandidateRecord> {
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (candidate.status === 'rejected' || candidate.status === 'promoted') throw new Error('recall candidate is terminal');
    if (nextStatus === 'promoted') throw new Error('use promoteRecallCandidate');
    const note = boundedText(decisionNote, 'decision note', 1_000);
    return {
      ...candidate,
      status: nextStatus,
      ...(note ? { decisionNote: note } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
  return asCandidate(updated);
}

export async function updateRecallCandidate(userId: string, candidateId: string, input: SaveRecallCandidateInput): Promise<RecallCandidateRecord> {
  const judgment = boundedText(input.judgment, 'judgment', 4_000, true)!;
  const summary = boundedText(input.summary, 'summary', 1_000);
  const uncertainty = boundedText(input.uncertainty, 'uncertainty', 1_000);
  const suggestedScope = boundedText(input.suggestedScope, 'suggested scope', 500, true)!;
  const suggestedType = requireAssetType(input.suggestedType);
  const sourceRefs = normalizeCognitionSourceRefsForWrite(input.sourceRefs);
  if (!sourceRefs.length) throw new Error('candidate evidence is required');
  const learningSignal = normalizeLearningSignal(input.learningSignal);
  const duplicates = await listRecallCandidates(userId);
  const nextFingerprint = fingerprint({ judgment, sourceRefs });
  if (duplicates.some((candidate) => candidate.id !== candidateId && fingerprint(candidate) === nextFingerprint)) throw new Error('duplicate recall candidate');
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, (raw) => {
    if (!raw) throw new Error('recall candidate not found');
    const current = asCandidate(raw);
    if (current.status === 'rejected' || current.status === 'promoted') throw new Error('recall candidate is terminal');
    return { ...current, judgment, ...(summary ? { summary } : {}), ...(uncertainty ? { uncertainty } : {}), suggestedType, suggestedScope, sourceRefs, ...(learningSignal ? { learningSignal } : current.learningSignal ? { learningSignal: current.learningSignal } : {}), updatedAt: new Date().toISOString() };
  });
  return asCandidate(updated);
}

export function deferRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return transitionCandidate(userId, candidateId, 'deferred', note);
}

export function resumeRecallCandidate(userId: string, candidateId: string): Promise<RecallCandidateRecord> {
  return transitionCandidate(userId, candidateId, 'pending');
}

export function rejectRecallCandidate(userId: string, candidateId: string, note?: string): Promise<RecallCandidateRecord> {
  return transitionCandidate(userId, candidateId, 'rejected', note);
}

export async function promoteRecallCandidate(
  userId: string,
  candidateId: string,
  options: { actor?: 'user'; ontologyRefs?: AbilityAssetOntologyRef[]; scopePolicy?: RecallAbilityAssetScopePolicy } = {},
): Promise<{ candidate: RecallCandidateRecord; asset: RecallAbilityAssetRecord }> {
  if (options.actor !== 'user') throw new Error('recall candidate promotion requires a user actor');
  const ontologyRefs = options.ontologyRefs === undefined ? undefined : normalizeAbilityAssetOntologyRefs(options.ontologyRefs);
  const scopePolicy = normalizeAbilityAssetScopePolicy(options.scopePolicy);
  const updated = await updateRecallJsonRecord(userId, 'candidates', candidateId, async (current) => {
    if (!current) throw new Error('recall candidate not found');
    const candidate = asCandidate(current);
    if (candidate.status === 'promoted') return candidate;
    if (candidate.status === 'rejected') throw new Error('recall candidate is terminal');
    const now = new Date().toISOString();
    const asset: RecallAbilityAssetRecord = {
      schemaVersion: 1,
      ownerId: userId,
      id: `aa-${genId12()}`,
      candidateId: candidate.id,
      type: candidate.suggestedType,
      title: candidate.summary || candidate.judgment.slice(0, 120),
      statement: candidate.judgment,
      evidenceRefs: candidate.sourceRefs,
      ...(candidate.learningSignal ? { learningSignal: candidate.learningSignal } : {}),
      ...(ontologyRefs?.length ? { ontologyRefs } : {}),
      scope: candidate.suggestedScope,
      ...(scopePolicy ? { scopePolicy } : {}),
      status: 'active',
      maturity: 'seed',
      version: '1',
      createdAt: now,
      updatedAt: now,
    };
    await writeRecallJsonRecord(userId, 'ability-assets', asset.id, asset);
    await initializeAbilityAsset(userId, asset);
    return { ...candidate, status: 'promoted', promotedAssetId: asset.id, updatedAt: now };
  });
  const candidate = asCandidate(updated);
  if (!candidate.promotedAssetId) throw new Error('promoted candidate has no ability asset');
  const storedAsset = await readRecallJsonRecord(userId, 'ability-assets', candidate.promotedAssetId);
  if (!storedAsset) throw new Error('promoted ability asset not found');
  return { candidate, asset: asAsset(storedAsset) };
}
