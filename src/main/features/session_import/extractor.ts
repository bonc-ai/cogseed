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
 *   - `candidates[]`    — reusable cognition candidates. Each carries a
 *                         `suggestedType` in the four AbilityAssetType values
 *                         ('personal' | 'rule' | 'template' | 'skill_method')
 *                         plus the full candidate fields (value / risk /
 *                         suggestedAction / applicableWhen / forbiddenWhen),
 *                         using the SAME extraction rule as the recall capture
 *                         pipeline ("沉淀活动 → 从历史会话沉淀"). The
 *                         asset-router (stage 4) hands them straight to
 *                         `saveRecallCandidate` with no translation layer, so
 *                         imported and capture-derived candidates share one
 *                         pool and one confirmation flow.
 *
 * Model access uses `chatWithModel` with `disableTools:true` — this is a pure
 * text summarisation call against whichever provider the user connected in the
 * onboarding first step. No tools, no file access.
 *
 * Robustness:
 *   - The model is asked for strict JSON; we parse defensively (strip code
 *     fences, locate the outermost object) and degrade to "summary only, no
 *     cognitions" rather than throwing when the JSON is unusable.
 *   - The legacy three-bucket shape ({personal, rules, templates}) is still
 *     parsed when the model returns it, so old outputs/caches keep working.
 *   - Long transcripts are chunked under a token budget and summarised
 *     per-chunk, then the partial summaries are reduced into one final pass.
 */

import { chatWithModel } from '../../model/core-agent/client';
import { createLogger } from '../../logger';
import {
  esticogseedTokens,
  renderTranscript,
  type NormalizedTranscript,
  type TranscriptTurn,
} from './transcript-normalize';
import { EXTRACT_SYSTEM_PROMPT } from '../../prompts/session-extract';

const log = createLogger('session-import:extractor');

/** The four AbilityAssetType values emitted by this extractor. */
export type EmittedCognitionType = 'personal' | 'rule' | 'template' | 'skill_method';

/** How long a single CLI extraction pass may run before aborting. Local CLIs
 *  are slower than a raw model call (process spawn + model latency). */
const CLI_EXTRACT_TIMEOUT_MS = 120_000;

/** Run a single extraction pass through an installed local CLI agent when no
 *  CogSeed API model is configured (same no-model → CLI fallback as chat).
 *  Returns the CLI's final text, or null on failure/unavailable CLI. */
async function runCliExtractionPass(userId: string, systemPrompt: string, content: string): Promise<string | null> {
  try {
    const { run: runCliAgent } = await import('../local_agents/runner');
    const { pickBestCliForFallback } = await import('../local_agents/fallback-picker');
    const { tmpdir } = await import('node:os');
    // 与聊天降级同规则：优先 Claude Code → 已登录 CLI → 任意可用；
    // 跳过本地代理确认不可达的 CLI（否则派发给未登录/代理没开的 CLI 会
    // 在非 TTY 下挂到超时，每个 chunk pass 都白等 120s）。
    const chosen = await pickBestCliForFallback({ prefer: 'claude' });
    if (!chosen) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLI_EXTRACT_TIMEOUT_MS);
    try {
      const result = await runCliAgent({
        uid: userId,
        cid: 'session-import-extractor',
        agentId: 'session-import-extractor',
        agentName: 'Session Extractor',
        cli: chosen.type,
        prompt: `${systemPrompt}\n\n${content}`,
        cwd: tmpdir(),
        signal: controller.signal,
        skipDispatchCheck: true,
        onEvent: () => {},
      });
      if (result.status === 'completed' && typeof result.output === 'string' && result.output.trim()) {
        return result.output.trim();
      }
      log.warn('cli extraction pass did not complete', {
        cli: chosen.type,
        status: result.status,
        error: result.error,
      });
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    log.warn('cli extraction pass failed', { error: String(err) });
    return null;
  }
}

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

export interface CognitionCandidate {
  /** The reusable content itself (judgment), one sentence or two. */
  text: string;
  /** How it reduces future repetition or risk (value). */
  value?: string;
  /** Short title / summary. */
  note?: string;
  suggestedType: EmittedCognitionType;
  /** 'global' or the concrete project/domain it applies to. */
  suggestedScope?: string;
  /** Required for rule candidates: when it applies. */
  applicableWhen?: string[];
  /** Required for rule candidates: where it must not be used. */
  forbiddenWhen?: string[];
  /** create | update | limit_scope | pause | keep_current | reject. */
  suggestedAction?: string;
  /** low | medium | high. */
  risk?: string;
  /** Short excerpt from the transcript supporting the judgment. */
  evidence?: string;
  uncertainty?: string;
}

export interface ExtractionResult {
  ok: boolean;
  /** Seed brief for the continued conversation (may be a degraded fallback). */
  sessionSummary: string;
  candidates: CognitionCandidate[];
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
    const turnTokens = esticogseedTokens(turn.text);
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

/** Normalize a suggestedType string to one of the four emitted types. */
function normalizeType(value: unknown): EmittedCognitionType {
  const t = String(value ?? '').trim().toLowerCase();
  return t === 'rule' || t === 'template' || t === 'skill_method' ? t : 'personal';
}

/** Parse a string array field defensively: drop blanks, cap length. */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
    .slice(0, 10)
    .map((item) => item.slice(0, 300));
  return items.length ? items : undefined;
}

/** Read one candidate object's optional string field. */
function optString(o: Record<string, unknown>, key: string): string | undefined {
  const s = typeof o[key] === 'string' ? (o[key] as string).trim() : '';
  return s || undefined;
}

/** Coerce an unknown value into a CognitionCandidate[] defensively. Handles
 *  the new `candidates` array shape (objects with judgment/text + fields). */
function toCandidates(value: unknown): CognitionCandidate[] {
  if (!Array.isArray(value)) return [];
  const items: CognitionCandidate[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) items.push({ text, suggestedType: 'personal' });
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const text = String(o.judgment ?? o.text ?? '').trim();
      if (!text) continue;
      const candidate: CognitionCandidate = {
        text,
        suggestedType: normalizeType(o.suggestedType),
      };
      const note = optString(o, 'note') ?? optString(o, 'summary');
      if (note) candidate.note = note;
      const value = optString(o, 'value');
      if (value) candidate.value = value;
      const scope = optString(o, 'suggestedScope');
      if (scope) candidate.suggestedScope = scope;
      const action = optString(o, 'suggestedAction');
      if (action) candidate.suggestedAction = action;
      const risk = optString(o, 'risk');
      if (risk) candidate.risk = risk;
      const evidence = optString(o, 'evidence');
      if (evidence) candidate.evidence = evidence;
      const uncertainty = optString(o, 'uncertainty');
      if (uncertainty) candidate.uncertainty = uncertainty;
      const applicableWhen = toStringArray(o.applicableWhen);
      if (applicableWhen) candidate.applicableWhen = applicableWhen;
      const forbiddenWhen = toStringArray(o.forbiddenWhen);
      if (forbiddenWhen) candidate.forbiddenWhen = forbiddenWhen;
      items.push(candidate);
    }
  }
  return items;
}

/** Coerce a legacy three-bucket array (personal/rules/templates) into
 *  candidates with a fixed type. Kept so old model outputs still parse. */
function toLegacyCandidates(value: unknown, type: EmittedCognitionType): CognitionCandidate[] {
  if (!Array.isArray(value)) return [];
  const items: CognitionCandidate[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) items.push({ text, suggestedType: type });
    } else if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      const text = String(o.text ?? o.judgment ?? '').trim();
      if (!text) continue;
      const candidate: CognitionCandidate = { text, suggestedType: type };
      const note = optString(o, 'note') ?? optString(o, 'summary');
      if (note) candidate.note = note;
      const evidence = optString(o, 'evidence');
      if (evidence) candidate.evidence = evidence;
      items.push(candidate);
    }
  }
  return items;
}

interface RawExtraction {
  summary: string;
  candidates: CognitionCandidate[];
}

function parseExtraction(raw: string): RawExtraction | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const candidates = toCandidates(o.candidates);
  if (candidates.length) return { summary, candidates };
  // Legacy three-bucket shape — accept it so old outputs still import.
  const legacy = [
    ...toLegacyCandidates(o.personal, 'personal'),
    ...toLegacyCandidates(o.rules, 'rule'),
    ...toLegacyCandidates(o.templates, 'template'),
  ];
  return { summary, candidates: legacy };
}

/** One model pass over a rendered transcript slice. */
async function runPass(userId: string, systemPrompt: string, content: string): Promise<string | null> {
  // 优先用 CogSeed 模型（测试/真实有模型场景）。仅当模型调用因「未配置模型」
  // 抛错时，降级到本机 CLI agent 提炼（导入会话也能用外接 Agent）。
  try {
    const res = await chatWithModel({
      userId,
      message: content,
      systemPrompt,
      disableTools: true,
    });
    if (!res.ok || !res.text) {
      // chatWithModel 对「未配置模型」是返回 {ok:false,error} 而非抛错，
      // 这里同样按「未配置模型」降级到 CLI 提炼，否则提取永远失败。
      const msg = String((res && res.error) || '');
      const noModel = /未配置模型|no model configured|model.*not.*configured/i.test(msg);
      if (noModel) return runCliExtractionPass(userId, systemPrompt, content);
      log.warn('extraction model pass failed', { error: msg });
      return null;
    }
    return res.text;
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    const noModel = /未配置模型|no model configured|model.*not.*configured/i.test(msg);
    if (!noModel) {
      log.warn('extraction model pass threw', { error: msg });
      return null;
    }
    return runCliExtractionPass(userId, systemPrompt, content);
  }
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
    candidates: [],
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
      candidates: parsed.candidates,
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
    candidates: dedupeCandidates(partials.flatMap((p) => p.candidates)),
  };
}

/** Minimal, honest fallback when the model can't be used or its output is
 *  unusable: keep the session importable (seed = first user turn) but claim no
 *  cognitions, and flag degraded so the UI can be honest about it. */
function fallback(transcript: NormalizedTranscript, reason: string): ExtractionResult {
  return {
    ok: false,
    sessionSummary: fallbackSummary(transcript),
    candidates: [],
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
function dedupeCandidates(items: CognitionCandidate[]): CognitionCandidate[] {
  const seen = new Set<string>();
  const out: CognitionCandidate[] = [];
  for (const item of items) {
    const key = item.text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
