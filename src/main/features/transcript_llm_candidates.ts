/**
 * transcript_llm_candidates — 模型纠错候选（方案 v0.2 §五 P2-1）
 *
 * 为什么要有这一层：字面匹配救不了 `roadmap` 这种"音不近、形不近"的错写
 * （09-14 对照里它其实指 `SpeakerA`）。做法是 **受约束纠错**：
 *   - 只对"疑似专名但词表/记忆分组里都没有"的位置发起（`detectSuspectEntities`）；
 *   - 模型优先从**已知写法**列表里挑目标；列表里没有合适的，允许给出自己的写法，
 *     并用 `inAllowlist: false` 标出来（复核时能一眼区分"词表已有的写法"与
 *     "模型自己想的写法"）；
 *   - **无论哪种，产出都只是候选**：只落进词表文件的候选区、只能被"标待核"。
 *     要变成扫描规则必须由人显式确认（见 transcript_glossary.adoptCandidate）。
 *
 * 所以"白名单"在这里已从**硬性闸门**降级为**优先参考**：真正的闸门是
 * "候选区 ≠ 词条区"这层结构隔离。硬性白名单曾把模型的用处压得很小
 * （候选只能来自词表已有正确写法 ⇒ 只能发现"已知词的错写"），而它原本要防的
 * "模型瞎编"风险，现在由"候选不生效"兜住——这比靠提示词约束更可靠。
 *
 * 本模块只负责"问得清楚 + 收得干净"：
 *   - `buildCandidateRequest`（纯函数）：构造一次性小请求的提示词；
 *   - `parseCandidateResponse`（纯函数）：解析、标注是否落在已知写法里、丢掉定位不了的；
 *   - `generateCandidates`（IO）：可注入 `runModel`，模型不可用时如实返回空 + 原因。
 */

import { createLogger } from '../logger';
import { buildRunner } from '../model/core-agent/runner';
import { hasConfiguredModel } from './auth';

const log = createLogger('transcript-llm-candidates');

/** 置信阈值：低于此值只进待确认，不允许默认接受。 */
export const LLM_CANDIDATE_MIN_CONFIDENCE = 0.7;
/** 疑似专名上限（一次请求最多问这么多处）。 */
export const LLM_CANDIDATE_MAX_SUSPECTS = 30;
/** 已知写法（优先参考名单）上限（提示词长度要可控）。 */
export const LLM_CANDIDATE_MAX_ALLOWED = 200;

export interface SuspectForModel {
  text: string;
  /** 该疑似词在原文里的**上下文**（便于模型判断是不是某个词的误写）。 */
  context: string;
  /** 原文偏移（回传时用它定位）。 */
  start: number;
}

export interface LlmCandidate {
  /** 原文里的片段（疑似错写）。 */
  wrong: string;
  /** 建议的写法。可能来自已知写法名单，也可能是模型自己的判断。 */
  correct: string;
  confidence: number;
  reason: string;
  /** 原文偏移。 */
  start: number;
  /** 置信不足 → 只能进待确认。 */
  pending: boolean;
  /** 该建议是否落在"已知写法"名单里（false = 模型自己想出来的写法）。 */
  inAllowlist: boolean;
}

export interface LlmCandidateResult {
  candidates: LlmCandidate[];
  /** 被丢掉的模型输出（可观测：模型编了什么）。**只**含定位不了的/自相矛盾的。 */
  rejected: Array<{ wrong: string; correct: string; why: string }>;
  /** 其中"已知写法"名单外的条数（模型自己想出来的写法有多少条）。 */
  outsideAllowlist: number;
  /** 没发请求的原因（未配置模型 / 没有疑似专名 / 模型调用失败）。 */
  skipped?: 'no_model' | 'no_suspects' | 'model_failed';
}

export const LLM_CANDIDATE_SYSTEM_PROMPT = [
  '你在做会议转写的错写筛查。',
  '输入给出若干疑似专名（转写里出现但不认识的写法）及其上下文。',
  '你的输出只作为**给人复核的候选**，不会被自动采纳，也不会直接生效。',
  '规则：',
  '1. 「已知写法」列表是优先参考：如果某个疑似写法其实是列表里某个词的误写，优先选它；',
  '2. 列表里没有合适的、但你从读音或上下文能确定正确写法时，可以给出你自己的写法；',
  '3. 拿不准就不要给（不要为了凑数瞎猜）；',
  '4. 每条给出 0~1 的置信度与一句理由；',
  '5. 只输出 JSON 数组，元素形如 '
    + '{"wrong":"原文片段","correct":"建议写法","confidence":0.8,"reason":"读音/上下文依据"}；',
  '6. 没有把握就输出 []。',
].join('\n');

/** 构造请求体（纯函数，便于测试提示词契约）。 */
export function buildCandidateRequest(
  suspects: SuspectForModel[],
  allowedTargets: string[],
): { systemPrompt: string; message: string; useSuspects: SuspectForModel[]; allowed: string[] } {
  const useSuspects = (suspects || []).slice(0, LLM_CANDIDATE_MAX_SUSPECTS);
  const allowed = [...new Set((allowedTargets || []).map((t) => String(t || '').trim()).filter(Boolean))]
    .slice(0, LLM_CANDIDATE_MAX_ALLOWED);
  const message = [
    // 名单为空也要照常问：放开白名单后"已知写法为零"不再是发不出请求的理由。
    '已知写法（优先参考）：',
    allowed.length ? allowed.join('、') : '（无；请完全依据上下文判断）',
    '',
    '疑似专名与上下文：',
    ...useSuspects.map((item, index) => `${index + 1}. ${item.text}　上下文：${item.context}`),
  ].join('\n');
  return { systemPrompt: LLM_CANDIDATE_SYSTEM_PROMPT, message, useSuspects, allowed };
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
 * 解析模型输出。丢掉的是**定位不了的**（`wrong` 不是本次问过的疑似专名 ⇒ 无法映射回
 * span ⇒ 连"标待核"都标不到位置）和自相矛盾的（目标与错形相同、字段缺失）。
 *
 * **不再**因为目标不在"已知写法"名单里就丢弃：名单已降级为优先参考，
 * 名单外的写法只是标上 `inAllowlist: false` 交给人工复核，不静默消失——
 * 静默丢弃会让"模型到底说了什么"变得不可观测。
 */
export function parseCandidateResponse(
  raw: string,
  suspects: SuspectForModel[],
  allowedTargets: string[],
): { candidates: LlmCandidate[]; rejected: Array<{ wrong: string; correct: string; why: string }>; outsideAllowlist: number } {
  const allowedSet = new Set((allowedTargets || []).map((t) => String(t || '').trim()).filter(Boolean));
  const byText = new Map(suspects.map((item) => [item.text, item]));
  const list = extractJsonArray(raw);
  if (!list) return { candidates: [], rejected: [], outsideAllowlist: 0 };
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
    const suspect = byText.get(wrong);
    if (!suspect) {
      rejected.push({ wrong, correct, why: 'unknown_span' });
      continue;
    }
    const confidenceRaw = Number(row?.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    candidates.push({
      wrong,
      correct,
      confidence,
      reason: String(row?.reason ?? '').slice(0, 200),
      start: suspect.start,
      pending: confidence < LLM_CANDIDATE_MIN_CONFIDENCE,
      inAllowlist: allowedSet.has(correct),
    });
  }
  // 同一位置多条只留置信最高的（模型偶尔会给两个目标）
  const best = new Map<string, LlmCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.start}|${candidate.wrong}`;
    const current = best.get(key);
    if (!current || candidate.confidence > current.confidence) best.set(key, candidate);
  }
  const sorted = [...best.values()].sort((a, b) => b.confidence - a.confidence);
  return { candidates: sorted, rejected, outsideAllowlist: sorted.filter((c) => !c.inAllowlist).length };
}

export interface GenerateOptions {
  /** 测试注入：给定提示词返回模型文本。 */
  runModel?: (input: { systemPrompt: string; message: string }) => Promise<string>;
  sessionKey?: string;
}

/**
 * 一次性小调用：仅当"有疑似专名 + 白名单非空 + 模型已配置"才发请求。
 * 失败/未配置一律返回空并把原因说清（不假装问过模型）。
 */
export async function generateCandidates(
  userId: string,
  suspects: SuspectForModel[],
  allowedTargets: string[],
  options: GenerateOptions = {},
): Promise<LlmCandidateResult> {
  const request = buildCandidateRequest(suspects, allowedTargets);
  // 注意：**已知写法名单为空也照样问**（放开白名单后"词表里没有合适目标"
  // 恰恰是最需要模型看一眼的情况）；只有"没有疑似专名"才不值得发请求。
  if (request.useSuspects.length === 0) return { candidates: [], rejected: [], outsideAllowlist: 0, skipped: 'no_suspects' };
  if (!options.runModel && !hasConfiguredModel().configured) {
    return { candidates: [], rejected: [], outsideAllowlist: 0, skipped: 'no_model' };
  }
  let raw = '';
  try {
    if (options.runModel) {
      raw = await options.runModel({ systemPrompt: request.systemPrompt, message: request.message });
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
        log.warn('candidate model unavailable', {
          aborted: !!result.meta.aborted,
          error: result.meta.error ? String(result.meta.error).slice(0, 200) : undefined,
        });
        return { candidates: [], rejected: [], outsideAllowlist: 0, skipped: 'model_failed' };
      }
      raw = result.text;
    }
  } catch (error) {
    log.warn('candidate model call failed', { error: (error as Error).message });
    return { candidates: [], rejected: [], outsideAllowlist: 0, skipped: 'model_failed' };
  }
  const parsed = parseCandidateResponse(raw, request.useSuspects, request.allowed);
  return { ...parsed };
}
