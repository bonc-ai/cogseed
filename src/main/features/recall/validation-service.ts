import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nowIso, safeId } from '../../storage';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { recallJsonRecordPath } from './paths';
import type { RecallJsonRecord } from './types';
import { recordRecallCandidateValidation } from './candidate-service';
import { recordAbilityAssetValidation } from './asset-service';
import type { CognitionSourceRef } from './source-service';

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
  let created = false;
  const stored = await updateRecallJsonRecord(userId, 'validation-records', id, (current) => {
    if (current) return current;
    created = true;
    return record;
  });
  if (!created) return stored as unknown as ValidationRecord;
  if (input.outcome === 'success' || input.outcome === 'failure') {
    await recordRecallCandidateValidation(userId, input.candidateId, input.outcome);
    // A validation can outlive a legacy candidate/asset handoff. The outcome
    // record and candidate ledger remain authoritative even when the asset was
    // purged or never existed in older data.
    await recordAbilityAssetValidation(userId, input.assetId, input.outcome).catch(() => undefined);
  }
  return record;
}

export async function listValidationRecords(userId: string): Promise<ValidationRecord[]> {
  const directory = path.dirname(recallJsonRecordPath(userId, 'validation-records', 'placeholder'));
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => readRecallJsonRecord(userId, 'validation-records', name.slice(0, -5))));
  return records.filter((record): record is ValidationRecord => Boolean(record)) as ValidationRecord[];
}
