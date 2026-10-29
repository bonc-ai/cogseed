/**
 * transcript_filler_rules — 口癖与填充词规则包
 *
 * 删除策略保持保守：
 *   - 白名单类（`嗯/呃/啊/哦/这个/那个/的话`）**只在句首或独立出现时**删；
 *   - 语义性连词（`就是/然后/对`）只在重复或纯应答时删，保留正常连接语义。
 *
 * 因此这里给每个词配的是**边界策略**，不是"见词就删"：
 *   - `standalone`：左右都被标点/空白/换行/串首尾包住才算；
 *     中文粒子 `的话` 只要求右侧（它天生跟在从句后面：`开会的话，…`）；
 *   - `repeated`：紧邻重复、窗口内成簇（保留第一次）、或整句只有这个词
 *     （纯应答"然后。"）才算。
 *
 * 本模块是纯函数、零 IO：词条仍然走既有的词表/扫描/替换/回滚链路，
 * 这里只回答"这个位置该不该算口癖"。
 */

/** 规则包版本（写进 run.params.fillerRulePack，便于回看当时用的是哪版）。 */
export const FILLER_PACK_VERSION = 'v1';

/** 成簇判定的窗口（字符）：窗口内出现 ≥2 次才算"重复"。 */
export const REPEAT_CLUSTER_WINDOW = 20;

export type FillerMode = 'interjection' | 'standalone' | 'repeated';

/**
 * 感叹词保护：这些是含感叹字的**实词/固定搭配**，不删（否则会切出半个词）。
 */
export const PROTECTED_INTERJECTION_COMPOUNDS = ['啊哈', '啊呀', '啊哟', '嗯哼', '哦哟', '呃逆'];

export interface FillerRule {
  term: string;
  mode: FillerMode;
  /** standalone：左侧是否必须是边界（默认 true）。 */
  left?: boolean;
  /** standalone：右侧是否必须是边界（默认 true）。 */
  right?: boolean;
  /** 一句话说明规则意图，落进 run/词表时给人看。 */
  note: string;
}

/**
 * 默认规则包。**保守**是硬要求：`这个/那个` 只有在"这个词、那个事"这种
 * 独立出现时才删，`这个方案` 里一个字都不动。
 */
export const DEFAULT_FILLER_RULES: FillerRule[] = [
  // 感叹词按出现位置删除，但受保护的实词与固定搭配必须完整保留。
  { term: '嗯', mode: 'interjection', note: '感叹/迟疑，出现即删（保护搭配除外）' },
  { term: '呃', mode: 'interjection', note: '迟疑，出现即删（保护搭配除外）' },
  { term: '啊', mode: 'interjection', note: '感叹，出现即删（保护搭配除外）' },
  { term: '哦', mode: 'interjection', note: '应答，出现即删（保护搭配除外）' },
  { term: '这个', mode: 'standalone', note: '只删独立出现的（`这个方案` 不动）' },
  { term: '那个', mode: 'standalone', note: '只删独立出现的（`那个事` 不动）' },
  // `的话` 只删右侧有标点或句尾的形态，避免切坏 `他的话说明了立场` 等实义从句。
  { term: '的话', mode: 'standalone', left: false, note: '从句尾粒子：右侧有标点才删，避免切坏从句' },
  { term: '就是', mode: 'repeated', note: '只在重复或纯应答时删' },
  { term: '然后', mode: 'repeated', note: '只在重复或纯应答时删' },
  { term: '对', mode: 'repeated', note: '只在重复或纯应答时删' },
];

export interface FillerMatch {
  term: string;
  span: { start: number; end: number };
  rule: FillerRule;
}

/** 是否落在受保护的感叹词搭配里（`啊哈` 里的 `啊` 不动）。 */
function inProtectedCompound(text: string, start: number, end: number): boolean {
  return PROTECTED_INTERJECTION_COMPOUNDS.some((compound) => {
    const at = compound.indexOf(text.slice(start, end));
    if (at < 0) return false;
    const from = Math.max(0, start - at);
    return text.slice(from, from + compound.length) === compound;
  });
}

function isWordChar(ch: string): boolean {
  if (!ch) return false;
  // 字母/数字/CJK 视为"词内字符"，其余（标点/空白/换行/串尾）视为边界。
  return /[0-9A-Za-z]/.test(ch) || /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
}

function boundaryAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  return !isWordChar(text[index]);
}

/** 取出该偏移所在的"发言句"（以换行为界）。 */
function utteranceOf(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/** 纯应答：整句只有这个词（允许尾随标点/空白）。 */
function isPureAcknowledgment(text: string, index: number, term: string): boolean {
  const utterance = utteranceOf(text, index);
  if (!utterance) return false;
  const stripped = utterance.replace(/[\s，。！？、,.!?~～…]+$/g, '').trim();
  return stripped === term;
}

/** 紧邻重复的**后者**：这个词刚好紧接着同一个词（`然后然后` 里的第二个）。 */
function isRepeatedAfterSame(text: string, start: number, term: string): boolean {
  if (start < term.length) return false;
  return text.slice(start - term.length, start) === term;
}

/**
 * 成簇：窗口内**之前**已经出现过同一个词。
 * 语义是"保留第一次、删后面的"，所以判据只看前方窗口，不看后面——
 * 否则一次 `然后然后` 会被删成整句都不剩。
 */
function isClusterRepeat(text: string, start: number, term: string): boolean {
  const from = Math.max(0, start - REPEAT_CLUSTER_WINDOW);
  return text.slice(from, start).includes(term);
}

/**
 * 找出该删除的口癖位置。`rules` 缺省 = 默认规则包；
 * 词表里 kind=filler 的词条若不在规则包内，按 `standalone`（左右都要边界）处理。
 */
export function detectFillers(
  text: string,
  rules: FillerRule[] = DEFAULT_FILLER_RULES,
  limit = 1000,
): FillerMatch[] {
  const matches: FillerMatch[] = [];
  if (!text) return matches;
  for (const rule of rules) {
    const term = String(rule?.term || '').trim();
    if (!term) continue;
    const mode: FillerMode = rule.mode === 'repeated'
      ? 'repeated'
      : rule.mode === 'interjection' ? 'interjection' : 'standalone';
    let from = 0;
    for (;;) {
      const idx = text.indexOf(term, from);
      if (idx < 0) break;
      from = idx + Math.max(1, term.length);
      const end = idx + term.length;
      if (mode === 'interjection') {
        if (inProtectedCompound(text, idx, end)) continue;
      } else if (mode === 'standalone') {
        const needLeft = rule.left !== false;
        const needRight = rule.right !== false;
        if (needLeft && !boundaryAt(text, idx - 1)) continue;
        if (needRight && !boundaryAt(text, end)) continue;
      } else {
        // repeated：三种"确是口癖"的证据，缺一不删。
        // 注意顺序：整句纯应答 → 删；紧邻重复的后者 → 删；簇里非首个 → 删；
        // 其余（包括簇的第一个）保留。
        if (!isPureAcknowledgment(text, idx, term)
          && !isRepeatedAfterSame(text, idx, term)
          && !isClusterRepeat(text, idx, term)) continue;
      }
      matches.push({ term, span: { start: idx, end }, rule: { ...rule, mode } });
      if (matches.length >= limit) return matches;
    }
  }
  return matches.sort((a, b) => a.span.start - b.span.start);
}

/** 规则包导出成词表词条（`action: delete` + `kind: filler`），供种子动作使用。 */
export function fillerRuleEntries(rules: FillerRule[] = DEFAULT_FILLER_RULES): Array<{
  wrong: string; correct: string; action: 'delete'; kind: 'filler'; boundary: 'substring'; riskLevel: 'low';
  note: string;
}> {
  return rules.map((rule) => ({
    wrong: rule.term,
    correct: '',
    action: 'delete' as const,
    kind: 'filler' as const,
    boundary: 'substring' as const,
    riskLevel: 'low' as const,
    note: rule.note,
  }));
}

/** 某个词在规则包里的策略（词表里已有的 filler 词条据此判定）。 */
export function fillerRuleFor(term: string, rules: FillerRule[] = DEFAULT_FILLER_RULES): FillerRule | null {
  const key = String(term || '').trim();
  if (!key) return null;
  return rules.find((rule) => rule.term === key) ?? null;
}
