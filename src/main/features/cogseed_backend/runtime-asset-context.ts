/**
 * Main-process assembly of confirmed recall ability assets for CogSeed Runtime
 * tasks.
 *
 * The CogSeed Runtime worker is an isolated process and must never read the
 * recall store itself. The main process reads confirmed projections here and
 * ships the assembled text block through the existing `context` slot of the
 * Runtime JSONL protocol — the same path `resolveRuntimeCapabilities` uses
 * for trusted host capabilities ("never accepted from external callers").
 *
 * Writes exactly two things at the injection site: the ContextReuseReceipt and
 * one InjectionReceipt per injected asset. Host task/execution coordinates bind
 * new runtime receipts to the persisted terminal result, not a UI message.
 * Never candidates, assets, or projections. Record both receipts at the
 * injection site so terminal transfer proofs refer to the exact loaded assets.
 */

import { createLogger } from '../../logger';
import type { RuntimeContextItem } from '../cogseed_runtime/protocol';
import {
  buildConfirmedProjectionPromptContext,
  buildDispatchedAssetsPromptBlock,
} from '../recall/prompt-injection';
import { runtimeResultAnchor } from '../recall/runtime-result-content';

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
  taskId?: string;
  executionId?: string;
  projectId?: string;
  workspaceId?: string;
  conversationKind?: string;
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
    if (context.taskId && context.executionId) {
      const { recordInjectionReceipt } = await import('../recall/injection-receipt');
      await Promise.allSettled(dispatched.assets.map(asset => recordInjectionReceipt(userId, { taskRunId: context.taskId!,
        assetId: asset.id, assetVersion: asset.version, boundary: 'real', status: 'injected', channel: 'runtime',
        messageId: runtimeResultAnchor(context.executionId!) })));
    }
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
  executionId?: string,
  runtimeContext: import('../recall/formal-assets/runtime').AssetRuntimeContext = {},
): Promise<RuntimeContextItem[]> {
  let block: string;
  let citations: Array<{ assetId: string; version: string; projectionId: string }> = [];
  try {
    const context = await buildConfirmedProjectionPromptContext(userId, conversationId,
      { ...runtimeContext, ...(taskId ? { taskRunId: taskId } : {}) });
    block = context.promptBlock;
    citations = context.citations.map((citation) => ({ assetId: citation.assetId, version: citation.version, projectionId: citation.projectionId }));
  } catch (error) {
    log.warn('runtime asset context assembly failed', { error: (error as Error).message });
    return [];
  }
  const assetIds = [...new Set(citations.map((citation) => citation.assetId).filter(Boolean))];
  if (!block) return [];
  // A whole block is either supplied or omitted; never cut its final exception
  // while recording every asset as successfully supplied.
  if (block.length > MAX_RUNTIME_ASSET_CONTEXT_CHARS) return [];
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
    // Runtime has no required group-chat message. New host launches supply the
    // execution identity, so the receipt can use a stable terminal-result
    // anchor; historical three-argument callers retain their old receipt shape.
    try {
      const { recordInjectionReceipt } = await import('../recall/injection-receipt');
      await Promise.allSettled(citations.map((citation) => recordInjectionReceipt(userId, {
        assetId: citation.assetId,
        assetVersion: citation.version,
        taskRunId: taskId,
        boundary: 'real',
        status: 'injected',
        channel: executionId ? 'runtime' : 'projection',
        ...(executionId ? { messageId: runtimeResultAnchor(executionId), projectionId: citation.projectionId } : {}),
      })));
    } catch (error) {
      log.warn('runtime asset injection receipts failed', { error: (error as Error).message });
    }
  }
  return [{
    type: 'text',
    label: 'Confirmed reusable ability assets',
    content: block,
  }];
}
