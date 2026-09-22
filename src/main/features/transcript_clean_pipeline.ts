/**
 * transcript_clean_pipeline — 转写清理的**确定性部分**（①冻结解析 ②结构口癖 ③实体归一 ⑤渲染）
 *
 * 纯函数为主：所有文件读写都在 driver（`scripts/transcript-clean-run.ts`）里，
 * 这样每一段都能单测、也能被 IPC/面板复用。
 *
 * 完整的六段管线见 `教育插件/教育插件/1/转写清理-端到端打通方案-2026-09-16.md`：
 *   ① 冻结与解析 → ② 结构与口癖 → ③ 实体归一 → ④ 受约束重建（LLM，见 transcript_rewrite）
 *   → ⑤ 锚点校验 → ⑥ 交付与对照
 *
 * 为什么这些必须确定性做（而不是交给模型）：
 *   - 口癖与同人合并有**明确规则**，交给模型只会引入不确定性（"这个方案"不该删"这个"）；
 *   - 术语有**已确认词表**，模糊匹配置信度天然不足（实测 `cookie→Cogseed` 0.80 是误召回），
 *     所以默认只做确定性通道，模糊候选必须人工确认后才生效。
 */

import {
  type GlossaryEntry,
} from './transcript_glossary';
import { detectFillers, fillerRuleFor, type FillerRule } from './transcript_filler_rules';
import { type Span } from './transcript_auto_correct';
import { recallCandidates, type RecallOptions } from './transcript_recall';
import {
  type SourceUtterance,
  type VerifiedParagraph,
} from './transcript_rewrite';

// ── ① 冻结与解析 ────────────────────────────────────────────────────────

/**
 * 块头：`名字 时钟`，时钟允许 **1~3 段**（`02:45` / `1:00:35` / `01:00:35`），
 * 日期可选——腾讯会议同一份导出里整点前只给相对时钟（`王伟 02:45`），整点后才是
 * `李强 01:00:35`；带日期的是另一种导出（`王芳 2026-09-16 09:29:17`）。
 * 旧正则硬要日期，于是相对时钟的稿子解析出 **0 条发言**，整条清理管线静默失效
 * （真机事故 2026-09-18：77 分钟的稿子清理版为空）。
 */
const HEADER_RE = /^(\S+)\s+(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}(?::\d{2}){1,2})\s*$/;
/** 转写声明行：日期同样可选（相对时钟导出不带日期）。 */
const BANNER_RE = /^(?:\d{4}-\d{2}-\d{2} )?\d{1,2}(?::\d{2}){1,2} 会议已开启实时转写/;

/**
 * 把腾讯会议导出的转写文本切成逐条发言。
 * 产出的 `id` 是**锚点**：从解析那一刻起固定，后续任何清理都不改变它，
 * 因此最终产物里每个段落都能反向指回原文的哪几条发言（人工清理版没有这个能力）。
 */
export function parseSource(text: string): SourceUtterance[] {
  const out: SourceUtterance[] = [];
  let speaker: string | null = null;
  let at = '';
  let buf: string[] = [];
  let seq = 0;
  const flush = () => {
    if (speaker === null) return;
    const body = buf.join('').trim();
    if (body) {
      seq += 1;
      out.push({ id: `U${String(seq).padStart(4, '0')}`, speaker, at, text: body });
    }
    buf = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (BANNER_RE.test(line)) continue;
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      speaker = m[1];
      // 有日期就沿用原文的 `日期 时钟`，没有就只留时钟（`at` 的契约允许两者）
      at = m[2] ? `${m[2]} ${m[3]}` : m[3];
      continue;
    }
    if (speaker === null) continue;
    buf.push(line.trim());
  }
  flush();
  return out;
}

// ── ② 结构与口癖 ────────────────────────────────────────────────────────

export interface FillerRemoval {
  id: string;
  text: string;
  removed: Record<string, number>;
}

/**
 * 按口癖规则包删除填充词。**绝不"见词就删"**：
 * 白名单词只在独立出现时删（所以在那个窗口里取子串 +6 是安全的），
 * `这个`/`然后`/`对` 只在重复或纯应答时删（否则 `这个方案`、`然后我们` 会被删坏）。
 * 复用 `transcript_filler_rules`，与线上扫描器同一套判定。
 */
export function removeFillers(
  utterances: SourceUtterance[],
  rules?: FillerRule[],
): { items: FillerRemoval[]; totals: Record<string, number> } {
  const totals: Record<string, number> = {};
  const items: FillerRemoval[] = [];
  for (const u of utterances) {
    // detectFillers 要求词条形态；这里用规则包构造一次即可
    const spans: Array<{ start: number; end: number; term: string }> = [];
    for (const term of ['嗯', '呃', '啊', '哦', '哎', '唉']) {
      const rule = fillerRuleFor(term, rules);
      if (!rule) continue;
      for (const m of detectFillers(u.text, [{ ...rule, term }])) {
        spans.push({ start: m.span.start, end: m.span.end, term });
      }
    }
    // 重叠消解：按起点排序，取最长
    spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const kept: Span[] = [];
    const accepted: Array<{ start: number; end: number; term: string }> = [];
    for (const s of spans) {
      if (kept.some((k) => s.start < k.end && s.end > k.start)) continue;
      kept.push({ start: s.start, end: s.end });
      accepted.push(s);
    }
    accepted.sort((a, b) => a.start - b.start);
    let text = '';
    let cursor = 0;
    const removed: Record<string, number> = {};
    for (const s of accepted) {
      text += u.text.slice(cursor, s.start);
      cursor = s.end;
      removed[s.term] = (removed[s.term] ?? 0) + 1;
      totals[s.term] = (totals[s.term] ?? 0) + 1;
    }
    text += u.text.slice(cursor);
    // 清理删除后留下的悬空标点（`，，`、行首逗号）——这是"删词不修标点"的经典副产品
    text = tidyPunctuation(text);
    items.push({ id: u.id, text, removed });
  }
  return { items, totals };
}

/** 删除后修标点：避免出现 `，，`、行首逗号、`，。` 这类痕迹。 */
export function tidyPunctuation(text: string): string {
  return text
    .replace(/[，、]{2,}/g, '，')
    .replace(/，([。！？；])/g, '$1')
    .replace(/^[，、。；]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 同人连续发言合并后的块（用于渲染 `**说话人｜起—止**`）。 */
export interface MergedBlock {
  speaker: string;
  from: string;
  to: string;
  /** 块内段落（来自④重建；确定性阶段则每条发言一段）。 */
  paragraphs: string[];
  /** 块覆盖的源发言 id（锚点）。 */
  srcIds: string[];
}

/**
 * 按"说话人 + 段落来源"合并：相邻段落若同属一个说话人则并入同一块。
 * 与既有 `transcript_speaker_merge` 的合并语义一致（只是这里作用于重建后的段落）。
 */
export function mergeBlocks(paragraphs: VerifiedParagraph[]): MergedBlock[] {
  const out: MergedBlock[] = [];
  for (const p of paragraphs) {
    const last = out[out.length - 1];
    if (last && last.speaker === p.speaker) {
      last.paragraphs.push(p.text);
      last.to = p.to;
      last.srcIds.push(...p.srcIds);
      continue;
    }
    out.push({ speaker: p.speaker, from: p.from, to: p.to, paragraphs: [p.text], srcIds: [...p.srcIds] });
  }
  return out;
}

// ── ③ 实体归一 ──────────────────────────────────────────────────────────

export interface NormalizeResult {
  /** 原文 → 替换后。 */
  text: string;
  applied: Array<{ wrong: string; correct: string; channel: string; count: number }>;
  /** 只出候选、未自动替换的（模糊通道）。 */
  pending: Array<{ wrong: string; correct: string; channel: string; similarity: number }>;
}

/**
 * 实体归一：**确定性通道自动替换，模糊通道只出候选**。
 *
 * 依据（2026-09-16 实测）：模糊通道在真实语料上会把 `cookie`(0.80)、`Ok`/`id`(0.67)、
 * `cost`(0.67) 这类普通英文词召回成 Cogseed/EduSeed —— 一旦自动替换就是静默事故。
 * 因此本函数默认 `autoChannels = ['normalized']`（大小写/分隔符归一，相似度恒为 1）。
 */
export function normalizeEntities(
  text: string,
  entries: GlossaryEntry[],
  options: RecallOptions & { autoChannels?: Array<'normalized' | 'phonetic' | 'edit' | 'weak'> } = {},
): NormalizeResult {
  const autoChannels = new Set(options.autoChannels ?? ['normalized']);
  const result = recallCandidates(text, entries, options);
  const applied: NormalizeResult['applied'] = [];
  const pending: NormalizeResult['pending'] = [];
  // 只自动替换白名单通道命中的；其余如实进 pending（不静默丢，面板要能看见）
  const auto = result.candidates
    .filter((c) => autoChannels.has(c.channel))
    .sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  const done: Span[] = [];
  let out = '';
  let cursor = 0;
  for (const c of auto) {
    if (done.some((s) => c.span.start < s.end && c.span.end > s.start)) continue;
    done.push(c.span);
    out += text.slice(cursor, c.span.start) + c.correct;
    cursor = c.span.end;
    const hit = applied.find((a) => a.wrong === c.wrong && a.correct === c.correct);
    if (hit) hit.count += 1;
    else applied.push({ wrong: c.wrong, correct: c.correct, channel: c.channel, count: 1 });
  }
  out += text.slice(cursor);
  for (const c of result.candidates) {
    if (autoChannels.has(c.channel)) continue;
    pending.push({ wrong: c.wrong, correct: c.correct, channel: c.channel, similarity: c.similarity });
  }
  return { text: out, applied, pending };
}

// ── ⑥ 渲染 ──────────────────────────────────────────────────────────────

export interface RenderOptions {
  title: string;
  date: string;
  /** 参会人（去重后的说话人，按发言量降序）。 */
  speakers: string[];
  /** 章节标题（由 transcript_headings 契约为每块生成；缺省则不插入标题）。 */
  headings?: Map<number, string>;
  /** 术语依据表（清理后用词 ← 原始典型形式 → 依据）。 */
  glossaryTable?: Array<{ correct: string; forms: string; basis: string }>;
  /** 未决项（人工/机器都判不了的）。 */
  openItems?: string[];
  /** 使用的上下文材料。 */
  materials?: string[];
  /** 逐块统计，写进页脚便于复核。 */
  stats?: Record<string, string | number>;
}

function clockOf(at: string): string {
  const m = /(\d{2}:\d{2}:\d{2})/.exec(at);
  return m ? m[1] : at;
}

/**
 * 渲染成交付 Markdown。结构对齐人工清理版的形态（标题 → 整理说明 → 章节 →
 * `**说话人｜起—止**` 段落 → 附记），但**多两样**：每段的源发言 id、以及整理纪律声明。
 */
export function renderMarkdown(blocks: MergedBlock[], options: RenderOptions): string {
  const lines: string[] = [];
  lines.push(`# ${options.title}`, '');
  lines.push(`会议日期：${options.date}`, `发言人：${options.speakers.join('、')}`, '');
  lines.push(
    '> 整理说明：本文是由"转写清理管线"产出的**受约束重建版**，不是逐字校订，也不是会议摘要。',
    '> 只做三类编辑：实体归一、口语清理、句法重建；不新增原文没有的事实。',
    '> **每个段落都回引了源发言 id**（见段末 `⟦U0012-U0013⟧`），可逐段回溯到原始转写。',
    '> 无法可靠复原的内容以〔待核〕标注。原始转写文件保持不变。',
    '',
  );

  let section = 0;
  blocks.forEach((b, index) => {
    const heading = options.headings?.get(index);
    if (heading) {
      section += 1;
      lines.push(`## ${String(section).padStart(2, '0')}、${heading}`, '');
    }
    const from = clockOf(b.from);
    const to = clockOf(b.to);
    const label = from === to ? `**${b.speaker}｜${from}**` : `**${b.speaker}｜${from}—${to}**`;
    lines.push(label, '  ');
    for (const p of b.paragraphs) lines.push(p, '');
    lines.push(`⟦${b.srcIds[0]}${b.srcIds.length > 1 ? `-${b.srcIds[b.srcIds.length - 1]}` : ''}⟧`, '');
  });

  lines.push('---', '', '## 整理附记', '');

  if (options.glossaryTable?.length) {
    lines.push('### 已归一的术语', '', '| 规范写法 | 原始转写中的典型形式 | 依据 |', '|---|---|---|');
    for (const row of options.glossaryTable) lines.push(`| ${row.correct} | ${row.forms} | ${row.basis} |`);
    lines.push('');
  }
  if (options.openItems?.length) {
    lines.push('### 未决项（需人工确认）', '');
    for (const item of options.openItems) lines.push(`- ${item}`);
    lines.push('');
  }
  if (options.materials?.length) {
    lines.push('### 使用的材料', '');
    options.materials.forEach((m, i) => lines.push(`${i + 1}. ${m}`));
    lines.push('');
  }
  if (options.stats) {
    lines.push('### 本次运行统计', '');
    for (const [k, v] of Object.entries(options.stats)) lines.push(`- ${k}：${v}`);
    lines.push('');
  }
  return lines.join('\n');
}
