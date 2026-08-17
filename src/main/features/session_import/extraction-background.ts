// ─── Background extraction (B+ fast import) ────────────────────────────────
//
// Import used to wait for the full read → normalize → extract → materialize
// pipeline, and the extraction model pass is the slow part (seconds to tens
// of seconds). B+ flips it: materialize returns instantly with a placeholder
// seed ("正在提炼"), and extraction runs in the background. When it finishes
// the seed message is rewritten in place with the real brief, the continuation
// snapshot is built from the real summary, cognitions are routed to Recall,
// and the renderer is notified (via the `sessionImport.events` stream) so the
// open conversation can swap "extracting" for the real carry details.
//
// State is persisted under <uid>/local/session_import/extractions.json so a
// reloaded renderer can still show the right phase, and a second import of
// the same session never starts a duplicate extraction.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { userLocalRoot } from '../../paths';
import { conversationMessageFile } from '../../util/project-layout';
import { nowIso, rewriteJsonlLine } from '../../storage';
import { extractSession, type ExtractionResult } from './extractor';
import { generateWelcomeMessage, type WelcomeMessageData } from './welcome-message';
import type { NormalizedTranscript } from './transcript-normalize';
import type { GroupMessage } from '../group_chat/visibility';

const log = createLogger('session-import:extraction-bg');

export type ExtractionPhase = 'pending' | 'done' | 'failed';

export interface ExtractionState {
  status: ExtractionPhase;
  startedAt: string;
  finishedAt?: string;
  reason?: string;
  cognitions?: { personal: number; rule: number; template: number };
  degraded?: boolean;
}

export interface ExtractionEvent {
  type: 'extraction_done' | 'extraction_failed';
  cid: string;
  /** Present on `extraction_done`: the full welcome data for the conversation
   *  panel (restatement / carry / plan / boundary). */
  welcome?: WelcomeMessageData;
  reason?: string;
}

/** Structural view of the asset-router prefetch result — defined locally so
 *  this module never imports asset-router (which imports us). */
export interface PreparedExtraction {
  ok: boolean;
  prepared?: {
    transcript: NormalizedTranscript;
    extraction: ExtractionResult;
  };
  reason?: string;
}

export interface BackgroundExtractionInput {
  userId: string;
  source: string;
  sourceId: string;
  conversationId: string;
  projectId: string | null;
  transcript: NormalizedTranscript;
  seedMsgIndex: number;
  title: string;
  /** Optional read+extract producer (usually the prefetch cache). When
   *  provided it is awaited instead of a fresh `extractSession`, so an
   *  in-flight prefetch is consumed rather than duplicated. */
  prepare?: () => Promise<PreparedExtraction>;
}

function stateFile(userId: string): string {
  return path.join(userLocalRoot(userId), 'session_import', 'extractions.json');
}

async function readState(userId: string): Promise<Record<string, ExtractionState>> {
  try {
    const raw = await fs.readFile(stateFile(userId), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, ExtractionState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(userId: string, next: Record<string, ExtractionState>): Promise<void> {
  await fs.mkdir(path.dirname(stateFile(userId)), { recursive: true });
  await fs.writeFile(stateFile(userId), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export async function getExtractionState(userId: string, cid: string): Promise<ExtractionState | null> {
  const all = await readState(userId);
  return all[cid] || null;
}

// ── Event bus: renderer stream (`sessionImport.events`) subscribes here. ──
type ExtractionListener = (ev: ExtractionEvent) => void;
const listeners = new Set<ExtractionListener>();

export function subscribeExtractionEvents(listener: ExtractionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(ev: ExtractionEvent): void {
  for (const listener of listeners) {
    try {
      listener(ev);
    } catch (err) {
      log.warn('extraction event listener threw', { error: String(err) });
    }
  }
}

/** Whether a conversation is still waiting for its background extraction. */
export function isExtractionPending(state: ExtractionState | null | undefined): boolean {
  return !!state && state.status === 'pending';
}

/**
 * Start (or join) the background extraction for one imported conversation.
 * Idempotent per conversation: a pending or finished extraction is never
 * restarted. Returns immediately; the model pass runs detached.
 */
export function startBackgroundExtraction(input: BackgroundExtractionInput): void {
  const { userId, conversationId: cid } = input;
  void (async () => {
    try {
      const existing = await getExtractionState(userId, cid);
      if (existing && (existing.status === 'pending' || existing.status === 'done')) {
        return; // already running or finished — no duplicate work
      }
      await writeState(userId, {
        ...(await readState(userId)),
        [cid]: { status: 'pending', startedAt: nowIso() },
      });

      // Prefer the prefetch producer (already read+extracting); otherwise run
      // a fresh extraction over the transcript we materialized with.
      let extraction: ExtractionResult;
      let transcript = input.transcript;
      if (input.prepare) {
        const prep = await input.prepare();
        if (!prep.ok || !prep.prepared) {
          await writeState(userId, {
            ...(await readState(userId)),
            [cid]: {
              status: 'failed',
              startedAt: nowIso(),
              finishedAt: nowIso(),
              reason: prep.reason || 'prepare_failed',
              degraded: true,
            },
          });
          emit({ type: 'extraction_failed', cid, reason: prep.reason || 'prepare_failed' });
          return;
        }
        extraction = prep.prepared.extraction;
        transcript = prep.prepared.transcript;
      } else {
        extraction = await extractSession(userId, input.transcript);
      }
      await commitExtraction({ ...input, transcript }, extraction);
    } catch (err) {
      log.error('background extraction failed', {
        cid,
        error: (err as Error)?.message || String(err),
      });
      await writeState(userId, {
        ...(await readState(userId)),
        [cid]: {
          status: 'failed',
          startedAt: nowIso(),
          finishedAt: nowIso(),
          reason: (err as Error)?.message || String(err),
        },
      });
      emit({ type: 'extraction_failed', cid, reason: (err as Error)?.message || String(err) });
    }
  })();
}

async function commitExtraction(input: BackgroundExtractionInput, extraction: ExtractionResult): Promise<void> {
  const { userId, conversationId: cid, projectId, seedMsgIndex } = input;

  if (extraction.degraded || !extraction.sessionSummary) {
    const reason = extraction.reason || 'all_passes_failed';
    await writeState(userId, {
      ...(await readState(userId)),
      [cid]: {
        status: 'failed',
        startedAt: nowIso(),
        finishedAt: nowIso(),
        reason,
        degraded: true,
      },
    });
    emit({ type: 'extraction_failed', cid, reason });
    return;
  }

  // ① Rewrite the placeholder seed with the real distilled brief.
  if (seedMsgIndex >= 0) {
    try {
      const msgFile = conversationMessageFile(userId, cid, projectId);
      await rewriteJsonlLine<GroupMessage>(msgFile, seedMsgIndex, (current) => {
        const src = input.source;
        const summary = extraction.sessionSummary.trim();
        return {
          ...current,
          text: `[从 ${src} 导入 · 已提炼]\n\n${summary}`,
          model_text:
            `以下是用户从 ${src} 导入的一段历史会话的提炼简报。` +
            `请把它当作已发生的上下文，在此基础上继续协助用户，不要重复已完成的工作：\n\n${summary}`,
        };
      });
    } catch (seedErr) {
      log.warn('failed to rewrite seed message after extraction', {
        cid,
        error: (seedErr as Error)?.message || String(seedErr),
      });
    }
  }

  // ② Build the real continuation snapshot (skipped during placeholder
  //    materialize so the summary is never fabricated).
  try {
    const { buildContinuationSnapshot } = await import('../task_continuation');
    await buildContinuationSnapshot({
      userId,
      conversationId: cid,
      projectId,
      sessionSummary: extraction.sessionSummary,
      title: input.title,
    });
  } catch (snapErr) {
    log.warn('background extraction: continuation snapshot failed', {
      cid,
      error: (snapErr as Error)?.message || String(snapErr),
    });
  }

  // ③ Route cognitions to Recall (the asset side of the extraction).
  // Dynamic import to avoid a cycle (asset-router imports this module).
  let cognitions = { personal: 0, rule: 0, template: 0 };
  try {
    const { routeCognitions } = await import('./asset-router');
    cognitions = await routeCognitions(
      userId,
      input.source,
      input.sourceId,
      cid,
      { personal: extraction.personal, rules: extraction.rules, templates: extraction.templates },
    );
  } catch (routeErr) {
    log.warn('background extraction: cognition routing failed', {
      cid,
      error: (routeErr as Error)?.message || String(routeErr),
    });
  }

  // ④ Build the welcome payload the renderer swaps into the conversation.
  let welcome: WelcomeMessageData | undefined;
  try {
    welcome = await generateWelcomeMessage({
      userId,
      conversationId: cid,
      sessionSummary: extraction.sessionSummary,
    });
  } catch (welcomeErr) {
    log.warn('background extraction: welcome generation failed', {
      cid,
      error: (welcomeErr as Error)?.message || String(welcomeErr),
    });
  }

  await writeState(userId, {
    ...(await readState(userId)),
    [cid]: {
      status: 'done',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      cognitions,
      degraded: false,
    },
  });

  log.info(`background extraction done cid=${cid} cog=${cognitions.personal}/${cognitions.rule}/${cognitions.template}`);
  emit({ type: 'extraction_done', cid, welcome });
}
