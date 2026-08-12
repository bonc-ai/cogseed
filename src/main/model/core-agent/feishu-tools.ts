/**
 * Commander-only Feishu tools for Core Agent.
 *
 * Expose the Feishu touchpoint surface to the model: connection/briefing/
 * touchpoint status (read-only) plus daily-briefing scheduling (write). All
 * business logic lives in the owning features; these tools are thin adapters
 * that validate shapes and map results. `briefing_schedule` mutates user
 * configuration, so its description tells the model to state the intended
 * change to the user before calling it.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';

import * as autoTasks from '../../features/auto_tasks';
import * as touchpointLedger from '../../features/touchpoints/ledger';
import * as application from '../../features/personal_context/application';
import * as proactive from '../../features/messaging/proactive';
import { isPathAllowed } from '../../util/path-sandbox';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';

export interface FeishuToolsOpts {
  userId: string;
  /** Conversation id: scopes attachment roots and confirms routing. */
  cid?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  turnId?: string;
}

/** Roots the model may send files from: workspace + conversation attachments
 * (mirrors the local file tools' scope). */
function feishuFileRoots(opts: FeishuToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId);
      if (ws) roots.push(ws);
    } catch {
      // workspace resolution failure leaves the workspace root out; other
      // roots still apply
    }
    if (opts.cid) {
      try {
        roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid));
      } catch {
        // attachment dir unavailable; workspace root still applies
      }
    }
  }
  if (opts.extraRoots?.length) {
    for (const root of opts.extraRoots) if (root) roots.push(root);
  }
  return roots;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

function okResult(value: unknown): ToolResult {
  return { content: JSON.stringify(value) };
}

function briefingTaskView(task: {
  schedule: { type: string; hour?: number; minute?: number; at?: string };
  enabled?: boolean;
}): Record<string, unknown> {
  if (task.schedule.type === 'daily') {
    return {
      schedule: 'daily',
      time: `${String(task.schedule.hour ?? 0).padStart(2, '0')}:${String(task.schedule.minute ?? 0).padStart(2, '0')}`,
      enabled: task.enabled === true,
    };
  }
  return { schedule: 'one_time', at: task.schedule.at ?? null, enabled: task.enabled === true };
}

function createDashboardTool(opts: FeishuToolsOpts): AgentTool {
  return {
    name: 'feishu_dashboard',
    description:
      'Read the Feishu companion status: messaging bot connection, personal-context ' +
      'authorization and sync state, and daily-briefing configuration. Read-only; returns a ' +
      'sanitized summary without credentials or ids. Call this first when the user asks ' +
      'anything about their Feishu setup, briefing, or touchpoint notifications.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    executionMode: 'parallel',
    async execute(): Promise<ToolResult> {
      try {
        const dashboard = await application.getDashboard(opts.userId);
        return okResult({
          mode: dashboard.mode,
          messaging: dashboard.messaging,
          authorization: dashboard.authorization,
          sync: dashboard.sync,
          briefing: dashboard.briefing,
        });
      } catch (err) {
        return errResult('E_FEISHU_DASHBOARD_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createBriefingGetTool(opts: FeishuToolsOpts): AgentTool {
  return {
    name: 'briefing_get',
    description:
      'Read the daily-briefing configuration: whether a daily briefing is scheduled, at what ' +
      'time, whether it is enabled, and the most recent delivery outcome if any. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    executionMode: 'parallel',
    async execute(): Promise<ToolResult> {
      try {
        const tasks = await autoTasks.listTasks(opts.userId);
        const briefingTasks = tasks
          .filter((task) => task.briefing === true)
          .map((task) => briefingTaskView(task));
        return okResult({ briefing_tasks: briefingTasks });
      } catch (err) {
        return errResult('E_BRIEFING_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createBriefingScheduleTool(opts: FeishuToolsOpts): AgentTool {
  return {
    name: 'briefing_schedule',
    description:
      'Set or change the daily briefing time (24h HH:MM). This mutates the user\'s briefing ' +
      'configuration immediately: state the intended new time to the user before calling, and ' +
      'confirm the resulting configuration after. hour 0-23, minute 0-59.',
    inputSchema: {
      type: 'object',
      properties: {
        hour: {
          type: 'number',
          minimum: 0,
          maximum: 23,
          description: 'Hour of the daily briefing (24h, 0-23).',
        },
        minute: {
          type: 'number',
          minimum: 0,
          maximum: 59,
          description: 'Minute of the daily briefing (0-59).',
        },
      },
      required: ['hour', 'minute'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const raw = input as { hour?: unknown; minute?: unknown };
      const hour = typeof raw.hour === 'number' && Number.isInteger(raw.hour) ? raw.hour : -1;
      const minute = typeof raw.minute === 'number' && Number.isInteger(raw.minute) ? raw.minute : -1;
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return errResult('E_BRIEFING_INVALID_INPUT', 'hour must be 0-23 and minute 0-59');
      }
      try {
        const result = await application.scheduleBriefing(opts.userId, { hour, minute });
        if (result.error) return errResult('E_BRIEFING_SCHEDULE_FAILED', result.error);
        return okResult({ ok: true, task_id: result.taskId, briefing: result.dashboard.briefing });
      } catch (err) {
        return errResult('E_BRIEFING_SCHEDULE_FAILED', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

function createTouchpointListTool(opts: FeishuToolsOpts): AgentTool {
  return {
    name: 'touchpoint_list',
    description:
      'List recent touchpoint notifications (intents) and their recorded actions: what was ' +
      'sent to Feishu, its delivery state, and which card buttons the owner clicked with any ' +
      'submitted text. Read-only; returns the most recent entries. Use when the user asks ' +
      '"what did you send me" or "what did I approve/snooze recently".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: 'Max intents to return (default 5).',
        },
      },
      additionalProperties: false,
    },
    executionMode: 'parallel',
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const raw = input as { limit?: unknown };
      const limit = typeof raw.limit === 'number' && Number.isInteger(raw.limit) ? raw.limit : 5;
      try {
        const intents = (await touchpointLedger.listTouchpointIntents(opts.userId)).slice(0, limit);
        const actions = await touchpointLedger.listTouchpointActions(opts.userId, 10);
        return okResult({
          intents: intents.map((intent) => ({
            intent_id: intent.intentId,
            template: intent.template,
            title: intent.content.title,
            status: intent.status,
            delivered_at: intent.updatedAt,
            action_required: intent.requiresAction,
          })),
          actions: actions.map((action) => ({
            action_id: action.actionId,
            intent_id: action.intentId,
            action: action.action,
            content: action.content ?? null,
            consumed_at: action.consumedAt,
          })),
        });
      } catch (err) {
        return errResult('E_TOUCHPOINT_UNAVAILABLE', err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Stable per-(turn, path) source key: a replayed call reuses the ledger
 * entry and never sends the file twice. */
function fileSourceKeyFor(cid: string | undefined, turnId: string | undefined, filePath: string): string {
  const digest = crypto.createHash('sha256').update(filePath.trim(), 'utf8').digest('hex').slice(0, 24);
  return `file:${cid || 'turn'}:${turnId || 'turn'}:${digest}`;
}

function createSendFileTool(opts: FeishuToolsOpts): AgentTool {
  return {
    name: 'messaging_send_file',
    description:
      'Send a local file (markdown, Word, PDF, spreadsheet, …) to the configured owner ("self") ' +
      'through one Feishu/Lark bot. The user must approve a confirmation dialog before anything ' +
      'is uploaded or sent; a denied, timed-out, or aborted request reports not_sent and must not ' +
      'be retried automatically. file_path must be an absolute path the user can read via ' +
      'read_file (workspace or conversation attachment scope) — never guess paths outside that ' +
      'scope. Omit instance_id only when exactly one bot is available; with several, use the ' +
      'instance_id from messaging_list_targets.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Optional bot instance id from messaging_list_targets; required when several bots are available.',
        },
        file_path: {
          type: 'string',
          description: 'Absolute path of the local file to send (workspace/attachment scope).',
        },
        file_name: {
          type: 'string',
          description: 'Optional display file name; defaults to the base name of file_path.',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const raw = input as { instance_id?: unknown; file_path?: unknown; file_name?: unknown };
      const filePath = typeof raw.file_path === 'string' ? raw.file_path.trim() : '';
      if (!filePath) {
        return errResult('E_MESSAGING_INVALID_INPUT', 'file_path is required');
      }
      const roots = feishuFileRoots(opts);
      if (!roots.length || !isPathAllowed(filePath, roots)) {
        return errResult(
          'E_PATH_OUT_OF_SCOPE',
          'file_path is outside the workspace/attachment scope of this conversation',
        );
      }
      const fileName = typeof raw.file_name === 'string' && raw.file_name.trim()
        ? raw.file_name.trim()
        : path.basename(filePath);
      const instanceId = raw.instance_id === undefined ? undefined : String(raw.instance_id).trim();
      const result = await proactive.sendFileToSelf(
        opts.userId,
        {
          ...(instanceId ? { instance_id: instanceId } : {}),
          file_path: filePath,
          file_name: fileName,
        },
        {
          cid: opts.cid || 'turn',
          sourceKey: fileSourceKeyFor(opts.cid, opts.turnId, filePath),
          signal: ctx.signal ?? null,
        },
      );
      const content = JSON.stringify(result);
      if (result.status === 'error') return { content, isError: true };
      return { content };
    },
  };
}

/** Build the Commander-only Feishu tools. Inject only for gconv sessions
 * with a resolved uid (see runner.ts). */
export function createFeishuTools(opts: FeishuToolsOpts): AgentTool[] {
  return [
    createDashboardTool(opts),
    createBriefingGetTool(opts),
    createBriefingScheduleTool(opts),
    createTouchpointListTool(opts),
    createSendFileTool(opts),
  ];
}
