/**
 * Anchor resolver (知识库问答 ② P1) — chunk-level citation → char-level position.
 *
 * Given a citation anchor (`source`/`scope`/`path`/`chunkIdx`, optional
 * `quote`) this resolves the anchor to a concrete character range in the
 * source document's extracted text, so the UI can jump to and highlight the
 * exact spot:
 *
 *   1. read the chunk text from the vector store (kb / space library);
 *   2. load the source file's extracted text via the file-indexer cache
 *      (plain text read directly; rich docs only when cached — never
 *      trigger an expensive extraction from here);
 *   3. locate the chunk (or its quote) in the text: exact substring first,
 *      whitespace-normalized search, then first-token fallback;
 *   4. map charStart → page via the PDF page map when available.
 *
 * Failures are structured, not thrown: `resolved: false` with a reason
 * (`no_cache` / `not_found` / `out_of_scope` / `no_text`) so the caller can
 * degrade to the chunk-level anchor instead of silently failing.
 *
 * Read-only; reuses existing utilities (kb / space library / file_indexer /
 * attachment resolver) — no new parsers, no writes.
 */

import * as path from 'node:path';
import { createLogger } from '../../logger';
import * as kb from '../../features/kb_vector';
import * as spaceLibrary from '../../features/project_library_indexer';
import * as chatAttachments from '../../features/chat_attachments';
import * as fileIndexer from '../../features/file_indexer';
import { userContextsDir, spaceContextsDir } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import { maskId } from '../../util/log-redact';

const log = createLogger('anchor-resolver');

export interface AnchorTarget {
  userId: string;
  source: 'library' | 'attachment';
  scope: 'global' | 'space' | 'conversation';
  /** Library-relative path or attachment filename. */
  path: string;
  chunkIdx: number;
  /** Optional expected snippet from the evidence (preferred for locating). */
  quote?: string;
  /** Required for attachments. */
  cid?: string;
  spaceId?: string;
}

export type AnchorFailure = 'no_cache' | 'not_found' | 'out_of_scope' | 'no_text' | 'bad_input';

export interface AnchorLocation {
  resolved: boolean;
  reason?: AnchorFailure;
  /** Absolute path of the source file (for the viewer). */
  absPath?: string;
  /** Display path (library relPath / attachment filename / space relPath). */
  displayPath?: string;
  charStart?: number;
  charEnd?: number;
  page?: number;
  totalChars?: number;
  /** The located text range (preview for highlighting). */
  text?: string;
}

/** Collapse all whitespace runs to single spaces (for fuzzy locating). */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstSignificantToken(s: string): string {
  const m = s.match(/[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/u);
  return m ? m[0] : '';
}

/**
 * Locate `needle` inside `text`. Exact substring first; then
 * whitespace-normalized; then first-significant-token fallback. Returns
 * charStart/charEnd (approximate for the fuzzy paths).
 */
function locateInText(text: string, needle: string): { start: number; end: number } | null {
  if (!needle) return null;
  let idx = text.indexOf(needle);
  if (idx >= 0) return { start: idx, end: idx + needle.length };

  const needleNorm = normalize(needle);
  const textNorm = normalize(text);
  idx = textNorm.indexOf(needleNorm);
  if (idx >= 0) {
    // Map normalized index back to raw by locating the first token at/after idx.
    const head = needleNorm.slice(0, Math.min(60, needleNorm.length));
    const firstWord = firstSignificantToken(head);
    const rawIdx = firstWord ? text.indexOf(firstWord) : text.indexOf(needle[0]);
    if (rawIdx >= 0) {
      const end = Math.min(text.length, rawIdx + Math.max(needle.length, firstWord.length));
      return { start: rawIdx, end };
    }
  }

  const firstWord = firstSignificantToken(needle);
  if (firstWord) {
    const rawIdx = text.indexOf(firstWord);
    if (rawIdx >= 0) {
      return { start: rawIdx, end: Math.min(text.length, rawIdx + Math.max(needle.length, firstWord.length)) };
    }
  }
  return null;
}

/**
 * Derive the PDF page from the `--- page N ---` delimiters the materialiser
 * writes into text.md (see file_indexer). Scans markers up to charStart.
 */
function pageForText(text: string, charStart: number): number | undefined {
  const re = /---\s*page\s*(\d+)\s*---/g;
  let m: RegExpExecArray | null;
  let page: number | undefined;
  while ((m = re.exec(text)) && m.index <= charStart) {
    page = Number(m[1]);
  }
  return page;
}

/**
 * Resolve a citation anchor to a character range in the source document.
 * Returns `resolved: false` (with a reason) instead of throwing when the
 * source is out of scope, not cached, or the chunk cannot be located.
 */
export async function resolveAnchor(target: AnchorTarget): Promise<AnchorLocation> {
  const { userId, source, scope } = target;
  const displayPath = target.path;

  // ── Resolve abs path + read the chunk text ─────────────────────────────
  let absPath: string;
  let chunkText: string | null = null;

  if (source === 'attachment') {
    if (!target.cid) return { resolved: false, reason: 'bad_input' };
    const resolved = chatAttachments.resolveAttachmentAbsPath(userId, target.cid, displayPath);
    if (!resolved.ok) return { resolved: false, reason: 'not_found' };
    absPath = resolved.absPath;
    // Attachments are not in the vector store; locate by quote only.
    chunkText = target.quote?.trim() || null;
  } else if (scope === 'space') {
    if (!target.spaceId) return { resolved: false, reason: 'bad_input' };
    absPath = path.join(spaceContextsDir(userId, target.spaceId), displayPath);
    const chunks = spaceLibrary.readFileChunks(userId, target.spaceId, displayPath);
    chunkText = chunks.find((c) => c.chunk_idx === target.chunkIdx)?.content?.trim() ?? null;
  } else {
    absPath = path.join(userContextsDir(userId), displayPath);
    const chunks = kb.readFileChunks(userId, displayPath);
    chunkText = chunks.find((c) => c.chunk_idx === target.chunkIdx)?.content?.trim() ?? null;
  }

  // ── Scope check: source must be inside its allowed root ────────────────
  let allowedRoot: string;
  if (source === 'attachment') {
    allowedRoot = chatAttachments.attachmentDirForCid(userId, target.cid!);
  } else if (scope === 'space') {
    allowedRoot = spaceContextsDir(userId, target.spaceId!);
  } else {
    allowedRoot = userContextsDir(userId);
  }
  if (!isPathAllowed(absPath, [allowedRoot])) {
    return { resolved: false, reason: 'out_of_scope' };
  }

  // ── Load extracted text (cache-only for rich docs) ─────────────────────
  // readRange: plain text reads the file directly; rich docs require an
  // existing file-indexer cache (NeedStatError → no_cache) and carry the
  // PDF page map.
  let text: string;
  try {
    const read = await fileIndexer.readRange(userId, absPath, {});
    text = read.content;
  } catch (err) {
    const name = (err as Error).name || '';
    if (name.includes('NeedStat')) {
      return { resolved: false, reason: 'no_cache', absPath, displayPath };
    }
    log.warn('anchor_resolver: extract failed', {
      user_id: maskId(userId),
      abs_path: displayPath,
      error: (err as Error).message,
    });
    return { resolved: false, reason: 'no_text', absPath, displayPath };
  }

  const needle = target.quote?.trim() || chunkText;
  if (!needle) return { resolved: false, reason: 'not_found', absPath, displayPath };

  const located = locateInText(text, needle);
  if (!located) {
    return { resolved: false, reason: 'not_found', absPath, displayPath, totalChars: text.length };
  }

  const page = pageForText(text, located.start);
  return {
    resolved: true,
    absPath,
    displayPath,
    charStart: located.start,
    charEnd: located.end,
    page,
    totalChars: text.length,
    text: text.slice(located.start, Math.min(located.end, located.start + 400)),
  };
}
