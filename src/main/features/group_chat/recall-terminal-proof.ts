import { readMessages } from './index';
import { subscribeTaskNotificationTerminals, type TaskTerminalEvent, type TaskTerminalListener } from '../task_notification_terminal_source';
import { handleRecallTaskTerminal } from '../recall/terminal-proof';
import { listContextProjections } from '../recall/context-projection';
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

/** Turn 级投影兜底发现（T2.3 · 2026-09-13）：普通会话（无 KSTAR
 *  requirement）终态事件不带 projection_id，旧兜底只扫消息里的手工投影卡
 *  ——自动投影（proj-auto-*）从不发卡，注入了资产也永远进不了证明链（实机
 *  零证明的真因之一）。reuse_turn_ids 只在真实落过回执的 turn 上登记，
 *  以它反查「confirmed、未过期、taskRunId=该 turn」的投影，等价于按
 *  「本轮真的注入过」找证明锚点。上限对齐注入侧 MAX_PROJECTIONS=8。 */
async function turnProjectionIds(
  userId: string,
  reuseTurnIds: readonly string[] | undefined,
): Promise<string[]> {
  if (!reuseTurnIds?.length) return [];
  try {
    const projections = await listContextProjections(userId);
    const turns = new Set(reuseTurnIds);
    return projections
      .filter((projection) => projection.status === 'confirmed'
        && turns.has(projection.taskRunId)
        && !(projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()))
      .map((projection) => projection.id)
      .slice(0, 8);
  } catch (error) {
    log.warn('terminal turn-projection discovery failed', { error: (error as Error).message });
    return [];
  }
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
      const manualIds = event.projection_id
        ? [event.projection_id]
        : projectionIds(await read(event.user_id, event.conversation_id, 500));
      const turnIds = event.projection_id
        ? []
        : await turnProjectionIds(event.user_id, event.reuse_turn_ids);
      const ids = [...new Set([...manualIds, ...turnIds])];
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
