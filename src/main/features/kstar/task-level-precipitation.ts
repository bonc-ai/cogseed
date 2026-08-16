import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { lessonLanguageMismatches } from '../../util/language';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { precipitateDirectExperienceFromSource } from './direct-experience-assets';
import { readKstarEpisode } from './episode-store';
import { clearsPrecipitationGate, gapType, learningSignal, lessonTitleCore, scopeForTask } from './extraction-service';
import { readKstarReview } from './review-service';
import type { KstarRequirementRecord } from './requirement-types';
import type { KstarCandidateProposal, KstarEpisodeRecord, KstarReviewRecord } from './types';

/** 语言硬闸（消费方防御）：与任务主导脚本不匹配的 lesson 视为无效——
 *  中文任务产出的英文经验宁可不沉淀。 */
function lessonUsable(taskGoal: string, lesson: string | undefined): string | undefined {
  if (!lesson?.trim()) return undefined;
  return lessonLanguageMismatches(taskGoal, lesson) ? undefined : lesson.trim();
}

/** 用户可读的作用域标签（交互规范 §17.3：作用域要"看得懂"）。
 *  scopeForTask 输出短 ASCII 标签（retrieval 用），展示层转中文。 */
const SCOPE_LABELS: Record<string, string> = {
  report: '报告类任务',
  code: '代码类任务',
  review: '审查类任务',
  product: '产品类任务',
  general: '通用',
};

export function userScopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** 用户可读的经验标题（替代英文技术标题，交互规范附录 A 风格）。 */
export function userFacingSummary(
  kind: 'lesson' | 'workflow' | 'gap',
  scope: string,
  content?: string,
): string {
  // 标题 = 内容核心本身，不带模板前缀/scope 后缀——前缀（可复用经验/待
  // 修正经验）与 scope 由渲染层分类标签/作用域徽标单独展示，标题重复它们
  // 只会造成列表雷同（用户反馈：标题无法体现沉淀内容）。
  const core = content ? lessonTitleCore(content) : '';
  switch (kind) {
    case 'lesson': return core || '可复用经验';
    case 'workflow': return core || '已验证的工作流程';
    case 'gap': return core || '待修正经验';
  }
}

/**
 * task-level-precipitation.ts — requirement-level delta-r aggregation.
 *
 * Single-episode closure precipitates per-episode lessons. This module
 * aggregates ALL episodes of one requirement (B5): it merges the tool chain
 * across episodes, takes the strongest review signal, and precipitates ONE
 * reusable ability asset per signal so a multi-episode task yields a coherent
 * skill_method / gap asset instead of N fragmented fragments.
 *
 * Fired from:
 *  - finish/abandon (task closure, B7)
 *  - new-task switch (upsert_state task:create while a task is open, B2)
 *
 * Precipitation is best-effort and evidence-gated: no proposal is emitted
 * unless the merged evidence clears the same gates as the episode line.
 */

const log = createLogger('kstar.task-level-precipitation');

export interface AggregateRequirementProposalsInput {
  requirement: KstarRequirementRecord;
  episodes: KstarEpisodeRecord[];
  reviews: KstarReviewRecord[];
}

export interface RequirementLevelPrecipitationResult {
  proposals: KstarCandidateProposal[];
  createdAssetIds: string[];
  candidateIds: string[];
  mergedIntoIds: string[];
  updateCandidateIds: string[];
}

export function aggregateRequirementProposals(input: AggregateRequirementProposalsInput): KstarCandidateProposal[] {
  const { requirement, episodes, reviews } = input;
  if (episodes.length === 0) return [];

  // Merged tool chain across every episode, preserving first-seen order.
  const toolChain: string[] = [];
  for (const episode of episodes) {
    for (const call of episode.a.toolCalls) {
      const name = String(call.name || '').trim();
      if (name && !toolChain.includes(name)) toolChain.push(name);
    }
  }
  const allCallsOk = episodes.every((episode) => episode.a.toolCalls.every((call) => call.status === 'ok'));
  const anyCompleted = episodes.some((episode) => episode.r.status === 'completed');
  const verifiedWorkflow = anyCompleted && toolChain.length >= 2 && allCallsOk;

  // Merged evidence: each episode execution + non-execution refs, deduped.
  const mergedRefs = normalizeCognitionSourceRefs([
    ...episodes.flatMap((episode) => [
      { kind: 'execution' as const, id: episode.id, title: 'KSTAR requirement episode' },
      ...episode.evidenceRefs.filter((ref) => ref.kind !== 'execution'),
    ]),
  ]);

  // Strongest review drives the aggregated learning signal — it must clear
  // the |ΔR| precipitation gate so noise never becomes a requirement-level
  // rule.
  const strongest = [...reviews]
    .filter((review) => clearsPrecipitationGate(review))
    .sort((a, b) => b.confidence - a.confidence)[0];

  const proposals: KstarCandidateProposal[] = [];
  const goal = requirement.goalText || requirement.title;
  const scope = scopeForTask(goal);
  // 规则类候选的适用范围（PRD 3.1 RuleAsset 最低门槛）。只声明有证据支撑的
  // 那一条——这条经验学自哪类任务；禁止范围没有证据支撑，不编。
  const ruleBoundary = (type: string): Pick<KstarCandidateProposal, 'applicableWhen'> => (
    type === 'rule' ? { applicableWhen: [`处理${userScopeLabel(scope)}时`] } : {}
  );
  if (strongest) {
    const strongestLesson = lessonUsable(goal, strongest.lesson);
    if (verifiedWorkflow && !strongestLesson) {
      // Verified workflow without a reasoned lesson → skill_method.
      proposals.push({
        judgment: `处理类似「${goal}」的任务时，可使用已验证的工作流程：${toolChain.join(' → ')}。`,
        summary: userFacingSummary('workflow', scope, goal),
        uncertainty: '基于已闭环任务的执行经验生成，使用前可复核。',
        suggestedType: 'skill_method',
        suggestedScope: scope,
        sourceRefs: mergedRefs,
        learningSignal: learningSignal(strongest),
      });
    } else if (strongestLesson) {
      // Process-experience lesson (even on met_expected tasks): the reasoned
      // reusable pattern/pitfall is the asset body. Type rule by default —
      // it is a judgment lesson, not a workflow.
      proposals.push({
        judgment: strongestLesson,
        summary: userFacingSummary('lesson', scope, strongestLesson),
        uncertainty: '基于任务执行经验提炼，使用前可复核。',
        suggestedType: 'rule',
        suggestedScope: scope,
        ...ruleBoundary('rule'),
        sourceRefs: mergedRefs,
        learningSignal: learningSignal(strongest),
      });
    }
  }

  // Highest-confidence gap across all episodes, only when evidence-gated.
  // 同上：缺口候选必须有推理出的 lesson，不拿 review.reason 的诊断文本充数。
  const gapReview = [...reviews]
    .filter((review) => review.confidence >= 0.7 && lessonUsable(goal, review.lesson))
    .sort((a, b) => b.confidence - a.confidence)[0];
  const gapAssetType = gapReview ? gapType(gapReview) : null;
  if (gapAssetType && gapReview) {
    const gapLesson = lessonUsable(goal, gapReview.lesson)!;
    proposals.push({
      judgment: gapLesson,
      summary: userFacingSummary('gap', scope, gapLesson),
      uncertainty: '基于明确复盘结论生成，使用前可复核。',
      suggestedType: gapAssetType,
      suggestedScope: scope,
      ...ruleBoundary(gapAssetType),
      sourceRefs: mergedRefs,
      learningSignal: learningSignal(gapReview),
    });
  }

  return proposals.slice(0, 3);
}

/**
 * Precipitate requirement-level ability assets: aggregated proposals go
 * DIRECTLY into ability assets. The KStar line skips the cognitive-
 * precipitation candidate line (no pending_review) — self-evolution
 * precipitates straight to the asset store.
 */
export async function precipitateRequirementLevel(
  userId: string,
  requirement: KstarRequirementRecord,
): Promise<RequirementLevelPrecipitationResult> {
  if (!safeId(userId) || !safeId(requirement.id)) throw new Error('invalid requirement precipitation reference');
  const episodes = (
    await Promise.all(requirement.episodeIds.map((episodeId) => readKstarEpisode(userId, episodeId)))
  ).filter((episode): episode is KstarEpisodeRecord => Boolean(episode));
  const reviews = (
    await Promise.all(episodes.map((episode) => readKstarReview(userId, episode.id)))
  ).filter((review): review is KstarReviewRecord => Boolean(review));

  const proposals = aggregateRequirementProposals({ requirement, episodes, reviews });
  if (proposals.length === 0) {
    return { proposals: [], createdAssetIds: [], candidateIds: [], mergedIntoIds: [], updateCandidateIds: [] };
  }

  const workspaceId = episodes.map((episode) => episode.s?.workspaceId).find((id) => id && safeId(id));

  let createdAssetIds: string[] = [];
  let candidateIds: string[] = [];
  let mergedIntoIds: string[] = [];
  let updateCandidateIds: string[] = [];
  try {
    const direct = await precipitateDirectExperienceFromSource(userId, {
      id: requirement.id,
      ...(workspaceId ? { workspaceId } : {}),
    }, proposals);
    createdAssetIds = direct.createdAssetIds;
    candidateIds = direct.candidateIds;
    mergedIntoIds = direct.mergedIntoIds;
    updateCandidateIds = direct.updateCandidateIds;
  } catch (error) {
    // Best-effort: never break task closure.
    log.warn('requirement-level direct precipitation degraded', {
      userId,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
  }
  return { proposals, createdAssetIds, candidateIds, mergedIntoIds, updateCandidateIds };
}
