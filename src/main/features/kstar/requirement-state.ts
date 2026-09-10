import { nowIso, safeId } from '../../storage';
import {
  bindKstarRequirementWakeRequestByProjection,
  listKstarRequirementsForTask,
  readConversationTaskState,
  readKstarRequirement,
  readKstarTask,
  replaceKstarRequirement,
} from './requirement-store';
import type {
  KstarRequirementRecord,
  KstarTaskRecord,
} from './requirement-types';

export async function bindKstarRequirementWakeRequest(
  userId: string,
  input: { conversationId: string; projectionId: string; wakeRequestId: string },
): Promise<KstarRequirementRecord> {
  if (!safeId(userId) || !safeId(input.conversationId) || !safeId(input.projectionId) || !safeId(input.wakeRequestId)) {
    throw new Error('invalid kstar requirement wake binding reference');
  }
  return bindKstarRequirementWakeRequestByProjection(
    userId,
    input.conversationId,
    input.projectionId,
    input.wakeRequestId,
  );
}

function uniqueIds(ids: string[], next: string): string[] {
  return ids.includes(next) ? ids : [...ids, next];
}

export async function attachKstarEpisodeToRequirement(
  userId: string,
  input: {
    conversationId: string;
    episodeId: string;
    taskId?: string;
    requirementId?: string;
    projectionId?: string;
    wakeRequestId?: string;
  },
  options: { allowCurrentRequirementFallback?: boolean } = {},
): Promise<void> {
  if (!safeId(userId) || !safeId(input.conversationId) || !safeId(input.episodeId)) {
    throw new Error('invalid kstar episode attachment reference');
  }
  if (input.projectionId !== undefined && !safeId(input.projectionId)) throw new Error('invalid kstar episode projection reference');
  if (input.wakeRequestId !== undefined && !safeId(input.wakeRequestId)) throw new Error('invalid kstar episode wake reference');
  if (input.taskId !== undefined && !safeId(input.taskId)) throw new Error('invalid kstar episode task reference');
  if (input.requirementId !== undefined && !safeId(input.requirementId)) throw new Error('invalid kstar episode requirement reference');
  const state = await readConversationTaskState(userId, input.conversationId);
  const taskId = input.taskId || state?.currentTaskId;
  if (!taskId) return;
  const task = await readKstarTask(userId, taskId);
  if (!task) return;
  if (task.conversationId !== input.conversationId) throw new Error('kstar episode task conversation mismatch');
  const requirements = await listKstarRequirementsForTask(userId, task.id);
  const explicitRequirement = input.requirementId
    ? requirements.find((candidate) => candidate.id === input.requirementId)
    : undefined;
  if (input.requirementId && !explicitRequirement) throw new Error('kstar episode requirement does not belong to task');
  const provenanceMatches = requirements.filter((requirement) => {
    if (requirement.status === 'closed' || requirement.status === 'abandoned') return false;
    if (input.projectionId && requirement.projectionId === input.projectionId) return true;
    if (input.wakeRequestId && requirement.wakeRequestId === input.wakeRequestId) return true;
    return false;
  });
  let requirement: KstarRequirementRecord | null = null;
  if (explicitRequirement) {
    requirement = explicitRequirement;
  } else if (provenanceMatches.length === 1) {
    requirement = provenanceMatches[0];
  } else if (provenanceMatches.length > 1) {
    throw new Error('multiple kstar requirements match episode provenance');
  } else if (state.currentRequirementId && options.allowCurrentRequirementFallback !== false) {
    requirement = await readKstarRequirement(userId, state.currentRequirementId);
    if (requirement && (requirement.status === 'closed' || requirement.status === 'abandoned')) {
      // A closed/abandoned current requirement is never a fallback target:
      // drop it so the shared closed/abandoned gate below returns silently
      // (pre-membership-check behavior) instead of surfacing a foreign-task
      // membership error for a requirement we would not attach to anyway.
      requirement = null;
    } else if (requirement && requirement.taskId !== task.id) {
      // The current-requirement fallback is only sound when the conversation's
      // current requirement actually belongs to the task resolved above (the
      // conversation may have moved to a different task mid-run). Without this
      // membership check a lost-provenance episode would silently attach to an
      // unrelated requirement. It applies to an OPEN current requirement only.
      throw new Error('kstar current requirement does not belong to episode task');
    }
  }
  if (!requirement || requirement.status === 'closed' || requirement.status === 'abandoned') return;
  if ((input.projectionId || input.wakeRequestId) && provenanceMatches.length === 0) {
    const hasMatchingCurrentProvenance = Boolean(
      (input.projectionId && requirement.projectionId === input.projectionId) ||
      (input.wakeRequestId && requirement.wakeRequestId === input.wakeRequestId),
    );
    if (!hasMatchingCurrentProvenance) {
      throw new Error('no kstar requirement matches episode provenance');
    }
  }
  requirement.episodeIds = uniqueIds(requirement.episodeIds, input.episodeId);
  requirement.updatedAt = nowIso();
  await replaceKstarRequirement(userId, requirement);
}

/** Backward-compatible current-lifecycle adapter for non-snapshotted callers. */
export async function attachKstarEpisodeToCurrentRequirement(
  userId: string,
  input: { conversationId: string; episodeId: string; projectionId?: string; wakeRequestId?: string },
): Promise<void> {
  return attachKstarEpisodeToRequirement(userId, input);
}
