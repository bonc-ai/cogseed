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
/** 拼音 LLM 单次出题超时：与 kb_mindmap 同款预算（含排队+推理+流式输出）。 */
const QUIZ_LLM_TIMEOUT_MS = 120 * 1000;
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

const QUIZ_SYSTEM_PROMPT = `你是知识库测验出题助手。根据提供的文档要点出题，只输出 JSON，不要任何额外文字：
{"questions":[{"type":"single","question":"题干","options":["选项1","选项2","选项3","选项4"],"answer":"选项2","explain":"一句话解析","source":"来源文档名"},{"type":"short","question":"题干","options":[],"answer":"参考答案","explain":"一句话解析","source":"来源文档名"}]}
要求：
1. 单选题 4 个选项，**只有一个正确**，干扰项要似是而非（同领域概念，不要明显离谱）；
2. 「answer」写**选项原文**（不要只写 A/B/C/D）；
3. 考"理解与应用"（概念辨析、原理、为什么），不要考文件名、页码、章节号这类只有翻书才知道的记忆点；
4. 每题都要有 explain（一句话说清为什么）和 source（取自哪份文档，没有就留空字符串）；
5. 简答题的 answer **只给要点**：1–3 条，每条不超过 20 字，用「；」分隔，不要写成
   一段话（参考答案是给人对照的，不是复述原文）；需要展开的解释放 explain；
6. 题目之间不要重复考同一个点。`;

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
  resolveAnswer,
  fingerprint,
  normalizeAnswerText,
  clearCacheForTests: () => {
    cache.clear();
    inflight.clear();
    hintCache.clear();
  },
};
