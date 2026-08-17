import * as fs from 'node:fs/promises';
import { createLogger } from '../../logger';
import * as path from 'node:path';
import { recallJsonRecordPath } from './paths';
import { genId12 } from '../../storage';
import { safeId } from '../../storage';
import { readAbilityAsset, setAbilityAssetMaturity } from './asset-service';
import { maturityForEffectivenessOutcome, maturityForTransferOutcome } from './formal-assets/policy';
import { readContextProjection } from './context-projection';
import { recordRecallUsage } from './usage-service';
import { readRecallJsonRecord, updateRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from './source-service';
import { readReceipt, type ContextReuseReceipt } from '../p3394/context-reuse-receipt';
import { abilityAssetReferencesCover } from './asset-reference';

const log = createLogger('recall.proofs');

export type TransferProofStatus = 'prepared' | 'succeeded' | 'degraded' | 'rejected';
export type EffectivenessOutcome = 'better' | 'no_improvement' | 'worse' | 'insufficient_evidence' | 'invalid' | 'rework';
export interface TransferProofRecord extends RecallJsonRecord { projectionId: string; executionId: string; expectedResultSnapshot: string; assetVersions: Array<{ assetId: string; version: string }>; status: TransferProofStatus; receiptId?: string; receiptExecutionId?: string; observedTransfer?: string; wakeRequestId?: string; createdAt: string; completedAt?: string; }
export interface EffectivenessProofRecord extends RecallJsonRecord { transferProofId: string; outcome: EffectivenessOutcome; status: 'valid' | 'invalid'; observedResult: string; evidenceRefs: CognitionSourceRef[]; recommendedAction?: 'pause' | 'narrow_scope' | 'rework' | 'rollback_to_version'; createdAt: string; }
function text(value: unknown, field: string, max: number): string { if (typeof value !== 'string') throw new Error(`invalid ${field}`); const out = value.replace(/\s+/g, ' ').trim(); if (!out || out.length > max) throw new Error(`invalid ${field}`); return out; }
function asTransfer(value: RecallJsonRecord): TransferProofRecord { if (typeof value.projectionId !== 'string' || typeof value.executionId !== 'string' || typeof value.expectedResultSnapshot !== 'string' || !Array.isArray(value.assetVersions) || typeof value.status !== 'string' || typeof value.createdAt !== 'string' || (value.receiptExecutionId !== undefined && typeof value.receiptExecutionId !== 'string') || (value.wakeRequestId !== undefined && typeof value.wakeRequestId !== 'string')) throw new Error('malformed transfer proof'); return value as TransferProofRecord; }
function asEffectiveness(value: RecallJsonRecord): EffectivenessProofRecord {
  if (typeof value.transferProofId !== 'string' || typeof value.outcome !== 'string' || typeof value.status !== 'string' || typeof value.observedResult !== 'string' || !Array.isArray(value.evidenceRefs)) throw new Error('malformed effectiveness proof');
  return { ...value, evidenceRefs: normalizeCognitionSourceRefs(value.evidenceRefs) } as EffectivenessProofRecord;
}

function receiptProvesTransfer(
  receipt: ContextReuseReceipt,
  assetVersions: readonly { assetId: string; version: string }[],
): boolean {
  return receipt.boundary === 'real'
    && receipt.status !== 'rejected'
    && abilityAssetReferencesCover(receipt.reusedRefs, assetVersions);
}

async function findValidTransferReceipt(
  userId: string,
  receiptExecutionId: string | undefined,
  receiptId: string | undefined,
  assetVersions: readonly { assetId: string; version: string }[],
): Promise<ContextReuseReceipt | undefined> {
  if (!receiptExecutionId || !receiptId) return undefined;
  try {
    const receipt = await readReceipt(userId, receiptExecutionId);
    return receipt.receiptId === receiptId && receiptProvesTransfer(receipt, assetVersions)
      ? receipt
      : undefined;
  } catch {
    return undefined;
  }
}


export async function listTransferProofs(userId: string): Promise<TransferProofRecord[]> {
  const directory = path.dirname(recallJsonRecordPath(userId, 'transfer-proofs', 'placeholder'));
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => readRecallJsonRecord(userId, 'transfer-proofs', name.slice(0, -5))));
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asTransfer)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findTransferProof(userId: string, projectionId: string, executionId: string): Promise<TransferProofRecord | undefined> {
  return (await listTransferProofs(userId)).find((proof) => proof.projectionId === projectionId && proof.executionId === executionId);
}

export async function prepareTransferProof(userId: string, input: { projectionId: string; executionId: string; expectedResultSnapshot: string; assetIds?: string[]; wakeRequestId?: string }): Promise<TransferProofRecord> {
  const projection = await readContextProjection(userId, input.projectionId);
  if (projection.status !== 'confirmed') throw new Error('transfer proof requires a confirmed projection');
  // 资产事实默认取投影冻结清单；调用方可覆盖为"真实加载"的资产（以回执为准）。
  const assetIds = input.assetIds && input.assetIds.length ? input.assetIds : projection.assetIds;
  const assetVersions = await Promise.all(assetIds.map(async (assetId) => { const asset = await readAbilityAsset(userId, assetId); return { assetId, version: asset.version }; }));
  const now = new Date().toISOString();
  const record: TransferProofRecord = { schemaVersion: 1, ownerId: userId, id: `tp-${genId12()}`, projectionId: projection.id, executionId: text(input.executionId, 'execution id', 160), expectedResultSnapshot: text(input.expectedResultSnapshot, 'expected result snapshot', 4000), assetVersions, status: 'prepared', ...(input.wakeRequestId ? { wakeRequestId: text(input.wakeRequestId, 'wake request id', 160) } : {}), createdAt: now };
  await writeRecallJsonRecord(userId, 'transfer-proofs', record.id, record);
  return record;
}
async function completeTransferProofRecord(
  userId: string,
  proofId: string,
  input: {
    status: Exclude<TransferProofStatus, 'prepared'>;
    observedTransfer: string;
    receipt?: ContextReuseReceipt;
  },
): Promise<TransferProofRecord> {
  const existing = await readRecallJsonRecord(userId, 'transfer-proofs', proofId);
  if (!existing) throw new Error('transfer proof not found');
  const current = asTransfer(existing);
  if (input.receipt && !receiptProvesTransfer(input.receipt, current.assetVersions)) {
    throw new Error('transfer receipt does not prove all projected assets');
  }
  const updated = await updateRecallJsonRecord(userId, 'transfer-proofs', proofId, (raw) => { if (!raw) throw new Error('transfer proof not found'); const current = asTransfer(raw); if (current.status !== 'prepared') throw new Error('transfer proof is already complete'); if (input.status !== 'succeeded' && input.status !== 'degraded' && input.status !== 'rejected') throw new Error('invalid transfer proof status'); return { ...current, status: input.status, ...(input.receipt ? { receiptId: text(input.receipt.receiptId, 'receipt id', 160), receiptExecutionId: text(input.receipt.executionId, 'receipt execution id', 160) } : {}), observedTransfer: text(input.observedTransfer, 'observed transfer', 4000), completedAt: new Date().toISOString() }; });
  const proof = asTransfer(updated);
  if (proof.status === 'succeeded') {
    const projection = await readContextProjection(userId, proof.projectionId);
    // PRD 3.6 的 Transfer Verified 要求「目标 Agent 或隔离新 Session 真实加载该
    // 资产，形成可追溯 Action Plan 或可观察行为，**并生成 Receipt**」。没有回执
    // 就只证明了任务跑完，没证明这条资产被正确带入——不升档。
    // 使用记录照常写：它记的是"这次运行引用过它"，与够不够格升档无关。
    const validReceipt = await findValidTransferReceipt(userId, proof.receiptExecutionId, proof.receiptId, proof.assetVersions);
    for (const item of proof.assetVersions) {
      const advanced = validReceipt ? maturityForTransferOutcome(proof.status) : undefined;
      if (advanced) await setAbilityAssetMaturity(userId, item.assetId, advanced);
      await recordRecallUsage(userId, { assetId: item.assetId, assetVersion: item.version, taskRunId: projection.taskRunId, projectionId: projection.id, ...(projection.workspaceId ? { workspaceId: projection.workspaceId } : {}), outcome: proof.status });
    }
    if (!validReceipt) {
      log.info('transfer proof completed without a reuse receipt; maturity unchanged', {
        proofId: proof.id,
        projectionId: proof.projectionId,
        assetIds: proof.assetVersions.map((item) => item.assetId),
      });
    }
  }
  return proof;
}

/** Complete a transfer without claiming that a ContextReuseReceipt belongs to it.
 *  This is the only completion path exposed through renderer IPC. A successful
 *  task without a trusted receipt remains useful usage history, but cannot
 *  advance formal-asset maturity. */
export async function completeTransferProof(
  userId: string,
  proofId: string,
  input: { status: Exclude<TransferProofStatus, 'prepared'>; observedTransfer: string },
): Promise<TransferProofRecord> {
  return completeTransferProofRecord(userId, proofId, input);
}

/** Bind a transfer proof to the exact immutable receipt execution selected by
 *  the host terminal path. This function is intentionally not exposed through
 *  renderer IPC: receipt ids alone are globally discoverable history and do
 *  not prove that an old receipt belongs to the current transfer. */
export async function completeTransferProofWithReceipt(
  userId: string,
  proofId: string,
  input: {
    status: Exclude<TransferProofStatus, 'prepared'>;
    receiptExecutionId: string;
    observedTransfer: string;
  },
): Promise<TransferProofRecord> {
  const receiptExecutionId = text(input.receiptExecutionId, 'receipt execution id', 160);
  const receipt = await readReceipt(userId, receiptExecutionId);
  return completeTransferProofRecord(userId, proofId, {
    status: input.status,
    observedTransfer: input.observedTransfer,
    receipt,
  });
}
export async function evaluateEffectivenessProof(userId: string, input: { transferProofId: string; outcome: EffectivenessOutcome; observedResult: string; evidenceRefs: unknown[] }): Promise<EffectivenessProofRecord> {
  const raw = await readRecallJsonRecord(userId, 'transfer-proofs', input.transferProofId); if (!raw) throw new Error('transfer proof not found'); const transfer = asTransfer(raw); if (transfer.status !== 'succeeded') throw new Error('effectiveness proof requires a successful transfer');
  if (!await findValidTransferReceipt(userId, transfer.receiptExecutionId, transfer.receiptId, transfer.assetVersions)) throw new Error('effectiveness proof requires a verified transfer receipt');
  if (!['better','no_improvement','worse','insufficient_evidence','invalid','rework'].includes(input.outcome)) throw new Error('invalid effectiveness outcome');
  const refs = normalizeCognitionSourceRefs(input.evidenceRefs);
  // A positive click is useful feedback, but without a traceable comparison it
  // is not proof that the asset improved the outcome. Preserve the record and
  // downgrade its conclusion instead of silently promoting maturity.
  const outcome = input.outcome === 'better' && refs.length === 0
    ? 'insufficient_evidence'
    : input.outcome;
  const valid = outcome !== 'invalid';
  const recommendedAction = outcome === 'worse' ? 'pause' : outcome === 'rework' ? 'rework' : undefined;
  const record: EffectivenessProofRecord = { schemaVersion: 1, ownerId: userId, id: `ep-${genId12()}`, transferProofId: transfer.id, outcome, status: valid ? 'valid' : 'invalid', observedResult: text(input.observedResult, 'observed result', 4000), evidenceRefs: refs, ...(recommendedAction ? { recommendedAction } : {}), createdAt: new Date().toISOString() };
  await writeRecallJsonRecord(userId, 'effectiveness-proofs', record.id, record);
  const effectivenessMaturity = maturityForEffectivenessOutcome(record.outcome, record.status === 'valid');
  if (effectivenessMaturity) {
    for (const item of transfer.assetVersions) await setAbilityAssetMaturity(userId, item.assetId, effectivenessMaturity);
  }
  return asEffectiveness(record);
}

/** 列出全部效果证明。与 listTransferProofs 同构——迁移证明能按目录扫，
 *  效果证明也该能，否则「这条资产有没有被证明有用」永远问不出来。 */
export async function listEffectivenessProofs(userId: string): Promise<EffectivenessProofRecord[]> {
  const directory = path.dirname(recallJsonRecordPath(userId, 'effectiveness-proofs', 'placeholder'));
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => readRecallJsonRecord(userId, 'effectiveness-proofs', name.slice(0, -5))));
  return records
    .filter((record): record is RecallJsonRecord => Boolean(record))
    .map(asEffectiveness)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 一次迁移，加上挂在它上面的效果结论。 */
export interface AssetProofView {
  transfer: TransferProofRecord;
  /** 这次迁移带的是这条资产的哪一版。 */
  version: string;
  /** 同一次迁移可以被评价多次（复评、改判），全部列出，不只留最后一条。 */
  effectiveness: EffectivenessProofRecord[];
}

/**
 * 按资产反查证明。
 *
 * **迁移证明与效果证明说的不是一回事，这里刻意不合并成一个「已验证」布尔值：**
 *
 *   transfer.status = succeeded      → 它确实被带过去、被用了（USED）
 *   effectiveness.outcome = better   → 用了之后确实更好（PROVED_USEFUL）
 *   effectiveness.outcome = worse    → **也是一条证明**，证明它没帮上忙
 *
 * 只显示 better 会把「证明」变成宣传：一条被证明有害的资产和一条从没被评价过
 * 的资产在界面上会长得一样。所以三种结论一视同仁地列出来。
 */
export async function listAssetProofs(userId: string, assetId: string): Promise<AssetProofView[]> {
  if (!safeId(assetId)) throw new Error('invalid recall asset id');
  const [transfers, effectiveness] = await Promise.all([
    listTransferProofs(userId),
    listEffectivenessProofs(userId),
  ]);
  const byTransfer = new Map<string, EffectivenessProofRecord[]>();
  for (const record of effectiveness) {
    const list = byTransfer.get(record.transferProofId) || [];
    list.push(record);
    byTransfer.set(record.transferProofId, list);
  }

  const views: AssetProofView[] = [];
  for (const transfer of transfers) {
    const carried = transfer.assetVersions.find((item) => item.assetId === assetId);
    if (!carried) continue;
    views.push({
      transfer,
      version: carried.version,
      effectiveness: byTransfer.get(transfer.id) || [],
    });
  }
  return views;
}
