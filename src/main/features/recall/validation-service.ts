import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { nowIso, safeId } from '../../storage';
import { createLogger } from '../../logger';
import { readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { recallJsonRecordPath } from './paths';
import type { RecallJsonRecord } from './types';
import { recordRecallCandidateValidation } from './candidate-service';
import { readAbilityAsset, recordAbilityAssetValidation } from './asset-service';
import { withCognitionTransition } from '../cognition_bridge';
import type { CognitionSourceRef } from './source-service';

const log = createLogger('recall.validation');

export interface ValidationRecord extends RecallJsonRecord {
  schemaVersion: 1;
  assetId: string;
  candidateId: string;
  /** Exact observed content version; legacy unbound rows remain history only for the asset. */
  assetVersion?: string;
  taskRunId: string;
  outcome: 'success' | 'failure' | 'insufficient_evidence';
  evidenceRefs: CognitionSourceRef[];
  createdAt: string;
}

export async function recordValidation(
  userId: string,
  input: { assetId: string; candidateId: string; assetVersion?: string; taskRunId: string; outcome: ValidationRecord['outcome']; evidenceRefs: CognitionSourceRef[] },
): Promise<ValidationRecord> {
  if (!safeId(userId) || !safeId(input.assetId) || !safeId(input.candidateId) || !safeId(input.taskRunId)) throw new Error('invalid validation record reference');
  if (input.assetVersion !== undefined && !/^[0-9]{1,9}$/.test(input.assetVersion)) throw new Error('invalid validation asset version');
  let assetVersion = input.assetVersion;
  if (assetVersion === undefined) {
    try { const asset = await readAbilityAsset(userId, input.assetId); assetVersion = asset.activeVersion || asset.version; }
    catch { /* Legacy candidate-only observations still retain their own history. */ }
  }
  // A task run is one independent observation. Outcome is intentionally not
  // part of the key so a retry cannot count the same run twice with a changed
  // classification.
  const id = `val-${createHash('sha256').update(`${input.assetId}:${input.candidateId}:${input.taskRunId}`).digest('hex').slice(0, 24)}`;
  const record: ValidationRecord = { schemaVersion: 1, ownerId: userId, id, ...input, ...(assetVersion ? { assetVersion } : {}), createdAt: nowIso() };
  const stored = await updateRecallJsonRecord(userId, 'validation-records', id, (current) => {
    if (current) return current;
    return record;
  });
  const durableRecord = stored as unknown as ValidationRecord;
  if (durableRecord.outcome === 'success' || durableRecord.outcome === 'failure') {
    await applyValidation(userId, durableRecord);
  }
  return durableRecord;
}

/** Reuse the existing owner transition, so a body edit cannot interleave
 * between the exact-version check and either downstream counter application.
 * Legacy rows without an observed version cannot be relabeled as today's asset. */
async function applyValidation(userId: string, record: ValidationRecord, recover = false): Promise<boolean> {
  return withCognitionTransition(userId, async () => {
    let assetReadable = false;
    if (record.assetVersion !== undefined) {
      if (!/^[0-9]{1,9}$/.test(record.assetVersion)) return false;
      try { const asset = await readAbilityAsset(userId, record.assetId); if (asset.version !== record.assetVersion || String(asset.activeVersion || asset.version) !== record.assetVersion) return false; assetReadable = true; }
      catch { /* Candidate-only history may predate its asset handoff. */ }
    }
    if (record.outcome !== 'success' && record.outcome !== 'failure') return false;
    let applied = false;
    try { await recordRecallCandidateValidation(userId, record.candidateId, record.outcome, record.id); applied = true; }
    catch (error) { if (!recover) throw error; log.warn('candidate validation recovery degraded', { validationId: record.id, error: (error as Error).message }); }
    if (assetReadable && record.assetVersion !== undefined) {
      try { await recordAbilityAssetValidation(userId, record.assetId, record.outcome, record.id, record.assetVersion); applied = true; }
      catch { /* The durable ledger survives a partial downstream apply. */ }
    }
    return applied;
  });
}

export async function recoverValidationApplications(userId: string): Promise<number> {
  const records = await listValidationRecords(userId);
  let recovered = 0;
  for (const record of records) {
    if (record.outcome !== 'success' && record.outcome !== 'failure') continue;
    try { if (await applyValidation(userId, record, true)) recovered += 1; }
    catch (error) { log.warn('validation application recovery degraded', { validationId: record.id, error: (error as Error).message }); }
  }
  return recovered;
}

export async function listValidationRecords(userId: string): Promise<ValidationRecord[]> {
  const directory = path.dirname(recallJsonRecordPath(userId, 'validation-records', 'placeholder'));
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  // 逐条降级 + 文件名 safeId 过滤（照抄 listRecallCandidates 的既有口径）：
  // 此前一条坏 .json（损坏 JSON / ownerId 不匹配，或 macOS AppleDouble
  // '._val-*.json' 之类的非法 id 文件名）会让整个列表 reject，启动期的
  // recoverValidationApplications 随之失败——只降级记录形状的错，真正的 IO
  // 故障（带 errno code）照旧上抛。
  const reads = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => {
      const id = name.slice(0, -5);
      try {
        return { id, record: await readRecallJsonRecord(userId, 'validation-records', id) };
      } catch (error) {
        if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
        return { id, error: error as Error };
      }
    }));
  const records: ValidationRecord[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable validation record', { recordId: read.id, error: read.error.message });
      continue;
    }
    if (read.record) records.push(read.record as ValidationRecord);
  }
  return records;
}
