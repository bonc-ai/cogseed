/** Private catalog exposure events. A search hit is not a body read or use. */
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { userLocalRoot } from '../../paths';
import { appendJsonlAtomic, safeId } from '../../storage';
import { logErrorRef, maskId } from '../../util/log-redact';

export type CatalogObservationStage = 'prompt_included' | 'tool_page_shown' | 'search_result_shown' | 'body_read';

export interface CatalogObservation {
  turnId: string;
  cid: string;
  assetId: string;
  assetVersion: string;
  stage: CatalogObservationStage;
  rank?: number;
  at: string;
}

const log = createLogger('recall.catalog-observation');
const seen = new Set<string>();
const MAX_SEEN = 10_000;

function fileFor(userId: string, at: Date): string {
  if (!safeId(userId)) throw new Error('invalid catalog observation owner');
  return path.join(userLocalRoot(userId), 'recall', 'catalog-observations', `${at.toISOString().slice(0, 7)}.jsonl`);
}

/** Events contain identifiers and coarse stages only; no task or asset text. */
export async function recordCatalogObservations(
  userId: string,
  input: { turnId?: string; cid?: string; stage: CatalogObservationStage; assets: readonly { id: string; version: string }[] },
): Promise<void> {
  if (!input.turnId || !safeId(input.turnId)) return;
  const cid = input.cid && safeId(input.cid) ? input.cid : '';
  const now = new Date();
  const file = fileFor(userId, now);
  for (const [index, asset] of input.assets.entries()) {
    if (!safeId(asset.id)) continue;
    const key = `${userId}\0${input.turnId}\0${input.stage}\0${asset.id}`;
    if (seen.has(key)) continue;
    const event: CatalogObservation = {
      turnId: input.turnId,
      cid,
      assetId: asset.id,
      assetVersion: asset.version,
      stage: input.stage,
      rank: index + 1,
      at: now.toISOString(),
    };
    try {
      await appendJsonlAtomic(file, event);
      seen.add(key);
      if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
    } catch (error) {
      log.warn('catalog observation write failed', { userId: maskId(userId), error: logErrorRef(error as Error) });
    }
  }
}

export function resetCatalogObservationCacheForTest(): void { seen.clear(); }
