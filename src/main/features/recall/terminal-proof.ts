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


/** 归一化回执引用：可能带前缀（`asset:aa-xxx`）——按尾段取资产 id。 */
function bareAssetId(ref: unknown): string | undefined {
  const raw = String(ref || '');
  if (!raw) return undefined;
  const tail = raw.slice(raw.lastIndexOf(':') + 1);
  return tail.length > 0 ? tail : undefined;
}

/**
 * 以回执为准（产品决定 2026-08-16）：回执的 `reusedRefs` 是"本轮真的注入了
 * 哪几条"的唯一事实。终态证明升档的资产清单 = 本次运行全部回执的并集，提交
 * 投影只作为治理记录（证明挂在哪个投影上），不再当证明锚点——投影冻结清单与
 * 回合实际注入集合会因阈值校准等漂移（实机观测：提交投影含旧阈值资产，回合
 * 自动投影按新阈值过滤后两者无交集），导致回执永远"覆盖不到"投影资产。
 */
async function collectLoadedAssetsFromReceipts(
  userId: string,
  turnIds: readonly string[],
): Promise<{ loadedAssetIds: string[]; receipts: Array<{ receiptId: string; executionId: string; reusedRefs: string[] }> }> {
  if (!turnIds.length) return { loadedAssetIds: [], receipts: [] };
  const { readReceipt } = await import('../p3394/context-reuse-receipt');
  const loadedAssetIds: string[] = [];
  const receipts: Array<{ receiptId: string; executionId: string; reusedRefs: string[] }> = [];
  const seen = new Set<string>();
  for (const turnId of turnIds) {
    try {
      const receipt = await readReceipt(userId, `turn-${turnId}`);
      if (receipt.boundary !== 'real' || receipt.status === 'rejected') continue;
      receipts.push({ receiptId: receipt.receiptId || `turn-${turnId}`, executionId: receipt.executionId, reusedRefs: receipt.reusedRefs || [] });
      for (const ref of receipt.reusedRefs || []) {
        const id = bareAssetId(ref);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        loadedAssetIds.push(id);
      }
    } catch {
      // 单张回执读不到不影响其它轮次的判定。
    }
  }
  return { loadedAssetIds, receipts };
}

/** 本次运行回执覆盖的、仍存在的资产（以回执为准的升档事实）。 */
async function loadedExistingAssets(
  userId: string,
  turnIds: readonly string[],
): Promise<{ existing: string[]; receipts: Array<{ receiptId: string; executionId: string; reusedRefs: string[] }> }> {
  const { loadedAssetIds, receipts } = await collectLoadedAssetsFromReceipts(userId, turnIds);
  const { readAbilityAsset } = await import('./asset-service');
  const existing: string[] = [];
  for (const assetId of loadedAssetIds) {
    try {
      await readAbilityAsset(userId, assetId);
      existing.push(assetId);
    } catch {
      // 回执引用了已删除/合并的资产——不参与升档，也不让证明失败。
    }
  }
  return { existing, receipts };
}

function findReceiptCoveringAssets(
  receipts: ReadonlyArray<{ receiptId: string; executionId: string; reusedRefs: string[] }>,
  assetVersions: readonly { assetId: string; version: string }[],
): { receiptId: string; executionId: string; reusedRefs: string[] } | undefined {
  return receipts.find((receipt) => abilityAssetReferencesCover(receipt.reusedRefs, assetVersions));
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

  const { existing, receipts } = await loadedExistingAssets(event.user_id, event.reuse_turn_ids || []);

  let proof = await findTransferProof(event.user_id, projection.id, executionId);
  if (!proof) {
    // 以回执为准：真实加载并生成回执的资产才是本次迁移证明的资产事实。
    // 没有回执（或回执为空）时退回投影冻结清单——只记录"任务跑完"，不升档。
    proof = await prepareTransferProof(event.user_id, {
      projectionId: projection.id,
      executionId,
      expectedResultSnapshot: `Task terminal status: ${event.status}.`,
      ...(existing.length ? { assetIds: existing } : {}),
      ...(event.wake_request_id ? { wakeRequestId: event.wake_request_id } : {}),
    });
  }
  if (proof.status === 'prepared') {
    // 找出本次运行里真实加载了这次投影资产的那张回执。显式按 turn id 定位，
    // 不按时间窗反查、也不拿 execution id 硬粘——回执必须指得回某一次真实加载。
    const receipt = findReceiptCoveringAssets(receipts, proof.assetVersions);
    const observedTransfer = receipt
      ? `Task run ${logicalRunId} attempt ${executionId} reached ${event.status}; assets were loaded under receipt ${receipt.receiptId}.`
      : `Task run ${logicalRunId} attempt ${executionId} reached terminal status ${event.status}.`;
    proof = receipt
      ? await completeTransferProofWithReceipt(event.user_id, proof.id, {
          status,
          receiptExecutionId: receipt.executionId,
          observedTransfer,
        })
      : await completeTransferProof(event.user_id, proof.id, { status, observedTransfer });
  }
  return { handled: true, proof, proofs: [proof] };
}
