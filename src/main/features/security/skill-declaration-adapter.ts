/**
 * Adapter for the skill declaration engine (`resources/guardrail/skill-declaration-core`).
 *
 * Runs the declaration engine as a Python child process and maps its
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
 * not let the engine's output decide admission: `declarationVerdictFromExitCode` is the
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
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bundledPythonExecutable } from '../../util/bundled-runtime';
import { createLogger } from '../../logger';
import { packagedGuardrailDir } from '../../paths';
import { marketplaceContentTreeHash } from '../../util/marketplace-tree-hash';

const log = createLogger('security/skill-declaration');

/** Hard ceiling on a single engine run. */
const RUN_TIMEOUT_MS = 60_000;

/** Directory name under `resources/guardrail/`. Hardcoded, never configurable. */
const ENGINE_DIR_NAME = 'skill-declaration-core';

/** Pin file stored beside the engine tree, never inside it. */
const PIN_FILE_NAME = 'skill-declaration-core.INTEGRITY';

export type DeclarationCoreIntegrity = 'verified' | 'tampered' | 'unpinned' | 'unreadable';

/**
 * Validation mode, mirroring the engine's own two modes.
 *
 * `PREVALIDATION` runs against a mutable working tree and records a
 * deliberately NON-AUTHORITATIVE digest. `FORMAL_TEST` runs against a frozen
 * subject and requires a freeze id + subject digest.
 */
export type DeclarationValidationMode = 'PREVALIDATION' | 'FORMAL_TEST';

/**
 * Platform-owned verdict.
 *
 * Deliberately not the engine's own result vocabulary: the engine has ~16 result
 * strings, and mapping them at each call site would make admitting a new one an
 * omission rather than a decision.
 */
export type DeclarationVerdict = 'pass' | 'pass_with_warnings' | 'needs_input' | 'blocked' | 'unknown';

export interface DeclarationFinding {
  ruleId: string;
  severity: string;
  message: string;
  path?: string;
}

export interface DeclarationResult {
  verdict: DeclarationVerdict;
  /** Engine exit code, retained for diagnosis. */
  exitCode: number | null;
  /** The engine's own result string, when it produced a parseable report. */
  engineResult: string | null;
  findings: DeclarationFinding[];
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
export function declarationVerdictFromExitCode(code: number | null): DeclarationVerdict {
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
export function declarationEngineDir(): string | undefined {
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

function unavailable(reason: string): DeclarationResult {
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

function unavailableWithExitCode(reason: string, exitCode: number | null): DeclarationResult {
  return {
    verdict: 'unknown',
    exitCode,
    engineResult: null,
    findings: [],
    worktreeDigest: null,
    subjectDigest: null,
    unavailableReason: reason,
  };
}

/**
 * Verify the engine tree against its pinned hash.
 *
 * Mirrors `scanner_trust.verifyScannerIntegrity`, but applies to this advisory
 * engine rather than the admission scanner. The pin is read from a sibling file
 * and checked with the same tree hash used at release time.
 */
export function verifyDeclarationCoreIntegrity(dir: string): {
  status: DeclarationCoreIntegrity;
  expected?: string;
  actual?: string;
} {
  let expected = '';
  try {
    expected = fs.readFileSync(path.join(path.dirname(dir), PIN_FILE_NAME), 'utf8').trim();
  } catch {
    expected = '';
  }

  let actual = '';
  try {
    actual = marketplaceContentTreeHash(dir);
  } catch {
    return { status: 'unreadable' };
  }
  if (!actual) return { status: 'unreadable' };
  if (!expected) return { status: 'unpinned', actual };
  if (expected !== actual) {
    log.warn('declaration engine integrity mismatch', { expected, actual });
    return { status: 'tampered', expected, actual };
  }
  return { status: 'verified', expected, actual };
}

function _findings(report: Record<string, unknown>): DeclarationFinding[] {
  const validation = report.validation as Record<string, unknown> | undefined;
  const raw = Array.isArray(validation?.findings) ? validation.findings : [];
  const out: DeclarationFinding[] = [];
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
 * Parse the engine's stdout into a report object.
 *
 * Kept as a separate function so tests can cover the failure without needing a
 * hostile Python interpreter: a report is either JSON or it is not.
 */
export function parseDeclarationReport(stdout: string): Record<string, unknown> | null {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Combine an engine exit code and its parsed report into a platform verdict.
 *
 * Exported for direct testing because the unparseable-report rule is the part
 * most likely to regress: an exit code of 0 must not become `pass` when no
 * report was produced.
 */
export function declarationResultFromExitCodeAndReport(
  code: number | null,
  report: Record<string, unknown> | null,
): DeclarationResult {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return unavailableWithExitCode('unparseable_report', code);
  }

  const subject = (report.subject || {}) as Record<string, unknown>;
  const validation = (report.validation || {}) as Record<string, unknown>;
  if (typeof validation !== 'object' || Array.isArray(validation)) {
    return unavailableWithExitCode('unparseable_report', code);
  }
  return {
    verdict: declarationVerdictFromExitCode(code),
    exitCode: code,
    engineResult: typeof validation.result === 'string' ? validation.result : null,
    findings: _findings(report),
    worktreeDigest: typeof subject.worktree_digest === 'string' ? subject.worktree_digest : null,
    subjectDigest: typeof subject.subject_digest === 'string' ? subject.subject_digest : null,
  };
}

/**
 * Validate a skill directory with the engine.
 *
 * Returns `unknown` rather than throwing for every failure path, so a caller can
 * always distinguish "the content is bad" from "the check did not run".
 */
export async function validateSkillDeclaration(
  skillRoot: string,
  mode: DeclarationValidationMode = 'PREVALIDATION',
): Promise<DeclarationResult> {
  const dir = declarationEngineDir();
  if (!dir) return unavailable('engine_absent');

  const integrity = verifyDeclarationCoreIntegrity(dir);
  if (integrity.status !== 'verified') {
    log.warn('declaration engine integrity check failed', {
      status: integrity.status,
      expected: integrity.expected,
      actual: integrity.actual,
    });
    return unavailable(`engine_integrity_${integrity.status}`);
  }

  const python = resolvePython(dir);
  if (!python) return unavailable('python_absent');

  const args = [
    path.join(dir, 'scripts', 'validator_cli.py'),
    // Absolute: the child runs with `cwd: dir`, so a relative skill root would
    // resolve against the engine directory instead of the caller's cwd.
    '--skill-root', path.resolve(skillRoot),
    '--mode', mode,
  ];

  let code: number | null;
  let stdout: string;
  try {
    ({ code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(python, args, {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Vendored yaml first, then the engine package itself.
          PYTHONPATH: [path.join(dir, 'vendor'), dir].join(path.delimiter),
          // Writing .pyc files into the engine tree would change its tree hash and
          // make the pinned-integrity check report `tampered` after the first run.
          // Measured: without this, one run leaves 15 files under
          // `security_core/__pycache__` and the pin no longer matches.
          PYTHONDONTWRITEBYTECODE: '1',
          // Keep non-ASCII findings decodable on Windows, where the default
          // stdout encoding can otherwise mangle the engine's report.
          PYTHONIOENCODING: 'utf-8',
        },
      });

      let out = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('timeout'));
      }, RUN_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', () => { /* consumed to avoid a blocked pipe */ });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ code: typeof exitCode === 'number' ? exitCode : null, stdout: out });
      });
    }));
  } catch (err) {
    const msg = (err as Error).message || 'spawn_failed';
    log.warn('engine spawn failed', { error: msg });
    return unavailable(msg === 'timeout' ? 'timeout' : 'spawn_failed');
  }

  const report = parseDeclarationReport(stdout);
  if (!report) {
    log.warn('engine report was not valid JSON', { exitCode: code });
  }
  return declarationResultFromExitCodeAndReport(code, report);
}
