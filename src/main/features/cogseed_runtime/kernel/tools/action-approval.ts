import * as crypto from 'node:crypto';

import type { RuntimeHostToolClient } from './host-tools';
import type { RuntimeToolResult } from './file-tools';

export type RuntimeSensitiveAction = 'bash' | 'run_skill' | 'connector_call';
export type RuntimeActionRisk = 'high' | 'critical';

export interface RuntimeActionApprovalIntent {
  action: RuntimeSensitiveAction;
  target: string;
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
      if (!options.hostToolClient) return;
      try {
        await options.hostToolClient.call({
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
      } catch {
        // The action has already been approved or executed. Do not turn a
        // successful tool result into a retry loop solely because audit append
        // reporting became unavailable.
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
  await client.record(decision.requestId, 'started', undefined, signal);
  try {
    const result = await execute();
    await client.record(decision.requestId, result.isError ? 'failed' : 'succeeded', result.isError ? errorCode(result.content) : undefined, signal);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.record(decision.requestId, 'failed', 'E_RUNTIME_ACTION_THROW', signal);
    return { content: `[E_RUNTIME_ACTION_THROW] ${message}`, isError: true };
  }
}
