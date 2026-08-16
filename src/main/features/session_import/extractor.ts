/**
 * Session compression + cognition extraction (stage 2).
 *
 * Takes a NormalizedTranscript and, in one model pass (or a map-reduce over
 * chunks when the transcript is long), produces:
 *
 *   - `sessionSummary`  — a compact "where we left off" brief that becomes the
 *                         seed message of the materialised conversation, so the
 *                         user can continue without carrying the raw history
 *                         (avoids blowing the context window).
 *   - `personal[]`      — "关于我" candidate facts (preferences, background)
 *   - `rules[]`         — "规则与判断" candidate rules the user set/corrected
 *   - `templates[]`     — "模板与范例" reusable artifacts/formats observed
 *
 * The three cognition arrays map 1:1 onto Recall's AbilityAssetType values
 * ('personal' | 'rule' | 'template'), so the asset-router (stage 4) can hand
 * them straight to `saveRecallCandidate` with no translation layer.
 *
 * Model access uses `chatWithModel` with `disableTools:true` — this is a pure
 * text summarisation call against whichever provider the user connected in the
 * onboarding first step. No tools, no file access.
 *
 * Robustness:
 *   - The model is asked for strict JSON; we parse defensively (strip code
 *     fences, locate the outermost object) and degrade to "summary only, no
 *     cognitions" rather than throwing when the JSON is unusable.
 *   - Long transcripts are chunked under a token budget and summarised
 *     per-chunk, then the partial summaries are reduced into one final pass.
 */

import { chatWithModel } from '../../model/core-agent/client';
import { createLogger } from '../../logger';
import {
  estimateTokens,
  renderTranscript,
  type NormalizedTranscript,
  type TranscriptTurn,
} from './transcript-normalize';
import { EXTRACT_SYSTEM_PROMPT } from '../../prompts/session-extract';

const log = createLogger('session-import:extractor');

/** Max transcript tokens fed to the model in a single pass. Transcripts above
 *  this are chunked and map-reduced. Raised from the original 6000 → 14000 →
 *  48000: fewer/larger chunks means fewer model round trips, and each pass is
 *  the dominant import cost (tens of seconds on the user's configured model).
 *  48000 stays comfortably inside modern provider context windows. */
const CHUNK_TOKEN_BUDGET = 48000;

/** How many chunk passes run at once. The model client guards everything with
 *  a 5-slot global semaphore, so we stay under that to leave headroom for any
 *  other in-flight model work (and avoid starving the whole app during a big
 *  import). Each extractor pass uses its own anon session, so there's no
 *  per-session mutex contention between them. */
const MAP_CONCURRENCY = 3;

/** Run `task` over `items` with at most `limit` in flight at once, preserving
 *  input order in the returned results. A rejected task rejects the whole
 *  batch — callers that want best-effort should have tasks resolve to a
 *  sentinel instead of throwing. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await task(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface CognitionItem {
  /** One-line human-readable statement. */
  text: string;
  /** Optional short rationale / evidence phrase from the transcript. */
  note?: string;
}

export interface ExtractionResult {
  ok: boolean;
  /** Seed brief for the continued conversation (may be a degraded fallback). */
  sessionSummary: string;
  personal: CognitionItem[];
  rules: CognitionItem[];
  templates: CognitionItem[];
  /** Set when we could not get usable structured output and fell back. */
  degraded?: boolean;
  reason?: string;
}

/** Split turns into chunks each under CHUNK_TOKEN_BUDGET tokens. Keeps whole
 *  turns together; a single oversized turn becomes its own (truncated) chunk. */
function chunkTurns(turns: TranscriptTurn[]): TranscriptTurn[][] {
  const chunks: TranscriptTurn[][] = [];
  let current: TranscriptTurn[] = [];
  let currentTokens = 0;

  for (const turn of turns) {
    const turnTokens = estimateTokens(turn.text);
    if (currentTokens + turnTokens > CHUNK_TOKEN_BUDGET && current.length) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    if (turnTokens > CHUNK_TOKEN_BUDGET) {
      // Oversized single turn — truncate to the budget so one giant paste
      // can't blow the pass. Keep the head (usually the instruction/context).
      const budgetChars = CHUNK_TOKEN_BUDGET * 4;
      chunks.push([{ ...turn, text: turn.text.slice(0, budgetChars) }]);
      continue;
    }
    current.push(turn);
    currentTokens += turnTokens;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Strip markdown code fences and isolate the outermost {...} so a model that
 *  wraps JSON in prose or ```json fences still parses. Returns null when no
 *  balanced object is found. */
function extractJsonObject(raw: string): unknown | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/** Coerce an unknown value into a CognitionItem[] defensively. */
function toCognitionItems(value: unknown): CognitionItem[] {
  if (!Array.isArray(value)) return [];
  const items: CognitionItem[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) items.push({ text });
    } else if (entry && typeof entry === 'object') {
      const text = String((entry as { text?: unknown }).text ?? '').trim();
      if (!text) continue;
      const note = String((entry as { note?: unknown }).note ?? '').trim();
      items.push(note ? { text, note } : { text });
    }
  }
  return items;
}

interface RawExtraction {
  summary: string;
  personal: CognitionItem[];
  rules: CognitionItem[];
  templates: CognitionItem[];
}

function parseExtraction(raw: string): RawExtraction | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  return {
    summary,
    personal: toCognitionItems(o.personal),
    rules: toCognitionItems(o.rules),
    templates: toCognitionItems(o.templates),
  };
}

/** One model pass over a rendered transcript slice. */
async function runPass(userId: string, systemPrompt: string, content: string): Promise<string | null> {
  const res = await chatWithModel({
    userId,
    message: content,
    systemPrompt,
    disableTools: true,
  });
  if (!res.ok || !res.text) {
    log.warn('extraction model pass failed', { error: res.error });
    return null;
  }
  return res.text;
}

/**
 * Compress a transcript and extract cognitions.
 *
 * `userId` selects the provider (the one connected during onboarding).
 * Returns a best-effort result; `degraded:true` means we could not get usable
 * structured JSON and fell back to a minimal summary.
 */
export async function extractSession(
  userId: string,
  transcript: NormalizedTranscript,
): Promise<ExtractionResult> {
  const empty: ExtractionResult = {
    ok: false,
    sessionSummary: '',
    personal: [],
    rules: [],
    templates: [],
  };

  if (!transcript.turns.length) {
    return { ...empty, degraded: true, reason: 'empty_transcript' };
  }

  const chunks = chunkTurns(transcript.turns);

  // Single-pass fast path.
  if (chunks.length === 1) {
    const rendered = renderTranscript(chunks[0]);
    const out = await runPass(userId, EXTRACT_SYSTEM_PROMPT, rendered);
    if (!out) return fallback(transcript, 'model_unavailable');
    const parsed = parseExtraction(out);
    if (!parsed) return fallback(transcript, 'unparseable_json');
    return {
      ok: true,
      sessionSummary: parsed.summary || fallbackSummary(transcript),
      personal: parsed.personal,
      rules: parsed.rules,
      templates: parsed.templates,
    };
  }

  // Map: summarise each chunk to a partial extraction, up to MAP_CONCURRENCY
  // passes in flight at once. Each pass is best-effort — a failed/unparseable
  // pass yields null and is dropped, never aborting the batch.
  const mapped = await mapWithConcurrency(chunks, MAP_CONCURRENCY, async (chunk) => {
    const out = await runPass(userId, EXTRACT_SYSTEM_PROMPT, renderTranscript(chunk));
    if (!out) return null;
    return parseExtraction(out);
  });
  const partials: RawExtraction[] = mapped.filter((p): p is RawExtraction => p != null);

  if (!partials.length) return fallback(transcript, 'all_passes_failed');

  // No reduce pass: merging per-chunk summaries + deduping cognitions is done
  // locally. A reduce pass was one more full model call — the dominant cost
  // on long transcripts — for marginal coherence gains.
  return {
    ok: true,
    sessionSummary:
      partials.map((p) => p.summary).filter(Boolean).join('\n\n') ||
      fallbackSummary(transcript),
    personal: dedupeItems(partials.flatMap((p) => p.personal)),
    rules: dedupeItems(partials.flatMap((p) => p.rules)),
    templates: dedupeItems(partials.flatMap((p) => p.templates)),
  };
}

/** Minimal, honest fallback when the model can't be used or its output is
 *  unusable: keep the session importable (seed = first user turn) but claim no
 *  cognitions, and flag degraded so the UI can be honest about it. */
function fallback(transcript: NormalizedTranscript, reason: string): ExtractionResult {
  return {
    ok: false,
    sessionSummary: fallbackSummary(transcript),
    personal: [],
    rules: [],
    templates: [],
    degraded: true,
    reason,
  };
}

function fallbackSummary(transcript: NormalizedTranscript): string {
  const firstUser = transcript.turns.find((t) => t.role === 'user');
  const head = firstUser ? firstUser.text.slice(0, 500) : '';
  return head || '(导入的会话没有可提炼的文本内容)';
}

/** Case-insensitive dedupe on `text`. */
function dedupeItems(items: CognitionItem[]): CognitionItem[] {
  const seen = new Set<string>();
  const out: CognitionItem[] = [];
  for (const item of items) {
    const key = item.text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
