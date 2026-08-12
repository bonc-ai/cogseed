/**
 * Claude Code session history reader.
 *
 * Reads `~/.claude/projects/<encoded-path>/*.jsonl` files to list
 * past conversations for the onboarding "import sessions" step.
 *
 * **Constraints:**
 *   - READ-ONLY. Never writes to Claude Code's native storage.
 *   - Best-effort. If a file is malformed or inaccessible, skip it
 *     rather than failing the whole scan.
 *   - Privacy: only reads metadata (first user message, timestamp,
 *     project path) for the session list; full transcript is NOT
 *     read until the user explicitly selects a session to import.
 *
 * **Storage layout (Claude Code v2.x):**
 *   `~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl`
 *   Each line is a JSON object; relevant types:
 *     - `type:"user"` → user message (`.message.content[0].text`)
 *     - `type:"assistant"` → assistant reply
 *     - `type:"queue-operation"` → internal event (ignored)
 *   The `cwd` field (present on message lines) is the original project path.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { createLogger } from '../../logger';

const log = createLogger('local-agents:claude-sessions');

/** Above this size a transcript is read tail-only, to bound memory. */
const LARGE_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

/** Lines retained from the end of an oversized transcript. Counts raw jsonl
 *  lines rather than rendered turns — some lines are internal events that
 *  `parseClaudeTranscript` drops, so this is an upper bound on messages. */
const MAX_LINES_WHEN_LARGE = 1000;

export interface ClaudeSessionSummary {
  /** Session UUID (the jsonl filename stem). */
  sessionId: string;
  /** Decoded project path (from `cwd` field). */
  projectPath: string;
  /** First user message snippet (up to 100 chars). */
  firstMessage: string;
  /** ISO timestamp of the first user message. */
  timestamp: string;
  /** Full path to the jsonl file. */
  filePath: string;
}

interface JsonlLine {
  type?: string;
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  cwd?: string;
  timestamp?: string;
  sessionId?: string;
  uuid?: string;
}

/** Scan `~/.claude/projects/` and return a list of session summaries.
 *  Best-effort: directories/files that fail to read are logged and skipped. */
export async function listClaudeSessions(): Promise<ClaudeSessionSummary[]> {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs: string[] = [];

  try {
    const entries = await fsp.readdir(projectsRoot, { withFileTypes: true });
    projectDirs = entries.filter(e => e.isDirectory()).map(e => path.join(projectsRoot, e.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.info('~/.claude/projects not found — Claude Code not used or fresh install');
      return [];
    }
    log.warn('failed to scan ~/.claude/projects', { error: String(err) });
    return [];
  }

  const sessions: ClaudeSessionSummary[] = [];

  for (const dir of projectDirs) {
    let files: string[] = [];
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      files = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => path.join(dir, e.name));
    } catch (err) {
      log.warn('failed to list jsonl files in project dir', { dir, error: String(err) });
      continue;
    }

    for (const file of files) {
      const summary = await _parseSessionSummary(file);
      if (summary) sessions.push(summary);
    }
  }

  // Sort newest first.
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/** Parse the first user message from a jsonl file to build a summary.
 *  Returns null if no valid user message is found or the file is malformed. */
async function _parseSessionSummary(file: string): Promise<ClaudeSessionSummary | null> {
  const sessionId = path.basename(file, '.jsonl');
  let projectPath = '';
  let firstMessage = '';
  let timestamp = '';

  try {
    const content = await fsp.readFile(file, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      let obj: JsonlLine;
      try { obj = JSON.parse(line); }
      catch { continue; }

      if (obj.type === 'user' && obj.message?.role === 'user') {
        let text: string | undefined;
        const content = obj.message.content;

        // New format (Claude Code 2.1.220+): content is a string
        if (typeof content === 'string') {
          text = content;
        }
        // Old format: content is an array of content blocks
        else if (Array.isArray(content)) {
          text = content.find(c => c.type === 'text')?.text;
        }

        if (text) {
          firstMessage = text.slice(0, 100);
          timestamp = obj.timestamp || '';
          projectPath = obj.cwd || '';
          break;
        }
      }
    }
  } catch (err) {
    log.warn('failed to parse session file', { file, error: String(err) });
    return null;
  }

  if (!firstMessage || !timestamp) return null;

  return { sessionId, projectPath, firstMessage, timestamp, filePath: file };
}

/**
 * Read a single Claude Code session transcript in full (READ-ONLY).
 *
 * Unlike `listClaudeSessions` (which reads only the first user message for the
 * picker), this reads the whole jsonl so the session-import extractor can
 * summarise it. Still best-effort: a malformed / unreadable file yields an
 * empty body rather than throwing, and the caller decides how to surface that.
 *
 * `filePath` MUST be a path returned by `listClaudeSessions` (i.e. already
 * inside `~/.claude/projects`). We re-assert containment here as a
 * path-traversal backstop so a hostile IPC payload can't read arbitrary files.
 *
 * Read line-by-line rather than in one slurp so a long conversation can't pin
 * an unbounded string in the main process. Past `LARGE_TRANSCRIPT_BYTES` only
 * the most recent `MAX_LINES_WHEN_LARGE` lines are kept and `truncated` is set,
 * so the caller can say so instead of silently importing a partial history.
 */
export async function readClaudeSessionTranscript(
  filePath: string,
): Promise<{
  ok: boolean;
  body: string;
  sessionId: string;
  truncated?: boolean;
  reason?: string;
}> {
  const sessionId = path.basename(filePath, '.jsonl');
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const resolved = path.resolve(filePath);
  const rootWithSep = projectsRoot.endsWith(path.sep) ? projectsRoot : projectsRoot + path.sep;
  if (!resolved.startsWith(rootWithSep) || !resolved.endsWith('.jsonl')) {
    log.warn('rejected transcript read outside projects root', { filePath });
    return { ok: false, body: '', sessionId, reason: 'out_of_bounds' };
  }

  let capLines = false;
  try {
    capLines = (await fsp.stat(resolved)).size > LARGE_TRANSCRIPT_BYTES;
  } catch (err) {
    log.warn('failed to stat session transcript', { filePath, error: String(err) });
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
    log.warn('failed to read session transcript', { filePath, error: String(err) });
    return { ok: false, body: '', sessionId, reason: 'unreadable' };
  }

  if (dropped) {
    log.info('transcript truncated to most recent lines', { sessionId, kept: lines.length, dropped });
  }

  return { ok: true, body: lines.join('\n'), sessionId, truncated: dropped > 0 };
}
