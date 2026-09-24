/**
 * transcript_recall_bridge — 把**多路召回**接进纠错扫描通道（纯函数，不碰文件系统）
 *
 * 为什么需要这一层（2026-09-22 取证）：
 *   `transcript_recall.recallCandidates`（音形骨架/编辑距离/弱通道）此前**只被离线脚本用**
 *   —— 唯一调用方是 `transcript_clean_pipeline.normalizeEntities`，而它只被
 *   `scripts/transcript-clean-run.ts` 调用（`src/` 内 0 调用方）。于是**纠错面板
 *   实际上只有"字面精确命中 + 模型"两条**，词表里没写过的错形召回率恒为 0，
 *   而 ASR 错形是开放集（同一个概念在真实转写里出现过 11 种写法）。
 *   本模块就是那条缺失的接线，且**接线处不引入新的匹配逻辑**——匹配仍然只有
 *   `recallCandidates` 一份实现，这里只做"过滤 + 映射 + 去重"。
 *
 * 三条边界（都由既有实测依据决定，不是拍脑袋）：
 *   1. **`normalized` 通道整条丢弃**。它就是"折叠后字面命中"，与 `scanText` 的精确命中
 *      完全重合（`recallCandidates` 的通道优先级也把 normalized 排在第一，专门压住模糊命中）；
 *      保留它只会让同一次命中在面板上出现两行。
 *   2. **所有模糊候选一律 `riskLevel: 'medium'` + `fromFuzzy: true`，永不预勾**。
 *      依据（写在下游 `transcript_clean_pipeline` 的注释里）：模糊通道会把
 *      `cookie`(0.80)、`Ok`/`id`(0.67)、`cost`(0.67) 这类普通英文词召回成产品名，
 *      "一旦自动替换就是静默事故"。所以这一层**只出候选**，自动应用仅限 `normalized`
 *      ——而 `normalized` 由图一审精确命中承担，行为与接线前一致。
 *   3. **不重复报已有的精确命中**：与 `scanText` 已产出的 span 重叠的模糊候选直接丢弃
 *      （`scanText` 有自己的重叠消解与上限截断，召回层看不到它砍掉了哪些）。
 *
 * 作用域/边界/语境/保护区这四道护栏**不在这里重写**：`recallCandidates` 内部与
 * `scanText` 共用同一套实现（`boundaryOk` / `findDeniedContext` / `computeProtectedRanges`
 * / `scopeAllows`），所以传进去的 `docId` / `scenarioTags` 会被同一套规则判定。
 */

import {
  type CorrectionCandidate,
  type Span,
} from './transcript_auto_correct';
import { foldText, type GlossaryEntry } from './transcript_glossary';
import { findQuoteContext } from './transcript_quote_context';
import {
  recallCandidates,
  type RecallChannel,
  type RecallOptions,
} from './transcript_recall';

/** 模糊候选上限。召回层本身不设上限，面板的候选总数上限是 2000，这里留足余量。 */
export const MAX_FUZZY_CANDIDATES = 200;
/** 只有这些通道进接线（`normalized` 与精确扫描重复，见头注释第 1 条）。 */
const FUZZY_CHANNELS: ReadonlySet<RecallChannel> = new Set<RecallChannel>(['phonetic', 'edit', 'weak']);

/**
 * `riskLevel: 'high'` 的词条**不进模糊通道**。
 *
 * 依据（2026-09-22 真实转写实测，不是推测）：词表里 `redmi→README`、`contact→Context`
 * 这类高危规则本身就是"合法英文词/词根，只能逐条人工确认"（种子注释原话）。
 * 拿它们去做近似匹配，会在真实稿子里稳定产出噪声：
 *   `roadmap → README`（0.833 音形）、`codex → Context`（0.714 音形）——
 *   一场关于产品 roadmap 与 Codex 外接智能体的会，两条**都不是错字**。
 * 字面命中那条路不受影响：这些词条被写进正文时仍然照常命中。
 */
function isFuzzyEligible(entry: { riskLevel?: string }): boolean {
  return entry?.riskLevel !== 'high';
}

/** 模糊候选的 `entryRef` 前缀：`fuzzy_<entryId>_<channel>`。 */
export const FUZZY_ENTRY_PREFIX = 'fuzzy_';

export interface FuzzyCandidateStats {
  /** 召回层给出的候选总数（含被丢弃的 normalized）。 */
  recalled: number;
  /** 实际进入扫描结果的条数。 */
  produced: number;
  /** 被丢弃的 normalized 通道条数（与精确命中重复）。 */
  skippedNormalized: number;
  /** 与精确命中 span 重叠而丢弃的条数。 */
  skippedOverlap: number;
  /** 因词条是 `riskLevel:'high'`（合法英文词/短词）而不进模糊通道的条数。 */
  skippedHighRisk: number;
  /** 达到上限被截断（界面必须如实提示"还有更多没显示"）。 */
  truncated: boolean;
  /** 按通道产出条数（面板据此显示"音近 N / 编辑距离 N / 弱匹配 N"）。 */
  byChannel: Partial<Record<RecallChannel, number>>;
  /** 召回层报出的孤立可疑形态数（"必须入册"的行动清单长度，只报数不给映射）。 */
  residualCount: number;
}

export interface FuzzyCandidateResult {
  candidates: CorrectionCandidate[];
  stats: FuzzyCandidateStats;
}

export interface BuildFuzzyCandidatesOptions extends RecallOptions {
  /** 精确扫描已产出的 span：与之重叠的模糊候选直接丢弃。 */
  existingSpans?: Span[];
  maxCandidates?: number;
}

function overlapsAny(span: Span, spans: Span[]): boolean {
  return spans.some((s) => span.start < s.end && span.end > s.start);
}

/**
 * 建模糊候选。
 *
 * 输出可以**直接拼进 `scan.candidates`**：`entryRef` 唯一（`fuzzy_<entryId>_<channel>`）、
 * `span` 来自原文坐标（下游 apply 会按折叠串逐字复核）、`confidence` 沿用召回层
 * （恒 < 1，见 `MAX_RECALL_CONFIDENCE`）。
 */
export function buildFuzzyCandidates(
  text: string,
  entries: GlossaryEntry[],
  options: BuildFuzzyCandidatesOptions = {},
): FuzzyCandidateResult {
  const limit = Math.max(1, Math.floor(options.maxCandidates ?? MAX_FUZZY_CANDIDATES));
  const existing = (options.existingSpans ?? []).filter(
    (s) => Number.isFinite(s?.start) && Number.isFinite(s?.end),
  );
  const source = String(text ?? '');
  const emptyStats: FuzzyCandidateStats = {
    recalled: 0,
    produced: 0,
    skippedNormalized: 0,
    skippedOverlap: 0,
    skippedHighRisk: 0,
    truncated: false,
    byChannel: {},
    residualCount: 0,
  };
  if (!source.trim() || !entries?.length) return { candidates: [], stats: emptyStats };

  const recallOptions: RecallOptions = {
    ...(options.docId ? { docId: options.docId } : {}),
    ...(options.scenarioTags?.length ? { scenarioTags: options.scenarioTags } : {}),
    ...(options.kinds?.length ? { kinds: options.kinds } : {}),
    ...(options.excludeEntryIds?.length ? { excludeEntryIds: options.excludeEntryIds } : {}),
    ...(options.domainTerms?.length ? { domainTerms: options.domainTerms } : {}),
    ...(options.trapWords?.length ? { trapWords: options.trapWords } : {}),
    ...(options.extraPhonetic ? { extraPhonetic: options.extraPhonetic } : {}),
    ...(Number.isFinite(options.minSimilarity) ? { minSimilarity: options.minSimilarity } : {}),
    ...(Number.isFinite(options.weakSimilarity) ? { weakSimilarity: options.weakSimilarity } : {}),
    ...(Number.isFinite(options.contextWindow) ? { contextWindow: options.contextWindow } : {}),
    ...(options.initialStrict === false ? { initialStrict: false } : {}),
  };

  const recalled = recallCandidates(source, entries, recallOptions);
  // 高危词条不进模糊通道（依据见 isFuzzyEligible 注释）：先查表，O(1)。
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const foldedText = foldText(source);
  const candidates: CorrectionCandidate[] = [];
  const taken: Span[] = [...existing];
  let skippedNormalized = 0;
  let skippedOverlap = 0;
  let skippedHighRisk = 0;
  let truncated = false;
  const byChannel: Partial<Record<RecallChannel, number>> = {};

  for (const hit of recalled.candidates) {
    if (!FUZZY_CHANNELS.has(hit.channel)) {
      skippedNormalized += 1;
      continue;
    }
    if (!isFuzzyEligible(entryById.get(hit.entryRef) ?? {})) {
      skippedHighRisk += 1;
      continue;
    }
    if (overlapsAny(hit.span, taken)) {
      // 同一处已经有一条依据更强的候选（精确命中，或召回层里排更前的通道）。
      skippedOverlap += 1;
      continue;
    }
    if (candidates.length >= limit) {
      truncated = true;
      continue;
    }
    const quotedBy = findQuoteContext(foldedText, hit.span);
    taken.push(hit.span);
    byChannel[hit.channel] = (byChannel[hit.channel] ?? 0) + 1;
    candidates.push({
      // 引例前缀在这里**不加**：模糊候选本来就永不预勾，再分一组只会让界面更碎；
      // 但引例标记照旧带上，让面板能把"引例"讲清楚。
      entryRef: `${FUZZY_ENTRY_PREFIX}${hit.entryRef}_${hit.channel}`,
      wrong: hit.wrong,
      correct: hit.correct,
      action: 'replace',
      confidence: hit.confidence,
      riskLevel: 'medium',
      context: hit.context,
      span: hit.span,
      ignoredCount: 0,
      contextAllow: [],
      fromFuzzy: true,
      fuzzy: { channel: hit.channel, similarity: hit.similarity, disposition: hit.disposition },
      ...(quotedBy ? { quotedExample: true, quotedBy } : {}),
    });
  }

  candidates.sort((a, b) => a.span.start - b.span.start || b.confidence - a.confidence);

  return {
    candidates,
    stats: {
      recalled: recalled.candidates.length,
      produced: candidates.length,
      skippedNormalized,
      skippedOverlap,
      skippedHighRisk,
      truncated,
      byChannel,
      residualCount: recalled.stats.residual.length,
    },
  };
}

/** 供面板/离开记解释用：模糊候选的 ref 前缀常量（避免各处硬编码字符串）。 */
export const FUZZY_REF_PREFIX = FUZZY_ENTRY_PREFIX;
