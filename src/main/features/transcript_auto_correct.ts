/**
 * transcript_auto_correct — 转写纠错扫描与替换引擎（**纯函数，不碰文件系统**）
 *
 * 职责：给定"文本 + 词表"，产出①候选（含拒绝原因）②按确认结果替换后的文本
 * 与③偏移映射。所有副作用（落盘、快照、IPC）都在其它模块。
 *
 * 硬护栏（对应方案 v0.2 §五 P0-2，逐条都有真实事故依据）：
 *   1. 子串边界：`coxy` 不得命中 `coxyx`（span 前后字符约束）；
 *   2. 词边界：`boundary: 'word'` 的词条，左右邻字符是字母/数字/CJK 即拒
 *      （真实事故：`Cloud→Claude` 命中 `iCloud` 内部，写出 `iClaude`）；
 *   3. 语境黑名单：命中窗口内出现 `contextDeny` 任一词即拒
 *      （真实范式：`傅平 ~~~ 扶贫|精准|脱贫`，防"扶贫办工作人员"→"傅平办工作人员"）；
 *   4. 作用域：`scope.global=false` 的词条只在其 docId/场景内生效
 *      （真实事故：一次会议学到的 7 个姓氏变体被当全局规则，改了无关稿件的"某老师"）；
 *   5. 保护区域：fenced code / 行内 code / URL 内不做替换；
 *   6. 重叠消解：长词优先、`freq` 次优先，同 span 只保留一个候选；
 *   7. 口癖规则包：`kind=filler` 的词条按 `transcript_filler_rules` 的边界策略删除
 *      （白名单词只在句首/独立出现；`就是/然后/对` 只在重复或纯应答），
 *      绝不"见词就删"；
 *   8. 语境白名单：命中窗口内出现 `contextAllow` 任一词则**整条候选静默丢弃**
 *      （方案 §七「加白」：误杀一次就加白，别再反复提示）；
 *   9. **只做替换/删除，不生成句子**：输出必须能由"原文 + 编辑集"逐字重建
 *      （`verifyEditsRebuild`），从结构上排除模型补写
 *      （真实事故：清理产物里出现原文没有的 11 秒发言）。
 *
 * 偏移映射：删除会缩短文本、替换会改变长度，任何 span/时间锚点都会错位，
 * 因此 `applyCorrections` 必须同时返回 `offsetMap`（keep/replace/delete 段），
 * 供上层重算时间戳与语录位置。
 */

import {
  type GlossaryEntry,
  type GlossaryKind,
  type RiskLevel,
  foldText,
  isCjkOrWordChar,
  scopeAllows,
} from './transcript_glossary';
import {
  detectFillers,
  fillerRuleFor,
  type FillerRule,
} from './transcript_filler_rules';
// 【specs/013 T018】引例判据**唯一来源**是 transcript_rewrite.QUOTE_MARKERS（T005 导出）。
// 这里只引用、绝不复制第二份词表（T059 反漂移断言①）。运行时只在函数体内使用，
// 与 rewrite→recall→auto_correct 的既有 import 方向不构成顶层求值环。
import { QUOTE_MARKERS } from './transcript_rewrite';

/** 清理版字符保留率低于此值即判"疑似过度改写"（方案 v0.2 §8.2）。 */
export const OVER_REWRITE_THRESHOLD = 0.55;
/** 语境黑名单检查窗口（两侧各取多少字符）。方案里的例子用"周围 5 个语义词"，
 *  这里按字符近似（中文 1 字≈1 义素），取 20 字。 */
export const DEFAULT_CONTEXT_WINDOW = 20;

export type DeniedReason =
  | 'out_of_scope'
  | 'context_denied'
  | 'context_allowed'
  | 'word_boundary'
  | 'overlapping_span'
  | 'protected_region'
  // 【specs/013 T006，加法】引例语境：命中 span 的窗口内出现 QUOTE_MARKERS 任一
  // （"在讲拼写/识别这件事本身"）→ 宁可漏改不破坏语义（FR-011）。
  | 'quoted_example';

/**
 * 【specs/013 T006，加法】纠错候选的**依据**（FR-001"凭什么这么改"）。
 * 一条候选可并列多条（词表命中 + 本体规范名 + 会议引用资产）。
 */
export type CorrectionBasisRef =
  | { source: 'glossary'; entryId: string; kind: GlossaryKind; freq: number }
  | { source: 'ontology'; name: string; groupId?: string; fieldId?: string }
  | { source: 'asset'; assetId: string; version: string; title: string };

export interface Span { start: number; end: number }

export interface ScanTarget {
  docId?: string;
  scenarioTags?: string[];
}

export interface ScanOptions extends ScanTarget {
  /** 是否处理 `action: 'delete'` 的词条（口癖规则包，P1 默认关闭）。 */
  includeDelete?: boolean;
  includePaused?: boolean;
  contextWindow?: number;
  maxCandidates?: number;
  /**
   * 【specs/013 T006，加法】说话人名单（FR-012 情景层）。由主进程用
   * `parseTranscriptBlocks` 现算（不由渲染层传，避免已发生的时钟格式漂移事故）。
   * **只用于依据展示与降级标注，不参与 `scopeAllows`**（作用域语义不动）。
   */
  speakers?: string[];
  /** 【specs/013 T006，加法】话题/主题（可空）。仅用于依据展示；不参与 `scopeAllows`。 */
  topic?: string;
}

export interface CorrectionCandidate {
  entryRef: string;
  wrong: string;
  correct: string;
  action: 'replace' | 'delete';
  /** 精确（归一化后）命中 = 1；本引擎不产出模糊候选，模糊走 LLM 候选通道。 */
  confidence: number;
  riskLevel: RiskLevel;
  context: string;
  span: Span;
  /** 该词条被用户忽略过的次数（>0 = 降权展示：折叠到末尾、默认不勾选）。 */
  ignoredCount: number;
  /** 该词条已有的加白词（面板要能看见并移除；误加一次不该只能改 JSON）。 */
  contextAllow: string[];
  /**
   * 结构性编辑（同人段落合并删块头 / 插时间区间）——不是"清理掉的口癖"。
   * 标记后不会被计进 `deletedFillers`（否则 365 个块头会污染口癖计数）。
   */
  structure?: boolean;
  /**
   * 来自**模型读正文**的建议（`entryRef` 形如 `model_<i>`），不是词表命中。
   * 面板据此标出来源、且**永不预勾**——模型判断要逐条人工确认；
   * 确认应用时按 `meeting_accept` 记进词表（见 ipc/transcript.ts 的 apply）。
   */
  fromModel?: boolean;
  /**
   * 【specs/013 T006/T007，加法】本候选的**依据**（引用哪条词条/规范名/资产）。
   * 字面候选的构造点必填（`refs[0] = { source:'glossary', entryId, kind, freq }`）；
   * 缺 `refs` 的候选经 `withBasisRefsGuard` 不出行（SC-001 依据完整率，宁少不多）。
   * 可选类型 = 存量调用方（apply 的合成候选等）零破坏。
   */
  refs?: CorrectionBasisRef[];
  /**
   * 【specs/013 T006，加法】来源通道：exact（字面）/ recall（多路召回）/ model（模型复核）。
   * 缺省视为 exact（存量调用方与既有断言不受影响）。
   */
  channel?: 'exact' | 'recall' | 'model';
  /**
   * 【specs/013 T006，加法】处置分级：
   *   suggest        —— 可提为建议（仍须用户确认，永不自动替换）
   *   review         —— 必须逐条人工判断（面板永不预勾）
   *   quoted_example —— 引例，不建议替换（只读提示，不进可勾选清单，FR-011）
   * 缺省视为 suggest（存量行为不变）。
   */
  disposition?: 'suggest' | 'review' | 'quoted_example';
  /**
   * 【specs/013 T019，加法】`disposition:'quoted_example'` 的只读提示行里，
   * 命中的引例标记词（QUOTE_MARKERS 之一，如「一会儿叫」）——供文案
   * 解释"为什么降级"（FR-011 可解释）。其余候选不携带。
   */
  quotedBy?: string;
}

export interface DeniedMatch {
  entryRef: string;
  wrong: string;
  correct: string;
  reason: DeniedReason;
  span: Span;
  /** 语境黑名单命中的具体词。 */
  deniedBy?: string;
}

export interface ScanResult {
  candidates: CorrectionCandidate[];
  denied: DeniedMatch[];
  /**
   * `truncated` = 候选超过上限被截断（口癖规则包会让候选数量级上升：
   * 09-05 验收稿就有一千多条）。**截断必须可见**，否则用户以为"就这么多"。
   */
  stats: { entriesScanned: number; candidates: number; denied: number; truncated: boolean };
}

export interface AcceptedEdit {
  entryRef: string;
  wrong: string;
  correct: string;
  action: 'replace' | 'delete';
  span: Span;
  /** 结构性编辑（合并块头等）：不计入口癖删除统计。 */
  structure?: boolean;
}

export interface OffsetSegment {
  inStart: number;
  inEnd: number;
  outStart: number;
  outEnd: number;
  kind: 'keep' | 'replace' | 'delete';
}

export interface AppliedSummary {
  entryRef: string;
  wrong: string;
  correct: string;
  action: 'replace' | 'delete';
  count: number;
  spans: Span[];
}

export interface ApplyOptions {
  /** 接受哪些候选（UI 逐条确认的结果）。缺省 = 全部非 high 候选。 */
  acceptedIds?: string[];
  acceptRiskLevels?: RiskLevel[];
  /** 目标文档/场景——用于记录台账与作用域复核。 */
  docId?: string;
  scenarioTags?: string[];
}

export interface ApplyResult {
  text: string;
  offsetMap: OffsetSegment[];
  applied: AppliedSummary[];
  deletedFillers: Record<string, number>;
  charsIn: number;
  charsOut: number;
  retention: number;
  overRewriteSuspected: boolean;
  /** 未处理的高危候选数：>0 时产物只能标 draft，不得宣称完成。 */
  pendingTotal: number;
  status: 'draft' | 'applied';
}

// ── 保护区域（code / 链接）─────────────────────────────────────────────

export function computeProtectedRanges(text: string): Span[] {
  const ranges: Span[] = [];
  const patterns: RegExp[] = [
    /```[\s\S]*?```/g,          // fenced code
    /`[^`\n]*`/g,               // inline code
    /https?:\/\/\S+/g,          // URL
    /www\.\S+/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return ranges;
}

/**
 * 保护区判据：代码块 / 行内代码 / URL 一律不参与纠错。
 * 导出给"模型读正文提候选"复用——提候选和做替换必须用**同一套**保护区判断，
 * 否则会出现"这里提了候选、那里又拒绝替换"的自相矛盾。
 */
export function isProtected(ranges: Span[], span: Span): boolean {
  return ranges.some((r) => span.start < r.end && span.end > r.start);
}

// ── 扫描 ────────────────────────────────────────────────────────────────

interface RawMatch {
  entry: GlossaryEntry;
  span: Span;
}

/**
 * 【specs/013 T006】依据完整率守卫（SC-001）：缺 `refs` 的候选**不出行**（宁少不多）。
 * `scanText` 自身构造点必填 refs（此守卫对它恒为直通）；导出供后续通道
 * （召回/模型候选并入同一清单）复用同一道闸，不在渲染层重算。
 */
export function withBasisRefsGuard(candidates: CorrectionCandidate[]): CorrectionCandidate[] {
  return candidates.filter((c) => Array.isArray(c.refs) && c.refs.length > 0);
}

/**
 * 【specs/013 T018/T022】引例闸的**唯一判定**（引用唯一 QUOTE_MARKERS，不复制词表）：
 * 命中 span 的前后 `window`（缺省 DEFAULT_CONTEXT_WINDOW=20）窗口内出现任一
 * 引例标记词（"在讲拼写/识别这件事本身"）→ 该 span 是**引例位**。
 *
 * `scanText` 用它拒绝引例位（记 `denied:quoted_example`，FR-011 宁可漏改）；
 * apply 侧（ipc/transcript.ts 的 `excludeQuoted`，缺省 true）用同一判定挡住
 * 落在引例位的模型建议——两侧必须同判据，否则会出现"这里提示是引例、
 * 那里又照样替换"的自相矛盾（与 `isProtected` 导出复用同一理由）。
 */
export function isQuotedExampleSpan(
  text: string,
  span: Span,
  window = DEFAULT_CONTEXT_WINDOW,
): boolean {
  return findDeniedContext(foldText(text), span, QUOTE_MARKERS, window) !== null;
}

/**
 * 【specs/013 T019】引例降级的**可解释只读提示行**（FR-011）：把 `scanText`
 * 记下的 `denied:quoted_example` 转成 `candidates` 里 `disposition:'quoted_example'`
 * 的只读条目——不进可勾选清单、不参与替换，只说明"这里是引例，为什么不建议改"
 * （`quotedBy` = 命中的标记词）。词条已不可考时不造依据、不出行（SC-001 宁少不多）。
 */
export function quotedExampleRows(
  text: string,
  denied: DeniedMatch[],
  entries: GlossaryEntry[],
): CorrectionCandidate[] {
  if (!denied.length) return [];
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const rows: CorrectionCandidate[] = [];
  for (const d of denied) {
    if (d.reason !== 'quoted_example') continue;
    if (d.span.start < 0 || d.span.end <= d.span.start) continue;
    const entry = byId.get(d.entryRef);
    if (!entry) continue;
    rows.push({
      entryRef: d.entryRef,
      wrong: d.wrong,
      correct: d.correct,
      action: entry.action,
      // 只读提示不是替换建议：confidence 0，永不进可接受集
      confidence: 0,
      riskLevel: entry.riskLevel,
      context: contextAround(text, d.span, 40),
      span: d.span,
      ignoredCount: entry.ignoredCount ?? 0,
      contextAllow: entry.contextAllow ?? [],
      channel: 'exact',
      disposition: 'quoted_example',
      refs: [{ source: 'glossary', entryId: entry.id, kind: entry.kind, freq: entry.freq }],
      ...(d.deniedBy ? { quotedBy: d.deniedBy } : {}),
    });
  }
  return rows;
}

/** 【specs/013 T016】召回并入扫描清单的合并结果（统计如实透出，T017）。 */
export interface MergedChannelResult {
  candidates: CorrectionCandidate[];
  /** 同 span 双命中 → 并入既有行 `refs`（并列依据）、未出行的召回条数。 */
  merged: number;
  /** 仅与字面命中**重叠**（非同 span）→ 被既有重叠规则消解掉的召回条数。 */
  overlapsSuppressed: number;
}

/**
 * 【specs/013 T016】合并去重（D5）：召回条目与字面命中**追加进同一清单**前，
 * 在 features 层消解——
 *   - 同 span 已在字面命中 → 召回条目**不出行**，只把它的词条依据并入该行
 *     `refs`（并列依据；同一词条不重复追加，幂等）；
 *   - 其余重叠复用既有规则（通道优先级第一——精确命中必须压过模糊命中，
 *     与 `transcript_recall` 内部消解同一理由——再按长 span → freq → 靠前，
 *     即 `scanText` 重叠消解的同一套键）；
 *   - 不改入参（返回新数组）；IPC 层只调用、不重算。
 */
export function mergeRecallCandidates(
  exact: CorrectionCandidate[],
  recall: CorrectionCandidate[],
): MergedChannelResult {
  if (!recall.length) return { candidates: exact, merged: 0, overlapsSuppressed: 0 };
  const channelRank = (c: CorrectionCandidate): number => (c.channel === 'recall' ? 1 : 0);
  const freqOf = (c: CorrectionCandidate): number =>
    c.refs?.[0]?.source === 'glossary' ? c.refs[0].freq : 0;
  const pool: CorrectionCandidate[] = [...exact, ...recall].map((c) => ({ ...c }));
  pool.sort((a, b) => {
    if (channelRank(a) !== channelRank(b)) return channelRank(a) - channelRank(b);
    const la = a.span.end - a.span.start;
    const lb = b.span.end - b.span.start;
    if (la !== lb) return lb - la;
    if (freqOf(a) !== freqOf(b)) return freqOf(b) - freqOf(a);
    return a.span.start - b.span.start;
  });
  const accepted: CorrectionCandidate[] = [];
  let merged = 0;
  let overlapsSuppressed = 0;
  for (const c of pool) {
    const clash = accepted.find((a) => c.span.start < a.span.end && c.span.end > a.span.start);
    if (clash) {
      const sameSpan = c.span.start === clash.span.start && c.span.end === clash.span.end;
      if (c.channel === 'recall' && sameSpan) {
        const ref = c.refs?.[0];
        if (
          ref && ref.source === 'glossary'
          && !clash.refs?.some((r) => r.source === 'glossary' && r.entryId === ref.entryId)
        ) {
          clash.refs = [...(clash.refs ?? []), ref];
        }
        merged += 1;
      } else {
        overlapsSuppressed += 1;
      }
      continue;
    }
    accepted.push(c);
  }
  accepted.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  return { candidates: accepted, merged, overlapsSuppressed };
}

/**
 * 【specs/013 T008】本体规范名进纠错依据（FR-001）：候选建议写法（`correct`，
 * 折叠比较——大小写/全角不敏感，与词表命中同一套折叠）命中规范名 → 给该候选
 * **追加** `{ source:'ontology', name, groupId?, fieldId? }` 并列依据。
 * 只读纯函数：未命中的候选**原样返回**（对象不复制、refs 不动）；命中则产出
 * 新对象（不改入参）。本体侧来源由调用方（ipc/transcript.ts 的 scan 组装处）
 * 只读调既有 `collectCanonicalNames`/`collectAllCanonicalNames` 喂进来。
 */
export function attachOntologyRefs(
  candidates: CorrectionCandidate[],
  canonical: Array<{ name: string; ontologyRef?: { groupId: string; fieldId: string } }>,
): CorrectionCandidate[] {
  if (!canonical.length || !candidates.length) return candidates;
  const byFoldedName = new Map<string, { name: string; groupId?: string; fieldId?: string }>();
  for (const item of canonical) {
    const key = foldText(String(item?.name ?? '')).trim();
    if (!key) continue;
    if (!byFoldedName.has(key)) {
      byFoldedName.set(key, {
        name: String(item.name),
        ...(item.ontologyRef ? { groupId: item.ontologyRef.groupId, fieldId: item.ontologyRef.fieldId } : {}),
      });
    }
  }
  return candidates.map((candidate) => {
    const hit = byFoldedName.get(foldText(candidate.correct ?? '').trim());
    if (!hit) return candidate;
    const existing = Array.isArray(candidate.refs) ? candidate.refs : [];
    if (existing.some((ref) => ref.source === 'ontology' && ref.name === hit.name)) return candidate;
    return { ...candidate, refs: [...existing, { source: 'ontology', ...hit }] };
  });
}

export function scanText(text: string, entries: GlossaryEntry[], options: ScanOptions = {}): ScanResult {
  const foldedText = foldText(text);
  const protectedRanges = computeProtectedRanges(text);
  const window = options.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const denied: DeniedMatch[] = [];
  const raw: RawMatch[] = [];
  let entriesScanned = 0;

  for (const entry of entries) {
    if (!options.includePaused && entry.status === 'paused') continue;
    if (entry.action === 'delete' && !options.includeDelete) continue;
    entriesScanned += 1;

    const expect = foldText(entry.wrong).trim();
    if (!expect) continue;

    if (!scopeAllows(entry.scope, { docId: options.docId, scenarioTags: options.scenarioTags })) {
      denied.push({
        entryRef: entry.id, wrong: entry.wrong, correct: entry.correct,
        reason: 'out_of_scope', span: { start: -1, end: -1 },
      });
      continue;
    }

    // 口癖/填充词（kind=filler + action=delete）走规则包：白名单词只在句首或
    // 独立出现时删，语义连词只在重复或纯应答时删（方案 §五 P1-1）。
    // 关键：**绝不"见词就删"**——`这个方案`、`然后我们` 都要原样留着。
    if (entry.action === 'delete' && entry.kind === 'filler') {
      const rule: FillerRule = fillerRuleFor(entry.wrong) ?? {
        term: entry.wrong,
        mode: 'standalone',
        note: '词表自带口癖词：默认只删独立出现',
      };
      for (const match of detectFillers(text, [rule])) {
        if (isProtected(protectedRanges, match.span)) {
          denied.push({ entryRef: entry.id, wrong: entry.wrong, correct: entry.correct, reason: 'protected_region', span: match.span });
          continue;
        }
        // 【specs/013 T018】引例闸：删除同样不得碰引例（"我把口癖念成嗯"是例子，
        // 删掉就破坏了说话人在讲的例子本身）。判据与替换路径同一处（isQuotedExampleSpan）。
        const quotedMarker = findDeniedContext(foldedText, match.span, QUOTE_MARKERS, window);
        if (quotedMarker) {
          denied.push({
            entryRef: entry.id, wrong: entry.wrong, correct: entry.correct,
            reason: 'quoted_example', span: match.span, deniedBy: quotedMarker,
          });
          continue;
        }
        raw.push({ entry, span: match.span });
      }
      continue;
    }

    let from = 0;
    for (;;) {
      const idx = foldedText.indexOf(expect, from);
      if (idx < 0) break;
      const span: Span = { start: idx, end: idx + expect.length };
      from = idx + Math.max(1, expect.length);

      if (isProtected(protectedRanges, span)) {
        denied.push({ entryRef: entry.id, wrong: entry.wrong, correct: entry.correct, reason: 'protected_region', span });
        continue;
      }
      // 【specs/013 T018】引例闸（FR-011，唯一"修已知事故"的改动，优先于边界与语境）：
      // 命中窗口内出现 QUOTE_MARKERS 任一 → 该处是引例（"在讲拼写/识别这件事本身"），
      // 不进 candidates、改记 denied:quoted_example（T019 再转只读提示行）。真实事故：
      // 「一会儿叫 coxy」被改成「一会儿叫 Cogseed」，语义完全破坏——宁可漏改。
      // 放在 boundaryOk 之前：引例位要给的是"可解释的引例降级"，而不是一条普通
      // word_boundary 拒绝；同一句的非引例错形不受影响（各 span 各自取窗口）。
      const quotedMarker = findDeniedContext(foldedText, span, QUOTE_MARKERS, window);
      if (quotedMarker) {
        denied.push({
          entryRef: entry.id, wrong: entry.wrong, correct: entry.correct,
          reason: 'quoted_example', span, deniedBy: quotedMarker,
        });
        continue;
      }
      if (!boundaryOk(text, span, entry.boundary)) {
        denied.push({ entryRef: entry.id, wrong: entry.wrong, correct: entry.correct, reason: 'word_boundary', span });
        continue;
      }
      if (entry.action === 'replace') {
        // 白名单（加白）优先于黑名单：用户说过"这个语境里是对的"就不该再提示，
        // 因此这里直接静默丢弃（连待确认都不进），只留一条 denied 记录可追溯。
        const allowed = findDeniedContext(foldedText, span, entry.contextAllow ?? [], window);
        if (allowed) {
          denied.push({
            entryRef: entry.id, wrong: entry.wrong, correct: entry.correct,
            reason: 'context_allowed', span, deniedBy: allowed,
          });
          continue;
        }
        const hit = findDeniedContext(foldedText, span, entry.contextDeny, window);
        if (hit) {
          denied.push({
            entryRef: entry.id, wrong: entry.wrong, correct: entry.correct,
            reason: 'context_denied', span, deniedBy: hit,
          });
          continue;
        }
      }
      raw.push({ entry, span });
    }
  }

  // 重叠消解：长 span 优先 → freq 高优先 → 靠前优先。
  raw.sort((a, b) => {
    const lenDiff = (b.span.end - b.span.start) - (a.span.end - a.span.start);
    if (lenDiff !== 0) return lenDiff;
    if (b.entry.freq !== a.entry.freq) return b.entry.freq - a.entry.freq;
    return a.span.start - b.span.start;
  });

  const accepted: RawMatch[] = [];
  for (const m of raw) {
    const overlap = accepted.find((a) => m.span.start < a.span.end && m.span.end > a.span.start);
    if (overlap) {
      denied.push({
        entryRef: m.entry.id, wrong: m.entry.wrong, correct: m.entry.correct,
        reason: 'overlapping_span', span: m.span,
      });
      continue;
    }
    accepted.push(m);
  }

  accepted.sort((a, b) => a.span.start - b.span.start);
  // 上限从 500 提到 2000：装上口癖规则包后，一份 1 小时的稿子轻松过千条候选，
  // 原上限会把排在后面的口癖整类截掉（表现为"啊/呃/嗯 只清掉一半"）。
  const limit = options.maxCandidates ?? 2000;
  // 【specs/013 T007】字面候选构造点必填依据：refs[0] = 词表来源（命中词条身份）。
  // channel/disposition 不填（缺省 exact/suggest，存量行为与既有断言不变）。
  const candidates: CorrectionCandidate[] = withBasisRefsGuard(accepted.slice(0, limit).map((m) => ({
    entryRef: m.entry.id,
    wrong: m.entry.wrong,
    correct: m.entry.correct,
    action: m.entry.action,
    confidence: 1,
    riskLevel: m.entry.riskLevel,
    context: contextAround(text, m.span, 40),
    span: m.span,
    ignoredCount: m.entry.ignoredCount ?? 0,
    contextAllow: m.entry.contextAllow ?? [],
    refs: [{ source: 'glossary', entryId: m.entry.id, kind: m.entry.kind, freq: m.entry.freq }],
  })));

  return {
    candidates,
    denied,
    stats: {
      entriesScanned,
      candidates: candidates.length,
      denied: denied.length,
      // 被上限截断 = 候选数打满上限，此时界面必须提示"还有更多没显示"
      truncated: candidates.length >= limit,
    },
  };
}

/** 边界判定：`substring` 只要求不是更长词的一部分（由重叠消解兜底）；
 *  `word` 要求左右邻不是字母/数字/CJK。 */
/**
 * 边界判定（导出供 `transcript_recall` 复用——模糊召回与精确扫描必须用
 * 同一套边界语义，否则同一条词条在两个通道里得到相反结论）。
 */
export function boundaryOk(text: string, span: Span, boundary: GlossaryEntry['boundary']): boolean {
  const before = span.start > 0 ? text[span.start - 1] : undefined;
  const after = span.end < text.length ? text[span.end] : undefined;
  if (boundary === 'word') return !isCjkOrWordChar(before) && !isCjkOrWordChar(after);
  // 子串模式仍需挡住"错词是更长 ASCII 单词的一部分"：`coxy` 不得命中 `coxyx`。
  // 中文没有词间空格，CJK 相邻是正常的，因此只拒绝 ASCII 字母/数字紧贴。
  const nextAscii = !!after && /[0-9A-Za-z]/.test(after);
  const prevAscii = !!before && /[0-9A-Za-z]/.test(before);
  return !nextAscii && !prevAscii;
}

/** 语境窗口匹配（导出供 `transcript_recall` 复用，理由同 `boundaryOk`）。 */
export function findDeniedContext(
  foldedText: string,
  span: Span,
  denyList: string[],
  window: number,
): string | null {
  if (!denyList.length) return null;
  const start = Math.max(0, span.start - window);
  const end = Math.min(foldedText.length, span.end + window);
  const hay = foldedText.slice(start, end);
  for (const deny of denyList) {
    const needle = foldText(deny).trim();
    if (needle && hay.includes(needle)) return deny;
  }
  return null;
}

function contextAround(text: string, span: Span, radius: number): string {
  const start = Math.max(0, span.start - radius);
  const end = Math.min(text.length, span.end + radius);
  return text.slice(start, end);
}

// ── 替换 ────────────────────────────────────────────────────────────────

export function applyCorrections(
  text: string,
  candidates: CorrectionCandidate[],
  options: ApplyOptions = {},
): ApplyResult {
  const acceptedIds = options.acceptedIds;
  const levels = options.acceptRiskLevels ?? ['low', 'medium'];
  const chosen = candidates
    .filter((c) => (acceptedIds ? acceptedIds.includes(c.entryRef) : levels.includes(c.riskLevel)))
    .sort((a, b) => a.span.start - b.span.start);

  const edits: AcceptedEdit[] = chosen.map((c) => ({
    entryRef: c.entryRef, wrong: c.wrong, correct: c.correct, action: c.action, span: c.span,
    structure: c.structure === true,
  }));

  const offsetMap: OffsetSegment[] = [];
  let out = '';
  let cursor = 0;
  const perEntry = new Map<string, AppliedSummary>();
  const deletedFillers: Record<string, number> = {};

  for (const edit of edits) {
    if (edit.span.start < cursor) continue; // 已被前一段吃掉（理论上扫描器已消解）
    if (edit.span.start > cursor) {
      const chunk = text.slice(cursor, edit.span.start);
      offsetMap.push({ inStart: cursor, inEnd: edit.span.start, outStart: out.length, outEnd: out.length + chunk.length, kind: 'keep' });
      out += chunk;
    }
    if (edit.action === 'delete') {
      // 删除时顺手吞掉紧随其后的一个空格，避免留下双空格（不影响重建校验，
      // 因为该空格也被记录为 delete 段）。
      let end = edit.span.end;
      if (text[end] === ' ' || text[end] === '\t') {
        offsetMap.push({ inStart: edit.span.start, inEnd: end + 1, outStart: out.length, outEnd: out.length, kind: 'delete' });
        cursor = end + 1;
      } else {
        offsetMap.push({ inStart: edit.span.start, inEnd: end, outStart: out.length, outEnd: out.length, kind: 'delete' });
        cursor = end;
      }
      // 只有口癖类删除才计入"删了什么词"；结构性删除（合并块头）单独可查。
      if (!edit.structure) deletedFillers[edit.wrong] = (deletedFillers[edit.wrong] ?? 0) + 1;
    } else {
      offsetMap.push({
        inStart: edit.span.start, inEnd: edit.span.end,
        outStart: out.length, outEnd: out.length + edit.correct.length, kind: 'replace',
      });
      out += edit.correct;
      cursor = edit.span.end;
    }
    const summary = perEntry.get(edit.entryRef)
      ?? { entryRef: edit.entryRef, wrong: edit.wrong, correct: edit.correct, action: edit.action, count: 0, spans: [] };
    summary.count += 1;
    summary.spans.push(edit.span);
    perEntry.set(edit.entryRef, summary);
  }
  if (cursor < text.length) {
    const chunk = text.slice(cursor);
    offsetMap.push({ inStart: cursor, inEnd: text.length, outStart: out.length, outEnd: out.length + chunk.length, kind: 'keep' });
    out += chunk;
  }

  if (!verifyEditsRebuild(text, out, offsetMap)) {
    // 结构性不变量被破坏（编辑集与输出不一致）→ 宁可失败，也不产出无法追溯的文本。
    throw new Error('transcript auto correct: edit reconstruction check failed');
  }

  const pendingTotal = candidates.filter((c) => !chosen.includes(c)).length;
  const charsIn = text.length;
  const charsOut = out.length;
  const retention = charsIn > 0 ? charsOut / charsIn : 1;
  return {
    text: out,
    offsetMap,
    applied: [...perEntry.values()],
    deletedFillers,
    charsIn,
    charsOut,
    retention,
    overRewriteSuspected: retention < OVER_REWRITE_THRESHOLD,
    pendingTotal,
    status: pendingTotal > 0 ? 'draft' : 'applied',
  };
}

/**
 * 结构性不变量：输出 == 原文按 offsetMap 的 keep/replace/delete 段重建的结果。
 * 有了它，"模型补写原文没有的话"在类型上不可能发生（补写会破坏重建等式）。
 */
export function verifyEditsRebuild(original: string, output: string, offsetMap: OffsetSegment[]): boolean {
  let rebuilt = '';
  let cursor = 0;
  for (const seg of offsetMap) {
    if (seg.inStart !== cursor) return false;
    if (seg.kind === 'keep') {
      rebuilt += original.slice(seg.inStart, seg.inEnd);
      if (seg.outEnd - seg.outStart !== seg.inEnd - seg.inStart) return false;
    } else if (seg.kind === 'replace') {
      rebuilt += output.slice(seg.outStart, seg.outEnd);
    } else if (seg.outStart !== seg.outEnd) {
      return false;
    }
    cursor = seg.inEnd;
  }
  if (cursor !== original.length) return false;
  return rebuilt === output;
}

/** 把原文中的偏移映射到清理版（供时间戳/语录锚点重算）。 */
export function mapOffset(offsetMap: OffsetSegment[], inputOffset: number): number | null {
  for (const seg of offsetMap) {
    if (inputOffset >= seg.inStart && inputOffset <= seg.inEnd) {
      const delta = inputOffset - seg.inStart;
      if (seg.kind === 'delete') return seg.outStart;
      const width = seg.inEnd - seg.inStart;
      const outWidth = seg.outEnd - seg.outStart;
      if (width === 0) return seg.outStart;
      const scaled = Math.round((delta / width) * outWidth);
      return seg.outStart + Math.min(scaled, outWidth);
    }
  }
  return null;
}

// ── 疑似专名探测（模型复核的重点线索）────────────────────────────────────
//
// `detectSuspectEntities`：**保守**地找出"疑似专名但词表/本体分组都没有"的拉丁串。
// 保守的含义是"宁漏勿噪"——只认长度 ≥4 且（含内部大写 或 全大写）的串：
// `KSTAR`/`NoteBookLM` 会被认出，`Hello`/`OK`/`API` 不会。
//
// 注意它**不再是"要不要问模型"的闸门**：词形判据对中文稿几乎必然 0 命中
// （`roadmap`/`SpeakerA` 都过不了），拿它当准入条件会让模型永远收不到问题。
// 现在它只作为"重点线索"提示给模型，真正的语义判断由模型读正文完成
// （见 transcript_llm_candidates）。待核/【转写存疑】那套可见标记已随之移除。

export interface SuspectEntity {
  span: Span;
  text: string;
  reason: 'unknown_entity';
}

/** 疑似专名的词形判据：含内部大写的拉丁串，或 4 个字母以上的全大写串。 */
const SUSPECT_RE = /[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]+)+|[A-Z]{4,}/g;

/**
 * 找"疑似专名"。`known` = 词表（wrong/correct）与本体分组里的规范名，
 * 折叠后比对：已知的词不会进待核（它不是"未知实体"）。
 */
export function detectSuspectEntities(
  text: string,
  known: Iterable<string>,
  limit = 200,
): SuspectEntity[] {
  const out: SuspectEntity[] = [];
  const foldedKnown = new Set<string>();
  for (const item of known) {
    const folded = foldText(String(item ?? '')).trim();
    if (folded) foldedKnown.add(folded);
  }
  const protectedRanges = computeProtectedRanges(text);
  const seen = new Set<string>();
  for (const match of text.matchAll(SUSPECT_RE)) {
    const raw = match[0];
    if (match.index === undefined) continue;
    // 长度闸门：`API`/`PPT` 这类 3 字母缩写常见到没有信息量，进了只会制造噪声
    if (raw.length < 4) continue;
    const span: Span = { start: match.index, end: match.index + raw.length };
    const folded = foldText(raw).trim();
    if (!folded || foldedKnown.has(folded)) continue;
    if (isProtected(protectedRanges, span)) continue;
    const dedupeKey = `${folded}|${span.start}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ span, text: raw, reason: 'unknown_entity' });
    if (out.length >= limit) break;
  }
  return out;
}
