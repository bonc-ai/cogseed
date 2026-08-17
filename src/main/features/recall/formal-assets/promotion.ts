/**
 * 正式晋升的唯一闸门（PRD 3.1 四类最低准入门槛）。
 *
 * 收口理由：分类判断此前只发生在抽取管线里（capture-value-screening），
 * 而晋升入口不止一个——会话线、KStar 线、用户手动确认、失败重试，
 * 每条都能直接调 promote。抽取时挡住的东西，换条路仍然进得来。
 *
 * 这里回答一个问题：**这条候选，够不够格成为该类型的正式资产。**
 * 不回答"内容好不好"（那是 capture-value-screening 的质量校验），
 * 也不回答"能不能自动写入"（那是 policy 层的 use policy）。
 *
 * 四类的门槛直接取自 PRD 3.1：
 *   personal  身份/角色/偏好/关系/长期环境与边界；项目与任务事实不属于此类
 *   rule      用户确认来源、作用域、**适用与禁止范围**
 *   template  用户确认**可复用结构**、来源、敏感边界、适用范围
 *   skill_method  Goal / Action Plan / 输入输出 / Ontology Binding / 工具 / 流程 / Evaluation
 */

import {
  assessRecallCandidateClassification,
  type RecallCandidateClassificationReason,
} from '../capture-value-screening';
import type { AbilityAssetType, RecallCandidateAction } from '../candidate-service';

export type PromotionBlockReason =
  | RecallCandidateClassificationReason
  | 'rule_boundary_required';

export interface PromotionCandidateInput {
  judgment: string;
  value?: string;
  summary?: string;
  suggestedType: AbilityAssetType;
  suggestedScope: string;
  suggestedAction?: RecallCandidateAction;
  applicableWhen?: readonly string[];
  forbiddenWhen?: readonly string[];
  /** 系统里已存在的同文本条目的类型（不含本条自己）。同一句话被分成两类，
   *  说明至少一边分错了——谁都不晋升，留给人判断。 */
  conflictingTypes?: readonly string[];
}

export interface PromotionValidation {
  /** false → 不得晋升为正式资产，候选留在池子里等补齐。 */
  ok: boolean;
  reasons: PromotionBlockReason[];
  /** 不阻断但需要如实记录的（例如结构不完整的方法）。 */
  advisories: RecallCandidateClassificationReason[];
}

/** 晋升前的分类型校验。`actor` 决定 rule 的边界要求：用户确认路径可以
 *  先形成未验证资产并在待办中补边界；系统线拿不到人，缺边界就不能晋升。 */
export function validatePromotionByAssetType(
  candidate: PromotionCandidateInput,
  options: { actor?: 'user' | 'system' } = {},
): PromotionValidation {
  const boundaries = {
    ...(candidate.applicableWhen ? { applicableWhen: candidate.applicableWhen } : {}),
    ...(candidate.forbiddenWhen ? { forbiddenWhen: candidate.forbiddenWhen } : {}),
    ...(candidate.conflictingTypes ? { conflictingTypes: candidate.conflictingTypes } : {}),
  };
  const classification = assessRecallCandidateClassification({
    judgment: candidate.judgment,
    value: candidate.value || '',
    summary: candidate.summary || '',
    suggestedType: candidate.suggestedType,
    suggestedScope: candidate.suggestedScope,
    ...(candidate.suggestedAction ? { suggestedAction: candidate.suggestedAction } : {}),
    valueProvided: Boolean(candidate.value),
    actionProvided: Boolean(candidate.suggestedAction),
  }, boundaries);

  const reasons: PromotionBlockReason[] = [...classification.blockingReasons];
  const advisories: RecallCandidateClassificationReason[] = classification.advisoryReasons
    .filter((reason) => reason !== 'rule_missing_boundary');

  // PRD 3.1 给 RuleAsset 的最低门槛写明「用户确认来源、作用域、适用与禁止
  // 范围」。系统线没有人可确认，缺边界时只能停在候选；用户确认线保留提示，
  // 资产以 User Confirmed / Unverified 落库，后续由低打扰待办补齐边界。
  const missingBoundary = classification.advisoryReasons.includes('rule_missing_boundary');
  if (missingBoundary) {
    if (options.actor === 'system') reasons.push('rule_boundary_required');
    else advisories.push('rule_missing_boundary');
  }

  return { ok: reasons.length === 0, reasons, advisories };
}

/** 供调用方生成可读原因（日志/回执用，不是 UI 文案）。 */
export function describePromotionBlock(reason: PromotionBlockReason): string {
  switch (reason) {
    case 'personal_is_project_fact':
      return 'project or task facts stay with the project, not with the person';
    case 'template_not_reusable_structure':
      return 'only a reusable structure extracted from a source can become a template';
    case 'skill_not_executable':
      return 'a method needs an executable, checkable shape, not a capability claim';
    case 'rule_boundary_required':
      return 'a rule needs its applicable and forbidden range confirmed before it becomes formal';
    case 'judgment_is_meta_commentary':
      return 'the judgment is a verdict about the candidate, not reusable content';
    case 'type_conflicts_with_existing':
      return 'the same wording already exists under another asset type; the classification is unreliable';
    default:
      return reason;
  }
}
