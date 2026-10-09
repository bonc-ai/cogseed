/**
 * Group-chat facade — IPC layer talks only to this module.
 *
 * Responsibilities:
 *   - Send a user message (router @ + bus enqueue + UI event stream)
 *   - Subscribe to event stream (single async generator IPC handler)
 *   - List members / read plan / mark form submitted
 *   - Abort group + drop on conv delete
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  conversationLayout,
  conversationMessageFile,
  conversationMessageReadFile,
} from '../../util/project-layout';
import { readJson, readJsonl, rewriteJsonlLine, rewriteJsonlRecords, genId12, nowIso, safeId, writeJson } from '../../storage';
import { createLogger } from '../../logger';
import type { P3394Envelope } from '../p3394_bridge/envelope';
import { t } from '../../i18n';
import { logErrorRef } from '../../util/log-redact';
import { fileEditLock } from '../../util/locks';
import { cogSeedRequestFingerprint } from '../cogseed_backend/request-fingerprint';

import {
  COMMANDER_ID, USER_ID, RESERVED_IDS, readMembers, readState, seedReservedActors, purgeGroupDir,
  setCodingProjectDir, setStatus, actorSessionId, resetConversationRoutingState,
} from './state';
import { isPlaceholderTitle } from './conv_title';
import {
  abort as busAbort, dropConv as busDropConv, enqueue, subscribe, isQuiescent, runtimeSnapshot,
  classifyRecipientRuntimes, recoverPersistedUserDispatch, reconcileMemberRun,
  type GroupEvent,
  type AbortRunOptions,
} from './bus';
import {
  readActiveCollaborationSnapshot,
  readCollaborationSnapshot,
  clearActiveCollaborationState,
  resolveActiveContextConflictForActor,
  reviewCollaborationGate as reviewGateFeature,
  type CollaborationSnapshot,
  type ResolveContextConflictSelectionInput,
} from './collaboration';
import { buildRetryResumeModelText } from './retry_resume';
import { detectSequentialIntent, shouldDeferToCommanderForOrder } from './member_scope';
import type { KstarTaskLifecycleSnapshot } from '../kstar/lifecycle-adapter';

/** Re-export so the IPC layer can poll the bus's true quiescent state on
 *  every state_changed event — the on-disk state.json briefly shows 'idle'
 *  in the microtask gap between turns; the bus's in-memory queues are the
 *  authoritative source. */
export const busIsQuiescent = isQuiescent;

/** Re-export so the IPC stream layer can synthesise a final idle
 *  `state_changed` snapshot before closing a stream (safety fuse in
 *  ipc/index.ts). The renderer clears its "replying" flag only on a
 *  non-running snapshot; if the stream closes first, the UI stays stuck
 *  in replying mode and queued messages never drain. */
export { readState };

export interface GroupChatRuntimeStatus {
  processing: boolean;
  processing_since: string | null;
  in_flight: string[];
  active_turns: Array<{ actor: string; turn_id: string; msg_id?: string; started_at_ms: number }>;
  active_recipient?: string;
  /** True while a CogSeed Backend (Mate / local-CLI) task for this
   *  conversation is still executing. Backend tasks run OUTSIDE the
   *  group-chat bus, so without this the renderer's liveness model would
   *  treat a bus-quiescent conversation as idle and finalize the run early. */
  backend_active?: boolean;
  collaboration?: CollaborationSnapshot;
  kstarLifecycle?: KstarTaskLifecycleSnapshot;
}

export async function reviewCollaborationGate(
  userId: string,
  cid: string,
  gateId: string,
  input: { decision: 'approve' | 'reject'; reviewed_by?: string; reason?: string },
): Promise<{ ok: true; collaboration: CollaborationSnapshot | null }> {
  if (!safeId(cid)) throw new Error('invalid cid');
  if (!safeId(gateId)) throw new Error('invalid gate id');
  if (input.decision !== 'approve' && input.decision !== 'reject') throw new Error('invalid gate review decision');
  const reviewed = await reviewGateFeature(userId, cid, gateId, {
    decision: input.decision,
    reviewed_by: input.reviewed_by || 'user',
    ...(typeof input.reason === 'string' && input.reason.trim() ? { reason: input.reason.trim() } : {}),
  });
  const collaboration = reviewed.collaboration;
  if (input.decision === 'approve') {
    await enqueue({
      uid: userId,
      cid,
      fromActorId: USER_ID,
      text: 'Continue workflow',
      model_text: [
        '<collaboration-gate-resume>',
        `Gate approved: ${reviewed.gate.name}`,
        `Gate id: ${reviewed.gate.id}`,
        `Workflow run id: ${reviewed.run.id}`,
        'Continue the workflow from the shared task context. Do not repeat completed steps; choose the next unblocked step or explain if nothing remains.',
        '</collaboration-gate-resume>',
      ].join('\n'),
      forceTo: [COMMANDER_ID],
    });
  }
  return { ok: true, collaboration };
}

export async function listCollaborationConflicts(userId: string, cid: string) {
  if (!safeId(cid)) throw new Error('invalid cid');
  const collaboration = await readActiveCollaborationSnapshot(userId, cid);
  return {
    ok: true as const,
    conflicts: collaboration?.active_conflicts || [],
  };
}

export async function resolveCollaborationConflict(
  userId: string,
  cid: string,
  conflictId: string,
  input: ResolveContextConflictSelectionInput,
): Promise<{ ok: true; collaboration: CollaborationSnapshot | null }> {
  return resolveCollaborationConflictForActor(userId, cid, conflictId, input, USER_ID);
}

export async function resolveCollaborationConflictForActor(
  userId: string,
  cid: string,
  conflictId: string,
  input: ResolveContextConflictSelectionInput,
  resolvedBy: string,
): Promise<{ ok: true; collaboration: CollaborationSnapshot | null }> {
  if (!safeId(cid)) throw new Error('invalid cid');
  if (!safeId(conflictId)) throw new Error('invalid conflict id');
  if (!input || typeof input !== 'object') throw new Error('invalid conflict resolution input');
  const { decision, selected_proposal_ids, text, reason } = input;
  const resolved = await resolveActiveContextConflictForActor(userId, cid, conflictId, {
    decision,
    selected_proposal_ids,
    text,
    ...(typeof reason === 'string' ? { reason } : {}),
  }, resolvedBy);
  return { ok: true, collaboration: resolved.collaboration };
}

export async function runtimeStatus(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<GroupChatRuntimeStatus> {
  if (!safeId(cid)) return { processing: false, processing_since: null, in_flight: [], active_turns: [], backend_active: false };
  try {
    const state = await readState(userId, cid, projectIdHint);
    // Commander-centric KStar: recover legacy pending projection dispatch
    // states (forecasting / world_model_failed / ready_to_dispatch) exactly
    // once into the same Commander session. waiting_confirmation is left for
    // the user card; the service is idempotent and never launches a runner.
    if (state.pending_projection_dispatch) {
      void import('../kstar/projection-decision-service')
        .then((module) => module.recoverLegacyPendingProjectionDispatch(userId, cid))
        .catch((err) => log.warn(`kstar legacy pending recovery failed user=${userId} cid=${cid}: ${(err as Error).message}`));
    }
    const runtime = runtimeSnapshot(userId, cid);
    const diskInFlight = Array.isArray(state.in_flight)
      ? state.in_flight.filter(Boolean)
      : [];
    // CogSeed Backend (Mate / local-CLI) tasks run OUTSIDE the group-chat
    // bus: while one is active for this conversation the bus can be quiescent
    // even though the turn is still executing (imported-session continuation
    // dispatches long work there). This endpoint feeds the renderer's
    // liveness model (`/runtime` polling + history `processing`), so surface
    // backend tasks here or the UI finalizes the run prematurely, drops the
    // running indicator, and never rediscovers the in-flight turn.
    let backendActive = false;
    let backendAgents: string[] = [];
    let backendTurns: Array<{ actor: string; turn_id: string; started_at_ms: number }> = [];
    try {
      const { listCogSeedTasks } = await import('../cogseed_backend/task-store');
      const { isCogSeedTaskExecutingStatus } = await import('../cogseed_backend/lifecycle');
      const tasks = await listCogSeedTasks(userId);
      // 只认「执行中」（created/queued/running）。此前按"非终态"黑名单过滤，
      // 把 `waiting_user`（已停止、等用户回话）也算作活跃，导致会话
      // processing 恒为 true：发送按钮卡在停止态、后续消息被排队
      // （2026-09-11 claude spawn 失败后实机复现）。
      const active = (Array.isArray(tasks) ? tasks : []).filter((t) => (
        t && t.conversationId === cid
        && isCogSeedTaskExecutingStatus(t.status)
      ));
      backendActive = active.length > 0;
      backendAgents = Array.from(new Set(
        active.map((t) => t.agentId).filter((a): a is string => !!a),
      ));
      backendTurns = active.map((t) => {
        const startedMs = Date.parse(String(t.createdAt || ''));
        return {
          actor: String(t.agentId || ''),
          turn_id: t.taskId,
          started_at_ms: Number.isFinite(startedMs) ? startedMs : 0,
        };
      }).filter((t) => t.actor && t.turn_id);
    } catch (err) {
      log.warn(`backend task status unavailable user=${userId} cid=${cid}: ${(err as Error).message}`);
    }
    const collaboration = await readCollaborationSnapshot(userId, cid).catch((err) => {
      log.warn(`collaboration snapshot unavailable user=${userId} cid=${cid}: ${(err as Error).message}`);
      return null;
    });
    const collaborationPart = collaboration ? { collaboration } : {};
    const kstarLifecycle = await import('../kstar/lifecycle-adapter')
      .then((module) => module.readKstarTaskLifecycle(userId, cid))
      .catch((err) => {
        log.warn(`kstar lifecycle snapshot unavailable user=${userId} cid=${cid}: ${(err as Error).message}`);
        return null;
      });
    const kstarLifecyclePart = kstarLifecycle && kstarLifecycle.status !== 'none' ? { kstarLifecycle } : {};
    // The conversation floor — included so a renderer reload / recovery poll
    // restores the composer target (the agent the commander handed off to)
    // instead of dropping back to the commander until the next state_changed.
    const floor = state.active_recipient ? { active_recipient: state.active_recipient } : {};
    if ((state.status === 'running' || diskInFlight.length > 0) && !runtime.processing && !backendActive) {
      log.warn(`healing orphan running state user=${userId} cid=${cid} status=${state.status} in_flight=${diskInFlight.join(',')}`);
      await setStatus(userId, cid, 'idle');
      return { processing: false, processing_since: null, in_flight: [], active_turns: [], backend_active: false, ...collaborationPart, ...kstarLifecyclePart, ...floor };
    }
    const inFlight = Array.from(new Set([
      ...diskInFlight,
      ...runtime.inFlight,
      ...backendAgents,
    ].filter(Boolean)));
    const processing = state.status === 'running' || inFlight.length > 0 || runtime.processing || backendActive;
    return {
      processing,
      processing_since: processing ? (state.last_active_at || null) : null,
      in_flight: inFlight,
      active_turns: [...runtime.activeTurns, ...backendTurns],
      backend_active: backendActive,
      ...collaborationPart,
      ...kstarLifecyclePart,
      ...floor,
    };
  } catch {
    return { processing: false, processing_since: null, in_flight: [], active_turns: [], backend_active: false };
  }
}

/** Re-export so the IPC layer can subscribe to the bus BEFORE calling
 *  send(). enqueue wakes the recipient worker synchronously, which then
 *  starts emitting events on the same microtask cycle as send's return —
 *  if subscribe runs after send, those first events are lost. */
export const subscribeBus = subscribe;

import type { ChatUseSelection, ChatMessageReference, GroupMessage } from './visibility';
import {
  type ChatFormPayload, encodeSubmission, buildMention,
} from './router';
import type { MarketplaceInstallRequest } from './visibility';
import * as marketplace from '../marketplace';

const log = createLogger('group_chat.facade');

/** 主 jsonl 文件路径（confirm-cards.ts 等子模块共用）。 */
export function mainJsonlFile(uid: string, cid: string): string {
  return conversationMessageFile(uid, cid);
}

interface TombstoneRevision {
  file: string;
  deletedAt: string;
  originals: Map<string, GroupMessage>;
}

type TombstoneResult =
  | { ok: true; changed: number; revisions: TombstoneRevision[] }
  | { ok: false; error: string };

function _deletedMessageRevision(message: GroupMessage, deletedAt: string): GroupMessage {
  return {
    id: message.id,
    ts: message.ts,
    from: message.from,
    to: Array.isArray(message.to) ? message.to : [],
    text: '',
    ...(safeId(message.action_request_id) ? { action_request_id: message.action_request_id } : {}),
    ...(safeId(message.turn_id) ? { turn_id: message.turn_id } : {}),
    ...(message.turn_end === true ? { turn_end: true as const } : {}),
    deleted_at: deletedAt,
    deleted_by_user: true,
    _v: Math.max(0, Number(message._v) || 0) + 1,
  };
}

/** Tombstone all selected records in one file rewrite. A conversation message
 * id is stable across the main log and actor slices, so the same id set can be
 * applied to every representation without reinterpreting message content. */
async function _tombstoneMessagesInFile(
  file: string,
  ids: ReadonlySet<string>,
  deletedAt: string,
): Promise<TombstoneResult> {
  if (!fs.existsSync(file)) return { ok: true, changed: 0, revisions: [] };
  let changed = 0;
  const originals = new Map<string, GroupMessage>();
  const rewritten = await rewriteJsonlRecords<GroupMessage>(file, (records) => records.map((record) => {
    if (!record || !ids.has(record.id) || record.deleted_at) return record;
    originals.set(record.id, record);
    changed += 1;
    return _deletedMessageRevision(record, deletedAt);
  }));
  if (rewritten.ok === false) return { ok: false, error: rewritten.error };
  return {
    ok: true,
    changed,
    revisions: changed > 0 ? [{ file, deletedAt, originals }] : [],
  };
}

async function _restoreTombstoneRevision(revision: TombstoneRevision): Promise<void> {
  if (!revision.originals.size || !fs.existsSync(revision.file)) return;
  const restored = await rewriteJsonlRecords<GroupMessage>(revision.file, (records) => records.map((record) => {
    const original = revision.originals.get(record.id);
    if (!original || record.deleted_at !== revision.deletedAt || record.deleted_by_user !== true) return record;
    return original;
  }));
  if (restored.ok === false) throw new Error(restored.error);
}

async function _rollbackTombstones(revisions: readonly TombstoneRevision[]): Promise<void> {
  for (const revision of [...revisions].reverse()) await _restoreTombstoneRevision(revision);
}

/** Promote a legacy top-level message log into the canonical project/cloud
 * location before a mutating operation. Readers intentionally support both
 * paths, but writers must never create a new canonical file that contains only
 * the replacement and silently hides the legacy transcript. */
async function _ensureWritableConversationMessageFile(userId: string, cid: string): Promise<string> {
  const source = conversationMessageReadFile(userId, cid);
  const target = mainJsonlFile(userId, cid);
  if (source === target || !fs.existsSync(source)) return target;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return target;
}

/** Apply a message tombstone set to the authoritative log and every actor
 * slice. The caller validates the target against the main log before calling
 * this function, so a missing slice is simply a legacy/unused projection. */
async function _tombstoneMessagesEverywhere(
  userId: string,
  cid: string,
  ids: ReadonlySet<string>,
  deletedAt: string,
  mainFile = mainJsonlFile(userId, cid),
): Promise<TombstoneResult> {
  const main = await _tombstoneMessagesInFile(mainFile, ids, deletedAt);
  if (main.ok === false) return main;
  let changed = main.changed;
  const revisions = [...main.revisions];
  const layout = conversationLayout(userId, cid);
  try {
    const entries = await fsp.readdir(layout.visibilityDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const slice = await _tombstoneMessagesInFile(path.join(layout.visibilityDir, entry.name), ids, deletedAt);
      if (slice.ok === false) {
        try { await _rollbackTombstones(revisions); }
        catch (rollbackError) {
          return { ok: false, error: `visibility rewrite failed and rollback failed: ${(rollbackError as Error).message}` };
        }
        return slice;
      }
      changed += slice.changed;
      revisions.push(...slice.revisions);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { await _rollbackTombstones(revisions); }
      catch (rollbackError) {
        return { ok: false, error: `visibility rewrite failed and rollback failed: ${(rollbackError as Error).message}` };
      }
      return { ok: false, error: `visibility rewrite failed: ${(err as Error).message}` };
    }
  }
  return { ok: true, changed, revisions };
}

/** Clear every model session that could contain invalidated conversation
 * history. Session-file deletion is intentionally delegated to the existing
 * facade, which also evicts the in-memory cache and its tool-result spill. */
async function _resetConversationModelSessions(userId: string, cid: string): Promise<void> {
  const members = await readMembers(userId, cid);
  const sessions = await import('../../model/core-agent/session-store');
  for (const actor of members.actors) {
    if (actor.kind !== 'commander' && actor.kind !== 'agent') continue;
    const sid = actorSessionId(cid, actor);
    sessions.evictSession(sid);
    sessions.deleteSessionFileForUser(userId, sid);
  }
  const cliSessions = await import('../local_agents/sessions');
  await cliSessions.clearForConversation(userId, cid);
}

async function _retitleAfterFirstUserMessageEdit(
  userId: string,
  cid: string,
  rows: readonly GroupMessage[],
  targetIndex: number,
  text: string,
): Promise<void> {
  const hasEarlierUserMessage = rows.slice(0, targetIndex).some((row) => (
    !row.deleted_at && !row.dispatch && row.from === USER_ID && String(row.text || '').trim()
  ));
  if (hasEarlierUserMessage) return;
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    if (conv && !conv.title_manually_set) {
      await chats.updateConversation(userId, cid, { title: chats.autoTitle(text) }, conv.project_id || null);
    }
  } catch (err) {
    log.warn('message edit auto-title failed', { cid, error: logErrorRef(err) });
  }
}

// ── Send (from human) ────────────────────────────────────────────────────


export async function sendCommanderMessage(
  input: { userId: string; cid: string; text: string; recall_projection_card?: { projectionId: string; authorization?: string; presentation?: 'sidecar' } },
): Promise<{ ok: boolean; msg?: GroupMessage; error?: string }> {
  const { userId, cid, text, recall_projection_card } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };
  await seedReservedActors(userId, cid);
  try {
    const msg = await enqueue({
      uid: userId,
      cid,
      fromActorId: COMMANDER_ID,
      forceTo: [USER_ID],
      text,
      ...(recall_projection_card ? { recall_projection_card } : {}),
    });
    return { ok: true, msg };
  } catch (err) {
    log.error(`commander send failed user=${userId} cid=${cid}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export interface SendInput {
  userId: string;
  cid: string;
  text: string;
  model_text?: string;
  attachments?: string[];
  use_selections?: ChatUseSelection[];
  references?: Array<{ source_cid: string; source_msg_id: string }>;
  recall_projection_card?: { projectionId: string; authorization?: string; presentation?: 'sidecar' };
  /** Explicit projection receipt ownership on the final user-visible turn message. */
  projection_receipt?: { projectionId: string; authorization: string };
  kstar_review_card?: { kind: 'kstar_review_card'; episodeId: string; reviewId: string; expectedResult?: string; actualResult?: string };
  recipient_agent_id?: string;
  recipient_origin?: 'user_selection' | 'cli_fallback' | 'active_floor';
  /** Per-task execution config from the unified execution entry (composer
   *  recipient/model pick). Validated here; empty objects are dropped so
   *  downstream sees a clean undefined. */
  execution_config?: import('./bus').TurnExecutionConfig;
  /** 提交幂等键（PRD EC-07）：同一次提交意图的重复发送携带同一个 id。
   *  第一个请求被接受后，重复请求直接返回原消息，不再新建一次运行。 */
  submit_request_id?: string;
  /** 多 Agent：会话成员快照（有序）。成员表示本次协作的可选范围，不等于本条都
   *  启动（FR-017）；缺省/空＝默认由 CogSeed 接收。 */
  member_agent_ids?: string[];
  /** 多 Agent：正文 `@` 点名的执行对象。非空时本条只派发给这些成员。 */
  mention_agent_ids?: string[];
  /** 多 Agent：按来源的模型配置（'internal' 共享来源，或外接实例 agent_id）。
   *  多来源时取代单套 execution_config，避免内部连接/模型串到外接实例（FR-007）。 */
  execution_configs?: Record<string, import('./bus').TurnExecutionConfig>;
  /** P3394 信封（翻译官模式）：渠道入站消息投影出的统一信封，随消息贯穿派发；
   * 不传时行为与既往完全一致。 */
  p3394_envelope?: P3394Envelope;
}

type ValidatedUserRoute = NonNullable<Parameters<typeof enqueue>[0]['userRoute']>;

/** Validate the structured composer route at the business boundary. Renderer
 * state is advisory: Agent availability, enabled state, and CLI capability are
 * all re-read here before a route can bypass Wake Gate. */
async function _validateUserRoute(
  userId: string,
  cid: string,
  agentId: unknown,
  origin: unknown,
): Promise<ValidatedUserRoute | null> {
  if (agentId === undefined && origin === undefined) return null;
  if (typeof agentId !== 'string' || !safeId(agentId)
      || (origin !== 'user_selection' && origin !== 'cli_fallback' && origin !== 'active_floor')) {
    throw new Error('invalid recipient route');
  }
  if (agentId === COMMANDER_ID) {
    if (origin !== 'user_selection') throw new Error('invalid recipient route');
    return { agentId, origin };
  }
  if (origin === 'active_floor') {
    const activeRecipient = (await readState(userId, cid)).active_recipient;
    if (activeRecipient !== agentId) throw new Error('invalid active floor route');
  }
  const agents = await import('../agents');
  const { isAgentEnabled } = await import('../component_enabled');
  if (!isAgentEnabled(userId, agentId)) throw new Error('selected Agent is disabled');
  const agent = await agents.getAgentForChatDispatch(userId, agentId);
  if (!agent) throw new Error('selected Agent is unavailable');
  if (origin === 'cli_fallback') {
    // A fallback route is only valid for a local CLI Agent and only while the
    // API model is unavailable. This prevents a forged renderer payload from
    // silently bypassing normal model selection or Wake approval.
    const runtime = agent.runtime;
    if (!runtime || (runtime.kind !== 'cli' && runtime.kind !== 'p3394-gateway')) {
      throw new Error('invalid CLI fallback recipient');
    }
    const cli = runtime.cli;
    const { hasConfiguredModel } = await import('../auth');
    if (hasConfiguredModel().configured) throw new Error('CLI fallback is not active');
    const { detectAll } = await import('../local_agents/registry');
    const entries = await detectAll();
    const entry = entries.find((item) => item.type === cli);
    if (!entry?.available) throw new Error('selected local Agent is unavailable');
  }
  return { agentId, origin };
}

/** Validate the per-task execution config (unified execution entry) at the
 *  business boundary. Renderer state is advisory: ids are shape-checked and
 *  unknown values are dropped (not fatal — a stale override must never block
 *  sending; the turn falls back to the default group). An all-empty object
 *  collapses to null so downstream sees a clean undefined.
 *  `model` may travel without `provider` — that's the CLI-agent override
 *  shape (the model id is passed to the external CLI directly); in-process
 *  turns require the full pair and ignore model-only values.
 *  Exported for the unified-execution-entry tests. */
export function _validatedExecutionConfig(raw: unknown): import('./bus').TurnExecutionConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = _safeExecutionString(r.provider);
  const model = _safeExecutionString(r.model);
  if (provider === null || model === null) return null;
  const effort = r.effort === 'off' || r.effort === 'low' || r.effort === 'high' ? r.effort : undefined;
  if (!model && !effort) return null;
  return {
    ...(provider && model ? { provider, model } : (model ? { model } : {})),
    ...(effort ? { effort } : {}),
  };
}

const MAX_EXECUTION_STRING_LENGTH = 256;
function _safeExecutionString(value: unknown): string | null {
  if (value === undefined) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_EXECUTION_STRING_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * 多 Agent 提交的成员 / 点名名单校验（PRD FR-015/FR-016）。
 *
 * 与单接收者路由同一条业务边界：渲染层状态只是建议，逐个 id 重新核验
 * 「已启用 + 可派发」。任一失效即整条拒绝——绝不静默降级成部分成员执行。
 */
async function _validateAgentIdList(
  userId: string,
  raw: unknown,
  field: string,
  opts: { preserveCommander?: boolean } = {},
): Promise<string[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`invalid ${field}`);
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !safeId(item)) throw new Error(`invalid ${field}`);
    // 保留 id（协调者 / 用户）不是成员 agent：跨版本载荷里出现时按「非成员」丢弃，
    // 而不是让整条提交失败——协调者由 bus 自身承担，不在 member_agent_ids 语义内。
    if (item === USER_ID || (item === COMMANDER_ID && !opts.preserveCommander)) continue;
    if (!ids.includes(item)) ids.push(item);
  }
  if (ids.length > 20) throw new Error(`${field} too large`);
  const agents = await import('../agents');
  const { isAgentEnabled } = await import('../component_enabled');
  for (const id of ids) {
    if (RESERVED_IDS.has(id)) continue;
    if (!isAgentEnabled(userId, id)) throw new Error(`selected Agent is disabled: ${id}`);
    const agent = await agents.getAgentForChatDispatch(userId, id);
    if (!agent) throw new Error(`selected Agent is unavailable: ${id}`);
  }
  return ids;
}

/** 按来源的模型配置（多 Agent）：key 为来源 id（'internal' 或外接 agent_id）。 */
export function _validatedExecutionConfigMap(raw: unknown): Record<string, import('./bus').TurnExecutionConfig> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, import('./bus').TurnExecutionConfig> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== 'internal' && !safeId(key)) continue;
    const cfg = _validatedExecutionConfig(value);
    if (cfg) out[key] = cfg;
  }
  return Object.keys(out).length ? out : null;
}

export type ExecutionSourceCapability =
  | {
      kind: 'internal';
      models: Array<{ provider: string; model: string; effort: boolean }>;
    }
  | {
      kind: 'external';
      model: boolean;
      effort: boolean;
      effortOff: boolean;
      /** Empty means the external runtime has a declared model channel but
       * exposes no enumerable catalog, so a free-form model id is allowed. */
      models: string[];
    };

/** Validate the complete renderer map against server-owned source identities
 * and their execution capabilities. Any invalid entry rejects the submission;
 * callers must never keep a valid subset of an untrusted map. */
export function _validateExecutionConfigMapForSources(
  raw: unknown,
  capabilities: Record<string, ExecutionSourceCapability>,
): Record<string, import('./bus').TurnExecutionConfig> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid execution configs');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length) return null;
  const out: Record<string, import('./bus').TurnExecutionConfig> = {};
  for (const [sourceId, value] of entries) {
    const capability = capabilities[sourceId];
    if (!capability) throw new Error(`invalid execution config source: ${sourceId}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid execution config: ${sourceId}`);
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'provider' && key !== 'model' && key !== 'effort')) {
      throw new Error(`invalid execution config: ${sourceId}`);
    }
    const provider = _safeExecutionString(record.provider);
    const model = _safeExecutionString(record.model);
    const effort = record.effort;
    const normalizedEffort: 'off' | 'low' | 'high' | undefined =
      effort === 'off' || effort === 'low' || effort === 'high' ? effort : undefined;
    if (provider === null || model === null) throw new Error(`invalid execution config: ${sourceId}`);
    if (effort !== undefined && !normalizedEffort) {
      throw new Error(`unsupported effort: ${sourceId}`);
    }
    if (capability.kind === 'internal') {
      if ((provider || model) && (!provider || !model)) {
        throw new Error(`unsupported provider/model: ${sourceId}`);
      }
      const match = provider && model
        ? capability.models.find((entry) => entry.provider === provider && entry.model === model)
        : undefined;
      if (provider && model && !match) throw new Error(`unsupported provider/model: ${sourceId}`);
      if (normalizedEffort && !(match ? match.effort : capability.models.some((entry) => entry.effort))) {
        throw new Error(`unsupported effort: ${sourceId}`);
      }
      if (!model && !normalizedEffort) throw new Error(`invalid execution config: ${sourceId}`);
      out[sourceId] = {
        ...(provider && model ? { provider, model } : {}),
        ...(normalizedEffort ? { effort: normalizedEffort } : {}),
      };
      continue;
    }
    if (provider) throw new Error(`unsupported provider: ${sourceId}`);
    if (model && (!capability.model
      || (capability.models.length > 0 && !capability.models.includes(model)))) {
      throw new Error(`unsupported model: ${sourceId}`);
    }
    if (normalizedEffort && (!capability.effort || (normalizedEffort === 'off' && !capability.effortOff))) {
      throw new Error(`unsupported effort: ${sourceId}`);
    }
    if (!model && !normalizedEffort) throw new Error(`invalid execution config: ${sourceId}`);
    out[sourceId] = { ...(model ? { model } : {}), ...(normalizedEffort ? { effort: normalizedEffort } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

async function _executionSourceCapabilities(
  userId: string,
  selectedAgentIds: string[],
): Promise<Record<string, ExecutionSourceCapability>> {
  const capabilities: Record<string, ExecutionSourceCapability> = {
    internal: { kind: 'internal', models: [] },
  };
  const auth = await import('../auth');
  const { entries } = await auth.listEntries();
  const modelLists = new Map<string, Awaited<ReturnType<typeof auth.listModels>>['models']>();
  for (const entry of entries) {
    let models = modelLists.get(entry.provider);
    if (!models) {
      models = (await auth.listModels(entry.provider)).models;
      modelLists.set(entry.provider, models);
    }
    const meta = models.find((model) => model.id === entry.model);
    (capabilities.internal as Extract<ExecutionSourceCapability, { kind: 'internal' }>).models.push({
      provider: entry.provider,
      model: entry.model,
      effort: meta?.reasoning === true,
    });
  }
  const agents = await import('../agents');
  const localModels = await import('../local_agents/models');
  const gateways = await import('../p3394_bridge/external-gateways');
  for (const id of selectedAgentIds) {
    const agent = await agents.getAgentForChatDispatch(userId, id);
    const runtime = agent?.runtime;
    if (!runtime || (runtime.kind !== 'cli' && runtime.kind !== 'p3394-gateway')) continue;
    const fallback = localModels.execControlFor(runtime.cli);
    const inspected = await gateways.inspectExternalGatewayModels(runtime.cli);
    const inspectedReady = inspected.status === 'ready';
    capabilities[id] = {
      kind: 'external',
      model: runtime.kind === 'p3394-gateway' && !!runtime.model_args
        ? true
        : (inspectedReady ? inspected.modelControllable === true : fallback.model),
      effort: runtime.kind === 'p3394-gateway' && !!runtime.effort_args
        ? true
        : (inspectedReady ? inspected.effortControllable === true : fallback.effort),
      effortOff: fallback.effortOff,
      models: inspectedReady
        ? inspected.models.map((entry) => entry.id)
        : localModels.listModels(runtime.cli as any).map((entry) => entry.id),
    };
  }
  return capabilities;
}

/** Convert the legacy single-source composer override into the same durable
 * per-source shape used by multi-source submissions. A single override is
 * safe only when all selected executors resolve to one configuration source. */
export function _normalizeRunSourceConfigs(
  executionConfig: import('./bus').TurnExecutionConfig | null,
  executionConfigs: Record<string, import('./bus').TurnExecutionConfig> | null,
  selectedAgentIds: string[],
  externalAgentIds: string[],
): Record<string, import('./bus').TurnExecutionConfig> | null {
  if (executionConfigs) {
    return Object.fromEntries(
      Object.entries(executionConfigs).map(([key, value]) => [key, { ...value }]),
    );
  }
  if (!executionConfig) return null;
  const external = new Set(externalAgentIds);
  const sources = new Set(
    selectedAgentIds.length
      ? selectedAgentIds.map((id) => external.has(id) ? id : 'internal')
      : ['internal'],
  );
  if (sources.size !== 1) {
    throw new Error('execution_configs required for multiple sources');
  }
  const [source] = sources;
  return { [source]: { ...executionConfig } };
}

/** 任务引用（@ 产物）源消息定位：在源会话消息里找持有该文件（附件或 produced）的最新一条。 */
async function _resolveTaskArtifactSourceMessage(
  userId: string,
  sourceCid: string,
  fileName: string,
): Promise<{ source_msg_id: string; source_ts: string; source_text: string } | null> {
  if (!safeId(sourceCid) || !fileName) return null;
  try {
    const rows = await readJsonl<{ id?: string; ts?: string; text?: string; attachments?: unknown; produced?: unknown }>(
      conversationMessageReadFile(userId, sourceCid),
      100_000,
    );
    const base = fileName.toLowerCase();
    for (let i = rows.length - 1; i >= 0; i--) {
      const m = rows[i];
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      const attNames: string[] = Array.isArray(m.attachments)
        ? m.attachments.map((a: any) => (typeof a === 'string' ? a : (a && a.name) || ''))
        : [];
      const producedNames: string[] = Array.isArray(m.produced)
        ? m.produced.map((p: any) => {
            // produced 可能是字符串全路径（AI 产出文件落盘时写入）或 {path} 对象
            if (typeof p === 'string') return path.basename(p);
            if (p && typeof p.path === 'string') return path.basename(p.path);
            return '';
          })
        : [];
      if ([...attNames, ...producedNames].some((n) => n && n.toLowerCase() === base)) {
        return {
          source_msg_id: m.id,
          source_ts: typeof m.ts === 'string' ? m.ts : '',
          source_text: typeof m.text === 'string' ? m.text : '',
        };
      }
    }
  } catch (err) {
    log.warn('resolve task artifact source message failed', { sourceCid, error: logErrorRef(err) });
  }
  return null;
}

/**
 * 空间任务引用合并（标准 composer @ 产物/资产 → task_references）：
 *   - 产物 → references（LLM 可读文件，经跨任务引用解析走源消息）；
 *   - 资产 → 模型上下文块（不污染用户可见文本）。
 * 所有发送路径（conversations.sendStream / groupChat.send IPC）都汇聚到
 * groupChat.send()，合并必须放在这里才能让 @ 引用真正随消息发给模型。
 */
async function _mergeTaskReferences(
  userId: string,
  cid: string,
  text: string,
  refs: SendInput['references'],
  incomingModelText: string | undefined,
): Promise<{ refs: SendInput['references']; modelText: string | undefined; assetRefs: Array<{ name: string; asset_type?: string }> }> {
  let modelText = incomingModelText;
  let mergedRefs = Array.isArray(refs) ? refs : [];
  let spaceAssetRefs: Array<{ name: string; asset_type?: string }> = [];
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    const taskRefs = conv?.task_references || [];
    const artifactRefs = taskRefs.filter((r) => r.kind === 'artifact');
    const assetRefs = taskRefs.filter((r) => r.kind === 'asset');
    if (artifactRefs.length) {
      // 产物引用需指向「持有该附件的源消息」才能过跨任务引用解析（_resolveMessageReferences
      // 要求合法 source_msg_id + 非空源文本）。逐条在源会话里定位持有该文件的最新消息。
      const resolved: Array<{
        source_cid: string; source_title: string; source_msg_id: string; source_ts: string;
        text: string; file_name: string;
      }> = [];
      for (const r of artifactRefs.slice(0, 20)) {
        const src = await _resolveTaskArtifactSourceMessage(userId, r.source_cid, r.file_name);
        if (!src) continue;
        resolved.push({
          source_cid: r.source_cid || '',
          source_title: r.source_title || r.name || '空间任务引用',
          source_msg_id: src.source_msg_id,
          source_ts: r.source_ts || src.source_ts || (conv && (conv.updated_at || conv.created_at)) || new Date().toISOString(),
          text: src.source_text,
          file_name: r.file_name || '',
        });
      }
      if (resolved.length) {
        mergedRefs = [
          ...mergedRefs,
          ...resolved.map((r) => ({
            source_cid: r.source_cid,
            source_title: r.source_title,
            source_msg_id: r.source_msg_id,
            from_actor: 'space_task',
            from_name: '空间任务引用',
            source_ts: r.source_ts,
            text: r.text,
            ...(r.file_name ? { attachments: [{ name: r.file_name }] } : {}),
          })),
        ];
      }
    }
    if (assetRefs.length) {
      const block = assetRefs
        .map((r) => `- ${r.name}（${r.asset_type || '空间资产'}）${r.summary ? `：${r.summary}` : ''}`)
        .join('\n');
      if (block) {
        const suffix = `\n\n【本任务引用的空间资产】\n${block}`;
        modelText = modelText && modelText.trim() ? `${modelText}${suffix}` : `${text}${suffix}`;
      }
      // 资产引用可见反馈：随 user 消息落 space_asset_refs，UI 气泡显示 chips
      spaceAssetRefs = assetRefs.map((r) => ({ name: r.name, ...(r.asset_type ? { asset_type: r.asset_type } : {}) }));
    }
  } catch (err) {
    log.warn('task references merge failed', { cid, error: logErrorRef(err) });
  }
  return { refs: mergedRefs, modelText, assetRefs: spaceAssetRefs };
}

async function _resolveMessageReferences(
  userId: string,
  requested: SendInput['references'],
): Promise<ChatMessageReference[]> {
  const inputs = Array.isArray(requested) ? requested.slice(0, 20) : [];
  if (!inputs.length) return [];
  const chats = await import('../chats');
  const attachmentsFeature = await import('../chat_attachments');
  const rowsByCid = new Map<string, GroupMessage[]>();
  const titleByCid = new Map<string, string>();
  const namesByCid = new Map<string, Map<string, string>>();
  const out: ChatMessageReference[] = [];
  const seen = new Set<string>();
  let remainingChars = 40_000;
  let remainingFiles = 40;

  const loadSource = async (sourceCid: string): Promise<GroupMessage[]> => {
    if (rowsByCid.has(sourceCid)) return rowsByCid.get(sourceCid) || [];
    const conv = await chats.getConversation(userId, sourceCid);
    if (!conv) {
      rowsByCid.set(sourceCid, []);
      return [];
    }
    const rows = await readJsonl<GroupMessage>(conversationMessageReadFile(userId, sourceCid), 100_000);
    rowsByCid.set(sourceCid, rows);
    titleByCid.set(sourceCid, conv.title || sourceCid);
    try {
      const members = await readMembers(userId, sourceCid);
      namesByCid.set(sourceCid, new Map(members.actors.map((actor) => [actor.id, actor.name || actor.id])));
    } catch { namesByCid.set(sourceCid, new Map()); }
    return rows;
  };

  const attachmentNames = (
    stored: ChatMessageReference['attachments'] | undefined,
    source: GroupMessage | undefined,
  ): string[] => {
    const fromSnapshot = Array.isArray(stored)
      ? stored.map((item) => typeof item === 'string' ? item : item?.name)
      : [];
    const fromSource = Array.isArray(source?.attachments) ? source.attachments : [];
    return Array.from(new Set([...fromSnapshot, ...fromSource]
      .filter((name): name is string => typeof name === 'string' && !!name.trim())));
  };

  const pushReference = async (
    ref: ChatMessageReference,
    authoritativeSource?: GroupMessage,
  ): Promise<void> => {
    if (out.length >= 20 || remainingChars <= 0) return;
    const sourceCid = ref.source_cid;
    const sourceMsgId = ref.source_msg_id;
    if (!safeId(sourceCid) || !safeId(sourceMsgId)) return;
    const identity = `${sourceCid}:${sourceMsgId}`;
    if (seen.has(identity)) return;
    seen.add(identity);

    const text = String(ref.text || authoritativeSource?.text || '')
      .slice(0, Math.min(12_000, remainingChars));
    const resolvedAttachments: NonNullable<ChatMessageReference['attachments']> = [];
    for (const name of attachmentNames(ref.attachments, authoritativeSource)) {
      if (remainingFiles <= 0) break;
      const resolved = attachmentsFeature.resolveAttachmentAbsPath(userId, sourceCid, name);
      resolvedAttachments.push({
        name,
        ...(resolved.ok ? { kind: resolved.kind } : {}),
      });
      remainingFiles -= 1;
    }
    const produced = (Array.isArray(ref.produced) ? ref.produced : authoritativeSource?.produced || [])
      .slice(0, Math.max(0, remainingFiles));
    remainingFiles -= produced.length;
    if (!text.trim() && !resolvedAttachments.length && !produced.length) return;
    remainingChars -= text.length;
    const { attachments: _storedAttachments, produced: _storedProduced, ...base } = ref;
    out.push({
      ...base,
      text,
      ...(resolvedAttachments.length ? { attachments: resolvedAttachments } : {}),
      ...(produced.length ? { produced } : {}),
    });
  };

  for (const item of inputs) {
    if (out.length >= 20 || remainingChars <= 0) break;
    const sourceCid = typeof item?.source_cid === 'string' ? item.source_cid : '';
    const sourceMsgId = typeof item?.source_msg_id === 'string' ? item.source_msg_id : '';
    if (!safeId(sourceCid) || !safeId(sourceMsgId)) continue;
    const source = (await loadSource(sourceCid)).find((msg) => msg.id === sourceMsgId);
    if (!source || source.deleted_at || source.dispatch || !source.text?.trim()) continue;
    // The renderer localizes the reserved user/commander labels. Persist only
    // real member display names here so snapshots stay locale-independent.
    const fromName = source.from === USER_ID
      ? ''
      : namesByCid.get(sourceCid)?.get(source.from);
    await pushReference({
      source_cid: sourceCid,
      source_title: titleByCid.get(sourceCid) || sourceCid,
      source_msg_id: sourceMsgId,
      from_actor: source.from,
      ...(fromName ? { from_name: fromName } : {}),
      source_ts: source.ts,
      text: source.text,
    }, source);

    // A referenced message may itself contain a flat reference bundle.
    // Expand that bundle one level into the destination, rehydrate any
    // attachment locators from their original conversations, and dedupe by
    // source cid/message id. Since every newly-written bundle is already
    // flat, one expansion level also prevents cycles and recursive growth.
    for (const nested of source.references || []) {
      if (out.length >= 20 || remainingChars <= 0) break;
      if (!safeId(nested.source_cid) || !safeId(nested.source_msg_id)) continue;
      const nestedSource = (await loadSource(nested.source_cid))
        .find((msg) => msg.id === nested.source_msg_id && !msg.deleted_at && !msg.dispatch);
      await pushReference(nested, nestedSource);
    }
  }
  return out;
}

// ─── 提交幂等（PRD EC-07 / 设计 §7） ──────────────────────────────────────
// 复用失败回合重试的 claim 模式：同一 submit_request_id 只允许一次 enqueue。
// 响应丢失后渲染层用同一个 id 重发 → 命中 claim 返回原消息，而不是新建运行。

export interface SubmitClaim {
  version: 1;
  request_id: string;
  payload_hash: string;
  state: 'preparing' | 'message_persisted' | 'accepted';
  updated_at: string;
  run_id: string;
  message_id: string;
  recipient_ids: string[];
  dispatch_turn_ids: Record<string, string>;
}

type SubmitPersistenceHooks = {
  beforeClaimWrite?: () => void | Promise<void>;
  beforeRunWrite?: () => void | Promise<void>;
  afterMessageAppend?: () => void | Promise<void>;
};

let _submitPersistenceHooksForTest: SubmitPersistenceHooks | null = null;

export function _setSubmitPersistenceHooksForTest(hooks: SubmitPersistenceHooks | null): void {
  _submitPersistenceHooksForTest = hooks;
}

function _submitClaimFile(userId: string, cid: string, requestId: string): string {
  return path.join(conversationLayout(userId, cid).groupDir, 'submit-claims', `${requestId}.json`);
}

export function _normSubmitClaim(raw: unknown, requestId: string): SubmitClaim | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SubmitClaim>;
  if (r.version !== 1 || r.request_id !== requestId) return null;
  if (r.state !== 'preparing' && r.state !== 'message_persisted' && r.state !== 'accepted') return null;
  if (typeof r.updated_at !== 'string' || !Number.isFinite(Date.parse(r.updated_at))) return null;
  if (typeof r.payload_hash !== 'string' || !safeId(r.payload_hash)) return null;
  if (typeof r.run_id !== 'string' || !safeId(r.run_id)) return null;
  if (typeof r.message_id !== 'string' || !safeId(r.message_id)) return null;
  if (!Array.isArray(r.recipient_ids) || r.recipient_ids.some((id) => !safeId(id))) return null;
  if (!r.dispatch_turn_ids || typeof r.dispatch_turn_ids !== 'object' || Array.isArray(r.dispatch_turn_ids)) return null;
  const dispatchTurnIds: Record<string, string> = {};
  for (const [recipientId, turnId] of Object.entries(r.dispatch_turn_ids)) {
    if (!safeId(recipientId) || typeof turnId !== 'string' || !safeId(turnId)) return null;
    dispatchTurnIds[recipientId] = turnId;
  }
  return {
    version: 1,
    request_id: requestId,
    payload_hash: r.payload_hash,
    state: r.state,
    updated_at: r.updated_at,
    run_id: r.run_id,
    message_id: r.message_id,
    recipient_ids: Array.from(new Set(r.recipient_ids)),
    dispatch_turn_ids: dispatchTurnIds,
  };
}

export async function _readSubmitClaim(userId: string, cid: string, requestId: string): Promise<SubmitClaim | null> {
  try {
    return _normSubmitClaim(await readJson(_submitClaimFile(userId, cid, requestId)), requestId);
  } catch {
    return null;
  }
}

export async function _writeSubmitClaim(
  userId: string,
  cid: string,
  requestId: string,
  claim: SubmitClaim,
): Promise<void> {
  const file = _submitClaimFile(userId, cid, requestId);
  await _submitPersistenceHooksForTest?.beforeClaimWrite?.();
  await writeJson(file, claim);
}

export async function _clearSubmitClaim(userId: string, cid: string, requestId: string): Promise<void> {
  try {
    await fsp.unlink(_submitClaimFile(userId, cid, requestId));
  } catch {
    /* already gone */
  }
}

/** 命中已接受的 claim 时取回原消息（回读失败也要返回"已接受"，不能变成第二次运行）。 */
async function _loadClaimedMessage(userId: string, cid: string, messageId: string): Promise<GroupMessage | undefined> {
  try {
    const rows = await readJsonl<GroupMessage>(mainJsonlFile(userId, cid), 10_000);
    return rows.find((row) => row.id === messageId);
  } catch {
    return undefined;
  }
}

function _submitConversationLockFile(userId: string, cid: string): string {
  return path.join(conversationLayout(userId, cid).groupDir, 'submit-claims', '.conversation-submit.lock');
}

function _stableSubmitId(
  prefix: 'run_' | 'msg_' | 'turn-submit-',
  input: Record<string, unknown>,
): string {
  const kind = prefix === 'run_'
    ? 'submit_run'
    : prefix === 'msg_'
      ? 'submit_message'
      : 'submit_turn';
  return `${prefix}${cogSeedRequestFingerprint(kind, input).slice(0, 24)}`;
}

async function _readSubmitClaimStrict(
  userId: string,
  cid: string,
  requestId: string,
): Promise<SubmitClaim | null> {
  const file = _submitClaimFile(userId, cid, requestId);
  const raw = await readJson<unknown>(file);
  const claim = _normSubmitClaim(raw, requestId);
  if (fs.existsSync(file) && !claim) throw new Error('invalid durable submit claim');
  return claim;
}

async function _recoverPersistedSubmit(
  userId: string,
  cid: string,
  claim: SubmitClaim,
  msg: GroupMessage,
): Promise<void> {
  for (const recipientId of msg.to) {
    if (recipientId === USER_ID) continue;
    const turnId = claim.dispatch_turn_ids[recipientId];
    if (!turnId) throw new Error('persisted submit claim is missing a dispatch turn id');
    await recoverPersistedUserDispatch({
      uid: userId,
      cid,
      messageId: claim.message_id,
      actionRequestId: claim.request_id,
      recipientId,
      turnId,
    });
  }
}

/** 提交被接受时建立协作运行（设计 §4.1）：成员/点名/配置在此冻结。 */
async function _startRunForSubmit(params: {
  userId: string;
  cid: string;
  text: string;
  memberIds: string[];
  mentionIds: string[];
  externalIds: string[];
  executionConfigs: Record<string, import('./bus').TurnExecutionConfig> | null;
  attachments: string[];
  references: ChatMessageReference[];
  requiresSequential: boolean;
  runId?: string;
}): Promise<string | null> {
  const { createRun } = await import('./run_store');
  const { primeScopeAgentNames } = await import('./bus');
  try {
    const agents = await import('../agents');
    const list = await agents.listAgents().catch(() => []);
    primeScopeAgentNames((list || []).map((a: { agent_id: string; name?: string }) => ({
      agent_id: a.agent_id,
      name: a.name,
    })));
  } catch {
    /* 显示名拿不到时范围块回落 id，不影响功能 */
  }
  const attachmentDescriptors = (() => {
    if (!params.attachments.length) return [];
    try {
      const all = require('../chat_attachments') as typeof import('../chat_attachments');
      const byName = new Map(all.listAttachments(params.userId, params.cid).map((item) => [item.name, item]));
      return params.attachments.map((id) => {
        const info = byName.get(id);
        return info ? { id, ...info } : { id, name: id };
      });
    } catch {
      return params.attachments.map((id) => ({ id, name: id }));
    }
  })();
  const record = await createRun({
    uid: params.userId,
    cid: params.cid,
    ...(params.runId ? { runId: params.runId } : {}),
    submittedText: params.text,
    memberAgentIds: params.memberIds,
    mentionAgentIds: params.mentionIds,
    externalAgentIds: params.externalIds,
    ...(params.executionConfigs ? { sourceConfigs: params.executionConfigs } : {}),
    attachmentIds: params.attachments,
    attachmentDescriptors,
    references: params.references,
    requiresSequential: params.requiresSequential,
  });
  return record ? record.run_id : null;
}

export async function send(
  input: SendInput,
): Promise<{
  ok: boolean;
  accepted?: true;
  cid?: string;
  submit_request_id?: string;
  msg?: GroupMessage;
  error?: string;
}> {
  const { userId, cid, text, model_text, attachments, use_selections, references, recall_projection_card, kstar_review_card, p3394_envelope } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!text || !text.trim()) return { ok: false, error: 'empty message' };
  const submitRequestId = input.submit_request_id || `submit_${genId12()}`;
  if (!safeId(submitRequestId)) return { ok: false, error: 'invalid submit request id' };
  const acceptanceReceipt = {
    accepted: true as const,
    cid,
    submit_request_id: submitRequestId,
  };
  const payloadHash = cogSeedRequestFingerprint('submit', {
    cid,
    text,
    model_text: model_text || '',
    attachments: attachments || [],
    use_selections: use_selections || [],
    references: references || [],
    recipient_agent_id: input.recipient_agent_id || '',
    recipient_origin: input.recipient_origin || '',
    execution_config: input.execution_config || null,
    member_agent_ids: input.member_agent_ids || [],
    mention_agent_ids: input.mention_agent_ids || [],
    execution_configs: input.execution_configs || null,
    recall_projection_card: recall_projection_card || null,
    kstar_review_card: kstar_review_card || null,
    p3394_envelope: p3394_envelope || null,
  });
  const identity = { uid: userId, cid, request_id: submitRequestId };
  const lockFile = _submitConversationLockFile(userId, cid);
  try {
    const accepted = await fileEditLock(lockFile).runExclusive(async () => {
      const claim = await _readSubmitClaimStrict(userId, cid, submitRequestId);
      if (!claim) return null;
      if (claim.payload_hash !== payloadHash) {
        return { ok: false as const, error: 'submit request ID payload conflict' };
      }
      if (claim.state !== 'accepted') return null;
      const original = await _loadClaimedMessage(userId, cid, claim.message_id);
      return { ok: true as const, ...(original ? { msg: original } : {}) };
    });
    if (accepted) return accepted.ok ? { ...accepted, ...acceptanceReceipt } : accepted;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  let userRoute: ValidatedUserRoute | null = null;
  try {
    userRoute = await _validateUserRoute(userId, cid, input.recipient_agent_id, input.recipient_origin);
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'invalid recipient route' };
  }
  // Execution selection is renderer-advisory until member identity and
  // server-owned source capabilities have both been classified below.
  let executionConfig: import('./bus').TurnExecutionConfig | null = null;
  // 多 Agent：成员 / 点名名单逐个核验；任一失效即整条拒绝，不静默部分执行
  // （FR-015）。点名是本条的派发对象，不能再叠加结构化单接收者路由。
  let memberIds: string[] = [];
  let mentionIds: string[] = [];
  let implicitActiveRecipient = '';
  let executionConfigs: Record<string, import('./bus').TurnExecutionConfig> | null = null;
  let memberExternalIds: string[] = [];
  try {
    memberIds = await _validateAgentIdList(userId, input.member_agent_ids, 'member_agent_ids');
    mentionIds = await _validateAgentIdList(userId, input.mention_agent_ids, 'mention_agent_ids', {
      preserveCommander: true,
    });
    if (mentionIds.length && userRoute) throw new Error('mention route conflicts with recipient route');
    if (!userRoute && !memberIds.length && !mentionIds.length) {
      const activeRecipient = (await readState(userId, cid)).active_recipient || '';
      if (safeId(activeRecipient) && activeRecipient !== USER_ID) {
        const validated = await _validateAgentIdList(
          userId,
          [activeRecipient],
          'active_recipient',
          { preserveCommander: true },
        );
        implicitActiveRecipient = validated[0] || '';
      }
    }
    // 外接实例名单：派发时用来源判定，避免内部配置串到外接（FR-007）。
    const selectedAgentIds = Array.from(new Set([
      ...memberIds,
      ...mentionIds,
      ...(userRoute ? [userRoute.agentId] : []),
      ...(implicitActiveRecipient ? [implicitActiveRecipient] : []),
    ])).filter((id) => !RESERVED_IDS.has(id));
    memberExternalIds = (await classifyRecipientRuntimes(userId, selectedAgentIds)).externalIds;
    if (input.execution_config !== undefined && input.execution_configs !== undefined) {
      throw new Error('ambiguous execution configs');
    }
    let rawSourceConfigs: unknown = input.execution_configs;
    if (rawSourceConfigs === undefined && input.execution_config !== undefined) {
      const external = new Set(memberExternalIds);
      const sources = new Set(
        selectedAgentIds.length
          ? selectedAgentIds.map((id) => external.has(id) ? id : 'internal')
          : ['internal'],
      );
      if (sources.size !== 1) throw new Error('execution_configs required for multiple sources');
      rawSourceConfigs = { [Array.from(sources)[0]]: input.execution_config };
    }
    if (rawSourceConfigs !== undefined) {
      const capabilities = await _executionSourceCapabilities(userId, selectedAgentIds);
      executionConfigs = _validateExecutionConfigMapForSources(rawSourceConfigs, capabilities);
    }
    if (executionConfigs && Object.keys(executionConfigs).length === 1) {
      executionConfig = Object.values(executionConfigs)[0];
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'invalid member selection' };
  }
  await seedReservedActors(userId, cid);
  // Auto-title: the first real user message in a fresh / unnamed
  // conversation overwrites the placeholder title so the sidebar item
  // becomes scannable. Lazy-imported to avoid a chats↔group_chat circular.
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    if (conv && !conv.title_manually_set && isPlaceholderTitle(conv.title)) {
      const mechanicalTitle = chats.autoTitle(text);
      await chats.updateConversation(
        userId,
        cid,
        { title: mechanicalTitle },
        conv.project_id || null,
      );
      // 机械标题先上（即时、离线可用）；再异步请模型生成一个概括性标题覆盖。
      // 应用前重新检查：期间用户手动改过（title_manually_set）或标题已被别的
      // 路径改写（≠ mechanicalTitle）就不再动——模型慢也不许覆盖新状态。
      if (typeof text === 'string' && text.trim()) {
        const sourceText = text;
        void (async () => {
          try {
            const { generateConversationTitle } = await import('../conversation-title');
            const generated = await generateConversationTitle(userId, cid, sourceText);
            if (!generated || generated === mechanicalTitle) return;
            const latest = await chats.getConversation(userId, cid);
            if (!latest || latest.title_manually_set || latest.title !== mechanicalTitle) return;
            await chats.updateConversation(userId, cid, { title: generated }, latest.project_id || null);
          } catch (err) {
            log.warn(`model auto-title failed user=${userId} cid=${cid}: ${(err as Error).message}`);
          }
        })();
      }
    }
  } catch (err) {
    log.warn(`auto-title failed user=${userId} cid=${cid}: ${(err as Error).message}`);
  }
  // 空间任务引用合并（标准 composer @ 产物/资产 → task_references）：所有发送路径
  // （conversations.sendStream / groupChat.send IPC）都汇聚到这里，引用才能真正随消息发出。
  // 顺序意图 + 多点名：交给协调者编排（决策 A）——直接并行派发会让"先…再…"没有任何
  // 依赖可依，强约束（设计 §4.4）也就无从校验。
  const requiresSequential = detectSequentialIntent(text);
  const deferToCommander = shouldDeferToCommanderForOrder({
    requiresSequential,
    mentionIds,
  });
  let merged: Awaited<ReturnType<typeof _mergeTaskReferences>>;
  let resolvedReferences: ChatMessageReference[];
  try {
    merged = await _mergeTaskReferences(userId, cid, text, references, model_text);
    resolvedReferences = await _resolveMessageReferences(userId, merged.refs);
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'invalid submission references' };
  }
  const deterministicRunId = _stableSubmitId('run_', identity);
  const deterministicMessageId = _stableSubmitId('msg_', identity);
  const runMentionIds = Array.from(new Set([
    ...mentionIds,
    ...(userRoute && userRoute.agentId !== COMMANDER_ID ? [userRoute.agentId] : []),
    ...(implicitActiveRecipient && implicitActiveRecipient !== COMMANDER_ID
      ? [implicitActiveRecipient]
      : []),
  ]));
  const candidateRecipients = Array.from(new Set([
    COMMANDER_ID,
    ...memberIds,
    ...runMentionIds,
    ...(userRoute ? [userRoute.agentId] : []),
    ...(implicitActiveRecipient ? [implicitActiveRecipient] : []),
  ]));
  const deterministicTurnIds = Object.fromEntries(candidateRecipients.map((recipientId) => [
    recipientId,
    _stableSubmitId('turn-submit-', { ...identity, recipient_id: recipientId }),
  ]));
  try {
    const result = await fileEditLock(lockFile).runExclusive(async () => {
      let claim = await _readSubmitClaimStrict(userId, cid, submitRequestId);
      if (claim && claim.payload_hash !== payloadHash) {
        return { ok: false, error: 'submit request ID payload conflict' };
      }
      if (!claim) {
        claim = {
          version: 1,
          request_id: submitRequestId,
          payload_hash: payloadHash,
          state: 'preparing',
          updated_at: nowIso(),
          run_id: deterministicRunId,
          message_id: deterministicMessageId,
          recipient_ids: [],
          dispatch_turn_ids: deterministicTurnIds,
        };
        await _writeSubmitClaim(userId, cid, submitRequestId, claim);
      }
      if (claim.state === 'accepted') {
        const original = await _loadClaimedMessage(userId, cid, claim.message_id);
        return { ok: true, ...(original ? { msg: original } : {}) };
      }

      const acceptPersisted = async (persisted: GroupMessage) => {
        claim = {
          ...claim!,
          state: 'message_persisted',
          updated_at: nowIso(),
          recipient_ids: persisted.to.slice(),
        };
        await _writeSubmitClaim(userId, cid, submitRequestId, claim);
        await _recoverPersistedSubmit(userId, cid, claim, persisted);
        claim = { ...claim, state: 'accepted', updated_at: nowIso() };
        await _writeSubmitClaim(userId, cid, submitRequestId, claim);
        return { ok: true as const, msg: persisted };
      };

      const alreadyPersisted = await _loadClaimedMessage(userId, cid, claim.message_id);
      if (alreadyPersisted) return acceptPersisted(alreadyPersisted);

      const { readRun } = await import('./run_store');
      let run = await readRun(userId, cid, claim.run_id);
      if (!run) {
        await _submitPersistenceHooksForTest?.beforeRunWrite?.();
        const createdRunId = await _startRunForSubmit({
          userId,
          cid,
          text,
          memberIds,
          mentionIds: runMentionIds,
          externalIds: memberExternalIds,
          executionConfigs,
          attachments: attachments ? [...attachments] : [],
          references: resolvedReferences,
          requiresSequential,
          runId: claim.run_id,
        });
        if (createdRunId !== claim.run_id) throw new Error('collaboration run persistence failed');
        run = await readRun(userId, cid, claim.run_id);
        if (!run) throw new Error('collaboration run persistence failed');
      }

      try {
        const msg = await enqueue({
          uid: userId,
          cid,
          fromActorId: USER_ID,
          text,
          // Current renderer/IPC submissions are identity-structured. Raw
          // display-name text is presentation only and must never be upgraded
          // into a recipient by the legacy bus parser.
          structuredUserSubmission: true,
          actionRequestId: submitRequestId,
          messageId: claim.message_id,
          dispatchTurnIds: claim.dispatch_turn_ids,
          ...(merged.modelText && merged.modelText.trim() ? { model_text: merged.modelText } : {}),
          ...(merged.assetRefs.length ? { space_asset_refs: merged.assetRefs } : {}),
          ...(attachments && attachments.length ? { attachments: [...attachments] } : {}),
          ...(use_selections && use_selections.length ? { use_selections } : {}),
          ...(resolvedReferences.length ? { references: resolvedReferences } : {}),
          ...(recall_projection_card ? { recall_projection_card } : {}),
          ...(kstar_review_card ? { kstar_review_card } : {}),
          ...(userRoute ? { userRoute, forceTo: [userRoute.agentId] } : {}),
          ...(mentionIds.length && !deferToCommander ? { forceTo: mentionIds } : {}),
          ...(implicitActiveRecipient ? { forceTo: [implicitActiveRecipient] } : {}),
          ...(deferToCommander ? { forceTo: [COMMANDER_ID] } : {}),
          runId: claim.run_id,
          ...(executionConfig ? { executionConfig } : {}),
          ...(executionConfigs ? { memberConfigs: executionConfigs } : {}),
          ...(memberExternalIds.length
            ? { memberConfigScope: { external_ids: memberExternalIds } }
            : {}),
          ...((memberIds.length || runMentionIds.length || executionConfigs)
            ? {
              member_snapshot: {
                member_agent_ids: memberIds,
                ...(runMentionIds.length
                  ? { mention_agent_ids: runMentionIds, mention_order: runMentionIds }
                  : {}),
                ...(memberExternalIds.length ? { external_agent_ids: memberExternalIds } : {}),
                ...(requiresSequential ? { requires_sequential: true } : {}),
                ...(executionConfigs ? { execution_configs: executionConfigs } : {}),
              },
            }
            : {}),
          ...(p3394_envelope ? { p3394_envelope } : {}),
        });
        await _submitPersistenceHooksForTest?.afterMessageAppend?.();
        claim = {
          ...claim,
          state: 'message_persisted',
          updated_at: nowIso(),
          recipient_ids: msg.to.slice(),
        };
        await _writeSubmitClaim(userId, cid, submitRequestId, claim);
        claim = { ...claim, state: 'accepted', updated_at: nowIso() };
        await _writeSubmitClaim(userId, cid, submitRequestId, claim);
        return { ok: true, msg };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'TEST_CRASH_AFTER_MESSAGE_APPEND') {
          return { ok: false, error: (err as Error).message };
        }
        const persisted = await _loadClaimedMessage(userId, cid, claim.message_id);
        if (persisted) return acceptPersisted(persisted);
        throw err;
      }
    });
    if (result.ok) {
      try {
        const chats = await import('../chats');
        await chats.updateConversation(userId, cid, { task_references: [] });
      } catch (clearErr) {
        log.warn(`clear task_references failed user=${userId} cid=${cid}: ${(clearErr as Error).message}`);
      }
    }
    return result.ok ? { ...result, ...acceptanceReceipt } : result;
  } catch (err) {
    log.error(`send failed user=${userId} cid=${cid}: ${(err as Error).message}`);
    return { ok: false, error: (err as Error).message };
  }
}

export interface ReplaceUserMessageInput {
  userId: string;
  cid: string;
  messageId: string;
  text: string;
}

/**
 * Replace one persisted user message and discard its downstream conversation
 * branch. This application has a linear transcript, not branch storage: the
 * selected record and all later records become tombstones, then the edited
 * text enters the ordinary bus pipeline as a fresh user message.
 *
 * Attachments, explicit skill/connector selections, and resolved reference
 * snapshots belong to the original user request and are retained. The edited
 * text is deliberately the new model text; host-only `model_text` from a
 * form replay must never survive a manual user rewrite.
 */
export async function replaceUserMessage(
  input: ReplaceUserMessageInput,
): Promise<{ ok: boolean; msg?: GroupMessage; error?: string }> {
  const { userId, cid, messageId } = input;
  const text = String(input.text || '').trim();
  if (!safeId(cid) || !safeId(messageId) || !text) {
    return { ok: false, error: t('errors.message_edit_invalid_target') };
  }

  const runtime = await runtimeStatus(userId, cid);
  if (runtime.processing) return { ok: false, error: t('errors.message_edit_running') };

  let file: string;
  try {
    file = await _ensureWritableConversationMessageFile(userId, cid);
  } catch (err) {
    log.warn('message edit legacy history promotion failed', { cid, error: logErrorRef(err) });
    return { ok: false, error: t('errors.message_edit_sync_failed') };
  }
  const rows = await readJsonl<GroupMessage>(file, 100_000);
  const targetIndex = rows.findIndex((row) => row.id === messageId && !row.deleted_at);
  if (targetIndex < 0) return { ok: false, error: t('errors.message_edit_invalid_target') };
  const target = rows[targetIndex];
  if (target.from !== USER_ID || target.dispatch) {
    return { ok: false, error: t('errors.message_edit_invalid_target') };
  }

  const originalRecipients = Array.isArray(target.to) ? target.to : [];
  const originalAgentCandidate = originalRecipients.find((recipientId) =>
    safeId(recipientId) && !RESERVED_IDS.has(recipientId),
  );
  let originalAgentRecipient = '';
  if (originalAgentCandidate) {
    try {
      const agents = await import('../agents');
      const { isAgentEnabled } = await import('../component_enabled');
      if (isAgentEnabled(userId, originalAgentCandidate)
        && await agents.getAgentForChatDispatch(userId, originalAgentCandidate)) {
        originalAgentRecipient = originalAgentCandidate;
      }
    } catch (err) {
      log.warn('message edit original Agent lookup failed', { cid, error: logErrorRef(err) });
    }
  }

  const tailIds = new Set(rows.slice(targetIndex)
    .filter((row) => !row.deleted_at && safeId(row.id))
    .map((row) => row.id));
  if (!tailIds.has(messageId)) return { ok: false, error: t('errors.message_edit_invalid_target') };

  try {
    await seedReservedActors(userId, cid);
  } catch (err) {
    log.warn('message edit preparation failed', { cid, error: logErrorRef(err) });
    return { ok: false, error: t('errors.message_edit_prepare_failed') };
  }

  const tombstoned = await _tombstoneMessagesEverywhere(userId, cid, tailIds, nowIso(), file);
  if (tombstoned.ok === false) {
    log.error('message edit history rewrite failed', { cid, error: tombstoned.error });
    return { ok: false, error: t('errors.message_edit_sync_failed') };
  }

  try {
    await _resetConversationModelSessions(userId, cid);
    await resetConversationRoutingState(userId, cid);
    await clearActiveCollaborationState(userId, cid);
  } catch (err) {
    try { await _rollbackTombstones(tombstoned.revisions); }
    catch (rollbackError) {
      log.error('message edit preparation rollback failed', { cid, error: logErrorRef(rollbackError) });
    }
    log.warn('message edit preparation failed', { cid, error: logErrorRef(err) });
    return { ok: false, error: t('errors.message_edit_prepare_failed') };
  }

  try {
    const msg = await enqueue({
      uid: userId,
      cid,
      fromActorId: USER_ID,
      text,
      ...(target.attachments?.length ? { attachments: target.attachments.slice() } : {}),
      ...(target.use_selections?.length ? { use_selections: target.use_selections.slice() } : {}),
      ...(target.references?.length ? { references: target.references.slice() } : {}),
      ...(originalAgentRecipient
        ? {
            forceTo: [originalAgentRecipient],
            userRoute: { agentId: originalAgentRecipient, origin: 'message_edit' as const },
          }
        : originalRecipients.includes(COMMANDER_ID) || !!originalAgentCandidate
          ? { forceTo: [COMMANDER_ID] }
          : {}),
    });
    await _retitleAfterFirstUserMessageEdit(userId, cid, rows, targetIndex, text);
    log.info(`message-edited cid=${cid} invalidated=${tailIds.size} rewritten=${tombstoned.changed}`);
    return { ok: true, msg };
  } catch (err) {
    try { await _rollbackTombstones(tombstoned.revisions); }
    catch (rollbackError) {
      log.error('message edit enqueue rollback failed', { cid, error: logErrorRef(rollbackError) });
    }
    log.error('message edit replacement enqueue failed', { cid, error: logErrorRef(err) });
    return { ok: false, error: t('errors.message_edit_enqueue_failed') };
  }
}

export type FailedTurnRetryMode = 'resume' | 'restart';

export interface ResolveFailedTurnRetryInput {
  userId: string;
  cid: string;
  failedMessageId: string;
  /** Short localized text rendered in the user's bubble (for example,
   * "Continue"). The model receives host-owned text below. */
  visibleText: string;
}

export interface RetryFailedTurnInput extends ResolveFailedTurnRetryInput {
  requestId: string;
}

export interface ResolvedFailedTurnRetry {
  mode: FailedTurnRetryMode;
  enqueue: Parameters<typeof enqueue>[0];
}

interface FailedTurnRetryClaim {
  schemaVersion: 1;
  requestId: string;
  fingerprint: string;
  failedMessageId: string;
  status: 'pending' | 'completed';
  mode?: FailedTurnRetryMode;
  messageId?: string;
  dispatchTurnId?: string;
  /** Request ID persisted on the canonical user message. It differs from
   * requestId only when a fresh Dashboard request repairs a crash-before-
   * dispatch attempt without creating a second message. */
  canonicalRequestId?: string;
  createdAt: string;
  updatedAt: string;
}

interface FailedTurnRetryTargetClaim {
  schemaVersion: 1;
  requestId: string;
  fingerprint: string;
  failedMessageId: string;
  mode?: FailedTurnRetryMode;
  dispatchTurnId?: string;
  canonicalRequestId?: string;
  messageId?: string;
  createdAt: string;
  updatedAt: string;
}

function failedTurnRetryClaimFile(userId: string, cid: string, requestId: string): string {
  return path.join(conversationLayout(userId, cid).groupDir, 'dashboard-retry-claims', `${requestId}.json`);
}

function failedTurnRetryTargetClaimFile(userId: string, cid: string, failedMessageId: string): string {
  return path.join(
    conversationLayout(userId, cid).groupDir,
    'dashboard-retry-target-claims',
    `${failedMessageId}.json`,
  );
}

function retryDispatchTurnId(fingerprint: string): string {
  return `turn-retry-${fingerprint.slice(0, 24)}`;
}

async function readFailedTurnRetryClaim(file: string): Promise<FailedTurnRetryClaim | null> {
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<FailedTurnRetryClaim>;
    if (value.schemaVersion !== 1
      || !safeId(value.requestId || '')
      || !/^[a-f0-9]{64}$/.test(value.fingerprint || '')
      || !safeId(value.failedMessageId || '')
      || (value.status !== 'pending' && value.status !== 'completed')
      || (value.mode !== undefined && value.mode !== 'resume' && value.mode !== 'restart')
      || (value.messageId !== undefined && !safeId(value.messageId))
      || (value.dispatchTurnId !== undefined && !safeId(value.dispatchTurnId))
      || (value.canonicalRequestId !== undefined && !safeId(value.canonicalRequestId))) {
      throw new Error('malformed Group Chat retry claim');
    }
    return value as FailedTurnRetryClaim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readFailedTurnRetryTargetClaim(
  file: string,
): Promise<FailedTurnRetryTargetClaim | null> {
  try {
    const value = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<FailedTurnRetryTargetClaim>;
    if (value.schemaVersion !== 1
      || !safeId(value.requestId || '')
      || !/^[a-f0-9]{64}$/.test(value.fingerprint || '')
      || !safeId(value.failedMessageId || '')
      || (value.mode !== undefined && value.mode !== 'resume' && value.mode !== 'restart')
      || (value.dispatchTurnId !== undefined && !safeId(value.dispatchTurnId))
      || (value.canonicalRequestId !== undefined && !safeId(value.canonicalRequestId))
      || (value.messageId !== undefined && !safeId(value.messageId))) {
      throw new Error('malformed Group Chat retry target claim');
    }
    return value as FailedTurnRetryTargetClaim;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function _processHasCompletedOrStartedTool(msg: GroupMessage): boolean {
  return (msg.process || []).some((item) => {
    const event = item && typeof item === 'object' && 'event' in item ? item.event : undefined;
    if (!event || event.stream !== 'tool') return false;
    const data = event.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : {};
    return /^(?:start|running|request|call|begin|end|result)$/.test(String(data.phase || data.status || '').toLowerCase());
  });
}

/** Resolve one failed-bubble retry without mutating conversation state. The
 * main process owns this decision so the renderer cannot guess from localized
 * text or stale DOM. */
export async function resolveFailedTurnRetry(
  input: ResolveFailedTurnRetryInput,
): Promise<{ ok: true; value: ResolvedFailedTurnRetry } | { ok: false; error: string }> {
  const { userId, cid, failedMessageId } = input;
  const visibleText = String(input.visibleText || '').trim();
  if (!safeId(cid) || !safeId(failedMessageId)) return { ok: false, error: 'invalid retry target' };
  if (!visibleText) return { ok: false, error: 'empty retry message' };

  const rows = await readJsonl<GroupMessage>(mainJsonlFile(userId, cid), 100_000);
  const failedIndex = rows.findIndex((row) => row.id === failedMessageId && !row.deleted_at);
  if (failedIndex < 0) return { ok: false, error: 'failed message not found' };
  const failed = rows[failedIndex];
  if (!failed.from || failed.from === USER_ID || failed.dispatch) {
    return { ok: false, error: 'retry target is not an assistant reply' };
  }
  if (!failed.failure_kind && !failed.failure_code) {
    return { ok: false, error: 'retry target is not a failed assistant reply' };
  }

  let sourceIndex = failedIndex - 1;
  while (sourceIndex >= 0) {
    const row = rows[sourceIndex];
    if (!row.deleted_at && !row.dispatch && row.from === USER_ID && String(row.text || '').trim()) break;
    sourceIndex -= 1;
  }
  if (sourceIndex < 0) return { ok: false, error: 'retry source message not found' };
  const source = rows[sourceIndex];

  await seedReservedActors(userId, cid);
  const members = await readMembers(userId, cid);
  const actor = members.actors.find((item) => item.id === failed.from);
  if (!actor || actor.kind === 'user' || actor.kind === 'worker') {
    return { ok: false, error: 'retry actor is unavailable' };
  }
  if (actor.kind === 'agent') {
    try {
      const agents = await import('../agents');
      const { isAgentEnabled } = await import('../component_enabled');
      if (!isAgentEnabled(userId, actor.id)
        || !await agents.getAgentForChatDispatch(userId, actor.id)) {
        return { ok: false, error: 'retry actor is unavailable' };
      }
    } catch (err) {
      log.warn('retry actor lookup failed', { cid, error: logErrorRef(err) });
      return { ok: false, error: 'retry actor is unavailable' };
    }
  }

  let context: {
    activeTurn?: { id: number };
    completedTurns?: Array<{ id: number }>;
    executionPlan?: { updatedTurnId: number; objectiveTurnId: number };
    completedWork?: Array<{ turnId: number }>;
    resources?: Array<{ sourceTurnId?: number }>;
  } | null = null;
  try {
    const { getSession } = await import('../../model/core-agent/session-store');
    context = (await getSession(actorSessionId(cid, actor))).getSerializedContextState();
  } catch (err) {
    log.warn('retry context inspection failed', { error: logErrorRef(err) });
  }

  const activeTurnId = context?.activeTurn?.id;
  const latestCompletedTurnId = context?.completedTurns?.length
    ? context.completedTurns[context.completedTurns.length - 1]?.id
    : undefined;
  const attemptTurnId = activeTurnId || latestCompletedTurnId;
  const planBelongsToAttempt = !!context?.executionPlan && !!attemptTurnId
    && (
      context.executionPlan.updatedTurnId === attemptTurnId
      || context.executionPlan.objectiveTurnId === attemptTurnId
      || !!activeTurnId
    );
  const completedWorkBelongsToAttempt = !!attemptTurnId
    && (context?.completedWork || []).some((entry) => entry.turnId === attemptTurnId);
  const resourceBelongsToAttempt = !!attemptTurnId
    && (context?.resources || []).some((resource) => resource.sourceTurnId === attemptTurnId);
  const attemptRows = rows.slice(sourceIndex + 1, failedIndex + 1);
  // Actor sessions only expose their latest active/completed turn. If the
  // user or this actor has produced a newer visible turn after the selected
  // failure, that latest session state cannot be proven to belong to the old
  // bubble. Restart the old authoritative request instead of attaching it to
  // unrelated newer work.
  const newerAttemptExists = rows.slice(failedIndex + 1).some((row) =>
    !row.deleted_at
    && !row.dispatch
    && (row.from === USER_ID || row.from === failed.from),
  );
  const hasProduced = attemptRows.some((row) => Array.isArray(row.produced) && row.produced.length > 0);
  const hasToolState = attemptRows.some(_processHasCompletedOrStartedTool);
  const hasDurableState = !!activeTurnId
    || planBelongsToAttempt
    || completedWorkBelongsToAttempt
    || resourceBelongsToAttempt
    || hasProduced
    || hasToolState;
  // Configuration/dependency failures normally happen before the runner
  // starts. A stale plan from an older turn must not turn those into a false
  // resume; concrete state from this attempt still wins if it exists.
  const failedBeforeExecution = /^(?:config|dependency)$/.test(String(failed.failure_kind || ''))
    && !activeTurnId && !hasProduced && !hasToolState;
  const mode: FailedTurnRetryMode = hasDurableState && !failedBeforeExecution && !newerAttemptExists
    ? 'resume'
    : 'restart';
  const originalModelText = String(source.model_text || source.text || '');

  return {
    ok: true,
    value: {
      mode,
      enqueue: {
        uid: userId,
        cid,
        fromActorId: USER_ID,
        text: visibleText,
        model_text: mode === 'resume'
          ? buildRetryResumeModelText({
              originalRequest: originalModelText,
              uncertainToolState: hasToolState,
              failureCode: failed.failure_code,
            })
          : originalModelText,
        forceTo: [actor.id],
        userRoute: { agentId: actor.id, origin: 'failed_turn_retry' },
        ...(mode === 'resume' ? { resumeActiveTurn: true } : {}),
        ...(source.use_selections?.length ? { use_selections: source.use_selections.slice() } : {}),
        ...(mode === 'restart' && source.attachments?.length ? { attachments: source.attachments.slice() } : {}),
        ...(mode === 'restart' && source.references?.length ? { references: source.references.slice() } : {}),
      },
    },
  };
}

export async function retryFailedTurn(
  input: RetryFailedTurnInput,
): Promise<{ ok: boolean; mode?: FailedTurnRetryMode; msg?: GroupMessage; error?: string }> {
  const requestId = String(input.requestId || '').trim();
  if (!safeId(requestId)) return { ok: false, error: 'invalid retry request id' };
  if (!safeId(input.cid) || !safeId(input.failedMessageId)) {
    return { ok: false, error: 'invalid retry target' };
  }
  const fingerprint = cogSeedRequestFingerprint('retry', {
    cid: input.cid,
    failedMessageId: input.failedMessageId,
    visibleText: String(input.visibleText || '').trim(),
  });
  const claimFile = failedTurnRetryClaimFile(input.userId, input.cid, requestId);
  const targetClaimFile = failedTurnRetryTargetClaimFile(
    input.userId,
    input.cid,
    input.failedMessageId,
  );
  try {
    return await fileEditLock(claimFile).runExclusive(async () => {
      const existing = await readFailedTurnRetryClaim(claimFile);
      if (existing
        && (existing.requestId !== requestId || existing.failedMessageId !== input.failedMessageId)) {
        throw new Error('retry request claim does not match its storage key');
      }
      if (existing && existing.fingerprint !== fingerprint) {
        return { ok: false, error: 'retry request ID payload conflict' };
      }
      return fileEditLock(targetClaimFile).runExclusive(async () => {
        let targetClaim = await readFailedTurnRetryTargetClaim(targetClaimFile);
        if (targetClaim && targetClaim.failedMessageId !== input.failedMessageId) {
          throw new Error('retry target claim does not match its storage key');
        }
        const rows = await readJsonl<GroupMessage>(mainJsonlFile(input.userId, input.cid), 100_000);
        if (targetClaim && targetClaim.fingerprint !== fingerprint) {
          return { ok: false, error: 'retry target already claimed' };
        }

        const existingCanonicalRequestId = existing?.canonicalRequestId || requestId;
        const targetCanonicalRequestId = targetClaim?.canonicalRequestId
          || targetClaim?.requestId;
        const ownMessageId = existing?.messageId
          || (targetClaim?.requestId === requestId ? targetClaim.messageId : undefined);
        const ownCanonicalRequestId = existing
          ? existingCanonicalRequestId
          : targetClaim?.requestId === requestId
            ? targetCanonicalRequestId
            : requestId;
        const msg = ownMessageId
          ? rows.find((row) => (
              row.id === ownMessageId
              && row.action_request_id === ownCanonicalRequestId
            ))
          : rows.find((row) => row.action_request_id === ownCanonicalRequestId);
        if (msg) {
          const mode = existing?.mode || targetClaim?.mode;
          const dispatchTurnId = existing?.dispatchTurnId || targetClaim?.dispatchTurnId;
          const canonicalRequestId = msg.action_request_id;
          if (!canonicalRequestId || !safeId(canonicalRequestId)) {
            throw new Error('persisted retry message has invalid request identity');
          }
          const timestamp = nowIso();
          if (!targetClaim) {
            targetClaim = {
              schemaVersion: 1,
              requestId,
              fingerprint,
              failedMessageId: input.failedMessageId,
              ...(mode ? { mode } : {}),
              ...(dispatchTurnId ? { dispatchTurnId } : {}),
              canonicalRequestId,
              messageId: msg.id,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            await writeJson(targetClaimFile, targetClaim);
          } else if (targetClaim.requestId === requestId
            && (targetClaim.canonicalRequestId !== canonicalRequestId
              || targetClaim.messageId !== msg.id)) {
            targetClaim = {
              ...targetClaim,
              canonicalRequestId,
              messageId: msg.id,
              updatedAt: timestamp,
            };
            await writeJson(targetClaimFile, targetClaim);
          }
          if (dispatchTurnId) {
            if (msg.to.length !== 1 || msg.to[0] === USER_ID) {
              throw new Error('persisted retry message has no executable recipient');
            }
            await recoverPersistedUserDispatch({
              uid: input.userId,
              cid: input.cid,
              messageId: msg.id,
              actionRequestId: canonicalRequestId,
              recipientId: msg.to[0],
              turnId: dispatchTurnId,
              ...(mode === 'resume' ? { resumeActiveTurn: true } : {}),
            });
          }
          const completed: FailedTurnRetryClaim = {
            schemaVersion: 1,
            requestId,
            fingerprint,
            failedMessageId: input.failedMessageId,
            status: 'completed',
            ...(mode ? { mode } : {}),
            messageId: msg.id,
            ...(dispatchTurnId ? { dispatchTurnId } : {}),
            ...(canonicalRequestId !== requestId ? { canonicalRequestId } : {}),
            createdAt: existing?.createdAt || timestamp,
            updatedAt: timestamp,
          };
          await writeJson(claimFile, completed);
          return { ok: true, mode, msg };
        }
        if (existing?.status === 'completed') {
          throw new Error('completed retry message is missing');
        }

        if (targetClaim && targetClaim.requestId !== requestId) {
          const canonicalRequestId = targetCanonicalRequestId;
          const dispatchTurnId = targetClaim.dispatchTurnId;
          const mode = targetClaim.mode;
          if (!canonicalRequestId || !dispatchTurnId || !mode) {
            return { ok: false, error: 'retry target already claimed' };
          }
          const canonicalMsg = targetClaim.messageId
            ? rows.find((row) => (
                row.id === targetClaim.messageId
                && row.action_request_id === canonicalRequestId
              ))
            : rows.find((row) => row.action_request_id === canonicalRequestId);
          if (!canonicalMsg) {
            // No canonical message means the previous owner stopped before
            // enqueue persisted anything. Since this target lock is now ours,
            // that owner cannot still cross the persistence boundary. Transfer
            // the claim and let this request perform the one canonical enqueue.
            // A recorded messageId without a matching row is data loss, not a
            // safe pre-message crash, and must fail closed.
            if (targetClaim.messageId) throw new Error('completed retry message is missing');
            const priorClaim = await readFailedTurnRetryClaim(
              failedTurnRetryClaimFile(input.userId, input.cid, targetClaim.requestId),
            );
            if (priorClaim && (
              priorClaim.requestId !== targetClaim.requestId
              || priorClaim.failedMessageId !== input.failedMessageId
              || priorClaim.fingerprint !== fingerprint
              || priorClaim.status === 'completed'
              || (priorClaim.mode && priorClaim.mode !== mode)
              || (priorClaim.dispatchTurnId && priorClaim.dispatchTurnId !== dispatchTurnId)
            )) {
              throw new Error('retry target claim conflicts with its request claim');
            }
            targetClaim = {
              ...targetClaim,
              requestId,
              canonicalRequestId: requestId,
              messageId: undefined,
              updatedAt: nowIso(),
            };
            await writeJson(targetClaimFile, targetClaim);
          } else {
            if (canonicalMsg.to.length !== 1 || canonicalMsg.to[0] === USER_ID) {
              throw new Error('persisted retry message has no executable recipient');
            }
            const recovery = await recoverPersistedUserDispatch({
              uid: input.userId,
              cid: input.cid,
              messageId: canonicalMsg.id,
              actionRequestId: canonicalRequestId,
              recipientId: canonicalMsg.to[0],
              turnId: dispatchTurnId,
              ...(mode === 'resume' ? { resumeActiveTurn: true } : {}),
            });
            if (recovery.disposition !== 'redispatched') {
              return { ok: false, error: 'retry target already claimed' };
            }
            const timestamp = nowIso();
            const completed: FailedTurnRetryClaim = {
              schemaVersion: 1,
              requestId,
              fingerprint,
              failedMessageId: input.failedMessageId,
              status: 'completed',
              mode,
              messageId: canonicalMsg.id,
              dispatchTurnId,
              canonicalRequestId,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
            await writeJson(claimFile, completed);
            targetClaim = {
              ...targetClaim,
              requestId,
              canonicalRequestId,
              messageId: canonicalMsg.id,
              updatedAt: timestamp,
            };
            await writeJson(targetClaimFile, targetClaim);
            return { ok: true, mode, msg: canonicalMsg };
          }
        }

        const resolved = await resolveFailedTurnRetry(input);
        if (!resolved.ok) return resolved;
        const claimedMode = existing?.mode || targetClaim?.mode;
        if (claimedMode && claimedMode !== resolved.value.mode) {
          return { ok: false, error: 'retry target state changed before dispatch' };
        }
        const timestamp = nowIso();
        const dispatchTurnId = existing?.dispatchTurnId
          || targetClaim?.dispatchTurnId
          || retryDispatchTurnId(fingerprint);
        if (!targetClaim) {
          targetClaim = {
            schemaVersion: 1,
            requestId,
            fingerprint,
            failedMessageId: input.failedMessageId,
            mode: resolved.value.mode,
            dispatchTurnId,
            canonicalRequestId: requestId,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await writeJson(targetClaimFile, targetClaim);
        } else if (!targetClaim.dispatchTurnId) {
          targetClaim = {
            ...targetClaim,
            mode: targetClaim.mode || resolved.value.mode,
            dispatchTurnId,
            canonicalRequestId: targetClaim.canonicalRequestId || requestId,
            updatedAt: timestamp,
          };
          await writeJson(targetClaimFile, targetClaim);
        }
        const pending: FailedTurnRetryClaim = {
          schemaVersion: 1,
          requestId,
          fingerprint,
          failedMessageId: input.failedMessageId,
          status: 'pending',
          mode: resolved.value.mode,
          dispatchTurnId,
          canonicalRequestId: requestId,
          createdAt: existing?.createdAt || timestamp,
          updatedAt: timestamp,
        };
        await writeJson(claimFile, pending);
        const enqueued = await enqueue({
          ...resolved.value.enqueue,
          actionRequestId: requestId,
          dispatchTurnId,
        });
        if (!targetClaim) throw new Error('retry target claim disappeared before completion');
        targetClaim = {
          ...targetClaim,
          canonicalRequestId: requestId,
          messageId: enqueued.id,
          updatedAt: nowIso(),
        };
        await writeJson(targetClaimFile, targetClaim);
        await writeJson(claimFile, {
          ...pending,
          status: 'completed',
          messageId: enqueued.id,
          updatedAt: nowIso(),
        } satisfies FailedTurnRetryClaim);
        return { ok: true, mode: resolved.value.mode, msg: enqueued };
      });
    });
  } catch (err) {
    log.error('failed-turn retry failed', { error: logErrorRef(err) });
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

// ── Abort + drop ─────────────────────────────────────────────────────────

interface RunRetryClaim {
  version: 1;
  request_id: string;
  fingerprint: string;
  run_id: string;
  requested_agent_ids: string[];
  agent_ids: string[];
  status: 'pending' | 'completed';
  canonical_request_id: string;
  message_id?: string;
  updated_at: string;
}

function normalizeRunRetryClaim(raw: unknown): RunRetryClaim | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Partial<RunRetryClaim>;
  if (
    row.version !== 1
    || !safeId(row.request_id)
    || typeof row.fingerprint !== 'string'
    || !row.fingerprint
    || !safeId(row.run_id)
    || !Array.isArray(row.requested_agent_ids)
    || row.requested_agent_ids.some((id) => !safeId(id))
    || !Array.isArray(row.agent_ids)
    || row.agent_ids.some((id) => !safeId(id))
    || (row.status !== 'pending' && row.status !== 'completed')
    || !safeId(row.canonical_request_id)
    || (row.message_id !== undefined && !safeId(row.message_id))
  ) return null;
  return {
    version: 1,
    request_id: row.request_id,
    fingerprint: row.fingerprint,
    run_id: row.run_id,
    requested_agent_ids: Array.from(new Set(row.requested_agent_ids)),
    agent_ids: Array.from(new Set(row.agent_ids)),
    status: row.status,
    canonical_request_id: row.canonical_request_id,
    ...(row.message_id ? { message_id: row.message_id } : {}),
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

interface RunRetryOperation {
  version: 1;
  generation: number;
  operation_id: string;
  fingerprint: string;
  run_id: string;
  requested_agent_ids: string[];
  retry_agent_ids: string[];
  recipient_ids: string[];
  dispatch_turn_ids: Record<string, string>;
  state: 'preparing' | 'message_persisted' | 'accepted';
  canonical_request_id: string;
  request_aliases: string[];
  message_id: string;
  updated_at: string;
}

function normalizeRunRetryOperation(raw: unknown): RunRetryOperation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Partial<RunRetryOperation>;
  const idList = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || value.some((id) => !safeId(id))) return null;
    const ids = Array.from(new Set(value as string[]));
    return ids.length === value.length ? ids : null;
  };
  const requestedAgentIds = idList(row.requested_agent_ids);
  const retryAgentIds = idList(row.retry_agent_ids);
  const recipientIds = idList(row.recipient_ids);
  const requestAliases = idList(row.request_aliases);
  if (!requestedAgentIds?.length || !retryAgentIds?.length || !recipientIds?.length || !requestAliases?.length) {
    return null;
  }
  if (!row.dispatch_turn_ids
    || typeof row.dispatch_turn_ids !== 'object'
    || Array.isArray(row.dispatch_turn_ids)
    || Object.entries(row.dispatch_turn_ids).some(([recipientId, turnId]) => (
      !safeId(recipientId) || !safeId(turnId)
    ))
    || recipientIds.some((id) => !row.dispatch_turn_ids?.[id])
    || Object.keys(row.dispatch_turn_ids).some((id) => !recipientIds.includes(id))) {
    return null;
  }
  if (
    row.version !== 1
    || !Number.isSafeInteger(row.generation)
    || Number(row.generation) < 1
    || !safeId(row.operation_id)
    || typeof row.fingerprint !== 'string'
    || !row.fingerprint
    || !safeId(row.run_id)
    || !safeId(row.canonical_request_id)
    || !safeId(row.message_id)
    || (row.state !== 'preparing'
      && row.state !== 'message_persisted'
      && row.state !== 'accepted')
  ) return null;
  return {
    version: 1,
    generation: Number(row.generation),
    operation_id: row.operation_id,
    fingerprint: row.fingerprint,
    run_id: row.run_id,
    requested_agent_ids: requestedAgentIds,
    retry_agent_ids: retryAgentIds,
    recipient_ids: recipientIds,
    dispatch_turn_ids: { ...row.dispatch_turn_ids },
    state: row.state,
    canonical_request_id: row.canonical_request_id,
    request_aliases: requestAliases,
    message_id: row.message_id,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

function runRetryDispatchTurnId(fingerprint: string, recipientId: string): string {
  const recipientFingerprint = cogSeedRequestFingerprint('retry', {
    fingerprint,
    recipient_id: recipientId,
  });
  return `turn-run-retry-${recipientFingerprint.slice(0, 24)}`;
}

function runRetryOperationId(fingerprint: string, generation: number): string {
  return `retryop-${fingerprint.slice(0, 24)}-${generation}`;
}

function runRetryMessageId(fingerprint: string): string {
  const messageFingerprint = cogSeedRequestFingerprint('retry', {
    operation_id: fingerprint,
  });
  return `msg-run-retry-${messageFingerprint.slice(0, 24)}`;
}

function runRetryClaimFile(userId: string, cid: string, requestId: string): string {
  return path.join(
    conversationLayout(userId, cid).groupDir,
    'dashboard-retry-claims',
    `run-${requestId}.json`,
  );
}

function runRetryOperationFile(userId: string, cid: string, fingerprint: string): string {
  return path.join(
    conversationLayout(userId, cid).groupDir,
    'dashboard-retry-claims',
    `run-target-${fingerprint}.json`,
  );
}

async function readPersistedRunRetryMessage(
  userId: string,
  cid: string,
  operation: RunRetryOperation,
): Promise<GroupMessage | undefined> {
  const rows = await readJsonl<GroupMessage>(mainJsonlFile(userId, cid), 100_000);
  return rows.find((row) => (
    row.id === operation.message_id
    && row.from === USER_ID
    && row.action_request_id === operation.canonical_request_id
    && row.run_id === operation.run_id
  ));
}

function runRetryAlias(
  requestId: string,
  requestedAgentIds: string[],
  operation: RunRetryOperation,
  status: RunRetryClaim['status'],
): RunRetryClaim {
  return {
    version: 1,
    request_id: requestId,
    fingerprint: operation.fingerprint,
    run_id: operation.run_id,
    requested_agent_ids: requestedAgentIds.slice().sort(),
    agent_ids: operation.retry_agent_ids,
    status,
    canonical_request_id: operation.canonical_request_id,
    ...(status === 'completed' ? { message_id: operation.message_id } : {}),
    updated_at: nowIso(),
  };
}

export async function retryRun(input: {
  userId: string;
  cid: string;
  runId: string;
  agentIds: string[];
  requestId: string;
}): Promise<{ ok: boolean; retry_agent_ids?: string[]; msg?: GroupMessage; error?: string }> {
  if (!safeId(input.cid) || !safeId(input.runId) || !safeId(input.requestId)) {
    return { ok: false, error: 'invalid run retry request' };
  }
  const requested = Array.from(new Set(input.agentIds.filter((id) => safeId(id))));
  if (!requested.length || requested.length !== input.agentIds.length) {
    return { ok: false, error: 'invalid retry actors' };
  }
  const requestedPayloadIds = requested.slice().sort();
  const claimFile = runRetryClaimFile(input.userId, input.cid, input.requestId);
  const replayClaim = normalizeRunRetryClaim(await readJson<unknown>(claimFile));
  if (replayClaim) {
    if (replayClaim.request_id !== input.requestId
      || replayClaim.run_id !== input.runId
      || JSON.stringify(replayClaim.requested_agent_ids) !== JSON.stringify(requestedPayloadIds)) {
      return { ok: false, error: 'retry request ID payload conflict' };
    }
    if (replayClaim.status === 'completed') {
      const rows = await readJsonl<GroupMessage>(mainJsonlFile(input.userId, input.cid), 100_000);
      const msg = rows.find((row) => (
        row.id === replayClaim.message_id
        && row.action_request_id === replayClaim.canonical_request_id
        && row.run_id === replayClaim.run_id
      ));
      if (!msg) return { ok: false, error: 'accepted retry message is missing' };
      return { ok: true, retry_agent_ids: replayClaim.agent_ids, msg };
    }
  }
  const runStore = await import('./run_store');
  const initialRun = await runStore.readRun(input.userId, input.cid, input.runId);
  if (!initialRun || initialRun.cid !== input.cid) return { ok: false, error: 'run not found' };
  const requestedSet = new Set(requested);
  const targetActorIds = initialRun.actors
    .filter((actor) => requestedSet.has(actor.agent_id) && actor.terminal !== 'done')
    .map((actor) => actor.agent_id)
    .sort();
  if (!targetActorIds.length) return { ok: false, error: 'no retryable actors' };
  const fingerprint = cogSeedRequestFingerprint('retry', {
    cid: input.cid,
    run_id: input.runId,
    agent_ids: targetActorIds,
  });
  const operationFile = runRetryOperationFile(input.userId, input.cid, fingerprint);
  try {
    return await fileEditLock(claimFile).runExclusive(async () => {
      const claim = normalizeRunRetryClaim(await readJson<unknown>(claimFile));
      if (claim && (
        claim.request_id !== input.requestId
        || claim.fingerprint !== fingerprint
        || claim.run_id !== input.runId
        || JSON.stringify(claim.requested_agent_ids) !== JSON.stringify(requestedPayloadIds)
      )) {
        return { ok: false, error: 'retry request ID payload conflict' };
      }
      return fileEditLock(operationFile).runExclusive(async () => {
        const {
          finalizeRun,
          prepareRunRetry,
          readRun,
          recordRunActorTerminal,
          retryableRunActorIds,
        } = runStore;
        let operation = normalizeRunRetryOperation(await readJson<unknown>(operationFile));
        let run = await readRun(input.userId, input.cid, input.runId);
        if (!run || run.cid !== input.cid) return { ok: false, error: 'run not found' };

        const agentsFeat = await import('../agents');
        let nextGeneration = 1;
        if (operation) {
          if (operation.fingerprint !== fingerprint
            || operation.run_id !== input.runId
            || JSON.stringify(operation.requested_agent_ids) !== JSON.stringify(targetActorIds)) {
            return { ok: false, error: 'retry target claim conflict' };
          }
          if (operation.state === 'accepted') {
            const operationStillActive = operation.retry_agent_ids.every((agentId) => {
              const actor = run!.actors.find((candidate) => candidate.agent_id === agentId);
              return actor?.terminal === 'pending'
                && actor.retry_operation_id === operation!.operation_id;
            });
            if (!operationStillActive) {
              nextGeneration = operation.generation + 1;
              operation = null;
            }
          }
        }
        if (!operation) {
          const retryIds = retryableRunActorIds(run, targetActorIds);
          if (!retryIds.length) return { ok: false, error: 'no retryable actors' };
          const collaboration = await readCollaborationSnapshot(input.userId, input.cid);
          const rejectedGateActorIds = new Set(
            (collaboration?.gates || [])
              .filter((gate) => gate.review_decision === 'rejected')
              .map((gate) => collaboration?.steps.find((step) => step.id === gate.step_id))
              .filter((step) => (
                step?.group_chat_run_id === input.runId
                && !!step.actor_id
                && retryIds.includes(step.actor_id)
              ))
              .map((step) => step!.actor_id!),
          );
          if (rejectedGateActorIds.size > 0) {
            for (const agentId of rejectedGateActorIds) {
              await recordRunActorTerminal(input.userId, input.cid, input.runId, agentId, {
                terminal: 'blocked',
                reason: 'approval_rejected',
                messages: 0,
                artifacts: [],
              });
            }
            await finalizeRun(input.userId, input.cid, input.runId);
            return { ok: false, error: 'retry blocked by rejected approval' };
          }
          const { listWakeRequests } = await import('../p3394/wake-service');
          const wakes = await listWakeRequests(input.userId, input.cid);
          if (wakes.some((request) => (
            request.dispatch_payload.run_id === input.runId
            && retryIds.includes(request.agent_id)
            && request.status === 'rejected'
          ))) {
            return { ok: false, error: 'retry blocked by rejected approval' };
          }
          const { isAgentEnabled } = await import('../component_enabled');
          for (const agentId of retryIds) {
            if (!isAgentEnabled(input.userId, agentId)
              || !await agentsFeat.getAgentForChatDispatch(input.userId, agentId)) {
              return { ok: false, error: `retry actor is unavailable: ${agentId}` };
            }
          }
          const recipientIds = run.input_snapshot.requires_sequential && retryIds.length > 1
            ? [COMMANDER_ID]
            : retryIds;
          const operationId = runRetryOperationId(fingerprint, nextGeneration);
          operation = {
            version: 1,
            generation: nextGeneration,
            operation_id: operationId,
            fingerprint,
            run_id: input.runId,
            requested_agent_ids: targetActorIds,
            retry_agent_ids: retryIds,
            recipient_ids: recipientIds,
            dispatch_turn_ids: Object.fromEntries(recipientIds.map((recipientId) => [
              recipientId,
              runRetryDispatchTurnId(operationId, recipientId),
            ])),
            state: 'preparing',
            canonical_request_id: input.requestId,
            request_aliases: [input.requestId],
            message_id: runRetryMessageId(operationId),
            updated_at: nowIso(),
          };
          await writeJson(operationFile, operation);
        } else {
          if (!operation.request_aliases.includes(input.requestId)) {
            operation = {
              ...operation,
              request_aliases: [...operation.request_aliases, input.requestId],
              updated_at: nowIso(),
            };
            await writeJson(operationFile, operation);
          }
        }

        if (!claim) {
          await writeJson(
            claimFile,
            runRetryAlias(input.requestId, requestedPayloadIds, operation, 'pending'),
          );
        }

        let persisted = await readPersistedRunRetryMessage(input.userId, input.cid, operation);
        if (operation.state === 'accepted') {
          if (!persisted) throw new Error('accepted retry message is missing');
          await writeJson(
            claimFile,
            runRetryAlias(input.requestId, requestedPayloadIds, operation, 'completed'),
          );
          return { ok: true, retry_agent_ids: operation.retry_agent_ids, msg: persisted };
        }
        if (persisted) {
          operation = { ...operation, state: 'message_persisted', updated_at: nowIso() };
          await writeJson(operationFile, operation);
          for (const recipientId of operation.recipient_ids) {
            if (recipientId === USER_ID || !persisted.to.includes(recipientId)) continue;
            await recoverPersistedUserDispatch({
              uid: input.userId,
              cid: input.cid,
              messageId: persisted.id,
              actionRequestId: operation.canonical_request_id,
              recipientId,
              turnId: operation.dispatch_turn_ids[recipientId],
            });
          }
          operation = { ...operation, state: 'accepted', updated_at: nowIso() };
          await writeJson(operationFile, operation);
          await writeJson(
            claimFile,
            runRetryAlias(input.requestId, requestedPayloadIds, operation, 'completed'),
          );
          return { ok: true, retry_agent_ids: operation.retry_agent_ids, msg: persisted };
        }

        const prepared = await prepareRunRetry(
          input.userId,
          input.cid,
          input.runId,
          operation.retry_agent_ids,
          operation.operation_id,
        );
        if (!prepared?.retry_agent_ids.length) {
          run = await readRun(input.userId, input.cid, input.runId);
          if (!operation.retry_agent_ids.every((agentId) => {
            const actor = run?.actors.find((candidate) => candidate.agent_id === agentId);
            return actor?.terminal === 'pending'
              && actor.retry_operation_id === operation!.operation_id;
          })) {
            return { ok: false, error: 'no retryable actors' };
          }
        } else {
          run = prepared.run;
        }
        if (!run) return { ok: false, error: 'run not found' };
        const retryNames = await Promise.all(operation.retry_agent_ids.map(async (agentId) => (
          (await agentsFeat.getAgentForChatDispatch(input.userId, agentId))?.name || agentId
        )));
        const snapshot = run.input_snapshot;
        const retryModelText = [
          `<collaboration-run-retry run_id="${input.runId}">`,
          `Retry only these unfinished agent ids: ${operation.retry_agent_ids.join(', ')}`,
          'Do not dispatch or repeat work from members that already contributed.',
          'Original request:',
          snapshot.submitted_text,
          '</collaboration-run-retry>',
        ].join('\n');
        const msg = await enqueue({
          uid: input.userId,
          cid: input.cid,
          fromActorId: USER_ID,
          actionRequestId: operation.canonical_request_id,
          messageId: operation.message_id,
          dispatchTurnIds: operation.dispatch_turn_ids,
          text: t('chat.run_retry_message', { names: retryNames.join(', ') }),
          model_text: retryModelText,
          forceTo: operation.recipient_ids,
          runId: input.runId,
          ...(snapshot.attachment_ids.length
            ? { attachments: snapshot.attachment_ids.slice() }
            : {}),
          ...(snapshot.references.length
            ? { references: snapshot.references.map((reference) => ({ ...reference })) }
            : {}),
          ...(snapshot.source_configs
            ? {
                memberConfigs: snapshot.source_configs,
                memberConfigScope: { external_ids: snapshot.external_agent_ids },
              }
            : {}),
          member_snapshot: {
            member_agent_ids: snapshot.member_agent_ids,
            mention_agent_ids: operation.retry_agent_ids,
            mention_order: snapshot.mention_order.filter((id) => operation.retry_agent_ids.includes(id)),
            requires_sequential: snapshot.requires_sequential,
            external_agent_ids: snapshot.external_agent_ids,
            ...(snapshot.source_configs ? { execution_configs: snapshot.source_configs } : {}),
          },
        });
        if (msg.id !== operation.message_id) throw new Error('retry enqueue returned unexpected message id');
        operation = { ...operation, state: 'message_persisted', updated_at: nowIso() };
        await writeJson(operationFile, operation);
        operation = { ...operation, state: 'accepted', updated_at: nowIso() };
        await writeJson(operationFile, operation);
        await writeJson(
          claimFile,
          runRetryAlias(input.requestId, requestedPayloadIds, operation, 'completed'),
        );
        return { ok: true, retry_agent_ids: operation.retry_agent_ids, msg };
      });
    });
  } catch (err) {
    log.error('collaboration run retry failed', { error: logErrorRef(err) });
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

export async function reconcileRun(userId: string, cid: string, runId: string): Promise<void> {
  await reconcileMemberRun(userId, cid, runId);
}

export async function abort(
  userId: string,
  cid: string,
  options?: AbortRunOptions,
): Promise<{ ok: boolean }> {
  await busAbort(userId, cid, options);
  return { ok: true };
}

export async function dropConv(userId: string, cid: string): Promise<void> {
  await busDropConv(userId, cid);
  await purgeGroupDir(userId, cid);
}

// ── Members + plan ───────────────────────────────────────────────────────

export async function listMembers(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
) {
  if (!safeId(cid)) return { ok: false, error: 'invalid cid', actors: [] };
  await seedReservedActors(userId, cid, projectIdHint);
  const m = await readMembers(userId, cid, projectIdHint);
  // Enrich agent actors with the current `interactive` flag so the renderer
  // can decide on its own whether to auto-target the input box at this agent
  // when its plan step goes in_progress. Read from the live agent file each
  // call (no caching) — agents.ts maintains its own list cache so the read
  // is cheap, and "interactive follows the agent's current spec" is the
  // contract.
  const agentsFeat = await import('../agents');
  const enriched = await Promise.all(m.actors.map(async (a) => {
    if (a.kind !== 'agent') return a;
    try {
      const ag = await agentsFeat.getAgentForChatDispatch(userId, a.id);
      if (!agentsFeat.isAgentChatDispatchable(ag)) return null;
      return ag && ag.interactive === true ? { ...a, interactive: true } : a;
    } catch {
      return null;
    }
  }));
  return { ok: true, actors: enriched.filter((actor): actor is NonNullable<typeof actor> => actor !== null) };
}

// ── Streaming events ─────────────────────────────────────────────────────

export async function* streamEvents(
  userId: string, cid: string, opts: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<GroupEvent | { type: 'done' }, void, unknown> {
  if (!safeId(cid)) {
    yield { type: 'done' };
    return;
  }

  // Subscribe FIRST — before any await — so events fired during the seed
  // (or any concurrent enqueue / worker activity) get buffered, not lost.
  // The earlier "await seedReservedActors → subscribe" order had a window
  // where the recipient worker could wake on the same microtask cycle as
  // a `groupChat.send(...)` caller and emit state_changed / process events
  // before the listener was attached.
  const buf: GroupEvent[] = [];
  let wake: (() => void) | null = null;
  let cancelled = false;

  const unsub = subscribe(userId, cid, (ev) => {
    buf.push(ev);
    const w = wake; wake = null; w?.();
  });

  const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) cancelled = true;
    else opts.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  // Seed reserved actors AFTER subscribing — idempotent if `groupChat.send`
  // already ran it; safe if not (keeps `streamEvents` usable as a
  // standalone subscription channel from `groupChat.events` IPC).
  try { await seedReservedActors(userId, cid); }
  catch (err) { log.warn(`seed actors failed user=${userId} cid=${cid}: ${(err as Error).message}`); }

  try {
    while (!cancelled) {
      while (buf.length) {
        yield buf.shift()!;
      }
      if (cancelled) break;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    try { unsub(); } catch { /* ignore */ }
    if (opts.abortSignal) opts.abortSignal.removeEventListener?.('abort', onAbort);
    yield { type: 'done' };
  }
}

// ── Form submission ──────────────────────────────────────────────────────

export interface MarkFormSubmittedInput {
  userId: string; cid: string; msgId: string;
  formId: string;
  values: Record<string, unknown>;
}

/**
 * Mutate the message that owns this form (main jsonl + the agent's
 * visibility slice) to mark it submitted. Does **not** enqueue a follow-up
 * user→agent message — the renderer is responsible for replaying the
 * encoded submission through the normal send-stream pipeline so the UI
 * gets a user bubble + subscribes to the agent's reply stream. Doing both
 * here would either dispatch silently (no renderer subscription = lost
 * events) or double-enqueue (if renderer also sends).
 *
 * Returns the encoded submission text and the recipient actor id so the
 * renderer can fire the send without re-encoding client-side. Agent-owned
 * forms route back to that agent; user-owned plan forms route to `@user`
 * so the executor can close the user step without waking commander.
 */
export async function markFormSubmittedAndDispatch(
  input: MarkFormSubmittedInput,
): Promise<{ ok: boolean; error?: string; submission?: { text: string; agent_id: string } }> {
  const { userId, cid, msgId, formId, values } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return { ok: false, error: 'message not found' };
  const target = all[idx];
  if (!target.form || target.form.form_id !== formId) return { ok: false, error: 'form id mismatch' };

  const agentId = target.form.agent_id;
  const updated: ChatFormPayload = {
    ...target.form,
    submitted: true,
    values,
    submitted_at: nowIso(),
  };

  const r = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId) return null;
    return { ...rec, form: updated };
  });
  if (r.ok === false) {
    log.warn(`form mark failed user=${userId} cid=${cid} msgId=${msgId}: ${r.error}`);
    return { ok: false, error: r.error };
  }
  log.info(`form-submitted user=${userId} cid=${cid} msgId=${msgId} agent=${agentId} fields=${target.form.fields.length}`);

  // Expert-signals hook (plan §5 mount #4): one form_left_blank signal per
  // field the user didn't touch (kept blank OR kept default). Fire-and-
  // forget; failures never block the form submission.
  (async () => {
    try {
      const { emitSignal } = await import('../expert_signals');
      const { buildFormLeftBlankSignals } = await import('../expert_signals/extractors/event');
      const signals = buildFormLeftBlankSignals({
        cid, aid: agentId, turn_id: msgId, msg_id: msgId,
        fields: target.form.fields as any,
        values: (values || {}) as Record<string, unknown>,
      });
      for (const sig of signals) emitSignal(userId, sig);
    } catch (err) {
      log.warn(`expert-signals form_left_blank emit failed cid=${cid} msgId=${msgId}: ${(err as Error).message}`);
    }
  })();

  // Coding-agent contract: when a `project_dir` field is present in the
  // submitted form for an external claude / codex agent, persist it to
  // conv state so `_runCliAgentTurn` can spawn the CLI inside that
  // directory. Other form values stay only in the message log — the
  // agent extracts them from the encoded submission text.
  try {
    const projDir = values && typeof (values as any).project_dir === 'string'
      ? String((values as any).project_dir).trim()
      : '';
    if (projDir) {
      const agentsFeat = await import('../agents');
      const ag = await agentsFeat.getAgentForChatDispatch(userId, agentId);
      const cli = ag?.runtime?.kind === 'cli' ? ag.runtime.cli : '';
      if (agentsFeat.cliIsCodingAgent(cli)) {
        const prev = await readState(userId, cid);
        const oldDir = prev.coding_project_dir || '';
        await setCodingProjectDir(userId, cid, projDir, { explicit: true });
        if (oldDir && oldDir !== projDir) {
          // cwd is about to change — claude code's sessions are cwd-keyed,
          // so the existing binding would fail with "No conversation
          // found" on resume. Drop it; next dispatch starts a fresh CLI
          // session and bridges the prior visible transcript once so the
          // user-visible conversation continues seamlessly.
          const cliSessions = await import('../local_agents/sessions');
          await cliSessions.clearForConversation(userId, cid);
          log.info(`coding cwd changed (form) user=${userId} cid=${cid} ${oldDir} → ${projDir} — cleared cli sessions`);
        } else {
          log.info(`coding project_dir set (explicit) user=${userId} cid=${cid} agent=${agentId} dir=${projDir}`);
        }
      }
    }
  } catch (err) {
    log.warn(`form-submit project_dir hook failed: ${(err as Error).message}`);
  }

  const sliceFile = conversationLayout(userId, cid).visibilityFile(agentId);
  if (fs.existsSync(sliceFile)) {
    const slice = await readJsonl<GroupMessage>(sliceFile, 100_000);
    const sIdx = slice.findIndex((m) => m.id === msgId);
    if (sIdx >= 0) {
      await rewriteJsonlLine<GroupMessage>(sliceFile, sIdx, (rec) => {
        if (!rec || rec.id !== msgId) return null;
        return { ...rec, form: updated };
      });
    }
  }

  const encoded = encodeSubmission(
    { form_id: formId, agent_id: agentId, fields: target.form.fields },
    values,
  );
  // `buildMention` keeps the display name verbatim (whitespace included);
  // falling back to the id keeps the dispatch working if the agent was
  // renamed/disabled between form emit and submit. User-owned plan forms
  // deliberately keep `@user`: it is stripped from persisted text while
  // routing the replay to the user actor, which lets plan reconciliation
  // consume the answer without starting a commander turn.
  let mention = buildMention(agentId);
  if (agentId !== USER_ID) {
    try {
      const agentsFeat = await import('../agents');
      const ag = await agentsFeat.getAgentForChatDispatch(userId, agentId);
      if (ag && ag.name) mention = buildMention(ag.name);
    } catch (err) {
      log.warn(`form-submit name lookup failed agent=${agentId}: ${(err as Error).message}`);
    }
  }
  // Newline (not space) between the @-mention and the bullet list so the
  // markdown renderer treats them as a paragraph followed by a list. With a
  // space, the leading `- ` of the first bullet sits inline with the mention
  // and gets parsed as a hyphen in prose, dropping the first field out of
  // the list and leaving subsequent bullets visually orphaned.
  return { ok: true, submission: { text: `${mention}\n${encoded}`, agent_id: agentId } };
}

// ── Marketplace install confirmation ────────────────────────────────────

export interface ResolveMarketplaceInstallRequestInput {
  userId: string;
  cid: string;
  msgId: string;
  requestId: string;
  decision: 'install' | 'skip';
}

function _xmlAttr(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _marketplaceResultSummary(req: MarketplaceInstallRequest, status: 'installed' | 'skipped' | 'failed', error?: string): string {
  const name = req.name || req.id;
  const kind = req.kind === 'skill'
    ? t('marketplace_install_result.kind_skill')
    : t('marketplace_install_result.kind_agent');
  if (status === 'installed') {
    return t('marketplace_install_result.installed', { kind, name });
  }
  if (status === 'skipped') {
    return t('marketplace_install_result.skipped', { kind, name });
  }
  return t('marketplace_install_result.failed', { kind, name, error: error || 'unknown error' });
}

function _encodeMarketplaceInstallResult(
  req: MarketplaceInstallRequest,
  status: 'installed' | 'skipped' | 'failed',
  error?: string,
): string {
  const payload = {
    request_id: req.request_id,
    kind: req.kind,
    id: req.id,
    name: req.name,
    version: req.version,
    published_at: req.published_at,
    ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
    status,
    ...(error ? { error } : {}),
  };
  const json = JSON.stringify(payload, null, 2)
    .replace(/<\/marketplace-install-result/gi, '<\\/marketplace-install-result');
  return [
    _marketplaceResultSummary(req, status, error),
    `<marketplace-install-result request_id="${_xmlAttr(req.request_id)}" kind="${_xmlAttr(req.kind)}" id="${_xmlAttr(req.id)}" status="${_xmlAttr(status)}">`,
    json,
    '</marketplace-install-result>',
  ].join('\n');
}

async function _rewriteMarketplaceRequestInFile(
  file: string,
  msgId: string,
  requestId: string,
  patch: Partial<MarketplaceInstallRequest>,
): Promise<void> {
  if (!fs.existsSync(file)) return;
  const rows = await readJsonl<GroupMessage>(file, 100_000);
  const idx = rows.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId || !Array.isArray(rec.marketplace_requests)) return null;
    const reqIdx = rec.marketplace_requests.findIndex((r) => r.request_id === requestId);
    if (reqIdx < 0) return null;
    const nextReqs = rec.marketplace_requests.slice();
    nextReqs[reqIdx] = { ...nextReqs[reqIdx], ...patch };
    return { ...rec, marketplace_requests: nextReqs };
  });
}

async function _patchMarketplaceRequest(
  userId: string,
  cid: string,
  msgId: string,
  requestId: string,
  patch: Partial<MarketplaceInstallRequest>,
): Promise<{ ok: true; request: MarketplaceInstallRequest; message: GroupMessage } | { ok: false; error: string }> {
  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const idx = all.findIndex((m) => m.id === msgId);
  if (idx < 0) return { ok: false, error: 'message not found' };
  const target = all[idx];
  const requests = Array.isArray(target.marketplace_requests) ? target.marketplace_requests : [];
  const reqIdx = requests.findIndex((r) => r.request_id === requestId);
  if (reqIdx < 0) return { ok: false, error: 'request not found' };

  let updatedReq: MarketplaceInstallRequest | null = null;
  const r = await rewriteJsonlLine<GroupMessage>(file, idx, (rec) => {
    if (!rec || rec.id !== msgId || !Array.isArray(rec.marketplace_requests)) return null;
    const currentIdx = rec.marketplace_requests.findIndex((x) => x.request_id === requestId);
    if (currentIdx < 0) return null;
    const nextReqs = rec.marketplace_requests.slice();
    updatedReq = { ...nextReqs[currentIdx], ...patch };
    nextReqs[currentIdx] = updatedReq;
    return { ...rec, marketplace_requests: nextReqs };
  });
  if (r.ok === false || !updatedReq) return { ok: false, error: r.ok === false ? r.error : 'request update failed' };

  // Keep the commander's replay slice in sync; other actors do not need the
  // card state for reasoning, and the main jsonl is the renderer source.
  try {
    await _rewriteMarketplaceRequestInFile(
      conversationLayout(userId, cid).visibilityFile(target.from),
      msgId,
      requestId,
      patch,
    );
  } catch (err) {
    log.warn(`marketplace request slice update failed user=${userId} cid=${cid} msgId=${msgId}: ${(err as Error).message}`);
  }
  return { ok: true, request: updatedReq, message: r.record };
}

async function _autoBindInstalledMarketplaceResource(
  userId: string,
  cid: string,
  req: MarketplaceInstallRequest,
): Promise<void> {
  try {
    const chats = await import('../chats');
    const conv = await chats.getConversation(userId, cid);
    const spaceId = (conv as any)?.space_id;
    if (typeof spaceId !== 'string' || !spaceId) return;
    const spacesFeat = await import('../spaces');
    if (req.kind === 'agent') {
      await spacesFeat.addSpaceResource(userId, spaceId, 'agent', req.id);
    } else {
      await spacesFeat.addSpaceResource(userId, spaceId, 'skill', req.id);
    }
    log.info(`auto-added marketplace ${req.kind} ${req.id} to space ${spaceId} after install`);
  } catch (err) {
    log.warn(`marketplace install auto-add failed user=${userId} cid=${cid} id=${req.id}: ${(err as Error).message}`);
  }
}

export async function resolveMarketplaceInstallRequest(
  input: ResolveMarketplaceInstallRequestInput,
): Promise<{
  ok: boolean;
  error?: string;
  request?: MarketplaceInstallRequest;
  install_error?: {
    kind?: MarketplaceInstallRequest['kind'];
    id: string;
    name: string;
    reason: string;
  };
  submission?: { text: string; agent_id: string };
}> {
  const { userId, cid, msgId, requestId, decision } = input;
  if (!safeId(cid)) return { ok: false, error: 'invalid cid' };
  if (!safeId(msgId) || !safeId(requestId)) return { ok: false, error: 'invalid request' };
  if (decision !== 'install' && decision !== 'skip') return { ok: false, error: 'invalid decision' };

  const file = mainJsonlFile(userId, cid);
  const all = await readJsonl<GroupMessage>(file, 100_000);
  const target = all.find((m) => m.id === msgId);
  const req = target?.marketplace_requests?.find((r) => r.request_id === requestId) || null;
  if (!target || !req) return { ok: false, error: 'request not found' };
  if (req.status !== 'pending') return { ok: false, error: 'request already resolved' };
  if (req.kind !== 'agent' && req.kind !== 'skill') return { ok: false, error: 'invalid request kind' };
  if (!safeId(req.id) || !req.version || !Number.isFinite(req.published_at)) {
    return { ok: false, error: 'invalid marketplace request payload' };
  }

  if (decision === 'skip') {
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'skipped',
      resolved_at: nowIso(),
    });
    if (!patched.ok) return patched;
    return {
      ok: true,
      request: patched.request,
      submission: {
        text: _encodeMarketplaceInstallResult(patched.request, 'skipped'),
        agent_id: COMMANDER_ID,
      },
    };
  }

  try {
    if (req.kind === 'agent') {
      await marketplace.installMarketplaceAgent(req.id, {
        version: req.version,
        published_at: req.published_at,
        ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
      }, { name: req.name });
    } else {
      await marketplace.installMarketplaceSkill(req.id, {
        version: req.version,
        published_at: req.published_at,
        ...(typeof req.updated_at === 'number' ? { updated_at: req.updated_at } : {}),
      }, { name: req.name });
    }
    await _autoBindInstalledMarketplaceResource(userId, cid, req);
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'installed',
      resolved_at: nowIso(),
    });
    const request = patched.ok
      ? patched.request
      : { ...req, status: 'installed' as const, resolved_at: nowIso() };
    if (patched.ok === false) {
      log.warn(`marketplace request status update failed after install user=${userId} cid=${cid} msgId=${msgId}: ${patched.error}`);
    }
    return {
      ok: true,
      request,
      submission: {
        text: _encodeMarketplaceInstallResult(request, 'installed'),
        agent_id: COMMANDER_ID,
      },
    };
  } catch (err) {
    const installInfo = marketplace.getMarketplaceInstallErrorInfo(err);
    const failedKind = installInfo.kind || req.kind;
    const failedName = installInfo.name || (failedKind !== req.kind ? installInfo.id : '') || req.name || req.id;
    const failedKindLabel = failedKind === 'skill'
      ? t('marketplace_install_result.kind_skill')
      : t('marketplace_install_result.kind_agent');
    const error = `${failedKindLabel}: ${failedName} - ${installInfo.reason}`;
    const patched = await _patchMarketplaceRequest(userId, cid, msgId, requestId, {
      status: 'failed',
      resolved_at: nowIso(),
      error,
    });
    const request = patched.ok ? patched.request : { ...req, status: 'failed' as const, resolved_at: nowIso(), error };
    return {
      ok: true,
      request,
      install_error: {
        kind: failedKind,
        id: installInfo.id || '',
        name: failedName,
        reason: installInfo.reason,
      },
      submission: {
        text: _encodeMarketplaceInstallResult(request, 'failed', error),
        agent_id: COMMANDER_ID,
      },
    };
  }
}

// ── Read messages (UI initial load) ──────────────────────────────────────

export async function readMessages(userId: string, cid: string, limit = 500): Promise<GroupMessage[]> {
  if (!safeId(cid)) return [];
  return (await readJsonl<GroupMessage>(conversationMessageReadFile(userId, cid), limit))
    .filter((msg) => !msg.deleted_at);
}

/** Delete visible messages as versioned tombstones in the main log and all
 * actor slices. Persistent model sessions are purged so the next turn is
 * rebuilt from the filtered slices rather than retaining deleted context. */
export async function deleteMessages(
  userId: string,
  cid: string,
  messageIds: string[],
): Promise<{ ok: boolean; deleted: string[]; error?: string }> {
  if (!safeId(cid)) return { ok: false, deleted: [], error: 'invalid cid' };
  const ids = Array.from(new Set((Array.isArray(messageIds) ? messageIds : [])
    .filter((id) => typeof id === 'string' && safeId(id)))).slice(0, 100);
  if (!ids.length) return { ok: false, deleted: [], error: 'no messages selected' };
  const runtime = await runtimeStatus(userId, cid);
  if (runtime.processing) return { ok: false, deleted: [], error: 'conversation is running' };

  let mainFile: string;
  try {
    mainFile = await _ensureWritableConversationMessageFile(userId, cid);
  } catch (err) {
    log.warn('message delete legacy history promotion failed', { cid, error: logErrorRef(err) });
    return { ok: false, deleted: [], error: 'message history promotion failed' };
  }
  const mainRows = await readJsonl<GroupMessage>(mainFile, 100_000);
  const existing = new Set(mainRows
    .filter((msg) => ids.includes(msg.id) && !msg.deleted_at && !msg.dispatch)
    .map((msg) => msg.id));
  if (!existing.size) return { ok: false, deleted: [], error: 'messages not found' };

  const tombstoned = await _tombstoneMessagesEverywhere(userId, cid, existing, nowIso(), mainFile);
  if (tombstoned.ok === false) {
    log.error('message delete history rewrite failed', { cid, error: tombstoned.error });
    return { ok: false, deleted: [], error: 'message rewrite failed' };
  }

  try {
    await _resetConversationModelSessions(userId, cid);
  } catch (err) {
    log.warn('message delete session reset failed', { cid, error: logErrorRef(err) });
  }

  log.info(`messages-deleted user=${userId} cid=${cid} count=${existing.size}`);
  return { ok: true, deleted: Array.from(existing) };
}
