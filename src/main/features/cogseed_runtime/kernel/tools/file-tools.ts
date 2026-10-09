import * as fs from 'node:fs';
import * as path from 'node:path';

import { capToolResult, DEFAULT_INLINE_RESULT_TOKENS, type WrapOpts } from '../../../../util/tool-result-cap';
import { getCachedMeta, getExtractedText, kindOf, readRange, statFile } from '../../../file_indexer';
import { cogseedRuntimeSessionToolResultsDir } from '../../../../paths';
import { normalizeRuntimePath, ensureRuntimeAllowedRoots, isRuntimeTranscriptPath } from './permissions';
import type { RuntimeToolName } from './catalog';
import type { RuntimeToolPolicy } from '../types';
import type { RuntimeSkillVersionPin } from '../../protocol';
import type { RuntimeActionApprovalClient } from './action-approval';

export interface RuntimeToolResult {
  content: string;
  isError?: boolean;
  persistedOutput?: {
    path: string;
    size: number;
    ref: string;
  };
}

export interface RuntimeToolCallContext {
  userId: string;
  runtimeSessionId: string;
  allowedRoots: readonly string[];
  writableRoots: readonly string[];
  pcDir: string;
  toolPolicy: RuntimeToolPolicy;
  allowedSkillIds?: readonly string[];
  skillVersionPins?: readonly RuntimeSkillVersionPin[];
  actionApproval?: RuntimeActionApprovalClient;
}

export interface RuntimeToolImplementation<TInput = Record<string, unknown>> {
  name: RuntimeToolName;
  execute(input: TInput, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult>;
}

export interface RuntimeToolResultOptions {
  userId: string;
  runtimeSessionId: string;
  maxInlineTokens?: number;
  signal?: AbortSignal | null;
}

function formatError(code: string, message: string): RuntimeToolResult {
  return { content: `[${code}] ${message}`, isError: true };
}


function escapeAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatStat(meta: { absPath: string; kind: string; bytes: number; totalChars?: number; source?: string }): string {
  const parts = [`path="${escapeAttr(meta.absPath)}"`, `kind="${escapeAttr(meta.kind)}"`, `bytes="${meta.bytes}"`];
  if (typeof meta.totalChars === 'number') parts.push(`total_chars="${meta.totalChars}"`);
  if (meta.source) parts.push(`source="${escapeAttr(meta.source)}"`);
  return parts.join(' ');
}

function lineRange(text: string, startLine: number): string {
  const lines = text.split(/\r?\n/);
  return lines.map((line, index) => `${startLine + index}\t${line}`).join('\n');
}

function renderBlock(openTag: string, lines: string[], closeTag: string): string {
  return [openTag, ...(lines.length ? lines : ['(none)']), closeTag].join('\n');
}

function compileQueryMatcher(query: string): { test: (candidate: string) => boolean; glob: boolean } {
  const q = query.trim();
  if (!q) return { test: () => true, glob: false };
  const glob = /[*?\[]/.test(q);
  if (!glob) {
    const lower = q.toLowerCase();
    return { glob: false, test: (candidate) => candidate.toLowerCase().includes(lower) };
  }
  const escaped = q.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${escaped}$`, 'i');
  return { glob: true, test: (candidate) => re.test(candidate) };
}

function compileSearchMatcher(pattern: string, useRegex: boolean): RegExp {
  if (!pattern.trim()) throw new Error('`pattern` is required');
  return useRegex
    ? new RegExp(pattern, 'ig')
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
}

function walkFiles(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

async function extractSearchableText(userId: string, absPath: string): Promise<string | null> {
  const kind = kindOf(absPath);
  if (kind === 'image' || kind === 'legacy_office') return null;
  if (kind === 'text') return fs.readFileSync(absPath, 'utf8');
  try {
    const { text } = await getExtractedText(userId, absPath);
    return text;
  } catch {
    return null;
  }
}

function toRuntimeResult(result: { content: string; isError?: boolean; persistedOutput?: { path: string; size: number; ref: string } }): RuntimeToolResult {
  return result;
}

async function capRuntimeResult(
  name: RuntimeToolName,
  result: RuntimeToolResult,
  ctx: RuntimeToolResultOptions,
): Promise<RuntimeToolResult> {
  const capped = capToolResult(name, result as any, { state: {} } as any, {
    maxInlineTokens: ctx.maxInlineTokens ?? DEFAULT_INLINE_RESULT_TOKENS,
    toolResultsDir: cogseedRuntimeSessionToolResultsDir(ctx.userId, ctx.runtimeSessionId),
  } satisfies WrapOpts);
  return toRuntimeResult(capped as RuntimeToolResult);
}

async function runStatFile(input: { path: string }, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult> {
  if (ctx.toolPolicy.fileRead !== 'explicit_roots') {
    return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime file read is not enabled by policy');
  }
  try {
    const abs = normalizeRuntimePath(input.path, ctx.allowedRoots);
    const meta = await statFile(ctx.userId, abs);
    const kind = meta.kind;
    return { content: formatStat({ absPath: abs, kind, bytes: meta.bytes, totalChars: meta.totalChars, source: meta.source }) };
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}

async function runReadFile(input: { path: string; charStart?: number; charEnd?: number }, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult> {
  if (ctx.toolPolicy.fileRead !== 'explicit_roots') {
    return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime file read is not enabled by policy');
  }
  try {
    const abs = normalizeRuntimePath(input.path, ctx.allowedRoots);
    const slice = await readRange(ctx.userId, abs, {
      charStart: typeof input.charStart === 'number' ? input.charStart : undefined,
      charEnd: typeof input.charEnd === 'number' ? input.charEnd : undefined,
    });
    const totalChars = slice.meta.totalChars ?? slice.content.length;
    const endLine = slice.startLine + Math.max(0, slice.content.split(/\r?\n/).length - 1);
    return {
      content: [
        `<runtime-file path="${escapeAttr(abs)}" kind="${escapeAttr(slice.meta.kind)}" total_chars="${totalChars}" covered="${slice.range.charStart}-${slice.range.charEnd}" lines="${slice.startLine}-${endLine}">`,
        lineRange(slice.content, slice.startLine),
        `</runtime-file>`,
      ].join('\n'),
    };
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}

async function runSearchFiles(input: { query?: string }, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult> {
  if (ctx.toolPolicy.fileRead !== 'explicit_roots') {
    return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime file read is not enabled by policy');
  }
  try {
    const roots = ensureRuntimeAllowedRoots(ctx.allowedRoots);
    const matcher = compileQueryMatcher(String(input.query ?? ''));
    const hits: string[] = [];
    for (const root of roots) {
      for (const abs of walkFiles(root, 5000)) {
        if (isRuntimeTranscriptPath(abs)) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        const name = path.basename(abs);
        if (!matcher.test(name) && !matcher.test(rel)) continue;
        const st = fs.statSync(abs);
        const meta = getCachedMeta(ctx.userId, abs);
        hits.push([`path="${escapeAttr(abs)}"`, `name="${escapeAttr(name)}"`, `bytes="${st.size}"`, 'source="explicit_root"', meta?.totalChars ? `total_chars="${meta.totalChars}"` : ''].filter(Boolean).join(' '));
      }
    }
    return { content: renderBlock(`<runtime-search query="${escapeAttr(input.query ?? '')}">`, hits, '</runtime-search>') };
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}

async function runGrepFiles(input: { pattern: string; regex?: boolean; glob?: string; output_mode?: 'content' | 'files' | 'count' }, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult> {
  if (ctx.toolPolicy.fileRead !== 'explicit_roots') {
    return formatError('E_RUNTIME_PERMISSION_DENIED', 'runtime file read is not enabled by policy');
  }
  try {
    const pattern = String(input.pattern ?? '').trim();
    if (!pattern) return formatError('E_BAD_INPUT', '`pattern` is required');
    const roots = ensureRuntimeAllowedRoots(ctx.allowedRoots);
    const matcher = compileSearchMatcher(pattern, input.regex === true);
    const glob = typeof input.glob === 'string' ? input.glob.trim() : '';
    const globMatcher = glob ? compileQueryMatcher(glob) : null;
    const mode = input.output_mode === 'files' || input.output_mode === 'count' ? input.output_mode : 'content';
    const hits: string[] = [];
    const seenFiles = new Set<string>();
    for (const root of roots) {
      for (const abs of walkFiles(root, 5000)) {
        if (isRuntimeTranscriptPath(abs)) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (globMatcher) {
          const cmp = glob.includes('/') ? rel : path.basename(abs);
          if (!globMatcher.test(cmp)) continue;
        }
        const text = await extractSearchableText(ctx.userId, abs);
        if (text === null) continue;
        const lines = text.split(/\r?\n/);
        let matchCount = 0;
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
          const line = lines[lineNo];
          matcher.lastIndex = 0;
          const matches = line.match(matcher);
          if (!matches || !matches.length) continue;
          matchCount += matches.length;
          if (mode === 'content') {
            hits.push(`${abs}:${lineNo + 1}:${line}`);
          }
        }
        if (matchCount > 0 && mode === 'files') {
          if (!seenFiles.has(abs)) {
            seenFiles.add(abs);
            hits.push(abs);
          }
        }
        if (matchCount > 0 && mode === 'count') {
          hits.push(`${abs}: ${matchCount}`);
        }
      }
    }
    return { content: renderBlock(`<runtime-grep pattern="${escapeAttr(pattern)}">`, hits, '</runtime-grep>') };
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}


function normalizeWritableRuntimePath(candidate: unknown, ctx: RuntimeToolCallContext): string {
  if (ctx.toolPolicy.fileWrite !== 'explicit_writable_roots') {
    throw Object.assign(new Error('runtime file write is not enabled by policy'), { code: 'E_RUNTIME_PERMISSION_DENIED' });
  }
  return normalizeRuntimePath(String(candidate ?? ''), ctx.writableRoots);
}

function atomicWriteUtf8(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

async function runWriteFile(input: { path: string; content?: string }, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult> {
  try {
    const abs = normalizeWritableRuntimePath(input.path, ctx);
    const content = typeof input.content === 'string' ? input.content : '';
    atomicWriteUtf8(abs, content);
    return { content: `written path="${escapeAttr(abs)}" bytes="${Buffer.byteLength(content, 'utf8')}"` };
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}

async function runEditFile(input: { path: string; old_string?: string; new_string?: string; replace_all?: boolean }, ctx: RuntimeToolCallContext): Promise<RuntimeToolResult> {
  try {
    const abs = normalizeWritableRuntimePath(input.path, ctx);
    const oldString = typeof input.old_string === 'string' ? input.old_string : '';
    const newString = typeof input.new_string === 'string' ? input.new_string : '';
    if (!oldString) return formatError('E_BAD_INPUT', '`old_string` is required');
    const current = fs.readFileSync(abs, 'utf8');
    const occurrences = current.split(oldString).length - 1;
    if (occurrences === 0) return formatError('E_OLD_STRING_NOT_FOUND', '`old_string` was not found');
    if (occurrences > 1 && input.replace_all !== true) {
      return formatError('E_OLD_STRING_NOT_UNIQUE', '`old_string` appears more than once; pass replace_all=true to replace all occurrences');
    }
    const updated = input.replace_all === true
      ? current.split(oldString).join(newString)
      : current.replace(oldString, newString);
    atomicWriteUtf8(abs, updated);
    return { content: `edited path="${escapeAttr(abs)}" replacements="${input.replace_all === true ? occurrences : 1}"` };
  } catch (err) {
    return formatError((err as { code?: string }).code || 'E_RUNTIME_TOOL_FAILED', (err as Error).message);
  }
}

export const RUNTIME_FILE_TOOLS: readonly RuntimeToolImplementation[] = Object.freeze([
  { name: 'stat_file', execute: runStatFile },
  { name: 'read_file', execute: runReadFile },
  { name: 'search_files', execute: runSearchFiles },
  { name: 'grep_files', execute: runGrepFiles },
  { name: 'write_file', execute: runWriteFile },
  { name: 'edit_file', execute: runEditFile },
]);

export function createRuntimeFileTool(name: RuntimeToolName): RuntimeToolImplementation | null {
  return RUNTIME_FILE_TOOLS.find((tool) => tool.name === name) || null;
}

export function isRuntimeFileToolName(name: string): name is RuntimeToolName {
  return RUNTIME_FILE_TOOLS.some((tool) => tool.name === name);
}

export async function runRuntimeFileTool(
  name: RuntimeToolName,
  input: Record<string, unknown>,
  ctx: RuntimeToolCallContext,
  opts: RuntimeToolResultOptions,
): Promise<RuntimeToolResult> {
  const tool = createRuntimeFileTool(name);
  if (!tool) return formatError('E_RUNTIME_UNKNOWN_TOOL', `unknown runtime tool: ${name}`);
  const raw = await tool.execute(input, ctx);
  return capRuntimeResult(name, raw, opts);
}
