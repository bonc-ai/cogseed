import { readJsonl, safeId } from '../../storage';
import { conversationMessageReadFile } from '../../util/project-layout';
import type { GroupMessage, RecallMessageCitation } from '../group_chat/visibility';
import { listRecallUsage, recordRecallUsage, type RecallUsageRecord } from './usage-service';

export type RecallMessageFeedback = 'positive' | 'negative';

export interface RecordRecallMessageFeedbackInput {
  cid: string;
  messageId: string;
  feedback: RecallMessageFeedback;
}

export interface RecordRecallMessageFeedbackResult {
  feedback: RecallMessageFeedback;
  citationCount: number;
  recordedCount: number;
  records: RecallUsageRecord[];
}

function isCitation(value: unknown): value is RecallMessageCitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const citation = value as Partial<RecallMessageCitation>;
  return typeof citation.asset_id === 'string'
    && safeId(citation.asset_id)
    && typeof citation.title === 'string'
    && citation.title.trim().length > 0
    && citation.title.length <= 160
    && (citation.type === 'personal' || citation.type === 'rule' || citation.type === 'template' || citation.type === 'skill_method')
    && typeof citation.version === 'string'
    && citation.version.trim().length > 0
    && citation.version.length <= 40
    && typeof citation.scope === 'string'
    && citation.scope.trim().length > 0
    && citation.scope.length <= 500
    && typeof citation.projection_id === 'string'
    && safeId(citation.projection_id)
    && (citation.match_method === 'semantic' || citation.match_method === 'manual')
    && (citation.match_score === undefined
      || (typeof citation.match_score === 'number'
        && Number.isFinite(citation.match_score)
        && citation.match_score >= 0
        && citation.match_score <= 1));
}

export async function recordRecallMessageFeedback(
  userId: string,
  input: RecordRecallMessageFeedbackInput,
): Promise<RecordRecallMessageFeedbackResult> {
  if (!safeId(input.cid) || !safeId(input.messageId)) throw new Error('invalid Recall feedback message');
  if (input.feedback !== 'positive' && input.feedback !== 'negative') throw new Error('invalid Recall feedback value');

  const messages = await readJsonl<GroupMessage>(conversationMessageReadFile(userId, input.cid), 100_000);
  const message = [...messages].reverse().find((item) => item?.id === input.messageId);
  if (!message) throw new Error('Recall feedback message not found');
  if (message.from === 'user' || message.deleted_at) throw new Error('Recall feedback requires an assistant message');
  if (!Array.isArray(message.recall_citations) || !message.recall_citations.length) {
    throw new Error('assistant message does not contain Recall citations');
  }
  if (message.recall_citations.length > 12 || !message.recall_citations.every(isCitation)) {
    throw new Error('assistant message contains malformed Recall citations');
  }

  const outcome = `feedback_${input.feedback}`;
  const taskRunId = typeof message.turn_id === 'string' && safeId(message.turn_id)
    ? message.turn_id
    : message.id;
  const existing = await listRecallUsage(userId);
  const records: RecallUsageRecord[] = [];
  for (const citation of message.recall_citations) {
    const duplicate = existing.some((record) => (
      record.messageId === message.id
      && record.assetId === citation.asset_id
      && record.projectionId === citation.projection_id
      && record.outcome === outcome
    ));
    if (duplicate) continue;
    records.push(await recordRecallUsage(userId, {
      assetId: citation.asset_id,
      assetVersion: citation.version,
      taskRunId,
      projectionId: citation.projection_id,
      messageId: message.id,
      boundary: 'real',
      outcome,
    }));
  }
  return {
    feedback: input.feedback,
    citationCount: message.recall_citations.length,
    recordedCount: records.length,
    records,
  };
}
