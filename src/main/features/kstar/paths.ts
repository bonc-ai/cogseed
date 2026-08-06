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
