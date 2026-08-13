/**
 * Adapter for the NSEAP security-core engine (`resources/guardrail/nseap-security-core`).
 *
 * Runs the ECS Security 3.1/3.2 engine as a Python child process and maps its
 * exit code onto a verdict the platform owns. Mirrors `sentry-adapter` in shape
 * on purpose: one more component on the same pipe, not a second architecture.
 *
 * ## Why the engine lives in `resources/guardrail/`, not the marketplace
 *
 * A ruleset that can be installed can be replaced, and a replaceable checker is
 * chosen by whatever is being checked. `scanner_trust.ts` records the measured
 * consequence of getting this wrong for skill-sentry: installed as a user skill
 * and re-verified, the scanner returns `blocked` in 262ms with 11 red lines,
 * because a rule for "reads a credential path" necessarily contains one. So the
 * engine ships as platform content and its integrity comes from a pinned tree
 * hash, never from scanning its own bytes.
 *
 * ## Why PyYAML is vendored
 *
 * The engine hard-imports `yaml` in five modules with no fallback, and the
 * bundled CPython 3.12 payload carries only pip. Measured: PyYAML 6.0.3's
 * `lib/yaml` is 17 pure-Python modules that import and round-trip correctly with
 * `__with_libyaml__ == False` — the C extension is an optional accelerator, not a
 * requirement. Vendoring those 248KB under `vendor/` therefore needs no compiler,
 * no per-platform wheel, and no change to the runtime download flow, and the
 * files land inside the builtin content manifest's tree hash rather than in an
 * unprotected `site-packages`.
 *
 * `jsonschema` is declared in the engine's `pyproject.toml` but never imported
 * anywhere in its source, so it is deliberately not vendored.
 *
 * ## The verdict is symbolic — the platform decides
 *
 * This module locates and runs the engine and translates its exit code. It does
 * not let the engine's output decide admission: `verdictFromExitCode` is the
 * whole mapping and it lives here, in platform code. An unrecognised exit code
 * becomes `unknown`, never `pass`.
 *
 * ## Fail-closed, but never fail-scary
 *
 * Every infrastructure failure (missing interpreter, missing engine, timeout,
 * crash, unparseable report) maps to `unknown` — never `blocked`. `blocked` tells
 * the user "this content is dangerous"; `unknown` tells them "we could not
 * check". Reporting the second as the first trains users to dismiss real blocks.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bundledPythonExecutable } from '../../util/bundled-runtime';
import { createLogger } from '../../logger';
import { packagedGuardrailDir } from '../../paths';

const log = createLogger('security/nseap-core');

/** Hard ceiling on a single engine run. */
const RUN_TIMEOUT_MS = 60_000;

/** Directory name under `resources/guardrail/`. Hardcoded, never configurable. */
const ENGINE_DIR_NAME = 'nseap-security-core';

/**
 * Validation mode, mirroring the engine's own two modes.
 *
 * `PREVALIDATION` runs against a mutable working tree and records a
 * deliberately NON-AUTHORITATIVE digest. `FORMAL_TEST` runs against a frozen
 * subject and requires a freeze id + subject digest.
 */
export type NseapValidationMode = 'PREVALIDATION' | 'FORMAL_TEST';

/**
 * Platform-owned verdict.
 *
 * Deliberately not the engine's own result vocabulary: the engine has ~16 result
 * strings, and mapping them at each call site would make admitting a new one an
 * omission rather than a decision.
 */
export type NseapVerdict = 'pass' | 'pass_with_warnings' | 'needs_input' | 'blocked' | 'unknown';

export interface NseapFinding {
  ruleId: string;
  severity: string;
  message: string;
  path?: string;
}

export interface NseapResult {
  verdict: NseapVerdict;
  /** Engine exit code, retained for diagnosis. */
  exitCode: number | null;
  /** The engine's own result string, when it produced a parseable report. */
  engineResult: string | null;
  findings: NseapFinding[];
  /** Non-authoritative in PREVALIDATION; authoritative only for frozen subjects. */
  worktreeDigest: string | null;
  subjectDigest: string | null;
  /** Set when the engine could not run at all. Never means "content is unsafe". */
  unavailableReason?: string;
}

/**
 * Map an engine exit code to a platform verdict.
 *
 * Exported for direct testing: the mapping is the security-relevant decision in
 * this module, and it must be checkable without spawning a process. Codes come
 * from the engine's `exit-code-registry.yaml`, which is a stable cross-process
 * contract — matching on numbers rather than parsing prose means a reworded
 * message or an extra log line cannot change a verdict.
 *
 * Codes 35-39 are the registry's phase-2 range (EXPIRED / ATTESTATION_INVALID /
 * SIGNATURE_INVALID / KEY_STATUS_INVALID / GATE_DENIED). The engine cannot emit
 * them today. They map to `unknown` rather than being treated as failures so
 * that a future engine build which does emit them degrades to "could not check"
 * instead of silently reading as `pass` by not matching anything.
 */
export function verdictFromExitCode(code: number | null): NseapVerdict {
  switch (code) {
    case 0: return 'pass';                 // PASS / FROZEN / CONSISTENT / TEMPLATE_PROVIDED
    case 10: return 'pass_with_warnings';  // PASS_WITH_WARNINGS / VERSION_DEPRECATED
    case 11: return 'needs_input';         // NEEDS_INPUT / REQUIRED_FIELD_MISSING
    case 12: return 'needs_input';         // NOT_READY — actionable, not a threat
    case 20: case 21: case 22: case 23:    // FAIL / DERIVATION / CONSISTENCY / VERSION
      return 'blocked';
    case 31: case 32: case 33: case 34:    // SECURITY_BLOCK / MUTATED / DIGEST / REPORT_SET
      return 'blocked';
    default:
      // 40 (EXECUTION_ERROR), the 35-39 phase-2 range, and anything unrecognised.
      return 'unknown';
  }
}

/** Absolute path to the packaged engine, or undefined when this build omits it. */
export function engineDir(): string | undefined {
  try {
    const dir = path.join(packagedGuardrailDir(), ENGINE_DIR_NAME);
    return fs.existsSync(path.join(dir, 'security_core', '__init__.py')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

function pythonCandidates(): string[] {
  const out: string[] = [];
  const bundled = bundledPythonExecutable();
  if (bundled) out.push(bundled);
  out.push(process.platform === 'win32' ? 'python' : 'python3');
  return out;
}

/**
 * Pick an interpreter that can actually load the engine.
 *
 * Probes `import yaml` with the vendored copy on `PYTHONPATH`, which checks the
 * interpreter and the vendored payload together — the failure mode we care about
 * is "the engine cannot start", and a missing vendor directory produces it just
 * as a missing interpreter does.
 *
 * Cached per session: the probe spawns a process and the answer cannot change
 * while the app runs.
 */
let _pythonChoice: string | null | undefined;
function resolvePython(dir: string): string | null {
  if (_pythonChoice !== undefined) return _pythonChoice;
  const vendor = path.join(dir, 'vendor');
  for (const candidate of pythonCandidates()) {
    try {
      const r = spawnSync(candidate, ['-c', 'import yaml'], {
        stdio: 'ignore',
        timeout: 10_000,
        // Same reason as the run path: the probe imports the vendored payload and
        // would otherwise leave `vendor/yaml/__pycache__` behind, breaking the pin.
        env: { ...process.env, PYTHONPATH: vendor, PYTHONDONTWRITEBYTECODE: '1' },
      });
      if (r.status === 0) {
        _pythonChoice = candidate;
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  _pythonChoice = null;
  log.warn('no interpreter can import the vendored yaml payload');
  return null;
}

/** Reset the cached interpreter choice. Test-only seam. */
export function _resetPythonChoiceForTest(): void {
  _pythonChoice = undefined;
}

function unavailable(reason: string): NseapResult {
  return {
    verdict: 'unknown',
    exitCode: null,
    engineResult: null,
    findings: [],
    worktreeDigest: null,
    subjectDigest: null,
    unavailableReason: reason,
  };
}

function _findings(report: Record<string, unknown>): NseapFinding[] {
  const validation = report.validation as Record<string, unknown> | undefined;
  const raw = Array.isArray(validation?.findings) ? validation.findings : [];
  const out: NseapFinding[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const rec = f as Record<string, unknown>;
    out.push({
      ruleId: String(rec.rule_id || ''),
      severity: String(rec.severity || ''),
      message: String(rec.message || ''),
      ...(typeof rec.path === 'string' && rec.path ? { path: rec.path } : {}),
    });
  }
  return out;
}

/**
 * Validate a skill directory with the engine.
 *
 * Returns `unknown` rather than throwing for every failure path, so a caller can
 * always distinguish "the content is bad" from "the check did not run".
 */
export function validateSkillWithEngine(
  skillRoot: string,
  mode: NseapValidationMode = 'PREVALIDATION',
): NseapResult {
  const dir = engineDir();
  if (!dir) return unavailable('engine_absent');

  const python = resolvePython(dir);
  if (!python) return unavailable('python_absent');

  const args = [
    path.join(dir, 'scripts', 'validator_cli.py'),
    // Absolute: the child runs with `cwd: dir`, so a relative skill root would
    // resolve against the engine directory instead of the caller's cwd.
    '--skill-root', path.resolve(skillRoot),
    '--mode', mode,
  ];

  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(python, args, {
      cwd: dir,
      timeout: RUN_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        // Vendored yaml first, then the engine package itself.
        PYTHONPATH: [path.join(dir, 'vendor'), dir].join(path.delimiter),
        // Writing .pyc files into the engine tree would change its tree hash and
        // make the pinned-integrity check report `tampered` after the first run.
        // Measured: without this, one run leaves 15 files under
        // `security_core/__pycache__` and the pin no longer matches.
        PYTHONDONTWRITEBYTECODE: '1',
      },
    });
  } catch (err) {
    log.warn('engine spawn failed', { error: (err as Error).message });
    return unavailable('spawn_failed');
  }

  if (r.error) {
    log.warn('engine run errored', { error: r.error.message });
    return unavailable('spawn_failed');
  }
  // spawnSync reports a timeout kill via `signal`, not via a non-zero status.
  if (r.signal) return unavailable('timeout');

  const code = typeof r.status === 'number' ? r.status : null;
  const verdict = verdictFromExitCode(code);

  let report: Record<string, unknown> | null = null;
  try {
    const text = String(r.stdout || '').trim();
    if (text) report = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An unparseable report is not evidence of danger: keep the exit-code
    // verdict, but surface that details are missing.
    log.warn('engine report was not valid JSON', { exitCode: code });
  }

  if (!report) {
    return {
      verdict, exitCode: code, engineResult: null, findings: [],
      worktreeDigest: null, subjectDigest: null,
      ...(verdict === 'unknown' ? { unavailableReason: 'unparseable_report' } : {}),
    };
  }

  const subject = (report.subject || {}) as Record<string, unknown>;
  const validation = (report.validation || {}) as Record<string, unknown>;
  return {
    verdict,
    exitCode: code,
    engineResult: typeof validation.result === 'string' ? validation.result : null,
    findings: _findings(report),
    worktreeDigest: typeof subject.worktree_digest === 'string' ? subject.worktree_digest : null,
    subjectDigest: typeof subject.subject_digest === 'string' ? subject.subject_digest : null,
  };
}
