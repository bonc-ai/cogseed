import { nowIso, safeId } from '../../storage';
import { assertKstarTransition } from './state-machine';
import type { RecallCandidateRecord } from '../recall/candidate-service';
import type { KstarCandidateProposal } from './types';
import { closeKstarRequirement } from './requirement-closure';
import {
  createKstarRequirementRecord,
  createKstarTaskRecord,
  listKstarRequirementsForTask,
  readConversationTaskState,
  readKstarTask,
  replaceConversationTaskState,
  replaceKstarRequirement,
  replaceKstarTask,
} from './requirement-store';
import type { KstarConversationTaskStateRecord, KstarRequirementRecord, KstarTaskRecord } from './requirement-types';

/** 沉淀路径已收口：KStar 候选统一走 requirement 级路径，本类型保留仅为
 *  兼容调用方契约（drain 不再实际产候选）。 */
export type KstarTaskCandidateBridge = (userId: string, proposals: KstarCandidateProposal[]) => Promise<RecallCandidateRecord[]>;

export interface DrainKstarTaskStateOptions {
  candidateBridge?: KstarTaskCandidateBridge;
}

export interface KstarTaskAggregateResult {
  task: KstarTaskRecord;
  closedRequirements: KstarRequirementRecord[];
  proposals: KstarCandidateProposal[];
  candidates: RecallCandidateRecord[];
}

export async function drainKstarTaskState(
  userId: string,
  conversationId: string,
  options: DrainKstarTaskStateOptions = {},
): Promise<KstarTaskAggregateResult | null> {
  if (!safeId(conversationId)) throw new Error('invalid kstar conversation id');
  let state = await readConversationTaskState(userId, conversationId);
  if (!state) return null;

  let justClosed: KstarRequirementRecord | null = null;
  if (state.requirementJustClosed) {
    justClosed = await closeKstarRequirement(userId, { requirementId: state.requirementJustClosed });
    state = await replaceConversationTaskState(userId, {
      ...state,
      requirementJustClosed: undefined,
      updatedAt: nowIso(),
    });
  }

  if (state.taskComplete !== true) return null;
  if (!state.currentTaskId) return null;
  const task = await readKstarTask(userId, state.currentTaskId);
  if (!task) return null;

  const requirements = await listKstarRequirementsForTask(userId, task.id);
  const closedRequirements = requirements.filter((requirement) => requirement.status === 'closed');
  // 沉淀路径收口（2026-08-17）：KStar 候选沉淀统一走 requirement 级路径
  // （task-level-precipitation → precipitateRequirementLevel，控制服务在
  // finish/切换/自动闭环时触发，lesson 门控 + 语言硬闸 + 语义查重完整）。
  // 本 drain 函数只保留任务/会话状态关闭职责，不再产候选——此前它用
  // aar.candidateSeed（= review.reason 诊断文本）经 recall-bridge 进池，
  // 与 requirement 级路径（= review.lesson）对同一 review 各产一条，
  // 指纹不同去重拦不住（reason ≠ lesson），语义查重也未必命中（0.85）。
  // 保留空数组字段以维持 KstarTaskAggregateResult 形状与调用方契约。
  const proposals: KstarCandidateProposal[] = [];
  const candidates: RecallCandidateRecord[] = [];
  const closedTask: KstarTaskRecord = {
    ...task,
    status: 'closed',
    candidateRunId: `kstc-${task.id}`,
    currentRequirementId: undefined,
    updatedAt: nowIso(),
  };
  assertKstarTransition('task', task.status, 'closed');
  await replaceKstarTask(userId, closedTask);

  const result: KstarTaskAggregateResult = {
    task: closedTask,
    closedRequirements: justClosed && !closedRequirements.some((requirement) => requirement.id === justClosed!.id)
      ? [...closedRequirements, justClosed]
      : closedRequirements,
    proposals,
    candidates,
  };

  // No deferred task open here: a topic switch closes the old task and lets the
  // next message open its own. Stashing a "to be started" task and creating it
  // at close time would land the task after the work it describes is already
  // done, so the mechanism was removed rather than wired.
  await replaceConversationTaskState(userId, {
    ...state,
    currentTaskId: undefined,
    currentRequirementId: undefined,
    requirementJustClosed: undefined,
    taskComplete: false,
    updatedAt: nowIso(),
  });

  return result;
}
