/**
 * Sandbox executor for safely running shell commands.
 *
 * Provides resource limits, directory restrictions, command filtering,
 * and timeout enforcement. Inspired by OpenClaw's sandbox execution layer.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { createLogger } from "../shared/logger.js";
import {
  ProcessOutputCapture,
  type StreamedToolOutput,
} from "./output-capture.js";
import {
  warnWindowsSandboxUnavailable,
  windowsSandboxMode,
} from "./windows-sandbox.js";

const log = createLogger("sandbox");

/** Configuration for the sandbox executor. */
export interface SandboxConfig {
  /** Working directory for commands. */
  workingDir: string;
  /** Maximum execution time in milliseconds (default: 60 min). */
  timeoutMs?: number;
  /** Maximum output buffer size in bytes (default: 1MB). */
  maxOutputBytes?: number;
  /** Session-scoped directory for streaming output beyond maxOutputBytes. */
  outputSpoolDir?: string;
  /** Hard per-stream safety limit when outputSpoolDir is available (default: 64MB). */
  maxSpoolBytes?: number;
  /** Allowed directories the sandbox can access (default: [workingDir]). */
  allowedDirs?: string[];
  /** Commands that are explicitly blocked. */
  blockedCommands?: string[];
  /** Whether to allow network access (default: true). */
  allowNetwork?: boolean;
  /** Environment variables to pass through. */
  env?: Record<string, string>;
  /** Abort signal used by the runner to stop a wedged tool without aborting the whole turn. */
  signal?: AbortSignal;
  /** Shell to use (default: /bin/sh on POSIX, PowerShell on Windows). */
  shell?: string;
}

/** Result of a sandboxed command execution. */
export interface SandboxResult {
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Exit code (null if killed). */
  exitCode: number | null;
  /** Whether the command was killed due to timeout. */
  timedOut: boolean;
  /** Whether the command was killed due to output limit. */
  outputLimitExceeded: boolean;
  /** Captured byte counts before UTF-8 normalization. */
  stdoutBytes: number;
  stderrBytes: number;
  /** Host-only temp files for streams larger than the in-memory threshold. */
  stdoutStreamedOutput?: StreamedToolOutput;
  stderrStreamedOutput?: StreamedToolOutput;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

type ShellKind = "posix" | "cmd" | "powershell";
type KillableChild = Pick<ChildProcess, "kill" | "pid">;
type ProcessKiller = typeof process.kill;
type SpawnFn = typeof spawn;

const WINDOWS_POWERSHELL_UTF8_PREFIX =
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
  "$OutputEncoding = [Console]::OutputEncoding; ";

export const DEFAULT_SANDBOX_TIMEOUT_MS = 60 * 60_000;
const KILL_GRACE_MS = 5_000;
const KILL_SETTLE_GRACE_MS = KILL_GRACE_MS + 1_000;

export interface ShellInvocation {
  command: string;
  args: string[];
  kind: ShellKind;
}

type SpawnInvocation = {
  command: string;
  args: string[];
  envPatch?: Record<string, string>;
};

function windowsSystem32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(root, "System32", name);
}

export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals = "SIGTERM",
  opts: {
    platform?: NodeJS.Platform;
    processKill?: ProcessKiller;
    spawnFn?: SpawnFn;
  } = {},
): Promise<void> {
  const platform = opts.platform ?? process.platform;
  const fallback = () => {
    try { child.kill(signal); } catch { /* Process may already be dead. */ }
  };
  if (platform === "win32" && child.pid) {
    let killer: ReturnType<SpawnFn>;
    try {
      killer = (opts.spawnFn ?? spawn)(windowsSystem32Tool("taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      fallback();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      let usedFallback = false;
      const fallbackOnce = () => {
        if (usedFallback) return;
        usedFallback = true;
        fallback();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      killer.once("error", () => {
        fallbackOnce();
        finish();
      });
      killer.once("exit", (code, exitSignal) => {
        if (code !== 0 || exitSignal) fallbackOnce();
      });
      killer.once("close", (code, closeSignal) => {
        if (code !== 0 || closeSignal) fallbackOnce();
        finish();
      });
      if (typeof killer.unref === "function") killer.unref();
    });
  }

  try {
    if (platform !== "win32" && child.pid) {
      (opts.processKill ?? process.kill)(-child.pid, signal);
      return Promise.resolve();
    }
  } catch {
    // Fall back to killing the shell process below.
  }
  fallback();
  return Promise.resolve();
}

type OutputEncodingEnv = {
  LANG?: string;
  LC_ALL?: string;
  COGSEED_UI_LANG?: string;
  [key: string]: string | undefined;
};

/** Default blocked commands — destructive or dangerous operations. */
const DEFAULT_BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "chmod -R 777 /",
  "> /dev/sda",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
];

function shellBaseName(shell: string): string {
  return (shell.split(/[\\/]/).pop() || shell).toLowerCase();
}

function inferShellKind(shell: string, platform: NodeJS.Platform = process.platform): ShellKind {
  const base = shellBaseName(shell).replace(/\.exe$/i, "");
  if (platform !== "win32") return "posix";
  if (base === "cmd" || base === "comspec") return "cmd";
  if (base === "powershell" || base === "pwsh") return "powershell";
  return "posix";
}

export function defaultShellForPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return process.env.COGSEED_WINDOWS_SHELL || "powershell.exe";
  }
  return "/bin/sh";
}

export function buildShellInvocation(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === "win32" && /^\s*cmd(?:\.exe)?\s+(?:\/d\s+)?(?:\/s\s+)?\/c\b/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command],
      kind: "cmd",
    };
  }

  const kind = inferShellKind(shell, platform);
  if (platform === "win32" && kind === "powershell") {
    return {
      command: shell,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `${WINDOWS_POWERSHELL_UTF8_PREFIX}${command}`,
      ],
      kind,
    };
  }
  if (platform === "win32" && kind === "cmd") {
    return {
      command: shell,
      args: ["/d", "/s", "/c", command],
      kind,
    };
  }
  return {
    command: shell,
    args: [platform === "win32" ? "-lc" : "-c", command],
    kind,
  };
}

function countMatches(input: string, re: RegExp): number {
  const matches = input.match(re);
  return matches ? matches.length : 0;
}

function decodeWithEncoding(bytes: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

function canonicalSandboxPath(input: string): string {
  const abs = path.resolve(input);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function uniqueSandboxDirs(input: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of input ?? []) {
    if (!dir) continue;
    const abs = canonicalSandboxPath(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function escapeSandboxString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/* ------------------------------------------------------------------------- *
 * Strict reception sandbox (macOS, opt-in per shell call)
 *
 * The default macOS sandbox above is `(allow default) + (deny file-write*)`:
 * it stops writes outside the allowed dirs but nothing else. A trusted
 * reception turn additionally needs the denied *read* side and no network, so
 * `local-tools` opts exactly one bash call in by setting the markers below in
 * the injected `SandboxConfig.env`. They are read from that injected map only
 * (never from `process.env`), so ordinary local turns cannot pick the strict
 * profile up by accident and keep their existing behavior byte for byte.
 *
 * The profile is the deny-default baseline proven in
 * `sandbox-deny-default-diagnosis.md` §2: `file-read-data "/"` is required by
 * dyld4's CacheFinder (otherwise exit 134 with empty stderr) and
 * `sysctl-read` keeps Node's os.cpus()/os.totalmem() from aborting with a
 * native assertion. Anything not listed is denied — network, reads/writes
 * outside ROOT/SCRATCH, and the mach/ipc lookups the sandbox evaluates. The
 * launchd bootstrap port inherited by the process is *not* filtered by this
 * profile (`launchctl print` still runs); that limitation is documented in
 * `s2b-strict-sandbox.md` §9.13 and is not claimed as closed. Paths must be
 * canonical (realpath): the sandbox matches vnode canonical paths, not the
 * strings we pass.
 * ------------------------------------------------------------------------- */

/** Env keys that opt one shell call into the strict reception profile. */
export const STRICT_SANDBOX_ENV = {
  /** `"1"` enables the strict profile; any other present value fails closed. */
  mode: "COGSEED_SANDBOX_STRICT",
  /** Canonical confirmed reception root (the single read/write ceiling). */
  root: "COGSEED_SANDBOX_STRICT_ROOT",
  /** Writable scratch dir, must live inside ROOT. Default `<ROOT>/.cogseed-scratch`. */
  scratch: "COGSEED_SANDBOX_STRICT_SCRATCH",
  /** sandbox-exec override used by fail-closed tests/diagnosis. Validated like the default. */
  execPath: "COGSEED_SANDBOX_EXEC",
} as const;

export const STRICT_SANDBOX_SCRATCH_DIRNAME = ".cogseed-scratch";
export const DEFAULT_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const E_SANDBOX_UNAVAILABLE = "E_SANDBOX_UNAVAILABLE";
export const E_SANDBOX_SCOPE = "E_SANDBOX_SCOPE";

/** System-only PATH for strict turns. Homebrew/node/npm roots live outside the
 *  proven root, so advertising them would only produce metadata denials. */
const STRICT_SANDBOX_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export type StrictSandboxFailure = { code: string; message: string };

export type StrictSandboxPolicy = {
  /** Canonical confirmed reception root. */
  root: string;
  /** Canonical in-root scratch dir (allowed read+write, used as TMPDIR/HOME). */
  scratch: string;
  sandboxExec: string;
  /** Full deny-default profile text passed through `sandbox-exec -p`. */
  profile: string;
};

export type StrictSandboxResolution =
  | { kind: "none" }
  | { kind: "refused"; failure: StrictSandboxFailure }
  | { kind: "strict"; policy: StrictSandboxPolicy };

function isSameOrInsideSandboxPath(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Deny-default profile for a trusted reception shell. Exported so tests can
 * pin the exact rule set; the parameterized `-D` form is deliberately not used
 * — canonical paths are injected into the text and handed to `sandbox-exec -p`
 * in-process, which avoids the lifetime/permissions of a temp `-f` profile.
 */
export function buildStrictReceptionSandboxProfile(roots: { root: string; scratch: string }): string {
  const root = escapeSandboxString(roots.root);
  const scratch = escapeSandboxString(roots.scratch);
  return [
    "(version 1)",
    "(deny default)",
    ";; process lifecycle: initial execve + fork for external commands",
    "(allow process-exec)",
    "(allow process-fork)",
    ";; kernel state: Node os.cpus()/os.totalmem() abort without it",
    "(allow sysctl-read)",
    ';; dyld4 CacheFinder reads "/" before libSystem; metadata alone is not enough',
    '(allow file-read-data (literal "/"))',
    ";; PATH discovery only (bash stats candidates); read-DATA on /bin,/usr/bin stays denied",
    '(allow file-read-metadata (subpath "/bin") (subpath "/usr/bin"))',
    ";; proven root + scratch, plus the minimal system runtime literals",
    `(allow file-read* (subpath "${root}") (subpath "${scratch}") (literal "/System/Library/OpenSSL/openssl.cnf") (literal "/dev/null") (literal "/private/var/select/sh"))`,
    `(allow file-write* (subpath "${root}") (subpath "${scratch}") (literal "/dev/null"))`,
  ].join("\n");
}

function strictSandboxRefused(message: string): StrictSandboxResolution {
  return { kind: "refused", failure: { code: E_SANDBOX_UNAVAILABLE, message } };
}

/**
 * Resolve the strict reception policy from host-injected env. Returns
 * `{kind:"none"}` for ordinary turns and `{kind:"refused"}` for every state
 * that cannot be proven (non-darwin, missing/odd marker, canonical root not
 * stat-able, no allowed dirs, sandbox-exec missing, scratch outside ROOT).
 * A refused result must never fall back to an unrestricted spawn.
 */
export function resolveStrictReceptionSandbox(input: {
  env?: Record<string, string> | undefined;
  allowedDirs: readonly string[];
  platform?: NodeJS.Platform;
}): StrictSandboxResolution {
  const env = input.env ?? {};
  const hasModeMarker = STRICT_SANDBOX_ENV.mode in env;
  // A partially injected marker set is a host bug, not an ordinary turn: only
  // the complete triple may opt in, and any leftover strict key fails closed
  // instead of silently degrading to the allow-default write sandbox.
  const partialMarkers = [
    STRICT_SANDBOX_ENV.root,
    STRICT_SANDBOX_ENV.scratch,
    STRICT_SANDBOX_ENV.execPath,
  ].filter((key) => key in env);
  if (!hasModeMarker) {
    if (partialMarkers.length) {
      return strictSandboxRefused(
        `a partial strict sandbox marker is set (${partialMarkers.join(", ")}) without ${STRICT_SANDBOX_ENV.mode}; refusing instead of falling back to allow-default.`,
      );
    }
    return { kind: "none" };
  }
  if (env[STRICT_SANDBOX_ENV.mode] !== "1") {
    return strictSandboxRefused(
      `the strict sandbox marker ${STRICT_SANDBOX_ENV.mode} has an unexpected value; refusing instead of falling back to allow-default.`,
    );
  }
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin") {
    return strictSandboxRefused(
      `a trusted reception shell requires the macOS deny-default sandbox; ${platform} has no proven OS-enforced equivalent.`,
    );
  }
  const rawRoot = (env[STRICT_SANDBOX_ENV.root] ?? "").trim();
  if (!rawRoot || !path.isAbsolute(rawRoot)) {
    return strictSandboxRefused("the confirmed reception root is missing or is not an absolute path.");
  }
  const root = canonicalSandboxPath(rawRoot);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
  } catch (err) {
    return strictSandboxRefused(`the confirmed reception root cannot be proven (${(err as Error).message}).`);
  }
  if (!rootStat.isDirectory()) {
    return strictSandboxRefused("the confirmed reception root is not a directory.");
  }
  // Defence in depth: an upstream regression that hands us "/" would turn the
  // filesystem root into the reception scope. Only the exact filesystem root
  // is refused here; a mount-point root such as "/Volumes/X" is still accepted
  // as a user-confirmed reception root.
  if (root === path.parse(root).root) {
    return strictSandboxRefused(
      "the confirmed reception root is the filesystem root; refusing to treat it as the reception scope.",
    );
  }
  const allowedDirs = input.allowedDirs;
  if (!allowedDirs.length) {
    return strictSandboxRefused(
      "the reception shell has no proven allowed directory; refusing instead of spawning an unsandboxed child.",
    );
  }
  if (!allowedDirs.some((dir) => canonicalSandboxPath(dir) === root)) {
    return strictSandboxRefused(
      "the confirmed reception root is not one of the shell's allowed directories; refusing to widen or reinterpret the scope.",
    );
  }
  const sandboxExec = (env[STRICT_SANDBOX_ENV.execPath] ?? "").trim() || DEFAULT_SANDBOX_EXEC;
  if (!path.isAbsolute(sandboxExec)) {
    return strictSandboxRefused("the sandbox-exec path is not absolute.");
  }
  let execStat: fs.Stats;
  try {
    execStat = fs.statSync(sandboxExec);
  } catch {
    return strictSandboxRefused(`sandbox-exec is unavailable at ${sandboxExec}.`);
  }
  if (!execStat.isFile()) {
    return strictSandboxRefused(`sandbox-exec is not a regular file at ${sandboxExec}.`);
  }
  try {
    fs.accessSync(sandboxExec, fs.constants.X_OK);
  } catch {
    return strictSandboxRefused(`sandbox-exec is not executable at ${sandboxExec}.`);
  }
  const rawScratch = (env[STRICT_SANDBOX_ENV.scratch] ?? "").trim()
    || path.join(root, STRICT_SANDBOX_SCRATCH_DIRNAME);
  const scratchCandidate = path.resolve(rawScratch);
  if (!isSameOrInsideSandboxPath(root, scratchCandidate)) {
    return strictSandboxRefused("the reception scratch directory is outside the proven root; refusing.");
  }
  let scratch: string;
  try {
    fs.mkdirSync(scratchCandidate, { recursive: true, mode: 0o700 });
    scratch = fs.realpathSync.native(scratchCandidate);
  } catch (err) {
    return strictSandboxRefused(`cannot prepare the in-root scratch directory: ${(err as Error).message}`);
  }
  if (!isSameOrInsideSandboxPath(root, scratch)) {
    return strictSandboxRefused("the reception scratch directory resolves outside the proven root; refusing.");
  }
  return {
    kind: "strict",
    policy: { root, scratch, sandboxExec, profile: buildStrictReceptionSandboxProfile({ root, scratch }) },
  };
}

/** Successful self-checks, keyed by binary + exact profile text. Failures are
 *  never cached: the next call re-probes and still fails closed. */
const strictSandboxSelfChecks = new Set<string>();

/** Run `sandbox-exec -p <profile>` against `/usr/bin/true` before the real
 *  caller: a profile that cannot start must not be mistaken for a sandboxed
 *  shell that merely failed. */
function strictSandboxSelfCheck(policy: StrictSandboxPolicy): StrictSandboxFailure | null {
  const key = `${policy.sandboxExec}\u0000${policy.profile}`;
  if (strictSandboxSelfChecks.has(key)) return null;
  let probe: ReturnType<typeof spawnSync>;
  try {
    probe = spawnSync(policy.sandboxExec, ["-p", policy.profile, "/usr/bin/true"], {
      env: { PATH: STRICT_SANDBOX_PATH },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5_000,
    });
  } catch (err) {
    return {
      code: E_SANDBOX_UNAVAILABLE,
      message: `the strict profile self-check could not start: ${(err as Error).message}`,
    };
  }
  if (probe.error) {
    return {
      code: E_SANDBOX_UNAVAILABLE,
      message: `the strict profile self-check could not start: ${probe.error.message}`,
    };
  }
  if (probe.status !== 0) {
    const detail = String(probe.stderr ?? "").trim().slice(0, 400);
    return {
      code: E_SANDBOX_UNAVAILABLE,
      message: `the strict deny-default profile self-check exited ${probe.status ?? "null"}${detail ? `: ${detail}` : ""}.`,
    };
  }
  if (strictSandboxSelfChecks.size > 64) strictSandboxSelfChecks.clear();
  strictSandboxSelfChecks.add(key);
  return null;
}

/** Per-invocation TMPDIR/HOME inside the proven scratch dir. Foreground calls
 *  remove it when the process settles; background calls keep theirs because
 *  the detached process outlives the turn. */
function createStrictRunDir(scratch: string): { dir: string } | { error: string } {
  const candidate = path.join(
    scratch,
    `run-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
    const dir = fs.realpathSync.native(candidate);
    if (!isSameOrInsideSandboxPath(scratch, dir)) {
      fs.rmSync(candidate, { recursive: true, force: true });
      return { error: "the per-command scratch directory resolves outside the in-root scratch directory." };
    }
    return { dir };
  } catch (err) {
    return { error: `cannot create the per-command scratch directory: ${(err as Error).message}` };
  }
}

function removeStrictRunDir(runDir: string | null): void {
  if (!runDir) return;
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Canonical env for a strict shell: everything that can hold state points at
 *  the writable in-root scratch dir; PATH drops unreadable user toolchains. */
function applyStrictSandboxEnv(env: Record<string, string>, runDir: string): void {
  env.HOME = runDir;
  env.TMPDIR = runDir;
  env.TMP = runDir;
  env.TEMP = runDir;
  env.PATH = STRICT_SANDBOX_PATH;
  env.SANDBOX_NO_NETWORK = "1";
  delete env.COGSEED_PATH_PREPEND;
}

/** Resolve `target` against the writable roots by canonicalizing the deepest
 *  existing ancestor first, so a symlinked parent cannot smuggle the target
 *  outside. The final component is checked with `lstat` and must not be a
 *  symlink (`executeBackground` additionally opens with O_NOFOLLOW): the
 *  parent opens the log fd *after* this check, and following a final-component
 *  symlink there could create a file outside the writable roots. Returns the
 *  canonical target path or null when out of scope. */
function resolveStrictWritablePath(policy: StrictSandboxPolicy, target: string): string | null {
  const abs = path.resolve(target);
  let probe = path.dirname(abs);
  const rest: string[] = [];
  let real = "";
  for (;;) {
    try {
      real = fs.realpathSync.native(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
  const resolved = path.join(real, ...rest, path.basename(abs));
  if (!isSameOrInsideSandboxPath(policy.root, resolved)
    && !isSameOrInsideSandboxPath(policy.scratch, resolved)) {
    return null;
  }
  try {
    const finalStat = fs.lstatSync(resolved);
    // A symlink, directory, FIFO or device is never a valid background log:
    // only a regular file (or a not-yet-created name) may be opened.
    if (!finalStat.isFile()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  return resolved;
}

function strictSandboxFailureResult(failure: StrictSandboxFailure, startTime: number): SandboxResult {
  const text = `${failure.code}: ${failure.message}`;
  return {
    stdout: "",
    stderr: text,
    exitCode: 1,
    timedOut: false,
    outputLimitExceeded: false,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(text),
    durationMs: Date.now() - startTime,
  };
}

function macWriteSandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
}

function macWriteSandboxProfile(allowedDirs: readonly string[]): string {
  const forms = [
    '(literal "/dev/null")',
    ...allowedDirs.map((dir) => `(subpath "${escapeSandboxString(dir)}")`),
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${forms.join(" ")})`,
  ].join("\n");
}

function maybeWrapWithMacWriteSandbox(
  invocation: ShellInvocation,
  allowedDirs: readonly string[] | undefined,
): SpawnInvocation {
  const dirs = uniqueSandboxDirs(allowedDirs);
  if (!dirs.length || !macWriteSandboxAvailable()) {
    return { command: invocation.command, args: invocation.args };
  }
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", macWriteSandboxProfile(dirs), invocation.command, ...invocation.args],
  };
}

let warnedWindowsFallback = false;

/**
 * Platform dispatch for the OS-enforced write sandbox. macOS uses
 * sandbox-exec. Windows strong mode fails closed until a broker can enforce
 * per-process writes without mutating persistent directory integrity labels;
 * the default keeps the legacy behavior with a one-time warning.
 */
function maybeWrapWithWriteSandbox(
  invocation: ShellInvocation,
  allowedDirs: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): SpawnInvocation {
  const dirs = uniqueSandboxDirs(allowedDirs);
  const windowsMode = platform === "win32" ? windowsSandboxMode() : null;
  if (windowsMode === "strong") {
    throw new Error(warnWindowsSandboxUnavailable(windowsMode));
  }
  if (!dirs.length) return invocation;
  if (platform === "darwin") {
    return maybeWrapWithMacWriteSandbox(invocation, dirs);
  }
  if (platform === "win32") {
    if (!warnedWindowsFallback) {
      warnedWindowsFallback = true;
      warnWindowsSandboxUnavailable(windowsMode ?? "auto");
    }
  }
  return invocation;
}

function decodedTextScore(text: string): number {
  if (!text) return 0;
  let score = countMatches(text, /\uFFFD/g) * 100;
  score += countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) * 20;
  // Common mojibake produced when UTF-8 text is decoded with a legacy ANSI
  // code page. Keep this as a light penalty so valid English/ASCII remains
  // neutral while obviously broken mixed output loses ties.
  score += countMatches(text, /(?:Ã.|Â.|å.|æ.|ç.|ä.)/g) * 2;
  return score;
}

function windowsFallbackEncodings(env: OutputEncodingEnv = process.env): string[] {
  const lang = String(env.COGSEED_UI_LANG || env.LC_ALL || env.LANG || "").toLowerCase();
  const preferred = lang.startsWith("ja")
    ? ["shift_jis"]
    : lang.startsWith("ko")
      ? ["euc-kr"]
      : lang.includes("tw") || lang.includes("hk") || lang.includes("hant")
        ? ["big5", "gb18030"]
        : ["gb18030", "big5"];
  const out: string[] = [];
  for (const encoding of [...preferred, "shift_jis", "euc-kr", "windows-1252"]) {
    if (!out.includes(encoding)) out.push(encoding);
  }
  return out;
}

export function decodeProcessOutput(
  bytes: Buffer,
  platform: NodeJS.Platform = process.platform,
  env: OutputEncodingEnv = process.env,
): string {
  if (bytes.length === 0) return "";
  const utf8 = decodeWithEncoding(bytes, "utf-8") ?? bytes.toString("utf8");
  if (platform !== "win32") return utf8;

  const utf8Score = decodedTextScore(utf8);
  if (utf8Score === 0) return utf8;

  let best = utf8;
  let bestScore = utf8Score;
  for (const encoding of windowsFallbackEncodings(env)) {
    const decoded = decodeWithEncoding(bytes, encoding);
    if (decoded == null) continue;
    const score = decodedTextScore(decoded);
    if (score < bestScore) {
      best = decoded;
      bestScore = score;
    }
  }
  return best;
}

function buildWindowsCanonicalPathEntries(env: NodeJS.ProcessEnv): string[] {
  const root = getEnvValue(env, ["SystemRoot", "WINDIR"]) || "C:\\Windows";
  const programFiles = getEnvValue(env, ["ProgramFiles"]) || "C:\\Program Files";
  const programFilesX86 = getEnvValue(env, ["ProgramFiles(x86)"]) || "C:\\Program Files (x86)";
  const appData = getEnvValue(env, ["APPDATA"]);
  const localAppData = getEnvValue(env, ["LOCALAPPDATA"]);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string | undefined) => {
    if (!entry) return;
    const normalized = path.win32.normalize(entry);
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  add(path.win32.join(root, "System32"));
  add(root);
  add(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0"));
  add(path.win32.join(programFiles, "nodejs"));
  add(path.win32.join(programFilesX86, "nodejs"));
  add(path.win32.join(programFiles, "Git", "cmd"));
  add(path.win32.join(programFiles, "Git", "bin"));
  add(path.win32.join(programFilesX86, "Git", "cmd"));
  add(path.win32.join(programFilesX86, "Git", "bin"));
  if (appData) add(path.win32.join(appData, "npm"));
  if (localAppData) {
    add(path.win32.join(localAppData, "npm"));
    add(path.win32.join(localAppData, "Programs", "nodejs"));
    add(path.win32.join(localAppData, "Programs", "Git", "cmd"));
    add(path.win32.join(localAppData, "Programs", "Git", "bin"));
    add(path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
    addPythonInstallDirs(path.win32.join(localAppData, "Programs", "Python"), add);
  }
  addPythonInstallDirs(programFiles, add);

  return out;
}

function buildPosixCanonicalPathEntries(env: NodeJS.ProcessEnv): string[] {
  const home = getEnvValue(env, ["HOME"]);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string | undefined) => {
    if (!entry) return;
    const normalized = path.posix.normalize(entry);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const entry of CANONICAL_PATH_ENTRIES) add(entry);
  add("/opt/homebrew/share/google-cloud-sdk/bin");
  add("/usr/local/share/google-cloud-sdk/bin");
  add("/opt/google-cloud-sdk/bin");
  if (home) add(path.posix.join(home, "google-cloud-sdk", "bin"));
  return out;
}

function addPythonInstallDirs(root: string | undefined, add: (entry: string | undefined) => void): void {
  if (!root) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^Python\d+/i.test(entry)) continue;
    const dir = path.win32.join(root, entry);
    add(dir);
    add(path.win32.join(dir, "Scripts"));
  }
}

function getEnvValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string") return value;
  }
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(env)) {
    if (wanted.has(key.toLowerCase()) && typeof value === "string") return value;
  }
  return undefined;
}

function windowsHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]) {
    const value = getEnvValue(env, [key]);
    if (value) out[key] = value;
  }
  return out;
}

export function buildSandboxEnv(
  injected: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const hostPath = getEnvValue(process.env, ["PATH", "Path"]);
  const env: Record<string, string> = {
    ...(platform === "win32" ? windowsHostEnv(process.env) : {}),
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? (platform === "win32" ? "C:\\" : "/tmp"),
    PATH: augmentPath(hostPath, platform, process.env),
    TERM: "dumb",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(platform === "win32" ? {
      PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
      PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
    } : {}),
    ...(injected ?? {}),
  };

  if (env.COGSEED_PATH_PREPEND) {
    const delimiter = platform === "win32" ? ";" : ":";
    env.PATH = `${env.COGSEED_PATH_PREPEND}${delimiter}${env.PATH}`;
  }

  return env;
}

/**
 * SandboxExecutor wraps command execution with safety controls.
 *
 * Features:
 * - Timeout enforcement with SIGTERM → SIGKILL escalation
 * - Output size limits to prevent memory exhaustion
 * - Command blocklist for dangerous operations
 * - Working directory restriction
 * - Environment variable filtering
 */
export class SandboxExecutor {
  private readonly config: Required<
    Pick<SandboxConfig, "workingDir" | "timeoutMs" | "maxOutputBytes" | "shell">
  > & SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = {
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024, // 1MB
      shell: defaultShellForPlatform(),
      ...config,
      workingDir: path.resolve(config.workingDir),
      allowedDirs: uniqueSandboxDirs(config.allowedDirs),
      blockedCommands: [
        ...DEFAULT_BLOCKED_COMMANDS,
        ...(config.blockedCommands ?? []),
      ],
    };
  }

  /**
   * Resolve and self-check the strict reception profile for one invocation.
   * A refused result must be reported as a failed call: it never degrades to
   * an unrestricted spawn or to the allow-default write sandbox.
   */
  private prepareStrictSandbox(): StrictSandboxResolution {
    const resolution = resolveStrictReceptionSandbox({
      env: this.config.env,
      allowedDirs: this.config.allowedDirs ?? [],
    });
    if (resolution.kind !== "strict") return resolution;
    const failure = strictSandboxSelfCheck(resolution.policy);
    if (failure) {
      log.warn(`strict reception sandbox unavailable: ${failure.message}`);
      return { kind: "refused", failure };
    }
    return resolution;
  }

  /**
   * Execute a command inside the sandbox.
   *
   * The command runs as a child process with:
   * - Timeout enforcement (SIGTERM after timeout, SIGKILL after 5s grace)
   * - Output buffer size limit
   * - Blocked command check
   * - Working directory restriction
   */
  async execute(command: string): Promise<SandboxResult> {
    const startTime = Date.now();

    // Check for blocked commands
    const violation = this.checkBlockedCommand(command);
    if (violation) {
      log.warn(`Blocked command: ${violation}`);
      return {
        stdout: "",
        stderr: `Command blocked by sandbox policy: ${violation}`,
        exitCode: 1,
        timedOut: false,
        outputLimitExceeded: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // A trusted reception shell opts into the deny-default profile through
    // host-injected env. Every unprovable state fails closed before spawn.
    const strict = this.prepareStrictSandbox();
    if (strict.kind === "refused") {
      log.warn(`strict reception shell refused (${strict.failure.code})`);
      return strictSandboxFailureResult(strict.failure, startTime);
    }
    if (strict.kind === "strict") {
      const cwdReal = canonicalSandboxPath(this.config.workingDir);
      if (!isSameOrInsideSandboxPath(strict.policy.root, cwdReal)) {
        const failure = {
          code: E_SANDBOX_SCOPE,
          message: `the shell working directory is outside the confirmed reception root ${strict.policy.root}: ${this.config.workingDir}.`,
        };
        log.warn(`strict reception shell refused (${failure.code})`);
        return strictSandboxFailureResult(failure, startTime);
      }
    }
    const strictPolicy = strict.kind === "strict" ? strict.policy : null;

    // Validate working directory
    const cwd = this.config.workingDir;

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let killed = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let forceSettleTimer: NodeJS.Timeout | null = null;
      let abortListener: (() => void) | null = null;

      const env = buildSandboxEnv(this.config.env);
      const outputSpoolDir = typeof this.config.outputSpoolDir === "string"
        ? this.config.outputSpoolDir
        : undefined;
      const stdoutCapture = outputSpoolDir
        ? new ProcessOutputCapture({
          spoolDir: outputSpoolDir,
          prefix: "bash-stdout",
          memoryBytes: this.config.maxOutputBytes,
          maxSpoolBytes: this.config.maxSpoolBytes,
        })
        : null;
      const stderrCapture = outputSpoolDir
        ? new ProcessOutputCapture({
          spoolDir: outputSpoolDir,
          prefix: "bash-stderr",
          memoryBytes: this.config.maxOutputBytes,
          maxSpoolBytes: this.config.maxSpoolBytes,
        })
        : null;

      // Restrict network if configured
      if (this.config.allowNetwork === false) {
        // On macOS/Linux, we can't easily block network without sandboxing tools
        // but we can set a flag for documentation
        env.SANDBOX_NO_NETWORK = "1";
      }

      // Strict reception turns get a private writable TMPDIR/HOME inside the
      // proven root; ordinary turns keep the legacy write sandbox untouched.
      let strictRunDir: string | null = null;
      let invocation: SpawnInvocation;
      if (strictPolicy) {
        const runDir = createStrictRunDir(strictPolicy.scratch);
        if ("error" in runDir) {
          log.warn(`strict reception shell refused (${E_SANDBOX_UNAVAILABLE}): ${runDir.error}`);
          resolve(strictSandboxFailureResult(
            { code: E_SANDBOX_UNAVAILABLE, message: runDir.error },
            startTime,
          ));
          return;
        }
        strictRunDir = runDir.dir;
        applyStrictSandboxEnv(env, strictRunDir);
        const shell = buildShellInvocation(this.config.shell, command);
        invocation = {
          command: strictPolicy.sandboxExec,
          args: ["-p", strictPolicy.profile, shell.command, ...shell.args],
        };
      } else {
        invocation = maybeWrapWithWriteSandbox(
          buildShellInvocation(this.config.shell, command),
          this.config.allowedDirs,
        );
      }
      if (invocation.envPatch) {
        Object.assign(env, invocation.envPatch);
      }
      let child: ChildProcess;
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd,
          env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        removeStrictRunDir(strictRunDir);
        if (!strictPolicy) throw err;
        const message = `the strict sandbox could not start the shell: ${(err as Error).message}`;
        log.warn(`strict reception shell refused (${E_SANDBOX_UNAVAILABLE}): ${message}`);
        resolve(strictSandboxFailureResult({ code: E_SANDBOX_UNAVAILABLE, message }, startTime));
        return;
      }

      const abortSignal = this.config.signal;
      if (abortSignal) {
        abortListener = () => killChild();
        if (abortSignal.aborted) abortListener();
        else abortSignal.addEventListener("abort", abortListener, { once: true });
      }

      // Close stdin immediately — no interactive input
      child.stdin.end();

      // Collect stdout with size limit
      child.stdout.on("data", (data: Buffer) => {
        if (outputLimitExceeded) return;
        if (stdoutCapture) {
          if (!stdoutCapture.append(data)) {
            outputLimitExceeded = true;
            stdoutTruncated = true;
            killChild();
          }
          return;
        }
        stdoutBytes += data.length;
        if (stdoutBytes > this.config.maxOutputBytes) {
          outputLimitExceeded = true;
          stdoutTruncated = true;
          const allowed = Math.max(0, data.length - (stdoutBytes - this.config.maxOutputBytes));
          if (allowed > 0) stdoutChunks.push(data.subarray(0, allowed));
          killChild();
          return;
        }
        stdoutChunks.push(data);
      });

      // Collect stderr with size limit
      child.stderr.on("data", (data: Buffer) => {
        if (outputLimitExceeded) return;
        if (stderrCapture) {
          if (!stderrCapture.append(data)) {
            outputLimitExceeded = true;
            stderrTruncated = true;
            killChild();
          }
          return;
        }
        stderrBytes += data.length;
        if (stderrBytes > this.config.maxOutputBytes) {
          outputLimitExceeded = true;
          stderrTruncated = true;
          const allowed = Math.max(0, data.length - (stderrBytes - this.config.maxOutputBytes));
          if (allowed > 0) stderrChunks.push(data.subarray(0, allowed));
          killChild();
          return;
        }
        stderrChunks.push(data);
      });

      // Timeout handler
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killChild();
      }, this.config.timeoutMs);

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        if (abortSignal && abortListener) abortSignal.removeEventListener("abort", abortListener);
        // The foreground shell is gone; its private scratch dir has no owner.
        removeStrictRunDir(strictRunDir);
        let stdout: string;
        let stderr: string;
        let stdoutStreamedOutput: StreamedToolOutput | undefined;
        let stderrStreamedOutput: StreamedToolOutput | undefined;
        if (stdoutCapture && stderrCapture) {
          const decode = (bytes: Buffer) => decodeProcessOutput(bytes, process.platform, env);
          const capturedStdout = stdoutCapture.finish({
            decode,
            normalizeSpoolToUtf8: process.platform === "win32",
          });
          const capturedStderr = stderrCapture.finish({
            decode,
            normalizeSpoolToUtf8: process.platform === "win32",
          });
          stdout = capturedStdout.text;
          stderr = capturedStderr.text;
          stdoutBytes = capturedStdout.bytes;
          stderrBytes = capturedStderr.bytes;
          stdoutStreamedOutput = capturedStdout.streamedOutput;
          stderrStreamedOutput = capturedStderr.streamedOutput;
        } else {
          stdout = decodeProcessOutput(Buffer.concat(stdoutChunks), process.platform, env);
          stderr = decodeProcessOutput(Buffer.concat(stderrChunks), process.platform, env);
          if (stdoutTruncated) stdout += "\n... [output truncated by sandbox]";
          if (stderrTruncated) stderr += "\n... [stderr truncated by sandbox]";
        }
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          outputLimitExceeded,
          stdoutBytes,
          stderrBytes,
          ...(stdoutStreamedOutput ? { stdoutStreamedOutput } : {}),
          ...(stderrStreamedOutput ? { stderrStreamedOutput } : {}),
          durationMs: Date.now() - startTime,
        });
      };

      function killChild() {
        if (killed) return;
        killed = true;
        killProcessTree(child, "SIGTERM");
        // Escalate to SIGKILL after 5 seconds
        const killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
        if (typeof killTimer.unref === "function") killTimer.unref();
        forceSettleTimer = setTimeout(() => finish(null), KILL_SETTLE_GRACE_MS);
        if (typeof forceSettleTimer.unref === "function") forceSettleTimer.unref();
      }

      child.on("close", (code) => {
        finish(code);
      });

      child.on("error", (err) => {
        if (settled) return;
        if (stderrCapture) stderrCapture.append(Buffer.from(err.message));
        else {
          stderrChunks.push(Buffer.from(err.message));
          stderrBytes += Buffer.byteLength(err.message);
        }
        finish(1);
      });
    });
  }

  /**
   * Launch a command detached, with stdout+stderr appended to `logPath`.
   * Same env construction (PATH augmentation + COGSEED_PATH_PREPEND) and
   * blocked-command policy as `execute`, but no timeout and no output
   * buffering — the process intentionally outlives the agent turn (long
   * builds, renders, downloads). The caller reports `pid` + `logPath` to
   * the model, which polls the log and may `kill <pid>` to stop it.
   */
  executeBackground(command: string, logPath: string): { pid: number | null; error?: string } {
    const violation = this.checkBlockedCommand(command);
    if (violation) {
      return { pid: null, error: `Command blocked by sandbox policy: ${violation}` };
    }
    // Same opt-in strict profile as `execute`. The log fd is opened by the
    // parent but written by the sandboxed child, so it must live inside the
    // writable reception roots or the child's writes would be denied.
    const strict = this.prepareStrictSandbox();
    if (strict.kind === "refused") {
      log.warn(`strict reception background shell refused (${strict.failure.code})`);
      return { pid: null, error: `${strict.failure.code}: ${strict.failure.message}` };
    }
    const strictPolicy = strict.kind === "strict" ? strict.policy : null;
    let strictRunDir: string | null = null;
    let effectiveLogPath = logPath;
    if (strictPolicy) {
      const cwdReal = canonicalSandboxPath(this.config.workingDir);
      if (!isSameOrInsideSandboxPath(strictPolicy.root, cwdReal)) {
        return {
          pid: null,
          error: `${E_SANDBOX_SCOPE}: the background shell working directory is outside the confirmed reception root ${strictPolicy.root}: ${this.config.workingDir}.`,
        };
      }
      const runDir = createStrictRunDir(strictPolicy.scratch);
      if ("error" in runDir) {
        return { pid: null, error: `${E_SANDBOX_UNAVAILABLE}: ${runDir.error}` };
      }
      strictRunDir = runDir.dir;
      const scopedLog = resolveStrictWritablePath(strictPolicy, logPath);
      if (!scopedLog) {
        removeStrictRunDir(strictRunDir);
        return {
          pid: null,
          error: `${E_SANDBOX_SCOPE}: the background log path is outside the writable reception roots (root/scratch): ${logPath}`,
        };
      }
      effectiveLogPath = scopedLog;
    }
    const env = buildSandboxEnv(this.config.env);
    if (strictPolicy && strictRunDir) applyStrictSandboxEnv(env, strictRunDir);
    let logFd: number;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      fs.mkdirSync(path.dirname(effectiveLogPath), { recursive: true });
      // The scope check above is check-then-use. O_NOFOLLOW closes the final
      // component race: a symlink swapped in after `lstat` makes this open fail
      // instead of following the link and creating a file outside the roots.
      const openFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
        | (fs.constants.O_NOFOLLOW ?? 0);
      logFd = fs.openSync(effectiveLogPath, openFlags);
    } catch (err) {
      removeStrictRunDir(strictRunDir);
      return { pid: null, error: `cannot open log file: ${(err as Error).message}` };
    }
    try {
      const shell = buildShellInvocation(this.config.shell, command);
      const invocation: SpawnInvocation = strictPolicy
        ? {
          command: strictPolicy.sandboxExec,
          args: ["-p", strictPolicy.profile, shell.command, ...shell.args],
        }
        : maybeWrapWithWriteSandbox(shell, this.config.allowedDirs);
      if (invocation.envPatch) {
        Object.assign(env, invocation.envPatch);
      }
      const child = spawn(invocation.command, invocation.args, {
        cwd: this.config.workingDir,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      child.unref();
      // spawn() reports ENOENT/EACCES (and any later start failure) through an
      // asynchronous 'error' event. Without a listener that event is an
      // uncaught exception; the caller already gets the synchronous `pid:null`
      // result, so this only records the cause.
      child.once("error", (err: Error) => {
        log.warn(`background command failed to start: ${err.message}`);
      });
      const pid = child.pid ?? null;
      if (pid == null) {
        // spawn() reports ENOENT/EACCES asynchronously; without a pid there is
        // no owner for the strict run dir, so clean it up like other failures.
        removeStrictRunDir(strictRunDir);
        return { pid: null, error: "the background shell did not produce a process id." };
      }
      log.info(`background command started pid=${pid} log=${effectiveLogPath}`);
      // A detached child owns its scratch dir until it exits; only the agent
      // can decide when that is, so `<ROOT>/.cogseed-scratch` entries for
      // background runs are intentionally left in place (documented contract).
      return { pid };
    } catch (err) {
      removeStrictRunDir(strictRunDir);
      return { pid: null, error: (err as Error).message };
    } finally {
      // The child holds its own duplicated descriptors after spawn.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require("node:fs") as typeof import("node:fs")).closeSync(logFd);
      } catch { /* already closed */ }
    }
  }

  /** Check if a command matches the blocklist. */
  private checkBlockedCommand(command: string): string | null {
    const normalized = command.trim().toLowerCase();
    for (const blocked of this.config.blockedCommands ?? []) {
      if (normalized.includes(blocked.toLowerCase())) {
        return blocked;
      }
    }
    return null;
  }
}

/**
 * Prepend canonical shell PATH entries that aren't already present. Applied
 * to every sandboxed command so Electron-launched processes (which inherit
 * Finder's minimal PATH) can still find brew / fnm / pyenv-installed tools.
 * Order matters: `/opt/homebrew/...` goes first so Apple-Silicon brew wins
 * when both x86_64 and arm64 brews are installed.
 */
const CANONICAL_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export function augmentPath(
  input: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const canonical = platform === "win32"
    ? buildWindowsCanonicalPathEntries(env)
    : buildPosixCanonicalPathEntries(env);
  const existing = (input ?? "").split(delimiter).filter(Boolean);
  const existingSet = new Set(existing);
  const missing = canonical.filter((p) => !existingSet.has(p));
  const merged = [...missing, ...existing];
  return merged.length ? merged.join(delimiter) : canonical.join(delimiter);
}
