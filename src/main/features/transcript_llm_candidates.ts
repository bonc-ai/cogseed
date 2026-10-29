/**
 * transcript_llm_candidates — 模型纠错候选
 *
 * 字面匹配无法识别所有错写，因此让模型结合正文提出建议：
 *   - 把转写正文分段交给模型，让它自己指出"疑似写错 → 建议写法"；
 *   - 产出只是当前材料的候选，应用前须人工勾选，不自动形成长期词表规则。
 *
 * 为什么不再"先猜疑似专名、只问那几处"：那条路要求先由 `detectSuspectEntities`
 * 用词形判据（含内部大写的拉丁串 / 4 字母以上全大写）挑出可疑位置，挑不出就
 * 根本不发请求。中文转写可能没有符合该词形的片段（`roadmap`、`coxyx`
 * 这类小写英文、以及 `SpeakerA`（正则少认一个尾随大写）都命中不了），面板只会
 * 显示「没有发现疑似专名，不需要问模型」——用户看到的是"模型给不出候选"，
 * 实际是模型**没被问到**。词形判据现在降级为**重点线索**（优先看这些位置），
 * 不再是准入闸门。
 *
 * 三条硬约束（都由本模块自己保证，不依赖提示词）：
 *   1. `wrong` 必须能在该段正文里**逐字定位**，否则整条丢弃——定位不到就没有 span，
 *      连"标待核"都标不到位置。定位用折叠串做（大小写/全角不敏感），因为
 *      `foldText` 逐码点折叠且长度不变，折叠串的下标可直接当原文坐标用。
 *   2. 落进代码块 / URL 等保护区的候选一律丢弃（与扫描器同一套保护区判据）。
 *   3. 分段数、每段候选数、总候选数都有上限，超出的如实回报 `truncated`，
 *      不假装"都看过了"。
 */

import { createLogger } from '../logger';
import { buildRunner } from '../model/core-agent/runner';
import { hasConfiguredModelForUser } from './auth';
import { computeProtectedRanges, isProtected } from './transcript_auto_correct';
import { foldText } from './transcript_glossary';

const log = createLogger('transcript-llm-candidates');

/** 置信阈值：低于此值只进待确认，不允许默认接受。 */
export const LLM_CANDIDATE_MIN_CONFIDENCE = 0.7;
/** 重点线索上限（词形可疑的位置，只作为提示，不再是准入条件）。 */
export const LLM_CANDIDATE_MAX_HINTS = 30;
/**
 * 注入提示词的「错写对照」条数上限。
 *
 * 45 条词表实测约 1.2k 字符，可接受；设 200 是防词表长大后把提示词撑爆
 * （对照表按 freq/风险排序由调用方决定，这里只做硬上限）。
 */
export const LLM_CANDIDATE_MAX_PAIRS = 200;
/** 优先参考名单上限（提示词长度要可控）。 */
export const LLM_CANDIDATE_MAX_ALLOWED = 200;
/** 每段正文的字符数（太小会丢上下文，太大模型容易漏）。 */
export const REVIEW_CHUNK_CHARS = 3000;
/** 一次点击最多读几段（成本上界：8 段 ≈ 2.4 万字）。 */
export const REVIEW_MAX_CHUNKS = 8;
/** 每段最多收几条候选（防一段刷屏）。 */
export const REVIEW_MAX_PER_CHUNK = 20;
/** 单次返回的候选总数上限。 */
export const REVIEW_MAX_RESULTS = 50;

export interface SuspectHint {
  text: string;
  /** 原文偏移（仅用于提示模型"这里可疑"，不参与定位）。 */
  start: number;
}

export interface ReviewChunk {
  /** 该段在全文里的起止（原文坐标）。 */
  start: number;
  end: number;
  text: string;
}

export interface LlmCandidate {
  /** 正文里**逐字可定位**的片段（疑似错写）。 */
  wrong: string;
  /** 建议的写法。可能来自优先参考名单，也可能是模型自己的判断。 */
  correct: string;
  confidence: number;
  reason: string;
  /** 原文偏移（绝对坐标，可直接用于标待核）。 */
  start: number;
  /** 置信不足 → 只进待确认。 */
  pending: boolean;
  /** 该建议是否落在"已知写法"名单里（false = 模型自己想出来的写法）。 */
  inAllowlist: boolean;
}

export interface LlmCandidateResult {
  /** Source spans with a parseable structured review, including explicit [].
   * A model call returning prose is not evidence that a span needs no change. */
  reviewedRanges?: Array<{ start: number; end: number }>;
  candidates: LlmCandidate[];
  /** 被丢掉的模型输出（可观测：模型编了什么）。 */
  rejected: Array<{ wrong: string; correct: string; why: string }>;
  /** 其中"已知写法"名单外的条数（模型自己想出来的写法有多少条）。 */
  outsideAllowlist: number;
  /** 实际问过的段数 / 总段数（总段数 > 问过的说明达到上限）。 */
  chunksScanned: number;
  chunksTotal: number;
  /** 达到分段上限：正文还有没看的部分。 */
  truncated: boolean;
  /** 模型调用失败的段数（>0 时 UI 必须如实提示"结果可能不全"）。 */
  failedChunks: number;
  /** 没产出候选的原因（未配置模型 / 正文为空 / 所有段都失败）。 */
  skipped?: 'no_model' | 'empty_text' | 'model_failed';
  /**
   * 本次复核消耗的 token 用量（各成功段累加）。
   * 形态对齐 `RecallCaptureModelUsage`（`recall/capture-service.ts`）。
   * `runner.run()` 的 `result.meta.usage`
   * 为 `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?,
   * totalTokens }`，单位 = token 个数、整轮累加口径。
   * **测不到就缺失**：模型不可用 / 全段失败 / 注入方不回报时该字段
   * 整个不存在——不写 0 假装测到（cache 字段不在此口径内）。
   */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export const REVIEW_SYSTEM_PROMPT = [
  '你在做会议转写的"错写复核"。',
  '下面给你一段转写正文。请找出其中**看起来是语音识别写错**的地方。',
  '重点看：同音字/近音字写错、人名或术语被写成了另一个常见词、英文术语被拼错。',
  '',
  '**最重要的依据是「团队已确认的错写对照」**：那是团队自己攒下来的'
    + '"这个错形其实是那个正确写法"的记录，出现同类错写时**优先按它改**。',
  '「已知写法」列表是团队在用的规范词（人名/产品名/术语），用来判断正文里'
    + '某个词是不是本该写成其中一个。',
  '两者结合用：对照表告诉你"大家一般怎么读错"，已知写法告诉你"正确的词长什么样"。',
  '',
  // 这一句必须与实现一致：高置信且指向已知写法的会自动生效。
  '你的输出多数会**先给人复核**；但**指向已确认写法的建议可能被直接采纳**。',
  '所以：拿不准就不要给，宁可少给也不要猜。',
  '规则：',
  '1. wrong 字段必须**逐字**出现在给定正文里（程序会按字符串查找定位，找不到整条作废），'
    + '只给最小的那个错写片段，不要带整句；',
  '2. correct 给出你认为正确的写法。**如果正文里的错形与「错写对照」里某条相近，'
    + '就用那条的正确写法**；否则用「已知写法」列表里的词；'
    + '列表里确实没有合适的、你又有把握时，才写你自己的判断；',
  '3. 不要改标点、语序、口语词，不要做润色或风格改写——只找"写错了"；',
  '4. 拿不准就不要给（不要为了凑数瞎猜）；',
  '5. 每条给出 0~1 的置信度与一句理由；',
  '6. 只输出 JSON 数组，元素形如 '
    + '{"wrong":"正文片段","correct":"建议写法","confidence":0.8,"reason":"读音/上下文依据"}；',
  '7. 没有发现就输出 []。',
].join('\n');

/** 分段：优先在换行/句末断开，避免把一处错写劈成两半。 */
export function splitForReview(
  text: string,
  opts: { chunkChars?: number; maxChunks?: number } = {},
): { chunks: ReviewChunk[]; totalChunks: number; truncated: boolean } {
  const chunkChars = Math.max(200, Math.floor(opts.chunkChars ?? REVIEW_CHUNK_CHARS));
  const maxChunks = Math.max(1, Math.floor(opts.maxChunks ?? REVIEW_MAX_CHUNKS));
  const source = String(text ?? '');
  if (!source.trim()) return { chunks: [], totalChunks: 0, truncated: false };

  const all: ReviewChunk[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    let end = Math.min(source.length, cursor + chunkChars);
    if (end < source.length) {
      // 在窗口后半段找最近的断点（换行 / 句末标点），让段落边界干净些。
      const window = source.slice(Math.max(cursor, end - 400), end);
      const breakAt = Math.max(
        window.lastIndexOf('\n'),
        Math.max(
          window.lastIndexOf('。'),
          Math.max(window.lastIndexOf('？'), window.lastIndexOf('！')),
        ),
      );
      if (breakAt > 0) end = Math.max(cursor, end - 400) + breakAt + 1;
    }
    all.push({ start: cursor, end, text: source.slice(cursor, end) });
    cursor = end;
  }
  return { chunks: all.slice(0, maxChunks), totalChunks: all.length, truncated: all.length > maxChunks };
}

/** 构造请求体（纯函数，便于测试提示词契约）。 */
export function buildReviewRequest(
  chunkText: string,
  knownTargets: string[],
  hints: SuspectHint[] = [],
  correctionPairs: Array<{ wrong: string; correct: string }> = [],
): { systemPrompt: string; message: string; allowed: string[] } {
  const allowed = [...new Set((knownTargets || []).map((t) => String(t || '').trim()).filter(Boolean))]
    .slice(0, LLM_CANDIDATE_MAX_ALLOWED);
  const useHints = (hints || []).slice(0, LLM_CANDIDATE_MAX_HINTS);
  /**
   * **错写对照表**（`错形 → 正确写法`）。
   *
   * 为什么必须给：词表的核心就是这张对照表，但此前只把"正确写法"那一列
   * （`knownTargets`）平铺给模型，**错形那一列完全没给**。后果是模型只能靠
   * "这个词长得像哪个已知写法"去猜读音，猜不准就编：
   * 实测 `maas → MaaS`（团队实际指的是 MeshSeed）、`msc → MSC`。
   *
   * 给了对照表之后，模型能直接沿用团队已确认的对应关系，
   * 也可以据此推广到**相近的**新错形（这正是"泛化"该有的形态：
   * 沿已确认的读音关系外推，而不是凭空发明写法）。
   *
   * 上限保护：条数与单条长度都设限，避免提示词无限膨胀。
   */
  const pairs = (correctionPairs || [])
    .map((p) => ({ wrong: String(p?.wrong ?? '').trim(), correct: String(p?.correct ?? '').trim() }))
    .filter((p) => p.wrong && p.correct && p.wrong !== p.correct
      && p.wrong.length <= 40 && p.correct.length <= 40)
    .slice(0, LLM_CANDIDATE_MAX_PAIRS);
  const pairLines = pairs.map((p) => `- 「${p.wrong}」→「${p.correct}」`);
  const message = [
    '已知写法（团队在用的规范词，可以不限在这些里）：',
    allowed.length ? allowed.join('、') : '（无）',
    '',
    ...(pairLines.length
      ? [
        '团队已确认的错写对照（**这是最可靠的依据**：正文里出现相同或读音相近的错形，'
        + '就用右边这个正确写法；也可以据此推广到**读音相近的**新错形）：',
        ...pairLines,
        '',
      ]
      : []),
    ...(useHints.length
      ? ['重点线索（这些位置的词形可疑，优先看看，但不限于这些）：', useHints.map((h) => h.text).join('、'), '']
      : []),
    '正文：',
    chunkText,
  ].join('\n');
  return { systemPrompt: REVIEW_SYSTEM_PROMPT, message, allowed };
}

/** 从模型文本里抠出 JSON 数组（模型常包在 ```json 里或加解释）。 */
function extractJsonArray(raw: string): unknown[] | null {
  const text = String(raw || '').trim();
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

/**
 * 在一段正文里定位 `wrong` 的**所有**出现处。用折叠串找（大小写/全角不敏感），
 * 因为 `foldText` 逐码点折叠、折叠后长度与原文一致，下标可直接当原文坐标。
 * 返回的是**该段内**的相对偏移，以及**命中片段的长度**（= 折叠后 needle 的长度，
 * 不是模型回传字符串的长度：模型偶尔会在片段两头带空格/引号，
 * 用它的长度去切原文会让 span 比实际多算几个字符）。
 */
function locateAll(chunkText: string, wrong: string): Array<{ at: number; length: number }> {
  const needle = foldText(String(wrong ?? '')).trim();
  if (!needle) return [];
  const haystack = foldText(chunkText);
  const out: Array<{ at: number; length: number }> = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out.push({ at, length: needle.length });
    from = at + Math.max(1, needle.length);
    if (out.length > 50) break; // 一段里同一片段出现太多次没有复核价值
  }
  return out;
}

/**
 * 解析一段的模型输出。
 *
 * 丢掉的是**定位不了的**（`wrong` 在该段正文里找不到 ⇒ 没有 span ⇒ 连"标待核"
 * 都标不到位置）与自相矛盾的（目标与错形逐字相同）。名单外的写法**不丢**，
 * 只标 `inAllowlist: false` —— 名单已降级为优先参考，静默丢弃会让"模型到底
 * 说了什么"变得不可观测。
 */
export function parseReviewResponse(
  raw: string,
  chunkText: string,
  chunkOffset: number,
  knownTargets: string[],
): { candidates: LlmCandidate[]; rejected: Array<{ wrong: string; correct: string; why: string }> } {
  const allowedSet = new Set((knownTargets || []).map((t) => String(t || '').trim()).filter(Boolean));
  const list = extractJsonArray(raw);
  if (!list) return { candidates: [], rejected: [] };
  const candidates: LlmCandidate[] = [];
  const rejected: Array<{ wrong: string; correct: string; why: string }> = [];

  for (const item of list) {
    const row = item as Partial<{ wrong: unknown; correct: unknown; confidence: unknown; reason: unknown }>;
    const wrong = String(row?.wrong ?? '').trim();
    const correct = String(row?.correct ?? '').trim();
    if (!wrong || !correct) continue;
    if (wrong === correct) {
      rejected.push({ wrong, correct, why: 'identical_pair' });
      continue;
    }
    // 「xrd → ?」: the model admits it does not know the right form. A target
    // without any letter, digit or CJK character is never a correction.
    if (!/[\p{L}\p{N}]/u.test(correct)) {
      rejected.push({ wrong, correct, why: 'placeholder_target' });
      continue;
    }
    // 按折叠串定位（大小写/全角差异不该让候选作废；定位不到就没有 span）
    const hits = locateAll(chunkText, wrong);
    if (hits.length === 0) {
      rejected.push({ wrong, correct, why: 'not_in_text' });
      continue;
    }
    const confidenceRaw = Number(row?.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    const reason = String(row?.reason ?? '').slice(0, 200);
    for (const { at, length } of hits) {
      const absolute = chunkOffset + at;
      candidates.push({
        // 用正文里的**原文**片段（而不是模型回的字符串）：大小写/全角由正文说了算，
        // 这样 span 与 text 严格对齐。
        wrong: chunkText.slice(at, at + length),
        correct,
        confidence,
        reason,
        start: absolute,
        pending: confidence < LLM_CANDIDATE_MIN_CONFIDENCE,
        inAllowlist: allowedSet.has(correct),
      });
    }
  }

  // 同一位置同一目标只留一条（折叠串定位可能让重复项撞在一起）
  const best = new Map<string, LlmCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.start}|${candidate.correct}`;
    const current = best.get(key);
    if (!current || candidate.confidence > current.confidence) best.set(key, candidate);
  }
  const sorted = [...best.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, REVIEW_MAX_PER_CHUNK);
  return { candidates: sorted, rejected };
}

/** 单次调用的 token 用量（`runner.run()` 的 `result.meta.usage` 子集）。 */
export interface ReviewModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** 累加一段的用量（只认有限非负数；一段没报任何字段就不计——不写 0 假装测到）。 */
function addUsage(total: ReviewModelUsage | undefined, incoming: ReviewModelUsage | undefined): ReviewModelUsage | undefined {
  if (!incoming) return total;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const next: ReviewModelUsage = { ...(total ?? {}) };
  let touched = false;
  if (ok(incoming.inputTokens)) { next.inputTokens = (next.inputTokens ?? 0) + incoming.inputTokens; touched = true; }
  if (ok(incoming.outputTokens)) { next.outputTokens = (next.outputTokens ?? 0) + incoming.outputTokens; touched = true; }
  if (ok(incoming.totalTokens)) { next.totalTokens = (next.totalTokens ?? 0) + incoming.totalTokens; touched = true; }
  return touched ? next : total;
}

export interface GenerateReviewOptions {
  /** 优先参考名单（词表正确写法 + 本体分组字段值）。 */
  knownTargets?: string[];
  /**
   * **错写对照表**（`错形 → 正确写法`），来自用户的纠错词表。
   *
   * 这是本模块**最可靠的依据**：团队自己确认过"这个错形其实是那个正确写法"。
   * 不给它，模型就只能靠"长得像哪个已知写法"猜读音，猜不准就编
   * （实测 `maas → MaaS`，团队实际指的是 MeshSeed）。
   */
  correctionPairs?: Array<{ wrong: string; correct: string }>;
  /** 词形判据找出的可疑位置：只作为提示。 */
  hints?: SuspectHint[];
  /**
   * 测试注入：给定提示词返回模型文本。返回纯字符串 = 不带用量；
   * 返回 `{ text, usage? }` = 连同该段 token 用量一起回报；仍兼容只返回字符串的注入方。
   */
  runModel?: (
    input: { systemPrompt: string; message: string },
  ) => Promise<string | { text: string; usage?: ReviewModelUsage }>;
  sessionKey?: string;
  chunkChars?: number;
  maxChunks?: number;
}

/**
 * 读正文提候选：分段 → 逐段问模型 → 定位 → 过滤保护区 → 汇总。
 *
 * 语义要点：
 *   - 只在"正文为空"或"未配置模型"时才完全不发请求；
 *   - 单段失败**不拖垮**其余段：如实累计 `failedChunks`，结果可能不全要让人看得见；
 *   - 所有段都失败才报 `skipped: 'model_failed'`。
 */
export async function generateReviewCandidates(
  userId: string,
  text: string,
  options: GenerateReviewOptions = {},
): Promise<LlmCandidateResult> {
  const base = {
    reviewedRanges: [] as Array<{ start: number; end: number }>,
    candidates: [] as LlmCandidate[],
    rejected: [] as Array<{ wrong: string; correct: string; why: string }>,
    outsideAllowlist: 0,
    chunksScanned: 0,
    chunksTotal: 0,
    truncated: false,
    failedChunks: 0,
  };
  const { chunks, totalChunks, truncated } = splitForReview(text, {
    ...(options.chunkChars ? { chunkChars: options.chunkChars } : {}),
    ...(options.maxChunks ? { maxChunks: options.maxChunks } : {}),
  });
  base.chunksTotal = totalChunks;
  base.truncated = truncated;
  if (chunks.length === 0) return { ...base, skipped: 'empty_text' };
  // 按**传入的 uid** 判断，不用"当前活动用户"：本模块的调用方已经拿着 uid，
  // 依赖活动用户指针会在指针过期/多账号切换时误报"未配置模型"。
  if (!options.runModel && !hasConfiguredModelForUser(userId).configured) {
    return { ...base, skipped: 'no_model' };
  }

  const knownTargets = options.knownTargets ?? [];
  const protectedRanges = computeProtectedRanges(String(text ?? ''));
  const merged = new Map<string, LlmCandidate>();
  const rejectedAll: Array<{ wrong: string; correct: string; why: string }> = [];
  let failedChunks = 0;
  // token 用量只累计成功段：失败段没有可信读数，缺失比编 0 诚实。
  let usageTotal: ReviewModelUsage | undefined;

  for (const chunk of chunks) {
    // 该段的重点线索：只带落在这一段里的
    const hints = (options.hints ?? []).filter(
      (h) => h.start >= chunk.start && h.start < chunk.end,
    );
    const request = buildReviewRequest(chunk.text, knownTargets, hints, options.correctionPairs ?? []);
    let raw = '';
    try {
      if (options.runModel) {
        const outcome = await options.runModel({ systemPrompt: request.systemPrompt, message: request.message });
        if (typeof outcome === 'string') {
          raw = outcome;
        } else {
          raw = String(outcome?.text ?? '');
          usageTotal = addUsage(usageTotal, outcome?.usage);
        }
      } else {
        const { runner } = await buildRunner({
          sessionId: `transcript-llm-${options.sessionKey ?? userId}`,
          userId,
          systemPrompt: request.systemPrompt,
          disableTools: true,
          ephemeralSession: true,
          skillList: [],
        });
        const result = await runner.run({ message: request.message, thinkingLevel: 'off', cacheRetention: 'none' });
        if (result.meta.aborted || result.meta.error) {
          log.warn('review model unavailable', {
            aborted: !!result.meta.aborted,
            error: result.meta.error ? String(result.meta.error).slice(0, 200) : undefined,
          });
          failedChunks += 1;
          continue;
        }
        // meta.usage 为整轮累加口径（inputTokens/outputTokens/totalTokens，
        // token 个数）；cacheRead/cacheWrite 不进本口径。键名已按 runner 类型核实。
        usageTotal = addUsage(usageTotal, result.meta.usage);
        raw = result.text;
      }
    } catch (error) {
      log.warn('review model call failed', { error: (error as Error).message });
      failedChunks += 1;
      continue;
    }

    const reviewRows = extractJsonArray(raw);
    if (reviewRows && reviewRows.every(row => row && typeof row === 'object'
      && 'wrong' in row && typeof row.wrong === 'string' && row.wrong.trim()
      && 'correct' in row && typeof row.correct === 'string' && row.correct.trim())) {
      base.reviewedRanges.push({ start: chunk.start, end: chunk.end });
    }
    const parsed = parseReviewResponse(raw, chunk.text, chunk.start, knownTargets);
    rejectedAll.push(...parsed.rejected);
    base.chunksScanned += 1;
    // 只记**计数**，不记模型输出或正文（正文是用户内容，不进日志）。
    // 这一步是"模型到底答了没、答的东西能不能解析"的唯一可观测点：
    // rawChars>0 而 parsed=0 时，要么模型确实说"没有"，要么输出没被解析出来。
    if (parsed.candidates.length === 0 && parsed.rejected.length === 0) {
      log.info('review chunk yielded nothing', {
        rawChars: String(raw || '').length,
        looksLikeJson: /\[\s*[{[]/.test(String(raw || '')),
      });
    } else {
      log.info('review chunk parsed', { rawChars: String(raw || '').length, parsed: parsed.candidates.length });
    }
    for (const candidate of parsed.candidates) {
      const span = { start: candidate.start, end: candidate.start + candidate.wrong.length };
      // 保护区（代码块 / URL）：与扫描器同一套判据，不在这里提候选。
      if (isProtected(protectedRanges, span)) {
        rejectedAll.push({ wrong: candidate.wrong, correct: candidate.correct, why: 'protected_region' });
        continue;
      }
      const key = `${candidate.start}|${candidate.correct}`;
      const current = merged.get(key);
      if (!current || candidate.confidence > current.confidence) merged.set(key, candidate);
    }
  }

  const candidates = [...merged.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, REVIEW_MAX_RESULTS);
  const result: LlmCandidateResult = {
    ...base,
    candidates,
    rejected: rejectedAll.slice(0, 100),
    outsideAllowlist: candidates.filter((c) => !c.inAllowlist).length,
    failedChunks,
  };
  // 测不到就整个缺失：一次用量都没读到（模型不可用/全段失败/注入方不回报）
  // 时不出 usage 字段，更不写 0 假装测到。
  if (usageTotal) result.usage = usageTotal;
  if (base.chunksScanned === 0 && failedChunks > 0) result.skipped = 'model_failed';
  return result;
}
