/**
 * transcript_rewrite — 受约束的**语句重建层**（L5）契约与校验器（纯函数，不碰文件系统）
 *
 * 为什么需要这一层：
 *   口癖删除、术语归一和同人合并不能代替句子重建：后者还包括合句、
 *   补被省略的主谓、断句和按主题归并。
 *   这一步绕不开模型，但**必须上枷锁**——公开数据已证伪裸 prompt：
 *   零样本 prompting 纠错把 CER 从 8.11% 恶化到 30.41%（ASR-EC Benchmark, EMNLP 2025）。
 *
 * 与既有模块的关系（沿用同一套契约风格）：
 *   `transcript_llm_candidates` 管"实体候选"、`transcript_headings` 管"章节标题"，
 *   本模块管"段落重建"。三者都是 `buildRequest → (模型) → parseResponse` 的纯函数形态，
 *   便于单测提示词契约、也便于把模型换成任意实现。
 *
 * ── 三条纪律─────────────────────────────────────────────────────────
 *   1. 只允许三类编辑：①实体归一 ②口癖与重复起句删除 ③句法重建（合句/补主谓/断句/分章）；
 *   2. 每段**必须**回引源发言 id（`srcIds`）——引用不上的段落一律不进正文；
 *   3. 不信任模型：所有输出都过机器侧六个校验（见 `verifyRewrite`）。
 *
 * 未能关联现有源发言的内容不进入正文；标注〔待核〕不能替代来源依据。
 * 模型返回的源 id 必须通过 `invalid_anchor` 校验。
 */

import { editDistance } from './transcript_recall';

/** 保留率下限：低于此值判"过度改写"（对齐 `OVER_REWRITE_THRESHOLD`）。 */
export const REWRITE_MIN_RETENTION = 0.35;
/** 保留率上限：高于此值说明"根本没清理"。 */
export const REWRITE_MAX_RETENTION = 0.90;
/** 段落与其源发言的最低相似度：低于此值不算"重建"，只能进待核。 */
export const REWRITE_MIN_SIMILARITY = 0.3;
/** 一次请求最多给模型多少条源发言（提示词长度可控）。 */
export const REWRITE_MAX_UTTERANCES = 40;
/** 单段最长字符数（防模型把整块糊成一段）。 */
export const REWRITE_MAX_PARAGRAPH_CHARS = 1200;
/**
 * 第三人称转述检测用于区分摘要与保留发言人原话口吻的重建。
 * 独立诊断该模式，避免只报告相似度低而无法说明原因。
 */
/**
 * "引例语境"标记：出现这些词说明发言人在**讲拼写/识别/纠错这件事本身**，
 * 那么其中的错写形态是**例子**，必须原样保留。
 * 错形本身属于引例内容，遵循"引例保留、实际指称纠正"。
 */
// 引例判据的唯一定义处，导出供扫描链共享；任何通道不得复制第二份词表。
export const QUOTE_MARKERS = [
  '会变成', '识别成', '识别错', '识别不准', '错误形式', '错形', '拼写', '写成',
  '一会儿叫', '这个词', '词汇表', '纠错', '纠正', '转录里', '转写里', '搞错', '叫错',
];
const NARRATION_VERBS = [
  '说', '询问', '问', '答', '回答', '确认', '指出', '认为', '提到', '提出', '表示',
  '建议', '要求', '同意', '补充', '强调', '回应', '解释', '承认',
];

/** 源发言（由①冻结解析产出）。 */
export interface SourceUtterance {
  /** 稳定 id（`U0001` 起，按原文顺序）。这是锚点，**不随清理变化**。 */
  id: string;
  speaker: string;
  /** `YYYY-MM-DD HH:mm:ss`、`HH:mm:ss` 或仅 `mm:ss`（沿用原文，相对时钟导出只给后者）。 */
  at: string;
  text: string;
}

/** 模型返回的一个段落。 */
export interface RewriteParagraph {
  /** 必须回引真实存在的发言 id。 */
  srcIds: string[];
  text: string;
}

/** 通过校验的段落（带机器侧计算出的度量）。 */
export interface VerifiedParagraph {
  srcIds: string[];
  text: string;
  /** 与源发言拼接文本的相似度（机器侧计算，不是模型自报的置信度）。 */
  similarity: number;
  speaker: string;
  /** 起始时间（取 srcIds 里第一条发言的时间）。 */
  from: string;
  /** 结束时间（取最后一条的）。 */
  to: string;
  /** 相似度过低 → 只能进待核，不进正文主列表。 */
  suspect: boolean;
}

export type RewriteIssueReason =
  | 'invalid_anchor'        // srcIds 里有不存在的 id → 段落丢弃
  | 'unreferenced_paragraph' // 段落没给 srcIds → 段落丢弃
  | 'empty_paragraph'       // 段落文本为空
  | 'low_similarity'        // 与原发言差太远 → 标待核
  | 'new_entity'            // 段里出现源发言没有的英文专名/数字串
  | 'too_long_paragraph'    // 单段超长
  | 'narration_style'       // **第三人称转述/摘要**：出现了"某人说/问/确认"式叙述
  | 'mixed_speaker'         // **跨说话人粘连**：一段里把几个人的话焊在一起，归属不明
  | 'unsupported_canonical' // **过度归一**：用了规范形，但本段来源里没有任何对应形态
  | 'dropped_utterance'    // **发言被挂名丢弃**：id 被引用，但该条内容没进产出
  | 'quoted_form_flattened' // **引例被抹平**：来源在举例说明错写形态，产出却改成规范形

export interface RewriteIssue {
  reason: RewriteIssueReason;
  /** 相关段落文本（截断到 200 字）。 */
  text: string;
  srcIds: string[];
  detail?: string;
}

export interface RewriteResult {
  paragraphs: VerifiedParagraph[];
  issues: RewriteIssue[];
  /** 未被任何段落引用的源发言 id —— **防"模型擅自删内容"**。 */
  uncovered: string[];
  stats: {
    sourceCount: number;
    charsIn: number;
    charsOut: number;
    /** 字符保留率（非空白）。 */
    retention: number;
    retentionOk: boolean;
    /** 可回溯段落占比（本模块保证为 1，除非 issues 里有 invalid_anchor）。 */
    anchorCoverage: number;
    /** 相似度过低段落占比。 */
    lowSimilarityRatio: number;
    /** 第三人称转述段落数。 */
    narrationCount: number;
    /** 跨说话人粘连段落数。 */
    mixedSpeakerCount: number;
    /** 被"挂名丢弃"的发言条数（id 被引用但内容未进产出）。 */
    droppedUtteranceCount: number;
    /** 质量门诊断：pass / summarized（在写摘要）/ over_rewrite / under_clean。 */
    qualityGate: 'pass' | 'summarized' | 'over_rewrite' | 'under_clean';
  };
}

// ── 输入构造 ────────────────────────────────────────────────────────────

export interface RewriteChunkOptions {
  /** 本块已确认的术语映射（供模型做归一，避免它自己发明写法）。 */
  glossary?: Array<{ correct: string; forms: string[] }>;
  /** 章节标题建议（可空；由 `transcript_headings` 产出）。 */
  heading?: string;
  /** 场景说明（会议主题、参会人），帮助模型判断语境。 */
  scenario?: string;
}

export const REWRITE_SYSTEM_PROMPT = [
  '你在把会议**实时语音转写**整理成书面文本：把口语写成书面语。',
  '**这不是写摘要，不是写纪要，不是第三人称复述。** 你要保留发言人的原话口吻和全部信息，',
  '只是把口语的赘余去掉、把断句理顺、把术语写对。',
  '',
  '【风格：必须保持第一人称原话】',
  '· 发言人说的是"我"，就用"我"；说"你"，就用"你"。**不要把"我"改成"他"或人名。**',
  '· **禁止写"某某说/某某问/某某确认/某某指出"这类叙述句**——那是摘要，不是整理。',
  '· 禁止把几条发言概括成一句抽象结论；要保留他具体怎么说的。',
  '',
  '【正例（照这个风格写）】',
  '输入：',
  '以下身份、时间与内容均为合成示例：',
  '  U0025｜示例发言人甲｜10:00:00｜那这个演示表单，就是用户在本地填完以后，怎么怎么把它保存成一个文件呢？',
  '  U0026｜示例发言人甲｜10:00:10｜保存完那个，文件的这个名字可以自己改吗？',
  '正确输出：',
  '  {"srcIds":["U0025","U0026"],"text":"用户在本地填完演示表单后，如何保存成文件？保存后可以自行修改文件名吗？"}',
  '说明：合并了同一人的两条连续发言，去掉了口语赘余与重复起句，',
  '仍然是第一人称的疑问句，信息一点没少。',
  '',
  '【反例（这样做是错的）】',
  '  "示例发言人甲讨论了表单导出，示例发言人乙同意。"  ← 第三人称摘要，并新增了原文没有的回应，禁止；',
  '  "示例发言人甲询问如何保存文件，以及能否修改文件名。"  ← 复述式，禁止。',
  '',
  '【最容易做错的一条：引例必须原样保留】',
  '当发言人**正在举例说明错写形态**时——例如"转写里会变成 X""错误形式可能是 X"',
  '"它一会儿叫 X""碰见 X 的时候""X 这个词应该进词汇表"——这个 X 是他要展示的**错误样例**，',
  '**必须原样保留**，绝对不要改成规范写法。改掉会毁掉整句意思：',
  '  · "它一会儿叫 demoterm，一会儿叫别的什么" → 若改成"一会儿叫 DemoTerm"，整句就没有意义了；',
  '  · "词汇表里应该有 demoterm 这个词" → 若改成"DemoTerm"，逻辑就反了（错形才需要进词汇表）；',
  '  · "真正要的是 DemoTerm，它有 demoterm，可能还有 demoturm" → 这些形态是**例子本身**，不能抹平。',
  '只有当 X 是**正常指称**（他就是在说这个东西本身）时才归一。判断依据：这句话是在**讲拼写/识别/纠错这件事**，还是在**用这个词说事**。',
  '',
  '【一条硬性排版规则：绝对不要跨说话人合并】',
  '只有**同一个人**连续说的话才能合并进同一段。相邻发言若分属不同人，**必须各自成段**，',
  '即使语义上连贯、即使其中一条只是"Ok""对对对"这样的短应答，也不要焊在一起——',
  '把两个人的话合成一段会导致**归属错误**。',
  '短应答可以直接删掉（按第②类编辑），但不可以并入别人的段落。',
  '',
  '【只允许做三类编辑】',
  '① 实体归一：把术语的错写/异写改成给定词表里的规范写法；',
  '② 口语清理：删语气词（嗯/呃/啊/哦）、重复起句（"我我我""这这个"）、无实义应答（"对对对""是吧"）、',
  '   说到一半又重说的整句；',
  '③ 句法重建：合并同一个人连续说的话为完整段落、补出被省略的主语谓语、按语义重新断句。',
  '',
  '【压缩来自哪里】',
  '压缩只能来自删口语赘余与重复表述，**不能来自丢信息或抽象化**。',
  '整体长度约为源发言的 45%–70%；低于 45% 通常说明你丢信息了，高于 70% 通常说明你还在照抄口语。',
  '',
  '【绝对禁止】',
  '1. 新增原文没有的事实、数字、人名、产品名、结论、时间；',
  '2. 把疑问句改成陈述句，或替发言人下判断、补结论；',
  '3. 丢掉实质信息：观点、理由、例子、数字、待办、未决问题、不同意见必须保留；',
  '4. 把不确定的地方写成确定的说法——拿不准就保留原话并标〔待核〕；',
  '5. 自己补会议结尾或总结段。',
  '',
  '【每个段落必须回引来源】',
  '每段给出 srcIds，元素是给定源发言的 id，**必须原样照抄给定的 id**，不得编造。',
  '一段引用多条连续发言是正常且期望的。',
  '',
  '【输出格式】只输出 JSON 数组，不要任何解释文字：',
  '[{"srcIds":["U0012","U0013"],"text":"整理后的书面语段落"}]',
].join('\n');

/** 构造请求体（纯函数，便于测提示词契约）。 */
export function buildRewriteRequest(
  chunk: SourceUtterance[],
  options: RewriteChunkOptions = {},
): { systemPrompt: string; message: string; usedUtterances: SourceUtterance[] } {
  const usedUtterances = (chunk ?? []).slice(0, REWRITE_MAX_UTTERANCES);
  const lines: string[] = [];
  if (options.scenario) lines.push(`【会议背景】${options.scenario}`, '');
  if (options.heading) lines.push(`【本块主题】${options.heading}`, '');
  const glossary = (options.glossary ?? []).filter((g) => g.correct && g.forms.length);
  if (glossary.length) {
    lines.push('【已确认术语（必须按此规范写法，不要使用其它写法）】');
    for (const g of glossary) lines.push(`  ${g.correct} ← ${g.forms.join(' / ')}`);
    lines.push('');
  }
  lines.push('【本块源发言（id 必须原样回引）】');
  for (const u of usedUtterances) {
    lines.push(`${u.id}｜${u.speaker}｜${u.at}｜${u.text}`);
  }
  lines.push('', '请按系统提示的格式输出 JSON 数组。');
  return { systemPrompt: REWRITE_SYSTEM_PROMPT, message: lines.join('\n'), usedUtterances };
}

// ── 响应解析（严格，不信任模型）──────────────────────────────────────────

/** 从模型文本里抠出 JSON 数组（模型常包在 ```json 里或加解释）。 */
export function extractJsonArray(raw: string): unknown[] | null {
  const text = String(raw ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 解析模型输出为段落列表；格式不符的项丢弃并记账（可观测模型编了什么）。 */
export function parseRewriteResponse(raw: string): { paragraphs: RewriteParagraph[]; issues: RewriteIssue[] } {
  const list = extractJsonArray(raw);
  const issues: RewriteIssue[] = [];
  if (!list) {
    return { paragraphs: [], issues: [{ reason: 'empty_paragraph', text: '', srcIds: [], detail: 'json_parse_failed' }] };
  }
  const paragraphs: RewriteParagraph[] = [];
  for (const item of list) {
    const row = item as Partial<{ srcIds: unknown; text: unknown }>;
    const text = String(row?.text ?? '').trim();
    const srcIds = Array.isArray(row?.srcIds)
      ? row.srcIds.map((x) => String(x ?? '').trim()).filter(Boolean)
      : [];
    if (!text) {
      issues.push({ reason: 'empty_paragraph', text: '', srcIds });
      continue;
    }
    if (!srcIds.length) {
      issues.push({ reason: 'unreferenced_paragraph', text: text.slice(0, 200), srcIds: [] });
      continue;
    }
    paragraphs.push({ srcIds, text });
  }
  return { paragraphs, issues };
}

// ── 机器侧校验 ──────────────────────────────────────────────────────────

const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9.+-]{2,}|[0-9]{2,}/g;

/** 拉丁 token 的"归一化键"：只留字母数字并小写（用于判定"是否只是写法差异"）。 */
function stripLatinKey(token: string): string {
  return token.toLowerCase().replace(/[^0-9a-z]/g, '');
}

function chars(text: string): number {
  return text.replace(/\s/g, '').length;
}

function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - editDistance(a, b) / max;
}

function normalizeForSim(text: string): string {
  return text.replace(/[\s，。！？、；：""''（）《》〔〕,.!?;:"'()<>[\]]/g, '');
}

/**
 * 校验重建结果。**这是本模块存在的意义**：模型的输出一律视为不可信输入。
 *
 * 六个校验（任一不通过的后果见 `RewriteIssueReason`）：
 *   ① 锚点存在性 ② 锚点非空 ③ 相似度地板 ④ 保留率区间 ⑤ 无新增实体 ⑥ 覆盖完整性
 */
/**
 * 判定"某条发言是否被挂名丢弃"的最小实义字符数：低于此长度的发言多为
 * "对""好的""Ok""嗯"这类应答，被合并/删除属正常，不该报。
 */
export const DROPPED_UTTERANCE_MIN_CHARS = 12;
/** 该条发言与其引用段落的最低相似度：低于此值即认为其内容没有被反映。 */
export const DROPPED_UTTERANCE_MIN_SIMILARITY = 0.25;

/**
 * "这条发言的内容是否出现在这段文本里"——用**滑窗最佳匹配**，不能用整段相似度。
 *
 * 合并段落可能包含多条发言，单条发言只占其中一部分，不能与整段直接比较。
 * 应在段内找与该条长度相当的最佳窗口再比。
 */
function bestWindowSimilarity(flatNeedle: string, flatHay: string): number {
  if (!flatNeedle) return 1;
  if (flatHay.includes(flatNeedle)) return 1;
  let best = similarity(flatNeedle, flatHay);
  const len = flatNeedle.length;
  if (len < 4 || flatHay.length <= len) return best;
  const step = Math.max(1, Math.floor(len / 4));
  for (let i = 0; i + len <= flatHay.length; i += step) {
    const r = similarity(flatNeedle, flatHay.slice(i, i + len));
    if (r > best) best = r;
    if (best >= 0.95) break;
  }
  return best;
}

export function verifyRewrite(
  source: SourceUtterance[],
  paragraphs: RewriteParagraph[],
  options: {
    minSimilarity?: number;
    maxParagraphChars?: number;
    /**
     * 允许出现的"原文里没有的写法"——即词表里的**规范形**。
     * 必须传入：词表规范形在原文里可能没有出现过，
     * 不豁免的话，每一处**合法**的实体归一都会被误报成"新增实体"。
     */
    allowedTerms?: string[];
    /** 发言人名列表：用于检测"某人说/问/确认"式第三人称转述。 */
    speakers?: string[];
    /**
     * 规范形 → 允许的原始形态（来自词表）。用于**过度归一**检测：
     * 若某段落用了规范形 `Cogseed`，但其来源发言里既没有 `Cogseed`，
     * 也没有词表里映射到它的任何形态（coxy/cox/…），则这一处归一没有依据。
     *
     * `new_entity` 无法单独检查缺乏原始形态依据的归一，因为规范形已在
     * `allowedTerms` 白名单中；这里仍要检查其来源发言。
     */
    canonicalForms?: Array<{ correct: string; forms: string[] }>;
    /**
     * 是否启用"挂名丢弃"检测（**默认关闭**）。
     *
     * 字符相似度无法可靠区分单条发言被改写还是被丢弃，长发言尤其容易误报，
     * 因此该检查默认关闭。
     * 要真正闭合"id 被引用但内容被丢"这个空档，需要**语义蕴含判定**（LLM/人工）
     * 或人工标注 gold 集；属未做项，不用启发式冒充。
     */
    checkDroppedUtterances?: boolean;
  } = {},
): RewriteResult {
  const minSimilarity = options.minSimilarity ?? REWRITE_MIN_SIMILARITY;
  const maxParagraphChars = options.maxParagraphChars ?? REWRITE_MAX_PARAGRAPH_CHARS;
  const byId = new Map(source.map((u) => [u.id, u]));
  const issues: RewriteIssue[] = [];
  const verified: VerifiedParagraph[] = [];
  const used = new Set<string>();

  for (const p of paragraphs) {
    // ① 锚点存在性
    const missing = p.srcIds.filter((id) => !byId.has(id));
    if (missing.length) {
      issues.push({
        reason: 'invalid_anchor',
        text: p.text.slice(0, 200),
        srcIds: p.srcIds,
        detail: `不存在的 id: ${missing.join(',')}`,
      });
      continue;
    }
    // ④ 单段长度
    if (chars(p.text) > maxParagraphChars) {
      issues.push({ reason: 'too_long_paragraph', text: p.text.slice(0, 200), srcIds: p.srcIds });
    }

    const sources = p.srcIds.map((id) => byId.get(id)!);
    const sourceText = sources.map((u) => u.text).join('');
    // ③ 相似度地板（机器侧计算，不用模型自报的置信度）
    const sim = similarity(normalizeForSim(p.text), normalizeForSim(sourceText));

    // ⑤ 无新增实体：段里出现的英文专名/长数字串必须在其源发言里出现过
    const sourceHay = sourceText.toLowerCase();
    const allowedHay = (options.allowedTerms ?? []).map((t) => String(t).toLowerCase());
    /**
     * 来源里出现过的"归一化键"集合：`NotebookLM` 与原文的 `notebook lm` 只差大小写/空格，
     * 属**合法的写法归一**，不该报成"原文没有的写法"。
     * 而 `OpenMAIC` 与原文的 `open mac open mic` 归一化后并不相等，仍会被如实报出。
     */
    // 用整段来源的"扁平串"做包含判定：`NotebookLM`(输出) 与 `notebook lm`(来源) 在扁平化后
    // 是同一串 → 判定为写法归一；而 `OpenMAIC` 与 `open mac open mic` 扁平化后不相等
    // （`openmaic` ⊄ `openmacopenmic`）→ 仍如实报出。
    const sourceFlat = stripLatinKey(sourceText);
    const newEntities: string[] = [];
    for (const m of p.text.matchAll(LATIN_TOKEN_RE)) {
      const token = m[0];
      const lower = token.toLowerCase();
      if (sourceHay.includes(lower)) continue;
      if (sourceFlat.includes(stripLatinKey(token))) continue;
      if (allowedHay.some((a) => a === lower || a.includes(lower) || lower.includes(a))) continue;
      newEntities.push(token);
    }
    if (newEntities.length) {
      issues.push({
        reason: 'new_entity',
        text: p.text.slice(0, 200),
        srcIds: p.srcIds,
        detail: [...new Set(newEntities)].join('、'),
      });
    }

    // ⑦ 第三人称转述检测
    //
    // 判据经过一次修正：不能"只要出现发言人名字就跳过"——本段说话人自己写的
    // "示例发言人甲指出，……"同样是转述（说话人用第三人称称呼自己）。
    // 最终规则：**名字 + 叙述动词**，且满足以下任一：
    //   (a) 这个名字就是本段的说话人（自己用第三人称说自己 = 一定是转述）；
    //   (b) 这个名字在其源发言里根本没出现过（凭空出现的叙述主语）。
    const ownSpeaker = sources[0].speaker;
    const narrationHits: string[] = [];
    for (const name of options.speakers ?? []) {
      if (!name || !p.text.includes(name)) continue;
      if (!new RegExp(`${name}\\s*(?:${NARRATION_VERBS.join('|')})`).test(p.text)) continue;
      if (name === ownSpeaker || !sourceText.includes(name)) narrationHits.push(name);
    }
    if (narrationHits.length) {
      issues.push({
        reason: 'narration_style',
        text: p.text.slice(0, 200),
        srcIds: p.srcIds,
        detail: `第三人称转述：${[...new Set(narrationHits)].join('、')}`,
      });
    }

    // ⑧ 跨说话人归属：`sources[0].speaker` 是错的做法。
    // 正确做法：按"谁的话更能解释这段文本"来定归属（argmax），
    // 只有当没有任何一个人能解释过半时，才判为粘连并从正文摘出。
    const speakerGroups = new Map<string, string[]>();
    for (const u of sources) {
      const list = speakerGroups.get(u.speaker) ?? [];
      list.push(u.text);
      speakerGroups.set(u.speaker, list);
    }
    let bestSpeaker = sources[0].speaker;
    let bestShare = -1;
    for (const [speaker, texts] of speakerGroups) {
      const share = similarity(normalizeForSim(p.text), normalizeForSim(texts.join('')));
      if (share > bestShare) { bestShare = share; bestSpeaker = speaker; }
    }
    const glued = speakerGroups.size > 1 && bestShare < 0.5;
    if (glued) {
      issues.push({
        reason: 'mixed_speaker',
        text: p.text.slice(0, 200),
        srcIds: p.srcIds,
        detail: `跨 ${speakerGroups.size} 位说话人且无法归属（最佳解释度 ${bestShare.toFixed(2)}）：${[...speakerGroups.keys()].join('、')}`,
      });
    }

    // ⑩ 引例被抹平检测：来源在举例说明错形，产出却把它改成了规范形
    if (options.canonicalForms?.length) {
      const sourceIsQuoting = QUOTE_MARKERS.some((m) => sourceText.includes(m))
        && (options.canonicalForms ?? []).some((g) =>
          (g.forms ?? []).some((f) => f && f.length > 2 && sourceText.toLowerCase().includes(f.toLowerCase())));
      if (sourceIsQuoting) {
        const keptRaw = (options.canonicalForms ?? []).some((g) =>
          (g.forms ?? []).some((f) => f && f.length > 2 && p.text.toLowerCase().includes(f.toLowerCase())));
        if (!keptRaw) {
          issues.push({
            reason: 'quoted_form_flattened',
            text: p.text.slice(0, 200),
            srcIds: p.srcIds,
            detail: '来源在举例说明错写形态，产出里已无任何原始错形（引例被抹平，语义可能已破坏）',
          });
        }
      }
    }

    // ⑨ 过度归一检测：规范形必须在其来源里有依据（见 canonicalForms 注释）
    if (options.canonicalForms?.length) {
      for (const g of options.canonicalForms) {
        if (!g.correct || !p.text.includes(g.correct)) continue;
        if (sourceText.includes(g.correct)) continue;
        const hasForm = (g.forms ?? []).some((f) => f && sourceText.toLowerCase().includes(f.toLowerCase()));
        if (hasForm) continue;
        issues.push({
          reason: 'unsupported_canonical',
          text: p.text.slice(0, 200),
          srcIds: p.srcIds,
          detail: `用了「${g.correct}」但来源里没有它、也没有 ${(g.forms ?? []).slice(0, 6).join('/')} 等形态`,
        });
      }
    }

    // ⑪ 挂名丢弃检测：id 被引用 ≠ 内容进了产出。
    //
    // `uncovered` 只检查 id 是否被引用，不能证明发言内容确实出现在产出中。
    // 启用此检查时，还需比较每条发言与段内最佳窗口的相似度。
    const paraFlat = normalizeForSim(p.text);
    for (const u of (options.checkDroppedUtterances ? sources : [])) {
      const flat = normalizeForSim(u.text);
      if (flat.length < DROPPED_UTTERANCE_MIN_CHARS) continue;
      const best = bestWindowSimilarity(flat, paraFlat);
      if (best < DROPPED_UTTERANCE_MIN_SIMILARITY) {
        issues.push({
          reason: 'dropped_utterance',
          text: p.text.slice(0, 200),
          srcIds: [u.id],
          detail: `[${u.id}] 的 id 被引用，但其内容未体现在本段（最佳窗口相似度 ${best.toFixed(2)}）：「${u.text.slice(0, 40)}」`,
        });
      }
    }

    for (const id of p.srcIds) used.add(id);
    verified.push({
      srcIds: p.srcIds,
      text: p.text,
      similarity: sim,
      speaker: bestSpeaker,
      from: sources[0].at,
      to: sources[sources.length - 1].at,
      suspect: sim < minSimilarity || glued,
    });
    if (sim < minSimilarity) {
      issues.push({
        reason: 'low_similarity',
        text: p.text.slice(0, 200),
        srcIds: p.srcIds,
        detail: `相似度 ${sim.toFixed(3)} < ${minSimilarity}`,
      });
    }
  }

  // ⑥ 覆盖完整性：没被任何段落引用的源发言必须列出来（防模型偷偷丢内容）
  const uncovered = source.map((u) => u.id).filter((id) => !used.has(id));

  const charsIn = source.reduce((n, u) => n + chars(u.text), 0);
  const charsOut = verified.filter((p) => !p.suspect).reduce((n, p) => n + chars(p.text), 0);
  const retention = charsIn ? charsOut / charsIn : 0;

  const lowRatio = verified.length
    ? verified.filter((p) => p.suspect).length / verified.length
    : 0;
  const narrationCount = issues.filter((i) => i.reason === 'narration_style').length;
  const mixedSpeakerCount = issues.filter((i) => i.reason === 'mixed_speaker').length;
  const droppedUtteranceCount = issues.filter((i) => i.reason === 'dropped_utterance').length;
  /**
   * 质量门：区分三种失败模式，给出可行动的诊断（而不是只报一个"问题数"）。
   *   `summarized`  = 大量段落相似度过低 → 模型在写摘要，不是在重建；
   *   `over_rewrite`= 保留率低于下限 → 改写过猛/在丢信息；
   *   `under_clean` = 保留率高于上限 → 没做书面化；
   */
  const qualityGate: 'pass' | 'summarized' | 'over_rewrite' | 'under_clean' =
    lowRatio > 0.2 || narrationCount > 3 ? 'summarized'
      : retention < REWRITE_MIN_RETENTION ? 'over_rewrite'
        : retention > REWRITE_MAX_RETENTION ? 'under_clean'
          : 'pass';

  return {
    paragraphs: verified,
    issues,
    uncovered,
    stats: {
      sourceCount: source.length,
      charsIn,
      charsOut,
      retention,
      retentionOk: retention >= REWRITE_MIN_RETENTION && retention <= REWRITE_MAX_RETENTION,
      anchorCoverage: verified.length
        ? verified.filter((p) => p.srcIds.length > 0).length / verified.length
        : 1,
      lowSimilarityRatio: lowRatio,
      narrationCount,
      mixedSpeakerCount,
      droppedUtteranceCount,
      qualityGate,
    },
  };
}

/**
 * **引例段的确定性回退**：被 `quoted_form_flattened` 标记的段落，一律用**源发言原文**
 * 替换模型产出，并在段尾标注。
 *
 * 为什么用"回退"而不是"再让模型改一次"：
 *   提示词不能保证模型保留错形引例。检测到该问题后，直接恢复源发言原文，
 *   牺牲部分流畅度以保留可核对的原始内容，不再依赖额外模型调用。
 */
export function applyQuotedFallback(
  paragraphs: VerifiedParagraph[],
  issues: RewriteIssue[],
  sourceText: (id: string) => string,
): { paragraphs: VerifiedParagraph[]; repaired: number[] } {
  const needFix = new Set(
    issues.filter((i) => i.reason === 'quoted_form_flattened').map((i) => i.srcIds.join('|')),
  );
  const repaired: number[] = [];
  const out = paragraphs.map((p, index) => {
    if (!needFix.has(p.srcIds.join('|'))) return p;
    const raw = p.srcIds.map((id) => sourceText(id)).filter(Boolean).join('');
    if (!raw) return p;
    repaired.push(index);
    return {
      ...p,
      text: `${raw}〔本段含对错写形态的举例，为避免误改示例，回退原文表述〕`,
    };
  });
  return { paragraphs: out, repaired };
}

/** 把校验结果转成给人看的「待核」条目（渲染层用）。 */
export function toSuspectNotes(result: RewriteResult): Array<{ srcIds: string[]; text: string; note: string }> {
  return result.issues
    .filter((i) => i.reason === 'low_similarity' || i.reason === 'new_entity')
    .map((i) => ({
      srcIds: i.srcIds,
      text: i.text,
      note: i.reason === 'low_similarity'
        ? `〔与原文差异较大，待核：${i.detail ?? ''}〕`
        : `〔出现原文没有的写法，待核：${i.detail ?? ''}〕`,
    }));
}
