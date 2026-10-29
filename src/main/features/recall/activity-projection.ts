/** 活动是用户要决定的变化与处理结果；原候选和版本记录保持原样。
 * 存量收敛只派生可解释的排除标记，不能在读取时删除/改写用户认知。
 */
import type { RecallCandidateRecord, RecallAbilityAssetRecord } from './candidate-service';
import { isKstarCognitionSource } from '../cognition/integration-boundary';

export type ActivityExclusionReason = 'isolated_source' | 'task_local' | 'execution_record' | 'already_current';
const normalize = (text: unknown) => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** 只接受明确的临时性声明；不得用“验收/技术/测试”等主题词一刀切。 */
export function nonRetainableActivityContent(text: string): 'task_local' | 'execution_record' | undefined {
  if (/(?:以后|今后|每次|长期(?:采用|使用|负责|坚持)|反复复用|from now on|every time|long.term)/i.test(text)) return undefined;
  if (/(?:仅|只)(?:用于|供).{0,24}(?:本次|这次|一次性|验收专用)|(?:不(?:入|进入|作为)|不是).{0,8}(?:长期(?:资产|认知|偏好)|用户事实)|(?:纯虚构|虚构).{0,12}(?:验收|测试)(?:身份|对象)|属于?一次性测试信号/i.test(text)) return 'task_local';
  if (/(?:personal_fields_check|bound\+missing\+assetMissing).{0,100}(?:total|计数|返回)|(?:工具调用|槽位检查|执行日志).{0,32}(?:返回值|计数缺口|差额|报错)/i.test(text)) return 'execution_record';
  return undefined;
}

export function projectActivityCandidates<T extends RecallCandidateRecord & { capabilities?: { countsAsPending?: boolean; eligibility?: string } }>(candidates: readonly T[], assets: readonly RecallAbilityAssetRecord[] = []) {
  return candidates.map(candidate => {
    let reason: ActivityExclusionReason | undefined;
    if (candidate.origin === 'kstar' || isKstarCognitionSource(candidate)) reason = 'isolated_source';
    // 手动保存/用户改过的候选不因文本规则失去确认入口。
    else if (candidate.origin !== 'organization' && candidate.origin !== 'stock_organization' && candidate.origin !== 'manual' && candidate.origin !== 'teaching' && !candidate.userModifiedAt) {
      reason = nonRetainableActivityContent(candidate.judgment);
      if (!reason && candidate.sourceRefs.length && candidate.sourceRefs.every(ref => ref.kind === 'execution_evaluation')) reason = 'execution_record';
      if (!reason && candidate.risk === 'low' && candidate.capabilities?.eligibility !== 'ineligible' && !candidate.uncertainty && candidate.suggestedAction === 'create' && candidate.capabilities?.countsAsPending) {
        const current = assets.find(asset => asset.status === 'active'
          && (!asset.activeVersion || asset.activeVersion === asset.version)
          && asset.type === candidate.suggestedType && normalize(asset.scope) === normalize(candidate.suggestedScope)
          && JSON.stringify(asset.applicableWhen || []) === JSON.stringify(candidate.applicableWhen || [])
          && JSON.stringify(asset.forbiddenWhen || []) === JSON.stringify(candidate.forbiddenWhen || [])
          && JSON.stringify(asset.scopePolicy || null) === JSON.stringify(candidate.scopePolicy || null)
          && (normalize(asset.statement) === normalize(candidate.judgment)
            || normalize(asset.statement) === normalize(candidate.judgment + '\n\n' + candidate.value)));
        if (current) reason = 'already_current';
      }
    }
    return { ...candidate, ...(reason ? { activityExclusionReason: reason } : {}) };
  });
}

/** 旧本体候选也遵守活动筛选，但原过渡队列读口保持完整。 */
export function projectLegacyActivityCandidates<T extends { memory_text?: string; summary: string; write_actor?: string }>(candidates: readonly T[]) {
  return candidates.map(candidate => {
    const reason = candidate.write_actor === 'user' ? undefined : nonRetainableActivityContent(candidate.memory_text || candidate.summary);
    return { ...candidate, ...(reason ? { activityExclusionReason: reason } : {}) };
  });
}
