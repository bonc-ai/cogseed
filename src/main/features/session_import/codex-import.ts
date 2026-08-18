/**
 * Codex session and memory import.
 *
 * Codex stores data in `~/.codex/`:
 *   - sessions/YYYY/MM/DD/*.jsonl  — session transcripts
 *   - config.toml                   — user preferences
 *   - AGENTS.md                     — custom agent definitions
 *   - memories_1.sqlite             — auto memory (often empty when using non-Anthropic APIs)
 *   - .codex-global-state.json      — workspace/project state
 *
 * This importer:
 *   1. Lists Codex sessions (metadata only)
 *   2. Imports selected sessions into CogSeed conversations
 *   3. Extracts config.toml preferences into shared memory
 *   4. Reads AGENTS.md for custom agent definitions (if present)
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { createLogger } from '../../logger';
import { createTask, listTasks, type Schedule } from '../auto_tasks';

const log = createLogger('session-import:codex-import');

/** Cap for small config-style files (config.toml, AGENTS.md). */
const MAX_FILE_BYTES = 256 * 1024;

/**
 * Cap for session transcripts. These grow with every assistant reply and tool
 * result, so they are orders of magnitude larger than the config files above:
 * a routine session is a few hundred KiB and long ones reach tens of MiB.
 * Sharing the 256 KiB config cap rejected most real sessions as `too_large`.
 */
const MAX_SESSION_BYTES = 32 * 1024 * 1024;

function codexDir(home = os.homedir()): string {
  return path.join(home, '.codex');
}

/**
 * Codex prefixes most sessions with synthetic user turns it injects itself —
 * environment context, AGENTS.md instructions, resumed-transcript envelopes,
 * and file-mention preambles. They are real `role: 'user'` events but not
 * anything the user typed, so titles and summaries must skip past them.
 */
const SYNTHETIC_USER_PREFIXES = [
  '<environment_context',
  '<user_instructions',
  '<AGENTS.md',
  '# AGENTS.md instructions',
  '# Files mentioned by the user',
  'The following is the Codex agent history',
  '>>> TRANSCRIPT START',
];

const RECOMMENDED_PLUGINS_BLOCK_PREFIX =
  /^<recommended_plugins>\s*here is a list of plugins that are available but not installed\b/i;

function isSyntheticUserText(text: string): boolean {
  const t = text.trimStart();
  return RECOMMENDED_PLUGINS_BLOCK_PREFIX.test(t) ||
    SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

/** Numbered transcript replay Codex emits when resuming: `[1] user: …`. */
const NUMBERED_REPLAY_RE = /^\[\d+\]\s+\w+:\s*/;

/**
 * Strip the envelopes Codex wraps around a real prompt. A resumed session
 * replays history as `[1] user: …`, and file mentions nest the prompt under a
 * `## My request for Codex:` heading — sometimes both at once. Returns the
 * user's own words, or '' if nothing but envelope remains.
 */
function unwrapUserText(text: string): string {
  let t = text.trimStart();
  if (NUMBERED_REPLAY_RE.test(t)) t = t.replace(NUMBERED_REPLAY_RE, '').trimStart();

  const marker = t.indexOf('## My request for Codex:');
  if (marker !== -1) t = t.slice(marker + '## My request for Codex:'.length).trimStart();

  return isSyntheticUserText(t) ? '' : t.trim();
}

/**
 * Text of the content items on a Codex `response_item` payload. Codex writes
 * `input_text` (Responses API shape); `text` is accepted for older records.
 */
function payloadTexts(content: unknown): string[] {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const item of content) {
    const type = (item as { type?: unknown })?.type;
    const text = (item as { text?: unknown })?.text;
    if (
      (type === 'input_text' || type === 'output_text' || type === 'text') &&
      typeof text === 'string' &&
      text
    ) {
      out.push(text);
    }
  }
  return out;
}

// ── Session listing ──────────────────────────────────────────────────────

export interface CodexSessionSummary {
  /** Full path to the session JSONL file */
  filePath: string;
  /** Session ID from filename */
  sessionId: string;
  /** First user message or title hint */
  title: string;
  /** ISO timestamp */
  createdAt: string;
  /** Working directory */
  cwd?: string;
}

/**
 * List Codex sessions from `~/.codex/sessions/`. Returns metadata only,
 * newest first. Best-effort: missing dir or unreadable files return [].
 */
export async function listCodexSessions(home = os.homedir()): Promise<CodexSessionSummary[]> {
  const sessionsRoot = path.join(codexDir(home), 'sessions');
  const sessions: CodexSessionSummary[] = [];

  try {
    // Walk sessions/YYYY/MM/DD/*.jsonl
    const years = await fsp.readdir(sessionsRoot);
    for (const year of years.sort().reverse()) {
      const yearPath = path.join(sessionsRoot, year);
      const yearStat = await fsp.stat(yearPath).catch(() => null);
      if (!yearStat?.isDirectory()) continue;

      const months = await fsp.readdir(yearPath);
      for (const month of months.sort().reverse()) {
        const monthPath = path.join(yearPath, month);
        const monthStat = await fsp.stat(monthPath).catch(() => null);
        if (!monthStat?.isDirectory()) continue;

        const days = await fsp.readdir(monthPath);
        for (const day of days.sort().reverse()) {
          const dayPath = path.join(monthPath, day);
          const dayStat = await fsp.stat(dayPath).catch(() => null);
          if (!dayStat?.isDirectory()) continue;

          const files = await fsp.readdir(dayPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const filePath = path.join(dayPath, file);

            // Parse filename: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
            const match = file.match(/rollout-(.+?)\.jsonl$/);
            const sessionId = match ? match[1] : file.replace('.jsonl', '');

            // Read first few lines to extract metadata
            const { title, cwd, createdAt } = await extractSessionMeta(filePath);

            sessions.push({ filePath, sessionId, title, createdAt, cwd });

            if (sessions.length >= 100) break; // Cap at 100 sessions
          }
          if (sessions.length >= 100) break;
        }
        if (sessions.length >= 100) break;
      }
      if (sessions.length >= 100) break;
    }
  } catch (err) {
    log.warn('failed to list Codex sessions', { error: String(err) });
  }

  return sessions;
}

/** Bytes of a transcript scanned for listing metadata. */
const META_SCAN_BYTES = 256 * 1024;

/**
 * Read at most `bytes` from the head of a file. Listing reads every session,
 * and transcripts run to tens of MiB, so the whole file must not be loaded
 * just to recover a title.
 */
async function readHead(filePath: string, bytes: number): Promise<string> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Single-line, length-capped form of transcript text for titles/summaries. */
function condense(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

async function extractSessionMeta(
  filePath: string,
): Promise<{ title: string; cwd?: string; createdAt: string }> {
  try {
    // A trailing partial line from the byte-bounded read is dropped by the
    // per-line JSON.parse below.
    const lines = (await readHead(filePath, META_SCAN_BYTES)).split('\n');

    let title = '';
    let cwd: string | undefined;
    let createdAt = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let event: {
        type?: unknown;
        timestamp?: unknown;
        payload?: { cwd?: unknown; role?: unknown; content?: unknown };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue; // partial or malformed line
      }

      if (!createdAt && typeof event.timestamp === 'string') {
        const ts = new Date(event.timestamp);
        if (!Number.isNaN(ts.getTime())) createdAt = ts.toISOString();
      }

      if (event.type === 'session_meta' && typeof event.payload?.cwd === 'string') {
        cwd = event.payload.cwd;
      }

      // First user turn that the user actually typed.
      if (!title && event.type === 'response_item' && event.payload?.role === 'user') {
        for (const text of payloadTexts(event.payload.content)) {
          if (isSyntheticUserText(text)) continue;
          const candidate = condense(unwrapUserText(text), 100);
          if (candidate) {
            title = candidate;
            break;
          }
        }
      }

      if (title && cwd && createdAt) break;
    }

    // Sessions that never reach a typed prompt within the scan window (e.g.
    // opened and abandoned) fall back to the project directory.
    if (!title && cwd) title = path.basename(cwd);

    return { title: title || 'Untitled', cwd, createdAt };
  } catch (err) {
    log.warn('failed to extract Codex session meta', { filePath, error: String(err) });
    return { title: 'Untitled', createdAt: new Date().toISOString() };
  }
}

// ── Memory extraction (config.toml) ──────────────────────────────────────

export interface CodexMemoryPreview {
  present: boolean;
  entries: string[];
  reason?: 'not_found' | 'unreadable' | 'empty';
}

/**
 * Preview Codex config.toml for importable preferences. Returns structured
 * facts extracted from TOML (model preferences, workspace trust, etc.).
 */
export async function readCodexMemory(home = os.homedir()): Promise<CodexMemoryPreview> {
  const configPath = path.join(codexDir(home), 'config.toml');

  try {
    const stat = await fsp.stat(configPath);
    if (!stat.isFile()) return { present: false, entries: [], reason: 'not_found' };
    if (stat.size > MAX_FILE_BYTES) return { present: false, entries: [], reason: 'unreadable' };

    const content = await fsp.readFile(configPath, 'utf8');
    const entries = extractConfigFacts(content);

    if (!entries.length) return { present: false, entries: [], reason: 'empty' };
    return { present: true, entries };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { present: false, entries: [], reason: 'not_found' };
    return { present: false, entries: [], reason: 'unreadable' };
  }
}

function extractConfigFacts(toml: string): string[] {
  const facts: string[] = [];

  // Extract key preferences from TOML
  const lines = toml.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Model provider
    if (trimmed.startsWith('model_provider =')) {
      const match = trimmed.match(/model_provider\s*=\s*"([^"]+)"/);
      if (match) facts.push(`Codex 使用模型提供商: ${match[1]}`);
    }

    // Model
    if (trimmed.startsWith('model =')) {
      const match = trimmed.match(/model\s*=\s*"([^"]+)"/);
      if (match) facts.push(`Codex 默认模型: ${match[1]}`);
    }

    // Reasoning effort
    if (trimmed.startsWith('model_reasoning_effort =')) {
      const match = trimmed.match(/model_reasoning_effort\s*=\s*"([^"]+)"/);
      if (match) facts.push(`Codex 推理强度: ${match[1]}`);
    }

    // Trust level (from [projects."..."] sections)
    if (trimmed.startsWith('[projects.')) {
      const projectMatch = trimmed.match(/\[projects\."([^"]+)"\]/);
      if (projectMatch) {
        facts.push(`Codex 信任项目: ${projectMatch[1]}`);
      }
    }
  }

  return facts;
}

/**
 * Import Codex config.toml facts into the shared memory tier. Per-entry
 * idempotent via the memory guard.
 */
export async function importCodexMemory(
  userId: string,
  home = os.homedir(),
): Promise<{ ok: boolean; added: number; skipped: number; rejected: number; reason?: string }> {
  const preview = await readCodexMemory(home);
  if (!preview.present || !preview.entries.length) {
    return { ok: true, added: 0, skipped: 0, rejected: 0, reason: 'no_content' };
  }

  // Import via the memory module
  const { addEntry, listEntries } = await import('../memory');
  const existing = new Set<string>();
  const cur = listEntries(userId, 'memory');
  if (cur.ok && Array.isArray(cur.entries)) {
    for (const e of cur.entries) existing.add((e || '').trim());
  }

  let added = 0;
  let skipped = 0;
  let rejected = 0;

  for (const text of preview.entries) {
    const t = text.trim();
    if (!t) continue;
    if (existing.has(t)) { skipped += 1; continue; }

    const res = addEntry(userId, 'memory', t);
    if (res.ok) { added += 1; existing.add(t); }
    else { rejected += 1; }
  }

  log.info('codex memory import done', { added, skipped, rejected });
  return { ok: true, added, skipped, rejected };
}

// ── Session import ───────────────────────────────────────────────────────

export interface CodexTranscript {
  sourceId: string;
  cwd?: string;
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Read and parse a Codex session JSONL file into a normalized transcript.
 * Codex event types: session_meta, response_item (role: user/assistant/developer).
 */
export async function readCodexSessionTranscript(
  filePath: string,
): Promise<{ ok: boolean; transcript?: CodexTranscript; reason?: string }> {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { ok: false, reason: 'not_file' };
    if (stat.size > MAX_SESSION_BYTES) return { ok: false, reason: 'too_large' };

    const content = await fsp.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());

    let sourceId = path.basename(filePath, '.jsonl');
    let cwd: string | undefined;
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        // Extract session metadata
        if (event.type === 'session_meta' && event.payload?.cwd) {
          cwd = event.payload.cwd;
          if (event.payload.session_id) sourceId = event.payload.session_id;
        }

        // Extract conversation turns
        if (event.type === 'response_item' && event.payload?.role) {
          const role = event.payload.role;
          if (role === 'user' || role === 'assistant') {
            const content = extractContentFromPayload(event.payload.content);
            if (content) turns.push({ role, content });
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (!turns.length) return { ok: false, reason: 'empty_transcript' };

    return { ok: true, transcript: { sourceId, cwd, turns } };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'not_found' };
    log.warn('failed to read codex session', { filePath, error: String(err) });
    return { ok: false, reason: 'unreadable' };
  }
}

function extractContentFromPayload(content: unknown): string {
  return payloadTexts(content).join('\n\n').trim();
}

/**
 * Import a single Codex session into a CogSeed conversation.
 * Simpler than Claude import: no extraction/cognition routing, just materialize.
 */
export async function importCodexSession(
  userId: string,
  filePath: string,
  titleHint?: string,
): Promise<{ ok: boolean; conversationId?: string; alreadyImported?: boolean; reason?: string }> {
  const read = await readCodexSessionTranscript(filePath);
  if (!read.ok || !read.transcript) {
    return { ok: false, reason: read.reason || 'unreadable' };
  }

  const { sourceId, cwd, turns } = read.transcript;

  // Import materialize logic
  const { materializeSession } = await import('./materialize');

  // Build a minimal extraction shape (no cognitions for Codex, just a plain
  // summary). Skip the synthetic turns Codex injects ahead of the real prompt.
  const firstUserMsg = turns
    .filter((t) => t.role === 'user' && !isSyntheticUserText(t.content))
    .map((t) => unwrapUserText(t.content))
    .find((t) => t);
  const sessionSummary = condense(firstUserMsg || '', 200) || '从 Codex 导入的会话';

  const extraction = {
    ok: true,
    sessionSummary,
    candidates: [],
    degraded: false,
  };

  const materialize = await materializeSession({
    userId,
    source: 'codex',
    sourceId,
    projectPath: cwd,
    titleHint,
    extraction,
  });

  log.info(`imported codex session=${sourceId} cid=${materialize.conversationId}`);

  return {
    ok: true,
    conversationId: materialize.conversationId,
    alreadyImported: materialize.created === false,
  };
}

// ── Scheduled tasks (automations) ─────────────────────────────────────────
//
// Codex stores scheduled tasks in `~/.codex/sqlite/codex-dev.db`, table
// `automations`:
//   id, name, prompt, status, next_run_at, last_run_at, cwds, rrule,
//   model, reasoning_effort, created_at, updated_at, target_type, project_id
// `rrule` is an iCalendar RRULE string (e.g. FREQ=HOURLY;INTERVAL=24;BYMINUTE=0).
// READ-ONLY: opened with readonly + fileMustExist, never written.

export interface CodexTaskSummary {
  /** Automation id (primary key). */
  id: string;
  /** Human-facing task name. */
  name: string;
  /** The prompt Codex runs on each trigger. */
  prompt: string;
  /** ACTIVE / PAUSED / etc. */
  status: string;
  /** iCal RRULE recurrence string. */
  rrule: string;
  /** Next scheduled run (epoch ms) or null. */
  nextRunAt: number | null;
  /** Last run (epoch ms) or null. */
  lastRunAt: number | null;
}

function codexAutomationsDbPath(home = os.homedir()): string {
  return path.join(codexDir(home), 'sqlite', 'codex-dev.db');
}

/**
 * List Codex scheduled tasks from the `automations` table (READ-ONLY).
 * Returns [] when the DB is absent, the table is missing, or empty — an empty
 * list is a valid, honest "no scheduled tasks yet" state, not an error.
 */
export async function listCodexTasks(home = os.homedir()): Promise<CodexTaskSummary[]> {
  const dbPath = codexAutomationsDbPath(home);
  if (!fs.existsSync(dbPath)) {
    log.info('codex automations db not found — no scheduled tasks', { dbPath });
    return [];
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    // Schema tolerance: the automations table may not exist on older Codex.
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='automations'`)
      .get() as { name: string } | undefined;
    if (!tbl) {
      log.info('codex automations table missing — no scheduled tasks');
      return [];
    }

    const rows = db
      .prepare(
        `SELECT id, name, prompt, status, rrule, next_run_at, last_run_at
           FROM automations
          ORDER BY next_run_at IS NULL, next_run_at ASC`,
      )
      .all() as Array<{
        id: string;
        name: string;
        prompt: string;
        status: string;
        rrule: string;
        next_run_at: number | null;
        last_run_at: number | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      name: (r.name || '').trim() || '(未命名任务)',
      prompt: (r.prompt || '').trim(),
      status: (r.status || '').trim() || 'ACTIVE',
      rrule: (r.rrule || '').trim(),
      nextRunAt: typeof r.next_run_at === 'number' ? r.next_run_at : null,
      lastRunAt: typeof r.last_run_at === 'number' ? r.last_run_at : null,
    }));
  } catch (err) {
    log.warn('failed to read codex automations', { error: (err as Error).message });
    return [];
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

// ── Scheduled-task import ────────────────────────────────────────────────
//
// Codex automations carry an iCalendar RRULE. The in-app task scheduler has
// four schedule shapes (daily / weekly / monthly / one_time), so we map the
// common recurrences and HONESTLY skip the ones we cannot represent — an
// hourly task silently becoming a daily task would mislead the user.

/** Weekday tokens per `Date.getDay()` semantics (0 = Sunday). */
const RRULE_WEEKDAY: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

/** Parse an iCal RRULE into an in-app `Schedule`, or null when unmappable. */
export function parseCodexRrule(rrule: string, nextRunAt: number | null): Schedule | null {
  const trimmed = (rrule || '').trim();
  if (!trimmed) {
    // No recurrence = one-shot; only importable when we know when it runs.
    if (nextRunAt) return { type: 'one_time', at: new Date(nextRunAt).toISOString() };
    return null;
  }

  const kv: Record<string, string> = {};
  for (const part of trimmed.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }

  const freq = (kv.FREQ || '').toUpperCase();
  const fallback = typeof nextRunAt === 'number' ? new Date(nextRunAt) : null;

  const parseInt2 = (v: string | undefined, min: number, max: number): number | null => {
    const n = parseInt(v || '', 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const hour = parseInt2(kv.BYHOUR, 0, 23) ?? (fallback ? fallback.getHours() : 9);
  const minute = parseInt2(kv.BYMINUTE, 0, 59) ?? (fallback ? fallback.getMinutes() : 0);

  if (freq === 'DAILY') return { type: 'daily', hour, minute };
  if (freq === 'WEEKLY') {
    const weekday = RRULE_WEEKDAY[kv.BYDAY || ''];
    if (weekday === undefined) {
      // No BYDAY (or multi-day like "MO,WE"): fall back to the next run's day.
      return { type: 'weekly', weekday: fallback ? fallback.getDay() : 1, hour, minute };
    }
    return { type: 'weekly', weekday, hour, minute };
  }
  if (freq === 'MONTHLY') {
    const day = parseInt2(kv.BYMONTHDAY, 1, 31) ?? (fallback ? fallback.getDate() : 1);
    return { type: 'monthly', day, hour, minute };
  }
  if (!freq) {
    // No FREQ = one-shot; only importable when we know when it runs.
    if (nextRunAt) return { type: 'one_time', at: new Date(nextRunAt).toISOString() };
    return null;
  }
  // HOURLY / MINUTELY / YEARLY / unknown — not representable; skip honestly.
  return null;
}

export interface CodexTaskImportItem {
  id: string;
  name: string;
  status: 'imported' | 'skipped' | 'unsupported' | 'failed';
  reason?: string;
}

export interface CodexTaskImportResult {
  imported: number;
  skipped: number;
  unsupported: number;
  failed: number;
  items: CodexTaskImportItem[];
}

/**
 * Import selected Codex scheduled tasks into the in-app auto-task module.
 * `taskIds` defaults to ALL listed tasks when omitted. Idempotent: a task
 * whose (title, content) already exists is skipped, never duplicated.
 * Unmappable recurrences are skipped with a reason — never silently coerced.
 */
export async function importCodexTasks(
  userId: string,
  taskIds?: string[],
  home = os.homedir(),
): Promise<CodexTaskImportResult> {
  const result: CodexTaskImportResult = { imported: 0, skipped: 0, unsupported: 0, failed: 0, items: [] };
  const all = await listCodexTasks(home);
  const selected = taskIds && taskIds.length
    ? all.filter((t) => taskIds.includes(t.id))
    : all;

  if (!selected.length) return result;

  const existing = await listTasks(userId);
  const existingByContent = new Set(existing.map((t) => `${t.title || ''}\u0000${t.content}`));

  for (const t of selected) {
    const schedule = parseCodexRrule(t.rrule, t.nextRunAt);
    if (!schedule) {
      result.unsupported += 1;
      result.items.push({
        id: t.id, name: t.name, status: 'unsupported',
        reason: `无法映射的频率（RRULE: ${t.rrule || '无'}），已跳过`,
      });
      continue;
    }

    if (existingByContent.has(`${t.name}\u0000${t.prompt}`)) {
      result.skipped += 1;
      result.items.push({ id: t.id, name: t.name, status: 'skipped', reason: '已存在相同任务' });
      continue;
    }

    try {
      const out = await createTask(userId, {
        schedule,
        content: t.prompt || t.name || '继续之前的工作',
        title: t.name || undefined,
        enabled: t.status === 'ACTIVE',
      });
      if (out.ok) {
        result.imported += 1;
        result.items.push({ id: t.id, name: t.name, status: 'imported' });
      } else {
        result.failed += 1;
        const reason = (out as { ok: false; error: string }).error;
        result.items.push({ id: t.id, name: t.name, status: 'failed', reason });
      }
    } catch (err) {
      result.failed += 1;
      result.items.push({ id: t.id, name: t.name, status: 'failed', reason: (err as Error).message });
    }
  }

  log.info('codex tasks import done', { selected: selected.length, imported: result.imported, skipped: result.skipped, unsupported: result.unsupported, failed: result.failed });
  return result;
}
