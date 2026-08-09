import { completeTransferProof, findTransferProof, prepareTransferProof, type TransferProofRecord } from './proof-service';
import { readContextProjection } from './context-projection';

export type RecallTaskTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'waiting_input';

/**
 * Host-neutral terminal facts. Group Chat and Mate adapters translate their
 * terminal events into this shape before calling the Recall proof handler.
 */
export interface RecallTaskTerminalEvent {
  run_id: string;
  user_id: string;
  conversation_id: string;
  status: RecallTaskTerminalStatus;
  projection_id?: string;
  wake_request_id?: string;
  logical_run_id?: string;
  execution_id?: string;
  started_at_ms: number;
  finished_at_ms: number;
}

type TerminalProofResult =
  | { handled: true; proof: TransferProofRecord; proofs: TransferProofRecord[] }
  | { handled: false; reason: 'no_confirmed_projection' };

function proofStatusFor(event: RecallTaskTerminalEvent): 'succeeded' | 'degraded' | 'rejected' {
  if (event.status === 'completed') return 'succeeded';
  if (event.status === 'waiting_input') return 'degraded';
  return 'rejected';
}

export async function handleRecallTaskTerminal(event: RecallTaskTerminalEvent): Promise<TerminalProofResult> {
  const status = proofStatusFor(event);
  const executionId = event.execution_id || event.run_id;
  const logicalRunId = event.logical_run_id || event.run_id;
  if (!event.projection_id) return { handled: false, reason: 'no_confirmed_projection' };

  let projection;
  try {
    projection = await readContextProjection(event.user_id, event.projection_id);
  } catch {
    return { handled: false, reason: 'no_confirmed_projection' };
  }
  if (projection.status !== 'confirmed' || projection.taskRunId !== logicalRunId) {
    return { handled: false, reason: 'no_confirmed_projection' };
  }
  if (projection.expiresAt && Date.parse(projection.expiresAt) <= Date.now()) {
    return { handled: false, reason: 'no_confirmed_projection' };
  }

  let proof = await findTransferProof(event.user_id, projection.id, executionId);
  if (!proof) {
    proof = await prepareTransferProof(event.user_id, {
      projectionId: projection.id,
      executionId,
      expectedResultSnapshot: `Task terminal status: ${event.status}.`,
      ...(event.wake_request_id ? { wakeRequestId: event.wake_request_id } : {}),
    });
  }
  if (proof.status === 'prepared') {
    proof = await completeTransferProof(event.user_id, proof.id, {
      status,
      observedTransfer: `Task run ${logicalRunId} attempt ${executionId} reached terminal status ${event.status}.`,
    });
  }
  return { handled: true, proof, proofs: [proof] };
}
