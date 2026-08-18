/**
 * Common contract + helpers for all local CLI backends.
 *
 * `LocalBackend.run` is the single entry point each backend implements:
 * spawn the binary, parse its native output (stream-json or ACP),
 * normalize each event to a `LocalEvent`, and emit them through
 * `onEvent`. The runner sequences spawning, persistence, and the
 * outbound bus message — backends only translate.
 *
 * Two helpers everyone needs:
 *   - `StderrTail` — bounded ring buffer for diagnostic context when a
 *     CLI crashes mid-run; the runner attaches the tail to a failed
 *     `done` event so users see the last 64 KB instead of "exit 3".
 *   - `spawnCli` — uniform spawn options (windowsHide + ignored stdin
 *     close on EPIPE during cancel).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCliSpawnEnv, resolveCliCommand } from '../spawn-command.js';

type KillableChild = Pick<ChildProcessWithoutNullStreams, 'kill' | 'pid'>;
type SpawnFn = typeof spawn;

/** All event types a backend can emit. The runner persists these to
 *  `events.jsonl` verbatim and forwards them to the renderer through
 *  the existing group-chat stream. */
export type LocalEventType =
  | 'process-info'
  | 'text-delta'
  | 'thinking'
  | 'tool-event'
  | 'stderr-line'
  | 'status'
  | 'file-change'
  | 'log'
  | 'raw-line'
  | 'permission-request'
  | 'artifact'
  | 'idle'
  | 'done';

export interface LocalEvent {
  type: LocalEventType;
  /** Free-form payload — exact keys vary per type. Documented inline at
   *  each emit site; a minimal index:
   *    process-info:       { pid, cwd, cmd, args, sessionId? }
   *    text-delta:         { text }
   *    thinking:           { text }
   *    tool-event:         { tool, callId?, phase: 'use'|'result', input?, output?, outputPath? }
   *    stderr-line:        { line }
   *    status:             { status, usage? }   // usage carried for status:'usage' running counters
   *    file-change:        { paths: string[] }   // files reported by CLI-native diff/tool metadata
   *    log:                { level: 'debug'|'info'|'warn'|'error', message, source? }
   *    raw-line:           { line }             // stdout line we couldn't parse as our protocol
   *    permission-request: { id, tool?, input?, autoDecided: 'allow'|'deny', reason }
   *    artifact:           { cid, artifactId, title } // validated by execution sink before linkage
   *    idle:               { stalledMs }        // runner-emitted heartbeat on prolonged silence
   *    done:               { status: 'completed'|'failed'|'cancelled'|'timeout'|
   *                                  'missing_cli', error?, durationMs?, sessionId?, usage? }
   */
  [key: string]: unknown;
}

export interface BackendRunOptions {
  binPath: string;
  prompt: string;
  cwd: string;
  model?: string;
  customArgs?: string[];
  /** When set, ask the CLI to resume a prior session by id (claude:
   *  `--resume <id>`). Backends that don't support resume ignore the
   *  field; the runner's session-bookkeeping treats that as "no
   *  optimisation possible — fall back to slice replay". */
  resumeSessionId?: string;
  /** Cancellation; backend wires this to SIGTERM (10s) → SIGKILL. */
  signal: AbortSignal;
  onEvent: (e: LocalEvent) => void;
  /** Hard wall-clock cap — zombie insurance, NOT the hang detector
   *  (that's `idleKillMs`). Backends arm `armKillWatchdog` with both and
   *  emit `done({status:'timeout'})` when either fires before exit. */
  timeoutMs: number;
  /** Kill the CLI when it emits no events for this long (ms). Unset /
   *  0 disables idle-kill — the runner disables it for backends with no
   *  mid-run event stream (openclaw), where silence is normal. */
  idleKillMs?: number;
  /** Activity clock maintained by the runner (ms epoch of the last
   *  non-idle backend event). Read by the idle-kill watchdog; unset
   *  means no activity tracking and idle-kill stays off. */
  lastEventAt?: () => number;
  /** Per-backend idle threshold override (ms). Read by `runner.ts`'s
   *  idle-heartbeat to decide when to emit `{type:'idle'}` events. When
   *  unset the runner uses its own default (90 s; configurable via
   *  ORKAS_LOCAL_AGENT_IDLE_MS). Backends with no streaming (today:
   *  openclaw) should pass a smaller value so users get an early "still
   *  alive" pulse instead of staring at a blank rail for the full run. */
  idleMs?: number;
  /** Custom-provider variables applied only to the spawned child process. */
  providerEnv?: Record<string, string>;
  /** Host-validated context boundary. Backends may project only these bounded fields. */
  executionContext?: {
    sessionId: string; contextId?: string; readOnlyRoots: string[]; writableRoots: string[];
    permissionMode: string; receiptId: string;
  };
  /** orkas-bridge injection (plan §D — set by runner.ts when a bridge
   *  host is live for this run). Backends that support adding an MCP
   *  server pass the config through (claude: `--mcp-config`; codex:
   *  `-c mcp_servers.…` overrides); others ignore the field. The env
   *  block must be launch-safe: no bridge token/socket values. */
  bridge?: {
    mcpConfigPath: string;
    /** The raw MCP server entry, for backends that take config values
     *  instead of a config file (codex `-c` overrides). */
    server: { command: string; args: string[]; env: Record<string, string> };
    appendSystemPrompt?: string;
  };
}

export interface LocalBackend {
  run(opts: BackendRunOptions): Promise<void>;
}

/** Bounded stderr collector. ringBytes overrides the default 64 KB cap. */
export class StderrTail {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly cap = 64 * 1024) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 1) {
      this.size -= this.chunks[0].length;
      this.chunks.shift();
    }
    // Single chunk over cap → keep its tail.
    if (this.chunks.length === 1 && this.size > this.cap) {
      const only = this.chunks[0];
      this.chunks[0] = only.slice(only.length - this.cap);
      this.size = this.cap;
    }
  }

  toString(): string {
    return this.chunks.join('');
  }
}

export function executionContextEnv(context: BackendRunOptions['executionContext']): Record<string, string> | undefined {
  if (!context) return undefined;
  return {
    ORKAS_EXECUTION_SESSION_ID: context.sessionId,
    ...(context.contextId ? { ORKAS_EXECUTION_CONTEXT_ID: context.contextId } : {}),
    ORKAS_EXECUTION_RECEIPT_ID: context.receiptId,
    ORKAS_PERMISSION_MODE: context.permissionMode,
    ORKAS_ALLOWED_READ_ROOTS: JSON.stringify(context.readOnlyRoots),
    ORKAS_ALLOWED_WRITE_ROOTS: JSON.stringify(context.writableRoots),
  };
}

/** Standard spawn options. Returns a child with stdio: pipe/pipe/pipe.
 *
 *  `detached` (POSIX only) makes the child a process-group leader so
 *  `killProcessTree` can signal the WHOLE group, not just the CLI itself.
 *  Without it, killing the CLI on abort/timeout leaves its descendants
 *  (tool subprocesses, the orkas-bridge MCP child, a shell's forked last
 *  command) orphaned but still holding the inherited stdout/stderr pipes
 *  — so the run's `close` event never fires until those descendants exit
 *  on their own, making abort/timeout appear to hang. We do NOT `unref`:
 *  the run still awaits the child's lifetime. Windows has no POSIX process
 *  groups, so termination uses `taskkill /t /f` to include descendants. */
export function spawnCli(
  binPath: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  providerEnv?: Record<string, string>,
): ChildProcessWithoutNullStreams {
  // The CLI needs a real cwd to start in — child_process.spawn does NOT
  // create it, and a missing cwd surfaces as `spawn <bin> ENOENT` (same
  // code as a missing binary, easy to misread). Conversation workspaces
  // are created lazily (see group_chat/conv_workspace.ts: the subdir is
  // only materialised on first activity), so a space-bound conversation's
  // first CLI turn can point at a directory that does not exist yet.
  // Creating it here is idempotent and matches the existing defensive
  // `mkdirSync(cwd)` pattern the wrapped bash tool already uses.
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    // Best effort — if the parent is genuinely unwritable the spawn below
    // will fail with its own ENOENT/EACCES and the runner reports it.
  }
  const childEnv = buildCliSpawnEnv(binPath, env ?? process.env);
  for (const [key, value] of Object.entries(providerEnv || {})) {
    if (key === 'PATH' || key === 'Path') continue;
    childEnv[key] = value;
  }
  const launch = resolveCliCommand(binPath, args, process.platform, childEnv);
  for (const [key, value] of Object.entries(launch.envPatch || {})) {
    childEnv[key] = value;
  }
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    detached: process.platform !== 'win32',
  });
  // Swallow EPIPE during cancel; the OS will close the pipe when the
  // child dies before we finish writing the prompt.
  child.stdin.on('error', () => { /* noop */ });
  return child;
}

function windowsSystem32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

/** Send `signal` to the child's whole process group on POSIX (the child
 *  is spawned detached, so its pgid == pid and `-pid` addresses the
 *  group). This reaps grandchildren that inherited the stdio pipes;
 *  signaling only the direct child leaves them orphaned and the run's
 *  `close` hangs for their full lifetime (see `spawnCli`). Windows uses
 *  taskkill's tree mode for the same reason. Both paths fall back to a
 *  direct child kill when the platform mechanism cannot start or fails. */
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  opts: { platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {},
): void {
  const pid = child.pid;
  const platform = opts.platform ?? process.platform;
  if (pid && platform === 'win32') {
    try {
      const killer = (opts.spawnFn ?? spawn)(
        windowsSystem32Tool('taskkill.exe'),
        ['/pid', String(pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      const fallback = () => {
        try { child.kill(signal); } catch { /* already gone */ }
      };
      killer.once('error', fallback);
      killer.once('exit', (code) => {
        if (code !== 0) fallback();
      });
      if (typeof killer.unref === 'function') killer.unref();
      return;
    } catch {
      // Fall through to a best-effort direct child kill.
    }
  }
  if (pid && platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch (err) {
      // ESRCH: the group is already gone — nothing left to signal.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
      // Any other error (e.g. the child never became a group leader):
      // fall through to a best-effort direct kill.
    }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

/**
 * Iterate over newline-delimited chunks. Buffers partial lines across
 * `data` events. Each yielded line excludes the terminating `\n` /
 * `\r\n`. Used by stream-json backends; ACP also uses NDJSON so the
 * helper is shared.
 */
export class LineSplitter {
  private buf = '';
  /** Push a chunk; emit each complete line via `onLine`. */
  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      onLine(line);
    }
  }
  /** Flush any trailing line without a newline (e.g. CLI exited early). */
  flush(onLine: (line: string) => void): void {
    if (this.buf.length > 0) {
      onLine(this.buf);
      this.buf = '';
    }
  }
}

/** Normalize a free-form log level string to our 4-tier scale. CLIs
 *  use various conventions (`debug` / `DEBUG` / `verbose` / `warning`
 *  / `err` / numeric); unknown values fold to `info`. Shared by every
 *  backend's `log`-event emit site so the renderer can rely on the
 *  4-value enum. */
export function levelOrInfo(raw: unknown): 'debug' | 'info' | 'warn' | 'error' {
  if (typeof raw !== 'string') return 'info';
  const s = raw.toLowerCase();
  if (s === 'debug' || s === 'trace' || s === 'verbose') return 'debug';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'error' || s === 'err' || s === 'fatal') return 'error';
  return 'info';
}

/**
 * Activity-aware kill watchdog shared by every backend. Two independent
 * limits, polled on a coarse interval:
 *
 *   - `timeoutMs` — hard wall-clock cap. Zombie insurance; generous by
 *     design. It used to double as the hang detector at 20 min, which
 *     killed healthy long dispatches mid-work (a 20-min claude turn with
 *     80 tool events died at exactly 1200000 ms — run 1dffe7c48d18).
 *   - `idleKillMs` + `lastEventAt` — fires only when the CLI emitted NO
 *     events for the whole window. This is the actual hang detector.
 *     Long quiet tool calls are real (observed ~10 min for a model
 *     download), so callers keep this comfortably above them.
 *
 * On fire: SIGTERM, then SIGKILL after 10 s. The backend's close handler
 * reads `fired()` to map the exit to `done({status:'timeout'})`, and
 * `reason()` for the error text — worded inside the `isTransientError`
 * timeout family so plan-step retry can resume the session.
 */
export function armKillWatchdog(
  child: ChildProcessWithoutNullStreams,
  opts: { timeoutMs: number; idleKillMs?: number; lastEventAt?: () => number },
): { fired: () => 'wall' | 'idle' | null; reason: () => string; disarm: () => void } {
  const startedAt = Date.now();
  const idleKillMs = opts.idleKillMs && opts.idleKillMs > 0 && opts.lastEventAt
    ? opts.idleKillMs
    : 0;
  let firedKind: 'wall' | 'idle' | null = null;
  let firedIdleMs = 0;

  const kill = () => {
    killProcessTree(child, 'SIGTERM');
    const hardKill = setTimeout(() => killProcessTree(child, 'SIGKILL'), 10_000);
    if (typeof hardKill.unref === 'function') hardKill.unref();
  };

  // Poll instead of one-shot timers so the idle window slides with
  // activity. Coarse 5 s tick in production; sub-second limits (tests)
  // divide down so they still fire promptly.
  const minLimit = idleKillMs ? Math.min(opts.timeoutMs, idleKillMs) : opts.timeoutMs;
  const tickMs = Math.max(25, Math.min(5_000, Math.floor(minLimit / 4)));
  const ticker = setInterval(() => {
    const now = Date.now();
    if (now - startedAt >= opts.timeoutMs) {
      firedKind = 'wall';
    } else if (idleKillMs) {
      const idleFor = now - opts.lastEventAt!();
      if (idleFor >= idleKillMs) {
        firedKind = 'idle';
        firedIdleMs = idleFor;
      }
    }
    if (firedKind) {
      clearInterval(ticker);
      kill();
    }
  }, tickMs);
  if (typeof ticker.unref === 'function') ticker.unref();

  return {
    fired: () => firedKind,
    reason: () => (
      firedKind === 'idle'
        ? `timed out: no activity for ${firedIdleMs}ms (idle cap ${idleKillMs}ms)`
        : `timed out: exceeded ${opts.timeoutMs}ms wall-clock cap`
    ),
    disarm: () => clearInterval(ticker),
  };
}

/**
 * Wire abort + grace-kill behavior. Returns a cleanup function the
 * caller must invoke after the child exits to detach listeners.
 */
export function bindAbort(child: ChildProcessWithoutNullStreams, signal: AbortSignal, graceMs = 10_000): () => void {
  let killTimer: NodeJS.Timeout | null = null;
  const onAbort = () => {
    killProcessTree(child, 'SIGTERM');
    killTimer = setTimeout(() => {
      killProcessTree(child, 'SIGKILL');
    }, graceMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
  };
}

// ── Fallback file-change detection (shared across all CLI backends) ──────
// Every backend's structured "tool → file-change" path (patch/diff events,
// or `extractWritablePathsFromCliTool`-style tool-name/arg matching in
// group_chat/bus.ts) only fires when the CLI *tells us* it edited a file
// through one of its own structured editing tools (Write/Edit/apply_patch/
// …). Every CLI examined so far (claude, codex, opencode, openclaw, hermes)
// can *also* touch files by running an arbitrary shell/exec command — and
// in that case none of them reliably reports the touched path in a way we
// can parse (shell command text has too many write idioms — redirects,
// `cp`, `tee`, `sed -i`, script-calls-script — to parse safely without
// misattributing changes to the wrong file or missing writes chained
// through variables/pipes).
//
// This is a filesystem-truth fallback instead: snapshot the working
// directory's file mtimes/sizes before the turn, snapshot again when it
// ends, and treat every added/modified path as a produced artifact —
// tool-agnostic, so it does not matter which of a CLI's tools made the
// change. Deletions are intentionally excluded (the produced-files UI is
// "here's something you can open", not a change log).
const FILE_CHANGE_SNAPSHOT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache',
  '.venv', 'venv', '__pycache__', '.turbo', 'target',
]);
const FILE_CHANGE_SNAPSHOT_MAX_ENTRIES = 20_000;
const FILE_CHANGE_SNAPSHOT_MAX_DEPTH = 12;

export type FileChangeSnapshot = Map<string, { mtimeMs: number; size: number }>;

/** Best-effort recursive mtime/size snapshot of `cwd`. Bounded by entry
 *  count and depth so a huge or symlink-cyclic tree can't hang a turn;
 *  swallows per-file/per-dir errors (permissions, races) since this is a
 *  heuristic aid, not a correctness-critical read. */
export function snapshotWorkingDir(cwd: string): FileChangeSnapshot {
  const out: FileChangeSnapshot = new Map();
  let budget = FILE_CHANGE_SNAPSHOT_MAX_ENTRIES;
  const walk = (dir: string, depth: number) => {
    if (budget <= 0 || depth > FILE_CHANGE_SNAPSHOT_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (budget <= 0) return;
      if (FILE_CHANGE_SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(abs);
          out.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
          budget -= 1;
        } catch { /* file vanished mid-scan; skip */ }
      }
    }
  };
  try { walk(cwd, 0); } catch { /* best-effort only */ }
  return out;
}

/** Paths present in `after` that are new or changed vs `before` (a
 *  size/mtime heuristic — good enough for "did this file get touched",
 *  not a content hash). */
export function diffWorkingDirSnapshots(before: FileChangeSnapshot, after: FileChangeSnapshot): string[] {
  const changed: string[] = [];
  for (const [abs, stat] of after) {
    const prev = before.get(abs);
    if (!prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
      changed.push(abs);
    }
  }
  return changed;
}

/**
 * Stateful helper each backend wires around its turn boundary:
 *   1. Construct at/after spawn, once `cwd` is known.
 *   2. Call `noteReported(paths)` whenever the backend emits its own
 *      structured `file-change` event, so the fallback sweep doesn't
 *      double-report the same file.
 *   3. Call `sweep(onEvent)` when the turn/run finishes (before process
 *      teardown) — emits one `file-change` event for anything the
 *      snapshot diff found that wasn't already reported.
 * All methods are best-effort: failures are swallowed so this can never
 * block a CLI run or corrupt its primary event stream.
 */
export class FileChangeFallbackTracker {
  private readonly cwd: string;
  private readonly reported = new Set<string>();
  private before: FileChangeSnapshot | undefined;

  constructor(cwd: string) {
    this.cwd = cwd;
    try { this.before = snapshotWorkingDir(cwd); } catch { this.before = undefined; }
  }

  noteReported(paths: readonly string[]): void {
    for (const p of paths) {
      try { this.reported.add(path.resolve(this.cwd, p)); } catch { /* ignore */ }
    }
  }

  sweep(onEvent: (e: { type: 'file-change'; paths: string[] }) => void): void {
    if (!this.before) return;
    try {
      const after = snapshotWorkingDir(this.cwd);
      const changed = diffWorkingDirSnapshots(this.before, after)
        .filter(abs => !this.reported.has(abs));
      if (changed.length) {
        for (const abs of changed) this.reported.add(abs);
        onEvent({ type: 'file-change', paths: changed });
      }
    } catch { /* best-effort only */ }
  }
}
