import {
  evaluateEffectivenessProof,
  listTransferProofs,
  type EffectivenessOutcome,
  type EffectivenessProofRecord,
} from './proof-service';
import { readContextProjection } from './context-projection';

export type RecallEffectivenessFeedback = 'positive' | 'neutral' | 'negative' | 'invalid' | 'rework';

export interface RecordEffectivenessFeedbackInput {
  transferProofId: string;
  feedback: RecallEffectivenessFeedback;
  note?: string;
  evidenceRefs?: unknown[];
}

export interface RecordTaskEffectivenessFeedbackInput {
  taskRunId: string;
  feedback: RecallEffectivenessFeedback;
  note?: string;
  evidenceRefs?: unknown[];
}

function outcomeFor(feedback: RecallEffectivenessFeedback): EffectivenessOutcome {
  if (feedback === 'positive') return 'better';
  if (feedback === 'negative') return 'worse';
  if (feedback === 'invalid') return 'invalid';
  if (feedback === 'rework') return 'rework';
  return 'no_improvement';
}

function observedResult(input: { feedback: RecallEffectivenessFeedback; note?: string }): string {
  const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
  return note || `User feedback: ${input.feedback}`;
}

function evaluateFeedbackProof(
  userId: string,
  transferProofId: string,
  input: { feedback: RecallEffectivenessFeedback; note?: string; evidenceRefs?: unknown[] },
): Promise<EffectivenessProofRecord> {
  return evaluateEffectivenessProof(userId, {
    transferProofId,
    outcome: outcomeFor(input.feedback),
    observedResult: observedResult(input),
    evidenceRefs: input.evidenceRefs || [],
  });
}

export function recordEffectivenessFeedback(
  userId: string,
  input: RecordEffectivenessFeedbackInput,
): Promise<EffectivenessProofRecord> {
  return evaluateFeedbackProof(userId, input.transferProofId, input);
}

export async function recordTaskEffectivenessFeedback(
  userId: string,
  input: RecordTaskEffectivenessFeedbackInput,
): Promise<{ proofs: EffectivenessProofRecord[] }> {
  const transfers = [];
  for (const proof of await listTransferProofs(userId)) {
    if (proof.status !== 'succeeded') continue;
    if (proof.executionId === input.taskRunId) {
      transfers.push(proof);
      continue;
    }
    try {
      const projection = await readContextProjection(userId, proof.projectionId);
      if (projection.taskRunId === input.taskRunId) transfers.push(proof);
    } catch {
      // A malformed/unavailable unrelated projection does not block feedback for other proofs.
    }
  }
  if (!transfers.length) throw new Error('no successful transfer proof for task run');
  const proofs: EffectivenessProofRecord[] = [];
  for (const transfer of transfers) {
    proofs.push(await evaluateFeedbackProof(userId, transfer.id, input));
  }
  return { proofs };
}
