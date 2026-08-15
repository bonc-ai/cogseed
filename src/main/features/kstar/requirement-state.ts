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

export async function attachKstarEpisodeToCurrentRequirement(
  userId: string,
  input: { conversationId: string; episodeId: string; projectionId?: string; wakeRequestId?: string },
): Promise<void> {
  if (!safeId(userId) || !safeId(input.conversationId) || !safeId(input.episodeId)) {
    throw new Error('invalid kstar episode attachment reference');
  }
  if (input.projectionId !== undefined && !safeId(input.projectionId)) throw new Error('invalid kstar episode projection reference');
  if (input.wakeRequestId !== undefined && !safeId(input.wakeRequestId)) throw new Error('invalid kstar episode wake reference');
  const state = await readConversationTaskState(userId, input.conversationId);
  if (!state?.currentTaskId) return;
  const task = await readKstarTask(userId, state.currentTaskId);
  if (!task) return;
  const requirements = await listKstarRequirementsForTask(userId, task.id);
  const provenanceMatches = requirements.filter((requirement) => {
    if (requirement.status === 'closed' || requirement.status === 'abandoned') return false;
    if (input.projectionId && requirement.projectionId === input.projectionId) return true;
    if (input.wakeRequestId && requirement.wakeRequestId === input.wakeRequestId) return true;
    return false;
  });
  let requirement: KstarRequirementRecord | null = null;
  if (provenanceMatches.length === 1) {
    requirement = provenanceMatches[0];
  } else if (provenanceMatches.length > 1) {
    throw new Error('multiple kstar requirements match episode provenance');
  } else if (state.currentRequirementId) {
    requirement = await readKstarRequirement(userId, state.currentRequirementId);
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
