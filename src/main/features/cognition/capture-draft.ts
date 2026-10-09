import { createLogger } from '../../logger';
import { logErrorSummary, maskId } from '../../util/log-redact';
import { prompts } from '../../prompts/loader';
import { safeId } from '../../storage';
import { scanForInjection } from '../memory';
import * as chats from '../chats';
import { chatWithModel } from '../../model/client';
import type { MessageRecord } from '../chats';

const log = createLogger('cognition.capture-draft');

export const COGNITION_CAPTURE_MAX_MESSAGES = 24;
export const COGNITION_CAPTURE_NEIGHBOR_MESSAGES = 6;
export const COGNITION_CAPTURE_MAX_CONTEXT_CHARS = 12_000;
export const COGNITION_CAPTURE_MAX_MESSAGE_CHARS = 3_000;
export const COGNITION_CAPTURE_MAX_MODEL_OUTPUT_CHARS = 8_000;
export const COGNITION_CAPTURE_MAX_REASON_CHARS = 400;

const MAX_USER_ID_LENGTH = 160;
const MAX_CONVERSATION_TITLE_LENGTH = 160;
const MAX_MESSAGE_ID_LENGTH = 160;
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 2_000;
const MIN_COPY_COMPARISON_CHARS = 24;

export interface CognitionCaptureRequest {
  conversationId: string;
  messageId: string;
}

/** 四类正式资产类型。与 `AbilityAssetType` 同一套词汇——气泡沉淀产出的是
 *  recall 候选，必须和其它五个候选生产者走同一套分类，不另立一套。 */
export type CognitionCaptureAssetType = 'personal' | 'rule' | 'template' | 'skill_method';

const COGNITION_CAPTURE_ASSET_TYPES: readonly CognitionCaptureAssetType[] = [
  'personal', 'rule', 'template', 'skill_method',
];

export function isCognitionCaptureAssetType(value: unknown): value is CognitionCaptureAssetType {
  return typeof value === 'string'
    && (COGNITION_CAPTURE_ASSET_TYPES as readonly string[]).includes(value);
}

export interface CognitionCaptureDraft {
  title: string;
  summary: string;
  evidenceSummary: string;
  /** 模型给出的四类预判。给不出合法值时缺省，由用户在面板上选。 */
  suggestedType?: CognitionCaptureAssetType;
  sourceLabel: string;
  conversationId: string;
  messageId: string;
}

export interface CognitionCaptureContextStats {
  messageCount: number;
  characterCount: number;
}

export interface CognitionCaptureDraftReady {
  status: 'ready';
  draft: CognitionCaptureDraft;
  context: CognitionCaptureContextStats;
}

export interface CognitionCaptureDraftNotReusable {
  status: 'not_reusable';
  reason: string;
}

export type CognitionCaptureDraftResult = CognitionCaptureDraftReady | CognitionCaptureDraftNotReusable;

export type CognitionCaptureErrorCode =
  | 'invalid_request'
  | 'conversation_not_found'
  | 'anchor_not_found'
  | 'model_failed'
  | 'invalid_model_output'
  | 'unsafe_model_output'
  | 'copied_model_output';

export class CognitionCaptureError extends Error {
  readonly code: CognitionCaptureErrorCode;

  constructor(code: CognitionCaptureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CognitionCaptureError';
    this.code = code;
  }
}

interface SourceMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  anchor: boolean;
}

interface SourceContext {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  messages: SourceMessage[];
  stats: CognitionCaptureContextStats;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredBoundedId(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new CognitionCaptureError('invalid_request', `invalid cognition capture ${field}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !safeId(trimmed)) {
    throw new CognitionCaptureError('invalid_request', `invalid cognition capture ${field}`);
  }
  return trimmed;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 32) return value.slice(0, Math.max(0, maxLength));
  const headLength = Math.max(1, Math.floor(maxLength * 0.72));
  const tailLength = Math.max(1, maxLength - headLength - 20);
  return `${value.slice(0, headLength)}\n[…中间内容已截断…]\n${value.slice(-tailLength)}`;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function comparisonTokens(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]/gu) || [];
  return new Set(tokens);
}

function isCopiedOnly(candidate: CognitionCaptureDraft, sourceText: string): boolean {
  const source = normalizeText(sourceText);
  const summary = normalizeText(candidate.summary);
  const evidence = normalizeText(candidate.evidenceSummary);
  if (!source || !summary || !evidence) return false;
  if (summary === source || evidence === source) return true;
  if (summary.length >= MIN_COPY_COMPARISON_CHARS && source.includes(summary)
      && evidence.length >= MIN_COPY_COMPARISON_CHARS && source.includes(evidence)) return true;
  const sourceTokens = comparisonTokens(sourceText);
  const candidateTokens = comparisonTokens(`${candidate.summary} ${candidate.evidenceSummary}`);
  if (candidateTokens.size < 8 || sourceTokens.size < candidateTokens.size) return false;
  let overlap = 0;
  for (const token of candidateTokens) if (sourceTokens.has(token)) overlap += 1;
  return overlap / candidateTokens.size >= 0.92;
}

function assertSafeGeneratedText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new CognitionCaptureError('invalid_model_output', `invalid generated ${field}`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new CognitionCaptureError('unsafe_model_output', `unsafe generated ${field}`);
  }
  const injection = scanForInjection(text);
  if (injection) {
    throw new CognitionCaptureError('unsafe_model_output', `generated ${field} contains ${injection}`);
  }
  return text;
}

function exactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = expected.slice().sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseModelOutput(raw: unknown, context: SourceContext): CognitionCaptureDraftResult {
  if (typeof raw !== 'string') {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft is not text');
  }
  if (raw.length > COGNITION_CAPTURE_MAX_MODEL_OUTPUT_CHARS) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft is too large');
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft is not valid JSON', { cause: error });
  }
  if (!isJsonObject(parsed) || typeof parsed.status !== 'string') {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft has an invalid shape');
  }
  if (parsed.status === 'not_reusable') {
    if (!exactKeys(parsed, ['status', 'reason']) || typeof parsed.reason !== 'string') {
      throw new CognitionCaptureError('invalid_model_output', 'generated no-candidate response has an invalid shape');
    }
    return {
      status: 'not_reusable',
      reason: assertSafeGeneratedText(parsed.reason, 'reason', COGNITION_CAPTURE_MAX_REASON_CHARS),
    };
  }
  // `suggested_type` 是**可选**键：模型漏了它不该让整条草稿作废——面板上的
  // 分类选择器是必填的，缺省时用户自己选，链路照样走得通。多余的其它键仍然拒收。
  const readyKeys: readonly string[] = ['status', 'title', 'summary', 'evidence_summary'];
  const shapeOk = exactKeys(parsed, readyKeys)
    || exactKeys(parsed, [...readyKeys, 'suggested_type']);
  if (parsed.status !== 'ready' || !shapeOk
      || typeof parsed.title !== 'string' || typeof parsed.summary !== 'string'
      || typeof parsed.evidence_summary !== 'string') {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft has an invalid shape');
  }
  // 四类分类走和主抽取管线同一套词汇（AbilityAssetType）。模型给不出合法值时
  // **不猜**——退回 skill_method 只会把分类错误藏进资产库，而面板上的分类选择器
  // 是必填的，用户会看到并可以改。这里只负责"预填一个可信的默认"。
  const draft: CognitionCaptureDraft = {
    title: assertSafeGeneratedText(parsed.title, 'title', MAX_TITLE_LENGTH),
    summary: assertSafeGeneratedText(parsed.summary, 'summary', MAX_SUMMARY_LENGTH),
    evidenceSummary: assertSafeGeneratedText(parsed.evidence_summary, 'evidence summary', MAX_SUMMARY_LENGTH),
    ...(isCognitionCaptureAssetType(parsed.suggested_type) ? { suggestedType: parsed.suggested_type } : {}),
    sourceLabel: context.conversationTitle,
    conversationId: context.conversationId,
    messageId: context.messageId,
  };
  const anchor = context.messages.find((message) => message.anchor);
  if (!anchor || !isCopiedOnly(draft, anchor.text)) return { status: 'ready', draft, context: context.stats };
  throw new CognitionCaptureError('copied_model_output', 'generated cognition draft only repeats the selected reply');
}

function sourceMessageFromRecord(record: MessageRecord, anchorId: string): SourceMessage | null {
  if (!record || typeof record.id !== 'string' || !record.id || typeof record.text !== 'string') return null;
  if (record.deleted_at || record.system_kind || record.failure_kind) return null;
  const text = record.text.trim();
  if (!text) return null;
  const role: SourceMessage['role'] = record.from === 'user' ? 'user' : 'assistant';
  return {
    id: record.id,
    role,
    text: truncateText(text, COGNITION_CAPTURE_MAX_MESSAGE_CHARS),
    timestamp: typeof record.ts === 'string' ? record.ts : '',
    anchor: record.id === anchorId,
  };
}

function serializedSourceMessage(message: SourceMessage, text = message.text): string {
  return JSON.stringify({
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    anchor: message.anchor,
    text,
  });
}

function fitAnchorTextToBudget(message: SourceMessage, budget: number): string | null {
  const maximum = Math.min(COGNITION_CAPTURE_MAX_MESSAGE_CHARS, message.text.length);
  let low = 1;
  let high = maximum;
  let best: string | null = null;
  while (low <= high) {
    const candidateLength = Math.floor((low + high) / 2);
    const candidate = truncateText(message.text, candidateLength);
    if (serializedSourceMessage(message, candidate).length <= budget) {
      best = candidate;
      low = candidateLength + 1;
    } else {
      high = candidateLength - 1;
    }
  }
  return best;
}

async function loadSourceContext(userId: string, request: CognitionCaptureRequest): Promise<SourceContext> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new CognitionCaptureError('invalid_request', 'invalid cognition capture request');
  }
  const uid = requiredBoundedId(userId, 'user id', MAX_USER_ID_LENGTH);
  const conversationId = requiredBoundedId(request.conversationId, 'conversation id', MAX_MESSAGE_ID_LENGTH);
  const messageId = requiredBoundedId(request.messageId, 'message id', MAX_MESSAGE_ID_LENGTH);
  const conversation = await chats.getConversation(uid, conversationId);
  if (!conversation || conversation.conversation_id !== conversationId || conversation.deleted_at) {
    throw new CognitionCaptureError('conversation_not_found', 'conversation not found');
  }
  const records = await chats.getMessages(uid, conversationId, COGNITION_CAPTURE_MAX_MESSAGES);
  if (!Array.isArray(records)) {
    throw new CognitionCaptureError('conversation_not_found', 'conversation messages are unavailable');
  }
  const visible = records
    .map((record) => sourceMessageFromRecord(record, messageId))
    .filter((message): message is SourceMessage => message !== null);
  const anchorIndex = visible.findIndex((message) => message.anchor);
  if (anchorIndex < 0 || visible[anchorIndex].role !== 'assistant') {
    throw new CognitionCaptureError('anchor_not_found', 'selected assistant reply was not found');
  }
  const start = Math.max(0, anchorIndex - COGNITION_CAPTURE_NEIGHBOR_MESSAGES);
  const end = Math.min(visible.length, anchorIndex + COGNITION_CAPTURE_NEIGHBOR_MESSAGES + 1);
  const messages = visible.slice(start, end);
  const boundedMessages: SourceMessage[] = [];
  let usedChars = 0;
  for (const message of messages) {
    let separatorLength = boundedMessages.length ? 1 : 0;
    let remaining = COGNITION_CAPTURE_MAX_CONTEXT_CHARS - usedChars - separatorLength;
    if (remaining <= 0 && !message.anchor) continue;
    const fullLength = serializedSourceMessage(message).length;
    if (message.anchor && fullLength > remaining) {
      // Keep the selected reply as the highest-priority context item. If
      // earlier neighbors consumed the budget, evict them from the tail
      // before fitting the anchor instead of rejecting a valid selection.
      while (boundedMessages.length
          && fullLength > COGNITION_CAPTURE_MAX_CONTEXT_CHARS - usedChars - separatorLength) {
        boundedMessages.pop();
        usedChars = boundedMessages.reduce(
          (total, item, index) => total + serializedSourceMessage(item).length + (index ? 1 : 0),
          0,
        );
        separatorLength = boundedMessages.length ? 1 : 0;
        remaining = COGNITION_CAPTURE_MAX_CONTEXT_CHARS - usedChars - separatorLength;
      }
    }
    let boundedText = message.text;
    if (fullLength > remaining) {
      if (!message.anchor) continue;
      boundedText = fitAnchorTextToBudget(message, remaining) || '';
      if (!boundedText) {
        throw new CognitionCaptureError('anchor_not_found', 'selected assistant reply exceeded the context boundary');
      }
    }
    const boundedLength = serializedSourceMessage(message, boundedText).length;
    if (boundedLength > remaining) {
      if (message.anchor) {
        throw new CognitionCaptureError('anchor_not_found', 'selected assistant reply exceeded the context boundary');
      }
      continue;
    }
    boundedMessages.push({ ...message, text: boundedText });
    usedChars += boundedLength + separatorLength;
  }
  if (!boundedMessages.some((message) => message.anchor)) {
    throw new CognitionCaptureError('anchor_not_found', 'selected assistant reply exceeded the context boundary');
  }
  const conversationTitle = (typeof conversation.title === 'string' ? conversation.title : conversationId)
    .trim().slice(0, MAX_CONVERSATION_TITLE_LENGTH);
  return {
    conversationId,
    conversationTitle: conversationTitle || conversationId,
    messageId,
    messages: boundedMessages,
    stats: {
      messageCount: boundedMessages.length,
      characterCount: usedChars,
    },
  };
}

function buildPrompt(context: SourceContext): string {
  const source = JSON.stringify({
    conversation: { id: context.conversationId, title: context.conversationTitle },
    anchor_message_id: context.messageId,
    messages: context.messages,
  });
  return `${prompts.load('cognition_capture')}\n${source}`;
}

export async function generateCognitionDraft(
  userId: string,
  request: CognitionCaptureRequest,
  abortSignal?: AbortSignal,
): Promise<CognitionCaptureDraftResult> {
  const context = await loadSourceContext(userId, request);
  let result;
  try {
    result = await chatWithModel({
      userId,
      message: 'Extract the cognition draft from the bounded source data.',
      systemPrompt: buildPrompt(context),
      disableTools: true,
      skillList: [],
      idleTimeout: 120,
      streamIdleTimeout: 60,
      abortSignal,
    });
  } catch (error) {
    log.warn('cognition draft model call failed', {
      user_id: maskId(userId),
      conversation_id: maskId(context.conversationId),
      message_id: maskId(context.messageId),
      error: logErrorSummary(error),
    });
    throw new CognitionCaptureError('model_failed', 'cognition draft generation failed', { cause: error });
  }
  if (!result || typeof result !== 'object' || !result.ok || result.aborted || typeof result.text !== 'string') {
    throw new CognitionCaptureError('model_failed', 'cognition draft generation failed');
  }
  try {
    return parseModelOutput(result.text, context);
  } catch (error) {
    if (error instanceof CognitionCaptureError) {
      log.warn('cognition draft rejected', {
        user_id: maskId(userId),
        conversation_id: maskId(context.conversationId),
        message_id: maskId(context.messageId),
        code: error.code,
      });
      throw error;
    }
    throw new CognitionCaptureError('invalid_model_output', 'cognition draft validation failed', { cause: error });
  }
}

export const _captureDraftInternals = {
  isCopiedOnly,
  loadSourceContext,
  parseModelOutput,
  buildPrompt,
};
