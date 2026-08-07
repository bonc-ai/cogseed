import { createLogger } from '../../logger';
import { subscribeTaskTerminals, type TaskTerminalEvent, type TaskTerminalListener } from '../group_chat/bus';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../mate_agent_runtime/protocol';
import type { RecallCandidateRecord } from '../recall/candidate-service';
import {
  readKstarJsonRecord,
  replaceKstarJsonRecord,
  writeKstarEpisode,
} from './episode-store';
import { buildGroupKstarEpisode, buildRuntimeKstarEpisode, type GroupKstarEpisodeInput, type GroupKstarMessageInput, type RuntimeKstarEpisodeInput } from './episode-builder';
import { proposeKstarCandidates } from './extraction-service';
import { saveKstarCandidateProposals } from './recall-bridge';
import { createInitialKstarReview, readKstarReview, saveKstarReviewRecord } from './review-service';
import type { KstarEpisodeRecord, KstarExtractionRunRecord, KstarReviewRecord } from './types';

const log = createLogger('kstar.task-closure');
const closureLocks = new Map<string, Promise<KstarClosureResult>>();

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

export interface RuntimeKstarClosureInput extends RuntimeKstarEpisodeInput {
  bridge?: KstarCandidateBridge;
}

export interface GroupKstarClosureInput extends GroupKstarEpisodeInput {
  bridge?: KstarCandidateBridge;
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

function serializeClosure(key: string, task: () => Promise<KstarClosureResult>): Promise<KstarClosureResult> {
  const previous = closureLocks.get(key) || Promise.resolve(undefined as unknown as KstarClosureResult);
  const current = previous.catch(() => undefined as unknown as KstarClosureResult).then(task);
  closureLocks.set(key, current);
  void current.then(
    () => { if (closureLocks.get(key) === current) closureLocks.delete(key); },
    () => { if (closureLocks.get(key) === current) closureLocks.delete(key); },
  );
  return current;
}

async function finishClosure(
  userId: string,
  episode: KstarEpisodeRecord,
  bridge: KstarCandidateBridge = saveKstarCandidateProposals,
): Promise<KstarClosureResult> {
  await writeKstarEpisode(userId, episode);
  let storedReview: KstarReviewRecord | null = null;
  try {
    storedReview = await readKstarReview(userId, episode.id);
  } catch {
    // A malformed synced review is degraded; replace it with a conservative review.
  }
  const review = storedReview || await saveKstarReviewRecord(userId, createInitialKstarReview(episode));
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

export async function captureRuntimeKstarClosure(input: RuntimeKstarClosureInput): Promise<KstarClosureResult> {
  const episode = buildRuntimeKstarEpisode(input);
  return serializeClosure(`${input.userId}:${episode.id}`, () => finishClosure(input.userId, episode, input.bridge));
}

export async function captureGroupKstarClosure(input: GroupKstarClosureInput): Promise<KstarClosureResult> {
  const episode = buildGroupKstarEpisode(input);
  return serializeClosure(`${input.userId}:${episode.id}`, () => finishClosure(input.userId, episode, input.bridge));
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

export interface GroupKstarClosureRuntime {
  subscribe?: GroupKstarTerminalSubscribe;
  readMessages?: GroupKstarMessageLoader;
  capture?: (input: GroupKstarClosureInput) => Promise<KstarClosureResult>;
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
  }));
}

/** Subscribe to content-free group terminal events and capture details asynchronously. */
export function startGroupKstarClosure(runtime: GroupKstarClosureRuntime = {}): () => void {
  const subscribe = runtime.subscribe || subscribeTaskTerminals;
  const loadMessages = runtime.readMessages || defaultGroupMessageLoader;
  const capture = runtime.capture || captureGroupKstarClosure;
  const seen = new Set<string>();
  const inFlight = new Set<string>();
  const listener: TaskTerminalListener = (event: TaskTerminalEvent) => {
    const key = `${event.user_id}:${event.run_id}`;
    if (seen.has(key) || inFlight.has(key)) return;
    const runCapture = async (attempt: number): Promise<void> => {
      inFlight.add(key);
      try {
        const messages = await loadMessages(event.user_id, event.conversation_id, 500);
        await capture({
          userId: event.user_id,
          runId: event.run_id,
          conversationId: event.conversation_id,
          status: event.status,
          startedAtMs: event.started_at_ms,
          finishedAtMs: event.finished_at_ms,
          messages,
        });
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
