/**
 * Library-scoped tools injected into every main-conv runner.
 *
 *   - `kb_list`   — list Library files and indexing status so the model can
 *                   discover what exists before choosing a search/read path.
 *   - `kb_search` — semantic search over the user's Library
 *                   (global, plus space-scoped Library when available).
 *   - `kb_read`   — read a Library file's chunk text back out of the
 *                   vector store (no re-parsing of the source; fast).
 *
 * These tools are read-only and need no localExec permission. They replace
 * the pre-kb-vector flow of `cat _INDEX.md` → drill into subdirs → cat files
 * (see the Library section of `prompts/chat_commander.md`
 * for the routing rule).
 *
 * Uses the currently-active user via `getActiveUserId()` — the tool's `uid` is
 * captured at runner build time and stays stable for the runner's lifetime
 * (per-invocation uid swap would require tearing down the runner anyway).
 */

import type { AgentTool } from '#core-agent';
import { createLogger } from '../../logger';
import * as kb from '../../features/kb_vector';
import * as kbEmbed from '../../features/kb_embed';
import * as spaceLibrary from '../../features/project_library_indexer';
import { logErrorRef, maskId } from '../../util/log-redact';
import { searchMaterials, type MaterialSearchOptions } from './material-search';
import { resolveMaterialSet } from './material-boundary';
import { askMaterials, formatEvidence } from './ask-materials';
import * as chatAttachments from '../../features/chat_attachments';
import * as fileIndexer from '../../features/file_indexer';

const log = createLogger('kb-tools');

export interface KbToolsOpts {
  userId: string;
  spaceId?: string;
  cid?: string;
}

const PREVIEW_CHARS = 400;
const DEFAULT_LIST_LIMIT = 80;
const MAX_LIST_LIMIT = 300;
const KB_KIND_VALUES = ['text', 'pdf', 'docx', 'spreadsheet', 'presentation', 'image'] as const;

function previewOf(text: string): string {
  const s = (text || '').trim();
  if (s.length <= PREVIEW_CHARS) return s;
  return s.slice(0, PREVIEW_CHARS) + '…';
}

function parseKbKind(raw: unknown): kb.KbKind | undefined {
  return typeof raw === 'string' && (KB_KIND_VALUES as readonly string[]).includes(raw)
    ? raw as kb.KbKind
    : undefined;
}

type LibraryScope = 'global' | 'space';
type ScopeInput = LibraryScope | 'all';
type LibraryHit = kb.KbSearchHit & { scope: LibraryScope };

function parseSearchScope(raw: unknown, hasSpace: boolean): ScopeInput {
  if (raw === 'global') return 'global';
  if (raw === 'space' && hasSpace) return 'space';
  if (raw === 'all' && hasSpace) return 'all';
  return hasSpace ? 'all' : 'global';
}

function parseReadScope(raw: unknown, hasSpace: boolean): ScopeInput {
  if (raw === 'global') return 'global';
  if (raw === 'space' && hasSpace) return 'space';
  if (raw === 'all' && hasSpace) return 'all';
  return hasSpace ? 'all' : 'global';
}

function parseListScope(raw: unknown, hasSpace: boolean): ScopeInput {
  if (raw === 'global') return 'global';
  if (raw === 'space' && hasSpace) return 'space';
  if (raw === 'all' && hasSpace) return 'all';
  return hasSpace ? 'all' : 'global';
}

type LibraryFileEntry = {
  scope: LibraryScope;
  row: kb.KbFileRow;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kbSize = bytes / 1024;
  if (kbSize < 1024) return `${kbSize.toFixed(kbSize < 10 ? 1 : 0)} KB`;
  const mbSize = kbSize / 1024;
  return `${mbSize.toFixed(mbSize < 10 ? 1 : 0)} MB`;
}

function statusRank(status: kb.KbStatus): number {
  switch (status) {
    case 'failed': return 0;
    case 'processing': return 1;
    case 'pending': return 2;
    case 'ready': return 3;
    default: return 4;
  }
}

function createKbListTool(opts: KbToolsOpts): AgentTool {
  const hasSpace = !!opts.spaceId;
  return {
    name: 'kb_list',
    executionMode: 'parallel',
    description:
      'List files in the user Library before deciding what to search or read'
      + (hasSpace ? ' (current space + global by default)' : '')
      + '. Use this when the user asks what is in the Library, asks about files\n'
      + 'without naming one, or when semantic search has no good hits. Returns\n'
      + 'relative paths, scope, kind, indexing status, chunk count, and size.\n'
      + 'After choosing a likely file, use `kb_search` for semantic retrieval or\n'
      + '`kb_read` when the user explicitly asks to inspect/read that file.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: hasSpace ? ['all', 'space', 'global'] : ['global'],
          description: hasSpace
            ? 'List scope. Default all = current space Library plus global Library.'
            : 'List scope. Only global is available outside a space.',
        },
        dir: {
          type: 'string',
          description: 'Optional: limit results to relative paths under this directory prefix.',
        },
        kind: {
          type: 'string',
          enum: [...KB_KIND_VALUES],
          description: 'Optional: restrict to one file kind.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'processing', 'ready', 'failed'],
          description: 'Optional: restrict to one indexing status.',
        },
        limit: {
          type: 'number',
          description: `Maximum files to return. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`,
        },
      },
    },
    async execute(input) {
      const scope = parseListScope(input.scope, hasSpace);
      const rawDir = typeof input.dir === 'string' ? input.dir.trim().replace(/^\/+|\/+$/g, '') : '';
      const dir = rawDir ? `${rawDir}/` : '';
      const kind = parseKbKind(input.kind);
      const rawStatus = typeof input.status === 'string' ? input.status : '';
      const status = ['pending', 'processing', 'ready', 'failed'].includes(rawStatus) ? rawStatus as kb.KbStatus : undefined;
      const limit = Math.min(
        MAX_LIST_LIMIT,
        Math.max(1, Math.floor(Number(input.limit ?? DEFAULT_LIST_LIMIT))),
      );

      const files: LibraryFileEntry[] = [];
      if (scope === 'global' || scope === 'all') {
        files.push(...kb.listFiles(opts.userId).map((row) => ({ scope: 'global' as const, row })));
      }
      if ((scope === 'space' || scope === 'all') && opts.spaceId) {
        files.push(...spaceLibrary.listFiles(opts.userId, opts.spaceId)
          .map((row) => ({ scope: 'space' as const, row })));
      }

      const filtered = files
        .filter(({ row }) => !dir || row.rel_path === rawDir || row.rel_path.startsWith(dir))
        .filter(({ row }) => !kind || row.kind === kind)
        .filter(({ row }) => !status || row.status === status)
        .sort((a, b) =>
          statusRank(a.row.status) - statusRank(b.row.status)
          || a.scope.localeCompare(b.scope)
          || a.row.rel_path.localeCompare(b.row.rel_path),
        );

      const globalSummary = kb.statusSummary(opts.userId);
      const spaceSummary = opts.spaceId ? spaceLibrary.statusSummary(opts.userId, opts.spaceId) : null;
      const summaryBits = [
        `global total=${globalSummary.total} ready=${globalSummary.ready} processing=${globalSummary.processing} pending=${globalSummary.pending} failed=${globalSummary.failed}`,
      ];
      if (spaceSummary) {
        summaryBits.push(
          `space total=${spaceSummary.total} ready=${spaceSummary.ready} processing=${spaceSummary.processing} pending=${spaceSummary.pending} failed=${spaceSummary.failed}`,
        );
      }

      const lines = [
        `Library files (${summaryBits.join('; ')}):`,
      ];
      if (!filtered.length) {
        lines.push('No files match the requested filters.');
        return { content: lines.join('\n') };
      }

      const shown = filtered.slice(0, limit);
      for (const { scope: fileScope, row } of shown) {
        lines.push(
          `- scope=${fileScope} path=${row.rel_path} kind=${row.kind} status=${row.status}`
          + ` chunks=${row.chunks} size=${formatBytes(row.bytes)}`
          + (row.error ? ` error="${previewOf(row.error)}"` : ''),
        );
      }
      if (filtered.length > shown.length) {
        lines.push(`... ${filtered.length - shown.length} more file(s). Increase limit or narrow dir/kind/status.`);
      }
      return { content: lines.join('\n') };
    },
  };
}

function createKbSearchTool(opts: KbToolsOpts): AgentTool {
  const hasSpace = !!opts.spaceId;
  return {
    name: 'kb_search',
    // Parallel-safe (verified 2026-06-18 by reading fastembed@2.1.0). kb_search
    // embeds the query on the process-wide shared ONNX embedder singleton, but
    // CONCURRENT calls on that ONE session are safe: fastembed's embed() keeps
    // all state local and already calls the tokenizer concurrently within a
    // batch (`Promise.all(...encode)`), and onnxruntime `InferenceSession.run()`
    // is concurrency-safe on a shared session (the documented serving pattern).
    // PC/CLAUDE.md's ONNX rule warns against multiple SESSIONS (worker_threads
    // each holding their own → memory blowup), NOT concurrent run() on one
    // session — which is all this is. (Same reason in-process indexing×search
    // concurrent embed is fine.)
    executionMode: 'parallel',
    description:
      'Semantic search over the user Library'
      + (hasSpace ? ' (current space + global by default)' : '')
      + '. Returns the top-k most similar chunks across processed files. Prefer this\n'
      + 'over manual directory walking / grep — the embeddings handle synonymy and\n'
      + 'cross-language matches. Call `kb_read` with the returned `scope` + `path`\n'
      + 'to fetch a full chunk or file after picking promising hits.\n'
      + 'Files still being processed (status=processing) or failed (status=failed) are\n'
      + 'excluded; the `processing` counter in the response tells you how many are in\n'
      + 'flight if you want to retry shortly.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query. Natural language works; no regex/operators.',
        },
        k: {
          type: 'number',
          description: 'Top-k result count. Default 8, max 30.',
        },
        dir: {
          type: 'string',
          description: 'Optional: limit Library search to files under this relative subdirectory.',
        },
        path: {
          type: 'string',
          description: 'Optional: limit Library search to one exact Library-relative file path. Use paths returned by kb_list.',
        },
        kind: {
          type: 'string',
          enum: [...KB_KIND_VALUES],
          description: 'Optional: restrict to one file kind.',
        },
        scope: {
          type: 'string',
          enum: hasSpace ? ['all', 'space', 'global'] : ['global'],
          description: hasSpace
            ? 'Search scope. Default all = current space Library plus global Library.'
            : 'Search scope. Only global is available outside a space.',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'kb_search: `query` is required', isError: true };
      const k = Math.min(30, Math.max(1, Math.floor(Number(input.k ?? 8))));
      const kind = parseKbKind(input.kind);
      const rawDir = typeof input.dir === 'string' ? input.dir.trim() : '';
      const dir = rawDir || undefined;
      const rawPath = typeof input.path === 'string' ? input.path.trim().replace(/^\/+/, '') : '';
      const filePath = rawPath || undefined;
      const scope = parseSearchScope(input.scope, hasSpace);

      let vec: number[];
      try { vec = await kbEmbed.embedQuery(query); }
      catch (err) {
        const msg = (err as Error).message;
        log.warn('kb_search embed failed', {
          user_id: maskId(opts.userId),
          space_id: maskId(opts.spaceId),
          query_chars: query.length,
          k,
          kind,
          scope,
          error: logErrorRef(err),
        });
        return { content: `kb_search: embedding failed — ${msg}`, isError: true };
      }

      let hits: LibraryHit[];
      try {
        const globalSearchOpts: kb.KbSearchOpts = { k };
        if (dir) globalSearchOpts.dir = dir;
        if (filePath) globalSearchOpts.path = filePath;
        if (kind) globalSearchOpts.kind = kind;
        const spaceSearchOpts: kb.KbSearchOpts = { k };
        if (dir) spaceSearchOpts.dir = dir;
        if (filePath) spaceSearchOpts.path = filePath;
        if (kind) spaceSearchOpts.kind = kind;
        const collected: LibraryHit[] = [];
        if (scope === 'global' || scope === 'all') {
          collected.push(...kb.search(opts.userId, vec, globalSearchOpts).map((h) => ({ ...h, scope: 'global' as const })));
        }
        if ((scope === 'space' || scope === 'all') && opts.spaceId) {
          collected.push(...(await spaceLibrary.search(opts.userId, opts.spaceId, vec, spaceSearchOpts))
            .map((h) => ({ ...h, scope: 'space' as const })));
        }
        collected.sort((a, b) => b.score - a.score);
        hits = collected.slice(0, k);
      } catch (err) {
        const msg = (err as Error).message;
        log.warn('kb_search query failed', {
          user_id: maskId(opts.userId),
          space_id: maskId(opts.spaceId),
          query_chars: query.length,
          k,
          kind,
          scope,
          has_dir: !!dir,
          has_path: !!filePath,
          error: logErrorRef(err),
        });
        return { content: `kb_search: ${msg}`, isError: true };
      }

      const globalSummary = kb.statusSummary(opts.userId);
      const spaceSummary = opts.spaceId ? spaceLibrary.statusSummary(opts.userId, opts.spaceId) : null;
      const lines: string[] = [];
      if (!hits.length) {
        lines.push(`No results for "${query}".`);
        const processing = globalSummary.processing + (spaceSummary?.processing || 0);
        const total = globalSummary.total + (spaceSummary?.total || 0);
        if (processing > 0) {
          lines.push(`Note: ${processing} Library file(s) are still being processed — retry shortly.`);
        } else if (total === 0) {
          lines.push('The Library is empty.');
        }
        return { content: lines.join('\n') };
      }

      const summaryBits = [`global=${globalSummary.total}`];
      if (spaceSummary) summaryBits.push(`space=${spaceSummary.total}`);
      const processing = globalSummary.processing + (spaceSummary?.processing || 0);
      lines.push(`${hits.length} hit(s) for "${query}" (Library ${summaryBits.join(', ')}, processing=${processing}):`);
      for (const h of hits) {
        lines.push(
          `- scope=${h.scope} path=${h.rel_path} chunk=${h.chunk_idx} kind=${h.kind} score=${h.score.toFixed(3)}`
          + (h.title ? ` title="${h.title}"` : ''),
        );
        lines.push(`    ${previewOf(h.content)}`);
      }
      return { content: lines.join('\n') };
    },
  };
}

function createKbReadTool(opts: KbToolsOpts): AgentTool {
  const hasSpace = !!opts.spaceId;
  return {
    name: 'kb_read',
    executionMode: 'parallel',
    description:
      'Read a Library file\'s chunk content directly from the vector store.\n'
      + 'Use the `scope` and `path` fields returned by `kb_search`. Omit `chunk`\n'
      + 'to get the concatenated full body. Pass `chunk` (1-based) with optional\n'
      + '`window` (≥0) to fetch chunk N together with its ±window\n'
      + 'neighbours — use this when the kb_search preview isn\'t enough context.\n'
      + 'Chunks are ~400 chars each, so `window: 1` ≈ 3 chunks ≈ 1.2K chars.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Library-relative path (as returned by kb_search hits).' },
        source: {
          type: 'string',
          enum: ['library', 'attachment'],
          description: 'Source to read from. Default library. Use "attachment" with `name` to read a conversation attachment.',
        },
        name: {
          type: 'string',
          description: 'Attachment filename (only when source="attachment"). Use names from `material_list`.',
        },
        scope: {
          type: 'string',
          enum: hasSpace ? ['all', 'space', 'global'] : ['global'],
          description: hasSpace
            ? 'Read scope. Prefer the scope returned by kb_search. Default all tries space, then global.'
            : 'Read scope. Only global is available outside a space.',
        },
        chunk: { type: 'number', description: '1-based chunk index. Omit for full body.' },
        window: {
          type: 'number',
          description: 'Include ±window neighbour chunks around `chunk` for more context (default 0). Ignored when `chunk` is omitted.',
        },
      },
      required: ['path'],
    },
    async execute(input) {
      const src = input.source === 'attachment' ? 'attachment' : 'library';
      if (src === 'attachment') {
        const name = String(input.name ?? '').trim();
        if (!name) return { content: 'kb_read: `name` is required when source="attachment"', isError: true };
        if (!opts.cid) return { content: 'kb_read: no conversation context (cid) to read attachments from', isError: true };
        const resolved = chatAttachments.resolveAttachmentAbsPath(opts.userId, opts.cid, name);
        if (!resolved.ok) {
          const why = 'error' in resolved ? resolved.error : 'unknown';
          return { content: `kb_read: attachment not accessible — ${why}`, isError: true };
        }
        const { absPath, kind } = resolved;
        let text: string;
        try {
          ({ text } = await fileIndexer.getExtractedText(opts.userId, absPath));
        } catch (err) {
          return {
            content: `kb_read: attachment extraction failed — ${(err as Error).message}`,
            isError: true,
          };
        }
        const meta = await fileIndexer.statFile(opts.userId, absPath);
        const header = `<attachment name="${name}" kind="${kind}" bytes="${meta.bytes}">`;
        return { content: `${header}\n${text}\n</attachment>` };
      }
      const relPath = String(input.path ?? '').trim();
      if (!relPath) return { content: 'kb_read: `path` is required', isError: true };
      const scope = parseReadScope(input.scope, hasSpace);
      let source: {
        scope: LibraryScope;
        row: kb.KbFileRow;
        chunks: Array<{ chunk_idx: number; title: string | null; content: string }>;
      } | null = null;
      if ((scope === 'space' || scope === 'all') && opts.spaceId) {
        const row = spaceLibrary.getFileByPath(opts.userId, opts.spaceId, relPath);
        if (row) {
          source = {
            scope: 'space',
            row,
            chunks: spaceLibrary.readFileChunks(opts.userId, opts.spaceId, relPath),
          };
        }
      }
      if (!source && (scope === 'global' || scope === 'all')) {
        const row = kb.getFileByPath(opts.userId, relPath);
        if (row) {
          source = {
            scope: 'global',
            row,
            chunks: kb.readFileChunks(opts.userId, relPath),
          };
        }
      }
      if (!source) return { content: `kb_read: not found — ${relPath}`, isError: true };
      const { row, chunks } = source;
      if (row.status !== 'ready') {
        return {
          content: `kb_read: file status=${row.status}${row.error ? ` (${row.error})` : ''}`,
          isError: true,
        };
      }

      if (!chunks.length) {
        return { content: `kb_read: no chunks for ${relPath}`, isError: true };
      }

      const header = `<library-file scope="${source.scope}" path="${relPath}" kind="${row.kind}" chunks="${chunks.length}" bytes="${row.bytes}">`;
      if (input.chunk != null) {
        const n = Math.floor(Number(input.chunk));
        if (!Number.isFinite(n) || n < 1 || n > chunks.length) {
          return {
            content: `kb_read: chunk ${n} out of range; total=${chunks.length}`,
            isError: true,
          };
        }
        const w = Math.max(0, Math.floor(Number(input.window ?? 0)));
        const lo = Math.max(1, n - w);
        const hi = Math.min(chunks.length, n + w);
        const parts = chunks.slice(lo - 1, hi).map((c) => {
          const hit = c.chunk_idx === n ? ' · hit' : '';
          return `<!-- chunk ${c.chunk_idx}/${chunks.length}${c.title ? ` · ${c.title}` : ''}${hit} -->\n${c.content}`;
        });
        const rangeNote = lo === hi ? `chunk ${n}` : `chunks ${lo}..${hi} (hit=${n})`;
        return { content: `${header}\n<!-- ${rangeNote} -->\n${parts.join('\n\n')}\n</library-file>` };
      }

      const body = chunks
        .map((c) => `<!-- chunk ${c.chunk_idx}/${chunks.length}${c.title ? ` · ${c.title}` : ''} -->\n${c.content}`)
        .join('\n\n');
      return { content: `${header}\n${body}\n</library-file>` };
    },
  };
}

/** Build the KB tools for one runner. */
export function createKbTools(opts: KbToolsOpts): AgentTool[] {
  return [
    createKbListTool(opts),
    createKbSearchTool(opts),
    createKbReadTool(opts),
    createMaterialSearchTool(opts),
    createMaterialListTool(opts),
    createAskMaterialsTool(opts),
  ];
}

/**
 * `ask_materials` — grounded Q&A evidence service (COGSEED-39 ① Phase 4a).
 * Runs the material-set hybrid search (Library + attachments), applies a
 * fused-score threshold, and returns an evidence package with a citation
 * contract — or an explicit no-material / low-confidence marker. The model
 * answers ONLY from the evidence and cites `path#chunk N`.
 */
function createAskMaterialsTool(opts: KbToolsOpts): AgentTool {
  const hasSpace = !!opts.spaceId;
  return {
    name: 'ask_materials',
    description:
      'Grounded Q&A over the material set: hybrid search (Library + this conversation\'s\n'
      + 'attachments) with a relevance threshold. Returns either an evidence package\n'
      + 'to answer from — cite every claim as `path#chunk N` — or an explicit\n'
      + '"no material" / "low confidence" marker. Use for questions about imported\n'
      + 'materials; do NOT answer material questions from memory or web search\n'
      + 'without consulting this (or material_search) first.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The user\'s question about the materials.',
        },
        k: {
          type: 'number',
          description: 'Max evidence hits. Default 8, max 30.',
        },
        scope: {
          type: 'string',
          enum: hasSpace ? ['all', 'space', 'global'] : ['global'],
          description: hasSpace
            ? 'Search scope. Default all = current space Library plus global Library.'
            : 'Search scope. Only global is available outside a space.',
        },
        min_score: {
          type: 'number',
          description: 'Optional fused-score floor for evidence (default 0.0015). Raise it to demand stronger matches.',
        },
      },
      required: ['question'],
    },
    async execute(input) {
      const question = String(input.question ?? '').trim();
      if (!question) return { content: 'ask_materials: `question` is required', isError: true };
      const res = await askMaterials({
        userId: opts.userId,
        ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
        ...(opts.cid ? { cid: opts.cid, attachments: true } : {}),
        query: question,
        ...(input.k !== undefined ? { k: Number(input.k) } : {}),
        ...(hasSpace && input.scope !== undefined ? { scope: input.scope as MaterialSearchOptions['scope'] } : {}),
        ...(input.min_score !== undefined ? { minScore: Number(input.min_score) } : {}),
      });
      return { content: formatEvidence(res) };
    },
  };
}

/**
 * `material_list` — inventory the full material boundary for the current
 * conversation: Library files (global + space) plus conversation
 * attachments and space artifacts, each marked in-scope or not
 * (COGSEED-39 ① Phase 3). Read-only.
 */
function createMaterialListTool(opts: KbToolsOpts): AgentTool {
  const hasSpace = !!opts.spaceId;
  return {
    name: 'material_list',
    executionMode: 'parallel',
    description:
      'List everything in the current material boundary for grounded Q&A: Library files'
      + (hasSpace ? ' (global + current space)' : '')
      + ', this conversation\'s attachments'
      + (hasSpace ? ', and space artifacts' : '')
      + '. Each entry is marked in-scope or out-of-scope. Use before asking '
      + '"what materials can you answer from?" or when a question\'s scope is unclear.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum entries per section. Default 50, max 200.',
        },
      },
    },
    async execute(input) {
      const limit = Math.min(200, Math.max(1, Math.floor(Number(input.limit ?? 50))));
      const boundary = await resolveMaterialSet({
        userId: opts.userId,
        ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
        ...(opts.cid ? { cid: opts.cid } : {}),
      });

      const lines: string[] = [];
      lines.push(`Material boundary (history=${boundary.history}, library global=${boundary.library.global} space=${boundary.library.space}):`);

      const library: Array<{ scope: string; path: string; status: string; chunks: number }> = [];
      if (boundary.library.global) {
        for (const row of kb.listFiles(opts.userId)) {
          library.push({ scope: 'global', path: row.rel_path, status: row.status, chunks: row.chunks });
        }
      }
      if (boundary.library.space && opts.spaceId) {
        for (const row of spaceLibrary.listFiles(opts.userId, opts.spaceId)) {
          library.push({ scope: 'space', path: row.rel_path, status: row.status, chunks: row.chunks });
        }
      }
      if (library.length) {
        lines.push('Library:');
        for (const f of library.slice(0, limit)) {
          lines.push(`- [library/${f.scope}] ${f.path} (status=${f.status}, chunks=${f.chunks})`);
        }
        if (library.length > limit) lines.push(`... ${library.length - limit} more library file(s)`);
      } else {
        lines.push('Library: (empty)');
      }

      if (boundary.attachments.length) {
        lines.push('Attachments:');
        for (const a of boundary.attachments.slice(0, limit)) {
          lines.push(`- [attachment] ${a.name} (${a.kind}, ${formatBytes(a.bytes)}, ${a.inScope ? 'in-scope' : 'OUT-OF-SCOPE'})`);
        }
        if (boundary.attachments.length > limit) lines.push(`... ${boundary.attachments.length - limit} more attachment(s)`);
      } else {
        lines.push('Attachments: (none)');
      }

      if (boundary.artifacts.length) {
        lines.push('Space artifacts:');
        for (const ar of boundary.artifacts.slice(0, limit)) {
          lines.push(`- [artifact] ${ar.name} (${ar.type}${ar.ext}, ${ar.inScope ? 'in-scope' : 'OUT-OF-SCOPE'})`);
        }
        if (boundary.artifacts.length > limit) lines.push(`... ${boundary.artifacts.length - limit} more artifact(s)`);
      } else {
        lines.push('Space artifacts: (none)');
      }

      return { content: lines.join('\n') };
    },
  };
}

/**
 * `material_search` — hybrid (vector + BM25 keyword) retrieval over the
 * Library, fusing both signals with RRF. Same read-only posture as
 * kb_search, but returns a unified hit shape (scope/path/chunkIdx + snippet)
 * that doubles as the citation anchor for grounded answering
 * (COGSEED-39 ① Phase 2).
 */
function createMaterialSearchTool(opts: KbToolsOpts): AgentTool {
  const hasSpace = !!opts.spaceId;
  return {
    name: 'material_search',
    executionMode: 'parallel',
    description:
      'Hybrid search over the user Library (semantic vector + BM25 keyword, fused)'
      + (hasSpace ? ' (current space + global by default)' : '')
      + ', plus this conversation\'s attachments when present.'
      + ' Use for grounded Q&A about imported materials: returns the top-k most\n'
      + 'relevant chunks with a citation anchor (scope + path + chunk index) and a\n'
      + 'short snippet. Preferred over `kb_search` when the question mixes exact\n'
      + 'terms/ids (which keyword matching catches) with meaning (which vectors\n'
      + 'catch). After picking hits, read full chunks with `kb_read` using the\n'
      + 'returned scope + path.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query. Natural language works; exact terms/ids help the keyword side.',
        },
        k: {
          type: 'number',
          description: 'Top-k result count. Default 8, max 30.',
        },
        dir: {
          type: 'string',
          description: 'Optional: limit search to files under this relative subdirectory.',
        },
        path: {
          type: 'string',
          description: 'Optional: limit search to one exact Library-relative file path.',
        },
        kind: {
          type: 'string',
          enum: [...KB_KIND_VALUES],
          description: 'Optional: restrict to one file kind.',
        },
        scope: {
          type: 'string',
          enum: hasSpace ? ['all', 'space', 'global'] : ['global'],
          description: hasSpace
            ? 'Search scope. Default all = current space Library plus global Library.'
            : 'Search scope. Only global is available outside a space.',
        },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = String(input.query ?? '').trim();
      if (!query) return { content: 'material_search: `query` is required', isError: true };
      const searchOpts: MaterialSearchOptions = {
        userId: opts.userId,
        ...(opts.spaceId ? { spaceId: opts.spaceId } : {}),
        ...(opts.cid ? { cid: opts.cid, attachments: true } : {}),
        query,
        ...(input.k !== undefined ? { k: Number(input.k) } : {}),
        ...(typeof input.dir === 'string' && input.dir.trim() ? { dir: input.dir.trim() } : {}),
        ...(typeof input.path === 'string' && input.path.trim() ? { path: input.path.trim() } : {}),
        ...(parseKbKind(input.kind) ? { kind: parseKbKind(input.kind)! } : {}),
        ...(hasSpace && input.scope !== undefined ? { scope: input.scope as MaterialSearchOptions['scope'] } : {}),
      };

      const res = await searchMaterials(searchOpts);
      const lines = [`Material search hits (${res.summary.join('; ')}):`];
      if (!res.hits.length) {
        lines.push('No relevant material found for this query.');
        return { content: lines.join('\n') };
      }
      for (const h of res.hits) {
        const anchor = `[${h.scope}] ${h.path}#chunk ${h.chunkIdx}`;
        const scores = `score=${h.score.toFixed(3)}`
          + (h.vectorScore !== undefined ? ` vec=${h.vectorScore.toFixed(3)}` : '')
          + (h.keywordScore !== undefined ? ` kw=${h.keywordScore.toFixed(3)}` : '');
        lines.push(`- ${anchor} ${scores}${h.title ? ` · ${h.title}` : ''}\n  ${h.snippet}`);
      }
      return { content: lines.join('\n') };
    },
  };
}
