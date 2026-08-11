/**
 * kstar-bus-integration.ts — CogSeed backend-native KSTAR evidence bridge
 *
 * Group Chat keeps emitting collaboration evidence from the message/event bus,
 * but evidence capture is no longer routed through a standalone Meta Skill
 * Engine adapter. This module is a local backend sink: it writes stable,
 * idempotent evidence records to the user-scoped KSTAR journal and returns the
 * CogSeed backend boundary to callers.
 */

import * as fs from 'node:fs/promises';
import { createLogger } from '../../logger';
import { nowIso } from '../../storage';
import { getPendingEvidencePath } from './kstar-store';
import type { KStarDecisionRecord } from './kstar-compat';
import type { ExecutionBoundaryInfo } from './execution-boundary';

const log = createLogger('p3394.kstar-bus-integration');
const COGSEED_BOUNDARY: ExecutionBoundaryInfo = { mode: 'real', provider: 'cogseed-backend' };

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

export type KstarEvidenceResult = {
  success: boolean;
  deduplicated?: boolean;
  runId?: string;
  boundary: ExecutionBoundaryInfo;
};

async function readEvidenceRows(userId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await fs.readFile(getPendingEvidencePath(userId), 'utf8');
    return content
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as Record<string, unknown>; }
        catch { return null; }
      })
      .filter((row): row is Record<string, unknown> => !!row);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function writeEvidenceRows(userId: string, rows: Array<Record<string, unknown>>): Promise<void> {
  const logPath = getPendingEvidencePath(userId);
  await fs.mkdir(logPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  const tmpPath = `${logPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    await fs.rename(tmpPath, logPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function recordBackendEvidence(
  userId: string,
  evidence: Record<string, unknown>,
): Promise<KstarEvidenceResult> {
  const id = typeof evidence.id === 'string' ? evidence.id : '';
  const row = { ...evidence, boundary: COGSEED_BOUNDARY };
  try {
    const existing = await readEvidenceRows(userId);
    if (id && existing.some((item) => item.id === id)) {
      return { success: true, deduplicated: true, boundary: COGSEED_BOUNDARY };
    }
    await writeEvidenceRows(userId, [...existing, row]);
    return { success: true, boundary: COGSEED_BOUNDARY };
  } catch (err) {
    log.warn('failed to record CogSeed KSTAR evidence', {
      userId,
      evidenceId: id || evidence.type,
      error: (err as Error).message,
    });
    return { success: false, boundary: { ...COGSEED_BOUNDARY, mode: 'degraded', reason: 'evidence_journal_unavailable' } };
  }
}

async function hasContributionEvidence(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await readEvidenceRows(userId);
  return rows.some((record) => record.conversation_id === conversationId && record.type === 'conversation_message');
}

/** Record tool cycle evidence in the CogSeed backend evidence journal. */
export async function recordToolCycleEvidence(
  input: ToolCycleEvidenceInput,
): Promise<KstarEvidenceResult> {
  const evidenceId = `tool-${input.conversationId}-${input.agentId}-${input.turnId}-${input.toolCallId}`;
  return recordBackendEvidence(input.userId, {
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
  });
}

/** Record agent run start evidence in the CogSeed backend evidence journal. */
export async function recordAgentRunStartEvidence(
  input: AgentRunStartEvidenceInput,
): Promise<KstarEvidenceResult> {
  const evidenceId = `run-start-${input.conversationId}-${input.agentId}-${input.turnId}`;
  return recordBackendEvidence(input.userId, {
    id: evidenceId,
    type: 'agent_run_result',
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    turn_id: input.turnId,
    phase: 'start',
    ...input.data,
    created_at: nowIso(),
  });
}

/** Record agent contribution evidence in the CogSeed backend evidence journal. */
export async function recordAgentContributionEvidence(
  input: AgentContributionEvidenceInput,
): Promise<KstarEvidenceResult> {
  const evidenceId = `contribution-${input.conversationId}-${input.agentId}-${input.turnId}-${input.messageId}`;
  return recordBackendEvidence(input.userId, {
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
  });
}

/** Close collaboration evidence without spawning a standalone Engine adapter. */
export async function closeCollaborationEvidence(
  userId: string,
  input: {
    conversationId: string;
    commanderId?: string;
    outcomeStatus: 'completed' | 'failed' | 'cancelled';
  },
): Promise<KstarEvidenceResult> {
  const commanderId = input.commanderId || 'commander';
  const runId = `collab-${input.conversationId}-${commanderId}`;
  if (!(await hasContributionEvidence(userId, input.conversationId))) {
    return { success: true, runId, deduplicated: true, boundary: COGSEED_BOUNDARY };
  }
  const result = await recordBackendEvidence(userId, {
    id: runId,
    type: 'collaboration_close',
    conversation_id: input.conversationId,
    commander_id: commanderId,
    outcome_status: input.outcomeStatus,
    created_at: nowIso(),
  });
  return { ...result, runId };
}
