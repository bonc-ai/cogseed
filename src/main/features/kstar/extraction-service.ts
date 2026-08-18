import { normalizeCognitionSourceRefs } from '../recall/source-service';
import { lessonLanguageMismatches } from '../../util/language';
import type { KstarCandidateProposal, KstarEpisodeRecord, KstarReviewRecord } from './types';

/** 从经验内容提炼标题核心（交互规范附录 A 风格：标题体现内容）。
 *  去掉常见引导前缀，取第一句主干，限 24 字。
 *  "当…时/对于…/遇到…"引导整体移除（含"时"边界）——旧实现对"当任务
 *  要求生成基于用户具体数据的文档（如资产简介）时"只移除前 12 字符，
 *  留下"数据的文档（如资产简介）时"残片。 */
export function lessonTitleCore(text: string): string {
  let t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  // "遇到同类情况时，应注意修正："是"待修正经验"模板引导，整体移除。
  t = t.replace(/^(?:遇到同类情况时，)?(?:应|须|要)?注意修正[:：]/, '')
    // 引导前缀（"当X时，"/"对于X，"/"处理X时，"等）惰性匹配到标点移除。
    .replace(/^(?:当|对于|遇到|处理|在处理|在)[^，。；,.;:：]*?(?:时|后|中|之前|以后)?[，,。；;]/, '')
    // 纯助动词引导（"可以/应该/需要"）——"先/再"是流程内容词（"先X再Y"），不移除。
    .replace(/^(?:可|应|须|要|建议|务必|注意)[^，。；,.;:：]{0,2}/, '')
    .replace(/^(?:“|『|「)/, '')
    .replace(/([，。；,.;:：])[\s\S]*$/, '$1')
    .trim();
  if (!t) return '通用经验';
  // 40 字截断：24 字太短，标题核心经常被截成无意义残片（用户反馈）。
  return t.length <= 40 ? t : `${t.slice(0, 40)}…`;
}

export function scopeForTask(task: string): string {
  // Short ASCII tags by design (retrieval matches scope tokens whole-word /
  // bidirectional + cross-language aliases); CJK keywords keep Chinese tasks
  // out of the weak 'general' fallback.
  // NOTE: `file`/`文件` are weak words — "文件不存在时返回默认值" is CODE
  // logic, not a document/report task; matching them to 'report' mislabels
  // refactor/code tasks and breaks retrieval. Strong document words only.
  if (/report|summary|document|报告|总结/i.test(task)) return 'report';
  if (/code|function|bug|test|代码|函数|缺陷|测试/i.test(task)) return 'code';
  if (/review|audit|审查|审计|检查|评审/i.test(task)) return 'review';
  if (/product|decision|architecture|产品|决策|架构/i.test(task)) return 'product';
  return 'general';
}

export function gapType(review: KstarReviewRecord): KstarCandidateProposal['suggestedType'] | null {
  if (review.attribution === 'knowledge_gap') return 'personal';
  if (review.attribution === 'rule_gap') return 'rule';
  if (review.attribution === 'template_gap') return 'template';
  if (review.attribution === 'skill_gap') return 'skill_method';
  return null;
}

/** Minimum |ΔR| for precipitation (learning-reflex gate). Tiny deltas are
 *  measurement noise, not lessons: only evidence that actually moved the
 *  result by at least this much becomes a reusable rule. */
export const MIN_PRECIPITATION_DELTA_R = 0.15;

export function hasLearningSignal(review: KstarReviewRecord): boolean {
  return review.deltaR !== 'unknown'
    || review.deltaA !== 'unknown'
    || review.outcome === 'better_than_expected'
    || review.outcome === 'worse_than_expected'
    || (review.confidence >= 0.7 && review.attribution !== 'unclear' && !!review.reason.trim())
    // A concrete, reasoned lesson IS a learning signal even when the
    // Commander could not name an attribution bucket (attribution defaults
    // to 'unclear' for met_expected tasks). The lesson text itself carries
    // the reusable experience; clearsPrecipitationGate still requires
    // confidence + reason so routine successes do not pollute.
    || Boolean(
      review.lesson?.trim()
      && review.confidence >= 0.7
      && !!review.reason.trim(),
    );
}

/** Evidence gate for precipitation (learning-reflex): a review precipitates
 *  only when it carries a NON-TRIVIAL lesson —
 *   1. a numeric ΔR/ΔA at or above MIN_PRECIPITATION_DELTA_R (measured
 *      deviation), or
 *   2. an explicit better/worse-than-expected outcome (deviated by
 *      definition, numeric delta may be unknown), or
 *   3. a high-confidence review that names a concrete gap (knowledge/rule/
 *      template/skill gap with a reason) — a gap lesson is a signal even
 *      when the numeric delta is tiny, or
 *   4. a model-reasoned PROCESS EXPERIENCE lesson on a successful task
 *      (met_expected, ~0 delta): the executor discovered a reusable
 *      pattern/pitfall/method DURING execution (e.g. "merge-conflict type
 *      assertions hide runtime errors"). Gate: lesson present + confidence
 *      >= 0.7 + reason non-empty, so routine successes do not pollute.
 *  "Met expected" with ~0 delta and NO lesson stays un-precipitated. */
export function clearsPrecipitationGate(review: KstarReviewRecord): boolean {
  if (!hasLearningSignal(review)) return false;
  const numericDeltaR = typeof review.deltaR === 'number' && Number.isFinite(review.deltaR) ? review.deltaR : 0;
  const numericDeltaA = typeof review.deltaA === 'number' && Number.isFinite(review.deltaA) ? review.deltaA : 0;
  if (Math.abs(numericDeltaR) >= MIN_PRECIPITATION_DELTA_R || Math.abs(numericDeltaA) >= MIN_PRECIPITATION_DELTA_R) {
    return true;
  }
  if (review.outcome === 'better_than_expected' || review.outcome === 'worse_than_expected') return true;
  if (gapType(review) !== null && review.reason.trim().length > 0) return true;
  // Process-experience line: a successful task can still carry a reusable
  // lesson discovered during execution.
  return Boolean(
    review.lesson?.trim()
    && review.confidence >= 0.7
    && review.reason.trim().length > 0,
  );
}

export function learningSignal(review: KstarReviewRecord): KstarCandidateProposal['learningSignal'] {
  return {
    ...(review.expectedResult ? { expectedResult: review.expectedResult } : {}),
    ...(review.actualResult ? { actualResult: review.actualResult } : {}),
    deltaR: review.deltaR,
    deltaA: review.deltaA,
    outcome: review.outcome,
    confidence: review.confidence,
    source: 'review',
  };
}

export function proposeKstarCandidates(
  episode: KstarEpisodeRecord,
  review: KstarReviewRecord,
): KstarCandidateProposal[] {
  const sourceRefs = normalizeCognitionSourceRefs([
    { kind: 'execution', id: episode.id, title: 'KSTAR episode' },
    ...episode.evidenceRefs.filter((ref) => ref.kind !== 'execution'),
  ]);
  const proposals: KstarCandidateProposal[] = [];
  const distinctTools = [...new Set(episode.a.toolCalls.map((call) => call.name).filter(Boolean))];
  const verifiedWorkflow = episode.r.status === 'completed' &&
    distinctTools.length >= 2 &&
    episode.a.toolCalls.every((call) => call.status === 'ok');

  const signalAvailable = clearsPrecipitationGate(review);
  const scope = scopeForTask(episode.t.userGoal);
  const scopeLabel = ({
    report: '报告类任务', code: '代码类任务', review: '审查类任务',
    product: '产品类任务', general: '通用',
  } as Record<string, string>)[scope] ?? scope;
  // 语言硬闸（消费方防御）：lesson 可能来自历史 review 或用户确认路径，不
  // 一定经过出生点拦截。主导脚本与任务不匹配的 lesson 一律不产候选——宁可
  // 回退确定性模板，也不让英文经验（中文任务）进候选池。
  const lessonFor = (lesson: string | undefined): string | undefined =>
    lesson && lessonLanguageMismatches(episode.t.userGoal, lesson) ? undefined : lesson;
  // 规则类候选的适用范围：PRD 3.1 把"确认适用与禁止范围"列为 RuleAsset 的
  // 最低门槛，没有边界的规则只能停在候选池。KStar 唯一有证据支撑的边界是
  // "这条教训是在哪类任务上学到的"——就只声明这一条，不编造禁止范围。
  const ruleBoundary = (suggestedType: string): Pick<KstarCandidateProposal, 'applicableWhen'> => (
    suggestedType === 'rule' ? { applicableWhen: [`处理${scopeLabel}时`] } : {}
  );
  if (verifiedWorkflow && signalAvailable) {
    const lesson = lessonFor(review.lesson?.trim());
    const core = lessonTitleCore(lesson || episode.t.userGoal);
    proposals.push({
      // A model-reasoned lesson (cause + reusable guidance) wins over the
      // fixed workflow template — the difference IS the lesson.
      judgment: lesson
        ? lesson
        : `处理类似「${episode.t.userGoal}」的任务时，可使用已验证的工作流程：${distinctTools.join(' → ')}。`,
      summary: lesson ? `可复用经验：${core}（${scopeLabel}）` : `已验证的工作流程：${core}（${scopeLabel}）`,
      uncertainty: '基于任务执行经验提炼，使用前可复核。',
      // A lesson is judgment experience, not a workflow recipe: tag it
      // 'rule' (or the named gap) so downstream use treats it as guidance
      // instead of replaying a tool chain.
      suggestedType: lesson
        ? (gapType(review) ?? 'rule')
        : 'skill_method',
      suggestedScope: scope,
      ...ruleBoundary(lesson ? (gapType(review) ?? 'rule') : 'skill_method'),
      sourceRefs,
      learningSignal: learningSignal(review),
    });
  }

  const type = review.confidence >= 0.7 ? gapType(review) : null;
  const gapLesson = lessonFor(review.lesson?.trim());
  // 没有推理出的 lesson 就不产缺口候选。此前会退回
  // `遇到同类情况时，应注意修正：${review.reason}`，而 review.reason 在推断出来的
  // 复盘里往往是一句诊断（"expected 'oi' but actual was …"）——把诊断当认知写进
  // 候选池，用户看到的是一条读不懂也用不上的"规则"。宁可不产。
  if (type && gapLesson) {
    const lesson = gapLesson;
    proposals.push({
      judgment: lesson,
      summary: `待修正经验：${lessonTitleCore(lesson)}（${scopeLabel}）`,
      uncertainty: '基于明确复盘结论生成，使用前可复核。',
      suggestedType: type,
      suggestedScope: scope,
      ...ruleBoundary(type),
      sourceRefs,
      learningSignal: learningSignal(review),
    });
  }

  return proposals.slice(0, 3);
}


export interface KstarDetectionHints {
  /** Natural-language hints for the LLM extraction prompt. */
  hints: string[];
  /** Whether a verified multi-tool workflow was detected. */
  hasVerifiedWorkflow: boolean;
  /** Whether the verified workflow has an explicit expected/actual learning signal. */
  hasWorkflowLearningSignal: boolean;
  /** Whether a review gap with high confidence was detected. */
  hasReviewGap: boolean;
}

export function buildKstarDetectionHints(
  episode: KstarEpisodeRecord,
  review: KstarReviewRecord,
): KstarDetectionHints {
  const hints: string[] = [];
  const distinctTools = [...new Set(episode.a.toolCalls.map((call) => call.name).filter(Boolean))];
  const verifiedWorkflow = episode.r.status === 'completed' &&
    distinctTools.length >= 2 &&
    episode.a.toolCalls.every((call) => call.status === 'ok');

  const workflowLearningSignal = hasLearningSignal(review);
  if (verifiedWorkflow && workflowLearningSignal) {
    hints.push(
      `DETECTED WORKFLOW: The assistant completed task "${
        episode.t.userGoal.slice(0, 120)
      }" using tools ${distinctTools.join(' → ')} (all successful), and review recorded an expected-versus-actual learning signal. ` +
      'Transform this into a reusable "skill_method" candidate describing the verified approach.',
    );
  }

  if (review.confidence >= 0.7 && review.reason) {
    const gapLabel = review.attribution.replace(/_/g, ' ');
    hints.push(
      `DETECTED GAP: Review found a ${gapLabel} — ${review.reason.slice(0, 200)}. ` +
      'Transform this into a candidate addressing what was missing.',
    );
  }

  return {
    hints,
    hasVerifiedWorkflow: verifiedWorkflow,
    hasWorkflowLearningSignal: workflowLearningSignal,
    hasReviewGap: review.confidence >= 0.7 && !!review.reason,
  };
}
