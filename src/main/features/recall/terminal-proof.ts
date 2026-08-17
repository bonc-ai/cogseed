import { completeTransferProof, completeTransferProofWithReceipt, findTransferProof, prepareTransferProof, type TransferProofRecord } from './proof-service';
import { readContextProjection } from './context-projection';
import { abilityAssetReferencesCover } from './asset-reference';

export type RecallTaskTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'waiting_input';

/**
 * Host-neutral terminal facts. Group Chat and Mate adapters translate their
 * terminal events into this shape before calling the Recall proof handler.
 */
export interface RecallTaskTerminalEvent {
  run_id: string;
  user_id: string;
  conversation_id: string;
  status: RecallTaskTerminalStatus;
  projection_id?: string;
  wake_request_id?: string;
  logical_run_id?: string;
  execution_id?: string;
  /** 本次运行里落过 ContextReuseReceipt 的轮次 id（回执键为 `turn-<id>`）。
   *  这是"资产被真实加载"的唯一凭证入口——PRD 3.6 的 Transfer Verified 要求
   *  真实加载 + 生成 Receipt，没有这份清单就只证明了任务跑完。 */
  reuse_turn_ids?: string[];
  started_at_ms: number;
  finished_at_ms: number;
}

type TerminalProofResult =
  | { handled: true; proof: TransferProofRecord; proofs: TransferProofRecord[] }
  | { handled: false; reason: 'no_confirmed_projection' };

function proofStatusFor(event: RecallTaskTerminalEvent): 'succeeded' | 'degraded' | 'rejected' {
  if (event.status === 'completed') return 'succeeded';
  if (event.status === 'waiting_input') return 'degraded';
  return 'rejected';
}


/** 在本次运行落过的回执里，找覆盖了这次投影资产的那一张。
 *
 *  回执的 `reusedRefs` 记的是"本轮真的注入了哪几条"，所以只要与投影冻结的
 *  assetIds 有交集，就说明这次投影的认知真的被加载过。没有交集或压根没有回执，
 *  就不是 Transfer Verified——宁可停在"任务跑完了"。 */
async function findReuseReceiptForProjection(
  userId: string,
  turnIds: readonly string[],
  assetVersions: readonly { assetId: string; version: string }[],
): Promise<{ receiptId: string; receiptExecutionId: string } | undefined> {
  if (!turnIds.length || !assetVersions.length) return undefined;
  const { readReceipt } = await import('../p3394/context-reuse-receipt');
  for (const turnId of turnIds) {
    try {
      const receipt = await readReceipt(userId, `turn-${turnId}`);
      if (receipt.boundary !== 'real' || receipt.status === 'rejected') continue;
      const covers = abilityAssetReferencesCover(receipt.reusedRefs || [], assetVersions);
      if (covers) return { receiptId: receipt.receiptId, receiptExecutionId: receipt.executionId };
    } catch {
      // 单张回执读不到不影响其它轮次的判定。
    }
  }
  return undefined;
}

export async function handleRecallTaskTerminal(event: RecallTaskTerminalEvent): Promise<TerminalProofResult> {
  const status = proofStatusFor(event);
  const executionId = event.execution_id || event.run_id;
  const logicalRunId = event.logical_run_id || event.run_id;
  if (!event.projection_id) return { handled: false, reason: 'no_confirmed_projection' };

  let projection;
  try {
    projection = await readContextProjection(event.user_id, event.projection_id);
  } catch {
    return { handled: false, reason: 'no_confirmed_projection' };
  }
  if (projection.status !== 'confirmed' || projection.taskRunId !== logicalRunId) {
    return { handled: false, reason: 'no_confirmed_projection' };
  }
  if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) {
    return { handled: false, reason: 'no_confirmed_projection' };
  }

  let proof = await findTransferProof(event.user_id, projection.id, executionId);
  if (!proof) {
    proof = await prepareTransferProof(event.user_id, {
      projectionId: projection.id,
      executionId,
      expectedResultSnapshot: `Task terminal status: ${event.status}.`,
      ...(event.wake_request_id ? { wakeRequestId: event.wake_request_id } : {}),
    });
  }
  if (proof.status === 'prepared') {
    // 找出本次运行里真实加载了这次投影资产的那张回执。显式按 turn id 定位，
    // 不按时间窗反查、也不拿 execution id 硬粘——回执必须指得回某一次真实加载。
    const receipt = await findReuseReceiptForProjection(
      event.user_id,
      event.reuse_turn_ids || [],
      proof.assetVersions,
    );
    const observedTransfer = receipt
      ? `Task run ${logicalRunId} attempt ${executionId} reached ${event.status}; assets were loaded under receipt ${receipt.receiptId}.`
      : `Task run ${logicalRunId} attempt ${executionId} reached terminal status ${event.status}.`;
    proof = receipt
      ? await completeTransferProofWithReceipt(event.user_id, proof.id, {
          status,
          receiptExecutionId: receipt.receiptExecutionId,
          observedTransfer,
        })
      : await completeTransferProof(event.user_id, proof.id, { status, observedTransfer });
  }
  return { handled: true, proof, proofs: [proof] };
}
