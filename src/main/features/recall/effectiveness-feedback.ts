import {
  evaluateEffectivenessProof,
  listTransferProofs,
  listEffectivenessProofs,
  recallProofError,
  type EffectivenessOutcome,
  type EffectivenessProofRecord,
} from './proof-service';
import { readContextProjection } from './context-projection';
import { recommendAbilityAssetAction } from './asset-service';
import { createLogger } from '../../logger';
import { updateRecallJsonRecord } from './store';
import { findConversationMessage } from './conversation-message-lookup';

const log = createLogger('recall.effectiveness-feedback');

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

async function queueEffectFeedbackForNight(userId: string, transferProofId: string, input: {
  feedback: RecallEffectivenessFeedback; note?: string; observedAt: string;
}): Promise<boolean> {
  const transfer = (await listTransferProofs(userId)).find(record => record.id === transferProofId);
  if (!transfer) return false;
  const projection = await readContextProjection(userId, transfer.projectionId);
  if (!projection.conversationId) return false;
  const { read } = await import('../execution-records');
  const execution = transfer.receiptExecutionId ? await read(userId, transfer.receiptExecutionId).catch(() => undefined) : undefined;
  const { listInjectionReceipts } = await import('./injection-receipt');
  const injections = execution?.executionId.startsWith('turn-') && (execution.resultOutput || execution.resultMessage)
    ? await listInjectionReceipts(userId, execution.executionId.slice(5)) : [];
  const hasBoundDispatch = injections.some(row => row.status === 'dispatched' && row.dispatchBinding?.executionId === execution?.executionId
    && transfer.assetVersions.some(asset => asset.assetId === row.assetId && asset.version === row.assetVersion));
  // New delegated results use their exact original submission. Unbound historical
  // message feedback retains the existing message-only contract.
  if (execution && (execution.resultOutput || hasBoundDispatch)) {
    if (!execution.agentId || execution.conversationId !== projection.conversationId) return false;
    const source = { kind: 'group_execution' as const, executionId: execution.executionId,
      conversationId: projection.conversationId, actorId: execution.agentId };
    const { readGroupExecutionResult, readDispatchSourceMessage } = await import('./execution-result-content');
    await readGroupExecutionResult(userId, source);
    const { queueNightlyFeedback } = await import('./nightly-feedback');
    const { readFeedbackResultContext } = await import('./feedback-version-context');
    for (const asset of transfer.assetVersions) {
      const binding = injections.find(row => row.status === 'dispatched' && row.boundary === 'real'
        && row.assetId === asset.assetId && row.assetVersion === asset.version && row.dispatchBinding?.executionId === execution.executionId)?.dispatchBinding;
      if (!binding?.sourceMessageId) return false;
      const message = await readDispatchSourceMessage(userId, projection.conversationId, binding.runId, binding.sourceMessageId);
      if (!message) return false;
      const observation = { messageId: message.id, assetId: asset.assetId, assetVersion: asset.version,
        taskRunId: projection.taskRunId, feedback: input.feedback, resultSource: source };
      await readFeedbackResultContext(userId, projection.conversationId, observation);
      await queueNightlyFeedback(userId, { ...observation, conversationId: projection.conversationId,
        observedAt: input.observedAt, ...(input.note ? { note: input.note } : {}) });
    }
    return true;
  }
  if (execution?.resultMessage === 'pending') return false;
  const boundMessage = execution?.resultMessage;
  const message = await findConversationMessage(userId, projection.conversationId, row => row.from !== 'user'
    && (boundMessage ? row.id === boundMessage.id
      : row.turn_id === projection.taskRunId || row.turn_id === transfer.executionId));
  if (!message) return false; // Never attach a task's feedback to an unrelated answer.
  const { queueNightlyFeedback } = await import('./nightly-feedback');
  for (const asset of transfer.assetVersions) await queueNightlyFeedback(userId, { conversationId: projection.conversationId,
    messageId: message.id, assetId: asset.assetId, assetVersion: asset.version, taskRunId: projection.taskRunId,
    feedback: input.feedback, observedAt: input.observedAt, ...(input.note ? { note: input.note } : {}) });
  return true;
}

async function enqueueProofFeedback(userId: string, proof: EffectivenessProofRecord): Promise<void> {
  if (!proof.nightlyFeedback || proof.nightlyFeedback.status !== 'pending') return;
  try {
    if (!await queueEffectFeedbackForNight(userId, proof.transferProofId, { ...proof.nightlyFeedback, observedAt: proof.createdAt })) return;
    await updateRecallJsonRecord(userId, 'effectiveness-proofs', proof.id, current => ({ ...current!,
      nightlyFeedback: { ...proof.nightlyFeedback!, status: 'queued' } }));
    proof.nightlyFeedback.status = 'queued';
  } catch {
    log.warn('nightly feedback enqueue deferred', { proofId: proof.id });
  }
}

/** Recovery is part of the existing nightly sweep, never a daytime producer. */
export async function recoverNightlyEffectivenessFeedback(userId: string): Promise<void> {
  const pending = (await listEffectivenessProofs(userId)).filter(proof => proof.nightlyFeedback?.status === 'pending');
  let queued = 0;
  // Missing old results stay retryable, but do not consume another proof's
  // admission quota. No model calls are made by this recovery pass.
  for (const proof of pending) {
    await enqueueProofFeedback(userId, proof);
    if (proof.nightlyFeedback?.status === 'queued' && ++queued >= 20) break;
  }
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
    nightlyFeedback: { feedback: input.feedback, ...(input.note ? { note: input.note } : {}) },
  }).then(async proof => {
    await enqueueProofFeedback(userId, proof);
    return proof;
  });
}

async function applyRecommendedAssetAction(
  userId: string,
  proof: EffectivenessProofRecord,
): Promise<void> {
  const action = proof.recommendedAction;
  if (action !== 'pause' && action !== 'rework') return;
  const transfer = (await listTransferProofs(userId)).find((item) => item.id === proof.transferProofId);
  if (!transfer) return;
  const reason = proof.observedResult.length > 1_000
    ? `${proof.observedResult.slice(0, 997)}...`
    : proof.observedResult;
  for (const item of transfer.assetVersions) {
    // 逐资产降级（照 usage-feedback-service 对同一 recommendAbilityAssetAction 的
    // 先例）：负向反馈到达时资产可能已被删除/撤销/清除，assertMutableAbilityAsset
    // 会抛错——效果证明已先行落盘，单条推荐失败只记日志，不炸整条反馈 API、
    // 不中断剩余资产的推荐（重试也不会因此累积重复证明）。
    try {
      await recommendAbilityAssetAction(userId, item.assetId, {
        actor: 'system',
        expectedVersion: item.version,
        action,
        reason,
      });
    } catch (error) {
      log.warn('effectiveness recommendation skipped', { assetId: item.assetId, action, error: (error as Error).message });
    }
  }
}

export async function recordEffectivenessFeedback(
  userId: string,
  input: RecordEffectivenessFeedbackInput,
): Promise<EffectivenessProofRecord> {
  const proof = await evaluateFeedbackProof(userId, input.transferProofId, input);
  await applyRecommendedAssetAction(userId, proof);
  return proof;
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
  // 这一条是「这次运行压根没产生成功的迁移证明」，和「有证明但没成功」
  // （E_RECALL_TRANSFER_NOT_SUCCEEDED）不是同一件事——前者用户该做的是等任务
  // 跑完，后者是这次带入已经失败了。分开给码，渲染层才能说清下一步。
  if (!transfers.length) throw recallProofError('E_RECALL_NO_SUCCESSFUL_TRANSFER', 'no successful transfer proof for task run');
  const proofs: EffectivenessProofRecord[] = [];
  for (const transfer of transfers) {
    const proof = await evaluateFeedbackProof(userId, transfer.id, input);
    proofs.push(proof);
    await applyRecommendedAssetAction(userId, proof);
  }
  return { proofs };
}
