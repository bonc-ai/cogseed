import { listAbilityAssetAudit, listAbilityAssetVersions, listAbilityAssets, readAbilityAsset } from './asset-service';
import { listAllContextProjections, readContextProjection, type ProjectionAuthorization } from './context-projection';
import { listEffectivenessProofs, listTransferProofs, transferReceiptIsProven, type TransferProofRecord } from './proof-service';
import { listRecallUsage } from './usage-service';
import { createLogger } from '../../logger';

const log = createLogger('recall.timeline');

/** 一条坏记录不应拖垮整个时间线：
 *  集合读取对记录形状错误降级为空集、少几行事件；真正的 IO 故障（带 errno
 *  code）照旧上抛——静默少几行等于把磁盘问题伪装成「时间线变短了」。 */
async function readTimelineSet<T>(
  label: string,
  read: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await read();
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
    log.warn('timeline source degraded; events from it are skipped', { source: label, error: (error as Error).message });
    return [];
  }
}

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
  | 'asset_version_selected'
  | 'asset_maturity_downgraded'
  | 'asset_version'
  | 'projection_confirmed'
  | 'projection_revoked'
  | 'usage_recorded'
  | 'transfer_prepared'
  | 'transfer_completed'
  | 'effectiveness_recorded' | 'catalog_hint_unused';

/** 真实使用事件的统一白名单，列表、详情和排序因子共用。
 * 仅包含被带入任务或实际使用的事件；创建、版本、治理和撤销不抬高最近使用时间。
 * 是否实际采用另按 applied/real 的使用回执判断，见 asset-usage-receipt。 */
export const REAL_USAGE_KINDS: readonly RecallAssetTimelineKind[] = ['usage_recorded', 'projection_confirmed'];

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
   * 与 `status` 分开传递：`status` 表示评价是否可归因（valid / invalid），
   * `outcome` 表示评价结论，渲染层分别匹配各自的词表。
   */
  outcome?: string;
  refs?: {
    assetId?: string;
    version?: string;
    projectionId?: string;
    taskRunId?: string;
    /** 来源会话 id：使用记录页按它 join 会话名展示（不显示裸 id）。 */
    conversationId?: string;
    transferProofId?: string;
    usageReceiptId?: string;
    /** 使用记录自身 id（不是回执 id，仅展示用，不参与回执索引）。 */
    usage_id?: string;
    /** 已确认投影的原始授权/用途：详情页据此识别仍可撤销的长期挂载。 */
    authorization?: ProjectionAuthorization;
    purpose?: string;
    expiresAt?: string;
    /** 使用记录的 outcome：injected/dispatched/agent_read、执行结果或用户反馈。
     * 用于区分带入与实际采用；不复用顶层 outcome 的效果评价语义。 */
    usageOutcome?: string;
  };
}

function itemTitle(kind: RecallAssetTimelineKind, extra?: string): string {
  switch (kind) {
    case 'catalog_hint_unused': return 'Marked relevant but not used';
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
    case 'asset_version_selected': return 'Asset version selected';
    case 'asset_maturity_downgraded': return 'Asset maturity downgraded';
    case 'asset_version': return 'Asset version saved';
    case 'projection_confirmed': return 'Projection confirmed';
    case 'projection_revoked': return 'Attachment revoked';
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
    case 'version_selected': return 'asset_version_selected';
    case 'maturity_downgraded': return 'asset_maturity_downgraded';
    case 'pause_recommended':
    case 'rework_recommended':
    case 'recommendation_cleared':
    case 'cross_scope_confirmed':
    case 'cross_scope_withdrawn':
    case 'maturity_advanced':
    case 'maturity_corrected':
    case 'merged_from':
    case 'merged_into':
    case 'version_deleted':
      return 'asset_updated';
    default: return undefined;
  }
}

function pushSorted(items: RecallAssetTimelineItem[], item: RecallAssetTimelineItem): void {
  items.push(item);
}

/** 投影 → 最近可评价的迁移证明。效果评价只接受成功且有已验证回执的迁移；
 *  降级/拒绝记录仍保留在时间线，但不给它们生成会被后端拒绝的评价入口。 */
async function buildTransferProofIndex(userId: string, proofs: TransferProofRecord[]): Promise<Map<string, string>> {
  const index = new Map<string, { id: string; completedAt: string }>();
  for (const proof of proofs) {
    if (!proof.projectionId || !proof.completedAt || proof.status !== 'succeeded') continue;
    if (!await transferReceiptIsProven(userId, proof.receiptExecutionId, proof.receiptId, proof.assetVersions)) continue;
    const prev = index.get(proof.projectionId);
    if (!prev || String(proof.completedAt) > prev.completedAt) {
      index.set(proof.projectionId, { id: proof.id, completedAt: String(proof.completedAt) });
    }
  }
  const ids = new Map<string, string>();
  for (const [projectionId, { id }] of index) ids.set(projectionId, id);
  return ids;
}

/** Shared only by this timeline request. Writes and other users never share its read results. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => result ??= Promise.resolve().then(read);
}
async function readEpisodeConversations(userId: string): Promise<Map<string, string>> {
  const episodeConversationByRun = new Map<string, string>();
  try {
    const { listKstarEpisodes } = await import('../kstar/episode-store');
    for (const episode of await listKstarEpisodes(userId)) {
      const sessionId = episode.sessionId ? String(episode.sessionId).replace(/^gconv-/, '') : '';
      if (!sessionId) continue;
      if (episode.taskRunId) episodeConversationByRun.set(String(episode.taskRunId), sessionId);
      for (const runId of Array.isArray(episode.reuseTurnIds) ? episode.reuseTurnIds : []) {
        if (runId) episodeConversationByRun.set(String(runId), sessionId);
      }
    }
  } catch { /* kstar 不可用不阻断时间线 */ }
  return episodeConversationByRun;
}
function createTimelineReads(userId: string) {
  const transfers = once(() => readTimelineSet('transfer-proofs', () => listTransferProofs(userId)));
  const projections = new Map<string, Promise<Awaited<ReturnType<typeof readContextProjection>>>>();
  return {
    episodes: once(() => readEpisodeConversations(userId)),
    projections: once(() => listAllContextProjections(userId)),
    injections: once(async () => {
      try { return await (await import('./injection-receipt')).listInjectionReceipts(userId); }
      catch { return []; } // Same optional audit source as the single-asset read.
    }),
    transfers,
    transferIndex: once(async () => buildTransferProofIndex(userId, await transfers())),
    transferById: once(async () => new Map((await transfers()).map(proof => [proof.id, proof]))),
    effectiveness: once(() => readTimelineSet('effectiveness-proofs', () => listEffectivenessProofs(userId))),
    usage: once(() => readTimelineSet('usage-records', () => listRecallUsage(userId))),
    projection(id: string) {
      let read = projections.get(id);
      if (!read) { read = readContextProjection(userId, id); projections.set(id, read); }
      return read;
    },
  };
}

export async function listAbilityAssetTimeline(userId: string, assetId: string): Promise<RecallAssetTimelineItem[]> {
  return buildAssetTimeline(userId, await readAbilityAsset(userId, assetId), createTimelineReads(userId));
}
async function buildAssetTimeline(userId: string, asset: Awaited<ReturnType<typeof readAbilityAsset>>,
  reads: ReturnType<typeof createTimelineReads>): Promise<RecallAssetTimelineItem[]> {
  const assetId = asset.id;
  const items: RecallAssetTimelineItem[] = [];
  const episodeConversationByRun = await reads.episodes();

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

  for (const version of await listAbilityAssetVersions(userId, assetId, asset)) {
    pushSorted(items, {
      id: version.id,
      kind: 'asset_version',
      occurredAt: version.at,
      title: itemTitle('asset_version'),
      summary: `Version ${version.version}`,
      refs: { assetId: asset.id, version: version.version },
    });
  }

  // 资产事实链不能只看最近 20 条投影：较早但仍有效的固定版本仍可能被后续任务读取。
  for (const projection of await reads.projections()) {
    // 撤销的模型自选或用户钉住投影仍入时间线，保留历史授权与撤销记录。
    const isRevokedAttachment = projection.status === 'revoked'
      && (projection.authorization === 'model_selected'
        || (projection.authorization === 'user_confirmed' && projection.purpose === 'user_pinned'));
    if (projection.status !== 'confirmed' && !isRevokedAttachment) continue;
    if (!projection.assetIds.includes(asset.id)) continue;
    if (isRevokedAttachment) {
      const revokedAt = String(projection.decidedAt || projection.createdAt || '');
      const revokedConversationId = projection.conversationId
        || episodeConversationByRun.get(String(projection.taskRunId || ''));
      pushSorted(items, {
        id: `${projection.id}-revoked`,
        kind: 'projection_revoked',
        occurredAt: revokedAt,
        title: itemTitle('projection_revoked'),
        summary: projection.purpose,
        refs: {
          assetId: asset.id,
          projectionId: projection.id,
          taskRunId: projection.taskRunId,
          ...(revokedConversationId ? { conversationId: revokedConversationId } : {}),
        },
      });
      continue;
    }
    const occurredAt = projection.confirmedAt || projection.decidedAt || projection.createdAt;
    const projectionConversationId = projection.conversationId
      || episodeConversationByRun.get(String(projection.taskRunId || ''));
    pushSorted(items, {
      id: `${projection.id}-confirmed`,
      kind: 'projection_confirmed',
      occurredAt,
      title: itemTitle('projection_confirmed'),
      summary: projection.purpose,
      refs: {
        assetId: asset.id,
        version: projection.assetVersions?.[asset.id],
        projectionId: projection.id,
        taskRunId: projection.taskRunId,
        authorization: projection.authorization,
        purpose: projection.purpose,
        ...(projection.expiresAt ? { expiresAt: projection.expiresAt } : {}),
        ...(projectionConversationId ? { conversationId: projectionConversationId } : {}),
      },
    });
  }

  // 漏取审计行：catalog_hint 回执（目录标★相关但该回合未被
  // 使用）→「相关而未被用」时间线行。只列该资产的，读回执流全量后过滤。
  try {
    for (const receipt of await reads.injections()) {
      if (receipt.channel !== 'catalog_hint' || receipt.status !== 'omitted') continue;
      if (String(receipt.assetId) !== asset.id) continue;
      pushSorted(items, {
        id: `catalog-hint-${receipt.id}`,
        kind: 'catalog_hint_unused',
        occurredAt: receipt.createdAt,
        title: itemTitle('catalog_hint_unused'),
        summary: '目录标注了「本轮相关」，但这一轮没有被注入或取用',
        refs: {
          assetId: asset.id,
          taskRunId: receipt.taskRunId,
          ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
        },
      });
    }
  } catch {
    // 回执流读不到就少几行审计，不影响其余时间线。
  }

  // usage → 来源会话：usage 只带 projectionId，会话 id 在投影记录上——
  // 按投影 id 建缓存（同一批 usage 常共享投影，避免逐条读盘）。
  const projectionConversations = new Map<string, string>();
  const conversationOfProjection = async (projectionId?: string): Promise<string | undefined> => {
    if (!projectionId) return undefined;
    const cached = projectionConversations.get(projectionId);
    if (cached !== undefined) return cached || undefined;
    try {
      const projection = await reads.projection(projectionId);
      const conversationId = projection.conversationId || '';
      projectionConversations.set(projectionId, conversationId);
      return conversationId || undefined;
    } catch {
      projectionConversations.set(projectionId, '');
      return undefined;
    }
  };
  // 证明集合只读一次，按投影建索引供使用和迁移事件共用。
  // readTimelineSet 隔离坏记录，实际 IO 故障仍上抛。
  const transferProofs = await reads.transfers();
  const transferProofByProjection = await reads.transferIndex();
  for (const usage of (await reads.usage()).filter(row => row.assetId === assetId)) {
    // 会话 id：新投影的 conversationId 优先；旧数据用 episode 的
    // taskRunId→sessionId 回溯——用户要求老记录也能看出"在哪个对话里被用"。
    const usageConversationId = (await conversationOfProjection(usage.projectionId))
      || episodeConversationByRun.get(String(usage.taskRunId || ''));
    // 评价绑定在这次已成功的使用上。宿主刚注入、模型自读、失败迁移或用户
    // 已经提交的反馈都不能再挂同一个效果评价入口；旧流水没有 outcome 时，
    // 仅在投影确有成功且可验证的迁移证明时保留兼容入口。
    const usageOutcome = String(usage.outcome || '');
    const ratingEligibleUsage = !usageOutcome || usageOutcome === 'succeeded';
    const usageProofId = usage.projectionId && ratingEligibleUsage
      ? transferProofByProjection.get(usage.projectionId)
      : undefined;
    pushSorted(items, {
      id: usage.id,
      kind: 'usage_recorded',
      occurredAt: usage.createdAt,
      title: itemTitle('usage_recorded'),
      // taskRunId / projectionId 是定位键，已经在 refs 里；摘要不再把它们拼成
      // 展示文案。版本是用户看得懂的信息，留下。
      summary: usage.assetVersion ? `v${usage.assetVersion}` : '',
      refs: {
        assetId: asset.id,
        version: usage.assetVersion,
        projectionId: usage.projectionId,
        taskRunId: usage.taskRunId,
        ...(usageProofId ? { transferProofId: usageProofId } : {}),
        ...(usageConversationId ? { conversationId: usageConversationId } : {}),
        // outcome 随行下发：让渲染层能按"怎么用到的"分开
        // 措辞，而不是把宿主注入也写成"被实际使用"。旧记录没有该字段就省略。
        ...(usage.outcome ? { usageOutcome: String(usage.outcome) } : {}),
        // usage 行不使用 usageReceiptId。前端按 receiptId 索引回执，
        // usage 记录 id 不是回执 id——放了会让「详情/回执」在 usage 行恒查
        // 不到（口径漂移：transfer_completed 行的 usageReceiptId 才是真回执
        // id）。usage 行保留 usage_id 供展示，不参与回执索引。
        usage_id: usage.id,
      },
    });
  }

  const relevantTransfers = transferProofs.filter((proof: TransferProofRecord) => proof.assetVersions.some((entry) => entry.assetId === asset.id));
  for (const proof of relevantTransfers) {
    // 历史证明的投影可能已不存在；保留事件，省略不可恢复的投影上下文。
    let projection: Awaited<ReturnType<typeof readContextProjection>> | undefined;
    try {
      projection = await reads.projection(proof.projectionId);
    } catch {
      projection = undefined;
    }
    pushSorted(items, {
      id: `${proof.id}-prepared`,
      kind: 'transfer_prepared',
      occurredAt: proof.createdAt,
      title: itemTitle('transfer_prepared'),
      summary: `Projection ${proof.projectionId}`,
      refs: {
        assetId: asset.id,
        projectionId: proof.projectionId,
        ...(projection?.taskRunId ? { taskRunId: projection.taskRunId } : {}),
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

  const effectivenessProofs = await reads.effectiveness();
  const transferById = await reads.transferById();
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
  const reads = createTimelineReads(userId);
  const timelines = await Promise.all(assets.map((asset) => buildAssetTimeline(userId, asset, reads)));
  return timelines.flat()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .slice(0, boundedLimit);
}
