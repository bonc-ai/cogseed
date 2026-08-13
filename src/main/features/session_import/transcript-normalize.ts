/**
 * Transcript normalization for session import.
 *
 * Converts a raw Claude Code jsonl transcript (READ-ONLY, from
 * `~/.claude/projects/<enc>/<uuid>.jsonl`) into a provider-agnostic
 * `NormalizedTranscript` — a flat list of `{ role, text, ts }` turns with
 * internal/tool noise stripped. This is the single shape the extractor
 * (stage 2) consumes, so adding a second source agent later only means
 * writing another `parse<Source>` that returns `NormalizedTranscript`.
 *
 * Boundaries:
 *   - Pure function over already-read bytes. No fs, no network. The caller
 *     (claude_sessions.readClaudeSessionTranscript) owns the read.
 *   - Best-effort. Malformed lines are skipped, never thrown.
 *   - Lossy on purpose. Tool calls, thinking blocks and queue-operations are
 *     dropped; we keep human-readable user/assistant text only, which is what
 *     the summariser needs and keeps token cost bounded.
 */

export type TranscriptRole = 'user' | 'assistant';

export interface TranscriptTurn {
  role: TranscriptRole;
  /** Plain text, already trimmed. Never empty (empty turns are dropped). */
  text: string;
  /** ISO timestamp when available, else ''. */
  ts: string;
}

export interface NormalizedTranscript {
  /** Source agent this transcript came from. */
  source: 'claude' | 'workbuddy';
  /** Original session/transcript id (jsonl filename stem for Claude/WorkBuddy). */
  sourceId: string;
  /** Original working directory / project path, when the source recorded it. */
  projectPath: string;
  turns: TranscriptTurn[];
}

/** One parsed jsonl object from Claude Code's transcript format. */
interface ClaudeJsonlLine {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  cwd?: string;
  timestamp?: string;
}

/** Extract plain text from Claude's `message.content`, which is either a bare
 *  string (Claude Code 2.1.220+) or an array of typed content blocks. Only
 *  `type:'text'` blocks contribute; tool_use / tool_result / thinking blocks
 *  are intentionally dropped. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: unknown }).text;
        if (typeof t === 'string' && t.trim()) parts.push(t.trim());
      }
    }
    return parts.join('\n\n').trim();
  }
  return '';
}

/**
 * Parse a full Claude Code jsonl transcript body into a NormalizedTranscript.
 * `body` is the raw file contents; `sourceId` is the session uuid.
 */
export function parseClaudeTranscript(
  body: string,
  sourceId: string,
): NormalizedTranscript {
  const turns: TranscriptTurn[] = [];
  let projectPath = '';

  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let obj: ClaudeJsonlLine;
    try {
      obj = JSON.parse(line) as ClaudeJsonlLine;
    } catch {
      continue; // malformed line — skip, best-effort
    }

    if (obj.cwd && !projectPath) projectPath = obj.cwd;

    const role = obj.type === 'user' ? 'user' : obj.type === 'assistant' ? 'assistant' : null;
    if (!role) continue; // queue-operation / summary / internal — skip
    if (obj.message?.role && obj.message.role !== role) continue;

    const text = textFromContent(obj.message?.content);
    if (!text) continue; // tool-only / empty turn — skip

    turns.push({ role, text, ts: typeof obj.timestamp === 'string' ? obj.timestamp : '' });
  }

  return { source: 'claude', sourceId, projectPath, turns };
}

/** One parsed jsonl object from WorkBuddy's transcript format. Unlike
 *  Claude Code, `role` and `content` sit at the TOP LEVEL (not under
 *  `message`), the record type is `"message"`, and `timestamp` is an
 *  epoch-ms number. */
interface WorkbuddyJsonlLine {
  type?: string;
  role?: string;
  content?: unknown;
  timestamp?: number | string;
}

/** Extract plain text from a WorkBuddy content array. For user turns the
 *  real prompt is wrapped in `<user_query>…</user_query>` inside a big
 *  system-reminder blob — we pull that out and drop reminder scaffolding.
 *  Assistant turns keep `text` / `output_text` items and drop `thinking`. */
function workbuddyTextFromContent(role: TranscriptRole, content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const t = (block as { type?: string }).type;
    const rawText = (block as { text?: unknown }).text;
    const raw = typeof rawText === 'string' ? rawText : '';
    if (!raw) continue;
    if (role === 'user') {
      const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(raw);
      if (m && m[1].trim()) { parts.push(m[1].trim()); continue; }
      if (raw.trimStart().startsWith('<system-reminder')) continue;
      if (t === 'input_text' || t === 'text') parts.push(raw.trim());
    } else {
      if (t === 'text' || t === 'output_text') parts.push(raw.trim());
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * Parse a full WorkBuddy jsonl transcript body into a NormalizedTranscript.
 * Mirrors `parseClaudeTranscript` but for WorkBuddy's top-level
 * `role`/`content` shape and epoch-ms timestamps. `body` is the raw file
 * contents; `sourceId` is the session uuid.
 */
export function parseWorkbuddyTranscript(
  body: string,
  sourceId: string,
): NormalizedTranscript {
  const turns: TranscriptTurn[] = [];

  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    let obj: WorkbuddyJsonlLine;
    try {
      obj = JSON.parse(line) as WorkbuddyJsonlLine;
    } catch {
      continue; // malformed line — skip, best-effort
    }

    if (obj.type !== 'message') continue; // status/snapshot/ai-title — skip
    const role: TranscriptRole | null =
      obj.role === 'user' ? 'user' : obj.role === 'assistant' ? 'assistant' : null;
    if (!role) continue;

    const text = workbuddyTextFromContent(role, obj.content);
    if (!text) continue; // reminder-only / tool-only / empty turn — skip

    let ts = '';
    if (typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp)) {
      try { ts = new Date(obj.timestamp).toISOString(); } catch { ts = ''; }
    } else if (typeof obj.timestamp === 'string') {
      const d = new Date(obj.timestamp);
      ts = Number.isNaN(d.getTime()) ? '' : d.toISOString();
    }

    turns.push({ role, text, ts });
  }

  // WorkBuddy encodes the workdir in the parent dir name, not per-line; the
  // caller supplies projectPath via the summary, so we leave it '' here.
  return { source: 'workbuddy', sourceId, projectPath: '', turns };
}

/** Rough token estimate (chars/4) for the extractor's chunking budget. Kept
 *  local so normalization has no dependency on any tokenizer package. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Render a normalized transcript back to a plain `Role: text` block for
 *  feeding to the summariser. Turns are separated by blank lines. */
export function renderTranscript(turns: TranscriptTurn[]): string {
  return turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n\n');
}
