import { createLogger } from '../../logger';
import { safeId, nowIso } from '../../storage';
import { cidFromProjectSessionId } from '../../util/project-layout';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from '../recall/source-service';
import { listInjectionReceipts, type InjectionReceipt } from '../recall/injection-receipt';
import {
  recordAssetUsageReceipt,
  listAssetUsageReceipts,
  type AssetUsageEvidenceKind,
} from '../recall/asset-usage-receipt';
import { subscribeTaskTerminals, type TaskTerminalEvent, type TaskTerminalListener, type TaskTerminalStatus } from '../group_chat/bus';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../cogseed_runtime/protocol';
import type { RecallCandidateRecord } from '../recall/candidate-service';
import {
  readKstarEpisode,
  readKstarJsonRecord,
  replaceKstarJsonRecord,
  writeKstarEpisode,
} from './episode-store';
import { buildGroupKstarEpisode, buildRuntimeKstarEpisode, type GroupKstarEpisodeInput, type GroupKstarMessageInput, type RuntimeKstarEpisodeInput } from './episode-builder';
import { proposeKstarCandidates } from './extraction-service';
import { saveKstarCandidateProposals } from './recall-bridge';
import { createInitialKstarReview, readKstarReview, saveKstarReview, saveKstarReviewRecord } from './review-service';
import { inferKstarReview, type KstarReviewInferenceOptions, type KstarReviewInferenceResult } from './review-inference';
import { postKstarReviewCard } from './review-card';
import { recordKstarImprovementOutcome } from './improvement-outcome';
import type { KstarEpisodeRecord, KstarExtractionRunRecord, KstarReviewRecord } from './types';
import type { WorldModelForecast } from '../recall/world-model-types';
import type { KstarRequirementRecord } from './requirement-types';
import { listKstarRequirementsForTask, readConversationTaskState, readKstarRequirement } from './requirement-store';
import { recordKstarFailure } from './failure-service';

const log = createLogger('kstar.task-closure');
const closureLocks = new Map<string, Promise<KstarClosureResult>>();
const confirmationLocks = new Map<string, Promise<KstarClosureResult>>();

export interface KstarClosureResult {
  episode: KstarEpisodeRecord;
  review: KstarReviewRecord;
  candidates: RecallCandidateRecord[];
  extractionRun: KstarExtractionRunRecord;
}

export type KstarCandidateBridge = (
  userId: string,
  proposals: ReturnType<typeof proposeKstarCandidates>,
) => Promise<RecallCandidateRecord[]>;

export type KstarReviewInfer = (
  userId: string,
  episode: KstarEpisodeRecord,
  options?: KstarReviewInferenceOptions,
) => Promise<KstarReviewInferenceResult>;

export interface RuntimeKstarClosureInput extends RuntimeKstarEpisodeInput {
  bridge?: KstarCandidateBridge;
  inferReview?: KstarReviewInfer;
}

export interface GroupKstarClosureInput extends GroupKstarEpisodeInput {
  bridge?: KstarCandidateBridge;
  inferReview?: KstarReviewInfer;
}

function validExtractionRun(userId: string, episodeId: string, reviewId: string, runId: string, raw: Record<string, unknown>): KstarExtractionRunRecord {
  if (
    raw.ownerId !== userId || raw.id !== runId || raw.episodeId !== episodeId || raw.reviewId !== reviewId ||
    !Array.isArray(raw.candidateIds) || raw.candidateIds.some((id) => typeof id !== 'string') ||
    !['created', 'partial', 'degraded', 'failed'].includes(String(raw.status)) ||
    (raw.createdAssetIds !== undefined && (!Array.isArray(raw.createdAssetIds) || raw.createdAssetIds.some((id) => typeof id !== 'string' || !safeId(id)))) ||
    (raw.mergedIntoIds !== undefined && (!Array.isArray(raw.mergedIntoIds) || raw.mergedIntoIds.some((id) => typeof id !== 'string' || !safeId(id)))) ||
    (raw.updateCandidateIds !== undefined && (!Array.isArray(raw.updateCandidateIds) || raw.updateCandidateIds.some((id) => typeof id !== 'string' || !safeId(id)))) ||
    (raw.failureIds !== undefined && (!Array.isArray(raw.failureIds) || raw.failureIds.some((id) => typeof id !== 'string' || !safeId(id)))) ||
    (raw.completedAt !== undefined && typeof raw.completedAt !== 'string') ||
    typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string' ||
    (raw.error !== undefined && typeof raw.error !== 'string')
  ) throw new Error('malformed kstar extraction run');
  return raw as KstarExtractionRunRecord;
}

function serializeClosure(
  locks: Map<string, Promise<KstarClosureResult>>,
  key: string,
  task: () => Promise<KstarClosureResult>,
): Promise<KstarClosureResult> {
  const previous = locks.get(key) || Promise.resolve(undefined as unknown as KstarClosureResult);
  const current = previous.catch(() => undefined as unknown as KstarClosureResult).then(task);
  locks.set(key, current);
  void current.then(
    () => { if (locks.get(key) === current) locks.delete(key); },
    () => { if (locks.get(key) === current) locks.delete(key); },
  );
  return current;
}

async function reconcileKstarExtraction(
  userId: string,
  episode: KstarEpisodeRecord,
  review: KstarReviewRecord,
) : Promise<KstarClosureResult> {
  const extractionRunId = `ksx-${episode.id}`;
  let existingRun: KstarExtractionRunRecord | null = null;
  try {
    const raw = await readKstarJsonRecord(userId, 'extraction-runs', extractionRunId);
    existingRun = raw ? validExtractionRun(userId, episode.id, review.id, extractionRunId, raw) : null;
  } catch {
    // A malformed/future synced run is rebuilt below with the current schema.
  }
  // Review-only closure: this pass captures the episode + Commander review
  // and marks the run reviewed. NO precipitation happens here — the KStar
  // line precipitates only at the WHOLE-TASK loop boundary (finish/abandon/
  // task switch, where requirement-level aggregation runs). Per-run closure
  // precipitation would fragment lessons before the task closes.
  if (existingRun?.status === 'created') {
    return { episode, review, candidates: [], extractionRun: existingRun };
  }
  const extractionRun: KstarExtractionRunRecord = {
    schemaVersion: 1,
    ownerId: userId,
    id: extractionRunId,
    episodeId: episode.id,
    reviewId: review.id,
    candidateIds: [],
    status: 'created',
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  };
  await replaceKstarJsonRecord(userId, 'extraction-runs', extractionRun);
  return { episode, review, candidates: [], extractionRun };
}

async function finishClosure(
  userId: string,
  episode: KstarEpisodeRecord,
  bridge: KstarCandidateBridge = saveKstarCandidateProposals,
  inferReview: KstarReviewInfer = inferKstarReview,
  options: {
    forecast?: WorldModelForecast | null;
    forecastStatus?: string;
    messages?: Array<{ from: string; text: string; ts?: string }>;
    groupMessages?: GroupKstarMessageInput[];
    conversationId?: string;
  } = {},
): Promise<KstarClosureResult> {
  await writeKstarEpisode(userId, episode);
  await persistAssetUsageTruth(userId, episode, options.groupMessages, options.conversationId);
  let attributionReceipts: { injectionReceipts: InjectionReceipt[]; usageReceipts: Awaited<ReturnType<typeof listAssetUsageReceipts>> } = {
    injectionReceipts: [],
    usageReceipts: [],
  };
  const receiptRunIds = episode.reuseTurnIds !== undefined
    ? [...new Set(episode.reuseTurnIds)]
    : episode.taskRunId
      ? [episode.taskRunId]
      : [];
  if (receiptRunIds.length) {
    try {
      const receiptRunIdSet = new Set(receiptRunIds);
      const [injectionReceipts, usageReceipts] = await Promise.all([
        listInjectionReceipts(userId),
        listAssetUsageReceipts(userId),
      ]);
      attributionReceipts = {
        injectionReceipts: injectionReceipts.filter((receipt) => receiptRunIdSet.has(receipt.taskRunId)),
        usageReceipts: usageReceipts.filter((receipt) => receiptRunIdSet.has(receipt.taskRunId)),
      };
    } catch (error) {
      log.warn('kstar attribution receipt read degraded', {
        userId,
        episodeId: episode.id,
        error: (error as Error).message,
      });
    }
  }
  let storedReview: KstarReviewRecord | null = null;
  try {
    storedReview = await readKstarReview(userId, episode.id);
  } catch {
    // A malformed synced review is degraded; replace it with a conservative review.
  }
  let review = storedReview;
  if (!review) {
    try {
      // fallback 推理也走确定性世界模型度量（forecast）：期望 vs 实际由
      // reconcileWorldModel 确定性计算，模型只做归因与教训提炼——不依赖
      // Commander 回合（不占队列）。对话历史（messages）恢复执行情境
      // （中途变更/失败/临时决策），质量与 Commander review 相当。
      const inferred = await inferReview(userId, episode, {
        ...(options.forecast ? { forecast: options.forecast } : {}),
        ...(options.forecastStatus ? { forecastStatus: options.forecastStatus } : {}),
        ...(options.messages?.length ? { messages: options.messages } : {}),
        injectionReceipts: attributionReceipts.injectionReceipts,
        usageReceipts: attributionReceipts.usageReceipts,
      });
      review = await saveKstarReview(userId, episode, {
        ...inferred.review,
        reviewState: inferred.reviewState,
        inferenceMethod: inferred.inferenceMethod,
        needsConfirmation: inferred.needsConfirmation,
      });
    } catch {
      await recordKstarFailure(userId, {
        stage: 'review_inference', errorCode: 'review_inference_failed',
        errorMessage: 'KSTAR review inference failed; a conservative review was stored.',
        operationKey: `review-${episode.id}`, episodeId: episode.id,
      }).catch(() => undefined);
      review = await saveKstarReviewRecord(userId, createInitialKstarReview(episode));
    }
  }
  return reconcileKstarExtraction(userId, episode, review);
}

function messageHasSuccessfulToolCall(message: GroupKstarMessageInput): boolean {
  return (message.process || []).some((item) => {
    // 老格式两形态都可能有 event；chat_events 新条目（chatItem/turn）无此字段。
    const event = item.type === 'event' || item.type === 'progress' ? item.event : undefined;
    if (!event || event.stream !== 'tool' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      return false;
    }
    const data = event.data as Record<string, unknown>;
    const phase = typeof data.phase === 'string' ? data.phase.toLowerCase() : '';
    return (phase === 'end' || phase === 'complete' || phase === 'completed') && data.isError !== true;
  });
}

function hostObservableUsageEvidence(episode: KstarEpisodeRecord, message?: GroupKstarMessageInput): {
  evidenceKind: AssetUsageEvidenceKind;
  evidenceRefs: CognitionSourceRef[];
} | undefined {
  if (episode.r.status !== 'completed') return undefined;
  const executionRef = normalizeCognitionSourceRefs([{
    kind: 'execution_evaluation',
    id: episode.id,
    subtype: 'execution',
    title: 'Persisted KSTAR episode',
  }]);
  // The evidence must be tied to the exact persisted message that carried the
  // citation. A successful call elsewhere in the episode proves that the run
  // did work, but not that this particular asset was adopted.
  if (!message) return undefined;
  if (messageHasSuccessfulToolCall(message)) {
    return { evidenceKind: 'tool_call', evidenceRefs: executionRef };
  }
  const artifactRefs = normalizeCognitionSourceRefs([
    ...(message.produced || []).map((file) => ({ kind: 'artifact_file' as const, id: `artifact-${file}` })),
    ...(message.artifacts || []).map((artifact) => ({ kind: 'artifact_file' as const, id: artifact.id, title: artifact.title })),
  ]);
  if (artifactRefs.length) {
    return { evidenceKind: 'artifact', evidenceRefs: artifactRefs };
  }
  return undefined;
}

interface InjectedCitationForEpisode {
  injection: InjectionReceipt;
  message: GroupKstarMessageInput;
  ambiguous: boolean;
}

function injectedCitationsForEpisode(
  episode: KstarEpisodeRecord,
  messages: GroupKstarMessageInput[] | undefined,
  receipts: InjectionReceipt[],
): InjectedCitationForEpisode[] {
  if (!episode.projectionId || !messages?.length || !episode.k.abilityAssetRefs.length) return [];
  const evidenceMessageIds = new Set(episode.evidenceRefs
    .filter((ref) => ref.kind === 'conversation' || ref.kind === 'message')
    .map((ref) => ref.id));
  const citedByMessage = new Map<string, Set<string>>();
  for (const message of messages) {
    if (!evidenceMessageIds.has(message.id)) continue;
    for (const citation of message.recall_citations || []) {
      if (
        citation.projection_id === episode.projectionId
        && episode.k.abilityAssetRefs.includes(citation.asset_id)
      ) {
        const cited = citedByMessage.get(message.id) || new Set<string>();
        cited.add(`${citation.asset_id}:${citation.version}`);
        citedByMessage.set(message.id, cited);
      }
    }
  }
  return receipts.flatMap((injection) => {
    if (
      injection.boundary !== 'real'
      || (injection.status !== 'injected' && injection.status !== 'dispatched')
      || injection.projectionId !== episode.projectionId
      || !injection.messageId
    ) return [];
    const message = messages.find((candidate) => candidate.id === injection.messageId);
    const cited = message ? citedByMessage.get(message.id) : undefined;
    if (!message || !cited?.has(`${injection.assetId}:${injection.assetVersion}`)) return [];
    return [{ injection, message, ambiguous: cited.size > 1 }];
  });
}

async function persistAssetUsageTruth(
  userId: string,
  episode: KstarEpisodeRecord,
  messages?: GroupKstarMessageInput[],
  conversationId?: string,
): Promise<void> {
  try {
    const injections = injectedCitationsForEpisode(
      episode,
      messages,
      await listInjectionReceipts(userId),
    );
    if (!injections.length) return;
    const writes = await Promise.allSettled(injections.map(({ injection, message, ambiguous }) => {
      const observable = ambiguous ? undefined : hostObservableUsageEvidence(episode, message);
      return recordAssetUsageReceipt(userId, {
        taskRunId: injection.taskRunId,
        projectionId: injection.projectionId!,
        assetId: injection.assetId,
        assetVersion: injection.assetVersion,
        injectionReceiptId: injection.id,
        status: observable ? 'applied' : 'usage_unknown',
        evidenceKind: observable?.evidenceKind || 'none',
        evidenceRefs: observable?.evidenceRefs || [],
        boundary: 'real',
      });
    }));
    if (writes.some((result) => result.status === 'rejected')) {
      throw new Error('one or more asset usage receipts failed');
    }
  } catch (error) {
    log.warn('kstar asset usage persistence degraded', {
      userId,
      episodeId: episode.id,
      error: (error as Error).message,
    });
    await recordKstarFailure(userId, {
      stage: 'capture',
      errorCode: 'asset_usage_persistence_failed',
      errorMessage: 'KSTAR asset usage persistence degraded; terminal result was preserved.',
      operationKey: `usage-${episode.id}`,
      ...(conversationId ? { conversationId } : {}),
      episodeId: episode.id,
    }).catch(() => undefined);
  }
}

export type KstarReviewVerdict = 'met' | 'partial' | 'not_met' | 'skip';
export interface ConfirmKstarReviewInput {
  verdict: KstarReviewVerdict;
  actualResult?: string;
  reason?: string;
  attributionDetails?: unknown;
}

function confirmationReviewInput(
  episode: KstarEpisodeRecord,
  current: KstarReviewRecord,
  input: ConfirmKstarReviewInput,
): Parameters<typeof saveKstarReview>[2] {
  const confirmedAt = new Date().toISOString();
  const actualResult = typeof input.actualResult === 'string' && input.actualResult.trim()
    ? input.actualResult.trim()
    : current.actualResult;
  const reason = typeof input.reason === 'string' && input.reason.trim()
    ? input.reason.trim()
    : input.verdict === 'met'
      ? 'The user confirmed that the task met the expected result.'
      : input.verdict === 'partial'
        ? 'The user confirmed that the task only partially met the expected result.'
        : input.verdict === 'not_met'
          ? 'The user confirmed that the task did not meet the expected result.'
          : 'The user skipped outcome confirmation.';
  const common = {
    ...(current.expectedResult ? { expectedResult: current.expectedResult } : {}),
    ...(actualResult ? { actualResult } : {}),
    evidenceRefs: current.evidenceRefs.length ? current.evidenceRefs : episode.evidenceRefs,
    ...(input.attributionDetails !== undefined
      ? { attributionDetails: input.attributionDetails }
      : current.attributionDetails
        ? { attributionDetails: current.attributionDetails }
        : {}),
    inferenceMethod: 'user' as const,
    confirmedAt,
  };
  if (input.verdict === 'skip') return {
    ...common,
    deltaR: 'unknown', deltaA: 'unknown', outcome: 'unclear', attribution: 'unclear',
    reason, confidence: 0, reviewState: 'unknown', needsConfirmation: false,
  };
  if (input.verdict === 'met') return {
    ...common,
    deltaR: 0, deltaA: 0, outcome: 'met_expected', attribution: 'unclear',
    reason, confidence: 1, reviewState: 'confirmed', needsConfirmation: false,
  };
  return {
    ...common,
    deltaR: input.verdict === 'partial' ? -0.5 : -1,
    deltaA: 'unknown', outcome: 'worse_than_expected', attribution: 'execution_gap',
    reason, confidence: 1, reviewState: 'confirmed', needsConfirmation: false,
  };
}

/**
 * T035（US-704）：复盘确认后，这条 review 首次落**用户确认的终态**——沿
 * **同一条**改进分析链路继续，即需求级沉淀入口 `precipitateRequirementLevel`
 * （`task-level-precipitation.ts`；US-701 的采用门与四类结论都收口在那条链上）。
 *
 * 为什么不在确认里另起分析：finish / abandon / 任务切换 / 静默自动闭环全部走
 * 这一个入口（`control-service.ts` 的三处 + `runAutoClose`），确认只是让分析
 * 依据（review 的终态）变了，所以复用同一入口重跑；提交出口、采用门、结论
 * 幂等都由既有链路保证，不新增管线，也不绕开任何门。
 *
 * best-effort：链路异常只记日志与结论，**不回抛**——review 的终态在调用本函数
 * 之前已经落盘（`saveKstarReview`），确认失败不阻断终态，也不静默。
 */
async function requirementForConfirmedReview(
  userId: string,
  episode: KstarEpisodeRecord,
): Promise<KstarRequirementRecord | null> {
  if (episode.requirementId && safeId(episode.requirementId)) {
    const requirement = await readKstarRequirement(userId, episode.requirementId);
    if (requirement) return requirement;
  }
  // 没带 requirementId 的 episode：按任务成员表找回（`episodeIds` 是权威归属）。
  if (episode.taskId && safeId(episode.taskId)) {
    const member = (await listKstarRequirementsForTask(userId, episode.taskId))
      .find((requirement) => requirement.episodeIds.includes(episode.id));
    if (member) return member;
  }
  // 存量 episode（连 taskId 都没有）：只剩会话这条线索。需求必须真的把这条
  // episode 记进 `episodeIds` 才认——否则宁可不分析，也不挂到无关需求上。
  const conversationId = cidFromProjectSessionId(userId, episode.sessionId || '');
  if (!conversationId) return null;
  const state = await readConversationTaskState(userId, conversationId);
  const currentRequirementId = state?.currentRequirementId;
  if (!currentRequirementId || !safeId(currentRequirementId)) return null;
  const requirement = await readKstarRequirement(userId, currentRequirementId);
  return requirement && requirement.episodeIds.includes(episode.id) ? requirement : null;
}

async function continueImprovementAnalysisAfterConfirm(
  userId: string,
  episode: KstarEpisodeRecord,
  review: KstarReviewRecord,
  verdict: KstarReviewVerdict,
): Promise<void> {
  const recordConclusion = async (
    conclusion: 'insufficient_evidence' | 'analysis_failed',
    reason: string,
    options: { requirementId?: string; failureCategory?: 'unknown' } = {},
  ): Promise<void> => {
    try {
      await recordKstarImprovementOutcome(userId, {
        episodeId: episode.id,
        reviewId: review.id,
        conclusion,
        reason,
        ...(options.requirementId ? { requirementId: options.requirementId } : {}),
        ...(options.failureCategory ? { failureCategory: options.failureCategory } : {}),
        evidenceRefs: [{ kind: 'execution', id: episode.id }],
      });
    } catch (error) {
      log.warn('kstar confirm improvement conclusion degraded', {
        userId,
        episodeId: episode.id,
        error: (error as Error).message,
      });
    }
  };
  // 「需要修正」= 复盘结论未定（复盘卡两态里的第二态，research D8）：不放行任何
  // 候选，也不重跑聚合线——聚合线覆盖其他 episode 与偏好线，不该由一次"未确认"
  // 的处置触发；只如实留痕一条结论。
  if (verdict === 'skip') {
    await recordConclusion(
      'insufficient_evidence',
      '复盘被标记为需要修正，结论未定，本次没有产出改进候选；修正后可再次确认，由改进分析链路重新分析。',
    );
    return;
  }
  let requirement: KstarRequirementRecord | null = null;
  try {
    requirement = await requirementForConfirmedReview(userId, episode);
  } catch (error) {
    log.warn('kstar confirm requirement lookup degraded', {
      userId,
      episodeId: episode.id,
      error: (error as Error).message,
    });
  }
  if (!requirement) {
    // 缺必需上下文（没有归属的任务需求）：如实落一条结论，不静默什么都不做。
    await recordConclusion(
      'insufficient_evidence',
      '这条复盘没有归属到任务需求，改进分析链路没有可分析的范围，本次没有产出候选；补上任务归属后可再次确认。',
    );
    return;
  }
  try {
    const { precipitateRequirementLevel } = await import('./task-level-precipitation');
    await precipitateRequirementLevel(userId, requirement);
  } catch (error) {
    log.warn('kstar confirm improvement analysis degraded', {
      userId,
      episodeId: episode.id,
      requirementId: requirement.id,
      error: (error as Error).message,
    });
    await recordConclusion(
      'analysis_failed',
      '改进分析链路执行失败（归因：unknown），本次没有产出候选。',
      { requirementId: requirement.id, failureCategory: 'unknown' },
    );
  }
}

export async function confirmKstarReview(
  userId: string,
  episodeId: string,
  input: ConfirmKstarReviewInput,
  bridge: KstarCandidateBridge = saveKstarCandidateProposals,
): Promise<KstarClosureResult> {
  return serializeClosure(confirmationLocks, `${userId}:${episodeId}`, async () => {
    const episode = await readKstarEpisode(userId, episodeId);
    if (!episode) throw new Error('kstar episode not found');
    const current = await readKstarReview(userId, episodeId);
    if (!current) throw new Error('kstar review not found');
    const review = await saveKstarReview(userId, episode, confirmationReviewInput(episode, current, input));
    const result = await reconcileKstarExtraction(userId, episode, review);
    // review 已落终态（上面一行）→ 再沿同一改进分析链路继续（T035）。顺序有意
    // 如此：即使链路慢/失败，用户确认的终态也已经持久化，不会被链路拖累。
    await continueImprovementAnalysisAfterConfirm(userId, episode, review, input.verdict);
    return result;
  });
}

/** Merge Commander-submitted completion evidence (kstar_control.finish) into
 *  an episode, so the review pipeline consumes the terminal evidence the
 *  Commander explicitly declared. Explicit evidence wins over message-derived
 *  text; missing evidence leaves the episode untouched. */
async function enrichEpisodeFromRequirementEvidence(
  userId: string,
  conversationId: string,
  episode: KstarEpisodeRecord,
  requirementId?: string,
): Promise<KstarEpisodeRecord> {
  try {
    const state = requirementId ? null : await readConversationTaskState(userId, conversationId);
    const resolvedRequirementId = requirementId || state?.currentRequirementId;
    const requirement = resolvedRequirementId
      ? await readKstarRequirement(userId, resolvedRequirementId)
      : null;
    if (requirement && requirement.conversationId !== conversationId) {
      throw new Error('KSTAR requirement conversation mismatch');
    }
    const evidence = requirement?.completionEvidence;
    if (!evidence) return episode;
    const r = { ...episode.r };
    // Explicit Commander-submitted terminal evidence wins over message-derived text.
    if (evidence.finalText?.trim()) r.finalText = evidence.finalText;
    if (evidence.producedFiles.length) {
      r.producedFiles = Array.from(new Set([...(r.producedFiles || []), ...evidence.producedFiles])).slice(0, 50);
    }
    if (!r.finalText?.trim() && !r.producedFiles.length) return episode;
    return { ...episode, r };
  } catch (error) {
    log.warn('kstar completion evidence merge degraded', {
      userId,
      conversationId,
      error: (error as Error).message,
    });
    return episode;
  }
}

export async function captureRuntimeKstarClosure(input: RuntimeKstarClosureInput): Promise<KstarClosureResult> {
  const episode = buildRuntimeKstarEpisode(input);
  return serializeClosure(closureLocks, `${input.userId}:${episode.id}`, () => finishClosure(input.userId, episode, input.bridge, input.inferReview));
}

export async function captureGroupKstarClosure(input: GroupKstarClosureInput): Promise<KstarClosureResult> {
  // Five-source evidence context: delta-r/delta-a reasoning evolves from ALL
  // cognition sources. Teaching signals + execution evaluations bound to this
  // conversation are resolved host-side and attached to the episode before
  // review inference; connectors may add authorized_external_system refs.
  let teachingRefs: CognitionSourceRef[] = [];
  let executionRefs: CognitionSourceRef[] = [];
  try {
    const [signals, executionGroups] = await Promise.all([
      import('../recall/teaching-service').then((m) => m.listUserTeachingSignals(input.userId, {
        conversationId: input.conversationId,
        status: 'active',
        limit: 50,
      })),
      import('../recall/source-catalog').then((m) => m.listCognitionSources(input.userId, {
        kinds: ['execution_evaluation'],
        conversationId: input.conversationId,
        limit: 10,
      })),
    ]);
    teachingRefs = normalizeCognitionSourceRefs(signals.map((signal) => ({
      kind: 'user_teaching_signal',
      subtype: 'teaching',
      scope: signal.scope,
      id: signal.id,
      ...(signal.title ? { title: signal.title } : {}),
    })));
    executionRefs = executionGroups.flatMap((group) => group.items);
  } catch (error) {
    log.warn('kstar five-source evidence resolution degraded', {
      userId: input.userId,
      conversationId: input.conversationId,
      error: (error as Error).message,
    });
  }
  const built = buildGroupKstarEpisode({
    ...input,
    ...(teachingRefs.length ? { userTeachingSignalRefs: teachingRefs } : {}),
    ...(executionRefs.length ? { executionEvaluationRefs: executionRefs } : {}),
  });
  // New-format snapshot terminal events carry reuse_turn_ids ([] here is
  // authoritative-empty, not "unknown"). When such an event reaches capture
  // WITHOUT its task/requirement identity (transient provenance loss), the
  // post-run current lifecycle may already belong to a LATER requirement — do
  // not enrich from it. True legacy events (reuse_turn_ids undefined) keep the
  // current-state fallback for backward compatibility.
  const hasSnapshotFormat = built.reuseTurnIds !== undefined;
  const degradedSnapshotWithoutRequirement = hasSnapshotFormat && !input.requirementId;
  let episode = degradedSnapshotWithoutRequirement
    ? built
    : await enrichEpisodeFromRequirementEvidence(
        input.userId,
        input.conversationId,
        built,
        input.requirementId,
      );
  // 空间归属：episode 构建链路（buildGroupKstarEpisode）不透传 workspaceId，
  // 这里从会话的 space_id 补齐——KStar 沉淀的资产才挂得到空间（空间资产
  // tab 按 asset.spaceId 过滤；否则全局可见但空间里看不到）。runtime 链路
  // （RuntimeRunRequest 禁止 conversation_id）无会话上下文，不做空间归属。
  try {
    const { getConversation } = await import('../chats');
    const conversation = await getConversation(input.userId, input.conversationId);
    const spaceId = conversation && typeof (conversation as { space_id?: unknown }).space_id === 'string'
      ? (conversation as { space_id: string }).space_id
      : undefined;
    if (spaceId && safeId(spaceId) && !episode.s?.workspaceId) {
      episode = { ...episode, s: { ...(episode.s || {}), workspaceId: spaceId } };
    }
  } catch (error) {
    log.warn('kstar episode space attribution degraded', {
      userId: input.userId,
      conversationId: input.conversationId,
      error: (error as Error).message,
    });
  }
  // 确定性世界模型度量（review 推理用）：期望 vs 实际由 forecast 记录
  // 确定性计算，模型只归因——全程独立后台 runner，不占 Commander 队列
  // （Commander review 回合已移除：实测其占队列 8-10s 且 lesson 产出为
  // 空，而确定性度量 + 对话历史的后台推理质量更稳定）。
  let forecast: Awaited<ReturnType<typeof import('../recall/world-model').readWorldModelForecast>> | null = null;
  if (input.forecastId) {
    try {
      const { readWorldModelForecast } = await import('../recall/world-model');
      forecast = await readWorldModelForecast(input.userId, input.forecastId);
    } catch {
      // 无 forecast 记录 → 退化为机械推断（现状行为）。
    }
  }
  const result = await serializeClosure(closureLocks, `${input.userId}:${episode.id}`, async () => {
    return finishClosure(input.userId, episode, input.bridge, input.inferReview, {
      // readWorldModelForecast returns the RECORD (forecast nested under
      // `record.forecast`); inferKstarReview expects the flat WorldModelForecast.
      ...(forecast ? { forecast: forecast.forecast } : {}),
      ...(input.forecastId ? { forecastStatus: forecast ? 'committed' : 'failed' } : {}),
      ...(input.messages?.length ? { messages: input.messages } : {}),
      ...(input.messages?.length ? { groupMessages: input.messages } : {}),
      conversationId: input.conversationId,
    });
  });
  const degradedSnapshotWithoutIdentity = hasSnapshotFormat
    && !input.taskId
    && !input.requirementId
    && !input.projectionId
    && !input.wakeRequestId;
  if (degradedSnapshotWithoutRequirement) {
    // Snapshot episodes without a requirement identity can bind ONLY through a
    // resolved projection/wake provenance match under the explicitly provided
    // task — never through the post-run current-lifecycle fallback. Surface
    // them so unattached degraded episodes stay observable (identifiers only,
    // no private text).
    log.warn('kstar snapshot episode has no requirement identity; attachment limited to provenance match', {
      userId: input.userId,
      episodeId: episode.id,
    });
  }
  if (!degradedSnapshotWithoutIdentity) {
    try {
      const { attachKstarEpisodeToRequirement } = await import('./requirement-state');
      await attachKstarEpisodeToRequirement(input.userId, {
        conversationId: input.conversationId,
        episodeId: episode.id,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.requirementId ? { requirementId: input.requirementId } : {}),
        ...(input.projectionId ? { projectionId: input.projectionId } : {}),
        ...(input.wakeRequestId ? { wakeRequestId: input.wakeRequestId } : {}),
      }, { allowCurrentRequirementFallback: !hasSnapshotFormat });
    } catch (error) {
      log.warn('kstar requirement episode attachment degraded', {
        userId: input.userId,
        episodeId: episode.id,
        error: (error as Error).message,
      });
    }
  }
  try {
    const { drainKstarTaskState } = await import('./task-aggregate');
    await drainKstarTaskState(input.userId, input.conversationId);
  } catch (error) {
    log.warn('kstar task drain degraded', {
      userId: input.userId,
      episodeId: episode.id,
      error: (error as Error).message,
    });
  }
  return result;
}

/** Runtime facade adapter: only terminal-relevant facts are accepted by callers. */
export function runtimeKstarCaptureInput(
  userId: string,
  runId: string,
  request: RuntimeRunRequest,
  events: RuntimeEventEnvelope[],
): RuntimeKstarClosureInput {
  return { userId, runId, request, events };
}


export type GroupKstarTerminalSubscribe = (listener: TaskTerminalListener) => () => void;
/** 会话消息形态：episode 构建用的窄输入 + 复盘卡标识。发卡幂等必须能按
 *  `reviewId` 在消息里查重，而 `GroupKstarMessageInput` 不含卡片字段——默认
 *  loader 从真实消息映射它；测试注入的 loader 不带该字段即视为"历史里没有卡"。 */
export interface GroupKstarMessageWithReviewCard extends GroupKstarMessageInput {
  kstar_review_card?: { kind?: string; reviewId?: string };
}
export type GroupKstarMessageLoader = (userId: string, conversationId: string, limit: number) => Promise<GroupKstarMessageWithReviewCard[]>;
export type GroupKstarReviewCardPublisher = (userId: string, conversationId: string, review: KstarReviewRecord) => Promise<void>;

export interface GroupKstarClosureRuntime {
  subscribe?: GroupKstarTerminalSubscribe;
  readMessages?: GroupKstarMessageLoader;
  capture?: (input: GroupKstarClosureInput) => Promise<KstarClosureResult>;
  publishReviewCard?: GroupKstarReviewCardPublisher;
}


async function defaultReviewCardPublisher(userId: string, conversationId: string, review: KstarReviewRecord): Promise<void> {
  const bus = await import('../group_chat/bus');
  await postKstarReviewCard(userId, conversationId, review, {
    send: async (payload) => {
      const message = await bus.enqueue({
        uid: userId,
        cid: conversationId,
        fromActorId: 'commander',
        text: payload.text,
        kstar_review_card: payload.kstar_review_card,
        forceTo: ['user'],
      });
      return { id: message.id };
    },
  });
}

/** 发卡幂等的进程内占位（键 = userId:conversationId:reviewId）。两层各有分工：
 *  消息里查重覆盖重启/历史重放；这张表覆盖"并发触发都在对方落盘之前通过查重"
 *  的窗口——占位在第一个 await 之前完成，所以同一 review 只有一条路径能到发送。 */
const reviewCardClaims = new Set<string>();

function reviewCardClaimKey(userId: string, conversationId: string, reviewId: string): string {
  return `${userId}:${conversationId}:${reviewId}`;
}

/** 触发条件收口：只在**终态收口**（waiting_input 是非终态，不发）且 review
 *  明确需要用户确认时发卡；其余路径零发卡。 */
function shouldPublishReviewCard(status: TaskTerminalStatus, review: KstarReviewRecord | undefined): review is KstarReviewRecord {
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return false;
  return Boolean(review && review.needsConfirmation === true);
}

/** 在 capture 完成、review 落盘之后发卡（一 review 一卡）。发卡失败只记
 *  KstarFailureRecord(stage='control_receipt') + 日志：任务与 review 状态不变、
 *  不重试风暴，也不把异常抛回 capture 重试链（那会重跑整个 capture）。 */
async function publishReviewCardOnce(
  userId: string,
  conversationId: string,
  review: KstarReviewRecord,
  loadMessages: GroupKstarMessageLoader,
  publish: GroupKstarReviewCardPublisher,
): Promise<void> {
  const reviewId = typeof review.id === 'string' ? review.id.trim() : '';
  if (!reviewId) return;
  const claim = reviewCardClaimKey(userId, conversationId, reviewId);
  if (reviewCardClaims.has(claim)) return;
  reviewCardClaims.add(claim);
  try {
    // 消息里已有同 reviewId 的卡 → 已经发过（重启、历史重放、并发触发）。
    const messages = await loadMessages(userId, conversationId, 500);
    if (messages.some((message) => message.kstar_review_card?.reviewId === reviewId)) return;
    await publish(userId, conversationId, review);
  } catch (error) {
    // 失败不占位：本路径不重试（不给重试风暴），但后续独立的终态触发可以再试一次。
    reviewCardClaims.delete(claim);
    log.warn('kstar review card publish degraded', {
      userId,
      conversationId,
      reviewId,
      errorCode: 'review_card_publish_failed',
      error: (error as Error).message,
    });
    await recordKstarFailure(userId, {
      stage: 'control_receipt', errorCode: 'review_card_publish_failed',
      errorMessage: 'KSTAR review card publish failed; task closure and review state were preserved.',
      operationKey: `review-card-${reviewId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100),
      conversationId,
      ...(safeId(review.episodeId) ? { episodeId: review.episodeId } : {}),
    }).catch(() => undefined);
  }
}

async function defaultGroupMessageLoader(userId: string, conversationId: string, limit: number): Promise<GroupKstarMessageWithReviewCard[]> {
  const groupChat = await import('../group_chat');
  const messages = await groupChat.readMessages(userId, conversationId, limit);
  return messages.map((message) => {
    const base: GroupKstarMessageWithReviewCard = {
    id: message.id,
    ts: message.ts,
    from: message.from,
    text: message.text,
    ...(message.produced ? { produced: message.produced } : {}),
    ...(message.failure_kind ? { failure_kind: message.failure_kind } : {}),
    ...(message.failure_code ? { failure_code: message.failure_code } : {}),
    ...(message.system_kind ? { system_kind: message.system_kind } : {}),
    ...(message.artifacts ? { artifacts: message.artifacts.slice(0, 10).map((artifact) => ({ id: artifact.id, title: artifact.title })) } : {}),
    ...(message.created_agents ? { created_agents: message.created_agents.slice(0, 10).map((agent) => ({ agent_id: agent.agent_id, name: agent.name })) } : {}),
    ...(message.created_skills ? { created_skills: message.created_skills.slice(0, 10).map((skill) => ({ skill_id: skill.skill_id, name: skill.name })) } : {}),
    ...(message.plan_announcement ? { plan_announcement: true } : {}),
    ...(message.dispatch ? { dispatch: true } : {}),
    ...(message.kstar_dispatch_narration ? { kstar_dispatch_narration: { ...message.kstar_dispatch_narration } } : {}),
    ...(message.process ? { process: message.process.slice(0, 300) } : {}),
    ...(message.recall_citations ? { recall_citations: message.recall_citations.slice(0, 12).map((citation) => ({
      asset_id: citation.asset_id,
      version: citation.version,
      projection_id: citation.projection_id,
      ...(citation.forecast_id ? { forecast_id: citation.forecast_id } : {}),
    })) } : {}),
    };
    // 发卡幂等按 reviewId 查重需要看到历史卡片（卡片正文不进 episode 构建输入）。
    return message.kstar_review_card ? { ...base, kstar_review_card: message.kstar_review_card } : base;
  });
}

/** Subscribe to content-free group terminal events and capture details asynchronously. */
export function startGroupKstarClosure(runtime: GroupKstarClosureRuntime = {}): () => void {
  const subscribe = runtime.subscribe || subscribeTaskTerminals;
  const loadMessages = runtime.readMessages || defaultGroupMessageLoader;
  const capture = runtime.capture || captureGroupKstarClosure;
  const publishReviewCard = runtime.publishReviewCard || defaultReviewCardPublisher;
  const seen = new Set<string>();
  const inFlight = new Set<string>();
  const listener: TaskTerminalListener = (event: TaskTerminalEvent) => {
    const key = `${event.user_id}:${event.run_id}`;
    if (seen.has(key) || inFlight.has(key)) return;
    // 静默窗口自动闭环（设计 §5）：completed 终态立即安排窗口，不等待
    // capture（Commander review 可能耗时）——窗口计时从任务终态起算。
    // cancelled（用户中止）也安排窗口：中止任务不再悬挂——30min 静默后
    // 自动闭环（中止回合 review 证据不足 → 不沉淀，仅关任务）。
    if (event.status === 'completed' || event.status === 'cancelled') {
      void scheduleAutoClose(event.user_id, event.conversation_id);
    }
    const runCapture = async (attempt: number): Promise<void> => {
      inFlight.add(key);
      try {
        const messages = await loadMessages(event.user_id, event.conversation_id, 500);
            const result = await capture({
          userId: event.user_id,
          runId: event.run_id,
          conversationId: event.conversation_id,
          status: event.status,
          startedAtMs: event.started_at_ms,
          finishedAtMs: event.finished_at_ms,
          messages,
          ...(event.logical_run_id ? { logicalRunId: event.logical_run_id } : {}),
          ...(event.task_id ? { taskId: event.task_id } : {}),
          ...(event.requirement_id ? { requirementId: event.requirement_id } : {}),
          ...(event.execution_id ? { executionId: event.execution_id } : {}),
          ...(event.reuse_turn_ids !== undefined ? { reuseTurnIds: event.reuse_turn_ids } : {}),
          ...(event.reuse_turn_ids_truncated ? { reuseTurnIdsTruncated: true } : {}),
          ...(event.projection_id ? { projectionId: event.projection_id } : {}),
          ...(event.forecast_id ? { forecastId: event.forecast_id } : {}),
        });
        // 复盘卡恢复发送（US-704，D11）：capture 完成、review 落盘之后发卡。
        // 只发一次（reviewId 幂等）、只在终态收口且 review 需要确认时发；
        // 发卡失败不改任务/review 状态（见 publishReviewCardOnce）。
        if (shouldPublishReviewCard(event.status, result?.review)) {
          await publishReviewCardOnce(event.user_id, event.conversation_id, result.review, loadMessages, publishReviewCard);
        }
        inFlight.delete(key);
        seen.add(key);
      } catch {
        inFlight.delete(key);
        if (attempt < 1 && !seen.has(key)) {
          setTimeout(() => { void runCapture(attempt + 1); }, 0);
          return;
        }
        log.warn('kstar group terminal capture failed', {
          userId: event.user_id,
          runId: event.run_id,
          conversationId: event.conversation_id,
          errorCode: 'group_capture_failed',
        });
        void recordKstarFailure(event.user_id, {
          stage: 'capture', errorCode: 'group_capture_failed',
          errorMessage: 'KSTAR group terminal capture failed after retry.', conversationId: event.conversation_id,
          operationKey: `capture-${event.run_id}`, episodeId: `kse-${event.run_id}`,
        }).catch(() => undefined);
      }
    };
    void runCapture(0);
  };
  const unsubscribe = subscribe(listener);
  return () => {
    unsubscribe();
    seen.clear();
    inFlight.clear();
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 静默窗口自动闭环（设计 §5）：任务终态后启动窗口，窗口内无新用户消息 →
// 自动 finish（沉淀）。用户消息到达 → 清除（见 bus.ts 的 cancel 钩子）。
// 重启恢复：startAutoCloseRecovery 扫描 task-state 中未过期且仍 open 的
// pendingAutoCloseAt，按剩余时间重建定时器。
// ──────────────────────────────────────────────────────────────────────────

/** 静默窗口默认时长：30 分钟（任务级闭环，不宜过短——OQ-7 可校准）。 */
export const AUTO_CLOSE_QUIET_MS = 30 * 60 * 1_000;

/** 测试注入：缩短窗口。 */
let _autoCloseQuietMsOverride: number | undefined;
export function _setAutoCloseQuietMsForTest(ms: number | undefined): void {
  _autoCloseQuietMsOverride = ms;
}

function autoCloseQuietMs(): number {
  return _autoCloseQuietMsOverride ?? AUTO_CLOSE_QUIET_MS;
}

/** 运行时到期定时器：key = userId:conversationId。
 *  终端调度时按剩余时间 arm；用户消息到达时清除；重启由 recovery 重建。
 *  （旧实现只在 boot 时 setTimeout(0) 检查一次，runAutoClose 未到期时仅
 *  重写 state 不建 timer——窗口到期永远不触发，只能靠下次重启补跑。） */
const autoCloseTimers = new Map<string, NodeJS.Timeout>();

function autoCloseKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function clearAutoCloseTimer(key: string): void {
  const timer = autoCloseTimers.get(key);
  if (timer) clearTimeout(timer);
  autoCloseTimers.delete(key);
}

function armAutoCloseTimer(userId: string, conversationId: string, atMs: number): void {
  const key = autoCloseKey(userId, conversationId);
  clearAutoCloseTimer(key);
  const timer = setTimeout(() => {
    autoCloseTimers.delete(key);
    void runAutoClose(userId, conversationId);
  }, Math.max(0, atMs - Date.now()));
  autoCloseTimers.set(key, timer);
}

/** 在任务终态（completed run）后安排自动闭环。幂等：已有 pending 不重复；
 *  但每次都会按剩余时间重建运行时定时器（防 timer 丢失）。 */
export async function scheduleAutoClose(
  userId: string,
  conversationId: string,
): Promise<{ scheduled: boolean; at?: string }> {
  try {
    const { readConversationTaskState, replaceConversationTaskState } = await import('./requirement-store');
    const state = await readConversationTaskState(userId, conversationId);
    if (!state?.currentTaskId || !state.currentRequirementId) return { scheduled: false };
    if (state.taskComplete) return { scheduled: false }; // already closed
    if (state.pendingAutoCloseAt) {
      // 幂等：窗口已存在。重建定时器（可能在 cancel 后被重新调度时丢失）。
      armAutoCloseTimer(userId, conversationId, Date.parse(state.pendingAutoCloseAt));
      return { scheduled: true, at: state.pendingAutoCloseAt };
    }
    const at = new Date(Date.now() + autoCloseQuietMs()).toISOString();
    await replaceConversationTaskState(userId, {
      ...state,
      pendingAutoCloseAt: at,
      updatedAt: new Date().toISOString(),
    });
    armAutoCloseTimer(userId, conversationId, Date.parse(at));
    return { scheduled: true, at };
  } catch (error) {
    log.warn('kstar auto-close schedule degraded', {
      userId,
      conversationId,
      error: (error as Error).message,
    });
    return { scheduled: false };
  }
}

/** 用户新消息到达时清除 pending 自动闭环（由 bus enqueue 调用）。 */
export async function cancelAutoClose(
  userId: string,
  conversationId: string,
): Promise<void> {
  const key = autoCloseKey(userId, conversationId);
  clearAutoCloseTimer(key);
  try {
    const { readConversationTaskState, replaceConversationTaskState } = await import('./requirement-store');
    const state = await readConversationTaskState(userId, conversationId);
    if (!state?.pendingAutoCloseAt) return;
    await replaceConversationTaskState(userId, {
      ...state,
      pendingAutoCloseAt: undefined,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    log.warn('kstar auto-close cancel degraded', {
      userId,
      conversationId,
      error: (error as Error).message,
    });
  }
}

/** 执行自动闭环：走 finish 控制路径（沉淀在 finish 内）。幂等。 */
export async function runAutoClose(
  userId: string,
  conversationId: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { readConversationTaskState } = await import('./requirement-store');
    const state = await readConversationTaskState(userId, conversationId);
    if (!state?.pendingAutoCloseAt) return { ok: false, reason: 'no pending auto-close' };
    if (state.taskComplete) return { ok: false, reason: 'already closed' };
    // 到期校验：窗口必须真的过了（重启恢复的定时器按剩余时间，仍可能早触发）。
    if (Date.parse(state.pendingAutoCloseAt) <= Date.now()) {
      const { executeKstarControl } = await import('./control-service');
      await executeKstarControl({ userId, conversationId, allowedToolNames: new Set(['kstar_control']) }, {
        operation: 'finish',
        idempotencyKey: `auto-close-${conversationId}-${state.currentRequirementId}`,
        result: {
          finalStatus: 'completed',
          finalText: 'Auto-closed after a quiet period (no further user input).',
          producedFiles: [],
          acceptanceEvidence: [],
          closeReason: 'auto_close_quiet',
        },
      }).catch(() => undefined);
      clearAutoCloseTimer(autoCloseKey(userId, conversationId));
      return { ok: true };
    }
    // 窗口未到期（恢复定时器早触发）：按剩余时间重建。
    const { scheduleAutoClose: reschedule } = await import('./task-closure');
    await reschedule(userId, conversationId);
    return { ok: false, reason: 'window not expired yet' };
  } catch (error) {
    log.warn('kstar auto-close run degraded', {
      userId,
      conversationId,
      error: (error as Error).message,
    });
    return { ok: false, reason: (error as Error).message };
  }
}

/** 启动时恢复：扫描当前激活用户的 task-states，为未过期的 pendingAutoCloseAt
 *  按剩余时间重建运行时定时器；已过期的直接跑 auto-close。 */
export function startAutoCloseRecovery(
  runtime: { scan?: () => Promise<Array<{ userId: string; conversationId: string }>> } = {},
): () => void {
  const scan = runtime.scan || (async () => {
    try {
      const { listKstarJsonRecords } = await import('./episode-store');
      const { getActiveUserId } = await import('../users');
      const userId = getActiveUserId();
      const records = await listKstarJsonRecords(userId, 'task-states');
      return records.map((r) => ({ userId, conversationId: r.id }));
    } catch {
      return [];
    }
  });
  void scan().then((entries) => {
    for (const entry of entries) {
      void (async () => {
        try {
          const { readConversationTaskState } = await import('./requirement-store');
          const state = await readConversationTaskState(entry.userId, entry.conversationId);
          if (!state?.pendingAutoCloseAt || state.taskComplete) return;
          const atMs = Date.parse(state.pendingAutoCloseAt);
          if (atMs <= Date.now()) {
            void runAutoClose(entry.userId, entry.conversationId);
          } else {
            armAutoCloseTimer(entry.userId, entry.conversationId, atMs);
          }
        } catch {
          // degraded state → skip; a later boot re-scans.
        }
      })();
    }
  }).catch((error) => {
    log.warn('kstar auto-close recovery scan degraded', { error: (error as Error).message });
  });
  return () => {
    for (const timer of autoCloseTimers.values()) clearTimeout(timer);
    autoCloseTimers.clear();
  };
}
