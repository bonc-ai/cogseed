import { nowIso, safeId } from '../../storage';
import { listAssetUsageReceipts, type AssetUsageReceipt } from '../recall/asset-usage-receipt';
import { listInjectionReceipts, type InjectionReceipt } from '../recall/injection-receipt';
import { readRecallJsonRecord } from '../recall/store';
import { readKstarJsonRecord, listKstarJsonRecords } from './episode-store';
import { readConversationTaskState, readKstarTask, listKstarRequirementsForTask } from './requirement-store';
import { listKstarFailures } from './failure-service';
import type { KstarTrace, KstarTraceNode, TraceStatus } from './trace-types';

function bounded(value: unknown, max = 240): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

function status(value: unknown, fallback: TraceStatus = 'degraded'): TraceStatus {
  if (value === 'failed' || value === 'pending' || value === 'skipped' || value === 'not_started' || value === 'degraded' || value === 'ok') return value;
  if (value === 'created' || value === 'open' || value === 'preview') return 'pending';
  if (value === 'confirmed' || value === 'completed' || value === 'closed' || value === 'committed') return 'ok';
  return fallback;
}

function node(stage: KstarTraceNode['stage'], input: Partial<KstarTraceNode>): KstarTraceNode {
  return { stage, status: input.status || 'degraded', ...input };
}

function injectionStatus(receipt: InjectionReceipt): TraceStatus {
  if (receipt.boundary !== 'real') return 'degraded';
  if (receipt.status === 'injected' || receipt.status === 'dispatched') return 'ok';
  if (receipt.status === 'omitted') return 'skipped';
  return 'failed';
}

function usageStatus(receipt: AssetUsageReceipt): TraceStatus {
  if (receipt.boundary !== 'real') return 'degraded';
  if (receipt.status === 'applied') return 'ok';
  if (receipt.status === 'considered_not_applicable' || receipt.status === 'available_no_opportunity') return 'skipped';
  return 'degraded';
}

function candidateStatus(value: unknown): TraceStatus {
  if (value === 'observed' || value === 'weak_observation' || value === 'pending_review' || value === 'pending' || value === 'draft') return 'pending';
  if (value === 'confirmed' || value === 'accepted' || value === 'promoted' || value === 'active' || value === 'merged') return 'ok';
  if (value === 'rejected' || value === 'failed') return 'failed';
  if (value === 'deferred' || value === 'paused') return 'degraded';
  if (value === 'ignored' || value === 'expired' || value === 'superseded') return 'skipped';
  return 'degraded';
}

export async function readKstarTrace(
  userId: string,
  input: { conversationId?: string; taskId?: string },
): Promise<KstarTrace> {
  if (!input || !safeId(userId) || (input.conversationId === undefined && input.taskId === undefined)
    || (input.conversationId !== undefined && !safeId(input.conversationId))
    || (input.taskId !== undefined && !safeId(input.taskId))) {
    throw new Error('invalid KSTAR trace reference');
  }
  const selectedTask = input.taskId ? await readKstarTask(userId, input.taskId) : null;
  if (input.taskId && !selectedTask) throw new Error('kstar task not found');
  if (selectedTask && input.conversationId && selectedTask.conversationId !== input.conversationId) {
    throw new Error('kstar task does not belong to conversation');
  }
  const conversationId = selectedTask?.conversationId || input.conversationId!;
  const state = await readConversationTaskState(userId, conversationId);
  const currentTask = selectedTask || (state?.currentTaskId ? await readKstarTask(userId, state.currentTaskId) : null);
  const task = currentTask && currentTask.conversationId === conversationId ? currentTask : null;
  const tasks = input.taskId
    ? [selectedTask!]
    : task
      ? [task]
      : (await listKstarJsonRecords(userId, 'tasks')).filter((record) => record.conversationId === conversationId) as typeof task[];
  const nodes: KstarTraceNode[] = [];
  let injectionReceipts: InjectionReceipt[] = [];
  let usageReceipts: AssetUsageReceipt[] = [];
  let injectionLoadFailed = false;
  let usageLoadFailed = false;
  try { injectionReceipts = await listInjectionReceipts(userId); } catch { injectionLoadFailed = true; }
  try { usageReceipts = await listAssetUsageReceipts(userId); } catch { usageLoadFailed = true; }
  if (state?.routingDecisions?.length) {
    for (const decision of state.routingDecisions.slice(-20)) nodes.push(node('routing', {
      status: decision.isTask === false ? 'skipped' : 'ok', at: decision.at, primaryId: decision.sourceMessageId,
      source: decision.kind, summary: bounded(decision.reason),
    }));
  }
  for (const currentTask of tasks) {
    if (!currentTask) continue;
    nodes.push(node('task', { status: status(currentTask.status), at: currentTask.updatedAt, primaryId: currentTask.id, source: 'kstar', summary: bounded(currentTask.title) }));
    const requirements = await listKstarRequirementsForTask(userId, currentTask.id);
    for (const requirement of requirements) {
      nodes.push(node('requirement', { status: status(requirement.status), at: requirement.updatedAt, primaryId: requirement.id, parentId: currentTask.id, source: 'kstar', summary: bounded(requirement.goalText) }));
      const projectionIds = [...new Set([
        ...(requirement.projectionIds || []),
        ...(requirement.projectionId ? [requirement.projectionId] : []),
      ])];
      const persistedProjections = new Map<string, Record<string, unknown>>();
      if (projectionIds.length) {
        for (const projectionId of projectionIds) {
          const projection = await readRecallJsonRecord(userId, 'projections', projectionId).catch(() => undefined);
          if (projection) persistedProjections.set(projectionId, projection as Record<string, unknown>);
          nodes.push(node('projection', {
            status: status((projection as Record<string, unknown> | undefined)?.status),
            at: String((projection as Record<string, unknown> | undefined)?.decidedAt || (projection as Record<string, unknown> | undefined)?.createdAt || ''),
            primaryId: projectionId, parentId: requirement.id, source: 'recall',
            ...(projection ? {} : { errorCode: 'projection_missing', degradedReason: 'projection not persisted' }),
          }));
        }
      } else nodes.push(node('projection', { status: 'not_started', parentId: requirement.id, degradedReason: 'projection not persisted' }));
      const requirementInjections = injectionReceipts.filter((receipt) => (
        receipt.projectionId !== undefined && projectionIds.includes(receipt.projectionId)
      ));
      if (injectionLoadFailed) {
        nodes.push(node('injection', { status: 'degraded', parentId: requirement.id, source: 'recall', degradedReason: 'injection receipts unavailable' }));
      } else if (requirementInjections.length) {
        for (const receipt of requirementInjections) nodes.push(node('injection', {
          status: injectionStatus(receipt), at: receipt.createdAt, primaryId: receipt.id,
          parentId: receipt.projectionId || requirement.id, source: 'recall',
          summary: bounded(`${receipt.status}: ${receipt.assetId}@${receipt.assetVersion}`),
        }));
      } else {
        nodes.push(node('injection', { status: 'not_started', parentId: requirement.projectionId || requirement.id, source: 'recall', degradedReason: 'injection receipt not persisted' }));
      }
      const requirementUsage = usageReceipts.filter((receipt) => projectionIds.includes(receipt.projectionId));
      if (usageLoadFailed) {
        nodes.push(node('usage', { status: 'degraded', parentId: requirement.id, source: 'recall', degradedReason: 'asset usage receipts unavailable' }));
      } else if (requirementUsage.length) {
        for (const receipt of requirementUsage) nodes.push(node('usage', {
          status: usageStatus(receipt), at: receipt.createdAt, primaryId: receipt.id,
          parentId: receipt.injectionReceiptId, source: 'recall',
          summary: bounded(`${receipt.status}: ${receipt.assetId}@${receipt.assetVersion}`),
        }));
      } else {
        nodes.push(node('usage', { status: 'not_started', parentId: requirement.projectionId || requirement.id, source: 'recall', degradedReason: 'asset usage receipt not persisted' }));
      }
      if (requirement.forecastId) {
        const forecast = await readRecallJsonRecord(userId, 'world-model-forecasts', requirement.forecastId).catch(() => undefined);
        nodes.push(node('forecast', { status: status(requirement.forecastStatus || (forecast ? 'committed' : 'failed')), at: String((forecast as Record<string, unknown> | undefined)?.createdAt || ''), primaryId: requirement.forecastId, parentId: requirement.id, source: 'world-model', ...(requirement.forecastError ? { degradedReason: bounded(requirement.forecastError) } : {}) }));
      } else nodes.push(node('forecast', { status: requirement.forecastStatus ? status(requirement.forecastStatus) : 'not_started', parentId: requirement.id, degradedReason: requirement.forecastError ? bounded(requirement.forecastError) : 'forecast not persisted' }));
      if (!requirement.episodeIds.length) {
        nodes.push(node('closure', { status: 'not_started', parentId: requirement.id, source: 'kstar', degradedReason: 'episode closure not persisted' }));
        nodes.push(node('candidate', { status: 'not_started', parentId: requirement.id, source: 'recall', degradedReason: 'candidate extraction not started' }));
        nodes.push(node('trace_completeness', {
          status: 'not_started', parentId: requirement.id, source: 'kstar', completeness: 'not_recorded',
          degradedReason: 'execution facts not recorded',
        }));
      }
      for (const episodeId of requirement.episodeIds) {
        const episode = await readKstarJsonRecord(userId, 'episodes', episodeId);
        if (!episode) {
          nodes.push(node('episode', { status: 'failed', primaryId: episodeId, parentId: requirement.id, errorCode: 'episode_missing' }));
          nodes.push(node('closure', { status: 'degraded', primaryId: episodeId, parentId: requirement.id, source: 'kstar', degradedReason: 'episode missing' }));
          nodes.push(node('candidate', { status: 'not_started', parentId: episodeId, source: 'recall', degradedReason: 'candidate extraction not started' }));
          nodes.push(node('trace_completeness', {
            status: 'degraded', primaryId: episodeId, parentId: requirement.id, source: 'kstar',
            completeness: 'degraded', degradedReason: 'episode missing',
          }));
          continue;
        }
        const result = episode.r as Record<string, unknown>;
        nodes.push(node('runtime', { status: status(result.status), at: String(episode.updatedAt || ''), primaryId: String(episode.taskRunId || episode.executionId || episodeId), parentId: requirement.id, source: 'cogseed-runtime', ...(result.failureCode ? { errorCode: String(result.failureCode) } : {}) }));
        nodes.push(node('episode', { status: status(result.status), at: String(episode.updatedAt || ''), primaryId: episodeId, parentId: requirement.id, source: 'kstar', summary: bounded(result.finalText) }));
        const review = await readKstarJsonRecord(userId, 'reviews', `ksr-${episodeId}`);
        nodes.push(node('review', { status: review ? status((review as Record<string, unknown>).reviewState, 'ok') : 'not_started', at: String((review as Record<string, unknown> | undefined)?.updatedAt || ''), primaryId: review ? String(review.id) : undefined, parentId: episodeId, source: 'kstar', summary: bounded((review as Record<string, unknown> | undefined)?.lesson || (review as Record<string, unknown> | undefined)?.reason) }));
        const extraction = await readKstarJsonRecord(userId, 'extraction-runs', `ksx-${episodeId}`);
        const extractionRecord = extraction as Record<string, unknown> | null;
        nodes.push(node('extraction', { status: extraction ? status(extractionRecord?.status) : 'not_started', at: String(extractionRecord?.updatedAt || ''), primaryId: extraction ? String(extraction.id) : undefined, parentId: episodeId, source: 'kstar', ...(extractionRecord && typeof extractionRecord.error === 'string' ? { degradedReason: bounded(extractionRecord.error) } : {}) }));
        const precipitationIds = [
          ...(Array.isArray(extractionRecord?.candidateIds) ? extractionRecord.candidateIds : []),
          ...(Array.isArray(extractionRecord?.createdAssetIds) ? extractionRecord.createdAssetIds : []),
          ...(Array.isArray(extractionRecord?.mergedIntoIds) ? extractionRecord.mergedIntoIds : []),
          ...(Array.isArray(extractionRecord?.updateCandidateIds) ? extractionRecord.updateCandidateIds : []),
        ].filter((value): value is string => typeof value === 'string' && safeId(value));
        nodes.push(node('precipitation', {
          status: extraction ? status(extractionRecord?.status) : 'not_started',
          at: String(extractionRecord?.completedAt || extractionRecord?.updatedAt || ''),
          primaryId: extraction ? String(extraction.id) : undefined,
          parentId: episodeId, source: 'recall',
          ...(precipitationIds.length ? { summary: bounded(`result ids: ${[...new Set(precipitationIds)].join(', ')}`) } : {}),
          ...(extractionRecord && typeof extractionRecord.error === 'string' ? { degradedReason: bounded(extractionRecord.error) } : {}),
        }));
        const candidateIds = [
          ...(Array.isArray(extractionRecord?.candidateIds) ? extractionRecord.candidateIds : []),
          ...(Array.isArray(extractionRecord?.updateCandidateIds) ? extractionRecord.updateCandidateIds : []),
        ].filter((value): value is string => typeof value === 'string' && safeId(value));
        if (!extraction) {
          nodes.push(node('candidate', { status: 'not_started', parentId: episodeId, source: 'recall', degradedReason: 'candidate extraction not persisted' }));
        } else if (!candidateIds.length) {
          nodes.push(node('candidate', { status: 'skipped', parentId: String(extraction.id), source: 'recall', summary: 'no candidate produced' }));
        } else {
          for (const candidateId of [...new Set(candidateIds)]) {
            const candidate = await readRecallJsonRecord(userId, 'candidates', candidateId).catch(() => undefined);
            nodes.push(node('candidate', {
              status: candidate ? candidateStatus((candidate as Record<string, unknown>).status) : 'degraded',
              at: String((candidate as Record<string, unknown> | undefined)?.updatedAt || (candidate as Record<string, unknown> | undefined)?.createdAt || ''),
              primaryId: candidateId, parentId: String(extraction.id), source: 'recall',
              ...(candidate ? {} : { degradedReason: 'candidate result not persisted' }),
            }));
          }
        }
        const closureComplete = Boolean(review && extraction)
          && extractionRecord?.status !== 'failed'
          && extractionRecord?.status !== 'degraded';
        nodes.push(node('closure', {
          status: closureComplete ? 'ok' : 'degraded',
          at: String(extractionRecord?.updatedAt || (review as Record<string, unknown> | undefined)?.updatedAt || episode.updatedAt || ''),
          primaryId: episodeId, parentId: requirement.id, source: 'kstar',
          ...(!closureComplete ? { degradedReason: 'closure facts are incomplete or degraded' } : {}),
        }));
        const episodeProjectionId = typeof episode.projectionId === 'string' ? episode.projectionId : requirement.projectionId;
        const episodeAssetIds = new Set(Array.isArray((episode.k as Record<string, unknown> | undefined)?.abilityAssetRefs)
          ? ((episode.k as Record<string, unknown>).abilityAssetRefs as unknown[]).filter((value): value is string => typeof value === 'string')
          : []);
        const matchingInjections = episodeProjectionId
          ? requirementInjections.filter((receipt) => receipt.projectionId === episodeProjectionId
            && (episodeAssetIds.size === 0 || episodeAssetIds.has(receipt.assetId)))
          : [];
        const matchingInjectionIds = new Set(matchingInjections.map((receipt) => receipt.id));
        const matchingUsage = requirementUsage.filter((receipt) => matchingInjectionIds.has(receipt.injectionReceiptId));
        const allCitedAssetsHaveInjection = episodeAssetIds.size > 0
          && [...episodeAssetIds].every((assetId) => matchingInjections.some((receipt) => receipt.assetId === assetId));
        const allInjectionsHaveUsage = matchingInjections.length > 0
          && matchingInjections.every((injection) => matchingUsage.some((receipt) => receipt.injectionReceiptId === injection.id));
        const complete = Boolean(
          episodeProjectionId
          && persistedProjections.get(episodeProjectionId)?.status === 'confirmed'
          && allCitedAssetsHaveInjection
          && allInjectionsHaveUsage
          && review
          && extraction,
        );
        const explicitlyDegraded = injectionLoadFailed
          || usageLoadFailed
          || matchingInjections.some((receipt) => injectionStatus(receipt) === 'failed' || injectionStatus(receipt) === 'degraded')
          || matchingUsage.some((receipt) => usageStatus(receipt) === 'degraded')
          || extractionRecord?.status === 'failed'
          || extractionRecord?.status === 'degraded';
        nodes.push(node('trace_completeness', {
          status: complete && !explicitlyDegraded ? 'ok' : 'degraded',
          primaryId: episodeId, parentId: requirement.id, source: 'kstar',
          completeness: complete && !explicitlyDegraded ? 'complete' : explicitlyDegraded ? 'degraded' : 'partial',
          ...(!complete || explicitlyDegraded ? { degradedReason: 'one or more persisted lifecycle facts are missing or degraded' } : {}),
        }));
      }
    }
  }
  const taskIds = new Set(tasks.filter(Boolean).map((item) => item!.id));
  const requirementIds = new Set(nodes.filter((item) => item.stage === 'requirement' && item.primaryId).map((item) => item.primaryId!));
  const episodeIds = new Set(nodes.filter((item) => item.stage === 'episode' && item.primaryId).map((item) => item.primaryId!));
  const failures = await listKstarFailures(userId, { conversationId });
  for (const failure of failures.slice(0, 50)) nodes.push(node('failure', {
    status: 'failed', at: failure.at, primaryId: failure.id,
    parentId: failure.episodeId || failure.requirementId || failure.taskId || (taskIds.size === 1 ? [...taskIds][0] : undefined),
    source: failure.stage, errorCode: failure.errorCode, summary: bounded(failure.errorMessage),
  }));
  return { conversationId, ...(task ? { taskId: task.id } : {}), nodes, generatedAt: nowIso() };
}
