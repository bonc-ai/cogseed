import { safeId } from '../../storage';
import {
  saveRecallCandidate,
  type RecallCandidateRecord,
} from '../recall/candidate-service';
import type { KstarCandidateProposal } from './types';

/** Save proposals into Recall's pending review queue. Promotion is intentionally not part of this bridge.
 *  `spaceId`：任务/需求的工作空间归属（空间会话时即空间 id），透传给候选，
 *  保证任务级沉淀的候选/资产带空间归属（空间资产 tab 显示 + 注入过滤命中）。 */
export async function saveKstarCandidateProposals(
  userId: string,
  proposals: KstarCandidateProposal[],
  options: { spaceId?: string } = {},
): Promise<RecallCandidateRecord[]> {
  const candidates: RecallCandidateRecord[] = [];
  for (const proposal of proposals.slice(0, 3)) {
    candidates.push(await saveRecallCandidate(userId, {
      judgment: proposal.judgment,
      // value = judgment：saveRecallCandidate 的 reviewReady 要求 value 非空
      // （空 → weak_observation）；promote 时 statement 拼接有
      // value !== judgment 检查——相等则不拼，statement 保持纯净 lesson。
      // 不传时 value 默认成 summary（标题），promote 会把标题残片拼进
      // statement（已观测：'可复用经验：数据的文档…' 污染资产正文）。
      // 注意新建路径防呆：显式 value 必须配显式 suggestedAction，否则 weak。
      value: proposal.judgment,
      suggestedAction: proposal.suggestedAction || 'create',
      ...(proposal.summary ? { summary: proposal.summary } : {}),
      ...(proposal.uncertainty ? { uncertainty: proposal.uncertainty } : {}),
      suggestedType: proposal.suggestedType,
      suggestedScope: proposal.suggestedScope,
      sourceRefs: proposal.sourceRefs,
      ...(proposal.applicableWhen ? { applicableWhen: proposal.applicableWhen } : {}),
      ...(proposal.forbiddenWhen ? { forbiddenWhen: proposal.forbiddenWhen } : {}),
      ...(proposal.learningSignal ? { learningSignal: proposal.learningSignal } : {}),
      ...(proposal.learningProvenance ? { learningProvenance: proposal.learningProvenance } : {}),
      ...(options.spaceId && safeId(options.spaceId) ? { spaceId: options.spaceId } : {}),
    }));
  }
  return candidates;
}
