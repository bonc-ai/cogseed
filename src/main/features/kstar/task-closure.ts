import { createLogger } from '../../logger';
import { subscribeTaskTerminals, type TaskTerminalEvent, type TaskTerminalListener } from '../group_chat/bus';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../mate_agent_runtime/protocol';
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
import { inferKstarReview, type KstarReviewInferenceResult } from './review-inference';
import { postKstarReviewCard } from './review-card';
import type { KstarEpisodeRecord, KstarExtractionRunRecord, KstarReviewRecord } from './types';

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

export type KstarReviewInfer = (userId: string, episode: KstarEpisodeRecord) => Promise<KstarReviewInferenceResult>;

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
    !['created', 'partial', 'failed'].includes(String(raw.status)) ||
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
  bridge: KstarCandidateBridge = saveKstarCandidateProposals,
): Promise<KstarClosureResult> {
  const proposals = proposeKstarCandidates(episode, review);
  const extractionRunId = `ksx-${episode.id}`;
  let existingRun: KstarExtractionRunRecord | null = null;
  try {
    const raw = await readKstarJsonRecord(userId, 'extraction-runs', extractionRunId);
    existingRun = raw ? validExtractionRun(userId, episode.id, review.id, extractionRunId, raw) : null;
  } catch {
    // A malformed/future synced run is rebuilt below with the current schema.
  }
  if (existingRun?.status === 'created') {
    const existingCandidates = await (await import('../recall/candidate-service')).listRecallCandidates(userId);
    const candidatesBelongToEpisode = existingRun.candidateIds.every((id) => existingCandidates.some((candidate) =>
      candidate.id === id && candidate.sourceRefs.some((ref) => ref.kind === 'execution' && ref.id === episode.id)));
    const candidateSetComplete = proposals.length === existingRun.candidateIds.length;
    if (candidateSetComplete && candidatesBelongToEpisode) {
      return {
        episode,
        review,
        candidates: existingCandidates.filter((candidate) => existingRun!.candidateIds.includes(candidate.id)),
        extractionRun: existingRun,
      };
    }
  }

  let candidates: RecallCandidateRecord[] = [];
  let status: KstarExtractionRunRecord['status'] = 'created';
  let errorCode: string | undefined;
  try {
    candidates = proposals.length ? await bridge(userId, proposals) : [];
  } catch {
    status = 'failed';
    errorCode = 'candidate_bridge_failed';
    log.warn('kstar candidate extraction degraded', { userId, episodeId: episode.id, errorCode });
  }
  const extractionRun: KstarExtractionRunRecord = {
    schemaVersion: 1,
    ownerId: userId,
    id: extractionRunId,
    episodeId: episode.id,
    reviewId: review.id,
    candidateIds: candidates.map((candidate) => candidate.id),
    status,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
    ...(errorCode ? { error: errorCode } : {}),
  };
  await replaceKstarJsonRecord(userId, 'extraction-runs', extractionRun);
  return { episode, review, candidates, extractionRun };
}

async function finishClosure(
  userId: string,
  episode: KstarEpisodeRecord,
  bridge: KstarCandidateBridge = saveKstarCandidateProposals,
  inferReview: KstarReviewInfer = inferKstarReview,
): Promise<KstarClosureResult> {
  await writeKstarEpisode(userId, episode);
  let storedReview: KstarReviewRecord | null = null;
  try {
    storedReview = await readKstarReview(userId, episode.id);
  } catch {
    // A malformed synced review is degraded; replace it with a conservative review.
  }
  let review = storedReview;
  if (!review) {
    try {
      const inferred = await inferReview(userId, episode);
      review = await saveKstarReview(userId, episode, {
        ...inferred.review,
        reviewState: inferred.reviewState,
        inferenceMethod: inferred.inferenceMethod,
        needsConfirmation: inferred.needsConfirmation,
      });
    } catch {
      review = await saveKstarReviewRecord(userId, createInitialKstarReview(episode));
    }
  }
  return reconcileKstarExtraction(userId, episode, review, bridge);
}

export type KstarReviewVerdict = 'met' | 'partial' | 'not_met' | 'skip';
export interface ConfirmKstarReviewInput {
  verdict: KstarReviewVerdict;
  actualResult?: string;
  reason?: string;
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
    return reconcileKstarExtraction(userId, episode, review, bridge);
  });
}

export async function captureRuntimeKstarClosure(input: RuntimeKstarClosureInput): Promise<KstarClosureResult> {
  const episode = buildRuntimeKstarEpisode(input);
  return serializeClosure(closureLocks, `${input.userId}:${episode.id}`, () => finishClosure(input.userId, episode, input.bridge, input.inferReview));
}

export async function captureGroupKstarClosure(input: GroupKstarClosureInput): Promise<KstarClosureResult> {
  const episode = buildGroupKstarEpisode(input);
  const result = await serializeClosure(closureLocks, `${input.userId}:${episode.id}`, () => finishClosure(input.userId, episode, input.bridge, input.inferReview));
  try {
    const { attachKstarEpisodeToCurrentRequirement } = await import('./requirement-state');
    await attachKstarEpisodeToCurrentRequirement(input.userId, {
      conversationId: input.conversationId,
      episodeId: episode.id,
      ...(input.projectionId ? { projectionId: input.projectionId } : {}),
      ...(input.wakeRequestId ? { wakeRequestId: input.wakeRequestId } : {}),
    });
  } catch (error) {
    log.warn('kstar requirement episode attachment degraded', {
      userId: input.userId,
      episodeId: episode.id,
      error: (error as Error).message,
    });
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
export type GroupKstarMessageLoader = (userId: string, conversationId: string, limit: number) => Promise<GroupKstarMessageInput[]>;
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

async function defaultGroupMessageLoader(userId: string, conversationId: string, limit: number): Promise<GroupKstarMessageInput[]> {
  const groupChat = await import('../group_chat');
  const messages = await groupChat.readMessages(userId, conversationId, limit);
  return messages.map((message) => ({
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
  }));
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
          ...(event.execution_id ? { executionId: event.execution_id } : {}),
          ...(event.projection_id ? { projectionId: event.projection_id } : {}),
        });
        if (event.status === 'completed' && result?.review?.needsConfirmation) {
          await publishReviewCard(event.user_id, event.conversation_id, result.review);
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
