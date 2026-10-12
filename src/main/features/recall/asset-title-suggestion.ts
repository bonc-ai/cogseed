/**
 * LLM 起标题共享函数（设计《认知资产-四病整改设计-20260928》3.2/3.5 配套）。
 *
 * 输入 statement + type，输出一个**过 3.1 判定**的合规标题。供晋升线（不合规
 * summary 兜底）、存量「标题重起」轮（3.3）、跨会话记忆修正线（旧标题缺失或
 * 不合规时）调用；本文件只交付函数，不接调用方。
 *
 * 模型链与失败口径与 capture/skill-draft 同款：buildRunner（ephemeral、
 * disableTools）+ 严格 JSON 解析 + 分类失败码；开跑前 `hasConfiguredModelForUser`
 * 预检，不通过**明示失败**、不静默跳过（设计 3.3 模型预检口径）。输出不合规
 * （含非 JSON、超长、抄正文开头、标点结尾）按可重试处理：携带失败原因重试，
 * 总尝试次数（默认 3）耗尽后抛 `invalid_model_output`。
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { buildRunner } from '../../model/core-agent/runner';
import { safeId } from '../../storage';
import { getConfiguredModelOAuthExpiredMessage, hasConfiguredModelForUser } from '../auth';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { recallTitleIssue } from './title-policy';

const log = createLogger('recall.assetTitleSuggestion');

export type AbilityAssetType = RecallAbilityAssetRecord['type'];

export type AbilityAssetTitleSuggestionFailureCode =
  | 'model_not_configured'
  | 'model_auth_required'
  | 'model_timeout'
  | 'model_failed'
  | 'invalid_model_output';

export class AbilityAssetTitleSuggestionFailure extends Error {
  readonly code: AbilityAssetTitleSuggestionFailureCode;

  constructor(code: AbilityAssetTitleSuggestionFailureCode, message: string) {
    super(message);
    this.name = 'AbilityAssetTitleSuggestionFailure';
    this.code = code;
  }
}

const FAILURE_MESSAGES: Record<AbilityAssetTitleSuggestionFailureCode, string> = {
  model_not_configured: '尚未配置可用模型，无法自动起标题。',
  model_auth_required: '模型授权已失效，无法自动起标题。',
  model_timeout: '模型起标题超时。',
  model_failed: '模型未能给出标题。',
  invalid_model_output: '模型多次给出的标题都不合规。',
};

/** 重试提示里给模型看的「为什么不合格」。 */
const ISSUE_HINTS: Record<string, string> = {
  empty: '标题为空',
  too_long: '含汉字时超过 16 字（不含汉字时超过 60 字符）',
  prefix_overlap: '第一个字与正文第一个字相同（不得与正文开头重复）',
  punctuation_suffix: '以标点符号结尾',
};

function safeFailureMessage(code: AbilityAssetTitleSuggestionFailureCode): string {
  return FAILURE_MESSAGES[code];
}

export interface AbilityAssetTitleSuggestionOptions {
  signal?: AbortSignal;
  /** 总尝试次数（含首次）。默认 3：给不合规输出与瞬时失败各留一次重试。 */
  attempts?: number;
}

export interface AbilityAssetTitleSuggestion {
  title: string;
  providerId?: string;
  modelId?: string;
}

const TYPE_HINTS: Record<AbilityAssetType, string> = {
  personal: '个人偏好或身份事实（如沟通偏好、工作习惯）',
  rule: '做事规则或约束（遇到什么情况该怎么做）',
  template: '可复用的产出模板或结构',
  skill_method: '可复用的方法或流程',
  fact: '项目/领域的事实信息',
};

function titleSystemPrompt(): string {
  return [
    '你为一条「认知资产」起标题。资产正文在下一条消息里给出。',
    '要求：',
    '1. 标题是名词性短语，独立可读，不写成完整句子；',
    '2. 含汉字时不超过 16 个字；不含汉字时不超过 60 个字符；',
    '3. 不得与正文开头重复（第一个字都不能与正文第一个字相同）；',
    '4. 不以任何标点符号结尾；',
    '5. 概括正文的核心含义，可以换用正文里没有出现的词；',
    '6. 只输出严格 JSON：{"title":"标题"}，不要输出其他任何内容。',
  ].join('\n');
}

function titleUserMessage(statement: string, type: AbilityAssetType): string {
  return [
    `资产类型：${type}（${TYPE_HINTS[type] || type}）`,
    '资产正文：',
    String(statement || '').trim(),
  ].join('\n');
}

/** 容错解析模型输出（与 capture-service parseCaptureJson 同款）：剥 markdown
 *  围栏、隔离最外层 {...}、JSON.parse；任何一步失败都按 invalid_model_output
 *  重试，不把围栏当硬失败。 */
function parseSuggestedTitle(raw: string): string {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AbilityAssetTitleSuggestionFailure('invalid_model_output', safeFailureMessage('invalid_model_output'));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AbilityAssetTitleSuggestionFailure('invalid_model_output', safeFailureMessage('invalid_model_output'));
  }
  const title = (parsed as { title?: unknown }).title;
  if (typeof title !== 'string' || !title.trim()) {
    throw new AbilityAssetTitleSuggestionFailure('invalid_model_output', safeFailureMessage('invalid_model_output'));
  }
  return title.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function classifyModelException(error: unknown): AbilityAssetTitleSuggestionFailureCode {
  if (getConfiguredModelOAuthExpiredMessage()) return 'model_auth_required';
  const value = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  return /timeout|timed out/i.test(value) ? 'model_timeout' : 'model_failed';
}

/**
 * 输入 statement + type，让模型起一个过 3.1 判定的合规标题。
 *
 * 失败一律抛 `AbilityAssetTitleSuggestionFailure`（带稳定失败码），调用方据此
 * 明示失败或走各自兜底——本函数不静默降级、不自己编标题（机器编的标题会
 * 重复「正文首句截断」的老病，正是要修的东西）。
 */
export async function suggestAbilityAssetTitle(
  userId: string,
  input: { statement: string; type: AbilityAssetType },
  options: AbilityAssetTitleSuggestionOptions = {},
): Promise<AbilityAssetTitleSuggestion> {
  if (!safeId(userId)) throw new AbilityAssetTitleSuggestionFailure('model_failed', safeFailureMessage('model_failed'));
  const statement = String(input.statement || '').replace(/\s+/g, ' ').trim().slice(0, 4_000);
  if (!statement) {
    // 没有正文就没有可概括的对象：这是调用方的数据错误，不是模型失败，
    // 用 model_failed 码明示，不编造标题。
    throw new AbilityAssetTitleSuggestionFailure('model_failed', '资产正文为空，无法起标题。');
  }
  const maxAttempts = Number.isSafeInteger(options.attempts) && Number(options.attempts) > 0
    ? Number(options.attempts)
    : 3;

  // 模型预检（设计 3.3）：不通过则明示失败、勿静默跳过——模型配置在加密文件
  // 里无法离线确证，开跑前必须探测。
  if (!hasConfiguredModelForUser(userId).configured) {
    throw new AbilityAssetTitleSuggestionFailure('model_not_configured', safeFailureMessage('model_not_configured'));
  }
  if (getConfiguredModelOAuthExpiredMessage()) {
    throw new AbilityAssetTitleSuggestionFailure('model_auth_required', safeFailureMessage('model_auth_required'));
  }

  let message = titleUserMessage(statement, input.type);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new AbilityAssetTitleSuggestionFailure('model_failed', safeFailureMessage('model_failed'));
    }
    let built: Awaited<ReturnType<typeof buildRunner>>;
    try {
      built = await buildRunner({
        sessionId: `asset-title-suggest-${randomUUID()}`,
        userId,
        systemPrompt: titleSystemPrompt(),
        disableTools: true,
        ephemeralSession: true,
        skillList: [],
      });
    } catch (error) {
      const code = classifyModelException(error);
      if (attempt < maxAttempts && code !== 'model_auth_required') continue;
      throw new AbilityAssetTitleSuggestionFailure(code, safeFailureMessage(code));
    }
    let result: Awaited<ReturnType<typeof built.runner.run>>;
    try {
      result = await built.runner.run({
        message,
        ...(options.signal ? { signal: options.signal } : {}),
        thinkingLevel: 'off',
        cacheRetention: 'none',
        ...(built.turnEphemeral ? { turnEphemeral: built.turnEphemeral } : {}),
      });
    } catch (error) {
      const code = classifyModelException(error);
      if (attempt < maxAttempts && code !== 'model_auth_required') continue;
      throw new AbilityAssetTitleSuggestionFailure(code, safeFailureMessage(code));
    }
    if (result.meta.error) {
      const code: AbilityAssetTitleSuggestionFailureCode = result.meta.error.kind === 'auth'
        ? 'model_auth_required'
        : result.meta.error.kind === 'timeout'
          ? 'model_timeout'
          : 'model_failed';
      if (attempt < maxAttempts && code !== 'model_auth_required') continue;
      throw new AbilityAssetTitleSuggestionFailure(code, safeFailureMessage(code));
    }
    let rawTitle: string;
    try {
      rawTitle = parseSuggestedTitle(result.text);
    } catch (error) {
      // 非 JSON/缺 title 键与「标题不合规」同属可重试的输出缺陷：提示模型
      // 只输出严格 JSON 后再来一轮；次数耗尽才落 invalid_model_output。
      if (attempt < maxAttempts && error instanceof AbilityAssetTitleSuggestionFailure) {
        log.info('asset title suggestion retry', { attempt, issue: 'non_json' });
        message = `${message}\n（上一轮输出不是严格 JSON：请只输出 {"title":"标题"}，不要带任何其他内容）`;
        continue;
      }
      throw error;
    }
    const issue = recallTitleIssue(rawTitle, statement);
    if (!issue) {
      return {
        title: rawTitle,
        ...(result.meta.provider ? { providerId: result.meta.provider } : {}),
        ...(result.meta.model ? { modelId: result.meta.model } : {}),
      };
    }
    // 输出不合规：把具体原因拼进下一轮消息，模型才知道往哪改（换词、去标点、
    // 压长度），而不是原样再交一遍。
    log.info('asset title suggestion retry', { attempt, issue });
    message = `${message}\n（上一轮给出的标题不合格：${ISSUE_HINTS[issue]}，请重新给出）`;
  }
  throw new AbilityAssetTitleSuggestionFailure('invalid_model_output', safeFailureMessage('invalid_model_output'));
}
