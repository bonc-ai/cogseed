/**
 * Main-process assembly of confirmed recall ability assets for CogSeed Runtime
 * tasks (M-1 closure after Decision 2 = connect).
 *
 * The CogSeed Runtime worker is an isolated process and must never read the
 * recall store itself. The main process reads confirmed projections here and
 * ships the assembled text block through the existing `context` slot of the
 * Runtime JSONL protocol — the same path `resolveRuntimeCapabilities` uses
 * for trusted host capabilities ("never accepted from external callers").
 *
 * Writes exactly one thing: the ContextReuseReceipt for the assets this module
 * actually injected. Never candidates, assets, or projections. The receipt is
 * written **here**, at the injection site, on purpose — bus.ts:4131 states the
 * rule: 「回执要在注入的同一处落，用同一份事实——分开算两次早晚会对不上」.
 * Without it this path injected assets while leaving no proof of load, so every
 * transfer proof it produced had `receiptId: null` / `assetVersions: []` and no
 * asset could ever reach `transfer_validated`.
 */

import { createLogger } from '../../logger';
import type { RuntimeContextItem } from '../cogseed_runtime/protocol';
import {
  buildConfirmedProjectionPromptContext,
  buildDispatchedAssetsPromptBlock,
} from '../recall/prompt-injection';

const log = createLogger('cogseed-backend:runtime-asset-context');

/** Bounded size for the assembled asset block shipped to the Runtime worker.
 *  Recall's own `buildConfirmedProjectionPromptBlock` caps at 14k; keep the
 *  worker-facing contract slightly above that so recall-level limits remain
 *  authoritative, while this module still enforces a hard ceiling. */
export const MAX_RUNTIME_ASSET_CONTEXT_CHARS = 16_000;

export interface DispatchedRuntimeAssetContextInput {
  agentId?: string;
  taskText: string;
  purpose: string;
}

/**
 * Assemble the explicit assets granted by Commander for a Runtime launch.
 *
 * This remains in the main-process asset assembler so every Recall read has a
 * single, auditable boundary before text crosses into the isolated worker.
 */
export async function buildDispatchedRuntimeAssetContext(
  userId: string,
  assetIds: string[],
  context: DispatchedRuntimeAssetContextInput,
): Promise<RuntimeContextItem[]> {
  try {
    const dispatched = await buildDispatchedAssetsPromptBlock(userId, assetIds, context);
    if (!dispatched.promptBlock) return [];
    return [{
      type: 'text',
      label: 'Commander-dispatched ability assets',
      content: dispatched.promptBlock,
    }];
  } catch (error) {
    log.warn('Commander-dispatched asset context assembly failed', { error: (error as Error).message });
    return [];
  }
}

/**
 * Assemble confirmed reusable ability assets for a CogSeed Runtime task.
 *
 * Returns an empty array when the conversation has no confirmed projection,
 * when no asset is active, or on any recall read failure (soft failure: the
 * runtime task must still run without assets).
 */
export async function buildRuntimeAssetContext(
  userId: string,
  conversationId: string,
  taskId?: string,
): Promise<RuntimeContextItem[]> {
  let block: string;
  let assetIds: string[];
  try {
    const context = await buildConfirmedProjectionPromptContext(userId, conversationId);
    block = context.promptBlock;
    assetIds = [...new Set(context.citations.map((citation) => citation.assetId).filter(Boolean))];
  } catch (error) {
    log.warn('runtime asset context assembly failed', { error: (error as Error).message });
    return [];
  }
  if (!block) return [];
  // 回执键与终态事件对齐：`recall-bridge` 用 taskId 作为 reuse turn id，
  // `terminal-proof.collectLoadedAssetsFromReceipts` 按 `turn-<id>` 回读。
  // 只有真的注入了资产（citations 非空）才落——没有注入就不该有加载凭证。
  if (taskId && assetIds.length) {
    try {
      const { prepareReceipt } = await import('../p3394/context-reuse-receipt');
      await prepareReceipt(
        userId,
        {
          executionId: `turn-${taskId}`,
          targetSessionId: conversationId,
          reusedRefs: assetIds,
          omittedRefs: [],
          permissionMode: 'read-only',
          allowedScopes: ['cognition:projection'],
          boundary: 'real',
        },
        { sessionId: conversationId },
      ).catch(() => undefined);
    } catch (error) {
      // 回执落库失败不阻断任务启动——只是这次不产生迁移凭证。
      log.warn('runtime asset reuse receipt failed', { error: (error as Error).message });
    }
  }
  return [{
    type: 'text',
    label: 'Confirmed reusable ability assets',
    content: block.slice(0, MAX_RUNTIME_ASSET_CONTEXT_CHARS),
  }];
}
