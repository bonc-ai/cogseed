/**
 * External-session deliverable detection (import 方向2, step 1).
 *
 * When we import an external agent session (Claude Code / WorkBuddy), the
 * *transcript* is compressed into a seed brief — but any FILES that agent
 * produced (a report, a slide deck, a rendered video) are not part of the
 * text. This module identifies those deliverable files from the RAW transcript
 * so a later step can copy them into the new conversation's workspace, tagged
 * as "来自导入会话" produce output.
 *
 * Why the raw transcript, not the normalized turns:
 *   `transcript-normalize` deliberately drops tool_use / tool_result / thinking
 *   blocks — normalized turns are text-only. File writes live ONLY in the raw
 *   `tool_use` blocks, so detection must parse the raw jsonl body
 *   (`read.body`), never the normalized `transcript.turns`.
 *
 * Detection is DETERMINISTIC (no model): we walk `tool_use` blocks and read the
 * explicit file path off the tool input. Only the tools that carry an explicit
 * target path are trusted:
 *   - Write / Edit / MultiEdit → `input.file_path`
 *   - NotebookEdit             → `input.notebook_path`
 * `Bash`-created files are intentionally NOT inferred (no reliable path).
 *
 * WorkBuddy: its transcript records no structured tool_use blocks (content is
 * text-only: input_text / text / output_text / thinking), and its reader never
 * parses tool calls. Rather than guess a shape and risk copying the wrong
 * files, WorkBuddy honestly degrades to "no deliverables detected" ([]).
 *
 * The collected paths are then run through the shared `produced_files`
 * whitelist so only real, non-empty, deliverable-kind files survive — the same
 * gate the live agent uses for its own message footer, so imported produce
 * output is filtered identically to native produce output.
 */

import * as path from 'node:path';

import { selectVisibleProducedFiles, validateProducedFiles } from '../produced_files';
import { createLogger } from '../../logger';

const log = createLogger('session-import:deliverables');

/** Claude Code tool names whose input names an explicit file target. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * Parse a raw Claude Code jsonl transcript body and collect the absolute file
 * paths the session wrote via file-writing tools. Best-effort and non-throwing:
 * malformed lines are skipped, and any failure yields the paths found so far.
 *
 * `body` is the raw jsonl (one JSON object per line) as returned by
 * `readClaudeSessionTranscript().body`. Each object's shape is
 * `{ message: { content } }` where `content` is a string OR an array of typed
 * blocks; `tool_use` blocks carry `name` and `input`.
 */
export function detectClaudeDeliverables(body: string): string[] {
  const paths: string[] = [];
  if (!body) return paths;

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    let obj: { message?: { content?: unknown } };
    try {
      obj = JSON.parse(line) as { message?: { content?: unknown } };
    } catch {
      continue; // malformed line — skip, best-effort
    }

    const content = obj?.message?.content;
    if (!Array.isArray(content)) continue; // string content = no tool_use

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== 'tool_use') continue;

      const name = typeof b.name === 'string' ? b.name : '';
      const input = b.input && typeof b.input === 'object'
        ? (b.input as Record<string, unknown>)
        : null;
      if (!input) continue;

      let p = '';
      if (FILE_WRITE_TOOLS.has(name)) {
        p = typeof input.file_path === 'string' ? input.file_path : '';
      } else if (name === 'NotebookEdit') {
        p = typeof input.notebook_path === 'string' ? input.notebook_path : '';
      }
      // Only trust absolute paths — a relative path can't be resolved without
      // the original cwd and would risk pointing at the wrong file.
      if (p && path.isAbsolute(p)) paths.push(p);
    }
  }

  return paths;
}

/**
 * Filter a set of candidate deliverable paths down to the high-confidence,
 * real files worth surfacing — the WHITELIST + existence/non-empty gate.
 *
 * Reuses `produced_files`:
 *   1. `selectVisibleProducedFiles` — drops obvious process/debug files and
 *      applies the deliverable-kind priority ladder (documents → video → html
 *      → audio → images → remaining).
 *   2. `validateProducedFiles` — `fs.statSync` each survivor; keep only
 *      `status:'ready'` (exists, is a regular file, non-empty, readable).
 *
 * Returns the ready absolute paths, deduped. Non-throwing: any failure degrades
 * to [] so a detection problem never blocks the import.
 */
export function selectImportedDeliverables(rawPaths: readonly string[]): string[] {
  try {
    if (!rawPaths.length) return [];
    const visible = selectVisibleProducedFiles(rawPaths);
    if (!visible.length) return [];
    const validated = validateProducedFiles(visible);
    return validated.filter((v) => v.status === 'ready').map((v) => v.path);
  } catch (err) {
    log.warn('deliverable filtering failed — degrading to none', { error: String(err) });
    return [];
  }
}

/**
 * Detect + filter external deliverables from a raw transcript body, by source.
 * The single entry point callers use. Non-throwing; returns [] on any failure
 * or for sources without a parseable tool-call shape (WorkBuddy).
 */
export function detectImportedDeliverables(
  source: 'claude' | 'workbuddy',
  body: string,
): string[] {
  try {
    if (source !== 'claude') return []; // WorkBuddy: no structured tool_use — honest degrade
    const raw = detectClaudeDeliverables(body);
    const ready = selectImportedDeliverables(raw);
    if (ready.length) {
      log.info(`detected ${ready.length} imported deliverable(s) from ${source} session`);
    }
    return ready;
  } catch (err) {
    log.warn('deliverable detection failed — degrading to none', { source, error: String(err) });
    return [];
  }
}
