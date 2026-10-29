import * as crypto from 'node:crypto';

import type { RuntimeHostToolClient } from './host-tools';
import type { RuntimeToolResult } from './file-tools';

export type RuntimeSensitiveAction = 'bash' | 'run_skill' | 'connector_call';
export type RuntimeActionRisk = 'high' | 'critical';

export interface RuntimeActionApprovalIntent {
  action: RuntimeSensitiveAction;
  target: string;
  verbatimTarget?: boolean;
  scope: string;
  auditTarget: string;
  auditScope: string;
  risk: RuntimeActionRisk;
  reasons: string[];
  /** Exact action inputs. They are fingerprinted locally and never sent to the renderer. */
  execution: unknown;
}

export interface RuntimeActionApprovalClient {
  request(intent: RuntimeActionApprovalIntent, signal?: AbortSignal | null): Promise<{ approved: true; requestId: string } | { approved: false; code: string }>;
  record(requestId: string, phase: 'started' | 'succeeded' | 'failed', resultCode?: string, signal?: AbortSignal | null): Promise<void>;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function errorCode(content: string): string {
  const match = String(content || '').match(/\[(E_[A-Z0-9_]+)\]/);
  return match ? match[1] : 'E_RUNTIME_ACTION_FAILED';
}

export function createRuntimeActionApprovalClient(options: {
  hostToolClient?: RuntimeHostToolClient;
  requestId: string;
  runtimeSessionId: string;
  actor: string;
}): RuntimeActionApprovalClient {
  return {
    async request(intent, signal) {
      if (!options.hostToolClient) return { approved: false, code: 'E_ACTION_APPROVAL_UNAVAILABLE' };
      const fingerprint = crypto.createHash('sha256').update(canonical({
        actor: options.actor,
        action: intent.action,
        target: intent.target,
        scope: intent.scope,
        execution: intent.execution,
      })).digest('hex');
      let response: RuntimeToolResult;
      try {
        response = await options.hostToolClient.call({
          requestId: options.requestId,
          runtimeSessionId: options.runtimeSessionId,
          name: 'action_approval_request',
          input: {
            actor: options.actor,
            action: intent.action,
            target: intent.target,
            ...(intent.verbatimTarget ? { verbatim_target: true } : {}),
            scope: intent.scope,
            audit_target: intent.auditTarget,
            audit_scope: intent.auditScope,
            risk: intent.risk,
            reasons: intent.reasons,
            fingerprint,
          },
          signal,
        });
      } catch {
        return { approved: false, code: 'E_ACTION_APPROVAL_CANCELLED' };
      }
      const parsed = parseObject(response.content);
      if (parsed?.approved === true && typeof parsed.request_id === 'string') {
        return { approved: true, requestId: parsed.request_id };
      }
      return {
        approved: false,
        code: typeof parsed?.code === 'string' ? parsed.code : (response.isError ? errorCode(response.content) : 'E_ACTION_APPROVAL_DENIED'),
      };
    },

    async record(requestId, phase, resultCode, signal) {
      if (!options.hostToolClient) {
        if (phase === 'started') throw new Error('E_ACTION_APPROVAL_NOT_ACTIVE');
        return;
      }
      try {
        const response = await options.hostToolClient.call({
          requestId: options.requestId,
          runtimeSessionId: options.runtimeSessionId,
          name: 'action_approval_execution',
          input: {
            approval_request_id: requestId,
            phase,
            ...(resultCode ? { result_code: resultCode } : {}),
          },
          signal,
        });
        if (phase === 'started' && (response.isError || parseObject(response.content)?.ok !== true)) {
          throw new Error('E_ACTION_APPROVAL_NOT_ACTIVE');
        }
      } catch {
        if (phase === 'started') throw new Error('E_ACTION_APPROVAL_NOT_ACTIVE');
        // Terminal reporting is best-effort; never retry a completed action.
      }
    },
  };
}

export async function runWithRuntimeActionApproval(
  client: RuntimeActionApprovalClient | undefined,
  intent: RuntimeActionApprovalIntent,
  execute: () => Promise<RuntimeToolResult>,
  signal?: AbortSignal | null,
): Promise<RuntimeToolResult> {
  if (!client) return { content: '[E_ACTION_APPROVAL_UNAVAILABLE] sensitive action approval is unavailable', isError: true };
  const decision = await client.request(intent, signal);
  if (decision.approved === false) {
    return { content: `[${decision.code}] sensitive action was not approved`, isError: true };
  }
  return runWithRuntimeActionApprovalGrant(client, decision.requestId, execute, signal);
}

/** Consume a grant obtained either by the worker client or host preflight. */
export async function runWithRuntimeActionApprovalGrant(
  client: Pick<RuntimeActionApprovalClient, 'record'> | undefined,
  requestId: string,
  execute: () => Promise<RuntimeToolResult>,
  signal?: AbortSignal | null,
): Promise<RuntimeToolResult> {
  if (!client) return { content: '[E_ACTION_APPROVAL_UNAVAILABLE] execution reporting is unavailable', isError: true };
  // Audit must still reach the host when the execution signal is cancelled.
  try {
    await client.record(requestId, 'started');
  } catch {
    return { content: '[E_ACTION_APPROVAL_NOT_ACTIVE] host did not acknowledge approval consumption; action was not executed', isError: true };
  }
  try {
    const cancelled = () => ({ content: '[E_ACTION_APPROVAL_CANCELLED] action cancelled', isError: true });
    let result = signal?.aborted ? cancelled() : await execute();
    if (signal?.aborted) result = cancelled();
    await client.record(requestId, result.isError ? 'failed' : 'succeeded', result.isError ? errorCode(result.content) : undefined);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.record(requestId, 'failed', 'E_RUNTIME_ACTION_THROW');
    return { content: `[E_RUNTIME_ACTION_THROW] ${message}`, isError: true };
  }
}
