import { readConversationTaskState, readKstarRequirement, readKstarTask } from './requirement-store';
import type { KstarConversationTaskStateRecord, KstarRequirementRecord, KstarTaskRecord } from './requirement-types';
import { readContextProjection, type ContextProjectionRecord } from '../recall/context-projection';
import { getWakeRequest } from '../p3394/wake-service';
import type { AgentWakeRequest, WakeAssetConfirmationSnapshot } from '../p3394/types';

export type KstarLifecycleStatus =
  | 'none'
  | 'draft'
  | 'preload_preview'
  | 'authorized'
  | 'executing'
  | 'awaiting_user_satisfaction'
  | 'closed'
  | 'cancelled';

export interface KstarTaskLifecycleSnapshot {
  status: KstarLifecycleStatus;
  state: KstarConversationTaskStateRecord | null;
  task?: KstarTaskRecord;
  requirement?: KstarRequirementRecord;
  projection?: ContextProjectionRecord;
  wakeRequest?: AgentWakeRequest;
  assetConfirmationSnapshot?: WakeAssetConfirmationSnapshot;
}

function statusFor(
  task?: KstarTaskRecord,
  requirement?: KstarRequirementRecord,
  projection?: ContextProjectionRecord,
  wakeRequest?: AgentWakeRequest,
): KstarLifecycleStatus {
  if (!task || !requirement) return 'none';
  if (task.status === 'abandoned' || requirement.status === 'abandoned') return 'cancelled';
  if (task.status === 'closed' || requirement.status === 'closed') return 'closed';
  if (task.status === 'closing' || requirement.status === 'waiting_review') return 'awaiting_user_satisfaction';
  if (projection?.status === 'preview') return 'preload_preview';
  if (projection?.status === 'confirmed') {
    if (wakeRequest?.status === 'executed') return 'executing';
    return 'authorized';
  }
  return 'draft';
}

export async function readKstarTaskLifecycle(userId: string, conversationId: string): Promise<KstarTaskLifecycleSnapshot> {
  const state = await readConversationTaskState(userId, conversationId);
  const task = state?.currentTaskId ? await readKstarTask(userId, state.currentTaskId) : null;
  const requirement = state?.currentRequirementId ? await readKstarRequirement(userId, state.currentRequirementId) : null;
  let projection: ContextProjectionRecord | undefined;
  if (requirement?.projectionId) {
    try { projection = await readContextProjection(userId, requirement.projectionId); } catch { projection = undefined; }
  }
  const wakeRequest = requirement?.wakeRequestId ? (await getWakeRequest(userId, requirement.wakeRequestId) || undefined) : undefined;
  const assetConfirmationSnapshot = wakeRequest?.asset_confirmation_snapshot;
  return {
    status: statusFor(task || undefined, requirement || undefined, projection, wakeRequest),
    state,
    ...(task ? { task } : {}),
    ...(requirement ? { requirement } : {}),
    ...(projection ? { projection } : {}),
    ...(wakeRequest ? { wakeRequest } : {}),
    ...(assetConfirmationSnapshot ? { assetConfirmationSnapshot } : {}),
  };
}
