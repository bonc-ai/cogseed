/**
 * experience-catalog.ts — 经验清单的构建（specs/016 T007 / research D7）。
 *
 * 清单是**视图**，不落盘：回答"这一轮任务，模型眼前该看到哪些经验条目"。
 * 与资产目录（asset-catalog.ts）平行但不合并——两套集合、两套过滤口径，
 * 合并目录正是"经验稀释资产"的老毛病（spec 背景里被点名要修的那个）。
 *
 * 构建规则（D7）：
 *   ① 只取 status==='active' 且过 T006 准入的经验（消费准入与资产同一套闸门）；
 *   ② 任务类型过滤：当前类型 = scopeForTask(taskText)，只保留同类型条目 +
 *      通用（general）且相关度达标的条目，其余类型零出现（AC1 的字面要求）；
 *   ③ 相关度 ★ 阈值 0.40（与 asset-catalog-hint.ts:76 同值，同一个 embedding
 *      工具、同一把尺子，不另立标准）；
 *   ④ 排序：相关（★）优先 → 相关分 → 近度（updatedAt 降序）。「实际采用
 *      次数」v1 无数据源，不作因子（research 未决项已记，不假装有）；
 *   ⑤ 单行一条且**不含 body**（受限正文边界：清单行、日志一律不出现正文，
 *      正文只在模型显式读取时给）。
 *
 * embedding 不可用时相关度回退为空（相关分全 0）：同类型条目照常出现，
 * 通用条目因"相关度达标"条件不满足而缺席——宁可少给，不编分数。
 */

import { scopeForTask } from '../kstar/extraction-service';
import { catalogTruncate } from './asset-catalog';
import {
  evaluateExperienceRuntimeEligibility,
  listExperiences,
  type ExperienceRecord,
} from './experience-service';
import type { AssetRuntimeContext } from './formal-assets/runtime';

/** 相关度 ★ 阈值：与 asset-catalog-hint.ts 的 CATALOG_RELEVANT_MARK 同值（0.40）。 */
export const EXPERIENCE_CATALOG_RELEVANT_MARK = 0.40;

/** 清单条目（data-model §5 字段表）：**不含 body**。 */
export interface ExperienceCatalogEntry {
  id: string;
  title: string;
  experienceType: ExperienceRecord['experienceType'];
  taskType: ExperienceRecord['source']['taskType'];
  outcome: ExperienceRecord['verification']['outcome'];
  /** 引用冻结口径的展示版本：经验没有版本计数器，用 updatedAt 派生。 */
  version: string;
  /** ★ = 当轮相关度 ≥ 阈值。 */
  relevant: boolean;
  sourceTaskLabel: string;
}

/** 「已挂载但本轮被拦」的回执材料：只有标题与理由码，**不含正文**。 */
export interface ExperienceCatalogOmission {
  id: string;
  title: string;
  version: string;
  reason: string;
}

export interface ExperienceCatalogResult {
  entries: ExperienceCatalogEntry[];
  /** 单行一条的清单行（不含页眉页脚）。 */
  lines: string[];
  /** 页眉 + 行；无条目时为空串（**不输出「0 条」**——那会让模型以为用户没有经验）。 */
  text: string;
  /** 已挂载（调用方显式带入）却被拦的经验，各一条，供 hint 层写 omitted 回执。 */
  omitted: ExperienceCatalogOmission[];
}

export interface ExperienceCatalogOptions {
  /** 透传给准入闸门的 Agent/workspace 上下文；task scope 由本目录从任务文本推导。 */
  runtimeContext?: AssetRuntimeContext;
  /** 本轮已挂载的经验 id（@ 带入 / 引用集）：被拦的在这里产出 omitted。 */
  mountedExperienceIds?: readonly string[];
}

/** 引用冻结口径的版本展示（data-model §5：version = updatedAt 派生）。 */
export function experienceVersion(exp: Pick<ExperienceRecord, 'updatedAt'>): string {
  return String(exp.updatedAt || '');
}

const EXPERIENCE_TYPE_LABELS: Record<string, string> = {
  lesson: '教训',
  workflow: '工作流',
  gap: '缺口',
  uncategorized: '未分类',
};

const OUTCOME_LABELS: Record<string, string> = {
  better_than_expected: '优于预期',
  met_expected: '符合预期',
  worse_than_expected: '低于预期',
  unclear: '结果不明',
};

const TASK_TYPE_LABELS: Record<string, string> = {
  report: '报告类',
  code: '代码类',
  review: '审查类',
  product: '产品类',
  general: '通用',
};

/** 单行清单条目（⑤：单行、无正文）。 */
export function experienceCatalogLine(entry: ExperienceCatalogEntry, index: number): string {
  const meta = [
    EXPERIENCE_TYPE_LABELS[entry.experienceType] || entry.experienceType,
    TASK_TYPE_LABELS[entry.taskType] || entry.taskType,
    OUTCOME_LABELS[entry.outcome] || entry.outcome,
    `v${entry.version.slice(0, 10)}`,
  ].join('·');
  return [
    `${index}. ${entry.relevant ? '★' : ''}[exp:${entry.id}] ${catalogTruncate(entry.title, 40)}`,
    `${meta}`,
    `来源:${entry.sourceTaskLabel}`,
  ].join('｜');
}

/** 相关度（同 asset-catalog-hint 的用法：embedForDedup + cosineScore）。
 *  经验的检索文本用 body：与资产用 statement 同位（那是内容的载体）；向量是
 *  数值化比对，不构成正文向清单/日志的文本泄漏。 */
async function relevanceScores(
  userId: string,
  taskText: string,
  experiences: ExperienceRecord[],
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  try {
    const { embedForDedup, cosineScore } = await import('./similarity');
    const query = await embedForDedup(userId, taskText);
    if (!query) return scores;
    for (const exp of experiences) {
      const vector = await embedForDedup(userId, String(exp.body || exp.title || ''));
      if (vector) scores.set(exp.id, cosineScore(query, vector));
    }
  } catch {
    // 相关度是增强：拿不到就退化为纯近度排序（通用条目按规则缺席）。
  }
  return scores;
}

/** 构建经验清单（规则 ①~⑤ 见文件头）。 */
export async function buildExperienceCatalog(
  userId: string,
  taskText = '',
  options: ExperienceCatalogOptions = {},
): Promise<ExperienceCatalogResult> {
  const all = await listExperiences(userId);
  if (!all.length) {
    return { entries: [], lines: [], text: '', omitted: [] };
  }

  // ① 准入：清单是自动构建路径（模型默认可见），按静默默认注入口径判——
  // applicableWhen 声明却对不上当前任务的经验不得出现（闸门的
  // not_applicable_context），forbidden 命中同理。
  const gateContext: AssetRuntimeContext = {
    ...options.runtimeContext,
    ...(taskText ? { scope: scopeForTask(taskText) } : {}),
    taskText: taskText || undefined,
    silentDefaultInjection: true,
  };
  const admitted: ExperienceRecord[] = [];
  const blockedActive = new Map<string, string[]>();
  for (const exp of all) {
    if (exp.status !== 'active') continue;
    const eligibility = evaluateExperienceRuntimeEligibility(userId, exp, gateContext);
    if (eligibility.eligible) admitted.push(exp);
    else blockedActive.set(exp.id, [...eligibility.reasons]);
  }

  // ② 类型过滤：当前任务类型 + 「通用且相关度达标」。
  const currentType = scopeForTask(taskText || '');
  const relevance = taskText ? await relevanceScores(userId, taskText, admitted) : new Map<string, number>();
  const relevantScore = (exp: ExperienceRecord): number => relevance.get(exp.id) || 0;
  const visible = admitted.filter((exp) => (
    exp.source.taskType === currentType
    || (exp.source.taskType === 'general' && relevantScore(exp) >= EXPERIENCE_CATALOG_RELEVANT_MARK)
  ));

  // ④ 排序：★ 优先 → 相关分 → 近度。
  const sorted = [...visible].sort((left, right) => {
    const byClass = Number(relevantScore(right) >= EXPERIENCE_CATALOG_RELEVANT_MARK)
      - Number(relevantScore(left) >= EXPERIENCE_CATALOG_RELEVANT_MARK);
    if (byClass !== 0) return byClass;
    const byScore = relevantScore(right) - relevantScore(left);
    if (byScore !== 0) return byScore;
    return right.updatedAt.localeCompare(left.updatedAt);
  });

  const entries: ExperienceCatalogEntry[] = sorted.map((exp) => ({
    id: exp.id,
    title: String(exp.title || ''),
    experienceType: exp.experienceType,
    taskType: exp.source.taskType,
    outcome: exp.verification.outcome,
    version: experienceVersion(exp),
    relevant: relevantScore(exp) >= EXPERIENCE_CATALOG_RELEVANT_MARK,
    sourceTaskLabel: catalogTruncate(String(exp.source.taskGoal || ''), 24),
  }));
  const lines = entries.map((entry, index) => experienceCatalogLine(entry, index + 1));
  const marked = entries.filter((entry) => entry.relevant).length;
  const text = entries.length
    ? [
      `Experience catalog (${entries.length} 条同类任务经验${marked ? `，${marked} 条与本轮相关 (★)` : ''}; one compact line each — pull the full text with`,
      `read_task_experience by [exp:…] id when one fits this task):`,
      ...lines,
    ].join('\n')
    : '';

  // 「已挂载但本轮被拦」：挂载集里每个被拦/失效的条目恰好一条（只含标题）。
  const omitted: ExperienceCatalogOmission[] = [];
  const mountedIds = new Set(options.mountedExperienceIds || []);
  for (const id of mountedIds) {
    const exp = all.find((item) => item.id === id);
    if (!exp) {
      // 挂载指向的条目已不存在（异常态）：如实留 source_unavailable，不静默吞。
      omitted.push({ id, title: '', version: '', reason: 'source_unavailable' });
      continue;
    }
    const reasons = exp.status !== 'active'
      ? ['status_not_active']
      : blockedActive.get(exp.id);
    if (reasons?.length) {
      omitted.push({
        id: exp.id,
        title: String(exp.title || ''),
        version: experienceVersion(exp),
        reason: reasons[0],
      });
    }
  }

  return { entries, lines, text, omitted };
}
