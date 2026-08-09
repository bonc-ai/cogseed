import { readMessages } from './index';
import { subscribeTaskNotificationTerminals, type TaskTerminalEvent, type TaskTerminalListener } from '../task_notification_terminal_source';
import { handleRecallTaskTerminal } from '../recall/terminal-proof';
import type { GroupMessage } from './visibility';
import { createLogger } from '../../logger';

const log = createLogger('group-chat.recall-terminal-proof');

function projectionIds(messages: GroupMessage[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const message of messages) {
    const id = message.recall_projection_card?.projectionId;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export type GroupChatRecallTerminalSubscribe = (listener: TaskTerminalListener) => () => void;
export type GroupChatRecallMessageReader = (userId: string, cid: string, limit?: number) => Promise<GroupMessage[]>;

export function startGroupChatRecallTerminalProofs(
  subscribe: GroupChatRecallTerminalSubscribe = subscribeTaskNotificationTerminals,
  read: GroupChatRecallMessageReader = readMessages,
): () => void {
  const inFlight = new Set<string>();
  const listener: TaskTerminalListener = (event: TaskTerminalEvent) => {
    const key = `${event.user_id}:${event.conversation_id}:${event.logical_run_id || event.run_id}:${event.execution_id || event.run_id}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void (async () => {
      const ids = event.projection_id
        ? [event.projection_id]
        : projectionIds(await read(event.user_id, event.conversation_id, 500));
      for (const projectionId of ids) {
        await handleRecallTaskTerminal({ ...event, projection_id: projectionId, ...(event as any).wake_request_id ? { wake_request_id: (event as any).wake_request_id } : {} });
      }
    })()
      .catch((error) => log.warn('terminal transfer proof failed', { error: (error as Error).message, runId: event.run_id }))
      .finally(() => inFlight.delete(key));
  };
  const unsubscribe = subscribe(listener);
  return () => {
    unsubscribe();
    inFlight.clear();
  };
}
