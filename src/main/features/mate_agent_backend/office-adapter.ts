import * as fs from 'node:fs';
import * as path from 'node:path';

import { mateRuntimeSessionToolResultsDir } from '../../paths';
import { isPathAllowed } from '../../util/path-sandbox';
import {
  closeOfficeFile as defaultCloseOfficeFile,
  officeCliAvailable as defaultOfficeCliAvailable,
  runOfficeCli as defaultRunOfficeCli,
  type OfficeCliResult,
  type RunOfficeCliOpts,
} from '../office/office_engine';
import type { RuntimeHostToolName } from '../mate_agent_runtime/protocol';
import { mateCapabilityArtifactRegistry, type MateCapabilityArtifactRegistry } from './capability-artifact-lifecycle';

export interface MateHostToolScope {
  userId: string;
  requestId: string;
  runtimeSessionId: string;
  readOnlyRoots: readonly string[];
  writableRoots: readonly string[];
  workingDir?: string;
}

export interface MateHostToolResult { content: string; isError?: boolean }

export interface MateOfficeAdapterDeps {
  officeCliAvailable?: () => boolean;
  runOfficeCli?: (args: string[], opts: RunOfficeCliOpts) => Promise<OfficeCliResult>;
  closeOfficeFile?: (file: string, cwd: string) => Promise<void>;
  artifactRegistry?: MateCapabilityArtifactRegistry;
}

export interface MateOfficeAdapter {
  run(name: Extract<RuntimeHostToolName, `office_${string}`>, input: Record<string, unknown>, scope: MateHostToolScope, opts?: { signal?: AbortSignal | null }): Promise<MateHostToolResult>;
  createDocx(input: Record<string, unknown>, scope: MateHostToolScope, opts?: { signal?: AbortSignal | null }): Promise<MateHostToolResult>;
  createXlsx(input: Record<string, unknown>, scope: MateHostToolScope, opts?: { signal?: AbortSignal | null }): Promise<MateHostToolResult>;
  createPptx(input: Record<string, unknown>, scope: MateHostToolScope, opts?: { signal?: AbortSignal | null }): Promise<MateHostToolResult>;
}

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const MAX_OPERATIONS = 500;
const MAX_RESULT_CHARS = 24_000;

function error(code: string, message: string): MateHostToolResult {
  return { content: `[${code}] ${message}`, isError: true };
}

function resolvePath(raw: unknown, scope: MateHostToolScope): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4_000) return null;
  return path.resolve(scope.workingDir ?? '.', raw);
}

function pathError(file: string | null, roots: readonly string[], action: string): MateHostToolResult | null {
  if (!file) return error('E_OFFICE_INPUT', 'path is required');
  if (!OFFICE_EXTENSIONS.has(path.extname(file).toLowerCase())) return error('E_OFFICE_INPUT', 'only .docx, .xlsx, and .pptx are supported');
  if (!roots.length || !isPathAllowed(file, roots)) return error('E_PATH_OUT_OF_SCOPE', `Office ${action} path is outside the Runtime scope`);
  return null;
}

function safeToken(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 2_000 || value.startsWith('-')) throw new Error(`${label} is invalid`);
  return value;
}

function normalizeOperations(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OPERATIONS) throw new Error(`operations must contain 1-${MAX_OPERATIONS} entries`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`operation ${index + 1} must be an object`);
    const raw = item as Record<string, unknown>;
    const command = raw.action ?? raw.command;
    if (command !== 'set' && command !== 'add' && command !== 'remove') throw new Error(`operation ${index + 1} has an invalid action`);
    const out: Record<string, unknown> = { command };
    const target = safeToken(raw.path, 'operation path');
    const parent = safeToken(raw.parent, 'operation parent');
    const type = safeToken(raw.type, 'operation type');
    if (target) out.path = target;
    if (parent) out.parent = parent;
    if (type) out.type = type;
    if ((command === 'set' || command === 'remove') && !target) throw new Error(`operation ${index + 1} requires path`);
    if (command === 'add' && (!parent || !type)) throw new Error(`operation ${index + 1} requires parent and type`);
    if (raw.props !== undefined) {
      if (!raw.props || typeof raw.props !== 'object' || Array.isArray(raw.props)) throw new Error(`operation ${index + 1} props must be an object`);
      const props: Record<string, string> = {};
      const entries = Object.entries(raw.props as Record<string, unknown>);
      if (entries.length > 50) throw new Error(`operation ${index + 1} has too many props`);
      for (const [key, val] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof val)) throw new Error(`operation ${index + 1} has an invalid prop`);
        if (/^(?:src|source|file|image|path)$/i.test(key)) throw new Error(`operation ${index + 1} external file props are not allowed`);
        const text = String(val);
        if (text.length > 10_000) throw new Error(`operation ${index + 1} prop is too long`);
        props[key] = text;
      }
      out.props = props;
    }
    return out;
  });
}

function bounded(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
}

function normalizeParagraphs(input: Record<string, unknown>): Array<Record<string, unknown>> {
  const paragraphs = Array.isArray(input.paragraphs) ? input.paragraphs : [];
  return paragraphs.slice(0, 500).map((paragraph, index) => {
    if (!paragraph || typeof paragraph !== 'object' || Array.isArray(paragraph)) throw new Error(`paragraph ${index + 1} must be an object`);
    const row = paragraph as Record<string, unknown>;
    const text = typeof row.text === 'string' ? row.text : '';
    if (!text) throw new Error(`paragraph ${index + 1} text is required`);
    return { action: 'set', path: `/paragraphs/${index}`, props: { text } };
  });
}

function normalizeOfficeCreateInput(input: Record<string, unknown>, ext: string): { path: string; operations: Array<Record<string, unknown>>; preview: boolean } {
  const file = typeof input.path === 'string' ? input.path : '';
  const operations = input.operations !== undefined ? normalizeOperations(input.operations) : normalizeParagraphs(input);
  const preview = input.preview !== false;
  if (!file.endsWith(ext)) throw new Error(`path must end with ${ext}`);
  return { path: file, operations, preview };
}

export function createMateOfficeAdapter(deps: MateOfficeAdapterDeps = {}): MateOfficeAdapter {
  const officeCliAvailable = deps.officeCliAvailable ?? defaultOfficeCliAvailable;
  const runOfficeCli = deps.runOfficeCli ?? defaultRunOfficeCli;
  const closeOfficeFile = deps.closeOfficeFile ?? defaultCloseOfficeFile;
  const artifactRegistry = deps.artifactRegistry ?? mateCapabilityArtifactRegistry;

  async function registerOutput(scope: MateHostToolScope, file: string, kind: 'office-output' | 'office-preview', owned = kind === 'office-preview'): Promise<string | undefined> {
    if (!artifactRegistry) return undefined;
    const artifact = await artifactRegistry
      .register({ userId: scope.userId, runtimeSessionId: scope.runtimeSessionId }, { kind, path: file, owned })
      .catch(() => null);
    return artifact?.artifactId;
  }

  async function render(file: string, scope: MateHostToolScope, page: number, signal?: AbortSignal | null): Promise<MateHostToolResult> {
    const outputDir = mateRuntimeSessionToolResultsDir(scope.userId, scope.runtimeSessionId);
    fs.mkdirSync(outputDir, { recursive: true });
    const output = path.join(outputDir, `office-preview-${Date.now().toString(36)}.png`);
    const result = await runOfficeCli(['view', file, 'screenshot', '-o', output, '--page', String(page)], { cwd: path.dirname(file), ...(signal ? { signal } : {}) });
    if (result.code !== 0 || !fs.existsSync(output)) return error('E_OFFICE_RENDER_FAILED', bounded(result.stderr || result.stdout || `exit ${result.code}`));
    const previewArtifactId = await registerOutput(scope, output, 'office-preview', true);
    return { content: JSON.stringify({ sourcePath: file, path: output, page, bytes: fs.statSync(output).size, previewArtifactId }) };
  }

  async function executeCreate(file: string, scope: MateHostToolScope, operations: Array<Record<string, unknown>>, preview: boolean, signal?: AbortSignal | null): Promise<MateHostToolResult> {
    const cwd = path.dirname(file);
    fs.mkdirSync(cwd, { recursive: true });
    const created = await runOfficeCli(['create', file, '--force'], { cwd, ...(signal ? { signal } : {}) });
    if (created.code !== 0) return error('E_OFFICE_CREATE_FAILED', bounded(created.stderr || created.stdout || `exit ${created.code}`));
    const batch = await runOfficeCli(['batch', file], { cwd, stdin: JSON.stringify(operations), ...(signal ? { signal } : {}) });
    if (batch.code !== 0) return error('E_OFFICE_BATCH_FAILED', bounded(batch.stderr || batch.stdout || `exit ${batch.code}`));
    const artifactId = await registerOutput(scope, file, 'office-output', false);
    if (preview) {
      const previewResult = await render(file, scope, 1, signal);
      const previewArtifactId = previewResult.isError ? undefined : JSON.parse(previewResult.content).previewArtifactId;
      return { content: JSON.stringify({ path: file, operations: operations.length, ...(artifactId ? { artifactId } : {}), ...(previewArtifactId ? { previewArtifactId } : {}) }) };
    }
    return { content: JSON.stringify({ path: file, operations: operations.length, ...(artifactId ? { artifactId } : {}) }) };
  }

  async function executeEdit(name: 'office_edit', file: string, scope: MateHostToolScope, operations: Array<Record<string, unknown>>, preview: boolean, signal?: AbortSignal | null): Promise<MateHostToolResult> {
    const cwd = path.dirname(file);
    const batch = await runOfficeCli(['batch', file, '--stop-on-error'], { cwd, stdin: JSON.stringify(operations), ...(signal ? { signal } : {}) });
    if (batch.code !== 0) return error('E_OFFICE_EDIT_FAILED', bounded(batch.stderr || batch.stdout || `exit ${batch.code}`));
    const artifactId = await registerOutput(scope, file, 'office-output', false);
    if (preview) {
      const previewResult = await render(file, scope, 1, signal);
      const previewArtifactId = previewResult.isError ? undefined : JSON.parse(previewResult.content).previewArtifactId;
      return { content: JSON.stringify({ path: file, operations: operations.length, ...(artifactId ? { artifactId } : {}), ...(previewArtifactId ? { previewArtifactId } : {}) }) };
    }
    return { content: JSON.stringify({ path: file, operations: operations.length, ...(artifactId ? { artifactId } : {}) }) };
  }

  async function runOffice(name: Extract<RuntimeHostToolName, `office_${string}`>, input: Record<string, unknown>, scope: MateHostToolScope, opts: { signal?: AbortSignal | null } = {}): Promise<MateHostToolResult> {
    if (!officeCliAvailable()) return error('E_OFFICE_ENGINE_MISSING', 'the built-in Office engine is unavailable');
    const file = resolvePath(input.path, scope);
    const roots = name === 'office_create' || name === 'office_edit' ? scope.writableRoots : [...scope.readOnlyRoots, ...scope.writableRoots];
    const scopeError = pathError(file, roots, name === 'office_create' ? 'write' : 'read');
    if (scopeError || !file) return scopeError ?? error('E_OFFICE_INPUT', 'path is required');
    const cwd = path.dirname(file);
    if (name !== 'office_create' && !fs.existsSync(file)) return error('E_OFFICE_NOT_FOUND', 'Office file not found');
    if (name === 'office_create' && fs.existsSync(file)) return error('E_OFFICE_EXISTS', 'Office create target already exists; use office_edit or choose a new path');
    try {
      if (name === 'office_read') {
        const mode = typeof input.mode === 'string' ? input.mode : 'text';
        const target = typeof input.target === 'string' ? input.target : '';
        if (!['text', 'outline', 'get', 'query'].includes(mode) || (target && (target.length > 2_000 || target.startsWith('-')))) return error('E_OFFICE_INPUT', 'invalid Office read mode or target');
        const args = mode === 'get' ? ['get', file, target || '/', '--json'] : mode === 'query' ? ['query', file, target, '--json'] : ['view', file, mode];
        if (mode === 'query' && !target) return error('E_OFFICE_INPUT', 'query mode requires target');
        const result = await runOfficeCli(args, { cwd, ...(opts.signal ? { signal: opts.signal } : {}) });
        return result.code === 0 ? { content: bounded(result.stdout || '(empty)') } : error('E_OFFICE_READ_FAILED', bounded(result.stderr || result.stdout || `exit ${result.code}`));
      }
      if (name === 'office_render') {
        const page = Number.isInteger(input.page) && Number(input.page) > 0 ? Number(input.page) : 1;
        return await render(file, scope, page, opts.signal);
      }
      let operations: Array<Record<string, unknown>>;
      try { operations = normalizeOperations(input.operations); }
      catch (cause) { return error('E_OFFICE_INPUT', cause instanceof Error ? cause.message : String(cause)); }
      if (name === 'office_create') {
        return await executeCreate(file, scope, operations, input.preview !== false, opts.signal);
      }
      return await executeEdit(name, file, scope, operations, input.preview !== false, opts.signal);
    } catch (cause) {
      return error('E_OFFICE_FAILED', cause instanceof Error ? cause.message : String(cause));
    } finally {
      await closeOfficeFile(file, cwd).catch(() => {});
    }
  }

  return {
    run: runOffice,
    async createDocx(input, scope, opts = {}) {
      const normalized = normalizeOfficeCreateInput(input, '.docx');
      return runOffice('office_create', { path: input.path, operations: normalized.operations, preview: normalized.preview }, scope, opts);
    },
    async createXlsx(input, scope, opts = {}) {
      const normalized = normalizeOfficeCreateInput(input, '.xlsx');
      return runOffice('office_create', { path: input.path, operations: normalized.operations, preview: normalized.preview }, scope, opts);
    },
    async createPptx(input, scope, opts = {}) {
      const normalized = normalizeOfficeCreateInput(input, '.pptx');
      return runOffice('office_create', { path: input.path, operations: normalized.operations, preview: normalized.preview }, scope, opts);
    },
  };
}

export const mateOfficeAdapter = createMateOfficeAdapter();
