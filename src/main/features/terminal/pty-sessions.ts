/**
 * PTY-backed integrated terminal sessions.
 *
 * Unlike `model/core-agent/interactive-cli-sessions.ts` (pipe-backed, driven by
 * agent tools for short OAuth/confirm prompts), this module powers the
 * user-facing integrated terminal panel: a real pseudo-terminal (node-pty)
 * running the user's shell, so TUI programs, ANSI colors, and window resize all
 * work. Output bytes are forwarded verbatim (ANSI escapes intact) for xterm.js
 * to render — no redaction, no line buffering.
 *
 * Session ownership is scoped by `uid`; a session id belongs to exactly one
 * user. cwd is sandboxed to the active workspace plus user-granted roots.
 *
 * node-pty is a native module loaded lazily so importing this feature never
 * hard-fails if the native addon is missing in some environment.
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { app } from 'electron';

import { createLogger } from '../../logger';
import { buildSandboxEnv } from '../../../core-agent/src/sandbox/executor';
import { getWorkspacePath } from '../user_workspace';
import { grantedRootsForSandbox } from '../granted_roots';
import { isPathAllowed } from '../../util/path-sandbox';

const log = createLogger('terminal-pty');

// node-pty's minimal surface we rely on. Declared locally to avoid a hard
// type dependency at import time (the module is require()'d lazily).
interface IPtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPtyLike;
}

interface TerminalSession {
  id: string;
  uid: string;
  pty: IPtyLike;
  cwd: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  createdAt: string;
  exitCode: number | null;
  killTimer: NodeJS.Timeout | null;
}

export interface TerminalSessionView {
  session_id: string;
  cwd: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  created_at: string;
  exit_code: number | null;
}

const MIN_COLS = 1;
const MIN_ROWS = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 1000;
const KILL_ESCALATE_MS = 5000;

const _sessions = new Map<string, TerminalSession>();

/** PTY output/exit event bus. Payloads carry `{ userId, sessionId }` so the
 *  `terminal.stream` IPC handler can filter to one owner + session. */
export const terminalEvents = new EventEmitter();
terminalEvents.setMaxListeners(0);

let _nodePty: NodePtyModule | null = null;
function loadNodePty(): NodePtyModule {
  if (_nodePty) return _nodePty;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _nodePty = require('node-pty') as NodePtyModule;
  return _nodePty;
}

let _quitHookInstalled = false;
function installQuitHook(): void {
  if (_quitHookInstalled) return;
  _quitHookInstalled = true;
  try {
    app.on('before-quit', () => {
      shutdownAllTerminals();
    });
  } catch {
    /* app may be unavailable in tests; best-effort */
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'powershell.exe', args: [] };
  }
  const shell = process.env.SHELL || '/bin/zsh';
  // Interactive login shell so the user's rc files (PATH, aliases, prompt) load.
  return { file: shell, args: ['-l'] };
}

/** Resolve + sandbox the requested cwd. Falls back to the active workspace. */
function resolveCwd(uid: string, requested?: string): string {
  const workspace = getWorkspacePath(uid);
  if (!requested) return workspace;
  const resolved = path.resolve(requested);
  const roots = [workspace, ...grantedRootsForSandbox(uid)];
  if (!isPathAllowed(resolved, roots)) {
    throw new Error('cwd is outside the allowed workspace');
  }
  try {
    if (fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    /* fall through to workspace */
  }
  return workspace;
}

function assertOwnSession(uid: string, sessionId: string): TerminalSession {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('missing session_id');
  const s = _sessions.get(id);
  if (!s || s.uid !== String(uid || '')) throw new Error('terminal session not found');
  return s;
}

function viewOf(s: TerminalSession): TerminalSessionView {
  return {
    session_id: s.id,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    status: s.status,
    created_at: s.createdAt,
    exit_code: s.exitCode,
  };
}

export interface StartTerminalOpts {
  uid: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export function startTerminalSession(opts: StartTerminalOpts): TerminalSessionView {
  const uid = String(opts.uid || '');
  if (!uid) throw new Error('missing uid');
  installQuitHook();

  const cols = clampInt(opts.cols, MIN_COLS, MAX_COLS, 80);
  const rows = clampInt(opts.rows, MIN_ROWS, MAX_ROWS, 24);
  const cwd = resolveCwd(uid, opts.cwd);

  const pty = loadNodePty();
  const { file, args } = defaultShell();
  // Minimal sandboxed env, but a real TERM so TUIs render (executor defaults to "dumb").
  const env = buildSandboxEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' });

  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });

  const id = `term-${cryptoRandomId()}`;
  const session: TerminalSession = {
    id,
    uid,
    pty: proc,
    cwd,
    cols,
    rows,
    status: 'running',
    createdAt: new Date().toISOString(),
    exitCode: null,
    killTimer: null,
  };
  _sessions.set(id, session);

  proc.onData((data: string) => {
    terminalEvents.emit('data', { userId: uid, sessionId: id, chunk: data });
  });
  proc.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
    session.status = 'exited';
    session.exitCode = typeof exitCode === 'number' ? exitCode : null;
    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = null;
    }
    terminalEvents.emit('exit', { userId: uid, sessionId: id, exitCode: session.exitCode });
    // Keep the record briefly so a late reader can see the exit code, then drop.
    const t = setTimeout(() => _sessions.delete(id), 10_000);
    if (typeof t.unref === 'function') t.unref();
  });

  log.info('terminal session started', { sessionId: id, cwd });
  return viewOf(session);
}

export function writeTerminalInput(uid: string, sessionId: string, data: string): void {
  const s = assertOwnSession(uid, sessionId);
  if (s.status !== 'running') return;
  s.pty.write(typeof data === 'string' ? data : '');
}

export function resizeTerminal(uid: string, sessionId: string, cols: number, rows: number): TerminalSessionView {
  const s = assertOwnSession(uid, sessionId);
  const c = clampInt(cols, MIN_COLS, MAX_COLS, s.cols);
  const r = clampInt(rows, MIN_ROWS, MAX_ROWS, s.rows);
  s.cols = c;
  s.rows = r;
  if (s.status === 'running') {
    try {
      s.pty.resize(c, r);
    } catch (err) {
      log.warn('pty resize failed', { sessionId, error: (err as Error).message });
    }
  }
  return viewOf(s);
}

function killPty(s: TerminalSession, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    s.pty.kill(signal);
  } catch {
    /* best effort */
  }
  if (s.killTimer) clearTimeout(s.killTimer);
  s.killTimer = setTimeout(() => {
    try {
      s.pty.kill('SIGKILL');
    } catch {
      /* best effort */
    }
  }, KILL_ESCALATE_MS);
  if (typeof s.killTimer.unref === 'function') s.killTimer.unref();
}

export function closeTerminalSession(uid: string, sessionId: string): TerminalSessionView {
  const s = assertOwnSession(uid, sessionId);
  if (s.status === 'running') killPty(s, 'SIGTERM');
  return viewOf(s);
}

export function listTerminalSessions(uid: string): TerminalSessionView[] {
  const out: TerminalSessionView[] = [];
  for (const s of _sessions.values()) {
    if (s.uid === String(uid || '')) out.push(viewOf(s));
  }
  return out;
}

/** before-quit teardown: kill every live PTY so no shell is orphaned. */
export function shutdownAllTerminals(): void {
  for (const s of _sessions.values()) {
    if (s.status === 'running') {
      try {
        s.pty.kill('SIGKILL');
      } catch {
        /* best effort */
      }
    }
    if (s.killTimer) clearTimeout(s.killTimer);
  }
  _sessions.clear();
}

function cryptoRandomId(): string {
  // 96-bit random hex, no external deps.
  const bytes = new Uint8Array(12);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (require('node:crypto') as typeof import('node:crypto')).randomFillSync(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── test hooks ─────────────────────────────────────────────────────────────
export function _resetTerminalSessionsForTest(): void {
  shutdownAllTerminals();
}
export function _setNodePtyForTest(mod: NodePtyModule | null): void {
  _nodePty = mod;
}
export function _sessionCountForTest(): number {
  return _sessions.size;
}
