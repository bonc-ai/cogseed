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
  // 负反馈接线（T2.2 · 2026-09-13）：feedback_negative 此前只进 usage 流水、
  // 零消费方——"这条资产总被用户点踩"对治理链完全不可见。接两环：
  // ① contradicted 使用收据——补上五态中"零写入方"里语义最明确的一个
  //    （用户明确说这次没用）；无匹配注入收据（旧消息/旁路）就不编造。
  // ② 该资产累计负反馈 ≥2 → 生成 pause 治理建议（建议非停用，治理页
  //    里由人决定）。
  if (input.feedback === 'negative' && records.length) {
    try {
      const { listInjectionReceipts } = await import('./injection-receipt');
      const { recordAssetUsageReceipt } = await import('./asset-usage-receipt');
      const injections = await listInjectionReceipts(userId, taskRunId);
      for (const citation of message.recall_citations) {
        const injection = injections.find((receipt) => (
          receipt.assetId === citation.asset_id
          && receipt.assetVersion === citation.version
          && receipt.projectionId === citation.projection_id
          && (receipt.status === 'injected' || receipt.status === 'dispatched')
        ));
        if (!injection) continue;
        await recordAssetUsageReceipt(userId, {
          taskRunId,
          projectionId: citation.projection_id,
          assetId: citation.asset_id,
          assetVersion: citation.version,
          injectionReceiptId: injection.id,
          status: 'contradicted',
          evidenceKind: 'agent_action',
          evidenceRefs: [{ kind: 'conversation', id: input.cid, title: 'user negative feedback' }],
          boundary: 'real',
          reason: `用户对消息 ${input.messageId} 点了「需改进」`,
        }).catch(() => undefined);
      }
    } catch {
      // 收据侧失败不阻断反馈记账——流水里已有 feedback_negative。
    }
    try {
      const allUsage = await listRecallUsage(userId);
      const { recommendAbilityAssetAction } = await import('./asset-service');
      for (const citation of message.recall_citations) {
        const negatives = allUsage.filter((record) => (
          record.assetId === citation.asset_id && record.outcome === 'feedback_negative'
        )).length;
        if (negatives < 2) continue;
        await recommendAbilityAssetAction(userId, citation.asset_id, {
          action: 'pause',
          reason: `累计 ${negatives} 次用户负反馈（「需改进」），建议暂停注入并复核内容`,
          actor: 'system',
        }).catch(() => undefined);
      }
    } catch {
      // 治理建议失败同样不阻断——幂等，下次负反馈会再尝试。
    }
  }
  return {
    feedback: input.feedback,
    citationCount: message.recall_citations.length,
    recordedCount: records.length,
    records,
  };
}
