/**
 * WorkBuddy (Tencent) session history reader.
 *
 * Reads `~/.workbuddy/projects/<encoded-path>/<uuid>.jsonl` files to list
 * past conversations for the onboarding "import sessions" step — the
 * WorkBuddy counterpart of claude_sessions.ts.
 *
 * **Constraints (identical guarantees to the Claude reader):**
 *   - READ-ONLY. Never writes to WorkBuddy's native storage.
 *   - Best-effort. Malformed/inaccessible files are skipped, not fatal.
 *   - Privacy: the picker reads only the first real user query + timestamp;
 *     the full transcript is read only when a session is selected to import.
 *
 * **Storage layout (WorkBuddy / codebuddy):**
 *   `~/.workbuddy/projects/<encoded-workdir>/<session-uuid>.jsonl`
 *   Each line is a JSON object. Relevant shape (differs from Claude Code):
 *     - `type:"message"` with a TOP-LEVEL `role` ("user" | "assistant")
 *       and TOP-LEVEL `content: [{ type, text }]` — NOT nested under
 *       `message` the way Claude Code stores it.
 *     - content item types: `input_text` (user), `text` / `output_text`
 *       (assistant), plus `thinking`.
 *     - `timestamp` is epoch MILLISECONDS (a number), not an ISO string.
 *     - The first user turn embeds a large `<system-reminder>` context
 *       blob; the actual prompt is wrapped in `<user_query>…</user_query>`.
 *       We extract that so the picker shows the real question, not the blob.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { createLogger } from '../../logger';

const log = createLogger('local-agents:workbuddy-sessions');

/** Above this size a transcript is read tail-only, to bound memory. */
const LARGE_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

/** Lines retained from the end of an oversized transcript. */
const MAX_LINES_WHEN_LARGE = 1000;

export interface WorkbuddySessionSummary {
  /** Session UUID (the jsonl filename stem). */
  sessionId: string;
  /** Decoded work directory (best-effort, from the encoded dir name). */
  projectPath: string;
  /** First real user query snippet (up to 100 chars). */
  firstMessage: string;
  /** ISO timestamp of the first user message. */
  timestamp: string;
  /** Full path to the jsonl file. */
  filePath: string;
}

interface JsonlLine {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  timestamp?: number | string;
}

/** Pull the real user prompt out of a WorkBuddy user content array.
 *  Prefers the `<user_query>…</user_query>` payload (the first turn wraps
 *  the prompt inside a big system-reminder blob); otherwise falls back to
 *  the first plain text item that is not a system-reminder. */
function extractUserQuery(content: Array<{ type?: string; text?: string }> | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!text) continue;
    const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
    if (m) {
      const q = m[1].trim();
      if (q) return q;
    }
  }
  // No wrapped query — take the first text item that isn't a reminder blob.
  for (const item of content) {
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (text && !text.startsWith('<system-reminder')) return text;
  }
  return undefined;
}

/** Best-effort decode of the encoded project dir name back to a path.
 *  WorkBuddy encodes the workdir like `Users-blue-WorkBuddy-2026-…`; we
 *  can't losslessly reverse it, so we surface it as-is (prefixed) rather
 *  than fabricate a path. */
function decodeProjectDir(dirName: string): string {
  return dirName.startsWith('Users-') ? '/' + dirName.replace(/-/g, '/') : dirName;
}

/** Scan `~/.workbuddy/projects/` and return session summaries, newest first.
 *  Best-effort: unreadable dirs/files are logged and skipped. */
export async function listWorkbuddySessions(home = os.homedir()): Promise<WorkbuddySessionSummary[]> {
  const projectsRoot = path.join(home, '.workbuddy', 'projects');
  let projectDirs: Array<{ dir: string; name: string }> = [];

  try {
    const entries = await fsp.readdir(projectsRoot, { withFileTypes: true });
    projectDirs = entries
      .filter(e => e.isDirectory())
      .map(e => ({ dir: path.join(projectsRoot, e.name), name: e.name }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.info('~/.workbuddy/projects not found — WorkBuddy not used or fresh install');
      return [];
    }
    log.warn('failed to scan ~/.workbuddy/projects', { error: String(err) });
    return [];
  }

  const sessions: WorkbuddySessionSummary[] = [];

  for (const { dir, name } of projectDirs) {
    let files: string[] = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      files = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(dir, e.name));
    } catch (err) {
      log.warn('failed to list jsonl files in workbuddy project dir', { dir, error: String(err) });
      continue;
    }

    for (const file of files) {
      const summary = await _parseSessionSummary(file, decodeProjectDir(name));
      if (summary) sessions.push(summary);
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/** Parse the first real user query from a jsonl file to build a summary.
 *  Returns null when no usable user message is found or the file is bad. */
async function _parseSessionSummary(file: string, projectPath: string): Promise<WorkbuddySessionSummary | null> {
  const sessionId = path.basename(file, '.jsonl');
  let firstMessage = '';
  let timestamp = '';

  try {
    const content = await fsp.readFile(file, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      let obj: JsonlLine;
      try { obj = JSON.parse(line); }
      catch { continue; }

      if (obj.type === 'message' && obj.role === 'user') {
        const query = extractUserQuery(obj.content);
        if (query) {
          firstMessage = query.slice(0, 100);
          timestamp = normalizeTimestamp(obj.timestamp);
          break;
        }
      }
    }
  } catch (err) {
    log.warn('failed to parse workbuddy session file', { file, error: String(err) });
    return null;
  }

  if (!firstMessage || !timestamp) return null;
  return { sessionId, projectPath, firstMessage, timestamp, filePath: file };
}

/** WorkBuddy stores epoch-ms numbers; normalise to ISO. Tolerates an
 *  already-ISO string. Returns '' when unparseable so the caller can skip. */
function normalizeTimestamp(ts: number | string | undefined): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    try { return new Date(ts).toISOString(); } catch { return ''; }
  }
  if (typeof ts === 'string' && ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
}

/**
 * Read a single WorkBuddy session transcript in full (READ-ONLY).
 *
 * `filePath` MUST be a path returned by `listWorkbuddySessions` (i.e. inside
 * `~/.workbuddy/projects`). We re-assert containment here as a path-traversal
 * backstop so a hostile IPC payload can't read arbitrary files. Reads
 * line-by-line; past LARGE_TRANSCRIPT_BYTES only the most recent
 * MAX_LINES_WHEN_LARGE lines are kept and `truncated` is set.
 */
export async function readWorkbuddySessionTranscript(
  filePath: string,
  home = os.homedir(),
): Promise<{ ok: boolean; body: string; sessionId: string; truncated?: boolean; reason?: string }> {
  const sessionId = path.basename(filePath, '.jsonl');
  const projectsRoot = path.join(home, '.workbuddy', 'projects');
  const resolved = path.resolve(filePath);
  const rootWithSep = projectsRoot.endsWith(path.sep) ? projectsRoot : projectsRoot + path.sep;
  if (!resolved.startsWith(rootWithSep) || !resolved.endsWith('.jsonl')) {
    log.warn('rejected workbuddy transcript read outside projects root', { filePath });
    return { ok: false, body: '', sessionId, reason: 'out_of_bounds' };
  }

  let capLines = false;
  try {
    capLines = (await fsp.stat(resolved)).size > LARGE_TRANSCRIPT_BYTES;
  } catch (err) {
    log.warn('failed to stat workbuddy transcript', { filePath, error: String(err) });
    return { ok: false, body: '', sessionId, reason: 'unreadable' };
  }

  const lines: string[] = [];
  let dropped = 0;

  try {
    const stream = fs.createReadStream(resolved, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        lines.push(line);
        if (capLines && lines.length > MAX_LINES_WHEN_LARGE) {
          lines.shift();
          dropped++;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  } catch (err) {
    log.warn('failed to read workbuddy transcript', { filePath, error: String(err) });
    return { ok: false, body: '', sessionId, reason: 'unreadable' };
  }

  if (dropped) {
    log.info('workbuddy transcript truncated to most recent lines', { sessionId, kept: lines.length, dropped });
  }

  return { ok: true, body: lines.join('\n'), sessionId, truncated: dropped > 0 };
}
