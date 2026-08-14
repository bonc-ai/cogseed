/**
 * CogSeed Runtime host-tool adapter for proactive messaging.
 *
 * Thin bridge between a validated `RuntimeHostToolCall` and the shared
 * messaging feature: it performs shape validation only and forwards the
 * rest (target resolution, confirmation, delivery, result mapping) to
 * `features/messaging/proactive`. The host router already verified the
 * caller's Commander capability before dispatching here.
 */

import * as proactive from '../messaging/proactive';
import type { ProactiveSendResult } from '../messaging/proactive';

export interface MessagingHostToolContext {
  userId: string;
  /** Stable per-(request, call) key so a replayed host call never sends twice. */
  sourceKey: string;
  signal?: AbortSignal | null;
}

export async function runMessagingHostTool(
  name: 'messaging_list_targets' | 'messaging_send',
  input: Record<string, unknown>,
  context: MessagingHostToolContext,
): Promise<{ content: string; isError?: boolean }> {
  if (name === 'messaging_list_targets') {
    return { content: JSON.stringify(await proactive.listTargets(context.userId)) };
  }
  const raw = input as { instance_id?: unknown; target?: unknown; text?: unknown };
  if (raw.target !== 'self') {
    return { content: JSON.stringify({ status: 'error', code: 'E_MESSAGING_TARGET_UNAVAILABLE', message: 'target must be "self"' }), isError: true };
  }
  if (typeof raw.text !== 'string' || !raw.text.trim()) {
    return { content: JSON.stringify({ status: 'error', code: 'E_MESSAGING_INVALID_INPUT', message: 'text is required' }), isError: true };
  }
  const instanceId = raw.instance_id === undefined ? undefined : String(raw.instance_id).trim();
  const result: ProactiveSendResult = await proactive.sendToSelf(
    context.userId,
    {
      ...(instanceId ? { instance_id: instanceId } : {}),
      target: 'self',
      text: raw.text,
    },
    { cid: context.sourceKey, sourceKey: context.sourceKey, signal: context.signal ?? null },
  );
  const content = JSON.stringify(result);
  return result.status === 'error' ? { content, isError: true } : { content };
}
