import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { lessonLanguageMismatches } from '../../util/language';
import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { precipitateDirectExperienceFromSource } from './direct-experience-assets';
import { readKstarEpisode, readKstarJsonRecord, replaceKstarJsonRecord } from './episode-store';
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
  failureIds: string[];
}

async function updateExtractionRuns(
  userId: string,
  requirement: KstarRequirementRecord,
  episodes: KstarEpisodeRecord[],
  result: Pick<RequirementLevelPrecipitationResult, 'candidateIds' | 'createdAssetIds' | 'mergedIntoIds' | 'updateCandidateIds' | 'failureIds'>,
): Promise<void> {
  const completedAt = new Date().toISOString();
  await Promise.all(episodes.map(async (episode) => {
    const review = await readKstarReview(userId, episode.id);
    const id = `ksx-${episode.id}`;
    const existing = await readKstarJsonRecord(userId, 'extraction-runs', id);
    const record = {
      schemaVersion: 1 as const, ownerId: userId, id, episodeId: episode.id,
      reviewId: review?.id || `ksr-${episode.id}`, candidateIds: result.candidateIds,
      createdAssetIds: result.createdAssetIds, mergedIntoIds: result.mergedIntoIds,
      updateCandidateIds: result.updateCandidateIds, failureIds: result.failureIds,
      status: result.failureIds.length && !result.candidateIds.length ? 'failed' as const : result.candidateIds.length ? 'partial' as const : 'created' as const,
      ...(result.failureIds.length ? { error: 'One or more precipitation operations failed.' } : {}),
      createdAt: existing && typeof existing.createdAt === 'string' ? existing.createdAt : episode.createdAt,
      updatedAt: completedAt, completedAt,
    };
    await replaceKstarJsonRecord(userId, 'extraction-runs', record);
  }));
  void requirement;
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
  // 「关于我」独立资产（方案 C 2026-08-17）：确定性扫描会话用户消息的长期
  // 偏好陈述，产 personal 候选。与 lesson 候选合并沉淀（可能两者都无）。
  const personalProposals = await buildPersonalProposals(userId, requirement, episodes);
  // N-17 桥接：外部智能体（P3394 网关节点）的协作样本——主 KStar 沉淀链
  // 读 p3394-kstar/ 落盘的 episode，把 proposed_updates（Learn-What 候选，
  // 只建议不写回）作为附加证据注入本任务的提案。窗口取任务最近一次闭合
  // 之前 24h 内完成的 P3394 会话；失败静默降级（不影响既有沉淀）。
  let allProposals = [...proposals, ...personalProposals];
  try {
    const { collectP3394ProposedUpdates } = await import('../p3394_bridge/kstar-episodes');
    const p3394Updates = await collectP3394ProposedUpdates(Date.now() - 24 * 60 * 60 * 1_000);
    if (p3394Updates.length && allProposals.length) {
      const { normalizeCognitionSourceRefs } = await import('../recall/source-service');
      const p3394Refs = normalizeCognitionSourceRefs(p3394Updates.slice(0, 20).map((update, index) => ({
        kind: 'authorized_external_system',
        subtype: 'connector_record',
        scope: 'external',
        id: `p3394-proposal-${Date.now().toString(36)}-${index}`,
        ...(update && typeof update === 'object' && typeof (update as { goal?: unknown }).goal === 'string'
          ? { title: String((update as { goal: unknown }).goal).slice(0, 160) }
          : {}),
      })));
      allProposals = allProposals.map((proposal) => ({
        ...proposal,
        sourceRefs: [...(proposal.sourceRefs || []), ...p3394Refs],
      }));
      log.info('requirement precipitation bridged p3394 proposed updates', {
        userId,
        requirementId: requirement.id,
        updateCount: p3394Updates.length,
      });
    }
  } catch (error) {
    log.warn('requirement precipitation p3394 bridge degraded', {
      userId,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
  }
  if (allProposals.length === 0) {
    const empty = { proposals: [], createdAssetIds: [], candidateIds: [], mergedIntoIds: [], updateCandidateIds: [], failureIds: [] };
    await updateExtractionRuns(userId, requirement, episodes, empty);
    return empty;
  }

  const workspaceId = episodes.map((episode) => episode.s?.workspaceId).find((id) => id && safeId(id));

  let createdAssetIds: string[] = [];
  let candidateIds: string[] = [];
  let mergedIntoIds: string[] = [];
  let updateCandidateIds: string[] = [];
  let failureIds: string[] = [];
  try {
    const direct = await precipitateDirectExperienceFromSource(userId, {
      id: requirement.id,
      conversationId: requirement.conversationId,
      requirementId: requirement.id,
      ...(workspaceId ? { workspaceId } : {}),
    }, allProposals);
    createdAssetIds = direct.createdAssetIds;
    candidateIds = direct.candidateIds;
    mergedIntoIds = direct.mergedIntoIds;
    updateCandidateIds = direct.updateCandidateIds;
    failureIds = direct.failureIds;
  } catch (error) {
    // Best-effort: never break task closure.
    log.warn('requirement-level direct precipitation degraded', {
      userId,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
  }
  const result = { proposals: allProposals, createdAssetIds, candidateIds, mergedIntoIds, updateCandidateIds, failureIds };
  await updateExtractionRuns(userId, requirement, episodes, result);
  return result;
}

/** 读会话用户消息 → 确定性检测长期偏好 → 产 personal 候选。失败静默降级
 *  （不影响既有 lesson 沉淀）。 */
async function buildPersonalProposals(
  userId: string,
  requirement: KstarRequirementRecord,
  episodes: KstarEpisodeRecord[],
): Promise<KstarCandidateProposal[]> {
  try {
    if (!requirement.conversationId) return [];
    const { getMessages } = await import('../chats');
    const messages = await getMessages(userId, requirement.conversationId, 2_000);
    const userMessages = messages
      .filter((m) => m && m.from === 'user' && typeof m.text === 'string' && m.text.trim())
      .map((m) => ({ text: String(m.text) }));
    if (!userMessages.length) return [];
    const { extractPersonalStatements, personalStatementsToProposals } = await import('./personal-asset-precipitation');
    const statements = extractPersonalStatements(userMessages);
    if (!statements.length) return [];
    // 防跨类型重复（2026-08-17）：同一偏好可能已被沉淀为 rule/template
    // （模型提炼）或 capture personal（用户原话）——若偏好句与全库已有
    // 资产/候选语义命中（0.85），不再产 personal 候选，避免「关于我」与
    // 其他三类出现重复。查重失败（embedding 不可用）则保守产候选（宁可
    // 重复也不漏——统一晋升出口的语义查重仍会兜底）。
    const { findSemanticDuplicate } = await import('../recall/similarity');
    const [candidates, assets] = await Promise.all([
      import('../recall/candidate-service').then((m) => m.listRecallCandidates(userId)).catch(() => []),
      import('../recall/asset-service').then((m) => m.listAbilityAssets(userId)).catch(() => []),
    ]);
    const candidateTexts = candidates
      .filter((c) => c.status === 'observed' || c.status === 'weak_observation' || c.status === 'pending_review' || c.status === 'deferred' || c.status === 'failed' || c.status === 'confirmed')
      .map((c) => ({ id: c.id, text: String(c.judgment || '') }));
    const assetTexts = assets
      .filter((a) => a.status !== 'deleted' && a.status !== 'purged' && a.status !== 'revoked')
      .map((a) => ({ id: a.id, text: String(a.statement || a.title || '') }));
    const deduped: string[] = [];
    for (const statement of statements) {
      const outcome = await findSemanticDuplicate(userId, {
        text: statement,
        candidateTexts,
        assetTexts,
        excludeIds: new Set(),
      });
      if (outcome.status === 'match') continue; // 已有相同/近似表达，不重复产
      // 第二层：语义查重对"同主题不同措辞"失效（实测 <0.85）——主题词重叠
      // 兜底：偏好句与已有 rule/template 共享核心名词（如"周报"）→ 已有
      // 其他类型表达了同主题 → 不产 personal（避免「关于我」与三类重复）。
      const { sharesTheme } = await import('./personal-asset-precipitation');
      const sameTheme = [...candidateTexts, ...assetTexts].some((item) => sharesTheme(statement, item.text));
      if (sameTheme) continue;
      deduped.push(statement);
    }
    if (!deduped.length) return [];
    // 证据引用：本任务的 episodes。
    const { normalizeCognitionSourceRefs } = await import('../recall/source-service');
    const sourceRefs = normalizeCognitionSourceRefs(
      episodes.map((episode) => ({ kind: 'execution' as const, id: episode.id, title: 'KSTAR requirement episode' })),
    );
    return personalStatementsToProposals(deduped, sourceRefs);
  } catch (error) {
    log.warn('kstar personal asset precipitation degraded', {
      userId,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
    return [];
  }
}
