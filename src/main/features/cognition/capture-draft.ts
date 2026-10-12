import { createLogger } from '../../logger';
import { logErrorSummary, maskId } from '../../util/log-redact';
import { prompts } from '../../prompts/loader';
import { safeId } from '../../storage';
import { scanForInjection } from '../memory';
import * as chats from '../chats';
import { chatWithModel } from '../../model/client';
import type { MessageRecord } from '../chats';
import type { CognitionSourceInput } from '../recall/source-service';

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
const MAX_TITLE_LENGTH = 60;
const MAX_SUMMARY_LENGTH = 2_000;
const MIN_COPY_COMPARISON_CHARS = 24;
const CANDIDATE_SCOPES = ['general', 'report', 'code', 'review', 'product'] as const;
const CANDIDATE_RISKS = ['low', 'medium', 'high'] as const;

export interface CognitionCaptureRequest {
  conversationId: string;
  messageId: string;
}

/** 与所有 Recall 候选生产者共用的五类资产类型。 */
export type CognitionCaptureAssetType = 'personal' | 'fact' | 'rule' | 'template' | 'skill_method';

const COGNITION_CAPTURE_ASSET_TYPES: readonly CognitionCaptureAssetType[] = [
  'personal', 'fact', 'rule', 'template', 'skill_method',
];

export function isCognitionCaptureAssetType(value: unknown): value is CognitionCaptureAssetType {
  return typeof value === 'string'
    && (COGNITION_CAPTURE_ASSET_TYPES as readonly string[]).includes(value);
}

export interface CognitionCaptureDraft {
  /** Canonical Recall candidate fields. `summary` is the display title. */
  summary: string;
  judgment: string;
  value: string;
  suggestedType: CognitionCaptureAssetType;
  suggestedScope: typeof CANDIDATE_SCOPES[number];
  applicableWhen: string[];
  forbiddenWhen: string[];
  suggestedAction: 'create';
  risk: typeof CANDIDATE_RISKS[number];
  uncertainty?: string;
  sourceRefs: CognitionSourceInput[];
  evidenceRefs: CognitionSourceInput[];
  /** Display-only source title; references themselves are host-generated. */
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
  const judgment = normalizeText(candidate.judgment);
  if (!source || !judgment) return false;
  if (judgment === source) return true;
  if (judgment.length >= MIN_COPY_COMPARISON_CHARS && source.includes(judgment)) return true;
  const sourceTokens = comparisonTokens(sourceText);
  const candidateTokens = comparisonTokens(candidate.judgment);
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
  if (!isJsonObject(parsed) || !Array.isArray(parsed.candidates)
      || Object.keys(parsed).some((key) => key !== 'candidates' && key !== 'reason')) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft has an invalid shape');
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== 'string') {
    throw new CognitionCaptureError('invalid_model_output', 'generated extraction reason has an invalid shape');
  }
  if (parsed.candidates.length === 0) {
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
      throw new CognitionCaptureError('invalid_model_output', 'generated no-candidate response is missing its reason');
    }
    return {
      status: 'not_reusable',
      reason: assertSafeGeneratedText(parsed.reason, 'reason', COGNITION_CAPTURE_MAX_REASON_CHARS),
    };
  }
  if (parsed.reason !== undefined || parsed.candidates.length !== 1
      || !isJsonObject(parsed.candidates[0])) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition draft has an invalid shape');
  }
  const candidate = parsed.candidates[0];
  const requiredKeys = [
    'judgment', 'value', 'summary', 'suggestedType', 'suggestedScope',
    'applicableWhen', 'forbiddenWhen', 'suggestedAction', 'risk', 'evidence',
  ];
  const allowedKeys = [...requiredKeys, 'targetAssetId', 'uncertainty'];
  if (Object.keys(candidate).some((key) => !allowedKeys.includes(key))
      || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(candidate, key))) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition candidate has an invalid shape');
  }
  if (typeof candidate.summary !== 'string' || typeof candidate.judgment !== 'string'
      || typeof candidate.value !== 'string' || typeof candidate.suggestedType !== 'string'
      || typeof candidate.suggestedScope !== 'string' || candidate.suggestedAction !== 'create'
      || typeof candidate.risk !== 'string' || !Array.isArray(candidate.evidence)) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition candidate has an invalid shape');
  }
  if (candidate.targetAssetId !== undefined && candidate.targetAssetId !== '') {
    throw new CognitionCaptureError('invalid_model_output', 'new manual cognition candidate cannot target an existing asset');
  }
  if (candidate.uncertainty !== undefined && typeof candidate.uncertainty !== 'string') {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition uncertainty is not text');
  }
  if (!isCognitionCaptureAssetType(candidate.suggestedType)
      || !(CANDIDATE_SCOPES as readonly string[]).includes(candidate.suggestedScope)
      || !(CANDIDATE_RISKS as readonly string[]).includes(candidate.risk)) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition candidate has an invalid type, scope, or risk');
  }
  const applicableWhen = parseStringArray(candidate.applicableWhen, 'applicableWhen');
  const forbiddenWhen = parseStringArray(candidate.forbiddenWhen, 'forbiddenWhen');
  if (candidate.suggestedType === 'rule' && (!applicableWhen.length || !forbiddenWhen.length)) {
    throw new CognitionCaptureError('invalid_model_output', 'rule candidate is missing its applicability boundary');
  }
  const labels = context.messages.map((_message, index) => `m${index + 1}`);
  const evidenceLabels = [...new Set(candidate.evidence.map((label) => {
    if (typeof label !== 'string' || !labels.includes(label)) {
      throw new CognitionCaptureError('invalid_model_output', 'generated cognition candidate cites an unknown evidence label');
    }
    return label;
  }))];
  if (!evidenceLabels.length) {
    throw new CognitionCaptureError('invalid_model_output', 'generated cognition candidate has no evidence');
  }
  const evidenceMessages = evidenceLabels.map((label) => context.messages[labels.indexOf(label)]);
  const sessionRef: CognitionSourceInput = {
    kind: 'conversation', subtype: 'session', scope: 'conversation',
    id: context.conversationId, title: context.conversationTitle,
  };
  const messageRefs: CognitionSourceInput[] = evidenceMessages.map((message) => ({
    kind: 'conversation', subtype: 'message', scope: 'conversation',
    id: message.id, title: context.conversationTitle,
  }));
  const draft: CognitionCaptureDraft = {
    summary: assertSafeGeneratedText(candidate.summary, 'title', MAX_TITLE_LENGTH),
    judgment: assertSafeGeneratedText(candidate.judgment, 'judgment', MAX_SUMMARY_LENGTH),
    value: assertSafeGeneratedText(candidate.value, 'future value', MAX_SUMMARY_LENGTH),
    suggestedType: candidate.suggestedType,
    suggestedScope: candidate.suggestedScope as CognitionCaptureDraft['suggestedScope'],
    applicableWhen,
    forbiddenWhen,
    suggestedAction: 'create',
    risk: candidate.risk as CognitionCaptureDraft['risk'],
    ...(typeof candidate.uncertainty === 'string' && candidate.uncertainty.trim()
      ? { uncertainty: assertSafeGeneratedText(candidate.uncertainty, 'uncertainty', 1_000) }
      : {}),
    sourceRefs: [sessionRef, ...messageRefs],
    evidenceRefs: [sessionRef, ...messageRefs],
    sourceLabel: context.conversationTitle,
    conversationId: context.conversationId,
    messageId: context.messageId,
  };
  const anchor = context.messages.find((message) => message.anchor);
  if (!anchor || !isCopiedOnly(draft, anchor.text)) return { status: 'ready', draft, context: context.stats };
  throw new CognitionCaptureError('copied_model_output', 'generated cognition draft only repeats the selected reply');
}

function parseStringArray(value: JsonValue, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new CognitionCaptureError('invalid_model_output', `generated cognition ${field} is not an array`);
  }
  const items = value.map((item) => {
    if (typeof item !== 'string') {
      throw new CognitionCaptureError('invalid_model_output', `generated cognition ${field} has a non-text item`);
    }
    return assertSafeGeneratedText(item, field, 300);
  });
  return [...new Set(items)].slice(0, 10);
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
    messages: context.messages.map((message, index) => ({
      label: `m${index + 1}`,
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      anchor: message.anchor,
      text: message.text,
    })),
  });
  return `${prompts.load('cognition_capture')}\n\n${prompts.load('recall_candidate_contract')}\n\n${source}`;
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
