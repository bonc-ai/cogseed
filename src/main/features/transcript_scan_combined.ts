/**
 * transcript_scan_combined — 「规则 + 召回 + AI 复核」三路合一的扫描接缝
 *
 * 为什么要有这一层（2026-10-15）：
 *   三路候选原本只在 `ipc/transcript.ts` 的 `transcript.correct.scan` 处理函数里
 *   内联拼装。于是**同一件事有两条入口却只有一条实现**：
 *
 *     - 面板（IPC）  ：规则 + 召回 + AI 复核，三路齐全；
 *     - agent 工具   ：只调 `scanText`，**连召回层都没接**，更没有 AI 复核。
 *
 *   而智能会议Agent 的纠错流程走的正是 agent 那条路 —— 所以"规则加 AI"这件事，
 *   面板早就有了，agent 一直只有纯规则。补法有两种：再抄一遍内联流水线（迟早漂移），
 *   或者把它抽成唯一实现让两边都走。这里选后者。
 *
 * 三路各是什么：
 *   1. **精确（exact）**  —— `scanText` 字面命中（折叠大小写/全角）。确定性，零成本。
 *   2. **召回（recall）** —— 归一化/音形/编辑距离的多路召回。纯字符串算法，
 *      仍零成本；用来兜住"词表里没写过的错形"（ASR 错形是开放集，
 *      同一个概念 `Cogseed` 实测出现过 11 种写法）。**只出候选，不自动替换。**
 *   3. **AI 复核（model）** —— 让模型读正文找错写。唯一花钱、唯一依赖网络的一路。
 *      **默认开**：纠错的目标是"准确、快、稳定"，而 ASR 错形是开放集，纯查表
 *      必然漏（`roadmap` 这类音不近形不近的错写，任何字符串相似度都兜不住）。
 *      为了省钱而默认不跑，等于把准确率让掉 —— 那不是优化，是缺功能。
 *      用来兜住 `roadmap` 这类"音不近、形不近"的错写。
 *
 * 硬性质（靠设计，不靠调用方自觉）：
 *   - **AI 失败绝不拖垮纠错**：模型未配置 / 超时 / 报错都只让 `review.skipped` 有值，
 *     规则与召回结果照常返回。扫描的可用性不依赖模型可用性。
 *   - **AI 候选永不自动应用**：产出带 `fromModel: true`，而 `applyCorrections`
 *     对它的默认判据是"不入选"（见该函数说明）。这里只负责如实标注来源。
 *   - **截断可见**：召回与模型各自的上限打满时如实透出，不假装"都看过了"。
 */

import * as transcriptAutoCorrect from './transcript_auto_correct';
import * as transcriptRecall from './transcript_recall';
import * as transcriptGlossary from './transcript_glossary';
import * as transcriptOntology from './transcript_ontology_bridge';
import * as transcriptLlm from './transcript_llm_candidates';
import { createLogger } from '../logger';

const log = createLogger('transcript-scan-combined');

/**
 * 模型建议"可自动应用"所需的**最低置信度**。
 *
 * 为什么不能只看"指向已知写法"：实测（2026-10-15 真机）出现过
 * `都认资产 → 多维表格`（conf **0.4**，`inAllowlist: true`）—— 目标词确实在
 * 词表里，但模型自己都没把握。**指向已知写法只保证"不引入新词"，不保证
 * "这里真的该改"**。所以再加一道置信度门禁：把握不够就交给用户看一眼。
 *
 * 取 0.5：低于 `transcript_llm_candidates.LLM_CANDIDATE_MIN_CONFIDENCE`(0.7)。
 * 理由：那 0.7 是"值不值得提出来给用户看"的门槛，这里是"值不值得不打扰用户"，
 * 后者本来就该更严；但设成 0.7 会把 `maas → MaaS`(0.5)、`mary C → Mary C`(0.4)
 * 这类**字形规范化**也挡在外面，而那些是明显安全的。
 * 字形规范化走独立判据（`isGlyphNormalization`），**不受此阈值限制**。
 */
const AUTO_APPLY_MIN_CONFIDENCE = 0.5;

/** `stats.byChannel` 的形状（按**来源路**计数，与候选总数自洽）。 */
export interface ScanByChannel {
  exact: number;
  recall: number;
  model: number;
}

/** AI 复核的执行摘要。`skipped` 有值即表示这一路**没有真的跑**，必须如实告知。 */
export interface ScanReviewSummary {
  modelCandidates: number;
  chunksScanned: number;
  chunksTotal: number;
  truncated: boolean;
  failedChunks: number;
  outsideAllowlist: number;
  rejected: number;
  /** `no_model`（未配置） / `empty_text` / `model_failed`；空串表示真的跑过。 */
  skipped: string;
  /** 优先参考名单（词表正确写法 + 本体规范名）的长度，供"模型可有依据"的判断。 */
  knownCount: number;
  /** 【加法】本次复核消耗的 token（未配置/失败时缺省）。 */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface ScanRecallSummary {
  candidates: number;
  byChannel: Record<transcriptRecall.RecallChannel, number>;
  abandoned: Array<{ surface: string; count: number }>;
  merged: number;
}

export interface CombinedScanResult {
  /** 规则命中的原始扫描结果（保留 denied / stats，便于上层做引例只读行等）。 */
  ruleScan: transcriptAutoCorrect.ScanResult;
  /** 三路合并后的候选。 */
  candidates: transcriptAutoCorrect.CorrectionCandidate[];
  /** 引例只读行：是提示，不是候选，不进 `candidates`。 */
  quotedRows: transcriptAutoCorrect.CorrectionCandidate[];
  stats: {
    entriesScanned: number;
    candidates: number;
    denied: number;
    truncated: boolean;
    /** 因"左右一样、无替换动作"而未参与扫描的名册条目数。 */
    nameRosterSkipped: number;
    byChannel: ScanByChannel;
    quotedExample: number;
    /** 被抑制判据滤掉的行数（调用方未注入判据时为 0）。 */
    suppressed: number;
  };
  recall?: ScanRecallSummary;
  review: ScanReviewSummary | null;
}

export interface CombinedScanOptions {
  /** 文档标识：参与作用域判定与 AI 复核的会话键。 */
  docId?: string;
  scenarioTags?: string[];
  /** 情景信号（说话人/主题）：只进扫描的展示位，不参与作用域判定。 */
  speakers?: string[];
  topic?: string;
  includeDelete?: boolean;
  /** 是否跑召回层（纯算法、零成本）。默认 `false`，与既有调用方一致。 */
  includeRecall?: boolean;
  /**
   * 是否跑 AI 复核（**唯一花钱、唯一依赖网络的一路**）。**默认 `true`**。
   *
   * 默认开的理由：纠错的目标是准确 —— ASR 错形是开放集，纯查表必然漏。
   * 传 `false` 可显式关闭（例如"我只要规则结果、现在就出稿"）。
   *
   * 无论开不开，**模型不可用都不会让扫描失败**：只是 `review.skipped` 有值，
   * 规则与召回结果照常返回。扫描的可用性不依赖模型可用性。
   */
  includeReview?: boolean;
  /** 抑制判定：返回 true 的候选不出行。由调用方注入（面板走回执账本）。 */
  isSuppressed?: (entryRef: string) => Promise<boolean> | boolean;
  maxCandidates?: number;
  /**
   * `byChannel.exact` 的口径。
   *
   * - `'strict'`（默认）：只数真正走字面命中的候选；模型候选单独计进 `model`。
   *   ⇒ `exact + recall + model === candidates.length`，三路互斥、可自洽核对。
   * - `'legacy-panel'`：**保留面板的历史口径** —— 面板给规则候选统一标
   *   `channel: 'exact'`，于是模型候选也被算进 `exact`，`model` 靠 `review` 单独给。
   *   这是既有 UI 的既有断言（`transcript-scan-review.test.ts` 明确断过
   *   `{exact:1, recall:1, model:0}`），切换会改坏界面读数。
   *
   * 默认取 strict：新调用方（agent）应拿到自洽的口径；面板显式传 legacy 保持零变化。
   */
  byChannelMode?: 'strict' | 'legacy-panel';
}

/** 把模型候选转成与规则候选同构的形态（面板与 agent 共用同一转换）。 */
function buildModelCandidates(review: transcriptLlm.LlmCandidateResult): transcriptAutoCorrect.CorrectionCandidate[] {
  return review.candidates.map((candidate, index) => ({
    entryRef: `model_${index}`,
    wrong: candidate.wrong,
    correct: candidate.correct,
    action: 'replace' as const,
    confidence: candidate.confidence,
    // 固定 medium：不是"可自动应用的低风险规则"，也不是"高危待确认"。
    // 它能不能自动应用由 `toKnownForm` 决定（见下）。
    riskLevel: 'medium' as const,
    context: candidate.reason,
    span: { start: candidate.start, end: candidate.start + candidate.wrong.length },
    ignoredCount: 0,
    contextAllow: [] as string[],
    channel: 'model' as const,
    fromModel: true,
    /**
     * **能否自动应用的分界线**（对齐 `applyCorrections` 的入选判据）。
     *
     *   - `inAllowlist: true` —— 模型指向的写法**已经在词表/本体里**。
     *     它不引入新词，最坏也只是把同形词换成团队已在用的规范名
     *     ⇒ 可自动应用，不打扰用户。
     *   - 或**纯字形规范化**（只改大小写/全角，不改字，见 `isGlyphNormalization`）
     *     —— 没有引入任何新字符 ⇒ 同样可自动应用。
     *   - 其余 —— 模型**自创**了一个写法 ⇒ 必须人工确认。
     *
     * 这一层映射必须显式写出来：`inAllowlist` 与 `toKnownForm` 是不同模块的
     * 概念，靠名字相近来"顺手传递"迟早出错。
     */
    // 字形规范化「没有引入新字符」，任何时候都安全；
    // 「指向已知写法」还要模型有把握 —— 否则 `都认资产 → 多维表格`(conf 0.4)
    // 这种"目标在词表里、但这里未必该改"的也会被自动应用。
    toKnownForm:
      isGlyphNormalization(candidate.wrong, candidate.correct)
      || (candidate.inAllowlist === true
        && Number(candidate.confidence) >= AUTO_APPLY_MIN_CONFIDENCE),
  }));
}

/**
 * 这条建议是不是**纯字形规范化**（只改大小写 / 全角半角，不改字）。
 *
 * 为什么它可以自动应用：折叠大小写与全角后两串相同，说明模型**没有引入任何
 * 新字符**，只是把写法统一成规范形态 —— 改错的可能性极低，却因为是"模型提的、
 * 且不在词表里"而被判成需要人工确认，纯属打扰。
 *
 * 实测（2026-10-15 真机跑一份 18 分钟转写，模型 7.7 秒给出 17 条建议）：
 *   `mary C → Mary C`、`maas → MaaS` 等一批纯字形建议，
 * 全部落进"必须逐条确认"，用户白点十几下。
 *
 * 判据是**折叠后相等**，所以 `星巴克 → 星巴克`（完全相同）也包含在内；
 * 而 `健全 → 鉴权` 这类改字的**不会**被误放行（折叠后不相等）。
 */
function isGlyphNormalization(wrong: string, correct: string): boolean {
  const w = foldForGlyph(wrong);
  const c = foldForGlyph(correct);
  return w.length > 0 && w === c;
}

/** 折叠大小写与全角，用于判断"是否只改了字形"。 */
function foldForGlyph(value: string): string {
  return String(value ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * 执行「规则 + 召回 + AI 复核」扫描。
 *
 * 与 `scanText` 的关系：这是**编排层**，`scanText` 是三路里的一路实现。
 * 纯规则调用方应继续直接用 `scanText`（零依赖、同步）。
 */
export async function scanTranscriptCombined(
  userId: string,
  text: string,
  options: CombinedScanOptions = {},
): Promise<CombinedScanResult> {
  const entries = transcriptGlossary.listEntries(userId, { status: 'active' });
  const docId = options.docId;

  const ruleScan = transcriptAutoCorrect.scanText(text, entries, {
    ...(docId ? { docId } : {}),
    ...(options.scenarioTags?.length ? { scenarioTags: options.scenarioTags } : {}),
    ...(options.speakers?.length ? { speakers: options.speakers } : {}),
    ...(options.topic ? { topic: options.topic } : {}),
    includeDelete: options.includeDelete === true,
    ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
  });

  const canonical = transcriptOntology.collectCanonicalNames(userId);
  let candidates: transcriptAutoCorrect.CorrectionCandidate[] = transcriptAutoCorrect
    .attachOntologyRefs(ruleScan.candidates, canonical)
    .map((c) => ({ ...c, channel: 'exact' as const }));

  // ── 召回层（纯算法，零成本）────────────────────────────────────────────
  let recallSummary: ScanRecallSummary | undefined;
  if (options.includeRecall === true && entries.length > 0) {
    const recall = transcriptRecall.recallCandidates(text, entries, {
      ...(docId ? { docId } : {}),
      ...(options.scenarioTags?.length ? { scenarioTags: options.scenarioTags } : {}),
      domainTerms: canonical.map((item) => item.name),
    });
    const entryById = new Map(entries.map((e) => [e.id, e] as const));
    const recallList: transcriptAutoCorrect.CorrectionCandidate[] = recall.candidates.map((r) => ({
      entryRef: r.entryRef,
      wrong: r.wrong,
      correct: r.correct,
      action: 'replace' as const,
      confidence: r.confidence,
      riskLevel: r.riskLevel,
      context: r.context,
      span: r.span,
      ignoredCount: entryById.get(r.entryRef)?.ignoredCount ?? 0,
      contextAllow: entryById.get(r.entryRef)?.contextAllow ?? [],
      channel: 'recall' as const,
      disposition: r.disposition,
      refs: [{
        source: 'glossary' as const,
        entryId: r.entryRef,
        kind: r.kind,
        freq: entryById.get(r.entryRef)?.freq ?? 0,
      }],
    }));
    const merged = transcriptAutoCorrect.mergeRecallCandidates(candidates, recallList);
    candidates = merged.candidates;
    recallSummary = {
      candidates: candidates.filter((c) => c.channel === 'recall').length,
      byChannel: recall.stats.byChannel,
      abandoned: recall.stats.residual,
      merged: merged.merged,
    };
  }

  // ── 抑制过滤（调用方注入判据；面板走回执账本）─────────────────────────
  let suppressedRows = 0;
  if (options.isSuppressed) {
    const isSuppressed = options.isSuppressed;
    const refs = [...new Set(candidates.map((c) => c.entryRef))];
    const flags = new Map<string, boolean>();
    await Promise.all(refs.map(async (ref) => {
      try {
        flags.set(ref, await isSuppressed(ref));
      } catch (error) {
        // 抑制查询失败不该让整次扫描失败：按"未抑制"处理并如实记一条 warn。
        log.warn('suppression probe failed; treating candidate as not suppressed', {
          ref,
          error: error instanceof Error ? error.message : String(error),
        });
        flags.set(ref, false);
      }
    }));
    const before = candidates.length;
    candidates = candidates.filter((c) => !flags.get(c.entryRef));
    suppressedRows = before - candidates.length;
  }

  // 引例只读行：是提示，不是候选（不进 candidates / stats.candidates）。
  const quotedRows = transcriptAutoCorrect.quotedExampleRows(text, ruleScan.denied, entries);

  // ── AI 复核（唯一花钱、唯一依赖网络的一路）─────────────────────────────
  let review: ScanReviewSummary | null = null;
  if (options.includeReview !== false) {
    // 优先参考名单 = 词表正确写法 + 本体规范名（长度受限，提示词要可控）。
    const known = new Set<string>();
    for (const e of entries) {
      known.add(e.wrong);
      known.add(e.correct);
    }
    for (const name of canonical) known.add(name.name);
    const allowed = [
      ...entries.filter((e) => e.action !== 'delete').map((e) => e.correct),
      ...canonical
        .filter((n) => n.source === 'ontology' && n.seedKind !== 'field' && n.seedKind !== 'group')
        .map((n) => n.name),
    ]
      .filter((value) => !!value && value.length <= 60)
      .slice(0, transcriptLlm.LLM_CANDIDATE_MAX_ALLOWED);

    // 词形可疑的位置只作为"重点线索"，不决定要不要问（历史事故：把词形判据当准入闸门
    // ⇒ 中文会议几乎必然 0 命中 ⇒ 用户看到"模型给不出候选"，实际是模型没被问到）。
    // Phonetic recall has no semantic evidence (e.g. ok → an unrelated
    // product). Feed its locations into contextual review instead of making
    // every string resemblance a mandatory human decision.
    const hintRows = [
      ...candidates.filter(c => c.channel === 'recall' && c.disposition === 'review')
        .map(c => ({ text: c.wrong, start: c.span.start })),
      ...transcriptAutoCorrect.detectSuspectEntities(text, known, transcriptLlm.LLM_CANDIDATE_MAX_HINTS)
        .map(suspect => ({ text: suspect.text, start: suspect.span.start })),
    ];
    const hints = [...new Map(hintRows.map(hint => [hint.start, hint])).values()]
      .slice(0, transcriptLlm.LLM_CANDIDATE_MAX_HINTS);

    /**
     * **错写对照表**：词表里"错形 ≠ 正确写法"的那些条目。
     *
     * 必须传：词表的核心就是这张表，但此前只把"正确写法"那一列平铺给模型，
     * 错形那一列完全没给 —— 于是模型只能猜读音，实测把 `maas` 猜成 `MaaS`。
     * 名册条目（`wrong === correct`）没有对照信息，排除掉。
     */
    const correctionPairs = entries
      .filter((e) => e.action !== 'delete' && e.wrong.trim() !== e.correct.trim())
      .map((e) => ({ wrong: e.wrong, correct: e.correct }));

    let llm: transcriptLlm.LlmCandidateResult | null = null;
    try {
      llm = await transcriptLlm.generateReviewCandidates(userId, text, {
        knownTargets: allowed,
        correctionPairs,
        hints,
        ...(docId ? { sessionKey: docId } : {}),
      });
    } catch (error) {
      // 这一路失败**绝不能**影响规则/召回结果。如实标注 model_failed。
      log.warn('AI review threw; continuing with rule + recall only', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!llm) {
      review = {
        modelCandidates: 0, chunksScanned: 0, chunksTotal: 0, truncated: false,
        failedChunks: 0, outsideAllowlist: 0, rejected: 0,
        skipped: 'model_failed', knownCount: allowed.length,
      };
    } else {
      const allModelRows = buildModelCandidates(llm);
      // Absence counts only after a complete successful review. A skipped,
      // truncated or failed review must not silently discard pending work.
      if (!llm.skipped && !llm.truncated && !llm.failedChunks
        && llm.chunksTotal > 0 && llm.chunksScanned === llm.chunksTotal) {
        candidates = candidates.filter(c => c.channel !== 'recall' || c.disposition !== 'review'
          || (llm.reviewedRanges && !llm.reviewedRanges.some(range => c.span.start >= range.start && c.span.end <= range.end))
          || allModelRows.some(model => model.span.start === c.span.start
            && model.span.end === c.span.end && model.correct === c.correct));
        if (recallSummary) recallSummary.candidates = candidates.filter(c => c.channel === 'recall').length;
      }
      /**
       * **规则已命中的位置，模型不得再提同一处。**
       *
       * 否则同一个 `wrong -> correct` 会出现两条候选：规则那条按自己的风险等级
       * （例如 `maas -> MeshSeed` 是 `high`，要求人工确认），模型那条固定
       * `medium` 且 `toKnownForm: true` ⇒ **自动应用**。
       * 结果是模型那条把规则的风险保护**整个绕过去** —— 实测（2026-10-15）
       * `maas/mhc/msc` 就这么被自动应用了，而它们本该逐条确认。
       *
       * 判据用"同一处 + 同一改写"。规则命中优先 —— 它带着词表里配好的
       * 风险等级与语境护栏，权威性高于模型建议。
       */
      const ruleRows = candidates.filter((c) => c.fromModel !== true);
      const claimedByRules = new Set(
        ruleRows.map((c) => `${c.span.start}:${c.span.end}:${c.wrong}\u0000${c.correct}`),
      );
      /** 规则已经占住的跨度：模型换个改法插进同一处同样会冲突。 */
      const occupiedSpans = new Set(ruleRows.map((c) => `${c.span.start}:${c.span.end}`));
      const deduped = allModelRows.filter(
        (c) => !claimedByRules.has(`${c.span.start}:${c.span.end}:${c.wrong}\u0000${c.correct}`)
          && !occupiedSpans.has(`${c.span.start}:${c.span.end}`),
      );
      candidates = [...candidates, ...deduped];
      review = {
        modelCandidates: deduped.length,
        chunksScanned: llm.chunksScanned,
        chunksTotal: llm.chunksTotal,
        truncated: llm.truncated,
        failedChunks: llm.failedChunks,
        outsideAllowlist: llm.outsideAllowlist,
        rejected: llm.rejected.length,
        skipped: llm.skipped ?? '',
        knownCount: allowed.length,
        ...(llm.usage ? { usage: llm.usage } : {}),
      };
    }
  }

  const exactStrict = candidates.filter((c) => c.fromModel !== true && c.channel !== 'recall').length;
  const recallCount = candidates.filter((c) => c.channel === 'recall').length;
  const modelCount = candidates.filter((c) => c.fromModel === true).length;
  const legacy = options.byChannelMode === 'legacy-panel';

  return {
    ruleScan,
    candidates,
    quotedRows,
    stats: {
      entriesScanned: ruleScan.stats.entriesScanned,
      candidates: candidates.length,
      denied: ruleScan.stats.denied,
      truncated: ruleScan.stats.truncated,
      nameRosterSkipped: ruleScan.stats.nameRosterSkipped,
      byChannel: legacy
        // 面板历史口径：非召回的都算 exact（含模型候选），model 由 review 单独给。
        ? { exact: exactStrict + modelCount, recall: recallCount, model: 0 }
        // 严格口径：三路互斥，exact + recall + model === candidates.length
        : { exact: exactStrict, recall: recallCount, model: modelCount },
      quotedExample: quotedRows.length,
      suppressed: suppressedRows,
    },
    ...(recallSummary ? { recall: recallSummary } : {}),
    review,
  };
}
