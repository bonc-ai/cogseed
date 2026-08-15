import type { AgentTool } from '#core-agent';
import type { ChatResolvedRuntime } from '../../model/client';
import { executeKstarControl } from './control-service';
import type { KstarControlHostContext, KstarControlResult } from './control-types';

export interface CreateKstarControlToolOptions {
  userId: string;
  conversationId: string;
  sourceMessageId?: string;
  /** Exact user message text for host self-healing of empty upsert_state. */
  sourceMessageText?: string;
  workspaceId?: string;
  resolvedRuntime: () => ChatResolvedRuntime | null;
  executeControl?: (
    context: KstarControlHostContext,
    rawInput: unknown,
  ) => Promise<KstarControlResult>;
}

export function isCommanderCentricKstarEnabled(): boolean {
  // Commander-centric KStar is the default. Only an exact '0' disables the
  // tool; the disabled state never reinstates the deleted pre-router.
  return process.env.ORKAS_COMMANDER_CENTRIC_KSTAR !== '0';
}

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ['upsert_state', 'request_projection', 'commit_forecast', 'finish', 'abandon'],
      description: [
        'Explicit KStar lifecycle operation.',
        'upsert_state: create/open a tracked task — requires task.operation ("create" for a new task) and requirement.operation + goalText.',
        'request_projection: preload assets for the current requirement — requires projection { purpose, taskText } (requirementId optional; the host resolves it from current state).',
        'commit_forecast: after the projection is confirmed, submit 2-4 candidates — requires forecast { candidates (2-4 objects with id/plan/expectedTools/expectedActors/predictedResult), constraints?, acceptanceCriteria? }. Do NOT supply taskRunId/requirementId/projectionId — the host resolves them from current state and ignores guessed values.',
        'finish: close the loop with terminal evidence — requires result { finalStatus, finalText, producedFiles, acceptanceEvidence }.',
        'abandon: drop the task — requires result { closeReason }.',
      ].join(' '),
    },
    idempotencyKey: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description: 'Stable unique key for this intended state transition.',
    },
    task: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['keep', 'create', 'update', 'close'] },
        taskId: { type: 'string' },
        title: { type: 'string', maxLength: 200 },
        closeReason: { type: 'string', maxLength: 1000 },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    requirement: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['keep', 'create', 'update', 'close'] },
        requirementId: { type: 'string' },
        goalText: { type: 'string', maxLength: 4000 },
        expectedResult: {
          type: 'object',
          properties: {
            summary: { type: 'string', maxLength: 4000 },
            acceptanceSignals: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 1000 } },
            source: { type: 'string', enum: ['user_message', 'model', 'unknown'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['summary', 'acceptanceSignals', 'source', 'confidence'],
          additionalProperties: false,
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    projection: {
      type: 'object',
      properties: {
        requirementId: { type: 'string', description: 'Optional — the host resolves the current requirement from state when absent.' },
        purpose: { type: 'string', maxLength: 120 },
        taskText: { type: 'string', maxLength: 4000 },
      },
      required: ['purpose'],
      additionalProperties: false,
    },
    forecast: {
      type: 'object',
      properties: {
        taskRunId: { type: 'string', description: 'Deprecated — host resolves from state; guessed values ignored.' },
        requirementId: { type: 'string', description: 'Deprecated — host resolves from state; guessed values ignored.' },
        projectionId: { type: 'string', description: 'Deprecated — host resolves from state; guessed values ignored.' },
        candidates: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object' } },
        constraints: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1000 } },
        acceptanceCriteria: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1000 } },
      },
      required: ['candidates'],
      additionalProperties: false,
    },
    result: {
      type: 'object',
      properties: {
        finalStatus: { type: 'string', enum: ['completed', 'failed', 'cancelled'] },
        finalText: { type: 'string', maxLength: 4000 },
        producedFiles: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 1000 } },
        acceptanceEvidence: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 1000 } },
        closeReason: { type: 'string', maxLength: 1000 },
      },
      additionalProperties: false,
    },
  },
  required: ['operation', 'idempotencyKey'],
  additionalProperties: false,
};

export function createKstarControlTool(options: CreateKstarControlToolOptions): AgentTool {
  return {
    name: 'kstar_control',
    description: [
      'Manage explicit KStar Task, Requirement, Projection, Forecast, finish, or abandon transitions.',
      'Do not call this tool for greetings, acknowledgements, thanks, or ordinary conversation.',
      'The host validates ownership, approval, allowed tools, idempotency, scoring, and persistence.',
    ].join(' '),
    inputSchema: INPUT_SCHEMA,
    async execute(input) {
      const runtime = options.resolvedRuntime();
      const context: KstarControlHostContext = {
        userId: options.userId,
        conversationId: options.conversationId,
        ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        ...(options.sourceMessageText?.trim() ? { sourceMessageText: options.sourceMessageText } : {}),
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        allowedToolNames: new Set(runtime?.toolNames || []),
        ...(runtime ? {
          model: {
            providerId: runtime.providerId,
            modelId: runtime.modelId,
            ...(runtime.profileId ? { profileId: runtime.profileId } : {}),
            ...(runtime.entryId ? { entryId: runtime.entryId } : {}),
          },
        } : {}),
      };
      const result = await (options.executeControl || executeKstarControl)(context, input);
      return {
        content: JSON.stringify(result),
        ...(result.ok ? {} : { isError: true as const }),
      };
    },
  };
}
