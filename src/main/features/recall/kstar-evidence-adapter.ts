/**
 * KSTAR evidence → recall candidate: the pure layer.
 *
 * Turns a batch of engine evidence records into per-run groups, and a group
 * plus a recognizer verdict into the input `saveRecallCandidate` expects.
 *
 * Deliberately side-effect free. Nothing here reads or writes disk, calls IPC,
 * touches the engine, or persists a candidate. The single side-effecting entry
 * point is not implemented yet — see "Deduplication scope" below for what that
 * means for correctness.
 *
 * Evidence shapes come from `features/p3394/kstar-bus-integration.ts`:
 *   tool_cycle           tool-{conv}-{agent}-{turn}-{toolCallId}
 *   agent_run_result     run-start-{conv}-{agent}-{turn}   (start phase only)
 *   conversation_message contribution-{conv}-{agent}-{turn}-{messageId}
 *   collaboration_close  collab-{conv}-{commander}-{Date.now()}
 *
 * Three structural facts drive the design:
 *
 * 1. `collaboration_close` embeds `Date.now()` in its id, so the same close
 *    replayed produces a different id and engine-side id dedup cannot collapse
 *    it. It is also conversation-scoped — it carries `commander_id`, not
 *    `agent_id`. It is therefore never part of a run key; it is only reported
 *    as a conversation close signal.
 * 2. `agent_run_result` only has a `start` phase. There is no per-run end
 *    record, so run completion can only come from the conversation-level close.
 * 3. A run is the unit of learning, not a single tool call. One execution
 *    emitting a dozen tool cycles must not become a dozen candidates.
 *
 * ## Deduplication scope
 *
 * There are three dedup layers. This module implements exactly one:
 *
 *   L1  engine, by `evidence.id`            — already implemented in the engine
 *   L2  run aggregation, by run key         — HERE, **within one batch only**
 *   L3  candidate store, by judgment+refs   — already in `saveRecallCandidate`
 *
 * L2 here collapses duplicate records inside the batch it is given. It has no
 * memory: feeding the same batch twice across process restarts produces the
 * same runs again, and this layer will not know they were already ingested.
 * Cross-restart dedup requires reading existing candidates, which is I/O and
 * therefore belongs to the side-effecting entry. `runAnchorRef()` exists to
 * make that lookup possible — it is the reserved hook, not a working guarantee.
 */
import { createHash } from 'node:crypto';

import { safeId } from '../../storage';
import {
  normalizeCognitionSourceRef,
  redactSourceExcerpt,
  type CognitionSourceInput,
  type CognitionSourceRef,
} from './source-service';
import type { AbilityAssetType, SaveRecallCandidateInput } from './candidate-service';

/** Separator for the human-readable run key. Never used as a ref id. */
const RUN_KEY_SEPARATOR = '::';
const MAX_SOURCE_REFS = 100;
const MAX_TITLE_LENGTH = 120;

export type EvidenceType =
  | 'tool_cycle'
  | 'agent_run_result'
  | 'conversation_message'
  | 'collaboration_close';

export interface EvidenceRecord {
  id: string;
  type?: string;
  conversation_id?: string;
  agent_id?: string;
  turn_id?: string;
  created_at?: string;
  boundary?: { mode?: string; provider?: string; reason?: string };
  [key: string]: unknown;
}

export interface EvidenceRun {
  /** `${conversationId}::${agentId}::${turnId}` — readable, not a ref id. */
  runKey: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  /** Ascending by `created_at`, deduplicated by evidence id. */
  toolCycles: EvidenceRecord[];
  /** Last contribution by `created_at`; a run reports one outcome. */
  contribution: EvidenceRecord | null;
  startedAt?: string;
  /**
   * True when any member was not produced by a confirmed real execution.
   * Missing boundary counts as degraded: absence of proof is not proof of a
   * real run, and an ability claim should not rest on unverifiable evidence.
   */
  degraded: boolean;
}

export interface ConversationClose {
  conversationId: string;
  outcomeStatus: string;
  evidenceId: string;
}

export type UnattributedReason = 'malformed' | 'incomplete_run';

export interface UnattributedRecord {
  evidenceId: string;
  reason: UnattributedReason;
}

export interface GroupedEvidence {
  runs: EvidenceRun[];
  /** Conversation-level close signals. Never folded into a run. */
  closes: ConversationClose[];
  /** Records that could not be attributed, with the reason, never dropped silently. */
  unattributed: UnattributedRecord[];
}

export type SkipReason =
  | 'no_judgment'
  | 'incomplete_run'
  | 'degraded_evidence'
  | 'no_evidence_refs';

/** What a candidate recognizer must supply. Only `judgment` is mandatory. */
export interface RecognizerOutput {
  judgment: string;
  summary?: string;
  uncertainty?: string;
  suggestedType?: AbilityAssetType;
  suggestedScope?: string;
  confidence?: number;
}

export type EvidenceRecognizer = (run: EvidenceRun) => Promise<RecognizerOutput | null>;

export type BuildCandidateResult =
  | { ok: true; input: SaveRecallCandidateInput }
  | { ok: false; reason: SkipReason };

/**
 * Reserved hook for cross-restart deduplication.
 *
 * The side-effecting entry point will resolve the set of run keys already
 * represented in stored candidates and skip them. Declared here so the contract
 * is visible; **not implemented and not called by anything in this module**.
 */
export type KnownRunKeyLookup = (userId: string) => Promise<ReadonlySet<string>>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nonEmpty(value: unknown): string | null {
  const s = text(value).trim();
  return s ? s : null;
}

function compact(value: unknown, max: number): string | undefined {
  const s = text(value).replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`;
}

export function makeRunKey(conversationId: string, agentId: string, turnId: string): string {
  return [conversationId, agentId, turnId].join(RUN_KEY_SEPARATOR);
}

/**
 * Stable anchor ref for a run.
 *
 * The id is a digest rather than the run key itself because `safeId` only
 * accepts `[A-Za-z0-9_-]`, so a `::`-joined key would be dropped during
 * normalization and the anchor would vanish without a trace. Joining the three
 * ids with a legal separator instead would be ambiguous — the ids may contain
 * that separator themselves, and two different runs could collide onto one key,
 * silently merging unrelated executions. The readable triple rides along in
 * `title` so the anchor stays debuggable.
 */
export function runAnchorRef(runKey: string): CognitionSourceRef {
  const digest = createHash('sha256').update(runKey).digest('hex').slice(0, 16);
  const ref = refIfUsable({
    kind: 'execution',
    id: `run-${digest}`,
    title: compact(runKey, MAX_TITLE_LENGTH) || runKey,
  });
  // id 是本函数拼出来的（`run-` + hex），必然通过 safeId；拿不到 ref 说明
  // source 分类规则变了，属于坏不变量，不能静默返回一个残缺锚点。
  if (!ref) throw new Error('run anchor ref failed normalization');
  return ref;
}

function isRealBoundary(record: EvidenceRecord): boolean {
  return record.boundary?.mode === 'real';
}

function byCreatedAt(a: EvidenceRecord, b: EvidenceRecord): number {
  return text(a.created_at).localeCompare(text(b.created_at));
}

/**
 * Group a batch of evidence into runs.
 *
 * Requires `conversation_id`, `agent_id` and `turn_id` together: without all
 * three a record cannot be attributed to one execution, and guessing would
 * merge unrelated work.
 */
export function groupEvidenceIntoRuns(records: readonly unknown[]): GroupedEvidence {
  const runs = new Map<string, EvidenceRun>();
  const seenIds = new Map<string, Set<string>>();
  const closes: ConversationClose[] = [];
  const unattributed: UnattributedRecord[] = [];

  for (const raw of Array.isArray(records) ? records : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      unattributed.push({ evidenceId: '', reason: 'malformed' });
      continue;
    }
    const record = raw as EvidenceRecord;
    const evidenceId = text(record.id);
    if (!evidenceId) {
      unattributed.push({ evidenceId: '', reason: 'malformed' });
      continue;
    }

    const conversationId = nonEmpty(record.conversation_id);

    // Conversation-scoped close: reported, never part of a run key.
    if (record.type === 'collaboration_close') {
      if (conversationId) {
        closes.push({
          conversationId,
          outcomeStatus: text(record.outcome_status),
          evidenceId,
        });
      } else {
        unattributed.push({ evidenceId, reason: 'incomplete_run' });
      }
      continue;
    }

    const agentId = nonEmpty(record.agent_id);
    const turnId = nonEmpty(record.turn_id);
    if (!conversationId || !agentId || !turnId) {
      unattributed.push({ evidenceId, reason: 'incomplete_run' });
      continue;
    }

    const runKey = makeRunKey(conversationId, agentId, turnId);
    let run = runs.get(runKey);
    if (!run) {
      run = {
        runKey,
        conversationId,
        agentId,
        turnId,
        toolCycles: [],
        contribution: null,
        degraded: false,
      };
      runs.set(runKey, run);
      seenIds.set(runKey, new Set());
    }

    // L2, within this batch: a replayed record must not count twice.
    const seen = seenIds.get(runKey)!;
    if (seen.has(evidenceId)) continue;
    seen.add(evidenceId);

    if (!isRealBoundary(record)) run.degraded = true;

    if (record.type === 'tool_cycle') {
      run.toolCycles.push(record);
    } else if (record.type === 'conversation_message') {
      if (!run.contribution || byCreatedAt(run.contribution, record) <= 0) run.contribution = record;
    } else if (record.type === 'agent_run_result') {
      const at = text(record.created_at);
      if (at && (!run.startedAt || at < run.startedAt)) run.startedAt = at;
    }
    // Unknown types still join the run for boundary purposes but contribute no
    // refs; they are not evidence this layer knows how to describe.
  }

  for (const run of runs.values()) run.toolCycles.sort(byCreatedAt);

  return { runs: [...runs.values()], closes, unattributed };
}

/** Refs are dropped by normalization unless their id is `safeId`-clean.
 *
 *  走 `normalizeCognitionSourceRef` 而不是自己拼字段：`taxonomyVersion` 与
 *  `subtype` 由 kind 推导，手写字面量会填错，而这两个字段决定证据在能力册里
 *  怎么归类。normalizer 内部已含同一套 safeId 校验。 */
function refIfUsable(ref: CognitionSourceInput): CognitionSourceRef | null {
  return normalizeCognitionSourceRef(ref) ?? null;
}

function toolCycleRef(record: EvidenceRecord): CognitionSourceRef | null {
  const status = text(record.status) || (record.is_error === true ? 'failed' : '');
  const title = compact([text(record.tool_name), status].filter(Boolean).join(' · '), MAX_TITLE_LENGTH);
  // `result_preview` is model/tool output and can carry credentials, so it only
  // reaches a candidate through the shared redactor. `arguments_shape` is never
  // included at all: it can hold paths and query strings that the redactor's
  // known-secret patterns would not catch.
  const excerpt = redactSourceExcerpt(record.result_preview);
  return refIfUsable({
    kind: 'execution',
    id: text(record.id),
    ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}),
    ...(isRealBoundary(record) ? {} : { degraded: true, reason: compact(record.boundary?.reason, MAX_TITLE_LENGTH) || 'boundary_not_real' }),
  });
}

function contributionRef(record: EvidenceRecord): CognitionSourceRef | null {
  const messageId = nonEmpty(record.message_id) || text(record.id);
  const excerpt = redactSourceExcerpt(record.actual_result);
  const title = compact(text(record.outcome_status), MAX_TITLE_LENGTH);
  return refIfUsable({
    kind: 'conversation',
    id: messageId,
    ...(title ? { title } : {}),
    ...(excerpt ? { excerpt } : {}),
  });
}

/**
 * Turn one run plus a recognizer verdict into candidate input.
 *
 * Checks run in a fixed order, most fundamental first: evidence we cannot trust,
 * then a run with nothing to learn from, then a missing claim. Each returns a
 * structured reason rather than null so the caller can report why an execution
 * produced no candidate.
 */
export function buildCandidateInput(
  run: EvidenceRun,
  recognized: RecognizerOutput | null,
): BuildCandidateResult {
  // Degraded evidence describes a run that did not really happen as recorded.
  // Deriving an ability claim from it would harden an unreliable experience.
  if (run.degraded) return { ok: false, reason: 'degraded_evidence' };

  // A run with no tool cycle and no contribution carries no observable work.
  if (!run.toolCycles.length && !run.contribution) return { ok: false, reason: 'no_evidence_refs' };

  // The judgment is a capability claim, and no field of the evidence stream
  // carries that meaning. Without a recognizer verdict there is nothing to
  // assert, and inventing one from a template would fill the register with
  // claims nobody made.
  const judgment = nonEmpty(recognized?.judgment);
  if (!judgment) return { ok: false, reason: 'no_judgment' };

  const anchors: CognitionSourceRef[] = [];
  anchors.push(runAnchorRef(run.runKey));
  const conversationAnchor = refIfUsable({ kind: 'conversation', id: run.conversationId });
  if (conversationAnchor) anchors.push(conversationAnchor);

  const contribution = run.contribution ? contributionRef(run.contribution) : null;
  const toolRefs = run.toolCycles.map(toolCycleRef).filter((r): r is CognitionSourceRef => r !== null);

  // Cap keeps the newest tool cycles: recent activity describes what the run
  // ended up doing, while the anchors and the outcome must always survive.
  const reserved = anchors.length + (contribution ? 1 : 0);
  const room = Math.max(0, MAX_SOURCE_REFS - reserved);
  const keptToolRefs = toolRefs.length > room ? toolRefs.slice(toolRefs.length - room) : toolRefs;

  const sourceRefs: CognitionSourceRef[] = [
    ...anchors,
    ...keptToolRefs,
    ...(contribution ? [contribution] : []),
  ];

  const input: SaveRecallCandidateInput = {
    judgment,
    ...(nonEmpty(recognized?.summary) ? { summary: recognized!.summary! } : {}),
    ...(nonEmpty(recognized?.uncertainty) ? { uncertainty: recognized!.uncertainty! } : {}),
    suggestedType: recognized?.suggestedType ?? 'skill_method',
    suggestedScope: nonEmpty(recognized?.suggestedScope) ?? `agent:${run.agentId}`,
    sourceRefs,
    // Absent stays absent; N2 rejects a fabricated default downstream.
    ...(recognized?.confidence !== undefined ? { confidence: recognized.confidence } : {}),
  };

  return { ok: true, input };
}
