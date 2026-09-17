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
  | 'protected_region';

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

function isProtected(ranges: Span[], span: Span): boolean {
  return ranges.some((r) => span.start < r.end && span.end > r.start);
}

// ── 扫描 ────────────────────────────────────────────────────────────────

interface RawMatch {
  entry: GlossaryEntry;
  span: Span;
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
  const candidates: CorrectionCandidate[] = accepted.slice(0, limit).map((m) => ({
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
  }));

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

// ── 未决项（待核）：疑似专名探测 + 可见标记 ───────────────────────────────
//
// 方案 §4.3 要求：无法确定该不该纠的地方**不猜**，而是标出来给人看
// （`OpenIssue` + `【转写存疑】` 写回清理版）。这里只做两件纯文本事：
//   1. `detectSuspectEntities`：**保守**地找出"疑似专名但词表/记忆分组都没有"的
//      拉丁串。保守的含义是"宁漏勿噪"——只认长度 ≥4 且（含内部大写 或 全大写）
//      的串：`KSTAR`/`NoteBookLM` 会被认出，`Hello`/`OK`/`API` 不会。
//      真正的语义级"未知实体"（`roadmap` 可能指 SpeakerA）留给 P2 的 LLM 候选，
//      本引擎不假装能做。
//   2. `insertIssueMarkers`：把标记插进清理版，并返回插入后的新 span
//      （从后往前插，避免前面的插入让后面的偏移失效）。

/** 写回清理版的可见标记（方案 §4.3 固定文案）。 */
export const ISSUE_MARKER = '【转写存疑】';

export interface SuspectEntity {
  span: Span;
  text: string;
  reason: 'unknown_entity';
}

/** 疑似专名的词形判据：含内部大写的拉丁串，或 4 个字母以上的全大写串。 */
const SUSPECT_RE = /[A-Za-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]+)+|[A-Z]{4,}/g;

/**
 * 找"疑似专名"。`known` = 词表（wrong/correct）与记忆分组里的规范名，
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

/**
 * 把 `ISSUE_MARKER` 插到每个 span 之前（同一位置只插一次），返回新文本与**插入后**
 * 的 span（含标记本身）。从后往前插入，保证前面的偏移不受影响。
 */
export function insertIssueMarkers(
  text: string,
  spans: Span[],
): { text: string; spans: Span[]; byStart: Map<number, Span> } {
  const starts = [...new Set(
    (spans ?? [])
      .map((s) => Math.max(0, Math.min(Number(s?.start) || 0, text.length)))
      .filter((n) => Number.isFinite(n)),
  )].sort((a, b) => a - b);
  if (starts.length === 0) return { text, spans: [], byStart: new Map() };

  const markerLen = ISSUE_MARKER.length;
  let out = text;
  const shifted: Span[] = [];
  // 从后往前：插入点之后的旧内容整体后移，而更靠前的插入点不受已插入内容影响。
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i];
    out = out.slice(0, start) + ISSUE_MARKER + out.slice(start);
  }
  // 第 i 个标记前面还插了 i 个标记（0..i-1），所以它的最终起点是 p_i + i*markerLen。
  const byStart = new Map<number, Span>();
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] + markerLen * i;
    const span = { start, end: start + markerLen };
    shifted.push(span);
    byStart.set(starts[i], span);
  }
  return { text: out, spans: shifted, byStart };
}
