/**
 * KB quiz (知识库测验题，本地生成) —— 把「生成测验」做成真能力。
 *
 * 背景：AI 解析卡上的「生成测验」在 #112 只留了调用点，`_renderQuiz` 从未实现
 * （点击直接 ReferenceError），而且按钮被"先生成 AI 解析"挡着。测验和脑图一样
 * 只需要库内 ready 文档，**不需要解析结果**，所以这里与 kb_summary 解耦：
 * 与 kb_mindmap 同源（`collectReadyDocLines`）+ 本地 LLM，全程不上云。
 *
 * 只读管线：不写库、不写会话；库指纹缓存 + single-flight；失败降级给原因。
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../logger';
import { maskId } from '../util/log-redact';
import { collectReadyDocLines } from './kb_summary';

const log = createLogger('kb-quiz');

const CACHE_MAX = 50;
/** 默认题量（用户可在 IPC 传 count 覆盖）。 */
const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
/** 题目数量上限（防模型多输出）。 */
const MAX_QUESTIONS = 20;
/** LLM 单次出题超时：与 kb_mindmap 同款预算（含排队+推理+流式输出）。
 *  2026-09-16：共用的采样预算放开到最多 30k 字后，120s 会误杀正常请求，
 *  随脑图一起放宽到 180s（kb_summary / kb_mindmap / kb_quiz 三处对齐）。 */
const QUIZ_LLM_TIMEOUT_MS = 180 * 1000;
/** 「提示」是单题小请求：预算比整卷出题短得多（30s 还没回就不值得让用户等）。 */
export const HINT_LLM_TIMEOUT_MS = 30 * 1000;
/** 基于对话文本出题时的输入截断（防止超长回答撑爆上下文）。 */
const DOC_CHAR_CAP = 4000;

export interface KbQuizQuestion {
  /** 1-based 题号（按输出顺序重排，模型给的序号不可信）。 */
  id: number;
  type: 'single' | 'short';
  question: string;
  /** 单选题选项（简答题为空数组）。 */
  options: string[];
  /** 正确答案：单选题为选项原文；简答题为参考答案。 */
  answer: string;
  /** 一句话解析（可为空）。 */
  explain: string;
  /** 题目来源文档（溯源用，可选）。 */
  source?: string;
}

export interface KbQuizResult {
  questions: KbQuizQuestion[];
  source: 'generated' | 'cached' | 'degraded';
  /** 降级原因（source='degraded' 时存在）：
   *  - empty        ：库内没有 ready 文档要点，根本没调 LLM；
   *  - timeout      ：LLM 排队+推理超过 QUIZ_LLM_TIMEOUT_MS 被掐断；
   *  - model-failed ：模型调用返回失败；
   *  - unparsable   ：模型返回的内容里抽不出任何一道有效题。 */
  reason?: 'empty' | 'timeout' | 'model-failed' | 'unparsable';
  fingerprint: string;
  /** 出题所用的来源文档（去重、按首次出现顺序）：面板"查看 N 个来源"与溯源用。 */
  sources?: string[];
}

export interface KbQuizDeps {
  complete: (opts: {
    userId: string;
    message: string;
    systemPrompt: string;
    sessionId: string;
  }) => Promise<{ ok: boolean; text: string; error: string }>;
}

export const QUIZ_SYSTEM_PROMPT = `你是知识库测验出题助手。根据提供的文档要点出题，只输出 JSON，不要任何额外文字：
{"questions":[{"type":"single","question":"题干","options":["选项1","选项2","选项3","选项4"],"answer":"选项2","explain":"解析：说清材料里的哪条事实/哪句话支撑这个答案","source":"来源文档名"},{"type":"short","question":"题干","options":[],"answer":"参考答案","explain":"解析：说清依据来自材料的哪一点","source":"来源文档名"}]}
要求：
1. 单选题 4 个选项，**只有一个正确**，干扰项要似是而非（同领域概念，不要明显离谱）；
2. 「answer」写**选项原文**（不要只写 A/B/C/D）；
3. 考"理解与应用"（概念辨析、原理、为什么），不要考文件名、页码、章节号这类只有翻书才知道的记忆点；
4. **「explain」必须落到材料的具体事实，不要写空话**（真机反馈：一句话解析读起来像套话、跟材料对不上）：
   - 写清支撑正确答案的是**材料里的哪个事实/哪种机制/哪条规则**，能引用材料原话就引用（可短引）；
   - 允许直接写出关键依据，例如"因为材料写明清理以 CSV 为准，提示词只是速览"；
   - **禁止**只写"根据材料可知""综上所述""这符合题意""这是常识""考查的是理解能力"这类没有信息的句子；
   - 单选可再补一句"主要干扰项错在哪"，但总长控制在 1–2 句（约 30–80 字），不要复述整段原文；
5. 「source」只能写材料里**真实存在**的文档（写材料中 \`## \` 后那个名字，或它的文件名），不要编造；
6. 简答题的 answer **只给要点**：1–3 条，每条不超过 20 字，用「；」分隔，不要写成
   一段话（参考答案是给人对照的，不是复述原文）；需要展开的解释放 explain；
7. 题目之间不要重复考同一个点。`;

const cache = new Map<string, KbQuizResult>();
/** 同指纹在途生成（single-flight）：连点/并发只发起一次 LLM 调用。 */
const inflight = new Map<string, Promise<KbQuizResult>>();

function fingerprint(docLines: string[], count: number): string {
  return createHash('sha256').update(`${count}\u0000${docLines.join('\u0000')}`).digest('hex').slice(0, 16);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** 选项/答案比对用的归一：去空白、去首尾标点、小写、全角转半角（宽松但可解释）。 */
function normalizeAnswerText(s: string): string {
  return String(s || '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]/g, '')
    .replace(/^[a-fA-F][.、)．:：]\s*/, '')
    .replace(/[。，,.;；:：]+$/, '')
    .toLowerCase();
}

/**
 * 把模型给的 answer 归一到"选项原文"：
 *   - 单个字母（A–F）→ 对应下标选项；
 *   - "B. 选项文本" → 去前缀后与选项比对，命中就用选项原文；
 *   - 其余（简答题参考答案 / 已是选项原文）→ 原样返回。
 */
export function resolveAnswer(rawAnswer: string, options: string[]): string {
  const raw = String(rawAnswer || '').trim();
  if (!raw) return '';
  const letter = raw.match(/^[（(]?([A-Fa-f])[)）.、:：]?$/);
  if (letter) {
    const idx = letter[1].toUpperCase().charCodeAt(0) - 65;
    if (options[idx]) return options[idx];
  }
  const norm = normalizeAnswerText(raw);
  for (const opt of options) {
    if (normalizeAnswerText(opt) === norm) return opt;
  }
  return raw;
}

/** 从 LLM 文本里抽层级 JSON（容忍代码块/前后杂文），逐条校验并丢弃坏题。 */
export function parseQuizJson(text: string, opts: { maxQuestions?: number } = {}): KbQuizQuestion[] {
  const max = Math.max(1, opts.maxQuestions ?? MAX_QUESTIONS);
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  let list: any[] = [];
  try {
    if (objMatch) {
      const data = JSON.parse(objMatch[0]);
      list = Array.isArray(data?.questions) ? data.questions : (Array.isArray(data) ? data : []);
    } else if (arrMatch) {
      list = JSON.parse(arrMatch[0]);
    }
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];

  const out: KbQuizQuestion[] = [];
  for (const item of list) {
    if (out.length >= max) break;
    const question = String(item?.question ?? item?.q ?? item?.title ?? '').trim();
    if (!question) continue; // 没题干的直接丢
    const options = (Array.isArray(item?.options) ? item.options : [])
      .map((o: any) => String(o ?? '').trim())
      .filter(Boolean);
    const answerRaw = String(item?.answer ?? item?.correct ?? item?.a ?? '').trim();
    const explain = String(item?.explain ?? item?.explanation ?? item?.why ?? '').trim();
    const source = String(item?.source ?? item?.from ?? item?.doc ?? '').trim();
    const declaredType = String(item?.type ?? '').toLowerCase();
    // 题型以"选项数"为准，只有显式 short 才强制简答：模型偶尔声明 single 却只给
    // 1 个选项（没有干扰项就不是选择题），这种按简答题处理并拿选项文本当参考
    // 答案，而不是把废题丢给用户。
    const isSingle = declaredType !== 'short' && options.length >= 2;
    const answer = resolveAnswer(answerRaw, options);
    if (!answer && !isSingle) continue; // 简答题没有参考答案 = 无意义
    out.push({
      id: out.length + 1,
      type: isSingle ? 'single' : 'short',
      question,
      options: isSingle ? options : [],
      answer: answer || options[0] || '',
      explain,
      ...(source ? { source } : {}),
    });
  }
  return out;
}

/** 从模型给的题目里收集来源文档名（去重、按首次出现顺序）：面板"查看 N 个来源"。 */
export function collectQuizSources(questions: KbQuizQuestion[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of questions || []) {
    const name = String(q?.source || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 单题提示（「提示」按钮）：只给**文档内的线索**，不给答案。
 *
 * 与出题同源：复用库内 ready 文档要点；能定位到题目来源文档时优先只用那一份
 * （线索才不会串到别的材料上）。模型若答不上来/超时，如实降级并给原因，
 * 面板据此显示"暂无提示"，不编内容。
 */
export const HINT_SYSTEM_PROMPT = `你是知识库测验的"提示助手"。用户正在做一道题，需要一点线索，**但绝不能给出答案**。
只输出 JSON，不要任何额外文字：{"hint":"……","covered":true}
要求：
1. hint 用 1–2 句中文，指出去文档里**该看哪一节/哪个概念**（例如"回到『权限模型』一节对比两类角色的差异"），
   **不要**复述选项文字、不要点出哪个选项对、不要直接写出答案本身；
2. 若提供的文档要点里找不到与本题相关的线索，hint 写"这份材料里没有直接讲到这一点"，covered 写 false；
3. 不要编造文档里不存在的内容。`;

export interface KbQuizHintResult {
  hint: string;
  /** 线索是否真的来自材料；false = 材料没覆盖（面板如实标注）。 */
  covered: boolean;
  source: 'generated' | 'degraded';
  reason?: 'empty' | 'timeout' | 'model-failed' | 'unparsable';
}

const hintCache = new Map<string, KbQuizHintResult>();

export function parseHintJson(text: string): { hint: string; covered: boolean } | null {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;
  try {
    const data = JSON.parse(objMatch[0]);
    const hint = String(data?.hint ?? data?.tip ?? data?.clue ?? '').trim();
    if (!hint) return null;
    return { hint, covered: data?.covered !== false };
  } catch {
    return null;
  }
}

export async function kbQuizHint(
  userId: string,
  opts: {
    question?: string;
    options?: string[];
    type?: string;
    source?: string | null;
    dir?: string | null;
    spaceId?: string | null;
    fingerprint?: string;
    qid?: number;
  },
  deps: KbQuizDeps,
): Promise<KbQuizHintResult> {
  const question = String(opts?.question || '').trim();
  if (!question) return { hint: '', covered: false, source: 'degraded', reason: 'empty' };
  const cacheKey = `${String(opts?.fingerprint || '')}\u0000${Math.trunc(Number(opts?.qid) || 0)}`;
  const hit = hintCache.get(cacheKey);
  if (hit) return hit;

  const docName = String(opts?.source || '').trim();
  const allLines = collectReadyDocLines(userId, { dir: opts?.dir || null, spaceId: opts?.spaceId || null });
  const picked = docName ? allLines.filter((l) => l.includes(docName)) : [];
  const docLines = (picked.length ? picked : allLines).slice(0, 6);
  if (!docLines.length) return { hint: '', covered: false, source: 'degraded', reason: 'empty' };

  const optionText = Array.isArray(opts?.options) && opts.options.length
    ? `\n选项：\n${opts.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${String(o)}`).join('\n')}`
    : '';
  const completion = deps.complete({
    userId,
    message: `题目：${question}${optionText}\n${docName ? `（本题来源文档：${docName}）` : ''}\n\n材料要点：\n${docLines.join('\n\n')}`,
    systemPrompt: HINT_SYSTEM_PROMPT,
    sessionId: `aside-kbquizhint-${userId}`,
  });

  try {
    const res = await withTimeout(completion, HINT_LLM_TIMEOUT_MS);
    if (!res.ok) throw new Error(res.error || 'model failed');
    const parsed = parseHintJson(res.text);
    if (!parsed) return { hint: '', covered: false, source: 'degraded', reason: 'unparsable' };
    const out: KbQuizHintResult = { hint: parsed.hint, covered: parsed.covered, source: 'generated' };
    if (cacheKey.trim()) {
      hintCache.set(cacheKey, out);
      if (hintCache.size > CACHE_MAX) {
        const first = hintCache.keys().next().value;
        if (first) hintCache.delete(first);
      }
    }
    return out;
  } catch (err) {
    const message = (err as Error).message || String(err);
    const reason = message.startsWith('LLM timeout') ? 'timeout' as const : 'model-failed' as const;
    log.warn('kb quiz hint failed, degrading', { user_id: maskId(userId), error: message });
    return { hint: '', covered: false, source: 'degraded', reason };
  }
}


/**
 * 二级提示：**材料片段**（不打模型，离线也能用）。
 *
 * 一级提示（`kbQuizHint`）是模型给的"该看哪一节"；用户还想直接看原文时，
 * 不必离开测验——这里从该题来源文档的要点里挑**和题干/答案重合度最高**的一段。
 *
 * v2（真机反馈「文档对，但段落不对」）改了三件事：
 *   1. 词元加 **IDF 权重**：只在少数段落出现的词比"到处都是"的词有信息量；全段皆有的
 *      词直接丢弃（它不区分任何东西）。原来的"命中数"口径下，一段满是"文档/我们/可以"
 *      的废话能靠数量压过真正含依据的短段。
 *   2. **答案原文命中**给强加分：单选题的 answer 通常就是材料里的措辞，它落在哪一段，
 *      哪一段基本就是依据（长度 <4 的答案不加分，避免"甲/乙"乱命中）。
 *   3. 返回**句级窗口**而不是整段前 320 字：整段前半截常是铺垫，高亮会落在铺垫上；
 *      改为取命中句 ±1 句、句界对齐、逐字取原文，高亮才正对依据。
 */
export function pickSnippet(
  lines: string[],
  query: string,
  opts: { maxChars?: number; answer?: string } = {},
): { snippet: string; line: number } | null {
  const maxChars = Math.max(80, Math.min(1200, Math.trunc(Number(opts?.maxChars) || 320)));
  const candidates = (Array.isArray(lines) ? lines : [])
    .map((raw) => String(raw || '').trim())
    .filter(Boolean);
  if (!candidates.length) return null;

  const answer = normalizeAnswerText(opts?.answer || '');
  const wantAnswer = answer.length >= 4;
  const terms = queryTerms([query, wantAnswer ? answer : ''].filter(Boolean).join(' '));
  const lower = candidates.map((c) => c.toLowerCase());
  if (!terms.length && !wantAnswer) return { snippet: candidates[0].slice(0, maxChars), line: 0 };

  // 文档内词频：df = 含该词的段落数。df 等于总段数 → 该词在这份材料里无区分度，丢掉；
  // 只有一段候选时没有"区分"可言，全部保留，否则一个词都留不下（会退化成选不出来）。
  const df = new Map<string, number>();
  for (const term of terms) {
    let n = 0;
    for (const text of lower) if (text.includes(term)) n += 1;
    if (n > 0 && (candidates.length === 1 || n < candidates.length)) df.set(term, n);
  }
  const scoreText = (hay: string) => {
    let score = 0;
    for (const term of df.keys()) if (hay.includes(term)) score += Math.log(1 + candidates.length / (df.get(term) || 1));
    // 答案原文命中 = 直接证据，量级要压得住词元噪声
    if (wantAnswer && hay.includes(answer)) score += ANSWER_HIT_BONUS;
    return score;
  };

  let best = { score: -1, line: 0 };
  candidates.forEach((text, idx) => {
    const raw = scoreText(lower[idx]);
    if (raw <= 0) return;
    // 命中密度为辅，避免"长段落天然占优"；同分取靠前一段（保持稳定）
    const score = raw + (raw / Math.max(40, text.length)) * 4;
    if (score > best.score) best = { score, line: idx };
  });
  if (best.score <= 0) return null;

  return {
    snippet: pickSentenceWindow(candidates[best.line], scoreText, { maxChars, answer: wantAnswer ? answer : '' }),
    line: best.line,
  };
}

/** 答案原文命中的加分（几倍于单个词元，但不至于盖过整段证据）。 */
const ANSWER_HIT_BONUS = 8;

/**
 * 句级窗口：在段落里挑打分最高的那一句，带上前后各一句（句界对齐、逐字取原文）。
 * 段落只有一句（或切不出句子）时退回按字符截断。
 */
function pickSentenceWindow(
  paragraph: string,
  scoreText: (hay: string) => number,
  opts: { maxChars: number; answer?: string },
): string {
  const spans = sentenceSpans(paragraph);
  if (spans.length <= 1) return paragraph.slice(0, opts.maxChars);
  let bestIdx = 0;
  let bestScore = -1;
  spans.forEach((span, idx) => {
    const score = scoreText(paragraph.slice(span.start, span.end).toLowerCase());
    if (score > bestScore) { bestScore = score; bestIdx = idx; }
  });
  if (bestScore <= 0) return paragraph.slice(0, opts.maxChars);
  let from = Math.max(0, bestIdx - 1);
  let to = Math.min(spans.length - 1, bestIdx + 1);
  // 超预算就先丢后一句、再丢前一句（保住"命中句"在窗口里）
  while (to > from && spans[to].end - spans[from].start > opts.maxChars) {
    if (to - bestIdx > bestIdx - from) to -= 1;
    else if (from < bestIdx) from += 1;
    else to -= 1;
  }
  const window = paragraph.slice(spans[from].start, spans[to].end).trim();
  return window.length > opts.maxChars ? window.slice(0, opts.maxChars).trim() : window;
}

/** 句子切分（保留结尾标点与原文偏移，供逐字取窗口）。 */
function sentenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = /[^。！？!?；;\n]+[。！？!?；;]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!m[0].trim()) continue;
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** 问句虚词（2 字组）：这些组出现在任何一段里都不代表"这段是依据"。 */
const QUERY_STOP_GRAMS = new Set([
  '什么', '哪些', '哪个', '哪种', '哪一', '如何', '怎么', '怎样', '为什么', '为何', '是否',
  '以下', '下列', '下面', '上述', '关于', '对于', '根据', '一项', '一个', '一种', '不是',
  '可以', '需要', '应该', '属于', '以及', '或者', '如果', '因为', '所以', '进行', '我们',
  '他们', '它们', '这个', '那个', '这些', '那些', '其中', '并且', '而且', '但是', '然后',
  '请问', '正确', '错误', '说法', '主要', '还有', '有关',
]);

/** 检索词元：中文 2 字滑窗（滤掉问句虚词）+ 拉丁词/数字（≥3 位）。 */
export function queryTerms(input: string): string[] {
  const text = String(input || '').toLowerCase();
  const out = new Set<string>();
  for (const word of text.match(/[a-z0-9]{3,}/g) || []) out.add(word);
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i += 1) {
    const gram = cjk.slice(i, i + 2);
    if (!QUERY_STOP_GRAMS.has(gram)) out.add(gram);
  }
  return [...out];
}

/** 题干关键词（保留旧接口名；实现即 queryTerms，供 `_internals` 与测试使用）。 */
export function questionTerms(question: string): string[] {
  return queryTerms(question).slice(0, 60);
}

export interface KbQuizSnippetResult {
  snippet: string;
  /** 片段来自该文档抽样要点的第几段（0-based，-1 = 没定位到）。 */
  line: number;
  source: string;
  ok: boolean;
}

/**
 * 把"抽样要点里的一段"整理成能当原文 needle 用的片段。
 *
 * 为什么必须清：`sampleDocLines` 会用 `withTitle()` 把块标题拼进正文
 * （`标题：正文`），整篇前还挂着 `## 相对路径` 头。这些是**合成的前缀**，原文里
 * 并不存在——拿去做定位时，三级匹配（精确 → 归一化 → 首词兜底）会一路掉到
 * "首词兜底"，于是首词命中的是**标题**，高亮就落在标题上、而不是题目依据的正文。
 * 砍掉前缀不损失"逐字"性质（剩下的仍是原文子串），定位精度反而回到最高一档。
 */
export function quizQuoteText(paragraph: string): string {
  let text = String(paragraph || '').replace(/^##\s+\S[^\n]*\n?/, '').trim();
  // 合成标题前缀形如 `块标题：正文`；真句子带冒号时砍掉的也是原文前缀，剩余部分照样逐字
  const head = text.match(/^([^：:。！？!?；;\n]{1,40})[：:]\s*/);
  if (head) text = text.slice(head[0].length).trim();
  return text;
}

/** 取某题来源文档里与题干/答案最相关的一段（供"查看原文片段"与「原文依据」高亮用）。 */
export function kbQuizSnippet(
  userId: string,
  opts: { question?: string; answer?: string | null; source?: string | null; dir?: string | null; spaceId?: string | null; maxChars?: number },
): KbQuizSnippetResult {
  const question = String(opts?.question || '').trim();
  const answer = String(opts?.answer || '').trim();
  const docName = String(opts?.source || '').trim();
  const all = collectReadyDocLines(userId, { dir: opts?.dir || null, spaceId: opts?.spaceId || null });
  const scoped = docName ? all.filter((l) => l.includes(docName)) : all;
  const lines = (scoped.length ? scoped : all)
    .flatMap((l) => l.split(/\n{2,}/))
    .map((para) => quizQuoteText(para))
    .filter(Boolean);
  // 答案进检索：单选题的 answer 通常就是材料里的措辞，是"哪一段是依据"的最强信号
  const picked = pickSnippet(lines, question, { maxChars: opts?.maxChars, answer });
  if (!picked) return { snippet: '', line: -1, source: docName, ok: false };
  return { snippet: picked.snippet, line: picked.line, source: docName, ok: true };
}

function trimCache(): void {
  if (cache.size <= CACHE_MAX) return;
  const first = cache.keys().next().value;
  if (first) cache.delete(first);
}

export async function kbQuiz(
  userId: string,
  opts: { dir?: string | null; spaceId?: string | null; force?: boolean; text?: string | null; count?: number },
  deps: KbQuizDeps,
): Promise<KbQuizResult> {
  const count = Math.min(MAX_COUNT, Math.max(1, Math.trunc(Number(opts?.count) || DEFAULT_COUNT)));
  // 提供 text 时基于该文本出题（对话回答 → 测验）；否则基于知识库文档要点
  const docLines = typeof opts?.text === 'string' && opts.text.trim()
    ? [opts.text.trim().slice(0, DOC_CHAR_CAP * 8)]
    : collectReadyDocLines(userId, { dir: opts?.dir || null, spaceId: opts?.spaceId || null });
  const fp = fingerprint(docLines, count);

  const hit = cache.get(fp);
  if (hit && !opts?.force) {
    return { ...hit, source: 'cached', sources: hit.sources || collectQuizSources(hit.questions) };
  }

  if (!docLines.length) {
    return { questions: [], source: 'degraded', reason: 'empty', fingerprint: fp };
  }

  const existing = inflight.get(fp);
  if (existing && !opts?.force) return existing;

  const attempt = runQuizAttempt(userId, docLines, fp, count, deps);
  inflight.set(fp, attempt);
  try {
    return await attempt;
  } finally {
    if (inflight.get(fp) === attempt) inflight.delete(fp);
  }
}

async function runQuizAttempt(
  userId: string,
  docLines: string[],
  fp: string,
  count: number,
  deps: KbQuizDeps,
): Promise<KbQuizResult> {
  const startedAt = Date.now();
  const completion = deps.complete({
    userId,
    message: `请根据以下知识库文档要点出 ${count} 道题（其中约 4/5 为单选，可含 1 道简答）：\n\n${docLines.join('\n\n')}`,
    systemPrompt: QUIZ_SYSTEM_PROMPT,
    sessionId: `aside-kbquiz-${userId}`,
  });

  try {
    const res = await withTimeout(completion, QUIZ_LLM_TIMEOUT_MS);
    if (!res.ok) throw new Error(res.error || 'model failed');
    const questions = parseQuizJson(res.text, { maxQuestions: Math.max(count, 1) });
    if (!questions.length) {
      log.warn('kb quiz unparsable, degrading', { user_id: maskId(userId) });
      return { questions: [], source: 'degraded', reason: 'unparsable', fingerprint: fp };
    }
    const result: KbQuizResult = { questions, source: 'generated', fingerprint: fp, sources: collectQuizSources(questions) };
    cache.set(fp, result);
    trimCache();
    return result;
  } catch (err) {
    const message = (err as Error).message || String(err);
    const reason = message.startsWith('LLM timeout') ? 'timeout' as const : 'model-failed' as const;
    log.warn('kb quiz failed, degrading', {
      user_id: maskId(userId),
      error: message,
      wait_ms: Date.now() - startedAt,
    });
    // 迟到结果兜底缓存：超时降级时底层请求仍在跑，成功就写缓存，用户重试秒出
    if (reason === 'timeout') {
      completion.then((res) => {
        if (!res?.ok || !res.text) return;
        const late = parseQuizJson(res.text, { maxQuestions: count });
        if (late.length) {
          cache.set(fp, { questions: late, source: 'generated', fingerprint: fp, sources: collectQuizSources(late) });
          log.info('kb quiz late result cached (arrived after timeout)', { user_id: maskId(userId) });
        }
      }).catch(() => { /* 底层失败已由降级路径覆盖 */ });
    }
    return { questions: [], source: 'degraded', reason, fingerprint: fp };
  }
}

export const _internals = {
  parseQuizJson,
  parseHintJson,
  collectQuizSources,
  pickSnippet,
  quizQuoteText,
  queryTerms,
  questionTerms,
  resolveAnswer,
  fingerprint,
  normalizeAnswerText,
  clearCacheForTests: () => {
    cache.clear();
    inflight.clear();
    hintCache.clear();
  },
};
