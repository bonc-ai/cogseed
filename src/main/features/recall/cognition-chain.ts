/** 一条认知从哪来、走到了哪一段。
 *
 *  链路是 `Source → Candidate → Asset → Capability Pack → Reuse`。五段各有各的
 *  存储（候选与资产在 recall/，能力包在 agent 出生快照里，回执在 p3394/），
 *  此前没有贯穿的查询入口——用户问「我这条判断到底沉淀下来没有、被用过没有」
 *  没人答得上。
 *
 *  两条纪律：
 *
 *  1. **只报事实，不下结论。** 每段返回的是发生过什么、什么时候、多少次，
 *     不返回「这条资产很稳」这类系统判断。用户自己看 6 次任务 3 类场景，
 *     比看一个形容词有用。
 *  2. **未达到 ≠ 失败。** 一条刚沉淀的资产还没进过任何能力包，是正常的
 *     「还没走到」，不是出错。所以段状态区分 `reached` / `not_reached`，
 *     调用方不得把 `not_reached` 渲染成红色错误。
 */

import type { CognitionSourceRef } from './source-service';

export type ChainStage = 'source' | 'candidate' | 'asset' | 'pack' | 'reuse';
export type ChainSegmentStatus = 'reached' | 'not_reached';

export interface ChainSegment {
  stage: ChainStage;
  status: ChainSegmentStatus;
  /** 第一次到达这一段的时间。未到达时缺失。 */
  at?: string;
  /** 这一段发生了多少次（如进过几个能力包、被复用几次）。 */
  count?: number;
  /** 面向用户的事实描述，不含系统结论。 */
  detail?: string;
}

export interface CognitionChainView {
  assetId?: string;
  candidateId?: string;
  /** 这条认知的来源证据。 */
  sourceRefs: CognitionSourceRef[];
  /** 资产当前状态，撤销/暂停要在追溯里看得见。 */
  assetStatus?: 'active' | 'paused' | 'revoked';
  assetVersion?: string;
  segments: ChainSegment[];
}

function segment(
  stage: ChainStage,
  reached: boolean,
  extra: { at?: string; count?: number; detail?: string } = {},
): ChainSegment {
  return {
    stage,
    status: reached ? 'reached' : 'not_reached',
    ...(extra.at ? { at: extra.at } : {}),
    ...(extra.count !== undefined ? { count: extra.count } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

/** 回执里的资产引用形如 `asset:<id>@v<version>`，可能带 `:reason` 后缀。 */
function refMentionsAsset(ref: string, assetId: string): boolean {
  return ref === `asset:${assetId}` || ref.startsWith(`asset:${assetId}@`);
}

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

  // 能力包：扫所有 Agent 出生快照，看这条资产进过谁。
  const packs = (await inheritance.listAgentInheritance(userId))
    .filter((record) => record.capabilityPack.assets.some((ref) => ref.assetId === assetId));

  // 复用：扫回执，看这条资产真的被带进过哪些会话。
  const reuses = (await receipts.listReceipts(userId))
    .filter((receipt) => receipt.reusedRefs.some((ref) => refMentionsAsset(ref, assetId)));

  return {
    assetId,
    ...(candidate ? { candidateId: candidate.id } : {}),
    sourceRefs,
    assetStatus: asset.status,
    assetVersion: asset.version,
    segments: [
      segment('source', sourceRefs.length > 0, {
        count: sourceRefs.length,
        detail: sourceRefs.length ? `${sourceRefs.length} 条来源证据` : undefined,
      }),
      segment('candidate', Boolean(candidate), {
        ...(candidate ? { at: candidate.createdAt } : {}),
        ...(candidate ? {} : { detail: '候选记录已不存在，溯源链断了一节' }),
      }),
      segment('asset', true, {
        at: asset.createdAt,
        detail: `第 ${asset.version} 版${asset.status === 'active' ? '' : ` · 已${asset.status === 'paused' ? '暂停' : '撤销'}`}`,
      }),
      segment('pack', packs.length > 0, {
        count: packs.length,
        ...(packs.length ? { at: packs[packs.length - 1].createdAt } : {}),
        detail: packs.length ? `进入 ${packs.length} 个智能体的能力包` : '还没进过任何能力包',
      }),
      segment('reuse', reuses.length > 0, {
        count: reuses.length,
        ...(reuses.length ? { at: reuses[reuses.length - 1].createdAt } : {}),
        detail: reuses.length ? `被 ${reuses.length} 次任务真实带入` : '还没有复用记录',
      }),
    ],
  };
}
