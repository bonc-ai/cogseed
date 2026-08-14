/** 一条认知的履历与证据。
 *
 *  **这不是流程完成度。** 底下确实有 `Source → Candidate → Asset → 继承 → Reuse`
 *  这条实现链路，但对用户呈现的是一份履历：这条判断从哪来、成了什么、谁带着它、
 *  真用过几次、哪几次没用上为什么。一条只在两个智能体里躺着、还没被任务带入的
 *  认知，不是「五步只走了三步」，它就是一条还没被用过的认知——这两种说法给用户的
 *  暗示完全不同。
 *
 *  由此来的三条纪律：
 *
 *  1. **段名用用户语言。** `formation / settling / inheritance / use / evidence`，
 *     不叫 pack / receipt。ContextReuseReceipt 这些实现名只能出现在开发者详情里，
 *     用户层看到的是「进入了哪些智能体」「实际用过几次」。
 *  2. **状态词避开进度语义。** 用 `happened` / `not_yet`，不用 completed / pending
 *     —— 后者暗示欠着一步没做。调用方不得把 `not_yet` 渲染成红色或警告。
 *  3. **只报事实，不下结论。** 给「在 4 次任务中实际带入」这种用户自己能数的数，
 *     不给「这条很稳」。未带入的次数要带原因，沉默比说错更伤信任。
 */

import type { CognitionSourceRef } from './source-service';
import type { RecallAbilityAssetRecord } from './candidate-service';

/** 用户层的五段命名。刻意不叫 pack / receipt——那是实现名，
 *  用户看到的是「进入了哪些智能体」「实际用过几次」。 */
export type ChainStage = 'formation' | 'settling' | 'inheritance' | 'use' | 'evidence';

/** 段是否已经发生过。命名刻意避开 completed/pending 一类进度词：
 *  这是一份履历，不是一条要走满的流程。没发生就是还没发生，不是欠着。 */
export type ChainSegmentStatus = 'happened' | 'not_yet';

export interface ChainSegment {
  stage: ChainStage;
  status: ChainSegmentStatus;
  /** 第一次到达这一段的时间。未到达时缺失。 */
  at?: string;
  /** 这一段发生了多少次（如进过几个智能体、被复用几次）。 */
  count?: number;
  /** 面向用户的事实描述，不含系统结论。 */
  detail?: string;
}

/** 某次本来该带上、结果没带上的记录。用户问「为什么这次没用我这条」时，
 *  答案必须是具体原因，不能是沉默。 */
export interface ChainWithheldEntry {
  /** 撤销 / 暂停 / 资产已删 / 因长度截断。 */
  reason: string;
  at: string;
}

export interface CognitionChainView {
  assetId?: string;
  candidateId?: string;
  /** 这条认知的来源证据。 */
  sourceRefs: CognitionSourceRef[];
  /** 资产当前状态，撤销/暂停/归档要在追溯里看得见。 */
  assetStatus?: RecallAbilityAssetRecord['status'];
  assetVersion?: string;
  /** 带走这条认知的智能体 id。 */
  carriedByAgentIds: string[];
  /** 实际把它带进去的会话数。 */
  usedInSessions: number;
  /** 没带上的次数与原因。 */
  withheld: ChainWithheldEntry[];
  segments: ChainSegment[];
}

function segment(
  stage: ChainStage,
  reached: boolean,
  extra: { at?: string; count?: number; detail?: string } = {},
): ChainSegment {
  return {
    stage,
    status: reached ? 'happened' : 'not_yet',
    ...(extra.at ? { at: extra.at } : {}),
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

/** 回执里的资产引用形如 `asset:<id>@v<version>`，可能带 `:reason` 后缀。 */
function refMentionsAsset(ref: string, assetId: string): boolean {
  return ref === `asset:${assetId}` || ref.startsWith(`asset:${assetId}@`);
}

/** 状态在履历里怎么说。用用户能懂的词，且不把 deleted/purged 说成「撤销」——
 *  撤销是用户否定了这条判断，删除是把它拿走，两件事。 */
const STATUS_LABEL: Record<RecallAbilityAssetRecord['status'], string> = {
  active: '',
  paused: ' · 已暂停',
  archived: ' · 已归档',
  revoked: ' · 已撤销',
  deleted: ' · 已删除',
  purged: ' · 已彻底清除',
};

/**
 * 按资产追溯整条链路。
 *
 * 入口选资产而不是候选，因为用户在能力册里看到的是资产——「这条是怎么来的、
 * 被用过没有」是从资产往两头看，不是从候选往下看。
 */
export async function traceCognitionChainByAsset(
  userId: string,
  assetId: string,
): Promise<CognitionChainView> {
  const [assetService, candidateService, inheritance, receipts] = await Promise.all([
    import('./asset-service'),
    import('./candidate-service'),
    import('../agent_inheritance'),
    import('../p3394/context-reuse-receipt'),
  ]);

  const asset = await assetService.readAbilityAsset(userId, assetId);

  // 候选：资产记着它从哪条候选长出来的，反查拿到来源证据与沉淀时间。
  let candidate = null;
  try {
    candidate = await candidateService.readRecallCandidate(userId, asset.candidateId);
  } catch {
    // 候选被清理过：资产仍然成立，但溯源链断了一节，如实反映。
    candidate = null;
  }

  const sourceRefs = candidate?.sourceRefs ?? asset.evidenceRefs;

  // 继承：扫所有 Agent 出生快照，看这条资产进过谁。
  const births = (await inheritance.listAgentInheritance(userId))
    .filter((record) => record.inheritedAssets.some((ref) => ref.asset_id === assetId));

  // 实际使用与「本可用却没带上」：同一批回执，两个方向都要看。
  const allReceipts = await receipts.listReceipts(userId);
  // rejected 的那次是「本来要带、最后被拒了」，算进「实际带入」会虚报。
  // prepared 算——它表示这一轮确实把认知带进去了；用得好不好是 proof 的事，不是这里。
  const uses = allReceipts.filter((r) => (
    r.status !== 'rejected' && r.reusedRefs.some((ref) => refMentionsAsset(ref, assetId))
  ));
  const withheld: ChainWithheldEntry[] = [];
  for (const receipt of allReceipts) {
    for (const ref of receipt.omittedRefs) {
      if (!refMentionsAsset(ref, assetId)) continue;
      // 引用形如 `asset:<id>@v<n>:<reason>`——前两段是固定的 `asset` 与 `<id>@v<n>`，
      // 之后的全部才是原因（原因本身允许含冒号）。
      //
      // 早先这里写的是 `slice(3) || pop()`：这个格式 split 出来只有三段，slice(3)
      // 恒为空，一直靠 pop() 兜底才碰巧对。而 pop() 在「没带原因」的引用上会把
      // `<id>@v<n>` 当成原因返回——用户会看到一句 aa-xxxx@v1 冒充的解释。
      const reason = ref.split(':').slice(2).join(':') || 'unknown';
      withheld.push({ reason, at: receipt.createdAt });
    }
  }

  const carriedByAgentIds = births.map((record) => record.agentId);

  return {
    assetId,
    ...(candidate ? { candidateId: candidate.id } : {}),
    sourceRefs,
    assetStatus: asset.status,
    assetVersion: asset.version,
    carriedByAgentIds,
    usedInSessions: uses.length,
    withheld,
    segments: [
      // 形成：这条判断是从哪些真实材料里长出来的。
      segment('formation', sourceRefs.length > 0, {
        count: sourceRefs.length,
        ...(candidate ? { at: candidate.createdAt } : {}),
        detail: sourceRefs.length ? `来自 ${sourceRefs.length} 条来源` : undefined,
      }),
      // 沉淀：它成了一条正式认知，现在是第几版。
      segment('settling', true, {
        at: asset.createdAt,
        detail: `当前第 ${asset.version} 版${STATUS_LABEL[asset.status] ?? ''}`,
      }),
      // 继承：哪些智能体带着它出生。
      segment('inheritance', carriedByAgentIds.length > 0, {
        count: carriedByAgentIds.length,
        ...(births.length ? { at: births[births.length - 1].createdAt } : {}),
        detail: carriedByAgentIds.length
          ? `已进入 ${carriedByAgentIds.length} 个智能体`
          : '还没有智能体带着它',
      }),
      // 使用：真的在任务里被带进去过几次。
      segment('use', uses.length > 0, {
        count: uses.length,
        ...(uses.length ? { at: uses[uses.length - 1].createdAt } : {}),
        detail: uses.length ? `在 ${uses.length} 次任务中实际带入` : '还没有在任务中用过',
      }),
      // 证据：没带上的那些次，各是什么原因。
      segment('evidence', withheld.length > 0, {
        count: withheld.length,
        ...(withheld.length ? { at: withheld[0].at } : {}),
        detail: withheld.length ? `${withheld.length} 次未带入，均有记录原因` : '没有未带入记录',
      }),
    ],
  };
}
