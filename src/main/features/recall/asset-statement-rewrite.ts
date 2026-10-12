/**
 * LLM 正文改写共享函数（2026-09-29 正文一等规范，子安拍板「全自动写入」）。
 *
 * 输入旧正文 + 类型 + 标题，输出一段**按新规范改写且知识点不丢**的正文，供
 * 存量「正文改写」轮调用；与 asset-title-suggestion 同款骨架：buildRunner
 * （ephemeral、disableTools）+ 严格 JSON + 失败码 + 预检不静默跳过。
 *
 * 改写铁律（提示词与判定双重执行）：
 *   1. 知识点一条不丢——只删"怎么来的"（日期戳/会话标识/调试叙事/价值段），
 *      不删"是什么"；拿不准保留原句；
 *   2. 改写后长度必须不增（超长输入必须显著缩短）；
 *   3. 输出过 statement-policy 的机器可判项，不合规带原因重试（默认 3 次）。
 */
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { buildRunner } from '../../model/core-agent/runner';
import { safeId } from '../../storage';
import { getConfiguredModelOAuthExpiredMessage, hasConfiguredModelForUser } from '../auth';
import type { RecallAbilityAssetRecord } from './candidate-service';
import { recallStatementIssues } from './statement-policy';

const log = createLogger('recall.assetStatementRewrite');

type AbilityAssetType = RecallAbilityAssetRecord['type'];

export type AbilityAssetStatementRewriteFailureCode =
  | 'model_not_configured'
  | 'model_auth_required'
  | 'model_timeout'
  | 'model_failed'
  | 'invalid_model_output';

export class AbilityAssetStatementRewriteFailure extends Error {
  readonly code: AbilityAssetStatementRewriteFailureCode;

  constructor(code: AbilityAssetStatementRewriteFailureCode, message: string) {
    super(message);
    this.name = 'AbilityAssetStatementRewriteFailure';
    this.code = code;
  }
}

const FAILURE_MESSAGES: Record<AbilityAssetStatementRewriteFailureCode, string> = {
  model_not_configured: '尚未配置可用模型，无法自动改写正文。',
  model_auth_required: '模型授权已失效，无法自动改写正文。',
  model_timeout: '模型改写正文超时。',
  model_failed: '模型未能改写正文。',
  invalid_model_output: '模型多次给出的正文都不合规。',
};

export interface AbilityAssetStatementRewriteOptions {
  signal?: AbortSignal;
  /** 总尝试次数（含首次）。默认 3。 */
  attempts?: number;
}

export interface AbilityAssetStatementRewrite {
  statement: string;
  providerId?: string;
  modelId?: string;
}

const TYPE_SHAPES: Record<AbilityAssetType, string> = {
  personal: '一到三个陈述句（主体＋偏好/身份事实），120 字内，硬限 200 字',
  rule: '一到三个陈述句（场景＋做法），120 字内，硬限 200 字',
  fact: '一到三个陈述句（主体＋事实），200 字内；知识本身是位置/配置值时路径合法',
  template: '保留可复用的结构与字段，不加多余叙事',
  skill_method: '保留「触发条件/输入/操作步骤/输出/验证」五节结构（### 小标题）',
};

function rewriteSystemPrompt(): string {
  return [
    '你改写一条「认知资产」的正文，使它符合正文规范。旧正文在下一条消息给出。',
    '铁律（违反任何一条即为失败）：',
    '1. 知识点一条不丢：只删"怎么来的"，不删"是什么"。要删的只有——',
    '   a) "用户在某日明确提出"式日期戳（偏好本身保留，何时说的删掉）；',
    '   b) 会话一次性标识与调试叙事（会话号/cid/turn 号/某次排查的步骤流水）；',
    '   c) 独立的"为什么有用/带来的价值"段（若重要，融入最后一句）；',
    '   d) 规则/偏好类里的本机路径与源码文件名（事实类知识本身是该位置的除外）；',
    '2. 改写后字数不得超过原文（超长原文必须显著缩短）；',
    '3. 按资产类型的形态写（见消息内的类型说明）；',
    '4. 用与原文相同的语言（原文是中文就输出中文）；',
    '5. 拿不准是否该删的内容，保留原句，宁长勿丢；',
    '6. 只输出严格 JSON：{"statement":"正文"}，不要输出其他任何内容。',
  ].join('\n');
}

function rewriteUserMessage(statement: string, type: AbilityAssetType, title: string): string {
  return [
    `资产标题（仅供理解语义，不要复述进正文）：${title}`,
    `资产类型：${type}（形态要求：${TYPE_SHAPES[type] || type}）`,
    '旧正文：',
    String(statement || '').trim(),
  ].join('\n');
}

function parseSuggestedStatement(raw: string): string {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AbilityAssetStatementRewriteFailure('invalid_model_output', FAILURE_MESSAGES.invalid_model_output);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new AbilityAssetStatementRewriteFailure('invalid_model_output', FAILURE_MESSAGES.invalid_model_output);
  }
  const statement = (parsed as { statement?: unknown }).statement;
  if (typeof statement !== 'string' || !statement.trim()) {
    throw new AbilityAssetStatementRewriteFailure('invalid_model_output', FAILURE_MESSAGES.invalid_model_output);
  }
  return statement.replace(/[ \t]+\n/g, '\n').trim();
}

function classifyModelException(error: unknown): AbilityAssetStatementRewriteFailureCode {
  if (getConfiguredModelOAuthExpiredMessage()) return 'model_auth_required';
  const value = error instanceof Error ? `${error.name} ${error.message}` : String(error || '');
  return /timeout|timed out/i.test(value) ? 'model_timeout' : 'model_failed';
}

export async function suggestAbilityAssetStatement(
  userId: string,
  input: { statement: string; type: AbilityAssetType; title?: string },
  options: AbilityAssetStatementRewriteOptions = {},
): Promise<AbilityAssetStatementRewrite> {
  if (!safeId(userId)) throw new AbilityAssetStatementRewriteFailure('model_failed', FAILURE_MESSAGES.model_failed);
  const original = String(input.statement || '').trim();
  if (!original) {
    throw new AbilityAssetStatementRewriteFailure('model_failed', '旧正文为空，无需改写。');
  }
  const maxAttempts = Number.isSafeInteger(options.attempts) && Number(options.attempts) > 0
    ? Number(options.attempts)
    : 3;

  if (!hasConfiguredModelForUser(userId).configured) {
    throw new AbilityAssetStatementRewriteFailure('model_not_configured', FAILURE_MESSAGES.model_not_configured);
  }
  if (getConfiguredModelOAuthExpiredMessage()) {
    throw new AbilityAssetStatementRewriteFailure('model_auth_required', FAILURE_MESSAGES.model_auth_required);
  }

  let message = rewriteUserMessage(original, input.type, String(input.title || ''));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new AbilityAssetStatementRewriteFailure('model_failed', FAILURE_MESSAGES.model_failed);
    }
    let built: Awaited<ReturnType<typeof buildRunner>>;
    try {
      built = await buildRunner({
        sessionId: `asset-statement-rewrite-${randomUUID()}`,
        userId,
        systemPrompt: rewriteSystemPrompt(),
        disableTools: true,
        ephemeralSession: true,
        skillList: [],
      });
    } catch (error) {
      const code = classifyModelException(error);
      if (attempt < maxAttempts && code !== 'model_auth_required') continue;
      throw new AbilityAssetStatementRewriteFailure(code, FAILURE_MESSAGES[code]);
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
      throw new AbilityAssetStatementRewriteFailure(code, FAILURE_MESSAGES[code]);
    }
    if (result.meta.error) {
      const code: AbilityAssetStatementRewriteFailureCode = result.meta.error.kind === 'auth'
        ? 'model_auth_required'
        : result.meta.error.kind === 'timeout'
          ? 'model_timeout'
          : 'model_failed';
      if (attempt < maxAttempts && code !== 'model_auth_required') continue;
      throw new AbilityAssetStatementRewriteFailure(code, FAILURE_MESSAGES[code]);
    }
    let candidate: string;
    try {
      candidate = parseSuggestedStatement(result.text);
    } catch (error) {
      if (attempt < maxAttempts && error instanceof AbilityAssetStatementRewriteFailure) {
        log.info('asset statement rewrite retry', { attempt, issue: 'non_json' });
        message = `${message}\n（上一轮输出不是严格 JSON：请只输出 {"statement":"正文"}，不要带任何其他内容）`;
        continue;
      }
      throw error;
    }
    // 铁律 2（不增长）与机器可判项都在此把关：不合规带具体原因重试。
    const issues = recallStatementIssues({ statement: candidate, type: input.type });
    const grew = candidate.length > original.length;
    if (!issues.length && !grew) {
      return {
        statement: candidate,
        ...(result.meta.provider ? { providerId: result.meta.provider } : {}),
        ...(result.meta.model ? { modelId: result.meta.model } : {}),
      };
    }
    const why = [
      ...(grew ? ['改写后比原文更长（必须压缩，字数不得超过原文）'] : []),
      ...issues.map((issue) => ({ too_long: '仍超长（规则/偏好/事实硬限 200 字）', session_debris: '仍带会话一次性标识', local_path: '规则/偏好类仍带本机路径或源码文件名', empty: '正文为空' } as Record<string, string>)[issue] || issue),
    ].join('；');
    log.info('asset statement rewrite retry', { attempt, why });
    message = `${message}\n（上一轮改写不合格：${why}，请重新给出）`;
  }
  throw new AbilityAssetStatementRewriteFailure('invalid_model_output', FAILURE_MESSAGES.invalid_model_output);
}
