import { listAbilityAssetAudit, listAbilityAssetVersions, listAbilityAssets, readAbilityAsset } from './asset-service';
import { listContextProjections, readContextProjection } from './context-projection';
import { listEffectivenessProofs, listTransferProofs, type TransferProofRecord } from './proof-service';
import { listRecallUsage } from './usage-service';

export type RecallAssetTimelineKind =
  | 'asset_created'
  | 'asset_updated'
  | 'asset_paused'
  | 'asset_resumed'
  | 'asset_revoked'
  | 'asset_archived'
  | 'asset_deleted'
  | 'asset_purged'
  | 'asset_restored'
  | 'asset_rolled_back'
  | 'asset_maturity_downgraded'
  | 'asset_version'
  | 'projection_confirmed'
  | 'usage_recorded'
  | 'transfer_prepared'
  | 'transfer_completed'
  | 'effectiveness_recorded';

export interface RecallAssetTimelineItem {
  id: string;
  kind: RecallAssetTimelineKind;
  occurredAt: string;
  title: string;
  summary?: string;
  status?: string;
  /**
   * 效果评价的**结论**（better / no_improvement / worse / rework /
   * insufficient_evidence / invalid）。
   *
   * 必须和 `status` 分开带：效果证明记录里 `status` 只回答"这次评价本身可不可
   * 归因"（valid / invalid），结论在 `outcome` 上。此前只带 status，渲染层拿
   * 'valid' 去匹配结论词表永远落空，于是退回英文原文，页面上显示成
   * "Effectiveness recorded / User feedback: rework"。
   */
  outcome?: string;
  refs?: {
    assetId?: string;
    version?: string;
    projectionId?: string;
    taskRunId?: string;
    transferProofId?: string;
    usageReceiptId?: string;
    /** 使用记录自身 id（N-5: 不是回执 id，仅展示用，不参与回执索引）。 */
    usage_id?: string;
  };
}

function itemTitle(kind: RecallAssetTimelineKind, extra?: string): string {
  switch (kind) {
    case 'asset_created': return 'Asset created';
    case 'asset_updated': return 'Asset updated';
    case 'asset_paused': return 'Asset paused';
    case 'asset_resumed': return 'Asset resumed';
    case 'asset_revoked': return 'Asset revoked';
    case 'asset_archived': return 'Asset archived';
    case 'asset_deleted': return 'Asset deleted';
    case 'asset_purged': return 'Asset purged';
    case 'asset_restored': return 'Asset restored';
    case 'asset_rolled_back': return 'Asset rolled back';
    case 'asset_maturity_downgraded': return 'Asset maturity downgraded';
    case 'asset_version': return 'Asset version saved';
    case 'projection_confirmed': return 'Projection confirmed';
    case 'usage_recorded': return 'Usage recorded';
    case 'transfer_prepared': return 'Transfer prepared';
    case 'transfer_completed': return extra ? `Transfer ${extra}` : 'Transfer completed';
    case 'effectiveness_recorded': return 'Effectiveness recorded';
  }
}

/**
 * Audit actions are append-only data and can outlive the renderer's original
 * vocabulary. Keep the timeline readable when a newer governance action is
 * present, and ignore genuinely malformed legacy rows instead of producing an
 * item with an undefined kind that crashes the final sort.
 */
function auditTimelineKind(action: unknown): RecallAssetTimelineKind | undefined {
  switch (action) {
    case 'created': return 'asset_created';
    case 'updated': return 'asset_updated';
    case 'paused': return 'asset_paused';
    case 'resumed': return 'asset_resumed';
    case 'revoked': return 'asset_revoked';
    case 'archived': return 'asset_archived';
    case 'deleted': return 'asset_deleted';
    case 'purged': return 'asset_purged';
    case 'restored': return 'asset_restored';
    case 'rolled_back': return 'asset_rolled_back';
    case 'maturity_downgraded': return 'asset_maturity_downgraded';
    case 'pause_recommended':
    case 'rework_recommended':
    case 'recommendation_cleared':
    case 'cross_scope_confirmed':
    case 'cross_scope_withdrawn':
    case 'maturity_advanced':
    case 'maturity_corrected':
      return 'asset_updated';
    default: return undefined;
  }
}

function pushSorted(items: RecallAssetTimelineItem[], item: RecallAssetTimelineItem): void {
  items.push(item);
}

export async function listAbilityAssetTimeline(userId: string, assetId: string): Promise<RecallAssetTimelineItem[]> {
  const asset = await readAbilityAsset(userId, assetId);
  const items: RecallAssetTimelineItem[] = [];

  for (const audit of await listAbilityAssetAudit(userId, assetId)) {
    const kind = auditTimelineKind(audit.action);
    if (!kind || typeof audit.id !== 'string' || !audit.id
      || typeof audit.at !== 'string' || Number.isNaN(Date.parse(audit.at))) continue;
    pushSorted(items, {
      id: audit.id,
      kind,
      occurredAt: audit.at,
      title: itemTitle(kind),
      ...(audit.note ? { summary: audit.note } : {}),
      refs: { assetId: asset.id },
    });
  }

  for (const version of await listAbilityAssetVersions(userId, assetId)) {
    pushSorted(items, {
      id: version.id,
      kind: 'asset_version',
      occurredAt: version.at,
      title: itemTitle('asset_version'),
      summary: `Version ${version.version}`,
      refs: { assetId: asset.id, version: version.version },
    });
  }

  for (const projection of await listContextProjections(userId)) {
    if (projection.status !== 'confirmed' || !projection.assetIds.includes(asset.id)) continue;
    const occurredAt = projection.confirmedAt || projection.decidedAt || projection.createdAt;
    pushSorted(items, {
      id: `${projection.id}-confirmed`,
      kind: 'projection_confirmed',
      occurredAt,
      title: itemTitle('projection_confirmed'),
      summary: projection.purpose,
      refs: { assetId: asset.id, projectionId: projection.id, taskRunId: projection.taskRunId },
    });
  }

  for (const usage of await listRecallUsage(userId, assetId)) {
    pushSorted(items, {
      id: usage.id,
      kind: 'usage_recorded',
      occurredAt: usage.createdAt,
      title: itemTitle('usage_recorded'),
      summary: `Task ${usage.taskRunId}${usage.projectionId ? ` · projection ${usage.projectionId}` : ''}`,
      refs: {
        assetId: asset.id,
        version: usage.assetVersion,
        projectionId: usage.projectionId,
        taskRunId: usage.taskRunId,
        // N-5: usage 行不再伪装 usageReceiptId。前端按 receiptId 索引回执，
        // usage 记录 id 不是回执 id——放了会让「详情/回执」在 usage 行恒查
        // 不到（口径漂移：transfer_completed 行的 usageReceiptId 才是真回执
        // id）。usage 行保留 usage_id 供展示，不参与回执索引。
        usage_id: usage.id,
      },
    });
  }

  const transferProofs = await listTransferProofs(userId);
  const relevantTransfers = transferProofs.filter((proof: TransferProofRecord) => proof.assetVersions.some((entry) => entry.assetId === asset.id));
  for (const proof of relevantTransfers) {
    const projection = await readContextProjection(userId, proof.projectionId);
    pushSorted(items, {
      id: `${proof.id}-prepared`,
      kind: 'transfer_prepared',
      occurredAt: proof.createdAt,
      title: itemTitle('transfer_prepared'),
      summary: `Projection ${proof.projectionId}`,
      refs: {
        assetId: asset.id,
        projectionId: proof.projectionId,
        taskRunId: projection.taskRunId,
        transferProofId: proof.id,
      },
    });
    if (proof.completedAt) {
      pushSorted(items, {
        id: `${proof.id}-completed`,
        kind: 'transfer_completed',
        occurredAt: proof.completedAt,
        title: itemTitle('transfer_completed', proof.status),
        summary: proof.receiptId ? `Receipt ${proof.receiptId}` : undefined,
        status: proof.status,
        refs: {
          assetId: asset.id,
          projectionId: proof.projectionId,
          transferProofId: proof.id,
          ...(proof.receiptId ? { usageReceiptId: proof.receiptId } : {}),
        },
      });
    }
  }

  const effectivenessProofs = await listEffectivenessProofs(userId);
  const transferById = new Map(transferProofs.map((proof) => [proof.id, proof]));
  for (const proof of effectivenessProofs) {
    const transfer = transferById.get(proof.transferProofId);
    if (!transfer || !transfer.assetVersions.some((entry) => entry.assetId === asset.id)) continue;
    pushSorted(items, {
      id: proof.id,
      kind: 'effectiveness_recorded',
      occurredAt: proof.createdAt,
      title: itemTitle('effectiveness_recorded'),
      summary: proof.observedResult,
      status: proof.status,
      outcome: proof.outcome,
      refs: {
        assetId: asset.id,
        // 只带自己这条记录真正持有的引用。回执号属于**迁移证明**，效果证明是
        // 通过 transferProofId 指向它的——在这里顺手把 receiptId 抄过来，等于
        // 断言"效果证明直接持有一张回执"，把 Receipt → Transfer → Effectiveness
        // 三段关系拍成一段。要核对回执，消费方顺着 transferProofId 走一跳。
        transferProofId: proof.transferProofId,
        projectionId: transfer.projectionId,
      },
    });
  }

  return items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}


export async function listRecallTimeline(userId: string, limit = 500): Promise<RecallAssetTimelineItem[]> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 500), 500));
  const assets = await listAbilityAssets(userId);
  const timelines = await Promise.all(assets.map((asset) => listAbilityAssetTimeline(userId, asset.id)));
  return timelines.flat()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .slice(0, boundedLimit);
}
