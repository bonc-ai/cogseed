/** Resolve a durable message identity through the canonical paged chat reader.
 * Never substitute the newest answer when the requested result is unavailable. */
import { getMessagesPage } from '../chats';
import type { GroupMessage } from '../group_chat/visibility';

export async function findConversationMessage(
  userId: string, conversationId: string, matches: (message: GroupMessage) => boolean,
): Promise<GroupMessage | undefined> {
  let before: number | undefined;
  const cursors = new Set<number>();
  while (true) {
    const page = await getMessagesPage(userId, conversationId, 1_000, before);
    const found = [...page.history].reverse().find(message => !message.deleted_at && matches(message));
    if (found) return found;
    if (page.nextCursor === null) return undefined;
    if (cursors.has(page.nextCursor)) throw new Error('conversation message cursor did not advance');
    cursors.add(page.nextCursor);
    before = page.nextCursor;
  }
}

export function findConversationMessageById(userId: string, conversationId: string, messageId: string): Promise<GroupMessage | undefined> {
  return findConversationMessage(userId, conversationId, message => message.id === messageId);
}
