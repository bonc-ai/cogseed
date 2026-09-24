/**
 * transcript_quote_context — "引例语境"判定的**单一事实源**（纯函数，不碰文件系统）
 *
 * 什么算引例：发言人在**讲拼写/识别/纠错这件事本身**，那么句子里出现的错写形态
 * 是**例子**，不是"该被纠正的错字"。
 *
 * 为什么必须单独抽一个模块（而不是各层各写一份）：
 *   这条规则此前只活在 `transcript_rewrite` 的**语句重建校验器**里（文档级：来源
 *   含标记词、且产出里原始错形全部消失 → 报 `quoted_form_flattened`）。但同一条
 *   规则必须同时作用于**扫描通道**——词表扫描同样会把 `coxy→Cogseed` 提为候选，
 *   而扫描通道此前**没有任何引例判定**。两处各写一份必然漂移（一个认定引例、另一
 *   个照改），所以标记表与判定函数都放这里，第 56 行的注释与本次抽取共用同一份列表。
 *
 * 真实事故（2026-09-16 复核，写进 `transcript_rewrite` 的注释里）：
 *   「一会儿叫 coxy，一会儿叫别的」被改成「一会儿叫 Cogseed」、
 *   「词汇表应该有 coxy」被改成「应该有 Cogseed」，**实测 8 段被抹平、语义完全破坏**。
 *   人工清理版对此有明确规则："**引例保留、实际指称纠正**"。
 *
 * 判定方向是**保守**的：命中即"不预勾"（人仍可显式勾选），不是"禁止替换"。
 * 因此宁可多标（少预勾一个），也不漏标（误改一处）。已知的代价：像
 * 「识别不准，coxy 那边说下周上线」这种"标记词 + 真实指称"共现的句子，会被
 * 降级为待确认——方向安全，但确实会多出几条需要人工确认的候选。
 */

/** 引例标记：出现这些词说明发言人在**讲拼写/识别/纠错这件事本身**。 */
export const QUOTE_MARKERS = [
  '会变成', '识别成', '识别错', '识别不准', '错误形式', '错形', '拼写', '写成',
  '一会儿叫', '这个词', '词汇表', '纠错', '纠正', '转录里', '转写里', '搞错', '叫错',
];

/**
 * 语境窗口（命中前后各取多少字符）。取 24 的依据：真实引例里标记词通常紧贴错形
 * （「一会儿叫 coxy」0 字距、「词汇表应该有 coxy」5 字距、「老被识别成"智能题"」3 字距），
 * 而窗口放大到整段会让"这一段里凡是提到纠错，全段候选都不预勾"——那等于把功能关掉。
 */
export const DEFAULT_QUOTE_WINDOW = 24;

/**
 * 句子边界：窗口**不得跨句**。
 *
 * 为什么必须加这条（2026-09-22 单测抓出来的真问题）：
 *   「一会儿叫 coxy，一会儿叫别的。下周 coxy 那边上线。」里两处 `coxy` 相距不到 24 字，
 *   只按字符窗口判定会把**第二处真实指称**也降级成引例。跨句污染会让"不预勾"从
 *   "针对引例"退化成"针对整段"，用户要多勾很多条——功能看着还在，实际不好用。
 *   加了它以后：第一句命中（引例），第二句不命中（真实指称），两行可以分开处置。
 *
 * 刻意**不**把逗号算作边界：真人引例经常是「这个词，我们写成 coxy」这种口径，
 * 逗号处截断会把标记和错形切开，反而漏判。
 */
const SENTENCE_BREAKS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n', '\r']);

/** 命中点所在句子的边界（不含边界字符本身）。 */
function sentenceBounds(text: string, start: number, end: number): { from: number; to: number } {
  let from = 0;
  for (let i = Math.min(start, text.length) - 1; i >= 0; i -= 1) {
    if (SENTENCE_BREAKS.has(text[i])) { from = i + 1; break; }
  }
  let to = text.length;
  for (let i = Math.max(end, 0); i < text.length; i += 1) {
    if (SENTENCE_BREAKS.has(text[i])) { to = i; break; }
  }
  return { from, to };
}

/** 折叠：与词表/扫描器同一套归一（大小写、全角），保证标记词比对不受输入法影响。 */
function fold(value: string): string {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

/**
 * 命中窗口内是否出现引例标记。
 *
 * 多条标记同时出现时返回**离命中最近的那一条**：面板把它显示成"附近出现「X」"，
 * 报最近的那个才说得通（实测句「词汇表应该有 cox 这个词」两个标记都在窗口内，
 * 报更近的「这个词」比报「词汇表」更贴合用户看到的界面）。
 *
 * @param foldedText 已经折叠过的全文（调用方用 `foldText` 折叠，下标与原文一一对应）
 * @param span       命中位置（原文坐标）
 * @returns 命中的标记词原文；没有则 `null`
 */
export function findQuoteContext(
  foldedText: string,
  span: { start: number; end: number },
  window = DEFAULT_QUOTE_WINDOW,
): string | null {
  const text = String(foldedText ?? '');
  if (!text) return null;
  if (!Number.isFinite(span?.start) || !Number.isFinite(span?.end)) return null;
  const width = Math.max(0, Math.floor(window));
  // 先在"命中所在的那一句"里取窗口：跨句的标记不算（理由见 SENTENCE_BREAKS 注释）
  const sentence = sentenceBounds(text, Math.floor(span.start), Math.ceil(span.end));
  const start = Math.max(sentence.from, Math.floor(span.start) - width);
  const end = Math.min(sentence.to, Math.ceil(span.end) + width);
  if (end <= start) return null;
  const hay = text.slice(start, end);
  let best: { marker: string; distance: number } | null = null;
  for (const marker of QUOTE_MARKERS) {
    const needle = fold(marker).trim();
    if (!needle) continue;
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    // 距离按"标记词尾 → 命中起点"算（标记词通常在错形之前）
    const absoluteEnd = start + at + needle.length;
    const distance = Math.abs(Math.floor(span.start) - absoluteEnd);
    if (!best || distance < best.distance) best = { marker, distance };
  }
  return best ? best.marker : null;
}

/** 文档级判定：整份来源里是否出现任一引例标记（供重建层的既有校验复用）。 */
export function hasQuoteMarker(text: string): boolean {
  const hay = fold(text);
  if (!hay) return false;
  return QUOTE_MARKERS.some((marker) => {
    const needle = fold(marker).trim();
    return needle.length > 0 && hay.includes(needle);
  });
}
