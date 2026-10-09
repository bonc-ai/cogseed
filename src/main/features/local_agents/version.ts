/**
 * Version probe + minimum-version gate for local CLI agents.
 *
 * Two pure functions (parseSemver / checkMinVersion) for unit-testing,
 * and one subprocess call (detectVersion) that runs the caller-provided
 * version command (defaulting to `<bin> --version`)
 * and extracts the first `[v]MAJOR.MINOR.PATCH` token from stdout/stderr.
 *
 * MIN_VERSIONS is intentionally narrow: only CLIs whose stream-json /
 * ACP shape changed in a known-incompatible way before some version are
 * gated here. Adding entries should be paired with a backend that
 * actually relies on the new shape.
 */

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { killProcessTree } from './backends/base.js';
import { buildCliSpawnEnv, resolveCliCommand } from './spawn-command.js';

/** Minimum CLI versions; absent entry = no minimum. */
export const MIN_VERSIONS: Record<string, string> = {
  // claude --output-format stream-json + --print are stable from 2.x.
  claude: '2.0.0',
  // codex `app-server --listen stdio://` was added in 0.100.0.
  codex: '0.100.0',
};

const VERSION_RE = /v?(\d+)\.(\d+)\.(\d+)/;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_TERMINATION_DEADLINE_MS = 3_000;

export type Semver = { major: number; minor: number; patch: number };

/** Parse the first MAJOR.MINOR.PATCH triple in `raw`; null if not found. */
export function parseSemver(raw: string): Semver | null {
  if (typeof raw !== 'string') return null;
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Lexicographic compare across major / minor / patch. Returns -1/0/1. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Returns null when `detected` meets the minimum for `cli`, or an
 * explanatory string otherwise. Unknown / unparsable inputs return
 * null (no minimum / nothing to gate against) — the goal is to refuse
 * obviously-old binaries, not to be a strict version policy engine.
 */
export function checkMinVersion(cli: string, detected: string | null): string | null {
  const minRaw = MIN_VERSIONS[cli];
  if (!minRaw) return null;
  if (!detected) return null;
  const min = parseSemver(minRaw);
  const got = parseSemver(detected);
  if (!min || !got) return null;
  if (compareSemver(got, min) < 0) {
    return `${cli} ${detected} is below required minimum ${minRaw}`;
  }
  return null;
}

/**
 * Run the configured version probe, return the parsed version string (the
 * raw line we matched, not just the semver), or null on any failure.
 *
 * Timeout is 5s by default (callers pass 2s) — a version probe should be
 * sub-100ms; anything longer is a hung/wrong binary. A probe that times out
 * with ZERO output is retried once: under heavy machine load (CI suites,
 * first-launch cold starts) the spawn can be starved past the timeout even
 * for a healthy binary, so one retry recovers the common transient case.
 * A probe that needs SIGKILL escalation or reaches the termination deadline
 * is not retried. Callers may also provide a total budget spanning both
 * attempts; the registry uses this to keep discovery responsive.
 */
type ProbeOutcome =
  | { kind: 'version'; version: string }
  | { kind: 'silent-timeout' }
  | { kind: 'unavailable' };

interface ProbeRuntime {
  spawnFn?: typeof spawn;
  killTree?: (
    child: ReturnType<typeof spawn>,
    signal: NodeJS.Signals,
  ) => void | Promise<void>;
  platform?: NodeJS.Platform;
  terminationGraceMs?: number;
  terminationDeadlineMs?: number;
}

function probeVersionOnce(
  binPath: string,
  timeoutMs: number,
  versionArgs: readonly string[],
  runtime: ProbeRuntime = {},
): Promise<ProbeOutcome> {
  return new Promise(resolve => {
    let settled = false;
    let outputBytes = 0;
    let timer: NodeJS.Timeout | null = null;
    let hardKillTimer: NodeJS.Timeout | null = null;
    let closeDeadlineTimer: NodeJS.Timeout | null = null;
    let terminationOutcome: ProbeOutcome | null = null;
    let childClosedDuringTermination = false;
    let pendingKillOperations = 0;
    let child: ReturnType<typeof spawn> | null = null;
    let onError: (() => void) | null = null;
    let onClose: ((code: number | null) => void) | null = null;
    let onStdoutData: ((chunk: Buffer | string) => void) | null = null;
    let onStderrData: ((chunk: Buffer | string) => void) | null = null;
    let swallowLateKillError: (() => void) | null = null;
    let lateCloseCleanup: (() => void) | null = null;
    const maxOutputBytes = 64 * 1024;
    const probePlatform = runtime.platform ?? process.platform;
    const removeLateKillErrorSinkIfSafe = () => {
      if (
        !child
        || !swallowLateKillError
        || !childClosedDuringTermination
        || pendingKillOperations !== 0
        || hardKillTimer
      ) return;
      child.off('error', swallowLateKillError);
      swallowLateKillError = null;
      if (lateCloseCleanup) {
        child.off('close', lateCloseCleanup);
        lateCloseCleanup = null;
      }
    };
    const installLateKillErrorSink = () => {
      if (!child || swallowLateKillError) return;
      swallowLateKillError = () => {};
      child.on('error', swallowLateKillError);
      if (!childClosedDuringTermination && !lateCloseCleanup) {
        lateCloseCleanup = () => {
          lateCloseCleanup = null;
          childClosedDuringTermination = true;
          removeLateKillErrorSinkIfSafe();
        };
        child.once('close', lateCloseCleanup);
      }
    };
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (hardKillTimer) clearTimeout(hardKillTimer);
      hardKillTimer = null;
      if (closeDeadlineTimer) clearTimeout(closeDeadlineTimer);
      closeDeadlineTimer = null;
      if (child && onError) child.off('error', onError);
      if (child && onClose) child.off('close', onClose);
      if (child?.stdout && onStdoutData) child.stdout.off('data', onStdoutData);
      if (child?.stderr && onStderrData) child.stderr.off('data', onStderrData);
      resolve(outcome);
    };
    const maybeFinishTermination = () => {
      if (
        !terminationOutcome
        || !childClosedDuringTermination
        || pendingKillOperations !== 0
        || hardKillTimer
      ) return;
      if (!settled) finish(terminationOutcome);
      removeLateKillErrorSinkIfSafe();
    };
    const invokeTreeKill = (signal: NodeJS.Signals) => {
      if (!child) return;
      pendingKillOperations += 1;
      const complete = () => {
        pendingKillOperations -= 1;
        maybeFinishTermination();
      };
      let completion: void | Promise<void>;
      try {
        completion = (runtime.killTree ?? killProcessTree)(child, signal);
      } catch {
        complete();
        return;
      }
      void Promise.resolve(completion).then(complete, complete);
    };
    const escalateTreeKill = (graceExpired: boolean) => {
      // Only exhausting the grace window proves this was a genuinely
      // stubborn process tree. A close-during-grace SIGKILL merely cleans up
      // possible descendants before their original pgid can be recycled.
      if (graceExpired && terminationOutcome?.kind === 'silent-timeout') {
        terminationOutcome = { kind: 'unavailable' };
      }
      invokeTreeKill('SIGKILL');
    };

    let stdout = '';
    let stderr = '';
    const childEnv = buildCliSpawnEnv(binPath);
    const launch = resolveCliCommand(binPath, [...versionArgs], probePlatform, childEnv);
    for (const [key, value] of Object.entries(launch.envPatch || {})) {
      childEnv[key] = value;
    }
    try {
      child = (runtime.spawnFn ?? spawn)(launch.command, launch.args, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        detached: probePlatform !== 'win32',
      });
    } catch {
      finish({ kind: 'unavailable' });
      return;
    }

    const terminate = (outcome: ProbeOutcome, signal: NodeJS.Signals) => {
      if (!child || settled || terminationOutcome) return;
      terminationOutcome = outcome;
      // Do not resolve until the child's stdio closes: on Windows the .cmd
      // wrapper and its Node descendant can still hold the probed files for a
      // short time after taskkill starts. Escalate if a POSIX child ignores
      // SIGTERM, while keeping `close` as the normal resource-release barrier.
      const graceMs = Math.max(0, runtime.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
      const deadlineMs = Math.max(
        graceMs + 1,
        runtime.terminationDeadlineMs ?? DEFAULT_TERMINATION_DEADLINE_MS,
      );
      // Windows killProcessTree already uses forced taskkill /t /f for either
      // signal. Retrying its stale PID risks hitting an unrelated reused PID;
      // POSIX needs a later SIGKILL for descendants that ignored group SIGTERM.
      if (signal !== 'SIGKILL' && probePlatform !== 'win32') {
        hardKillTimer = setTimeout(() => {
          hardKillTimer = null;
          escalateTreeKill(true);
          maybeFinishTermination();
        }, graceMs);
        hardKillTimer.unref?.();
      }
      closeDeadlineTimer = setTimeout(() => {
        if (!child || settled) return;
        // A broken tree killer or escaped descendant must not make version
        // discovery hang forever. Stop its handles from keeping this process
        // alive, but retain a late-error sink because an already-running
        // The tree-kill operation or the target child may still emit an error
        // after this probe returns, so keep a sink until both have completed.
        const abandonedChild = child;
        installLateKillErrorSink();
        abandonedChild.stdout?.destroy();
        abandonedChild.stderr?.destroy();
        abandonedChild.unref();
        terminationOutcome = { kind: 'unavailable' };
        finish(terminationOutcome);
        removeLateKillErrorSinkIfSafe();
      }, deadlineMs);
      closeDeadlineTimer.unref?.();
      invokeTreeKill(signal);
    };

    const capture = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
      if (settled || terminationOutcome) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        terminate({ kind: 'unavailable' }, 'SIGKILL');
        return;
      }
      if (target === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };
    onStdoutData = (c: Buffer | string) => capture('stdout', c);
    onStderrData = (c: Buffer | string) => capture('stderr', c);
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);

    timer = setTimeout(() => {
      // Windows npm CLIs are .cmd -> node process trees. Killing only the
      // command-shell parent leaves the real CLI (and any probe descendants)
      // running after discovery has already returned.
      terminate(outputBytes === 0 ? { kind: 'silent-timeout' } : { kind: 'unavailable' }, 'SIGTERM');
    }, timeoutMs);
    timer.unref?.();

    onError = () => {
      // kill() can itself emit `error`. Once termination has started, only
      // `close` or the bounded close deadline may release the probe.
      if (!terminationOutcome) finish({ kind: 'unavailable' });
    };
    onClose = (code) => {
      if (terminationOutcome) {
        childClosedDuringTermination = true;
        // A POSIX wrapper can close while descendants survive SIGTERM with
        // redirected stdio. Escalate the original group before yielding: a
        // later timer could target a recycled pgid. Windows taskkill is
        // already forced tree mode, so it has no second kill operation.
        if (hardKillTimer) {
          clearTimeout(hardKillTimer);
          hardKillTimer = null;
          escalateTreeKill(false);
        }
        maybeFinishTermination();
        return;
      }
      if (code !== 0) return finish({ kind: 'unavailable' });
      // Some wrappers print a banner to stdout and the actual version to
      // stderr. Inspect both streams instead of letting non-empty stdout
      // hide a valid stderr version.
      const text = `${stdout}\n${stderr}`.trim();
      if (!text) return finish({ kind: 'unavailable' });
      const sv = parseSemver(text);
      if (!sv) return finish({ kind: 'unavailable' });
      // Return the matched semver string so callers store a clean value
      // (the raw line may carry product names / notes we don't want).
      finish({ kind: 'version', version: `${sv.major}.${sv.minor}.${sv.patch}` });
    };
    child.on('error', onError);
    child.on('close', onClose);
  });
}

export const __versionTestHooks = { probeVersionOnce };

export async function detectVersion(
  binPath: string,
  timeoutMs = 5000,
  versionArgs: readonly string[] = ['--version'],
  options: { totalBudgetMs?: number } = {},
): Promise<string | null> {
  const startedAt = performance.now();
  const totalBudgetMs = Number.isFinite(options.totalBudgetMs)
    ? Math.max(0, options.totalBudgetMs!)
    : null;
  const runProbe = (): Promise<ProbeOutcome> => {
    if (totalBudgetMs === null) {
      return probeVersionOnce(binPath, timeoutMs, versionArgs);
    }
    const remainingMs = totalBudgetMs - (performance.now() - startedAt);
    const minTerminationDeadlineMs = DEFAULT_TERMINATION_GRACE_MS + 1;
    if (remainingMs <= minTerminationDeadlineMs + 1) {
      return Promise.resolve({ kind: 'unavailable' });
    }
    const attemptTimeoutMs = Math.max(
      1,
      Math.min(Math.max(1, timeoutMs), Math.floor(remainingMs - minTerminationDeadlineMs)),
    );
    const terminationDeadlineMs = Math.min(
      DEFAULT_TERMINATION_DEADLINE_MS,
      Math.max(minTerminationDeadlineMs, Math.floor(remainingMs - attemptTimeoutMs)),
    );
    return probeVersionOnce(binPath, attemptTimeoutMs, versionArgs, {
      terminationGraceMs: Math.min(DEFAULT_TERMINATION_GRACE_MS, terminationDeadlineMs - 1),
      terminationDeadlineMs,
    });
  };

  const first = await runProbe();
  if (first.kind !== 'silent-timeout') {
    return first.kind === 'version' ? first.version : null;
  }
  const retry = await runProbe();
  return retry.kind === 'version' ? retry.version : null;
}
