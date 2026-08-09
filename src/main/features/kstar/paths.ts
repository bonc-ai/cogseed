import * as path from 'node:path';

import { userCloudRoot } from '../../paths';
import { safeId } from '../../storage';

function safeSegment(value: string, label: string): string {
  if (!safeId(value)) throw new Error(`invalid kstar ${label}`);
  return value;
}

export function kstarRoot(userId: string): string {
  return path.join(userCloudRoot(safeSegment(userId, 'user id')), 'kstar');
}

export function kstarRecordPath(userId: string, collection: string, recordId: string): string {
  return path.join(
    kstarRoot(userId),
    safeSegment(collection, 'collection'),
    `${safeSegment(recordId, `${collection.replace(/s$/, '')} id`)}.json`,
  );
}

export function kstarEpisodePath(userId: string, episodeId: string): string {
  if (!safeId(episodeId)) throw new Error('invalid kstar episode id');
  return kstarRecordPath(userId, 'episodes', episodeId);
}

export function kstarReviewPath(userId: string, reviewId: string): string {
  if (!safeId(reviewId)) throw new Error('invalid kstar review id');
  return kstarRecordPath(userId, 'reviews', reviewId);
}

export function kstarExtractionRunPath(userId: string, runId: string): string {
  if (!safeId(runId)) throw new Error('invalid kstar extraction run id');
  return kstarRecordPath(userId, 'extraction-runs', runId);
}

export function kstarTaskPath(userId: string, taskId: string): string {
  if (!safeId(taskId)) throw new Error('invalid kstar task id');
  return kstarRecordPath(userId, 'tasks', taskId);
}

export function kstarRequirementPath(userId: string, requirementId: string): string {
  if (!safeId(requirementId)) throw new Error('invalid kstar requirement id');
  return kstarRecordPath(userId, 'requirements', requirementId);
}

export function kstarConversationTaskStatePath(userId: string, conversationId: string): string {
  if (!safeId(conversationId)) throw new Error('invalid kstar conversation id');
  return kstarRecordPath(userId, 'task-states', conversationId);
}
