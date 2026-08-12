/**
 * Skill Lifecycle Recommendation — 主动 Skill 生命周期四分支建议
 * （PRD §4.5/§8.5：创建/调用/更新/暂不更新）。
 *
 * 纪律（FR-AST-08/09、AC-22/24）：
 * - 任何分支都不得静默改变正式 Skill；创建/更新必须用户逐次确认；
 * - no_change 是合法结论：区分原因并给出再次评估条件，不升版、不触发成长；
 * - 调用建议只生成本次使用记录，不产生新版本；
 * - 入口受 `p3394.skilllifecycle` flag 控制（关闭时主进程与渲染层双读同一配置）。
 *
 * 存储：`<uid>/cloud/mate_agent/skill-lifecycle/<skill_id>.jsonl`（append-only）。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { appendJsonlAtomic, readJsonl, nowIso, safeId } from '../../storage';
import { mateAgentSkillLifecycleDir } from '../../paths';
import { maskId } from '../../util/log-redact';
import { isP3394FlagEnabled } from '../p3394/flags';

const log = createLogger('skill-lifecycle');

export type SkillLifecycleType = 'create' | 'invoke' | 'update' | 'no_change';

/** no_change 的细分原因（PRD §8.5：现有覆盖/一次性配置/证据不足/不可归因/未达阈值）。 */
export type NoChangeReason =
  | 'covered_by_existing_version'
  | 'one_off_project_config'
  | 'evidence_insufficient'
  | 'not_attributable'
  | 'below_repeat_threshold';

export interface SkillLifecycleRecommendation {
  recommendation_id: string;
  recommendation_type: SkillLifecycleType;
  skill_id: string;
  skill_version?: string;
  /** 触发源（episode / task_run / teaching_signal / source）。 */
  trigger_refs: string[];
  reason: string;
  /** no_change 时的细分原因。 */
  no_change_reason?: NoChangeReason;
  /** no_change 时的再次评估条件。 */
  reassess_when?: string;
  confidence?: number;
  evidence_refs: string[];
  suggested_scope?: string;
  /** create/update 前的状态：draft（用户确认前不是正式资产）。 */
  status: 'draft' | 'user_confirmed' | 'user_rejected' | 'invoked' | 'deferred';
  created_at: string;
}

export interface RecordLifecycleInput {
  recommendationType: SkillLifecycleType;
  skillId: string;
  skillVersion?: string;
  triggerRefs: string[];
  reason: string;
  noChangeReason?: NoChangeReason;
  reassessWhen?: string;
  confidence?: number;
  evidenceRefs?: string[];
  suggestedScope?: string;
}

function assertType(v: unknown): asserts v is SkillLifecycleType {
  const allowed: readonly string[] = ['create', 'invoke', 'update', 'no_change'];
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error('invalid skill lifecycle type');
}

function assertNoChangeReason(v: unknown): asserts v is NoChangeReason {
  const allowed: readonly string[] = [
    'covered_by_existing_version', 'one_off_project_config', 'evidence_insufficient',
    'not_attributable', 'below_repeat_threshold',
  ];
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error('invalid no_change reason');
}

export function skillLifecyclePath(uid: string, skillId: string): string {
  return path.join(mateAgentSkillLifecycleDir(uid), `${skillId}.jsonl`);
}

/**
 * 记录一条生命周期建议。flag 关闭时直接抛错（调用方应提前检查；
 * 双保险：即使调用方漏检，写入层也不放行）。
 */
export async function recordSkillLifecycleRecommendation(
  uid: string,
  input: RecordLifecycleInput,
): Promise<SkillLifecycleRecommendation> {
  if (!isP3394FlagEnabled('skilllifecycle')) {
    throw new Error('skill lifecycle is disabled by feature flag');
  }
  if (!safeId(input.skillId)) throw new Error('invalid skill id');
  assertType(input.recommendationType);
  if (input.recommendationType === 'no_change') {
    if (input.noChangeReason === undefined) throw new Error('no_change requires no_change_reason');
    assertNoChangeReason(input.noChangeReason);
    if (!input.reassessWhen) throw new Error('no_change requires reassess_when');
  }
  if (!input.reason || typeof input.reason !== 'string' || !input.reason.trim()) {
    throw new Error('lifecycle recommendation requires reason');
  }

  const record: SkillLifecycleRecommendation = {
    recommendation_id: `slr_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    recommendation_type: input.recommendationType,
    skill_id: input.skillId,
    ...(input.skillVersion ? { skill_version: input.skillVersion } : {}),
    trigger_refs: input.triggerRefs ?? [],
    reason: input.reason.trim(),
    ...(input.noChangeReason ? { no_change_reason: input.noChangeReason } : {}),
    ...(input.reassessWhen ? { reassess_when: input.reassessWhen } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    evidence_refs: input.evidenceRefs ?? [],
    ...(input.suggestedScope ? { suggested_scope: input.suggestedScope } : {}),
    status: input.recommendationType === 'invoke' ? 'invoked' : 'draft',
    created_at: nowIso(),
  };
  await appendJsonlAtomic<SkillLifecycleRecommendation>(skillLifecyclePath(uid, input.skillId), record);
  log.info(`skill lifecycle user=${maskId(uid)} skill=${maskId(input.skillId)} type=${input.recommendationType}`);
  return record;
}

/** 某 Skill 的全部生命周期建议（按追加顺序）。 */
export async function listSkillLifecycleRecommendations(uid: string, skillId: string): Promise<SkillLifecycleRecommendation[]> {
  return readJsonl<SkillLifecycleRecommendation>(skillLifecyclePath(uid, skillId), 10000);
}

/**
 * 从一次 TaskRun 的 Episode Evidence 生成四分支建议（P0 最小判定）。
 * 依据：任务结果（outcome）+ Evidence 完整性。
 * - 无匹配正式 Skill → create 候选（draft）
 * - 有 Skill 且本次结果 Evidence 完整且存在可解释差异 → update 候选
 * - 有 Skill 且结果正常 → invoke（仅使用记录）或 no_change
 * - 单次发生/证据不足/不可归因 → no_change（合法结论，不升版）
 *
 * 注意：这是最小判定器；完整 Diff/归因引擎属于 Gate A 闭环（P1，D-3）。
 */
export function classifyLifecycleRecommendation(input: {
  skillId: string;
  skillVersion?: string;
  hasMatchingSkill: boolean;
  outcome: 'better' | 'same' | 'worse' | 'unclear' | 'unknown';
  evidenceComplete: boolean;
  repeatCount: number;
  attributionClear: boolean;
}): RecordLifecycleInput {
  const { skillId, skillVersion, hasMatchingSkill, outcome, evidenceComplete, repeatCount, attributionClear } = input;

  if (!hasMatchingSkill) {
    // 无匹配正式 Skill：创建候选（draft；用户确认前不是正式资产）
    return {
      recommendationType: 'create',
      skillId,
      reason: repeatCount >= 2
        ? '重复出现稳定工作模式且没有匹配 Skill，可形成创建候选'
        : '存在可复用方法但没有匹配 Skill，形成创建候选',
      triggerRefs: [],
      evidenceRefs: [],
    };
  }

  if (!evidenceComplete || !attributionClear || repeatCount < 2) {
    const reason: NoChangeReason = !evidenceComplete ? 'evidence_insufficient'
      : !attributionClear ? 'not_attributable' : 'below_repeat_threshold';
    return {
      recommendationType: 'no_change',
      skillId,
      skillVersion,
      reason: reason === 'evidence_insufficient'
        ? 'Evidence 不足，暂不更新'
        : reason === 'not_attributable' ? '变化不可归因，暂不更新' : '尚未达到重复阈值，暂不更新',
      noChangeReason: reason,
      reassessWhen: '出现新 Evidence 或重复次数达到阈值后再次评估',
      triggerRefs: [],
      evidenceRefs: [],
    };
  }

  if (outcome === 'worse') {
    return {
      recommendationType: 'update',
      skillId,
      skillVersion,
      reason: '检测到结果变差（负迁移风险），建议审查并限域或回滚',
      triggerRefs: [],
      evidenceRefs: [],
    };
  }

  if (outcome === 'better') {
    return {
      recommendationType: 'update',
      skillId,
      skillVersion,
      reason: '新 Evidence 表明现有 Skill 存在可解释改进空间',
      triggerRefs: [],
      evidenceRefs: [],
    };
  }

  return {
    recommendationType: 'no_change',
    skillId,
    skillVersion,
    reason: '本轮结果无明显变化，现有版本已覆盖',
    noChangeReason: 'covered_by_existing_version',
    reassessWhen: '出现显著差异 Evidence 后再次评估',
    triggerRefs: [],
    evidenceRefs: [],
  };
}
