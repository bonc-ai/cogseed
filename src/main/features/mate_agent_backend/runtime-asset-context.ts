/**
 * Main-process assembly of confirmed recall ability assets for Mate Runtime
 * tasks (M-1 closure after Decision 2 = connect).
 *
 * The Mate Runtime worker is an isolated process and must never read the
 * recall store itself. The main process reads confirmed projections here and
 * ships the assembled text block through the existing `context` slot of the
 * Runtime JSONL protocol — the same path `resolveRuntimeCapabilities` uses
 * for trusted host capabilities ("never accepted from external callers").
 *
 * Read-only: this module never writes recall state, candidates, assets,
 * receipts, or projections.
 */

import { createLogger } from '../../logger';
import type { RuntimeContextItem } from '../mate_agent_runtime/protocol';
import { buildConfirmedProjectionPromptBlock } from '../recall/prompt-injection';

const log = createLogger('mate-backend:runtime-asset-context');

/** Bounded size for the assembled asset block shipped to the Runtime worker.
 *  Recall's own `buildConfirmedProjectionPromptBlock` caps at 14k; keep the
 *  worker-facing contract slightly above that so recall-level limits remain
 *  authoritative, while this module still enforces a hard ceiling. */
export const MAX_RUNTIME_ASSET_CONTEXT_CHARS = 16_000;

/**
 * Assemble confirmed reusable ability assets for a Mate Runtime task.
 *
 * Returns an empty array when the conversation has no confirmed projection,
 * when no asset is active, or on any recall read failure (soft failure: the
 * runtime task must still run without assets).
 */
export async function buildRuntimeAssetContext(
  userId: string,
  conversationId: string,
): Promise<RuntimeContextItem[]> {
  let block: string;
  try {
    block = await buildConfirmedProjectionPromptBlock(userId, conversationId);
  } catch (error) {
    log.warn('runtime asset context assembly failed', { error: (error as Error).message });
    return [];
  }
  if (!block) return [];
  return [{
    type: 'text',
    label: 'Confirmed reusable ability assets',
    content: block.slice(0, MAX_RUNTIME_ASSET_CONTEXT_CHARS),
  }];
}
