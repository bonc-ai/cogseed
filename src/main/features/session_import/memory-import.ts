/**
 * Claude Code memory import (closed loop D).
 *
 * Claude Code's persistent memory lives in `CLAUDE.md` files:
 *   - User-level:    `~/.claude/CLAUDE.md`   (cross-project instructions/facts)
 * Project-level `CLAUDE.md` files live inside each project's working tree, not
 * under `~/.claude`, so they aren't discoverable from a single fixed root —
 * we deliberately import only the user-level file here and stay honest about
 * that scope in the UI.
 *
 * Import maps CLAUDE.md content into our shared memory tier (MemoryScope
 * 'memory' → MEMORY.md): cross-project, cross-agent facts. Each non-empty
 * markdown line/bullet becomes one candidate entry; the memory module's own
 * `addEntry` runs its injection scan and char-limit guard on every write, so
 * a hostile or oversized CLAUDE.md can't smuggle content in or blow the file.
 *
 * Boundaries:
 *   - READ-ONLY on `~/.claude`. Never writes to Claude's storage.
 *   - Preview (`readClaudeMemory`, content only) is separate from import.
 *   - Bounded: caps total bytes read and number of entries imported.
 *   - Idempotent-ish: an entry whose exact text already exists in MEMORY.md is
 *     skipped by the memory module's dedup on add; we also report per-line
 *     status so re-running is safe and visible.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

import { addEntry, listEntries } from '../memory';
import { createLogger } from '../../logger';

const log = createLogger('session-import:memory-import');

/** Cap the CLAUDE.md read + how many entries we'll route in one import. */
const MAX_FILE_BYTES = 256 * 1024; // 256 KiB
const MAX_ENTRIES = 200;

function claudeMemoryFile(home = os.homedir()): string {
  return path.join(home, '.claude', 'CLAUDE.md');
}

export interface ClaudeMemoryPreview {
  /** True when a user-level CLAUDE.md exists and was readable. */
  present: boolean;
  /** Number of importable entries (non-empty lines/bullets). */
  entryCount: number;
  /** First few entries, for a preview snippet (not the whole file). */
  sample: string[];
  reason?: 'not_found' | 'unreadable' | 'too_large';
}

/**
 * Split CLAUDE.md into importable memory entries. Markdown structure is
 * flattened to plain facts:
 *   - Bullet lines (`- `, `* `, `1. `) → the bullet text.
 *   - Non-empty prose lines → the line.
 *   - Headings (`#`), code fences, and blank lines are dropped (structure,
 *     not facts).
 * Leading list markers and surrounding whitespace are stripped.
 */
function splitMemoryEntries(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;              // skip fenced code blocks
    if (line.startsWith('#')) continue; // skip headings (structure)
    // Strip a leading list marker: "- ", "* ", "+ ", "1. ", "2) "
    const cleaned = line.replace(/^([-*+]\s+|\d+[.)]\s+)/, '').trim();
    if (cleaned) out.push(cleaned);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Read + preview the user-level Claude memory (READ-ONLY). Returns an honest
 * `present:false` state when there's no CLAUDE.md, rather than throwing.
 */
export async function readClaudeMemory(): Promise<ClaudeMemoryPreview> {
  const file = claudeMemoryFile();
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { present: false, entryCount: 0, sample: [], reason: 'not_found' };
  }
  if (stat.size > MAX_FILE_BYTES) {
    log.warn('CLAUDE.md too large to import', { bytes: stat.size });
    return { present: true, entryCount: 0, sample: [], reason: 'too_large' };
  }
  let body: string;
  try {
    body = await fsp.readFile(file, 'utf8');
  } catch (err) {
    log.warn('failed to read CLAUDE.md', { error: String(err) });
    return { present: false, entryCount: 0, sample: [], reason: 'unreadable' };
  }
  const entries = splitMemoryEntries(body);
  return { present: true, entryCount: entries.length, sample: entries.slice(0, 5) };
}

export interface ImportMemoryResult {
  ok: boolean;
  /** Entries newly written to MEMORY.md. */
  added: number;
  /** Entries skipped because identical text already existed. */
  skipped: number;
  /** Entries rejected by the memory guard (injection scan / char limit). */
  rejected: number;
  reason?: string;
}

/**
 * Import the user-level CLAUDE.md into the shared memory tier. Idempotent per
 * entry: identical existing text is skipped. Every write goes through
 * `memory.addEntry`, so the injection scan + char-limit guard apply.
 */
export async function importClaudeMemory(userId: string): Promise<ImportMemoryResult> {
  const file = claudeMemoryFile();
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { ok: false, added: 0, skipped: 0, rejected: 0, reason: 'not_found' };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { ok: false, added: 0, skipped: 0, rejected: 0, reason: 'too_large' };
  }
  let body: string;
  try {
    body = await fsp.readFile(file, 'utf8');
  } catch (err) {
    log.warn('failed to read CLAUDE.md for import', { error: String(err) });
    return { ok: false, added: 0, skipped: 0, rejected: 0, reason: 'unreadable' };
  }

  const entries = splitMemoryEntries(body);
  if (!entries.length) return { ok: true, added: 0, skipped: 0, rejected: 0 };

  // Existing shared-tier text, for per-entry dedup.
  const existing = new Set<string>();
  const cur = listEntries(userId, 'memory');
  if (cur.ok && Array.isArray(cur.entries)) {
    for (const e of cur.entries) existing.add((e || '').trim());
  }

  let added = 0;
  let skipped = 0;
  let rejected = 0;
  for (const text of entries) {
    if (existing.has(text)) { skipped += 1; continue; }
    const res = addEntry(userId, 'memory', text);
    if (res.ok) { added += 1; existing.add(text); }
    else { rejected += 1; }
  }

  log.info('claude memory import done', { added, skipped, rejected, total: entries.length });
  return { ok: true, added, skipped, rejected };
}
