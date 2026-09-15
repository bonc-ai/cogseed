/**
 * transcript_llm_candidates — 受约束的 LLM 候选（方案 v0.2 §五 P2-1）
 *
 * 为什么要有这一层：字面匹配救不了 `roadmap` 这种"音不近、形不近"的错写
 * （09-14 对照里它其实指 `Raymond`）。方案给的做法是 **受约束纠错**：
 *   - 只对"疑似专名但词表/记忆分组里都没有"的位置发起（`detectSuspectEntities`）；
 *   - 模型只能从**白名单**（词表正确写法 + 记忆分组字段值）里挑目标，
 *     挑不出就返回空 —— 任何白名单外的目标**一律丢弃**；
 *   - 低置信只进"待确认"，绝不自动替换（替换仍由既有护栏/风险分级管）。
 *
 * 本模块只负责"问得清楚 + 收得干净"：
 *   - `buildCandidateRequest`（纯函数）：构造一次性小请求的提示词；
 *   - `parseCandidateResponse`（纯函数）：解析并把白名单外的目标全部丢掉；
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
/** 白名单上限（提示词长度要可控）。 */
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
  /** 建议的正确写法 —— **保证在白名单内**。 */
  correct: string;
  confidence: number;
  reason: string;
  /** 原文偏移。 */
  start: number;
  /** 置信不足 → 只能进待确认。 */
  pending: boolean;
}

export interface LlmCandidateResult {
  candidates: LlmCandidate[];
  /** 被白名单挡掉的模型输出（可观测：模型编了什么）。 */
  rejected: Array<{ wrong: string; correct: string; why: string }>;
  /** 没发请求的原因（未配置模型 / 没有疑似专名 / 白名单为空）。 */
  skipped?: 'no_model' | 'no_suspects' | 'no_allowed' | 'model_failed';
}

export const LLM_CANDIDATE_SYSTEM_PROMPT = [
  '你在做会议转写的"受约束纠错"。',
  '输入给出若干疑似专名（转写里出现但不认识的写法）及其上下文。',
  '你只能从给定的「允许目标」列表中挑选最可能的正确写法。',
  '规则：',
  '1. 允许目标列表之外的名字**绝对不要**输出（宁可说没有）；',
  '2. 拿不准就不要给（不要为了凑数瞎猜）；',
  '3. 每条给出 0~1 的置信度与一句理由；',
  '4. 只输出 JSON 数组，元素形如 '
    + '{"wrong":"原文片段","correct":"允许目标之一","confidence":0.8,"reason":"读音/上下文依据"}；',
  '5. 没有把握就输出 []。',
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
    '允许目标：',
    allowed.length ? allowed.join('、') : '（空）',
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
 * 解析模型输出：白名单外的目标、格式不对的项、置信度越界的项**全部丢弃**，
 * 并如实记录被挡掉的内容（可观测模型编了什么）。
 */
export function parseCandidateResponse(
  raw: string,
  suspects: SuspectForModel[],
  allowedTargets: string[],
): { candidates: LlmCandidate[]; rejected: Array<{ wrong: string; correct: string; why: string }> } {
  const allowedSet = new Set((allowedTargets || []).map((t) => String(t || '').trim()).filter(Boolean));
  const byText = new Map(suspects.map((item) => [item.text, item]));
  const list = extractJsonArray(raw);
  if (!list) return { candidates: [], rejected: [] };
  const candidates: LlmCandidate[] = [];
  const rejected: Array<{ wrong: string; correct: string; why: string }> = [];
  for (const item of list) {
    const row = item as Partial<{ wrong: unknown; correct: unknown; confidence: unknown; reason: unknown }>;
    const wrong = String(row?.wrong ?? '').trim();
    const correct = String(row?.correct ?? '').trim();
    if (!wrong || !correct) continue;
    if (!allowedSet.has(correct)) {
      rejected.push({ wrong, correct, why: 'not_in_allowlist' });
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
    });
  }
  // 同一位置多条只留置信最高的（模型偶尔会给两个目标）
  const best = new Map<string, LlmCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.start}|${candidate.wrong}`;
    const current = best.get(key);
    if (!current || candidate.confidence > current.confidence) best.set(key, candidate);
  }
  return { candidates: [...best.values()].sort((a, b) => b.confidence - a.confidence), rejected };
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
  if (request.useSuspects.length === 0) return { candidates: [], rejected: [], skipped: 'no_suspects' };
  if (request.allowed.length === 0) return { candidates: [], rejected: [], skipped: 'no_allowed' };
  if (!options.runModel && !hasConfiguredModel().configured) {
    return { candidates: [], rejected: [], skipped: 'no_model' };
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
        return { candidates: [], rejected: [], skipped: 'model_failed' };
      }
      raw = result.text;
    }
  } catch (error) {
    log.warn('candidate model call failed', { error: (error as Error).message });
    return { candidates: [], rejected: [], skipped: 'model_failed' };
  }
  const parsed = parseCandidateResponse(raw, request.useSuspects, request.allowed);
  return { ...parsed };
}
