import { nowIso } from '../../storage';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { readKstarJsonRecord, replaceKstarJsonRecord, writeKstarJsonRecord } from './episode-store';
import type {
  KstarAttribution,
  KstarEpisodeRecord,
  KstarOutcome,
  KstarReviewRecord,
} from './types';

export interface SaveKstarReviewInput {
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: KstarOutcome;
  attribution: KstarAttribution;
  reason: string;
  confidence: number;
  evidenceRefs: unknown[];
}

function boundedReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('missing kstar review reason');
  const reason = value.replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('missing kstar review reason');
  if (reason.length > 2_000) throw new Error('kstar review reason is too long');
  return reason;
}

function reviewNumber(value: number | 'unknown', field: string): number | 'unknown' {
  if (value === 'unknown') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${field}`);
  return value;
}

function validateConfidence(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('invalid kstar review confidence');
  }
  return value;
}

export function createInitialKstarReview(episode: KstarEpisodeRecord): KstarReviewRecord {
  const reason = episode.r.status === 'completed'
    ? 'No explicit expectation or verification evidence was recorded.'
    : `Task ended with status ${episode.r.status}; an expected-result comparison was not recorded.`;
  const now = episode.updatedAt || nowIso();
  return {
    schemaVersion: 1,
    ownerId: episode.ownerId,
    id: `ksr-${episode.id}`,
    episodeId: episode.id,
    deltaR: 'unknown',
    deltaA: 'unknown',
    outcome: 'unclear',
    attribution: 'unclear',
    reason,
    confidence: 0,
    evidenceRefs: episode.evidenceRefs,
    createdAt: now,
    updatedAt: now,
  };
}

export async function saveKstarReviewRecord(
  userId: string,
  record: KstarReviewRecord,
): Promise<KstarReviewRecord> {
  validateStoredReview(userId, record.episodeId, record);
  return replaceKstarJsonRecord(userId, 'reviews', record);
}

export async function saveKstarReview(
  userId: string,
  episode: KstarEpisodeRecord,
  input: SaveKstarReviewInput,
): Promise<KstarReviewRecord> {
  if (episode.ownerId !== userId) throw new Error('kstar episode owner mismatch');
  const now = nowIso();
  const record: KstarReviewRecord = {
    schemaVersion: 1,
    ownerId: userId,
    id: `ksr-${episode.id}`,
    episodeId: episode.id,
    deltaR: reviewNumber(input.deltaR, 'deltaR'),
    deltaA: reviewNumber(input.deltaA, 'deltaA'),
    outcome: input.outcome,
    attribution: input.attribution,
    reason: boundedReason(input.reason),
    confidence: validateConfidence(input.confidence),
    evidenceRefs: normalizeCognitionSourceRefs(input.evidenceRefs),
    createdAt: now,
    updatedAt: now,
  };
  if (!record.evidenceRefs.length) throw new Error('kstar review evidence is required');
  return saveKstarReviewRecord(userId, record);
}

function validateStoredReview(userId: string, episodeId: string, raw: Record<string, unknown>): KstarReviewRecord {
  if (
    raw.ownerId !== userId || raw.id !== `ksr-${episodeId}` || raw.episodeId !== episodeId ||
    (raw.deltaR !== 'unknown' && (typeof raw.deltaR !== 'number' || !Number.isFinite(raw.deltaR))) ||
    (raw.deltaA !== 'unknown' && (typeof raw.deltaA !== 'number' || !Number.isFinite(raw.deltaA))) ||
    !['better_than_expected', 'met_expected', 'worse_than_expected', 'unclear'].includes(String(raw.outcome)) ||
    !['knowledge_gap', 'rule_gap', 'template_gap', 'skill_gap', 'execution_gap', 'unclear'].includes(String(raw.attribution)) ||
    typeof raw.reason !== 'string' || typeof raw.confidence !== 'number' ||
    !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1 ||
    !Array.isArray(raw.evidenceRefs) || typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string'
  ) throw new Error('malformed kstar review');
  return raw as KstarReviewRecord;
}

export async function readKstarReview(userId: string, episodeId: string): Promise<KstarReviewRecord | null> {
  const raw = await readKstarJsonRecord(userId, 'reviews', `ksr-${episodeId}`);
  return raw ? validateStoredReview(userId, episodeId, raw) : null;
}
