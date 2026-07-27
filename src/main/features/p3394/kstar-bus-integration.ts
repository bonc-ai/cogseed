/**
 * kstar-bus-integration.ts — Bus-to-Adapter evidence bridge
 *
 * Routes Bus evidence recording through the KSTAR adapter instead of direct
 * legacy PC KSTAR runtime calls. Preserves existing Bus call signatures while adding
 * adapter-based recording with deduplication and degraded-mode fallback.
 *
 * Integration points:
 * - maybeRecordKStarCompatToolCycle → recordToolCycleEvidence
 * - recordAgentRunEvidence → recordAgentRunStartEvidence
 * - recordAgentContribution → recordAgentContributionEvidence
 *
 * The adapter handles:
 * - Stable ID deduplication (prevents duplicate evidence on retry)
 * - Degraded mode (appends to pending log when Engine unavailable)
 * - CAS transactions for snapshot consistency
 */

import { createLogger } from '../../logger';
import { genId12, nowIso } from '../../storage';
import { getKstarAdapter } from './kstar-factory';
import { appendPendingEvidence, getPendingEvidencePath } from './kstar-store';
import * as fs from 'node:fs/promises';
import type { KStarDecisionRecord } from './kstar-compat';

const log = createLogger('p3394.kstar-bus-integration');

export interface ToolCycleEvidenceInput {
  userId: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  argumentsShape?: Record<string, unknown>;
  resultPreview: string;
  resultSize?: number;
  isError: boolean;
  durationMs?: number;
}

export interface AgentRunStartEvidenceInput {
  userId: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  data: Record<string, unknown>;
}

export interface AgentContributionEvidenceInput {
  userId: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  messageId: string;
  actualResult: string;
  kstarDecision?: KStarDecisionRecord;
  outcomeStatus: string;
  actualAction: string;
}

async function appendPendingAdapterEvidence(
  userId: string,
  evidence: Record<string, unknown>,
): Promise<{ success: false; degraded: true }> {
  try {
    await appendPendingEvidence(userId, evidence);
  } catch (err) {
    log.warn('failed to append pending kstar evidence', {
      userId,
      evidenceId: evidence.id,
      error: (err as Error).message,
    });
  }
  return { success: false, degraded: true };
}

async function hasPendingContributionEvidence(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const content = await fs.readFile(getPendingEvidencePath(userId), 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .some((line) => {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          return record.conversation_id === conversationId &&
            record.type === 'conversation_message' &&
            !!(record.kstar_decision as { required?: unknown } | undefined)?.required;
        } catch {
          return false;
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Record tool cycle evidence through the adapter.
 * Replaces recordKStarCompatToolCycle from legacy PC KSTAR runtime.
 */
export async function recordToolCycleEvidence(
  input: ToolCycleEvidenceInput,
): Promise<{ success: boolean; degraded?: boolean }> {
  const evidenceId = `tool-${input.conversationId}-${input.agentId}-${input.turnId}-${input.toolCallId}`;
  const evidence = {
    id: evidenceId,
    type: 'tool_cycle',
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    turn_id: input.turnId,
    tool_call_id: input.toolCallId,
    tool_name: input.toolName,
    phase: 'end',
    arguments_shape: input.argumentsShape,
    result_preview: input.resultPreview,
    result_size: input.resultSize,
    is_error: input.isError,
    status: input.isError ? 'failed' : 'succeeded',
    verifier_method: input.isError ? 'error_signal' : 'generic_signal',
    duration_ms: input.durationMs,
    created_at: nowIso(),
  };

  const adapter = await getKstarAdapter(input.userId);
  if (!adapter) {
    log.warn('adapter unavailable for tool cycle', {
      userId: input.userId,
      conversationId: input.conversationId,
      agentId: input.agentId,
    });
    return appendPendingAdapterEvidence(input.userId, evidence);
  }

  const result = await adapter.recordEvidence(evidence);
  return result.success ? result : appendPendingAdapterEvidence(input.userId, evidence);
}

/**
 * Record agent run start evidence through the adapter.
 * Replaces recordAgentRunEvidence from legacy PC KSTAR runtime.
 */
export async function recordAgentRunStartEvidence(
  input: AgentRunStartEvidenceInput,
): Promise<{ success: boolean; degraded?: boolean }> {
  const evidenceId = `run-start-${input.conversationId}-${input.agentId}-${input.turnId}`;
  const evidence = {
    id: evidenceId,
    type: 'agent_run_result',
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    turn_id: input.turnId,
    phase: 'start',
    ...input.data,
    created_at: nowIso(),
  };

  const adapter = await getKstarAdapter(input.userId);
  if (!adapter) {
    log.warn('adapter unavailable for agent run start', {
      userId: input.userId,
      conversationId: input.conversationId,
      agentId: input.agentId,
    });
    return appendPendingAdapterEvidence(input.userId, evidence);
  }

  const result = await adapter.recordEvidence(evidence);
  return result.success ? result : appendPendingAdapterEvidence(input.userId, evidence);
}

/**
 * Record agent contribution evidence through the adapter.
 * Replaces recordAgentContribution from legacy PC KSTAR runtime.
 */
export async function recordAgentContributionEvidence(
  input: AgentContributionEvidenceInput,
): Promise<{ success: boolean; degraded?: boolean }> {
  const evidenceId = `contribution-${input.conversationId}-${input.agentId}-${input.turnId}-${input.messageId}`;
  const evidence = {
    id: evidenceId,
    type: 'conversation_message',
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    turn_id: input.turnId,
    message_id: input.messageId,
    actual_result: input.actualResult,
    kstar_decision: input.kstarDecision,
    outcome_status: input.outcomeStatus,
    actual_action: input.actualAction,
    created_at: nowIso(),
  };

  const adapter = await getKstarAdapter(input.userId);
  if (!adapter) {
    log.warn('adapter unavailable for agent contribution', {
      userId: input.userId,
      conversationId: input.conversationId,
      agentId: input.agentId,
    });
    return appendPendingAdapterEvidence(input.userId, evidence);
  }

  const result = await adapter.recordEvidence(evidence);
  return result.success ? result : appendPendingAdapterEvidence(input.userId, evidence);
}

/**
 * Close collaboration and finalize KSTAR run through the adapter.
 * Replaces finalizeCommanderCollaboration from legacy PC KSTAR runtime.
 */
export async function closeCollaborationEvidence(
  userId: string,
  input: {
    conversationId: string;
    commanderId?: string;
    outcomeStatus: 'completed' | 'failed' | 'cancelled';
  },
): Promise<{ success: boolean; runId?: string }> {
  const commanderId = input.commanderId || 'commander';
  const runId = `collab-${input.conversationId}-${commanderId}-${Date.now()}`;
  const evidence = {
    id: runId,
    type: 'collaboration_close',
    conversation_id: input.conversationId,
    commander_id: commanderId,
    outcome_status: input.outcomeStatus,
    created_at: nowIso(),
  };

  const adapter = await getKstarAdapter(userId);
  if (!adapter) {
    log.warn('adapter unavailable for close collaboration', {
      userId,
      conversationId: input.conversationId,
    });
    if (await hasPendingContributionEvidence(userId, input.conversationId)) {
      await appendPendingAdapterEvidence(userId, evidence);
    }
    return { success: false };
  }

  const result = await adapter.recordEvidence(evidence);
  if (!result.success) {
    await appendPendingAdapterEvidence(userId, evidence);
    return { success: false };
  }
  return { success: true, runId };
}
