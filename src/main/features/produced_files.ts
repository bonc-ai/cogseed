/**
 * Select the files that deserve a compact user-facing footer on a completed
 * assistant message. The workspace file listing remains the source of truth
 * for every supporting file; this module only decides what is prominent in
 * chat.
 *
 * The selector is deliberately conservative when no rendered/package output
 * exists: an ambiguous `.md`, `.py`, or `.json` may itself be what the user
 * requested, so it stays visible. When a higher-confidence terminal output is
 * present, likely sources and assets are suppressed from the message footer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const PROCESS_DIR_NAMES = new Set([
  '.cache', '.tmp', '.temp',
  'cache', 'caches',
  'intermediate', 'intermediates',
  'logs',
  'scratch',
  'temp', 'tmp',
  'thumbs', 'thumbnails',
  'work', 'working',
]);

const PROCESS_EXTS = new Set([
  'bak', 'log', 'map', 'pyc', 'temp', 'tmp',
]);

const PROCESS_EXACT_NAMES = new Set([
  '.ds_store',
  'debug.log',
  'manifest.json',
  'metadata.json',
]);

const EXPORTED_DOCUMENT_EXTS = new Set([
  'csv', 'doc', 'docx', 'key', 'numbers', 'pages', 'pdf',
  'ppt', 'pptx', 'xls', 'xlsx', 'zip',
]);
const VIDEO_EXTS = new Set(['m4v', 'mov', 'mp4', 'webm']);
const VIDEO_COMPANION_EXTS = new Set(['srt', 'vtt']);
const AUDIO_EXTS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
const HTML_EXTS = new Set(['htm', 'html']);
const IMAGE_EXTS = new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const OFFICE_PREVIEW_EXTS = new Set(['docm', 'docx', 'xlsm', 'xlsx', 'pptm', 'pptx']);
const MARKDOWN_EXTS = new Set(['markdown', 'md']);
const TEXT_PREVIEW_EXTS = new Set([
  'bash', 'bat', 'c', 'cc', 'cjs', 'cmd', 'conf', 'cpp', 'css', 'csv',
  'gql', 'go', 'graphql', 'h', 'hpp', 'ini', 'java', 'js', 'json', 'jsx',
  'kt', 'less', 'log', 'mjs', 'ps1', 'py', 'pyi', 'rb', 'rs', 'scss',
  'sh', 'sql', 'toml', 'ts', 'tsx', 'tsv', 'txt', 'xml', 'yaml', 'yml',
  'zsh',
]);

export type ProducedFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'office'
  | 'html'
  | 'markdown'
  | 'text'
  | 'unsupported';

export type ProducedFileValidation = {
  path: string;
  status: 'ready' | 'preview_failed' | 'invalid';
  exists: boolean;
  bytes: number;
  non_empty: boolean;
  kind: ProducedFileKind;
  preview: 'available' | 'fallback_only' | 'failed';
  failure_code?: 'missing' | 'not_file' | 'empty' | 'unreadable' | 'stat_failed';
  evidence: {
    validator: 'filesystem_stat';
    basis: 'exists_and_non_empty';
    producer_tool?: string;
  };
  fallbacks: Array<'open' | 'reveal'>;
};

type ProducedCandidate = {
  path: string;
  ext: string;
};

function pathSegments(input: string): string[] {
  return String(input || '').split(/[\\/]/).filter(Boolean);
}

function extensionOf(input: string): string {
  return path.extname(input).slice(1).toLowerCase();
}

function producedFileKind(input: string): ProducedFileKind {
  const ext = extensionOf(input);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_PREVIEW_EXTS.has(ext)) return 'office';
  if (HTML_EXTS.has(ext)) return 'html';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (TEXT_PREVIEW_EXTS.has(ext)) return 'text';
  return 'unsupported';
}

/**
 * Build a durable validation snapshot for user-visible outputs. This is kept
 * separate from selection: selection answers which files are deliverables;
 * validation answers whether each selected deliverable is actually usable.
 */
function producerToolForPath(input: string, processItems: readonly unknown[]): string | undefined {
  for (let index = processItems.length - 1; index >= 0; index -= 1) {
    const item = processItems[index] as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') continue;
    const event = (item.event && typeof item.event === 'object'
      ? item.event
      : undefined) as Record<string, unknown> | undefined;
    if (!event || (event.stream !== 'tool' && event.stream !== 'cli')) continue;
    const data = (event.data && typeof event.data === 'object'
      ? event.data
      : {}) as Record<string, unknown>;
    let serialized = '';
    try { serialized = JSON.stringify(data); } catch { /* ignore malformed event */ }
    if (!serialized.includes(input)) continue;
    const rawTool = data.name || data.toolName || data.tool;
    const tool = typeof rawTool === 'string' ? rawTool.trim().slice(0, 120) : '';
    if (tool) return tool;
  }
  return undefined;
}

export function validateProducedFiles(
  paths: Iterable<string>,
  processItems: readonly unknown[] = [],
): ProducedFileValidation[] {
  const results: ProducedFileValidation[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const kind = producedFileKind(value);
    const previewAvailable = kind !== 'unsupported';
    const producerTool = producerToolForPath(value, processItems);
    const base = {
      path: value,
      kind,
      evidence: {
        validator: 'filesystem_stat' as const,
        basis: 'exists_and_non_empty' as const,
        ...(producerTool ? { producer_tool: producerTool } : {}),
      },
    };
    try {
      const stat = fs.statSync(value);
      if (!stat.isFile()) {
        results.push({
          ...base,
          status: 'invalid',
          exists: true,
          bytes: stat.size,
          non_empty: false,
          preview: 'failed',
          failure_code: 'not_file',
          fallbacks: ['reveal'],
        });
        continue;
      }
      if (stat.size <= 0) {
        results.push({
          ...base,
          status: 'invalid',
          exists: true,
          bytes: 0,
          non_empty: false,
          preview: 'failed',
          failure_code: 'empty',
          fallbacks: ['open', 'reveal'],
        });
        continue;
      }
      try {
        fs.accessSync(value, fs.constants.R_OK);
      } catch {
        results.push({
          ...base,
          status: 'invalid',
          exists: true,
          bytes: stat.size,
          non_empty: true,
          preview: 'failed',
          failure_code: 'unreadable',
          fallbacks: ['reveal'],
        });
        continue;
      }
      results.push({
        ...base,
        status: 'ready',
        exists: true,
        bytes: stat.size,
        non_empty: true,
        preview: previewAvailable ? 'available' : 'fallback_only',
        fallbacks: ['open', 'reveal'],
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      results.push({
        ...base,
        status: 'invalid',
        exists: false,
        bytes: 0,
        non_empty: false,
        preview: 'failed',
        failure_code: code === 'ENOENT' ? 'missing' : 'stat_failed',
        fallbacks: [],
      });
    }
  }
  return results;
}

function isObviousProcessFile(input: string): boolean {
  const segments = pathSegments(input);
  if (!segments.length) return true;
  const base = segments[segments.length - 1].toLowerCase();
  // Only inspect the immediate parent. Absolute paths may legitimately live
  // below a user folder named `work` or `temp`; treating every ancestor as a
  // process hint would hide all outputs in that workspace.
  const parent = (segments[segments.length - 2] || '').toLowerCase();
  if (PROCESS_DIR_NAMES.has(parent)) return true;
  if (PROCESS_EXACT_NAMES.has(base)) return true;
  if (PROCESS_EXTS.has(extensionOf(base))) return true;
  return /(?:^|[-_.])(?:debug|preview|thumb|thumbnail|trace)(?=[-_.]|$)/i.test(base);
}

function uniqueCandidates(paths: Iterable<string>): ProducedCandidate[] {
  const out: ProducedCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value) || isObviousProcessFile(value)) continue;
    seen.add(value);
    out.push({ path: value, ext: extensionOf(value) });
  }
  return out;
}

function pathsWithExts(
  candidates: readonly ProducedCandidate[],
  exts: ReadonlySet<string>,
): string[] {
  return candidates.filter((item) => exts.has(item.ext)).map((item) => item.path);
}

/**
 * Return only the high-confidence deliverables for a message footer.
 * Priority models common production chains:
 * source markdown/html/assets -> Office/PDF/archive, composition assets ->
 * rendered video/audio, and image-generation metadata -> final images.
 */
export function selectVisibleProducedFiles(
  paths: Iterable<string>,
  explicitlyPublished?: Iterable<string>,
): string[] {
  const allPaths: string[] = [];
  const available = new Set<string>();
  for (const raw of paths) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || available.has(value)) continue;
    available.add(value);
    allPaths.push(value);
  }
  if (explicitlyPublished !== undefined) {
    const explicit: string[] = [];
    const explicitSeen = new Set<string>();
    for (const raw of explicitlyPublished) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value || explicitSeen.has(value) || !available.has(value)) continue;
      explicitSeen.add(value);
      explicit.push(value);
    }
    // An explicit empty declaration is meaningful: the turn created working
    // files but has no file deliverable that belongs in the message footer.
    return explicit;
  }

  const candidates = uniqueCandidates(allPaths);
  if (!candidates.length) return [];

  const documents = pathsWithExts(candidates, EXPORTED_DOCUMENT_EXTS);
  if (documents.length) return documents;

  const videos = pathsWithExts(candidates, VIDEO_EXTS);
  if (videos.length) {
    return candidates
      .filter((item) => VIDEO_EXTS.has(item.ext) || VIDEO_COMPANION_EXTS.has(item.ext))
      .map((item) => item.path);
  }

  const html = pathsWithExts(candidates, HTML_EXTS);
  if (html.length) return html;

  const audio = pathsWithExts(candidates, AUDIO_EXTS);
  if (audio.length) return audio;

  const images = pathsWithExts(candidates, IMAGE_EXTS);
  if (images.length) return images;

  // No terminal-output signal: retain ambiguous files rather than hiding a
  // requested script, Markdown report, CSV, or JSON deliverable.
  return candidates.map((item) => item.path);
}
