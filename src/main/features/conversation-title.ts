/**
 * Conversation title generator — 用模型给会话起名。
 *
 * 背景：会话标题此前是「首条消息机械截断」（chats.autoTitle），"hi"、"1"
 * 这样的消息就成了标题，侧边栏与使用记录里都认不出是哪次对话。本模块在
 * 首条真实消息后异步调模型生成概括性标题，覆盖机械标题；失败静默保持原样。
 *
 * 与 KSTAR review-inference 同一套调用范式：buildRunner + 临时会话 +
 * thinkingLevel off + 不缓存——一次性小调用，不进入对话上下文、不影响会话。
 * runModel 可注入（测试用），生产默认走 buildRunner。
 */

import { createLogger } from '../logger';
import { buildRunner } from '../model/core-agent/runner';
import { hasConfiguredModel } from './auth';

const log = createLogger('conversation-title');

const TITLE_MAX_CHARS = 24;
const MIN_SOURCE_CHARS = 6;

const SYSTEM_PROMPT = [
  '你是对话命名助手。根据用户的第一条消息，为这次对话生成一个简短、具体的标题。',
  '要求：',
  '- 用与消息相同的语言；',
  '- 不超过 15 个字（英文不超过 8 个词）；',
  '- 概括这次对话要解决的事，不要复述语气词；',
  '- 只输出标题本身：不要引号、不要句末标点、不要任何解释。',
].join('\n');

/** 清洗模型输出：去引号/换行/尾标点，按上限截断。空串由调用方兜底。 */
export function sanitizeGeneratedTitle(raw: string): string {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'“”‘’「」《]+/, '').replace(/["'“”‘’「」《]+$/, '');
  text = text.replace(/[。.!！?？,，;；:：]+$/, '').trim();
  if (!text) return '';
  return text.length > TITLE_MAX_CHARS ? text.slice(0, TITLE_MAX_CHARS) : text;
}

/** 首条消息太短（无信息量，如 "hi"）时不值得调模型。 */
export function shouldGenerateTitle(sourceText: string): boolean {
  return String(sourceText || '').trim().replace(/\s+/g, ' ').length >= MIN_SOURCE_CHARS;
}

export interface ConversationTitleOptions {
  /** 测试注入：返回模型原始输出；缺省走 buildRunner。 */
  runModel?: (input: { systemPrompt: string; message: string }) => Promise<string>;
}

/** 生成会话标题；任何失败（未配置模型/限流/超时/输出不可用）返回 null。 */
export async function generateConversationTitle(
  userId: string,
  conversationId: string,
  sourceText: string,
  options: ConversationTitleOptions = {},
): Promise<string | null> {
  if (!shouldGenerateTitle(sourceText)) return null;
  const message = String(sourceText).slice(0, 2_000);
  if (options.runModel) {
    try {
      return sanitizeGeneratedTitle(await options.runModel({ systemPrompt: SYSTEM_PROMPT, message })) || null;
    } catch (error) {
      log.warn('generate conversation title failed', { conversationId, error: (error as Error).message });
      return null;
    }
  }
  if (!hasConfiguredModel().configured) {
    log.warn('title generation skipped: no configured model', { conversationId });
    return null;
  }
  try {
    const { runner } = await buildRunner({
      sessionId: `conv-title-${conversationId}`,
      userId,
      systemPrompt: SYSTEM_PROMPT,
      disableTools: true,
      ephemeralSession: true,
      skillList: [],
    });
    const result = await runner.run({
      message,
      thinkingLevel: 'off',
      cacheRetention: 'none',
    });
    if (result.meta.aborted || result.meta.error) {
      // 显式记录原因（限流/超时/鉴权）——此前静默返回 null 导致线上无法诊断。
      log.warn('title model unavailable', {
        conversationId,
        aborted: !!result.meta.aborted,
        error: result.meta.error ? String(result.meta.error).slice(0, 200) : undefined,
      });
      return null;
    }
    return sanitizeGeneratedTitle(result.text) || null;
  } catch (error) {
    log.warn('generate conversation title failed', { conversationId, error: (error as Error).message });
    return null;
  }
}
