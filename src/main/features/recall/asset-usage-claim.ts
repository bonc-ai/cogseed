import { createHash } from 'node:crypto';
import { safeId } from '../../storage';
import { createLogger } from '../../logger';
import { listInjectionReceipts, type InjectionReceipt } from './injection-receipt';
import { AGENT_READ_PROJECTION_ID, DISPATCH_PROJECTION_ID, recordAssetUsageReceipt, type AssetUsageReceipt } from './asset-usage-receipt';
import { locatePersistedResultExcerpt, readPersistedConversationResult, type PersistedResultContent } from './persisted-result-content';
import { readGroupExecutionResult, readDispatchBindingContext, type GroupExecutionResultSource } from './execution-result-content';
const log = createLogger('asset-usage-claim');

/** A model report is a pending claim, not a persisted adoption or effect proof. */
export interface AssetUsageClaim {
  assetId: string;
  assetVersion: string;
  outputExcerpt: string;
}

function version(value: string): string { return value.replace(/^v/, ''); }

function parseClaim(input: Record<string, unknown>): AssetUsageClaim {
  const assetId = typeof input.assetId === 'string' ? input.assetId.trim() : '';
  const assetVersion = typeof input.assetVersion === 'string' ? input.assetVersion.trim() : '';
  const outputExcerpt = typeof input.outputExcerpt === 'string' ? input.outputExcerpt.trim() : '';
  if (!safeId(assetId) || !/^v?\d+$/.test(assetVersion) || outputExcerpt.length < 12 || outputExcerpt.length > 500) {
    throw new Error('invalid asset usage claim');
  }
  return { assetId, assetVersion, outputExcerpt };
}

/** 主动读取快照 = 本回合 channel=agent_read 的注入回执。版本是宿主按真实
 *  资产记录写入的，模型不能自报版本；experience 条目（exp-*）与遗留画像
 *  （onto-*）不属于正式资产，不进采用链。 */
function isAgentReadSnapshot(receipt: InjectionReceipt, assetId: string, assetVersion: string): boolean {
  return receipt.channel === 'agent_read'
    && receipt.status === 'injected'
    && receipt.boundary === 'real'
    && assetId.startsWith('aa-')
    && receipt.assetId === assetId
    && version(receipt.assetVersion) === version(assetVersion);
}

export async function prepareAssetUsageClaim(userId: string, taskRunId: string, input: Record<string, unknown>, suppliedAssets: Array<{ assetId: string; assetVersion: string }>): Promise<AssetUsageClaim> {
  if (!safeId(userId) || !safeId(taskRunId)) throw new Error('asset usage requires a current turn');
  const claim = parseClaim(input);
  // Before final persistence there is no message-bound injection receipt yet.
  // The supplied list comes from the host's actual prompt context; active reads
  // qualify only through host-written agent_read receipts, never tool input.
  const supplied = suppliedAssets.some((asset) => asset.assetId === claim.assetId
    && version(asset.assetVersion) === version(claim.assetVersion));
  if (!supplied) {
    const readThisTurn = (await listInjectionReceipts(userId, taskRunId))
      .some((receipt) => isAgentReadSnapshot(receipt, claim.assetId, claim.assetVersion));
    if (!readThisTurn) throw new Error('asset version was not supplied or actively read in this turn');
  }
  return claim;
}

/** Called after successful message persistence and injection binding. Production
 * callers supply cid to re-read actual deliverables. The legacy text-only path
 * retains its contract and never authorizes reading caller-named files. */
export async function finalizeAssetUsageClaims(userId: string, input: {
  cid?: string; taskRunId: string; messageId: string; finalText?: string; claims: AssetUsageClaim[]; resultSource?: GroupExecutionResultSource; taskText?: string;
}): Promise<AssetUsageReceipt[]> {
  if (!safeId(input.taskRunId) || !safeId(input.messageId)) throw new Error('invalid asset usage final message');
  const readResult = async () => input.resultSource ? readGroupExecutionResult(userId, input.resultSource)
    : input.cid ? readPersistedConversationResult(userId, { ...input, cid: input.cid }) : undefined;
  if (input.resultSource && (input.cid !== input.resultSource.conversationId || input.resultSource.executionId !== `turn-${input.taskRunId}`
    || input.messageId !== `execution-result-${input.resultSource.executionId}`)) throw new Error('invalid execution claim identity');
  const persisted = await readResult();
  if (input.cid && !persisted) return [];
  const legacyText = typeof input.finalText === 'string' ? input.finalText : '';
  const result: PersistedResultContent = persisted?.content || { text: legacyText,
    refs: [{ kind: 'message', id: input.messageId, contentHash: createHash('sha256').update(legacyText).digest('hex'),
      contentRange: { start: 0, end: legacyText.length }, status: 'readable' }], coverage: { complete: true, totalFiles: 0, readableFiles: 0 } };
  const injections = await listInjectionReceipts(userId, input.taskRunId);
  // All claims in one final message observe the same deliverable snapshot.
  // Recheck it once before writes, rather than re-extracting every file per asset.
  const current = await readResult();
  if (input.cid && !current) return [];
  const changed = !!persisted && current?.fingerprint !== persisted.fingerprint;
  const observed = changed ? current!.content : result;
  const recorded: AssetUsageReceipt[] = [];
  const seen = new Set<string>();
  for (const raw of input.claims) {
    let claim: AssetUsageClaim;
    try { claim = parseClaim(raw as unknown as Record<string, unknown>); } catch { continue; }
    // 同一资产同轮可能既被投影供应又被主动读取：消息绑定的投影回执优先，
    // agent_read 快照只在投影证据缺席时兜底，两种来源不会重复记账。
    const injection = injections.find((receipt) => receipt.assetId === claim.assetId
      && version(receipt.assetVersion) === version(claim.assetVersion)
      && receipt.messageId === input.messageId && receipt.boundary === 'real'
      && !!receipt.projectionId && receipt.status === 'injected')
      ?? injections.find(receipt => receipt.status === 'dispatched' && receipt.dispatchBinding && receipt.assetId === claim.assetId
        && version(receipt.assetVersion) === version(claim.assetVersion) && receipt.messageId === input.messageId && receipt.boundary === 'real')
      ?? injections.find((receipt) => isAgentReadSnapshot(receipt, claim.assetId, claim.assetVersion));
    if (!injection) continue;
    if (injection.dispatchBinding && (!input.cid || !await readDispatchBindingContext(userId, injection, { ...input, cid: input.cid }).catch(() => undefined))) continue;
    if (injection.dispatchBinding) {
      const { readableCheckAsset } = await import('./cognition-output-check');
      if (!await readableCheckAsset(userId, injection, { ...input, cid: input.cid!, taskText: input.taskText || '' }).catch(() => undefined)) continue;
    }
    const viaAgentRead = injection.channel === 'agent_read';
    const projectionId = injection.projectionId || (injection.dispatchBinding ? DISPATCH_PROJECTION_ID : AGENT_READ_PROJECTION_ID);
    const key = `${projectionId}:${injection.assetId}:${injection.assetVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const evidence = locatePersistedResultExcerpt(result, claim.outputExcerpt);
      const reportFailure = changed ? 'result_changed' as const : !result.coverage.complete ? 'result_unavailable' as const
        : !evidence ? 'quote_not_found' as const : undefined;
      // A changed result cannot reuse the old quote. Unknown is bound to the
      // newly observed result, while its exact source hashes remain inspectable.
      recorded.push(await recordAssetUsageReceipt(userId, {
      taskRunId: input.taskRunId, projectionId,
      assetId: injection.assetId, assetVersion: injection.assetVersion, injectionReceiptId: injection.id,
      status: reportFailure ? 'usage_unknown' : 'applied', evidenceKind: 'final_output', boundary: 'real',
      observationMethod: 'agent_reported', messageId: input.messageId,
      outputHash: createHash('sha256').update(observed.text).digest('hex'),
      ...(reportFailure ? { reportFailure } : {}),
      ...(input.cid ? { resultRefs: observed.refs, resultCoverage: observed.coverage,
        ...(!reportFailure && evidence ? { outputEvidence: evidence } : {}) } : {}),
      ...(input.resultSource ? { resultSource: input.resultSource } : {}),
      evidenceRefs: [{ kind: input.resultSource ? 'execution' : 'message', id: input.resultSource?.executionId || input.messageId, title: 'Asset-specific final output' }],
      reason: reportFailure
        ? 'The model reported adoption, but its literal output evidence could not be established in the complete, unchanged persisted deliverables. Adoption remains unknown; this is not rejection or effectiveness verification.' : viaAgentRead
        ? 'Model-reported adoption tied to a host-recorded agent_read snapshot of this asset version and the persisted final output; not effectiveness verification.'
        : 'Model-reported adoption tied to this asset version and persisted final output; not effectiveness verification.',
      }));
    } catch {
      // One asset's storage failure must not drop other verifiable reports.
      log.warn('asset-specific adoption receipt write failed; remaining reports retained');
    }
  }
  return recorded;
}

export async function finalizeExecutionAssetUsageClaims(userId: string, source: GroupExecutionResultSource, claims: AssetUsageClaim[], taskText = '') {
  const result = await readGroupExecutionResult(userId, source);
  return finalizeAssetUsageClaims(userId, { cid: source.conversationId, taskRunId: result.taskRunId, messageId: result.anchorId, claims, resultSource: source, taskText });
}
