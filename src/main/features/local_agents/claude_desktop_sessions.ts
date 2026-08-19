/**
 * Claude Desktop (local agent mode) session reader.
 *
 * Sibling of `claude_sessions.ts`, which reads the Claude Code **CLI** history
 * under `~/.claude/projects/*.jsonl`. This module reads the **desktop app's**
 * session metadata instead.
 *
 * **Constraints:**
 *   - READ-ONLY. Never writes to Claude Desktop's storage.
 *   - Best-effort. A malformed or unreadable file is skipped, not fatal.
 *   - Metadata only, and that is a hard limit of the format rather than a
 *     staged-loading choice (see below).
 *
 * **Storage layout (verified against a real install):**
 *   `<root>/local-agent-mode-sessions/<accountId>/<workspaceId>/local_*.json`
 *   The account/workspace directories are why a flat scan of
 *   `local-agent-mode-sessions/` finds nothing — the files sit two levels down.
 *   `<root>` is the Electron userData dir, and enterprise (3P) builds use a
 *   `-3p` suffixed sibling, so both are scanned.
 *
 * **Why there is no transcript loader here:** these files carry no message
 * array. Their bulk is `systemPrompt` plus the slash-command catalog, and the
 * only conversation text is `initialMessage` (the opening user turn). The
 * `cliSessionId` field looks like a link to a CLI transcript but does not
 * resolve in practice — on the reference install none of the ids matched any
 * `~/.claude/projects` jsonl, and no jsonl had a `cwd` inside Claude's data
 * directory. Desktop keeps conversation bodies in its own IndexedDB store,
 * which is not a stable read target. So a session surfaced here can be
 * continued from its opening message, and callers must not promise more.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { createLogger } from '../../logger';

const log = createLogger('local-agents:claude-desktop-sessions');

/** Directory holding the per-account session trees. */
const SESSIONS_DIR = 'local-agent-mode-sessions';

/** Metadata filename prefix. `deleted_*` and settings files are ignored. */
const SESSION_PREFIX = 'local_';

/** Guard against a pathological metadata file; real ones are 40–60 KB. */
const MAX_META_BYTES = 4 * 1024 * 1024;

export interface ClaudeDesktopSessionSummary {
  /** `sessionId` field, e.g. `local_<uuid>`. Not a transcript filename. */
  sessionId: string;
  /** Display title. Falls back to the opening message, then a placeholder. */
  title: string;
  /** ISO timestamp derived from the epoch-millis `createdAt`. */
  createdAt: string;
  /** Model id recorded on the session, e.g. `claude-opus-4-8`. Empty if absent. */
  model: string;
  /** Working directory the session was opened against. */
  projectPath: string;
  /** Opening user message, trimmed. The only conversation text available. */
  initialMessage: string;
  /** Whether the user archived the session in Claude Desktop. */
  archived: boolean;
  /** Absolute path to the metadata file. */
  filePath: string;
}

/** Scan outcome. A single shape with an optional `error` rather than a
 *  discriminated union: this project compiles with `strictNullChecks: false`,
 *  under which TS does not narrow unions by a boolean discriminant, so
 *  `if (!res.ok)` would not expose `res.error` at the call site. */
export interface ClaudeDesktopScanResult {
  ok: boolean;
  sessions: ClaudeDesktopSessionSummary[];
  error?: 'permission_denied';
}

interface DesktopSessionMeta {
  sessionId?: unknown;
  id?: unknown;
  title?: unknown;
  /** Older builds wrote the display title here. */
  name?: unknown;
  createdAt?: unknown;
  timestamp?: unknown;
  lastActivityAt?: unknown;
  model?: unknown;
  cwd?: unknown;
  originCwd?: unknown;
  initialMessage?: unknown;
  isArchived?: unknown;
}

/** Candidate Claude Desktop userData roots for the current platform.
 *  Both the standard and `-3p` (enterprise) variants are probed because a
 *  machine can have either or both installed. */
export function claudeDesktopRoots(homedir = os.homedir(), platform = process.platform): string[] {
  const bases: string[] = [];

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    bases.push(appData);
  } else if (platform === 'darwin') {
    bases.push(path.join(homedir, 'Library', 'Application Support'));
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir, '.config');
    bases.push(configHome);
  }

  return bases.flatMap(base => [path.join(base, 'Claude'), path.join(base, 'Claude-3p')]);
}

/**
 * Scan every Claude Desktop root and return session summaries, newest first.
 *
 * A missing directory means the app was never used and yields an empty list.
 * `EACCES`/`EPERM` is reported as `permission_denied` so the UI can tell the
 * user to grant access rather than showing a misleading "nothing found".
 */
export async function listClaudeDesktopSessions(
  homedir = os.homedir(),
  platform = process.platform,
): Promise<ClaudeDesktopScanResult> {
  const sessions: ClaudeDesktopSessionSummary[] = [];
  let denied = false;
  let sawRoot = false;

  for (const root of claudeDesktopRoots(homedir, platform)) {
    const sessionsRoot = path.join(root, SESSIONS_DIR);
    const files = await _collectMetaFiles(sessionsRoot);

    if (files.denied) denied = true;
    if (files.exists) sawRoot = true;

    for (const file of files.paths) {
      const summary = await _parseDesktopSession(file);
      if (summary) sessions.push(summary);
    }
  }

  // Only fail the scan when nothing was readable anywhere; a permission error
  // on one root while another yields sessions is not worth blocking on.
  if (denied && !sessions.length) {
    log.warn('claude desktop sessions unreadable (permission denied)');
    return { ok: false, error: 'permission_denied', sessions: [] };
  }

  if (!sawRoot) log.info('no claude desktop session directory found');

  sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, sessions };
}

/** Walk `<sessionsRoot>/<account>/<workspace>/` collecting `local_*.json`.
 *  Depth is fixed at two rather than a general recursive walk: the same tree
 *  holds a `skills-plugin/` subtree with hundreds of unrelated files. */
async function _collectMetaFiles(
  sessionsRoot: string,
): Promise<{ paths: string[]; denied: boolean; exists: boolean }> {
  const accounts = await _readDirs(sessionsRoot);
  if (accounts.denied) return { paths: [], denied: true, exists: true };
  if (!accounts.exists) return { paths: [], denied: false, exists: false };

  const paths: string[] = [];
  let denied = false;

  for (const account of accounts.names) {
    // `skills-plugin` is a bundled-asset tree, not an account.
    if (account === 'skills-plugin') continue;

    const accountDir = path.join(sessionsRoot, account);
    const workspaces = await _readDirs(accountDir);
    if (workspaces.denied) denied = true;

    for (const workspace of workspaces.names) {
      const workspaceDir = path.join(accountDir, workspace);
      let entries;
      try {
        entries = await fsp.readdir(workspaceDir, { withFileTypes: true });
      } catch (err) {
        if (_isDenied(err)) denied = true;
        else log.warn('failed to list workspace dir', { workspaceDir, error: String(err) });
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith(SESSION_PREFIX) || !entry.name.endsWith('.json')) continue;
        paths.push(path.join(workspaceDir, entry.name));
      }
    }
  }

  return { paths, denied, exists: true };
}

/** List subdirectory names, distinguishing "absent" from "forbidden". */
async function _readDirs(
  dir: string,
): Promise<{ names: string[]; denied: boolean; exists: boolean }> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return { names: entries.filter(e => e.isDirectory()).map(e => e.name), denied: false, exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { names: [], denied: false, exists: false };
    if (_isDenied(err)) return { names: [], denied: true, exists: true };
    log.warn('failed to scan directory', { dir, error: String(err) });
    return { names: [], denied: false, exists: true };
  }
}

function _isDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

/** Parse one metadata file. Every field is optional so a Claude Desktop
 *  version bump that renames or drops one degrades the summary instead of
 *  dropping the session. Returns null only when there is no usable id. */
async function _parseDesktopSession(file: string): Promise<ClaudeDesktopSessionSummary | null> {
  let meta: DesktopSessionMeta;

  try {
    const stat = await fsp.stat(file);
    if (stat.size > MAX_META_BYTES) {
      log.warn('skipping oversized session metadata', { file, size: stat.size });
      return null;
    }
    meta = JSON.parse(await fsp.readFile(file, 'utf8')) as DesktopSessionMeta;
  } catch (err) {
    log.warn('failed to parse desktop session metadata', { file, error: String(err) });
    return null;
  }

  if (!meta || typeof meta !== 'object') return null;

  const sessionId = _str(meta.sessionId) || _str(meta.id) || path.basename(file, '.json');
  if (!sessionId) return null;

  const initialMessage = _str(meta.initialMessage).trim();
  const title =
    _str(meta.title).trim() ||
    _str(meta.name).trim() ||
    initialMessage.slice(0, 100) ||
    '未命名会话';

  return {
    sessionId,
    title,
    createdAt: _isoTime(meta.createdAt ?? meta.timestamp ?? meta.lastActivityAt),
    model: _str(meta.model),
    projectPath: _str(meta.cwd) || _str(meta.originCwd),
    initialMessage,
    archived: meta.isArchived === true,
    filePath: file,
  };
}

function _str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalise a timestamp to ISO. Claude Desktop writes epoch millis, but
 *  tolerate an ISO string in case that changes. */
function _isoTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === 'string' && value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return '';
}
