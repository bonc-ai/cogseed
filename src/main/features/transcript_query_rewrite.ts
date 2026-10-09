/**
 * transcript_query_rewrite — 检索前的 query 同义改写（方案 v0.2 §五 P2-3 / §八 效果⑧）
 *
 * 为什么：用户按转写里听到的写法去搜（`coxy`），清理版里是 `Cogseed`，
 * 于是"搜不到"。这里在**检索前**把 query 里命中词表的错形改写成正确写法，
 * 让同一份知识库在两种写法下都能被搜到。
 *
 * 边界（都是硬要求）：
 *   - **可开关**：默认关，由用户在词表管理页打开（`meta.queryRewrite`）；
 *   - **可追踪**：返回 `applied[]`（改了哪些词、各几处），IPC 层会记日志；
 *   - **护栏一致**：复用扫描器（word boundary / 语境黑名单 / 作用域 / 风险分级），
 *     高危词默认不改（用户搜 `model` 就是搜 model，不能被改成 Moodle）；
 *   - 删除类词条（口癖）**不参与**改写（把 query 删字没有意义）。
 */

import { applyCorrections, scanText } from './transcript_auto_correct';
import { listEntries } from './transcript_glossary';

export interface QueryRewriteResult {
  original: string;
  rewritten: string;
  applied: Array<{ wrong: string; correct: string; count: number }>;
  /** 是否真的改动了（便于调用方决定要不要提示用户）。 */
  changed: boolean;
}

/**
 * 改写 query。`enabled === false` 时原样返回（调用方负责开关判断，
 * 这里也再兜一层，避免误用）。
 */
export function rewriteQuery(
  userId: string,
  query: string,
  options: { enabled?: boolean; scenarioTags?: string[] } = {},
): QueryRewriteResult {
  const original = String(query ?? '');
  const base: QueryRewriteResult = { original, rewritten: original, applied: [], changed: false };
  if (!original.trim()) return base;
  if (options.enabled === false) return base;

  const entries = listEntries(userId, { status: 'active' })
    // 口癖是"删字"类规则，改 query 只会把它弄残
    .filter((entry) => entry.action !== 'delete' && entry.kind !== 'filler');
  if (entries.length === 0) return base;

  const scan = scanText(original, entries, {
    ...(options.scenarioTags?.length ? { scenarioTags: options.scenarioTags } : {}),
  });
  if (scan.candidates.length === 0) return base;

  // 只吃 low/medium：高危词（`model`/`for`/`contact`…）搜什么就搜什么
  const result = applyCorrections(original, scan.candidates, { acceptRiskLevels: ['low', 'medium'] });
  if (result.applied.length === 0) return base;
  return {
    original,
    rewritten: result.text,
    applied: result.applied.map((item) => ({ wrong: item.wrong, correct: item.correct, count: item.count })),
    changed: result.text !== original,
  };
}

/** 把改写结果压成一行提示文案用的短语（`coxy → Cogseed ×2`）。 */
export function describeRewrite(result: QueryRewriteResult): string {
  return result.applied.map((item) => `${item.wrong} → ${item.correct}${item.count > 1 ? ` ×${item.count}` : ''}`).join('；');
}
