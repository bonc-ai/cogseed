import { getMessagesPage, listA2AConversationDirectoryRows } from '../chats';
import { getCachedContact } from '../contacts/store';
import { parseA2AConversationMarker, type A2AConversationState } from './conversation-marker';

const MAX_CONVERSATIONS = 50;
const PREVIEW_CONCURRENCY = 8;
const PREVIEW_LENGTH = 80;

export interface A2AConversationSummary {
  conversationId: string;
  title: string;
  updatedAt: string;
  state: A2AConversationState;
  preview: string;
}

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await map(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function listA2AConversationsForContact(
  userId: string,
  peerUserId: string,
): Promise<A2AConversationSummary[]> {
  const peer = String(peerUserId || '').trim();
  if (!peer || !(await getCachedContact(userId, peer))) return [];
  const matches = (await listA2AConversationDirectoryRows(userId))
    .flatMap((row) => {
      const marker = parseA2AConversationMarker(row.a2a);
      return marker?.peer_user_id === peer && marker.state !== 'ended'
        ? [{ row, state: marker.state }]
        : [];
    })
    .sort((a, b) => (
      b.row.updated_at.localeCompare(a.row.updated_at)
      || a.row.conversation_id.localeCompare(b.row.conversation_id)
    ))
    .slice(0, MAX_CONVERSATIONS);
  return mapBounded(matches, PREVIEW_CONCURRENCY, async ({ row, state }) => {
    const latest = await getMessagesPage(
      userId,
      row.conversation_id,
      1,
      undefined,
      row.project_id ?? null,
    ).then((page) => page.history.at(-1)).catch(() => undefined);
    return {
      conversationId: row.conversation_id,
      title: String(row.title || ''),
      updatedAt: String(row.updated_at || ''),
      state,
      preview: String(latest?.text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LENGTH),
    };
  });
}
