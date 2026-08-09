/**
 * Commander-only proactive-messaging tools for Core Agent.
 *
 * The model may only name an instance (optional when unambiguous), the fixed
 * `target: "self"`, and text. All validation, target resolution, confirmation,
 * delivery and result mapping live in `features/messaging/proactive`; these
 * tools are thin adapters that forward the turn signal and a stable source key
 * so one tool call can never send twice.
 */

import * as crypto from 'node:crypto';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';

import * as proactive from '../../features/messaging/proactive';
import type { ProactiveSendResult } from '../../features/messaging/proactive';

export interface MessagingToolsOpts {
  userId: string;
  cid: string;
  turnId?: string;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

/** Stable per-(turn, payload) source key: same call replaying (model retry,
 *  duplicate tool batch) reuses the ledger entry and never sends twice. */
function sourceKeyFor(cid: string, turnId: string | undefined, text: string): string {
  const digest = crypto.createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 24);
  return `${cid}:${turnId || 'turn'}:${digest}`;
}

function createListTargetsTool(opts: MessagingToolsOpts): AgentTool {
  return {
    name: 'messaging_list_targets',
    description:
      'List the configured Feishu/Lark bots and which of them can proactively message the ' +
      'configured owner ("self"). Read-only; returns sanitized diagnostics only — never ' +
      'credentials, open ids, or chat ids. When the user asks to send them a Feishu/Lark ' +
      'message, call this first to learn the instance_id and target status.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    executionMode: 'parallel',
    async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      try {
        return { content: JSON.stringify(await proactive.listTargets(opts.userId)) };
      } catch (err) {
        return errResult('E_MESSAGING_TARGET_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createSendTool(opts: MessagingToolsOpts): AgentTool {
  return {
    name: 'messaging_send',
    description:
      'Send a text message to the configured owner ("self") through one Feishu/Lark bot. ' +
      'The user must approve a confirmation dialog before anything is sent; a denied, ' +
      'timed-out, or aborted request reports not_sent and must not be retried automatically. ' +
      'Omit instance_id only when exactly one bot is available; with several, pick the ' +
      'instance_id returned by messaging_list_targets. Never guess ids, and never ask the ' +
      'user for chat ids or open ids — this tool cannot send to arbitrary recipients.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Optional bot instance id from messaging_list_targets; required when several bots are available.',
        },
        target: {
          type: 'string',
          const: 'self',
          description: 'The only supported recipient: the configured owner of this bot.',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 12_000,
          description: 'The message text to send. Keep it concise and complete.',
        },
      },
      required: ['target', 'text'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const raw = input as { instance_id?: unknown; target?: unknown; text?: unknown };
      if (raw.target !== 'self') {
        return errResult('E_MESSAGING_TARGET_UNAVAILABLE', 'target must be "self"');
      }
      if (typeof raw.text !== 'string' || !raw.text.trim()) {
        return errResult('E_MESSAGING_INVALID_INPUT', 'text is required');
      }
      const instanceId = raw.instance_id === undefined ? undefined : String(raw.instance_id).trim();
      const sourceKey = sourceKeyFor(opts.cid, opts.turnId, raw.text);
      const result: ProactiveSendResult = await proactive.sendToSelf(
        opts.userId,
        {
          ...(instanceId ? { instance_id: instanceId } : {}),
          target: 'self',
          text: raw.text,
        },
        { cid: opts.cid, sourceKey, signal: ctx.signal ?? null },
      );
      const content = JSON.stringify(result);
      if (result.status === 'error') return { content, isError: true };
      return { content };
    },
  };
}

/** Build the Commander-only messaging tools. Inject only for gconv sessions
 *  with a resolved uid and cid (see runner.ts). */
export function createMessagingTools(opts: MessagingToolsOpts): AgentTool[] {
  return [createListTargetsTool(opts), createSendTool(opts)];
}
