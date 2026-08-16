import { createLogger } from '../../logger';
import { nowIso } from '../../storage';
import { normalizeCognitionSourceRefs, type CognitionSourceRef } from '../recall/source-service';
import { subscribeTaskTerminals, type TaskTerminalEvent, type TaskTerminalListener } from '../group_chat/bus';
import type { RuntimeEventEnvelope, RuntimeRunRequest } from '../cogseed_runtime/protocol';
import type { RecallCandidateRecord } from '../recall/candidate-service';
import {
  readKstarEpisode,
  readKstarJsonRecord,
  replaceKstarJsonRecord,
  writeKstarEpisode,
} from './episode-store';
import { buildGroupKstarEpisode, buildRuntimeKstarEpisode, type GroupKstarEpisodeInput, type GroupKstarMessageInput, type RuntimeKstarEpisodeInput } from './episode-builder';
import { createInitialKstarReview, readKstarReview, saveKstarReview, saveKstarReviewRecord } from './review-service';
import { inferKstarReview, type KstarReviewInferenceResult } from './review-inference';
import { parseKstarReviewInference } from './review-inference';
import { postKstarReviewCard } from './review-card';
import type { KstarEpisodeRecord, KstarExtractionRunRecord, KstarReviewRecord } from './types';
import { readConversationTaskState, readKstarRequirement } from './requirement-store';

const log = createLogger('kstar.task-closure');
const closureLocks = new Map<string, Promise<KstarClosureResult>>();
const confirmationLocks = new Map<string, Promise<KstarClosureResult>>();

export interface KstarClosureResult {
  episode: KstarEpisodeRecord;
  review: KstarReviewRecord;
  candidates: RecallCandidateRecord[];
  extractionRun: KstarExtractionRunRecord;
}

export type KstarReviewInfer = (userId: string, episode: KstarEpisodeRecord) => Promise<KstarReviewInferenceResult>;

// 这里曾有一个可注入的 candidate bridge。per-run closure 改成 review-only 之后
// （reconcileKstarExtraction 不再产候选，沉淀只发生在任务闭环边界），它就再也
// 没有被调用过——函数体传的是三参 reconcileKstarExtraction。留着只会让调用方
// 以为还能从这里换掉沉淀出口。需求级沉淀的注入点在 task-aggregate 的
// `candidateBridge` 与 task-level-precipitation 的 `candidateBridge`。

export interface RuntimeKstarClosureInput extends RuntimeKstarEpisodeInput {
  inferReview?: KstarReviewInfer;
}

export interface GroupKstarClosureInput extends GroupKstarEpisodeInput {
  inferReview?: KstarReviewInfer;
  /** Bounded wait for the Commander's in-context review reply. Tests inject
   *  a small value; production defaults to COMMANDER_REVIEW_TIMEOUT_MS. */
  commanderReviewTimeoutMs?: number;
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

/** Extract a Commander-authored review from a `<kstar-review>{...}</kstar-review>`
 *  block inside a message stream (the Commander replies in-context). Returns
 *  the parsed review fields or null when absent/malformed. */
export function parseCommanderReviewFromMessages(messages: GroupKstarMessageInput[]): ParsedReviewFromCommander | null {
  for (const message of messages) {
    const text = String(message.text || '');
    const match = text.match(/<kstar-review>([\s\S]*?)<\/kstar-review>/);
    if (!match) continue;
    try {
      const parsed = parseKstarReviewInference(match[1].trim());
      return {
        deltaR: parsed.deltaR,
        deltaA: parsed.deltaA,
        outcome: parsed.outcome,
        attribution: parsed.attribution,
        reason: parsed.reason,
        confidence: parsed.confidence,
        ...(parsed.lesson ? { lesson: parsed.lesson } : {}),
      };
    } catch (error) {
      log.warn('kstar commander review block malformed', {
        episodeId: message.id,
        error: (error as Error).message,
      });
    }
  }
  return null;
}

export interface ParsedReviewFromCommander {
  deltaR: number | 'unknown';
  deltaA: number | 'unknown';
  outcome: KstarReviewRecord['outcome'];
  attribution: KstarReviewRecord['attribution'];
  reason: string;
  confidence: number;
  lesson?: string;
}

/** Default ceiling for waiting on the Commander's in-context review reply.
 *  The reply is one extra LLM round in the SAME conversation; 120s covers
 *  a normal round plus scheduling slack. Tests inject a tiny timeout. */
export const COMMANDER_REVIEW_TIMEOUT_MS = 120_000;

/** Ask the Commander — in its own conversation, with FULL context — to
 *  produce the expected-vs-actual review for a finished episode, and wait
 *  (bounded) for the `<kstar-review>` reply. Returns the parsed review, or
 *  null on timeout / enqueue failure — the caller then falls back to
 *  host-side inference so precipitation is never blocked forever. */
export async function awaitCommanderReview(
  userId: string,
  conversationId: string,
  episode: KstarEpisodeRecord,
  evidence: Record<string, unknown>,
  timeoutMs: number = COMMANDER_REVIEW_TIMEOUT_MS,
): Promise<ParsedReviewFromCommander | null> {
  try {
    const bus = await import('../group_chat/bus');
    const unsubscribe = bus.subscribe(userId, conversationId, (event) => {
      if (event.type !== 'message') return;
      const text = String(event.msg?.text || '');
      if (!text.includes('<kstar-review>')) return;
      const parsed = parseCommanderReviewFromMessages([{ id: event.msg.id, ts: event.msg.ts, from: event.msg.from, text }]);
      if (parsed) resolve(parsed);
    });
    let resolve: (value: ParsedReviewFromCommander | null) => void;
    let settled = false;
    const done = new Promise<ParsedReviewFromCommander | null>((res) => { resolve = res; });
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(null); }
    }, Math.max(1, Number(timeoutMs) || COMMANDER_REVIEW_TIMEOUT_MS));
    try {
      await bus.enqueueCommanderControlMessage({
        userId,
        cid: conversationId,
        displayText: '',
        control: { type: 'kstar_review_request', episodeId: episode.id, evidence },
      });
    } catch (error) {
      log.warn('kstar commander review request enqueue degraded', {
        userId, episodeId: episode.id, error: (error as Error).message,
      });
      clearTimeout(timer);
      unsubscribe();
      return null;
    }
    const parsed = await done;
    clearTimeout(timer);
    unsubscribe();
    return parsed;
  } catch (error) {
    log.warn('kstar commander review wait degraded', {
      userId, episodeId: episode.id, error: (error as Error).message,
    });
    return null;
  }
}

async function finishClosure(
  userId: string,
  episode: KstarEpisodeRecord,
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
  return reconcileKstarExtraction(userId, episode, review);
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
): Promise<KstarClosureResult> {
  return serializeClosure(confirmationLocks, `${userId}:${episodeId}`, async () => {
    const episode = await readKstarEpisode(userId, episodeId);
    if (!episode) throw new Error('kstar episode not found');
    const current = await readKstarReview(userId, episodeId);
    if (!current) throw new Error('kstar review not found');
    const review = await saveKstarReview(userId, episode, confirmationReviewInput(episode, current, input));
    return reconcileKstarExtraction(userId, episode, review);
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
): Promise<KstarEpisodeRecord> {
  try {
    const state = await readConversationTaskState(userId, conversationId);
    const requirement = state?.currentRequirementId
      ? await readKstarRequirement(userId, state.currentRequirementId)
      : null;
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
  return serializeClosure(closureLocks, `${input.userId}:${episode.id}`, () => finishClosure(input.userId, episode, input.inferReview));
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
  const episode = await enrichEpisodeFromRequirementEvidence(input.userId, input.conversationId, built);
  // Commander-in-context review (self-evolution): ask the Commander — with its
  // full conversation context — to produce the expected-vs-actual review. The
  // reply (a <kstar-review> block) is picked up by a later closure pass; until
  // then finishClosure falls back to host-side inference so precipitation is
  // never blocked. Request enqueue is best-effort.
  // Commander-in-context review (self-evolution, SYNCHRONOUS): ask the
  // Commander — with its full conversation context — to produce the
  // expected-vs-actual review and WAIT (bounded) for the <kstar-review>
  // reply. The Commander-authored review drives precipitation; host-side
  // inference is the timeout fallback so a silent Commander never blocks
  // the line forever.
  const commanderReview = input.conversationId
    ? await awaitCommanderReview(input.userId, input.conversationId, episode, {
        episode: {
          id: episode.id,
          status: episode.r.status,
          task: episode.t.userGoal,
          toolCalls: episode.a.toolCalls.map((call) => ({ name: call.name, status: call.status })),
          producedFiles: (episode.r.producedFiles || []).slice(0, 20),
          finalText: episode.r.finalText,
          verification: episode.r.verification,
        },
        evidenceKinds: [...new Set(episode.evidenceRefs.map((ref) => ref.kind))],
      }, input.commanderReviewTimeoutMs)
    : null;
  const result = await serializeClosure(closureLocks, `${input.userId}:${episode.id}`, async () => {
    if (commanderReview) {
      const now = nowIso();
      await saveKstarReviewRecord(input.userId, {
        schemaVersion: 1,
        ownerId: input.userId,
        id: `ksr-${episode.id}`,
        episodeId: episode.id,
        deltaR: commanderReview.deltaR,
        deltaA: commanderReview.deltaA,
        outcome: commanderReview.outcome,
        attribution: commanderReview.attribution,
        reason: commanderReview.reason,
        confidence: commanderReview.confidence,
        ...(commanderReview.lesson ? { lesson: commanderReview.lesson } : {}),
        reviewState: 'inferred',
        inferenceMethod: 'commander',
        needsConfirmation: false,
        evidenceRefs: episode.evidenceRefs,
        createdAt: now,
        updatedAt: now,
      });
    }
    return finishClosure(input.userId, episode, input.inferReview);
  });
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
    ...(message.process ? { process: message.process.slice(0, 300) } : {}),
    ...(message.recall_citations ? { recall_citations: message.recall_citations.slice(0, 12).map((citation) => ({
      asset_id: citation.asset_id,
      version: citation.version,
      projection_id: citation.projection_id,
      ...(citation.forecast_id ? { forecast_id: citation.forecast_id } : {}),
    })) } : {}),
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
    // 静默窗口自动闭环（设计 §5）：completed 终态立即安排窗口，不等待
    // capture（Commander review 可能耗时）——窗口计时从任务终态起算。
    if (event.status === 'completed') {
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
          ...(event.execution_id ? { executionId: event.execution_id } : {}),
          ...(event.projection_id ? { projectionId: event.projection_id } : {}),
          ...(event.forecast_id ? { forecastId: event.forecast_id } : {}),
        });
        // Self-evolution is Agent-implemented: the review is automatically
        // precipitated (direct ability-asset line) without asking the user to
        // confirm the expected-vs-actual comparison — the user neither made
        // the prediction nor observes the execution internals, so they cannot
        // verify it. No review card is posted.
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

// ──────────────────────────────────────────────────────────────────────────
// 静默窗口自动闭环（设计 §5）：任务终态后启动窗口，窗口内无新用户消息 →
// 自动 finish（沉淀）。用户消息到达 → 清除（见 bus.ts 的 cancel 钩子）。
// 重启恢复：recoverPendingAutoClosures 扫描 task-state 中未过期且仍 open 的
// pendingAutoCloseAt，重建定时器（剩余时间）。
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

/** 在任务终态（completed run）后安排自动闭环。幂等：已有 pending 不重复。 */
export async function scheduleAutoClose(
  userId: string,
  conversationId: string,
): Promise<{ scheduled: boolean; at?: string }> {
  try {
    const { readConversationTaskState, replaceConversationTaskState } = await import('./requirement-store');
    const state = await readConversationTaskState(userId, conversationId);
    if (!state?.currentTaskId || !state.currentRequirementId) return { scheduled: false };
    if (state.taskComplete) return { scheduled: false }; // already closed
    if (state.pendingAutoCloseAt) return { scheduled: true, at: state.pendingAutoCloseAt }; // idempotent
    const at = new Date(Date.now() + autoCloseQuietMs()).toISOString();
    await replaceConversationTaskState(userId, {
      ...state,
      pendingAutoCloseAt: at,
      updatedAt: new Date().toISOString(),
    });
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

/** 启动时恢复：扫描当前激活用户的 task-states，重建未过期的自动闭环定时器。
 *  返回恢复的数量。由 bus 启动路径调用。 */
export function startAutoCloseRecovery(
  runtime: { scan?: () => Promise<Array<{ userId: string; conversationId: string }>> } = {},
): () => void {
  const timers = new Set<NodeJS.Timeout>();
  const scheduleOne = (userId: string, conversationId: string): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      void runAutoClose(userId, conversationId);
    }, 0);
    timers.add(timer);
  };
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
      scheduleOne(entry.userId, entry.conversationId);
    }
  }).catch((error) => {
    log.warn('kstar auto-close recovery scan degraded', { error: (error as Error).message });
  });
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
