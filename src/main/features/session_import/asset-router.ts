/**
 * Asset router + import orchestrator (stage 4, and the entry that ties
 * stages 1-3 together).
 *
 * Two responsibilities:
 *
 *   1. `importClaudeSession` — the full single-session pipeline:
 *        read transcript (stage 1) → normalize → extract/compress (stage 2)
 *        → materialize into a continuable conversation (stage 3)
 *        → route extracted cognitions into Recall's candidate pool (stage 4).
 *
 *   2. `routeCognitions` — the stage-4 mapping itself. The three extracted
 *      cognition buckets map 1:1 onto Recall's AbilityAssetType:
 *        personal  → suggestedType 'personal'   (关于我)
 *        rules     → suggestedType 'rule'       (规则与判断)
 *        templates → suggestedType 'template'   (模板与范例)
 *      Each becomes a *pending* candidate the user later confirms in the
 *      Recall review page — imported entities (the conversation) are direct,
 *      but model-inferred cognitions always go through human confirmation.
 *
 * ## Recall isolation boundary
 *
 * This module is the ONLY place the session-import feature touches Recall, and
 * it touches it through exactly one public function: `saveRecallCandidate`.
 * It never imports Recall's internal stores/services. If a teammate reshapes
 * Recall's internals, nothing here breaks; only a change to
 * `SaveRecallCandidateInput`'s shape would, and that is a single call site to
 * update.
 *
 * Idempotency: each cognition gets a deterministic `captureKey` derived from
 * (source, sourceId, type, text), so re-importing the same session does not
 * create duplicate candidates — `saveRecallCandidate` returns the existing one.
 */

import { createHash } from 'node:crypto';

import { saveRecallCandidate } from '../recall/candidate-service';
import { readClaudeSessionTranscript } from '../local_agents/claude_sessions';
import { listClaudeDesktopSessions } from '../local_agents/claude_desktop_sessions';
import { parseClaudeTranscript, parseWorkbuddyTranscript, type NormalizedTranscript } from './transcript-normalize';
import { readWorkbuddySessionTranscript } from '../local_agents/workbuddy_sessions';
import { extractSession, type CognitionItem, type ExtractionResult } from './extractor';
import { materializeSession, type MaterializeResult } from './materialize';
import { createLogger } from '../../logger';

const log = createLogger('session-import:asset-router');

/** Recall candidate types this feature emits (subset of AbilityAssetType). */
type EmittedType = 'personal' | 'rule' | 'template';

export interface RoutedCognitionCounts {
  personal: number;
  rule: number;
  template: number;
}

export interface ImportSessionResult {
  ok: boolean;
  conversationId?: string;
  materialize?: MaterializeResult;
  cognitions: RoutedCognitionCounts;
  degraded: boolean;
  /** Transcript was too large to read whole; only recent turns were imported. */
  truncated?: boolean;
  reason?: string;
}

/* ------------------------------------------------------------------------- *
 * Prefetch: the read+extract phase, cached.
 *
 * The import pipeline has two halves with very different costs and side
 * effects:
 *   - read → normalize → extract   : READ-ONLY, and the extract step is the
 *       slow one (a distillation model call, ~10-30s). Nothing user-visible
 *       is created; it is pure computation over a transcript already on disk.
 *   - materialize → route          : the WRITES (a continuable conversation +
 *       Recall candidates), millisecond-level once the extraction is in hand.
 *
 * So we let the read+extract half run *ahead of the click* — e.g. the moment
 * the onboarding recommendation resolves — and cache its result. When the user
 * actually chooses "continue this project", `importClaudeSession` finds the
 * cached extraction and only runs the fast write half. If prefetch hasn't
 * finished (or was never started), import falls back to running read+extract
 * inline, so behaviour is identical — just not sped up.
 *
 * The cache holds no side effects: an entry is a read-only transcript plus its
 * extraction. Keyed by (source, userId, filePath) so it can never cross users,
 * and TTL-bounded so a stale transcript is not reused indefinitely.
 * ------------------------------------------------------------------------- */

/** Read-only result of the prefetchable half (read → normalize → extract). */
interface PreparedSession {
  source: 'claude' | 'workbuddy';
  transcript: NormalizedTranscript;
  extraction: ExtractionResult;
  truncated: boolean;
}

/** `ok` discriminates: `prepared` is set on success, `reason` on failure.
 *  Flat (not a union) because the project builds with `strictNullChecks:false`,
 *  where a boolean-discriminated union doesn't narrow on `!prep.ok`. */
interface PreparedResult {
  ok: boolean;
  prepared?: PreparedSession;
  reason?: string;
}

interface PrefetchEntry {
  at: number;
  promise: Promise<PreparedResult>;
}

/** A prepared session older than this is re-read rather than reused, so an
 *  edited/rotated transcript is never imported from a stale snapshot. */
const PREFETCH_TTL_MS = 10 * 60 * 1000;
const prefetchCache = new Map<string, PrefetchEntry>();

function prefetchKey(source: string, userId: string, filePath: string): string {
  return `${source}:${userId}:${filePath}`;
}

/**
 * Run the read+extract half through the cache. If a fresh entry exists (a
 * prefetch, in-flight or done) it is reused; otherwise `run` is invoked and its
 * promise cached. A failed prepare is evicted so the next attempt can retry.
 */
function getPrepared(
  source: 'claude' | 'workbuddy',
  userId: string,
  filePath: string,
  run: () => Promise<PreparedResult>,
): Promise<PreparedResult> {
  const key = prefetchKey(source, userId, filePath);
  const existing = prefetchCache.get(key);
  if (existing && Date.now() - existing.at < PREFETCH_TTL_MS) {
    return existing.promise;
  }
  const promise = run();
  prefetchCache.set(key, { at: Date.now(), promise });
  // Don't let a transient read/extract failure poison the cache.
  promise
    .then((r) => { if (!r.ok) prefetchCache.delete(key); })
    .catch(() => prefetchCache.delete(key));
  return promise;
}

/** read → normalize → extract for a Claude Code session (no writes). */
async function prepareClaudeSession(userId: string, filePath: string): Promise<PreparedResult> {
  const read = await readClaudeSessionTranscript(filePath);
  if (!read.ok) return { ok: false, reason: read.reason || 'unreadable' };
  const transcript = parseClaudeTranscript(read.body, read.sessionId);
  if (!transcript.turns.length) return { ok: false, reason: 'empty_transcript' };
  const extraction = await extractSession(userId, transcript);
  return { ok: true, prepared: { source: 'claude', transcript, extraction, truncated: !!read.truncated } };
}

/** read → normalize → extract for a WorkBuddy session (no writes). */
async function prepareWorkbuddySession(userId: string, filePath: string): Promise<PreparedResult> {
  const read = await readWorkbuddySessionTranscript(filePath);
  if (!read.ok) return { ok: false, reason: read.reason || 'unreadable' };
  const transcript = parseWorkbuddyTranscript(read.body, read.sessionId);
  if (!transcript.turns.length) return { ok: false, reason: 'empty_transcript' };
  const extraction = await extractSession(userId, transcript);
  return { ok: true, prepared: { source: 'workbuddy', transcript, extraction, truncated: !!read.truncated } };
}

export interface PrefetchSessionInput {
  userId: string;
  source: 'claude' | 'workbuddy';
  filePath: string;
}

export interface PrefetchSessionResult {
  ok: boolean;
  /** Extraction degraded (e.g. no distillation model configured). The later
   *  import still works; it just won't have model-inferred cognitions. */
  degraded?: boolean;
  reason?: string;
}

/**
 * Warm the read+extract cache for one session so a later import skips the slow
 * half. Safe to call speculatively: read-only, best-effort, and a no-op-ish
 * repeat call just returns the already-warming entry. Errors are swallowed into
 * `{ok:false, reason}` — a failed prefetch never blocks the eventual import,
 * which will simply run the pipeline inline.
 */
export async function prefetchImportSession(input: PrefetchSessionInput): Promise<PrefetchSessionResult> {
  try {
    const run = input.source === 'workbuddy'
      ? () => prepareWorkbuddySession(input.userId, input.filePath)
      : () => prepareClaudeSession(input.userId, input.filePath);
    const prep = await getPrepared(input.source, input.userId, input.filePath, run);
    if (!prep.ok) return { ok: false, reason: prep.reason };
    log.info(`prefetched ${input.source} session (degraded=${!!prep.prepared.extraction.degraded})`);
    return { ok: true, degraded: !!prep.prepared.extraction.degraded };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/** Deterministic capture key so the same cognition from the same imported
 *  session dedupes on re-import. Must pass `safeId` (hex is safe). */
function captureKeyFor(source: string, sourceId: string, type: EmittedType, text: string): string {
  const hash = createHash('sha256').update(`${source}:${sourceId}:${type}:${text}`).digest('hex').slice(0, 32);
  return `simport-${hash}`;
}

/** Route one cognition bucket into the candidate pool. Returns how many were
 *  written (existing/deduped ones still count as present). Best-effort per
 *  item: one bad item never aborts the batch. */
async function routeBucket(
  userId: string,
  items: CognitionItem[],
  type: EmittedType,
  conversationId: string,
  source: string,
  sourceId: string,
): Promise<number> {
  let count = 0;
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    try {
      await saveRecallCandidate(userId, {
        judgment: text,
        summary: item.note?.trim() || undefined,
        suggestedType: type,
        suggestedScope: 'personal',
        // Evidence points at the materialized conversation (kind:'conversation',
        // subtype defaults to 'session'). Non-empty sourceRefs is required.
        sourceRefs: [{ kind: 'conversation', id: conversationId, subtype: 'session' }],
        captureKey: captureKeyFor(source, sourceId, type, text),
      });
      count += 1;
    } catch (err) {
      log.warn('failed to route cognition candidate', { type, error: String(err) });
    }
  }
  return count;
}

/**
 * Route all three extracted cognition buckets into the Recall candidate pool.
 * `conversationId` is the materialized conversation used as evidence.
 */
export async function routeCognitions(
  userId: string,
  source: string,
  sourceId: string,
  conversationId: string,
  buckets: { personal: CognitionItem[]; rules: CognitionItem[]; templates: CognitionItem[] },
): Promise<RoutedCognitionCounts> {
  const [personal, rule, template] = await Promise.all([
    routeBucket(userId, buckets.personal, 'personal', conversationId, source, sourceId),
    routeBucket(userId, buckets.rules, 'rule', conversationId, source, sourceId),
    routeBucket(userId, buckets.templates, 'template', conversationId, source, sourceId),
  ]);
  return { personal, rule, template };
}

export interface ImportClaudeSessionInput {
  userId: string;
  /** jsonl path from `listClaudeSessions` (validated read-only by the reader). */
  filePath: string;
  /** First-message snippet from the picker, used to title a degraded import. */
  titleHint?: string;
}

/**
 * Full pipeline for one Claude Code session:
 * read → normalize → extract → materialize → route cognitions.
 *
 * Always returns a result (never throws for expected failures like an
 * unreadable transcript); `ok:false` + `reason` describes what degraded.
 * Even a degraded extraction still materializes a conversation so the user
 * gets *something* importable, honestly labeled.
 */
/**
 * The WRITE half: materialize the prepared transcript into a continuable
 * conversation and route its cognitions into Recall. Shared by both the Claude
 * and WorkBuddy import entries — the only per-source difference is upstream, in
 * how the transcript was read. Fast (no model call); the slow work already
 * happened in `prepare*`.
 */
async function commitPreparedSession(
  userId: string,
  prepared: PreparedSession,
  titleHint?: string,
): Promise<ImportSessionResult> {
  const zeroCounts: RoutedCognitionCounts = { personal: 0, rule: 0, template: 0 };
  const { source, transcript, extraction, truncated } = prepared;

  const materialize = await materializeSession({
    userId,
    source,
    sourceId: transcript.sourceId,
    projectPath: transcript.projectPath,
    titleHint,
    extraction,
  });

  // Route cognitions only when extraction produced usable structured output.
  let cognitions = zeroCounts;
  if (!extraction.degraded) {
    cognitions = await routeCognitions(
      userId,
      source,
      transcript.sourceId,
      materialize.conversationId,
      { personal: extraction.personal, rules: extraction.rules, templates: extraction.templates },
    );
  }

  log.info(
    `imported ${source} session=${transcript.sourceId} cid=${materialize.conversationId} ` +
    `degraded=${!!extraction.degraded} cog=${cognitions.personal}/${cognitions.rule}/${cognitions.template}`,
  );

  return {
    ok: !extraction.degraded,
    conversationId: materialize.conversationId,
    materialize,
    cognitions,
    degraded: !!extraction.degraded,
    truncated,
    reason: extraction.reason,
  };
}

export async function importClaudeSession(input: ImportClaudeSessionInput): Promise<ImportSessionResult> {
  const zeroCounts: RoutedCognitionCounts = { personal: 0, rule: 0, template: 0 };

  // Reuse a warm prefetch if present, otherwise run read+extract inline. Same
  // result either way — a hit just skips the slow model call.
  const prep = await getPrepared(
    'claude',
    input.userId,
    input.filePath,
    () => prepareClaudeSession(input.userId, input.filePath),
  );
  if (!prep.ok) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: prep.reason };
  }

  return commitPreparedSession(input.userId, prep.prepared, input.titleHint);
}

export interface ImportWorkbuddySessionInput {
  userId: string;
  /** jsonl path from `listWorkbuddySessions` (validated read-only by the reader). */
  filePath: string;
  /** First-message snippet from the picker, used to title a degraded import. */
  titleHint?: string;
  /** Decoded project/workdir from the picker summary; WorkBuddy does not
   *  record cwd per line, so the caller passes it through. */
  projectPath?: string;
}

/**
 * Full pipeline for one WorkBuddy session:
 * read → normalize → extract → materialize → route cognitions.
 *
 * Identical stages to `importClaudeSession`; only the read+parse front end
 * differs (WorkBuddy's top-level role/content jsonl shape). Always returns a
 * result; a degraded extraction still materializes a conversation so the
 * user gets something importable, honestly labeled. This is what makes a
 * WorkBuddy session become real, owned cognitive assets in CogSeed.
 */
export async function importWorkbuddySession(input: ImportWorkbuddySessionInput): Promise<ImportSessionResult> {
  const zeroCounts: RoutedCognitionCounts = { personal: 0, rule: 0, template: 0 };

  const prep = await getPrepared(
    'workbuddy',
    input.userId,
    input.filePath,
    () => prepareWorkbuddySession(input.userId, input.filePath),
  );
  if (!prep.ok) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: prep.reason };
  }

  // WorkBuddy has no per-line cwd; take the picker-supplied path if any. Same
  // session ⇒ same path, so overwriting the cached transcript is consistent.
  if (input.projectPath) prep.prepared.transcript.projectPath = input.projectPath;

  return commitPreparedSession(input.userId, prep.prepared, input.titleHint);
}

export interface ImportClaudeDesktopSessionInput {
  userId: string;
  /** `sessionId` from `listClaudeDesktopSessions`. */
  sessionId: string;
}

/**
 * Import one Claude **Desktop** session.
 *
 * Desktop sessions are metadata-only: the app stores the system prompt, model,
 * and opening message per workspace, but not the reply stream, so there is no
 * transcript to read. The single opening message becomes a one-turn synthetic
 * transcript and runs the same extract → materialize → route pipeline, which
 * gives the user a continuable conversation seeded with their original request.
 *
 * `sourceId` is prefixed `desktop-` so a desktop session can never collide with
 * a CLI session in the idempotency key, even if the two ever share a uuid.
 */
export async function importClaudeDesktopSession(
  input: ImportClaudeDesktopSessionInput,
): Promise<ImportSessionResult> {
  const zeroCounts: RoutedCognitionCounts = { personal: 0, rule: 0, template: 0 };

  const scan = await listClaudeDesktopSessions();
  if (!scan.ok) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: scan.error };
  }

  const meta = scan.sessions.find((s) => s.sessionId === input.sessionId);
  if (!meta) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: 'session_not_found' };
  }

  const opening = (meta.initialMessage || '').trim();
  if (!opening) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: 'empty_transcript' };
  }

  const sourceId = `desktop-${meta.sessionId}`;
  const transcript: NormalizedTranscript = {
    source: 'claude',
    sourceId,
    projectPath: meta.projectPath || '',
    turns: [{ role: 'user', text: opening, ts: meta.createdAt || '' }],
  };

  const extraction = await extractSession(input.userId, transcript);

  const materialize = await materializeSession({
    userId: input.userId,
    source: 'claude',
    sourceId,
    projectPath: transcript.projectPath,
    titleHint: meta.title || undefined,
    extraction,
  });

  let cognitions = zeroCounts;
  if (!extraction.degraded) {
    cognitions = await routeCognitions(
      input.userId,
      'claude',
      sourceId,
      materialize.conversationId,
      { personal: extraction.personal, rules: extraction.rules, templates: extraction.templates },
    );
  }

  log.info(
    `imported claude-desktop session=${sourceId} cid=${materialize.conversationId} ` +
    `degraded=${!!extraction.degraded}`,
  );

  return {
    ok: !extraction.degraded,
    conversationId: materialize.conversationId,
    materialize,
    cognitions,
    degraded: !!extraction.degraded,
    reason: extraction.reason,
  };
}
