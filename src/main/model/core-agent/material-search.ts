/**
 * Material-boundary hybrid search (知识库问答 ① Phase 2 + 4.3).
 *
 * Retrieval entry for the "reliable Q&A within a material set" workstream:
 * fuses Library vector search (semantic, via the existing sqlite-vec KB)
 * with a keyword side (BM25 over chunk text, reusing the core-agent scorer)
 * using reciprocal rank fusion (RRF).
 *
 * Why hybrid: vector search alone misses exact terms / ids / filenames that
 * the embedding blurs (e.g. "知识库问答", "IPC 0012"), and keyword-only
 * misses synonyms. The fusion keeps both signals and returns a unified hit
 * shape — `{source, scope, path, chunkIdx, snippet, score}` — that later
 * phases (material-boundary model, answer verification) consume as the
 * citation anchor.
 *
 * Attachment side (4.3): when `cid` + `attachments` are given, in-scope
 * conversation attachments participate in the keyword side — plain-text
 * files read directly, rich documents only when the file-indexer cache
 * already exists (search stays fast and side-effect free; `kb_read
 * source="attachment"` extracts on demand). Attachment hits carry
 * `source: 'attachment'` and `scope: 'conversation'`.
 *
 * Design notes / reused utilities:
 *   - Vector side mirrors `kb-tools.ts::kb_search` (embed → kb.search on
 *     global + space Library), so behavior stays consistent with the
 *     existing tool.
 *   - Keyword side reuses `bm25Score` from the core-agent memory hybrid
 *     (loaded dynamically through `#core-agent`, per the dynamic-import
 *     rule); no new scoring implementation.
 *   - Boundary comes from `material-boundary.ts::resolveMaterialSet`
 *     (Phase 3): only in-scope attachments are considered.
 *   - No writes: read-only over the KB vector store, space library, and
 *     the file-indexer cache.
 *   - `#core-agent` is imported dynamically only (static import is
 *     forbidden in main).
 */

import * as fs from 'node:fs';
import { createLogger } from '../../logger';
import * as kb from '../../features/kb_vector';
import * as kbEmbed from '../../features/kb_embed';
import * as spaceLibrary from '../../features/project_library_indexer';
import * as chatAttachments from '../../features/chat_attachments';
import * as fileIndexer from '../../features/file_indexer';
import { resolveMaterialSet } from './material-boundary';
import { logErrorRef, maskId } from '../../util/log-redact';

const log = createLogger('material-search');

/** RRF rank-offset constant, matching the core-agent memory hybrid. */
const RRF_K = 60;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_KEYWORD_WEIGHT = 0.3;
const DEFAULT_K = 8;
const MAX_K = 30;
const SNIPPET_CHARS = 600;
/** Cap on keyword candidates scanned per query (prevents unbounded BM25). */
const KEYWORD_FILE_CAP = 200;
const KEYWORD_CHUNK_CAP = 800;
/** Attachment-side caps (4.3): bounded scanning and per-file text length. */
const ATTACHMENT_FILE_CAP = 20;
const ATTACHMENT_CHAR_CAP = 50_000;

export type MaterialScope = 'global' | 'space' | 'all';

export interface MaterialHit {
  source: 'library' | 'attachment';
  scope: 'global' | 'space' | 'conversation';
  path: string;
  chunkIdx: number;
  title: string | null;
  /** Truncated chunk text for citation grounding. */
  snippet: string;
  /** Fused relevance (RRF), 0..1-ish. */
  score: number;
  vectorScore?: number;
  keywordScore?: number;
}

export interface MaterialSearchOptions {
  userId: string;
  spaceId?: string;
  query: string;
  k?: number;
  scope?: MaterialScope;
  dir?: string;
  path?: string;
  kind?: kb.KbKind;
  vectorWeight?: number;
  keywordWeight?: number;
  /** Conversation id — when set with `attachments`, in-scope attachments join the keyword side (4.3). */
  cid?: string;
  /** Include conversation attachments in retrieval. Requires `cid`. Default false. */
  attachments?: boolean;
}

export interface MaterialSearchResult {
  hits: MaterialHit[];
  /** Human-readable per-scope summary (mirrors kb_search's counters). */
  summary: string[];
}

interface RankedHit {
  hit: MaterialHit;
  vectorRank?: number;
  keywordRank?: number;
  vectorScore?: number;
  keywordScore?: number;
}

function parseScope(raw: string | undefined, hasSpace: boolean): MaterialScope {
  if (raw === 'global') return 'global';
  if (raw === 'space' && hasSpace) return 'space';
  if (raw === 'all' && hasSpace) return 'all';
  return hasSpace ? 'all' : 'global';
}

function hitKey(scope: string, path: string, chunkIdx: number): string {
  return `${scope}\u0000${path}\u0000${chunkIdx}`;
}

function snippetOf(text: string): string {
  const s = (text || '').trim();
  return s.length <= SNIPPET_CHARS ? s : `${s.slice(0, SNIPPET_CHARS)}…`;
}

/** Vector side: embed the query once, search global + space Library. */
async function vectorCandidates(
  opts: Required<Pick<MaterialSearchOptions, 'userId'>> & MaterialSearchOptions,
  scope: MaterialScope,
  vec: number[],
): Promise<Array<{ key: string; rank: number; score: number; hit: MaterialHit }>> {
  const kbOpts: kb.KbSearchOpts = { k: opts.k };
  if (opts.dir) kbOpts.dir = opts.dir;
  if (opts.path) kbOpts.path = opts.path;
  if (opts.kind) kbOpts.kind = opts.kind;

  const collected: Array<{ scope: 'global' | 'space'; row: kb.KbSearchHit }> = [];
  if (scope === 'global' || scope === 'all') {
    collected.push(...kb.search(opts.userId, vec, kbOpts).map((h) => ({ scope: 'global' as const, row: h })));
  }
  if ((scope === 'space' || scope === 'all') && opts.spaceId) {
    collected.push(...(await spaceLibrary.search(opts.userId, opts.spaceId, vec, kbOpts))
      .map((h) => ({ scope: 'space' as const, row: h })));
  }
  // Dedupe (scope,path,chunkIdx) keeping the max score, then rank by score.
  const byKey = new Map<string, { scope: 'global' | 'space'; row: kb.KbSearchHit }>();
  for (const item of collected) {
    const key = hitKey(item.scope, item.row.rel_path, item.row.chunk_idx);
    const prev = byKey.get(key);
    if (!prev || item.row.score > prev.row.score) byKey.set(key, item);
  }
  const entries = [...byKey.values()].sort((a, b) => b.row.score - a.row.score);
  return entries.map((item, i) => ({
    key: hitKey(item.scope, item.row.rel_path, item.row.chunk_idx),
    rank: i,
    score: item.row.score,
    hit: {
      source: 'library' as const,
      scope: item.scope,
      path: item.row.rel_path,
      chunkIdx: item.row.chunk_idx,
      title: item.row.title,
      snippet: snippetOf(item.row.content),
      score: 0, // filled during fusion
    },
  }));
}

/** Keyword side: BM25 over chunk text of ready files (reuses core-agent scorer). */
async function keywordCandidates(
  opts: Required<Pick<MaterialSearchOptions, 'userId'>> & MaterialSearchOptions,
  scope: MaterialScope,
  query: string,
  bm25Score: (q: string, doc: string) => number,
): Promise<Array<{ key: string; rank: number; score: number; hit: MaterialHit }>> {
  const files: Array<{ scope: 'global' | 'space'; row: kb.KbFileRow }> = [];
  if (scope === 'global' || scope === 'all') {
    files.push(...kb.listFiles(opts.userId)
      .filter((row) => row.status === 'ready')
      .map((row) => ({ scope: 'global' as const, row })));
  }
  if ((scope === 'space' || scope === 'all') && opts.spaceId) {
    files.push(...spaceLibrary.listFiles(opts.userId, opts.spaceId)
      .filter((row) => row.status === 'ready')
      .map((row) => ({ scope: 'space' as const, row })));
  }

  // Apply the same dir/path/kind filters as the vector side.
  const rawDir = opts.dir?.trim() ?? '';
  const dir = rawDir ? (rawDir.endsWith('/') ? rawDir : `${rawDir}/`) : '';
  const filtered = files.filter(({ row }) =>
    (!dir || row.rel_path === rawDir || row.rel_path.startsWith(dir))
    && (!opts.path || row.rel_path === opts.path)
    && (!opts.kind || row.kind === opts.kind),
  );

  const candidates: Array<{ scope: 'global' | 'space'; path: string; chunkIdx: number; title: string | null; content: string; score: number }> = [];
  let scannedFiles = 0;
  for (const { scope: fileScope, row } of filtered) {
    if (scannedFiles >= KEYWORD_FILE_CAP) break;
    scannedFiles += 1;
    const chunks = fileScope === 'global'
      ? kb.readFileChunks(opts.userId, row.rel_path)
      : spaceLibrary.readFileChunks(opts.userId, opts.spaceId!, row.rel_path);
    for (const chunk of chunks) {
      if (candidates.length >= KEYWORD_CHUNK_CAP) break;
      const s = bm25Score(query, chunk.content);
      if (s <= 0) continue;
      candidates.push({
        scope: fileScope,
        path: row.rel_path,
        chunkIdx: chunk.chunk_idx,
        title: chunk.title,
        content: chunk.content,
        score: s,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c, i) => ({
    key: hitKey(c.scope, c.path, c.chunkIdx),
    rank: i,
    score: c.score,
    hit: {
      source: 'library' as const,
      scope: c.scope,
      path: c.path,
      chunkIdx: c.chunkIdx,
      title: c.title,
      snippet: snippetOf(c.content),
      score: 0,
    },
  }));
}

/**
 * Attachment side (4.3): BM25 over in-scope conversation attachments.
 * Plain-text files read directly; rich documents only when the file-indexer
 * cache already exists (search must stay fast and side-effect free — the
 * model can `kb_read source="attachment"` to extract on demand). Each
 * attachment contributes at most one candidate (chunkIdx 0) capped at
 * `ATTACHMENT_CHAR_CAP` chars.
 */
async function attachmentCandidates(
  opts: Required<Pick<MaterialSearchOptions, 'userId'>> & MaterialSearchOptions,
  query: string,
  bm25Score: (q: string, doc: string) => number,
): Promise<Array<{ key: string; rank: number; score: number; hit: MaterialHit }>> {
  if (!opts.attachments || !opts.cid) return [];

  let boundary;
  try {
    boundary = await resolveMaterialSet({ userId: opts.userId, cid: opts.cid });
  } catch (err) {
    log.warn('material_search: attachment boundary resolve failed', {
      user_id: maskId(opts.userId),
      error: logErrorRef(err),
    });
    return [];
  }

  const candidates: Array<{ name: string; text: string; score: number }> = [];
  let scanned = 0;
  for (const a of boundary.attachments) {
    if (!a.inScope || scanned >= ATTACHMENT_FILE_CAP) continue;
    scanned += 1;
    const resolved = chatAttachments.resolveAttachmentAbsPath(opts.userId, opts.cid, a.name);
    if (!resolved.ok) continue;
    const { absPath } = resolved;
    let text: string;
    try {
      if (fileIndexer.kindOf(absPath) === 'text') {
        text = fs.readFileSync(absPath, 'utf8');
      } else {
        const meta = fileIndexer.getCachedMeta(opts.userId, absPath);
        if (!meta) continue; // rich document not cached yet — skip in search
        ({ text } = await fileIndexer.getExtractedText(opts.userId, absPath));
      }
    } catch {
      continue;
    }
    if (text.length > ATTACHMENT_CHAR_CAP) text = text.slice(0, ATTACHMENT_CHAR_CAP);
    const s = bm25Score(query, text);
    if (s <= 0) continue;
    candidates.push({ name: a.name, text, score: s });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.map((c, i) => ({
    key: hitKey('conversation', c.name, 0),
    rank: i,
    score: c.score,
    hit: {
      source: 'attachment' as const,
      scope: 'conversation' as const,
      path: c.name,
      chunkIdx: 0,
      title: null,
      snippet: snippetOf(c.text),
      score: 0,
    },
  }));
}

/**
 * Hybrid material search over the Library (global + optional space).
 * Returns fused, top-k hits ordered by RRF score, each with a citation
 * anchor (`scope + path + chunkIdx`) for grounded answering.
 */
export async function searchMaterials(opts: MaterialSearchOptions): Promise<MaterialSearchResult> {
  const query = (opts.query ?? '').trim();
  if (!query) return { hits: [], summary: ['material_search: `query` is required'] };
  const hasSpace = !!opts.spaceId;
  const scope = parseScope(opts.scope, hasSpace);
  const k = Math.min(MAX_K, Math.max(1, Math.floor(Number(opts.k ?? DEFAULT_K))));
  const vectorWeight = Number(opts.vectorWeight ?? DEFAULT_VECTOR_WEIGHT);
  const keywordWeight = Number(opts.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT);

  let vec: number[];
  try {
    vec = await kbEmbed.embedQuery(query);
  } catch (err) {
    const msg = (err as Error).message;
    log.warn('material_search embed failed', {
      user_id: maskId(opts.userId),
      space_id: maskId(opts.spaceId),
      query_chars: query.length,
      error: logErrorRef(err),
    });
    return { hits: [], summary: [`material_search: embedding failed — ${msg}`] };
  }

  let vectorCands: Awaited<ReturnType<typeof vectorCandidates>> = [];
  let keywordCands: Awaited<ReturnType<typeof keywordCandidates>> = [];
  let attachmentCands: Awaited<ReturnType<typeof attachmentCandidates>> = [];
  try {
    vectorCands = await vectorCandidates(opts, scope, vec);
    // core-agent is dynamic-import-only in main; load the scorer lazily.
    const { bm25Score } = await import('#core-agent');
    keywordCands = await keywordCandidates(opts, scope, query, bm25Score);
    attachmentCands = await attachmentCandidates(opts, query, bm25Score);
  } catch (err) {
    const msg = (err as Error).message;
    log.warn('material_search query failed', {
      user_id: maskId(opts.userId),
      space_id: maskId(opts.spaceId),
      error: logErrorRef(err),
    });
    return { hits: [], summary: [`material_search: search failed — ${msg}`] };
  }

  // ── RRF fusion ───────────────────────────────────────────────────────────
  const fused = new Map<string, RankedHit>();
  for (const c of vectorCands) {
    fused.set(c.key, { hit: c.hit, vectorRank: c.rank + 1, vectorScore: c.score });
  }
  // Keyword-side evidence: Library BM25 chunks and attachment hits share the
  // keyword weight bucket and compete by rank within their own lists.
  for (const c of [...keywordCands, ...attachmentCands]) {
    const prev = fused.get(c.key);
    if (prev) {
      prev.keywordRank = c.rank + 1;
      prev.keywordScore = c.score;
    } else {
      fused.set(c.key, { hit: c.hit, keywordRank: c.rank + 1, keywordScore: c.score });
    }
  }
  const ranked = [...fused.values()].map((r) => {
    let score = 0;
    if (r.vectorRank) score += vectorWeight / (RRF_K + r.vectorRank);
    if (r.keywordRank) score += keywordWeight / (RRF_K + r.keywordRank);
    r.hit.score = score;
    r.hit.vectorScore = r.vectorScore;
    r.hit.keywordScore = r.keywordScore;
    return r.hit;
  }).sort((a, b) => b.score - a.score).slice(0, k);

  const globalSummary = kb.statusSummary(opts.userId);
  const spaceSummary = opts.spaceId ? spaceLibrary.statusSummary(opts.userId, opts.spaceId) : null;
  const summary = [
    `global total=${globalSummary.total} ready=${globalSummary.ready} processing=${globalSummary.processing} pending=${globalSummary.pending} failed=${globalSummary.failed}`,
  ];
  if (spaceSummary) {
    summary.push(
      `space total=${spaceSummary.total} ready=${spaceSummary.ready} processing=${spaceSummary.processing} pending=${spaceSummary.pending} failed=${spaceSummary.failed}`,
    );
  }
  if (opts.attachments && opts.cid) {
    summary.push(`attachments hits=${attachmentCands.length}`);
  }

  return { hits: ranked, summary };
}
