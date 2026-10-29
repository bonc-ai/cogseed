import {
  readRecallJsonRecord,
  updateRecallJsonRecord,
} from './store';
import type { RecallJsonRecord } from './types';

const STATS_COLLECTION = 'capture-settings';
const STATS_ID = 'capture-stats';

export interface RecallCaptureStatsTotals {
  sweeps: number;
  conversationsScanned: number;
  coarseFiltered: number;
  coarseReasons: Record<string, number>;
  extracted: number;
  suggestions: number;
  reviewReady: number;
  noCandidate: number;
  noCandidateReasons: Record<string, number>;
  failures: Record<string, number>;
  retried: number;
  duplicatesSuppressed: number;
  decisions: Record<string, number>;
  rejectReasons: Record<string, number>;
  updatedAt: string;
}

export interface RecallCaptureStatsRecord extends RecallJsonRecord {
  id: typeof STATS_ID;
  totals: RecallCaptureStatsTotals;
}

export interface RecallCaptureStatsDelta {
  sweeps?: number;
  conversationsScanned?: number;
  coarseFiltered?: number;
  coarseReasons?: Record<string, number>;
  extracted?: number;
  suggestions?: number;
  reviewReady?: number;
  noCandidate?: number;
  noCandidateReasons?: Record<string, number>;
  failures?: Record<string, number>;
  retried?: number;
  duplicatesSuppressed?: number;
  decisions?: Record<string, number>;
  rejectReasons?: Record<string, number>;
}

function emptyTotals(): RecallCaptureStatsTotals {
  return {
    sweeps: 0,
    conversationsScanned: 0,
    coarseFiltered: 0,
    coarseReasons: {},
    extracted: 0,
    suggestions: 0,
    reviewReady: 0,
    noCandidate: 0,
    noCandidateReasons: {},
    failures: {},
    retried: 0,
    duplicatesSuppressed: 0,
    decisions: {},
    rejectReasons: {},
    updatedAt: new Date().toISOString(),
  };
}

function asStats(value: RecallJsonRecord): RecallCaptureStatsRecord {
  const totals = (value as unknown as { totals?: Partial<RecallCaptureStatsTotals> }).totals || {};
  return {
    ...value,
    id: STATS_ID,
    totals: { ...emptyTotals(), ...totals },
  } as RecallCaptureStatsRecord;
}

function mergeCounters(target: Record<string, number>, delta: Record<string, number> | undefined): void {
  if (!delta) return;
  for (const [key, count] of Object.entries(delta)) {
    if (!Number.isFinite(count)) continue;
    target[key] = (target[key] || 0) + Math.max(0, Math.floor(count));
  }
}

export async function readRecallCaptureStats(userId: string): Promise<RecallCaptureStatsTotals> {
  const stored = await readRecallJsonRecord(userId, STATS_COLLECTION, STATS_ID);
  return stored ? asStats(stored).totals : emptyTotals();
}

/** 聚合只记计数与原因码，绝不落原文或消息内容（夜间统计隐私口径）。 */
export async function bumpRecallCaptureStats(
  userId: string,
  delta: RecallCaptureStatsDelta,
): Promise<RecallCaptureStatsTotals> {
  const updated = await updateRecallJsonRecord(userId, STATS_COLLECTION, STATS_ID, (current) => {
    const base = current ? asStats(current) : {
      schemaVersion: 1,
      ownerId: userId,
      id: STATS_ID,
      totals: emptyTotals(),
    } as RecallCaptureStatsRecord;
    const totals = { ...base.totals, coarseReasons: { ...base.totals.coarseReasons } };
    totals.sweeps += Math.max(0, Math.floor(delta.sweeps || 0));
    totals.conversationsScanned += Math.max(0, Math.floor(delta.conversationsScanned || 0));
    totals.coarseFiltered += Math.max(0, Math.floor(delta.coarseFiltered || 0));
    totals.extracted += Math.max(0, Math.floor(delta.extracted || 0));
    totals.suggestions += Math.max(0, Math.floor(delta.suggestions || 0));
    totals.reviewReady += Math.max(0, Math.floor(delta.reviewReady || 0));
    totals.noCandidate += Math.max(0, Math.floor(delta.noCandidate || 0));
    totals.retried += Math.max(0, Math.floor(delta.retried || 0));
    totals.duplicatesSuppressed += Math.max(0, Math.floor(delta.duplicatesSuppressed || 0));
    mergeCounters(totals.coarseReasons, delta.coarseReasons);
    mergeCounters(totals.noCandidateReasons, delta.noCandidateReasons);
    mergeCounters(totals.failures, delta.failures);
    mergeCounters(totals.decisions, delta.decisions);
    mergeCounters(totals.rejectReasons, delta.rejectReasons);
    totals.updatedAt = new Date().toISOString();
    return { ...base, totals } as RecallJsonRecord;
  });
  return asStats(updated).totals;
}
