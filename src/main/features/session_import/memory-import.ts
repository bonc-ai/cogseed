/**
 * Claude Code memory import (closed loop E).
 *
 * Claude Code keeps persistent memory in SEVEN distinct places:
 *
 * **Global (~/.claude/):**
 *   1. instructions - `~/.claude/CLAUDE.md`
 *        User-written cross-project instructions & facts.
 *   2. rules        - `~/.claude/rules/*.md`
 *        User-written rule files (one concern per file).
 *   3. automem      - `~/.claude/MEMORY.md`
 *        AutoMem: Claude-WRITTEN global memory, automatically maintained across
 *        all projects. User-level accumulation of learned facts.
 *   4. project-mem  - `~/.claude/projects/<project>/memory/*.md`
 *        Project-level auto memory: Claude-WRITTEN learnings per git repo,
 *        `MEMORY.md` as the index plus topic files. Machine-local.
 *   5. history      - `~/.claude/history.jsonl`
 *        Cross-session log of the user's own prompts. Not structured memory,
 *        but it's where genuine self-disclosures land ("我喜欢鲜花", "我是一个
 *        学生"). We extract it as best-effort personal facts with a noise filter.
 *
 * **Current workspace (project root):**
 *   6. workspace-project - `<workspace>/CLAUDE.md` or `<workspace>/.claude/CLAUDE.md`
 *        Project-level instructions shared with the team, version-controlled.
 *   7. workspace-local   - `<workspace>/CLAUDE.local.md`
 *        Personal project-specific settings, typically not version-controlled.
 *
 * Every source flattens into candidate lines that we route into our shared
 * memory tier (MemoryScope 'memory' -> MEMORY.md): cross-project, cross-agent
 * facts. Each write goes through `memory.addEntry`, so its injection scan and
 * char-limit guard apply to every entry no matter which source it came from.
 *
 * Boundaries:
 *   - READ-ONLY on `~/.claude` and workspace files. Never writes to Claude's storage.
 *   - Preview (`readClaudeMemories`) is separate from import
 *     (`importClaudeMemories`).
 *   - Bounded: per-file byte cap, per-source entry cap, global entry cap.
 *   - Honest: a source that's absent reports `present:false` with a reason
 *     rather than throwing or being silently dropped.
 *   - Idempotent per entry: identical existing text is skipped on re-run.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';

import { addEntry, listEntries } from '../memory';
import { createLogger } from '../../logger';

const log = createLogger('session-import:memory-import');

/** Caps. Per-file read, per-source entries, and a global ceiling per import. */
const MAX_FILE_BYTES = 256 * 1024;   // 256 KiB per file
const MAX_ENTRIES_PER_SOURCE = 200;  // per memory source
const MAX_ENTRIES_TOTAL = 500;       // across all sources in one import
const MAX_PROJECTS_SCANNED = 50;     // auto-memory: bound the project walk
const MAX_HISTORY_LINES = 2000;      // history.jsonl: bound the parse

/** The seven memory sources: 5 global under ~/.claude/, 2 in current workspace. */
export type MemorySourceKey = 'instructions' | 'rules' | 'automem' | 'project-mem' | 'history' | 'workspace-project' | 'workspace-local';

const SOURCE_LABELS: Record<MemorySourceKey, string> = {
  instructions: '用户指令 (CLAUDE.md)',
  rules: '用户规则 (rules/)',
  automem: '全局记忆 (MEMORY.md，Claude 自动维护)',
  'project-mem': '项目记忆 (projects/*/memory/)',
  history: '个人事实 (历史输入)',
  'workspace-project': '工作区项目指令 (CLAUDE.md)',
  'workspace-local': '工作区本地配置 (CLAUDE.local.md)',
};

function claudeDir(home = os.homedir()): string {
  return path.join(home, '.claude');
}

/**
 * Split markdown into importable memory entries. Structure is flattened to
 * plain facts:
 *   - Bullet lines (`- `, `* `, `1. `) -> the bullet text.
 *   - Non-empty prose lines -> the line.
 *   - Headings (`#`), code fences, and blank lines are dropped (structure,
 *     not facts).
 * Leading list markers and surrounding whitespace are stripped.
 */
function splitMarkdownEntries(text: string, cap = MAX_ENTRIES_PER_SOURCE): string[] {
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
    if (out.length >= cap) break;
  }
  return out;
}

/** Read one file with the byte cap. Returns null on any failure/oversize. */
async function readCappedFile(file: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_BYTES) {
      log.warn('memory file too large, skipping', { file, bytes: stat.size });
      return null;
    }
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-source collectors. Each returns the flattened candidate entries plus a
// short human-readable detail line, and never throws.
// ---------------------------------------------------------------------------

interface Collected {
  entries: string[];
  detail?: string;
  reason?: 'not_found' | 'unreadable' | 'too_large' | 'empty';
}

/** 1. `~/.claude/CLAUDE.md` */
async function collectInstructions(home: string): Promise<Collected> {
  const file = path.join(claudeDir(home), 'CLAUDE.md');
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    return { entries: [], reason: 'not_found' };
  }
  if (stat.size > MAX_FILE_BYTES) return { entries: [], reason: 'too_large' };
  const body = await readCappedFile(file);
  if (body == null) return { entries: [], reason: 'unreadable' };
  const entries = splitMarkdownEntries(body);
  return { entries, detail: entries.length ? undefined : undefined };
}

/** 2. `~/.claude/rules/*.md` */
async function collectRules(home: string): Promise<Collected> {
  const dir = path.join(claudeDir(home), 'rules');
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return { entries: [], reason: 'not_found' };
  }
  const mdFiles = names.filter((n) => n.toLowerCase().endsWith('.md')).sort();
  if (!mdFiles.length) return { entries: [], reason: 'empty' };
  const entries: string[] = [];
  let fileCount = 0;
  for (const name of mdFiles) {
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break;
    const body = await readCappedFile(path.join(dir, name));
    if (body == null) continue;
    fileCount += 1;
    for (const e of splitMarkdownEntries(body, MAX_ENTRIES_PER_SOURCE - entries.length)) {
      entries.push(e);
    }
  }
  return { entries, detail: `${fileCount} 个规则文件` };
}

/**
 * 3. AutoMem: `~/.claude/MEMORY.md` — user-level global memory that Claude
 * writes automatically across all projects. This is the PRIMARY global memory
 * source when it exists.
 */
async function collectAutoMem(home: string): Promise<Collected> {
  const file = path.join(claudeDir(home), 'MEMORY.md');
  const body = await readCappedFile(file);
  if (body == null) return { entries: [], reason: 'not_found' };
  const entries = splitMarkdownEntries(body);
  return { entries };
}

/**
 * 4. Project-level auto memory: `~/.claude/projects/<project>/memory/*.md`.
 * Walks every project dir, reads MEMORY.md first (the index) then topic files.
 */
async function collectProjectMem(home: string): Promise<Collected> {
  const projectsDir = path.join(claudeDir(home), 'projects');
  let projects: string[];
  try {
    projects = await fsp.readdir(projectsDir);
  } catch {
    return { entries: [], reason: 'not_found' };
  }
  const entries: string[] = [];
  let projectsWithMemory = 0;
  let scanned = 0;
  for (const proj of projects.sort()) {
    if (scanned >= MAX_PROJECTS_SCANNED) break;
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break;
    const memDir = path.join(projectsDir, proj, 'memory');
    let memFiles: string[];
    try {
      memFiles = await fsp.readdir(memDir);
    } catch {
      continue; // this project has no auto memory
    }
    scanned += 1;
    const mdFiles = memFiles.filter((n) => n.toLowerCase().endsWith('.md'));
    if (!mdFiles.length) continue;
    // MEMORY.md (the index) first, then topic files alphabetically.
    mdFiles.sort((a, b) => {
      const ai = a.toUpperCase() === 'MEMORY.MD' ? 0 : 1;
      const bi = b.toUpperCase() === 'MEMORY.MD' ? 0 : 1;
      return ai - bi || a.localeCompare(b);
    });
    let gotSome = false;
    for (const name of mdFiles) {
      if (entries.length >= MAX_ENTRIES_PER_SOURCE) break;
      const body = await readCappedFile(path.join(memDir, name));
      if (body == null) continue;
      for (const e of splitMarkdownEntries(body, MAX_ENTRIES_PER_SOURCE - entries.length)) {
        entries.push(e);
        gotSome = true;
      }
    }
    if (gotSome) projectsWithMemory += 1;
  }
  if (!entries.length) return { entries: [], reason: 'empty' };
  return { entries, detail: `${projectsWithMemory} 个项目的自动记忆` };
}

/**
 * 5. `~/.claude/history.jsonl` -> best-effort personal facts.
 *
 * This file is a raw log of the user's own prompts, not curated memory, so we
 * filter aggressively for lines that read like durable self-disclosures and
 * drop obvious noise (greetings, one-word commands, file references, very long
 * pasted blocks). It's best-effort by nature; the memory guard still vets each
 * write, and the UI presents these as candidates, not certainties.
 */
async function collectHistory(home: string): Promise<Collected> {
  const file = path.join(claudeDir(home), 'history.jsonl');
  const body = await readCappedFile(file);
  if (body == null) return { entries: [], reason: 'not_found' };

  const NOISE = new Set([
    '你好', '继续', '好的', '好', 'ok', 'okay', 'yes', 'no', '嗯', '谢谢',
    'continue', 'go', 'run', '开始', '停止',
  ]);
  const seen = new Set<string>();
  const entries: string[] = [];
  let lineNo = 0;
  for (const raw of body.split(/\r?\n/)) {
    if (lineNo++ >= MAX_HISTORY_LINES) break;
    const line = raw.trim();
    if (!line) continue;
    let display: string;
    try {
      const obj = JSON.parse(line);
      display = String(obj?.display ?? '').trim();
    } catch {
      continue;
    }
    if (!display) continue;
    const low = display.toLowerCase();
    if (NOISE.has(low)) continue;
    // Drop file references / paths and pasted-in artifacts.
    if (/[\/\\]/.test(display)) continue;
    if (/\.(html?|md|js|ts|tsx|jsx|py|java|json|css|png|jpe?g|pdf|zip)\b/i.test(display)) continue;
    // Keep sentence-like self-disclosures; drop very long pasted instructions.
    if (display.length < 2 || display.length > 100) continue;
    if (seen.has(display)) continue;
    seen.add(display);
    entries.push(display);
    if (entries.length >= MAX_ENTRIES_PER_SOURCE) break;
  }
  if (!entries.length) return { entries: [], reason: 'empty' };
  return { entries, detail: '从历史输入中提取' };
}

/**
 * 6. Workspace project-level: `<workspace>/CLAUDE.md` or `<workspace>/.claude/CLAUDE.md`.
 * Team-shared instructions, typically version-controlled.
 */
async function collectWorkspaceProject(workspaceDir: string): Promise<Collected> {
  // Try both locations: root CLAUDE.md first, then .claude/CLAUDE.md
  const candidates = [
    path.join(workspaceDir, 'CLAUDE.md'),
    path.join(workspaceDir, '.claude', 'CLAUDE.md'),
  ];
  for (const file of candidates) {
    const body = await readCappedFile(file);
    if (body != null) {
      const entries = splitMarkdownEntries(body);
      return { entries, detail: path.basename(path.dirname(file)) === '.claude' ? '.claude/CLAUDE.md' : 'CLAUDE.md' };
    }
  }
  return { entries: [], reason: 'not_found' };
}

/**
 * 7. Workspace local: `<workspace>/CLAUDE.local.md`.
 * Personal project-specific settings, typically not version-controlled.
 */
async function collectWorkspaceLocal(workspaceDir: string): Promise<Collected> {
  const file = path.join(workspaceDir, 'CLAUDE.local.md');
  const body = await readCappedFile(file);
  if (body == null) return { entries: [], reason: 'not_found' };
  const entries = splitMarkdownEntries(body);
  return { entries };
}

async function collectSource(key: MemorySourceKey, home: string, workspaceDir?: string): Promise<Collected> {
  switch (key) {
    case 'instructions': return collectInstructions(home);
    case 'rules': return collectRules(home);
    case 'automem': return collectAutoMem(home);
    case 'project-mem': return collectProjectMem(home);
    case 'history': return collectHistory(home);
    case 'workspace-project': return workspaceDir ? collectWorkspaceProject(workspaceDir) : { entries: [], reason: 'not_found' };
    case 'workspace-local': return workspaceDir ? collectWorkspaceLocal(workspaceDir) : { entries: [], reason: 'not_found' };
  }
}

const ALL_SOURCES: MemorySourceKey[] = ['instructions', 'rules', 'automem', 'project-mem', 'history', 'workspace-project', 'workspace-local'];

// ---------------------------------------------------------------------------
// Public preview API
// ---------------------------------------------------------------------------

export interface MemorySourcePreview {
  key: MemorySourceKey;
  label: string;
  /** True when the source exists and yielded at least one entry. */
  present: boolean;
  entryCount: number;
  /** First few entries for a preview snippet (not the whole source). */
  sample: string[];
  /** Short human detail, e.g. "3 个项目的自动记忆". */
  detail?: string;
  reason?: 'not_found' | 'unreadable' | 'too_large' | 'empty';
}

export interface ClaudeMemoriesPreview {
  sources: MemorySourcePreview[];
  /** Total importable entries across all present sources. */
  totalEntries: number;
}

/**
 * Preview every Claude Code memory source (READ-ONLY). Absent sources come back
 * with `present:false` and a reason rather than being omitted, so the UI can
 * show an honest "nothing here" state per source.
 *
 * @param home - User home directory (defaults to os.homedir())
 * @param workspaceDir - Current workspace directory for project-level CLAUDE files (optional)
 */
export async function readClaudeMemories(home = os.homedir(), workspaceDir?: string): Promise<ClaudeMemoriesPreview> {
  const sources: MemorySourcePreview[] = [];
  let total = 0;
  for (const key of ALL_SOURCES) {
    const c = await collectSource(key, home, workspaceDir);
    total += c.entries.length;
    sources.push({
      key,
      label: SOURCE_LABELS[key],
      present: c.entries.length > 0,
      entryCount: c.entries.length,
      sample: c.entries.slice(0, 5),
      detail: c.detail,
      reason: c.reason,
    });
  }
  return { sources, totalEntries: total };
}

// ---------------------------------------------------------------------------
// Public import API
// ---------------------------------------------------------------------------

export interface ImportMemoryResult {
  ok: boolean;
  /** Entries newly written to MEMORY.md. */
  added: number;
  /** Entries skipped because identical text already existed. */
  skipped: number;
  /** Entries rejected by the memory guard (injection scan / char limit). */
  rejected: number;
  /** Per-source added counts, for a transparent breakdown in the UI. */
  perSource: Partial<Record<MemorySourceKey, number>>;
  reason?: string;
}

/**
 * Import the selected Claude Code memory sources into the shared memory tier.
 * Idempotent per entry: identical existing text is skipped. Every write goes
 * through `memory.addEntry`, so the injection scan + char-limit guard apply.
 *
 * @param userId User ID
 * @param sourceKeys Which sources to import; defaults to all seven.
 * @param home User home directory (defaults to os.homedir())
 * @param workspaceDir Current workspace directory for project-level CLAUDE files (optional)
 */
export async function importClaudeMemories(
  userId: string,
  sourceKeys?: MemorySourceKey[],
  home = os.homedir(),
  workspaceDir?: string,
): Promise<ImportMemoryResult> {
  const keys = (sourceKeys && sourceKeys.length ? sourceKeys : ALL_SOURCES)
    .filter((k): k is MemorySourceKey => ALL_SOURCES.includes(k));

  // Existing shared-tier text, for per-entry dedup across all sources.
  const existing = new Set<string>();
  const cur = listEntries(userId, 'memory');
  if (cur.ok && Array.isArray(cur.entries)) {
    for (const e of cur.entries) existing.add((e || '').trim());
  }

  let added = 0;
  let skipped = 0;
  let rejected = 0;
  const perSource: Partial<Record<MemorySourceKey, number>> = {};

  for (const key of keys) {
    if (added >= MAX_ENTRIES_TOTAL) break;
    const c = await collectSource(key, home, workspaceDir);
    let addedHere = 0;
    for (const text of c.entries) {
      if (added >= MAX_ENTRIES_TOTAL) break;
      const t = text.trim();
      if (!t) continue;
      if (existing.has(t)) { skipped += 1; continue; }
      const res = addEntry(userId, 'memory', t);
      if (res.ok) { added += 1; addedHere += 1; existing.add(t); }
      else { rejected += 1; }
    }
    if (addedHere) perSource[key] = addedHere;
  }

  log.info('claude memory import done', { added, skipped, rejected, sources: keys });
  return { ok: true, added, skipped, rejected, perSource };
}

// ---------------------------------------------------------------------------
// Backward-compatible single-source shims (user-level CLAUDE.md only).
// Kept so existing callers/tests keep working while callers migrate to the
// multi-source API above.
// ---------------------------------------------------------------------------

export interface ClaudeMemoryPreview {
  present: boolean;
  entryCount: number;
  sample: string[];
  reason?: 'not_found' | 'unreadable' | 'too_large';
}

/** @deprecated Use {@link readClaudeMemories}. Previews only `~/.claude/CLAUDE.md`. */
export async function readClaudeMemory(home = os.homedir()): Promise<ClaudeMemoryPreview> {
  const c = await collectInstructions(home);
  const reason = c.reason === 'empty' ? undefined : c.reason;
  return {
    present: c.entries.length > 0 || c.reason === 'too_large',
    entryCount: c.entries.length,
    sample: c.entries.slice(0, 5),
    reason: reason as ClaudeMemoryPreview['reason'],
  };
}

/** @deprecated Use {@link importClaudeMemories}. Imports only `~/.claude/CLAUDE.md`. */
export async function importClaudeMemory(
  userId: string,
  home = os.homedir(),
): Promise<{ ok: boolean; added: number; skipped: number; rejected: number; reason?: string }> {
  const r = await importClaudeMemories(userId, ['instructions'], home);
  return { ok: r.ok, added: r.added, skipped: r.skipped, rejected: r.rejected, reason: r.reason };
}
