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
import { parseClaudeTranscript } from './transcript-normalize';
import { extractSession, type CognitionItem } from './extractor';
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
  reason?: string;
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
export async function importClaudeSession(input: ImportClaudeSessionInput): Promise<ImportSessionResult> {
  const zeroCounts: RoutedCognitionCounts = { personal: 0, rule: 0, template: 0 };

  const read = await readClaudeSessionTranscript(input.filePath);
  if (!read.ok) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: read.reason || 'unreadable' };
  }

  const transcript = parseClaudeTranscript(read.body, read.sessionId);
  if (!transcript.turns.length) {
    return { ok: false, cognitions: zeroCounts, degraded: true, reason: 'empty_transcript' };
  }

  const extraction = await extractSession(input.userId, transcript);

  const materialize = await materializeSession({
    userId: input.userId,
    source: 'claude',
    sourceId: transcript.sourceId,
    projectPath: transcript.projectPath,
    titleHint: input.titleHint,
    extraction,
  });

  // Route cognitions only when extraction produced usable structured output.
  let cognitions = zeroCounts;
  if (!extraction.degraded) {
    cognitions = await routeCognitions(
      input.userId,
      'claude',
      transcript.sourceId,
      materialize.conversationId,
      { personal: extraction.personal, rules: extraction.rules, templates: extraction.templates },
    );
  }

  log.info(
    `imported claude session=${transcript.sourceId} cid=${materialize.conversationId} ` +
    `degraded=${!!extraction.degraded} cog=${cognitions.personal}/${cognitions.rule}/${cognitions.template}`,
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
