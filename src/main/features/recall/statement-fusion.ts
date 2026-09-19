/**
 * statement-fusion.ts — 融合生成器（2026-09-19 合并实施·查重金字塔 L1/L2 的落点）。
 *
 * 职责：update 路径的正文不再是"新内容直接覆盖旧正文"，而是新旧**合成**：
 * 旧正文是主体，新内容按句级三档融入——
 *   重述（Dice ≥ RESTATED）：同一句话换个说法 → 保留信息更多的那条（更长者）；
 *   改写（REWRITE ≤ Dice < RESTATED）：同一主题、说法更新（含"改为/不再"类更新）→ 新句替换旧句；
 *   增量（Dice < REWRITE）：旧正文没有的新信息 → 追加到尾部。
 *
 * 纯函数、无 IO、不做 embedding（整体语义相关已由查重层保证；句级用字符
 * bigram 的 Dice 系数近似，保证可单测、离线可跑）。融合结果走 updateAbilityAsset
 * 的版本快照（reason=semantic-fusion），旧版始终可切回——融合错了可回退。
 */

const FUSION_STATEMENT_LIMIT = 4_000;
/** 重述（扩展式）：新句的 bigram 过半出现在旧句里、且新句长得多（信息更多）
 *  → 保留更长者。短句对长扩展句的 Dice 会被长度差稀释，重述判定必须用
 *  重叠系数（|A∩B|/min）而不是 Dice。 */
const RESTATED_OVERLAP = 0.50;
const RESTATED_LENGTH_RATIO = 1.8;
/** 近乎完全重合的等长重述也按"保留更长"处理。 */
const RESTATED_NEAR_TOTAL = 0.75;
/** 同一主题的改写（新说法替换旧说法，含"改为/不再"类更新）。 */
const REWRITE_OVERLAP = 0.45;

export interface StatementFusionResult {
  /** 融合后的正文（≤ 4000 字，超长截断）。 */
  statement: string;
  /** 旧正文没有、追加进来的新句。 */
  added: string[];
  /** 替换旧句的新句（同一主题更新说法），成对给出被替换的旧句。 */
  replaced: Array<{ oldSentence: string; newSentence: string }>;
  /** 旧正文保留下来的句子数（含被更长重述顶掉原文位置不变情形）。 */
  keptCount: number;
  /** statement 是否被 4000 字上限截断。 */
  truncated: boolean;
}

function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }
  return grams;
}

/** 字符 bigram Dice 系数：2|A∩B| / (|A|+|B|)。空串对返回 0。 */
export function diceOverlap(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) shared += 1;
  }
  return (2 * shared) / (a.size + b.size);
}

/** 重叠系数：|A∩B| / min(|A|,|B|)——不被长度差稀释，用于句级"同一句话"判定。 */
export function overlapCoefficient(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) shared += 1;
  }
  return shared / Math.min(a.size, b.size);
}

function splitSentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** 展示标题：取首个完整句子（含句读），超长才截断并加省略号——禁止"正文
 *  前 N 字裸截断"的残片模式（实测过 22 字半句标题）。 */
export function makeDisplayTitle(statement: string, max = 60): string {
  const sentences = splitSentences(statement);
  const first = sentences[0] || String(statement || '').trim();
  if (!first) return '';
  if (first.length <= max) return first;
  return `${first.slice(0, max - 1)}…`;
}

/** 融合：旧正文为主体，新内容按句级三档融入。旧正文为空时直接采用新内容。 */
export function fuseStatements(oldStatement: string, incoming: string): StatementFusionResult {
  const oldSentences = splitSentences(oldStatement);
  const newSentences = splitSentences(incoming);
  const added: string[] = [];
  const replaced: Array<{ oldSentence: string; newSentence: string }> = [];

  if (oldSentences.length === 0) {
    const statement = String(incoming || '').trim().slice(0, FUSION_STATEMENT_LIMIT);
    const kept: string[] = statement ? [statement] : [];
    return {
      statement,
      added: kept,
      replaced: [],
      keptCount: 0,
      truncated: (incoming || '').trim().length > FUSION_STATEMENT_LIMIT,
    };
  }
  if (newSentences.length === 0) {
    return { statement: oldStatement, added: [], replaced: [], keptCount: oldSentences.length, truncated: false };
  }

  const working = [...oldSentences];
  for (const sentence of newSentences) {
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let i = 0; i < working.length; i += 1) {
      const overlap = overlapCoefficient(sentence, working[i]);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) {
      // 与所有旧句零重叠：纯增量。
      added.push(sentence);
      working.push(sentence);
      continue;
    }
    const lengthRatio = sentence.length / working[bestIndex].length;
    if ((bestOverlap >= RESTATED_OVERLAP && lengthRatio >= RESTATED_LENGTH_RATIO)
      || bestOverlap >= RESTATED_NEAR_TOTAL) {
      // 重述：保留信息更多的一条（更长者胜，位置不动）。
      if (sentence.length > working[bestIndex].length) working[bestIndex] = sentence;
    } else if (bestOverlap >= REWRITE_OVERLAP) {
      // 同一主题的更新说法：新替旧，位置保持。
      replaced.push({ oldSentence: working[bestIndex], newSentence: sentence });
      working[bestIndex] = sentence;
    } else {
      // 增量：旧正文没有的新信息，追加到尾部。
      added.push(sentence);
      working.push(sentence);
    }
  }

  const joined = working.join('');
  return {
    statement: joined.slice(0, FUSION_STATEMENT_LIMIT),
    added,
    replaced,
    keptCount: working.length - added.length,
    truncated: joined.length > FUSION_STATEMENT_LIMIT,
  };
}
