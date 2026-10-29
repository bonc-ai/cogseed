/**
 * transcript_recall — 转写纠错的多路召回层（纯函数，不碰文件系统）。
 *
 * 将未知词形匹配到已确认词条，只提出候选，不自动替换或补写内容。
 * 归一化通道比较大小写和分隔符；模糊通道使用编辑距离与 ASCII 音形骨架。
 * confidence 上限为 0.99，只有域内、非陷阱词、低风险且达到强相似阈值的候选
 * 可以标为 suggest；其他候选只能 review，仍需人工确认。
 *
 * 边界、语境黑白名单、保护区域与作用域复用精确扫描的实现。
 * 字面和音形都不接近的错形不能靠降低阈值可靠解决，残余形态须如实报告。
 * 中文音近可通过 extraPhonetic 注入字符映射；未注入时保留中文字符，不能退化为空串。
 */

import {
  type GlossaryEntry,
  type GlossaryKind,
  type RiskLevel,
  foldText,
  scopeAllows,
} from './transcript_glossary';
import {
  boundaryOk,
  computeProtectedRanges,
  findDeniedContext,
  type ScanTarget,
  type Span,
} from './transcript_auto_correct';

/** 模糊通道阈值：≥ 此值才可能升级为 `suggest`。对齐 asr-hotword 的 0.85 经验值并略放宽。 */
export const DEFAULT_MIN_SIMILARITY = 0.82;
/** 弱通道阈值：≥ 此值只出 `review`（绝不 suggest）。实测 0.65 是兜住 k42/COS 的最低档。 */
export const DEFAULT_WEAK_SIMILARITY = 0.65;
/** 相似度上限：**结构性**保证模糊候选永不等于"精确命中"。 */
export const MAX_RECALL_CONFIDENCE = 0.99;
/** 语境黑白名单窗口，与 `DEFAULT_CONTEXT_WINDOW` 保持一致。 */
export const DEFAULT_RECALL_CONTEXT_WINDOW = 20;
/** `suggest` 的最低相似度（弱通道永远达不到）。 */
/**
 * `suggest` 的最低相似度。取与 `DEFAULT_MIN_SIMILARITY` 同值是有意的：
 * **只有够到"强模糊"档（如 `cogsed`→`Cogseed` 0.857）才有资格被建议**；
 * 弱通道（`k42` 0.667、`coxy` 0.667）永远只能是 `review`。
 */
export const SUGGEST_MIN_SIMILARITY = DEFAULT_MIN_SIMILARITY;
/** 允许窗口跨越的最大 token 数（`K star` / `code seat` / `open cloud` 各 2 个）。 */
const MAX_WINDOW_TOKENS = 3;
/** 长度守卫：归一化串长度差超过此值不做模糊比较（长度差是错形的强下界）。 */
const MAX_KEY_LENGTH_DELTA = 2;
/**
 * 多词形态的**逐词下限**：多词长串做整串相似度会被"共同前缀"抬分
 * （`personal ontology` 与 `personal college` 整串 0.86，但逐词 `ontology`↔`college`
 * 只有 ~0.13）。因此对"词数相同且都 >1"的形态，额外要求**每个词**都够近。
 * 逐词下限示例：`ontology`↔`oncology` = 0.75（近似词形可放行）；
 * `code`↔`car` = 0.50（词数相同但首词差太远，挡掉）。
 * 注：词数**不同**时不适用本规则（`code seat` 与 `coseat`、`car seat` 可能是同一词条的变体，
 * 不能因为切词不同就否决）。
 */
const PER_WORD_FLOOR = 0.6;

/** ASCII 音形骨架：辅音归并 + 元音占位。 */
const PHONETIC_CONSONANTS: Record<string, string> = {
  c: 'k', k: 'k', q: 'k',
  s: 's', z: 's', x: 'ks',
  g: 'g', j: 'g',
  f: 'f', v: 'f', w: 'f',
  p: 'b', b: 'b',
  t: 'd', d: 'd',
  r: 'l', l: 'l',
  m: 'm', n: 'n',
  h: 'h',
};
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

export type RecallChannel = 'normalized' | 'phonetic' | 'edit' | 'weak';

export interface RecallOptions extends ScanTarget {
  /** 模糊通道阈值（0–1，越大越严）。 */
  minSimilarity?: number;
  /** 弱通道阈值：只出 `review`。设 `1` 可整体关闭弱通道。 */
  weakSimilarity?: number;
  contextWindow?: number;
  maxCandidates?: number;
  /** 只召回这些 kind（例如只做 `people` + `product`）。缺省 = 全部。 */
  kinds?: GlossaryKind[];
  /** 不参与召回的词条 id（面板"忽略"过的条目可在此排除）。 */
  excludeEntryIds?: string[];
  /**
   * **域内概念**：当前文档/场景已知的概念规范名（来自本体、会议主题、课程标签）。
   * `correct` 命中者才有资格升级为 `suggest`；未命中者一律 `review`。
   * 域外的近似词形不能冒充当前任务的术语，即使相似度较高也须保留人工复核。
   */
  domainTerms?: string[];
  /**
   * 已知"合法词"守卫集：这些形态只出 `review`、永不给 `suggest`
   * （用于 `roadmap` / `for` / `case` 这类双义项陷阱）。
   */
  trapWords?: string[];
  /** 首字母约束（Soundex 式）。默认 true；置 false 会显著增加误召回。 */
  initialStrict?: boolean;
  /**
   * 额外音形映射：字符 → 音形键。**中文音近的唯一接入口**（零依赖下的拼音表挂点）。
   * 合成名称示例：`{ 例: 'li', 加: 'jia', 甲: 'jia' }`。缺省不启用（CJK 只走归一化/弱通道）。
   */
  extraPhonetic?: Record<string, string>;
}

export interface RecallCandidate {
  /** 命中的词条 id（语义同 `CorrectionCandidate.entryRef`）。 */
  entryRef: string;
  /** 文本里实际出现的形态（原样，未改写）。 */
  wrong: string;
  /** 命中词条的 `wrong` 形态（诊断用：`coseat` 命中的是词条 `code seat`）。 */
  matchedWrong: string;
  /** 词条已确认的规范写法。 */
  correct: string;
  channel: RecallChannel;
  /** 0–1，`normalized` 恒为 1。 */
  similarity: number;
  /** 恒 < 1（上限 `MAX_RECALL_CONFIDENCE`）：本层不得触发自动替换。 */
  confidence: number;
  riskLevel: RiskLevel;
  kind: GlossaryKind;
  span: Span;
  /** 前后各 `contextWindow` 字的上下文，供人工判读。 */
  context: string;
  /** 该概念是否落在本次的域内（`domainTerms` 命中）。 */
  inDomain: boolean;
  /** `suggest` = 可提为建议（仍须用户确认）；`review` = 必须逐条人工判断。 */
  disposition: 'suggest' | 'review';
}

export interface RecallStats {
  entriesScanned: number;
  tokensScanned: number;
  windowsScanned: number;
  candidates: number;
  truncated: boolean;
  byChannel: Record<RecallChannel, number>;
  /** 因护栏被拒的次数（按原因分桶，便于看"召回被谁挡住"）。 */
  denied: Record<string, number>;
  /**
   * **兜不住的部分**：文本里出现、但既不是任何词条的 `correct`、
   * 也没被任何通道召回的"可疑孤立形态"。这正是"必须入册或靠域先验"的清单来源。
   * 只给形态与出现次数，**不给建议映射**——本层不猜。
   */
  residual: Array<{ surface: string; count: number }>;
}

export interface RecallResult {
  candidates: RecallCandidate[];
  stats: RecallStats;
}

// ── 归一化与音形 ────────────────────────────────────────────────────────

const CJK_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK_RE = new RegExp(`[${CJK_CLASS}]`);

/** 抹掉一切非字母数字/非 CJK 字符：`K-STAR` / `K star` / `kstar` → `kstar`。 */
export function normalizeKey(text: string): string {
  return foldText(text).replace(new RegExp(`[^0-9a-z${CJK_CLASS}]`, 'g'), '');
}

/**
 * 音形骨架：ASCII 走"辅音归并（x→ks） + 元音→a + 连续重复压缩"；
 * 中文优先查 `extraPhonetic`（拼音挂点），查不到则**原样保留**（退化为字面比较，
 * 不会因为"两个都映射成空串"而假命中——空骨架在调用处被长度守卫拦掉）。
 */
export function phoneticKey(text: string, extraPhonetic?: Record<string, string>): string {
  const src = foldText(text);
  let out = '';
  for (const ch of src) {
    const mapped = extraPhonetic?.[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (ch >= '0' && ch <= '9') { out += ch; continue; }
    if (ch >= 'a' && ch <= 'z') {
      out += VOWELS.has(ch) ? 'a' : (PHONETIC_CONSONANTS[ch] ?? ch);
      continue;
    }
    if (CJK_RE.test(ch)) out += ch;
  }
  return squashRepeats(out);
}

/** 连续重复字符压缩：`Cogseed`→`kagsad` 而非 `kagsaad`。 */
function squashRepeats(s: string): string {
  let out = '';
  let prev = '';
  for (const ch of s) {
    if (ch !== prev) out += ch;
    prev = ch;
  }
  return out;
}

/** Levenshtein 距离（迭代式，仅需两行）。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = [];
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 − 归一化编辑距离。 */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - editDistance(a, b) / max;
}

/**
 * 多词形态的逐词否决：词数相同且都 >1 时，任一词离得太远即整体否决。
 * 返回 true = 通过（或本规则不适用）。
 */
function perWordOk(winWords: string[], entWords: string[]): boolean {
  if (winWords.length < 2 || winWords.length !== entWords.length) return true;
  for (let i = 0; i < winWords.length; i += 1) {
    const a = winWords[i];
    const b = entWords[i];
    if (!a || !b) return true;
    const sim = Math.max(similarity(a, b), similarity(phoneticKey(a), phoneticKey(b)));
    if (sim < PER_WORD_FLOOR) return false;
  }
  return true;
}

// ── 词表索引 ────────────────────────────────────────────────────────────

interface IndexedEntry {
  entry: GlossaryEntry;
  key: string;
  phonetic: string;
  /** 逐词归一化键（多词形态的逐词下限判定用）。 */
  words: string[];
  firstKey: string;
  firstPhonetic: string;
  boundary: GlossaryEntry['boundary'];
  contextDeny: string[];
  contextAllow: string[];
}

// 拉丁词整段成 token，CJK 逐字成 token，才能在连续中文句子中生成名称词条窗口。
const TOKEN_RE = new RegExp(`[0-9A-Za-z]+(?:[._\\-][0-9A-Za-z]+)*|[${CJK_CLASS}]`, 'g');
/** 窗口允许的 token 间分隔符（仅空白/点/连字符/间隔号；出现句读即视为跨句，不成窗）。 */
const GAP_RE = /^[ ._\-·]*$/;

/**
 * 包含关系守卫：候选 token **把错形整个装在里面**时，只有在"多出来的字符全是数字"时
 * 才算同一个词（例如 `K4` ← `k42`），否则视为另一个词而拒绝。
 * 依据：精确扫描靠 `boundaryOk` 挡住 `coxy` 命中 `coxyx`；模糊通道匹配的是整个 token，
 * 所以必须在这里补上同义守卫——否则 `coxyx`→`coxy`（0.80）、`kstar与`→`kstar`（0.83）
 * 都会被当成候选。
 */
function containsOtherWord(tokenKey: string, entryKey: string): boolean {
  if (tokenKey === entryKey || !entryKey) return false;
  const at = tokenKey.indexOf(entryKey);
  if (at < 0) return false;
  const extra = tokenKey.slice(0, at) + tokenKey.slice(at + entryKey.length);
  return /[a-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(extra);
}

interface Token { start: number; end: number; latin: boolean }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m.index === undefined) continue;
    out.push({ start: m.index, end: m.index + m[0].length, latin: /^[0-9A-Za-z]/.test(m[0]) });
  }
  return out;
}

function countTokens(text: string): number {
  const m = text.match(TOKEN_RE);
  return m ? m.length : 0;
}

// ── 主入口 ──────────────────────────────────────────────────────────────

/** 多路召回。**纯函数**：给定文本 + 词表 + 域信息，返回候选（不替换、不落盘）。 */
export function recallCandidates(
  text: string,
  entries: GlossaryEntry[],
  options: RecallOptions = {},
): RecallResult {
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const weakSimilarity = options.weakSimilarity ?? DEFAULT_WEAK_SIMILARITY;
  const window = options.contextWindow ?? DEFAULT_RECALL_CONTEXT_WINDOW;
  const initialStrict = options.initialStrict !== false;
  const denied: Record<string, number> = {};
  const noteDenied = (reason: string) => { denied[reason] = (denied[reason] ?? 0) + 1; };

  const excluded = new Set(options.excludeEntryIds ?? []);
  const kindFilter = options.kinds ? new Set(options.kinds) : null;
  const trapKeys = new Set((options.trapWords ?? []).map(normalizeKey));
  const domainKeys = new Set((options.domainTerms ?? []).map(normalizeKey));

  // 1) 建索引（跳过暂停/删除/被排除/不在 kind 范围的词条）
  const index: IndexedEntry[] = [];
  const correctKeys = new Set<string>();
  let entriesScanned = 0;
  let maxTokens = 1;
  for (const entry of entries) {
    entriesScanned += 1;
    correctKeys.add(normalizeKey(entry.correct));
    if (entry.status === 'paused') continue;
    if (entry.action !== 'replace') continue;
    if (excluded.has(entry.id)) continue;
    if (kindFilter && !kindFilter.has(entry.kind)) continue;
    const key = normalizeKey(entry.wrong);
    if (!key) continue;
    const phonetic = phoneticKey(entry.wrong, options.extraPhonetic);
    maxTokens = Math.min(MAX_WINDOW_TOKENS, Math.max(maxTokens, Math.max(1, countTokens(entry.wrong))));
    index.push({
      entry, key, phonetic,
      words: (entry.wrong.match(/[0-9A-Za-z]+/g) ?? []).map((w) => normalizeKey(w)),
      firstKey: key[0] ?? '',
      firstPhonetic: phonetic[0] ?? '',
      boundary: entry.boundary,
      contextDeny: entry.contextDeny ?? [],
      contextAllow: entry.contextAllow ?? [],
    });
  }

  // 精确归一化通道用 Map 直查；模糊通道按 key 长度分桶 + 首字符过滤，避免 O(窗口×词条)
  const byKey = new Map<string, IndexedEntry[]>();
  const byKeyLength = new Map<number, IndexedEntry[]>();
  for (const ie of index) {
    const b = byKey.get(ie.key);
    if (b) b.push(ie); else byKey.set(ie.key, [ie]);
    const lb = byKeyLength.get(ie.key.length);
    if (lb) lb.push(ie); else byKeyLength.set(ie.key.length, [ie]);
  }

  const protectedRanges = computeProtectedRanges(text);
  const foldedText = foldText(text);
  const raw: RecallCandidate[] = [];
  const tokens = tokenize(text);
  const orphanCounts = new Map<string, number>();
  let windowsScanned = 0;

  // 2) 生成 token 窗口（1..maxTokens 个连续 token，中间只允许轻分隔符）
  for (let i = 0; i < tokens.length; i += 1) {
    for (let n = 1; n <= maxTokens && i + n <= tokens.length; n += 1) {
      const first = tokens[i];
      const last = tokens[i + n - 1];
      let gapOk = true;
      for (let k = i; k < i + n - 1; k += 1) {
        if (!GAP_RE.test(text.slice(tokens[k].end, tokens[k + 1].start))) { gapOk = false; break; }
      }
      if (!gapOk) break; // 更长的窗口只会更不合法

      const span: Span = { start: first.start, end: last.end };
      const surface = text.slice(span.start, span.end);
      const key = normalizeKey(surface);
      if (key.length < 2 && n === 1) {
        noteDenied('too_short');
        continue;
      }
      if (protectedRanges.some((r) => span.start < r.end && span.end > r.start)) {
        noteDenied('protected_region');
        continue;
      }
      windowsScanned += 1;

      const windowWords = surface.match(/[0-9A-Za-z]+/g)?.map((w) => normalizeKey(w)) ?? [];
      const ctx = { window, options, domainKeys, trapKeys, foldedText, protectedRanges };
      const candidates: RecallCandidate[] = [];

      // 2a) 归一化通道（完全相等）
      for (const ie of byKey.get(key) ?? []) {
        const c = build(ie, surface, span, 'normalized', 1, text, ctx, noteDenied);
        if (c) candidates.push(c);
      }

      // 2b) 模糊通道（长度桶 ± delta + 首字符约束）
      //
      // 只对**单一脚本**窗口跑模糊：混合窗口（`personaloncology啊` / `cookie吗` /
      // `moodle了`）是"拉丁词 + 相邻汉字"的拼接产物，音形比较没有意义，
      // 会产生无意义的跨脚本候选。混合形态仍可走归一化通道。
      const scriptMixed = n > 1
        && tokens.slice(i, i + n).some((t) => t.latin)
        && tokens.slice(i, i + n).some((t) => !t.latin);
      if (!candidates.length && !scriptMixed) {
        const skel = phoneticKey(surface, options.extraPhonetic);
        const firstSkel = skel[0] ?? '';
        const seen = new Set<string>();
        for (let len = key.length - MAX_KEY_LENGTH_DELTA; len <= key.length + MAX_KEY_LENGTH_DELTA; len += 1) {
          for (const ie of byKeyLength.get(len) ?? []) {
            if (seen.has(ie.entry.id)) continue;
            seen.add(ie.entry.id);
            if (initialStrict && ie.firstKey !== key[0] && ie.firstPhonetic !== firstSkel) continue;
            if (containsOtherWord(key, ie.key)) { noteDenied('contains_other_word'); continue; }
            if (!perWordOk(windowWords, ie.words)) { noteDenied('per_word_floor'); continue; }
            let channel: RecallChannel = 'edit';
            let sim = similarity(key, ie.key);
            if (skel.length > 1 && ie.phonetic.length > 1) {
              const skelSim = similarity(skel, ie.phonetic);
              if (skelSim > sim) { channel = 'phonetic'; sim = skelSim; }
            }
            if (sim < weakSimilarity) continue;
            // ≥ minSimilarity 走"可 suggest"通道；否则降为 weak（只 review）
            if (sim < minSimilarity) channel = 'weak';
            const c = build(ie, surface, span, channel, sim, text, ctx, noteDenied);
            if (c) candidates.push(c);
          }
        }
      }

      if (candidates.length) {
        for (const c of candidates) raw.push(c);
      } else if (n === 1 && !correctKeys.has(key)) {
        orphanCounts.set(surface, (orphanCounts.get(surface) ?? 0) + 1);
      }
    }
  }

  // 3) 重叠消解：长 span 优先 → 高相似度 → 通道优先级 → entryRef 稳定排序
  const channelRank: Record<RecallChannel, number> = { normalized: 0, phonetic: 1, edit: 2, weak: 3 };
  // 顺序很重要：**通道优先级第一**（精确/归一化命中必须压过长 span 的模糊命中，
  // 否则 `K-STAR` 会被更长的 `K-STAR 与` 抢走 span），
  // 再按 span 长优先（`K star` 压 `star`）、相似度高优先、entryRef 稳定排序。
  raw.sort((a, b) => {
    if (channelRank[a.channel] !== channelRank[b.channel]) return channelRank[a.channel] - channelRank[b.channel];
    const la = a.span.end - a.span.start;
    const lb = b.span.end - b.span.start;
    if (la !== lb) return lb - la;
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    return a.entryRef.localeCompare(b.entryRef);
  });
  const accepted: RecallCandidate[] = [];
  const taken: Span[] = [];
  const maxCandidates = options.maxCandidates ?? Number.POSITIVE_INFINITY;
  let truncated = false;
  for (const c of raw) {
    if (taken.some((s) => c.span.start < s.end && c.span.end > s.start)) {
      noteDenied('overlapping_span');
      continue;
    }
    if (accepted.length >= maxCandidates) { truncated = true; continue; }
    taken.push(c.span);
    accepted.push(c);
  }
  accepted.sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);

  const byChannel: Record<RecallChannel, number> = { normalized: 0, phonetic: 0, edit: 0, weak: 0 };
  for (const c of accepted) byChannel[c.channel] += 1;

  // 4) 残余清单：只保留 2 字以上、且不是任何 correct 形态的可疑孤立形态。
  //    这是"必须入册 / 靠域先验"的行动清单；本层只报告，不给建议映射。
  //   过滤：① 任何词条的 correct 形态；② 纯数字/日期/时间戳类；③ 过短的拉丁串。
  //   时间戳和说话人不属于需要补充映射的术语。
  const residual = [...orphanCounts.entries()]
    .filter(([surface]) => {
      const key = normalizeKey(surface);
      if (key.length < 2 || correctKeys.has(key)) return false;
      if (/^[0-9]+$/.test(key)) return false;
      if (/^[0-9a-z]+$/.test(key) && !/[a-z]/.test(key)) return false;
      if (/^[0-9a-z]+$/.test(key) && /^[a-z]/.test(key) && key.length < 3) return false;
      return true;
    })
    .map(([surface, count]) => ({ surface, count }))
    .sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface));

  return {
    candidates: accepted,
    stats: {
      entriesScanned, tokensScanned: tokens.length, windowsScanned,
      candidates: accepted.length, truncated, byChannel, denied, residual,
    },
  };
}

/** 护栏上下文（打包传递，避免逐个参数）。 */
interface BuildContext {
  window: number;
  options: RecallOptions;
  domainKeys: Set<string>;
  trapKeys: Set<string>;
  foldedText: string;
  protectedRanges: Span[];
}

/**
 * 单条候选的构建 + 全部护栏判定。
 * 被任一护栏拒绝时返回 `null`（**不返回 confidence=0 的占位候选**——
 * 否则重叠消解会把它们当有效候选参与排序，语义混乱）。
 */
function build(
  ie: IndexedEntry,
  surface: string,
  span: Span,
  channel: RecallChannel,
  sim: number,
  text: string,
  ctx: BuildContext,
  noteDenied: (reason: string) => void,
): RecallCandidate | null {
  const entry = ie.entry;

  // 护栏 1：作用域
  if (!scopeAllows(entry.scope, { docId: ctx.options.docId, scenarioTags: ctx.options.scenarioTags })) {
    noteDenied('out_of_scope');
    return null;
  }
  // 护栏 2：边界（与 scanText 同一实现）
  if (!boundaryOk(text, span, ie.boundary)) {
    noteDenied('word_boundary');
    return null;
  }
  // 护栏 3：语境加白（静默）优先于黑名单
  if (findDeniedContext(ctx.foldedText, span, ie.contextAllow, ctx.window)) {
    noteDenied('context_allowed');
    return null;
  }
  if (findDeniedContext(ctx.foldedText, span, ie.contextDeny, ctx.window)) {
    noteDenied('context_denied');
    return null;
  }
  // 护栏 4：保护区域（scanText 已在窗口生成处挡过，这里做冗余断言）
  if (ctx.protectedRanges.some((r) => span.start < r.end && span.end > r.start)) {
    noteDenied('protected_region');
    return null;
  }

  // 逐字符已是规范写法 → 纯 no-op，不产出候选。
  // 注意判据必须是**精确相等（含大小写）**，不能用归一化键：`K-STAR` 与 `KSTAR`
  // 归一化后相等，但前者是需要纠正的写法；`openclaw` 与 `OpenClaw` 差大小写，
  // 那是**有效的写法归一**（人工清理版就做了这一步），不该被挡掉。
  if (surface === entry.correct
    || (entry.correct.startsWith(surface) && text.slice(span.start, span.start + entry.correct.length) === entry.correct)) {
    noteDenied('already_correct');
    return null;
  }

  const inDomain = ctx.domainKeys.has(normalizeKey(entry.correct));
  const isTrap = ctx.trapKeys.has(normalizeKey(surface));
  const disposition: RecallCandidate['disposition'] =
    !isTrap
    && channel !== 'weak'
    && inDomain
    && entry.riskLevel === 'low'
    && sim >= SUGGEST_MIN_SIMILARITY
      ? 'suggest'
      : 'review';

  const confidence = Math.min(MAX_RECALL_CONFIDENCE, sim * (channel === 'normalized' ? 1 : 0.95));

  return {
    entryRef: entry.id,
    wrong: surface,
    matchedWrong: entry.wrong,
    correct: entry.correct,
    channel,
    similarity: sim,
    confidence,
    riskLevel: entry.riskLevel,
    kind: entry.kind,
    span,
    context: text.slice(Math.max(0, span.start - ctx.window), Math.min(text.length, span.end + ctx.window)),
    inDomain,
    disposition,
  };
}
