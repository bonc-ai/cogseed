import * as path from 'node:path';

import { safeId } from '../../storage';
import { userCloudRoot } from '../../paths';

function assertSafeSegment(value: string, label: string): string {
  if (!safeId(value)) throw new Error(`invalid recall ${label}`);
  return value;
}

export function recallRoot(userId: string): string {
  return path.join(userCloudRoot(assertSafeSegment(userId, 'user id')), 'recall');
}

export function recallJsonRecordPath(userId: string, collection: string, recordId: string): string {
  return path.join(
    recallRoot(userId),
    'records',
    assertSafeSegment(collection, 'collection'),
    `${assertSafeSegment(recordId, 'record id')}.json`,
  );
}

export function recallJsonlPath(userId: string, collection: string, stream: string): string {
  return path.join(
    recallRoot(userId),
    'jsonl',
    assertSafeSegment(collection, 'collection'),
    `${assertSafeSegment(stream, 'stream')}.jsonl`,
  );
}

export function recallMigrationsPath(userId: string): string {
  return path.join(recallRoot(userId), 'migrations.json');
}
