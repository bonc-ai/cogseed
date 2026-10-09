import type { GroupMessage } from '../group_chat/visibility';

const INTERNAL_MESSAGE_SENDERS = new Set(['system', 'tool', 'process']);

export function isRecallAssistantMessage(message: Pick<GroupMessage, 'from'>): boolean {
  const sender = String(message.from || '').trim().toLocaleLowerCase();
  return Boolean(sender) && sender !== 'user' && !INTERNAL_MESSAGE_SENDERS.has(sender);
}

export function isRecallConversationMessage(message: GroupMessage): boolean {
  return !message.deleted_at
    && !message.dispatch
    && !message.system_kind
    && !message.failure_kind
    && typeof message.text === 'string'
    && Boolean(message.text.trim())
    && (message.from === 'user' || isRecallAssistantMessage(message));
}
