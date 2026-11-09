import { summaryCoversUserQuote, type CaptureContextSummary } from './capture-context-summary';

/** Value decision after context summarization. Evidence must be literal new
 * user-authored text; an extraction response cannot pass here. */
export interface CaptureValueJudgment {
  eligible: boolean;
  reason: string;
  evidence: Array<{ messageId: string; sourceId: string; quote: string }>;
  judgedAt: string;
  /** Set by the host, never by the model, to bind the decision to its summary. */
  summaryDigest?: string;
}

/** Keep independent passages separate. Joining them would manufacture source
 * text that a model can quote literally but the original message never said. */
export function captureValueJudgmentInput(summary: CaptureContextSummary,
  messages: readonly { id: string; role: string; text: string; discovery?: boolean; ts?: string; observations?: readonly unknown[] }[]) {
  const evidence = summary.topics.flatMap(topic => topic.evidence);
  return { summary: summary.topics, messages: messages.filter(message => evidence.some(ref => ref.messageId === message.id))
    .map(message => ({ id: message.id, role: message.role, discovery: message.discovery !== false,
      ...(message.ts ? { ts: message.ts } : {}),
      ...(message.observations?.length ? { observations: message.observations } : {}),
      excerpts: [...new Set(evidence.filter(ref => ref.messageId === message.id).map(ref => ref.quote))].filter(quote => message.text.includes(quote)),
    })) };
}

const VALUE_CONTRACT_ERRORS = new Set([
  'invalid capture value judgment',
  'invalid value evidence',
  'unsupported capture value evidence',
  'positive value judgment requires user evidence',
]);
const VALUE_REPAIR_INSTRUCTION = 'The previous output was not valid for this contract. Return only one JSON object '
  + '{"eligible":boolean,"reason":"short explanation","evidence":[...]}. Each evidence entry is one object with '
  + 'messageId and quote; separate array elements with commas. Do not add Markdown fences, comments or text after the JSON. '
  + 'Keep the same source meaning and never invent message IDs or quotations.';

/** One bounded repair applies only to output-contract errors; transport,
 * authorization, abort and forbidden-content failures keep their own paths.
 * JSON syntax failures arrive as `SyntaxError` from `JSON.parse`; matching
 * prose such as "unexpected response" would retry a transport failure. */
export function captureValueRepairInstruction(error: unknown): string | undefined {
  if (error instanceof SyntaxError) return VALUE_REPAIR_INSTRUCTION;
  const message = error instanceof Error ? error.message : '';
  return message && VALUE_CONTRACT_ERRORS.has(message) ? VALUE_REPAIR_INSTRUCTION : undefined;
}

export function parseCaptureValueJudgment(
  raw: string,
  messages: readonly { id: string; sourceId: string; role: string; text: string; discovery?: boolean }[],
  summary?: CaptureContextSummary,
): CaptureValueJudgment {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.eligible !== 'boolean'
    || typeof result.reason !== 'string' || !result.reason.trim() || result.reason.length > 500
    || !Array.isArray(result.evidence) || result.evidence.length > 64
    || Object.keys(result).some(key => !['eligible', 'reason', 'evidence'].includes(key))) {
    throw new Error('invalid capture value judgment');
  }
  const evidence = result.evidence.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid value evidence');
    const value = item as Record<string, unknown>;
    const message = messages.find(message => message.id === value.messageId && message.role === 'user' && message.discovery !== false);
    if (!message || typeof value.quote !== 'string' || !value.quote.trim()
      || value.quote.length > 1_000 || !message.text.includes(value.quote)
      || (summary && !summaryCoversUserQuote(summary, message.id, value.quote))) {
      throw new Error('unsupported capture value evidence');
    }
    return { messageId: message.id, sourceId: message.sourceId, quote: value.quote };
  });
  if (result.eligible && !evidence.length) throw new Error('positive value judgment requires user evidence');
  return { eligible: result.eligible, reason: result.reason.trim(), evidence, judgedAt: new Date().toISOString() };
}
