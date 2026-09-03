import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { recallJsonRecordPath } from './paths';
import type { RecallJsonRecord } from './types';
import { recordRecallCandidateValidation } from './candidate-service';
import { recordAbilityAssetValidation } from './asset-service';
import type { CognitionSourceRef } from './source-service';

const log = createLogger('recall.validation');

export interface ValidationRecord extends RecallJsonRecord {
  schemaVersion: 1;
  assetId: string;
  candidateId: string;
  taskRunId: string;
  outcome: 'success' | 'failure' | 'insufficient_evidence';
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
}

export async function recordValidation(
  userId: string,
  input: { assetId: string; candidateId: string; taskRunId: string; outcome: ValidationRecord['outcome']; evidenceRefs: CognitionSourceRef[] },
): Promise<ValidationRecord> {
  if (!safeId(userId) || !safeId(input.assetId) || !safeId(input.candidateId) || !safeId(input.taskRunId)) throw new Error('invalid validation record reference');
  // A task run is one independent observation. Outcome is intentionally not
  // part of the key so a retry cannot count the same run twice with a changed
  // classification.
  const id = `val-${createHash('sha256').update(`${input.assetId}:${input.candidateId}:${input.taskRunId}`).digest('hex').slice(0, 24)}`;
  const record: ValidationRecord = { schemaVersion: 1, ownerId: userId, id, ...input, createdAt: nowIso() };
  const stored = await updateRecallJsonRecord(userId, 'validation-records', id, (current) => {
    if (current) return current;
    return record;
  });
  const durableRecord = stored as unknown as ValidationRecord;
  const outcome = durableRecord.outcome;
  if (outcome === 'success' || outcome === 'failure') {
    // Replay downstream applications even when the validation record already
    // exists. A crash after this durable record but before a counter update is
    // therefore recoverable; appliedValidationIds make replay idempotent.
    await recordRecallCandidateValidation(userId, input.candidateId, outcome, id);
    // A validation can outlive a legacy candidate/asset handoff. The outcome
    // record and candidate ledger remain authoritative even when the asset was
    // purged or never existed in older data.
    await recordAbilityAssetValidation(userId, input.assetId, outcome, id).catch(() => undefined);
  }
  return durableRecord;
}

export async function recoverValidationApplications(userId: string): Promise<number> {
  const records = await listValidationRecords(userId);
  let recovered = 0;
  for (const record of records) {
    if (record.outcome !== 'success' && record.outcome !== 'failure') continue;
    let applied = false;
    try {
      await recordRecallCandidateValidation(userId, record.candidateId, record.outcome, record.id);
      applied = true;
    } catch (error) {
      log.warn('validation application recovery degraded', {
        validationId: record.id,
        target: 'candidate',
        error: (error as Error).message,
      });
    }
    try {
      await recordAbilityAssetValidation(userId, record.assetId, record.outcome, record.id);
      applied = true;
    } catch (error) {
      log.warn('validation application recovery degraded', {
        validationId: record.id,
        target: 'asset',
        error: (error as Error).message,
      });
    }
    if (applied) recovered += 1;
  }
  return recovered;
}

export async function listValidationRecords(userId: string): Promise<ValidationRecord[]> {
  const directory = path.dirname(recallJsonRecordPath(userId, 'validation-records', 'placeholder'));
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readRecallJsonRecord(userId, 'validation-records', name.slice(0, -5))));
  return records.filter((record): record is ValidationRecord => Boolean(record)) as ValidationRecord[];
}
