/**
 * Tests for the skill declaration engine adapter.
 *
 * The exit-code mapping gets direct coverage because it *is* the security
 * decision this module owns: the engine reports, the platform decides. A test
 * that only ran the engine end-to-end would pass while the mapping silently
 * admitted a failing code.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  declarationVerdictFromExitCode,
  declarationEngineDir,
  validateSkillDeclaration,
  _resetPythonChoiceForTest,
  verifyDeclarationCoreIntegrity,
  parseDeclarationReport,
  declarationResultFromExitCodeAndReport,
} from '../../../../src/main/features/security/skill-declaration-adapter';
import { marketplaceContentTreeHash } from '../../../../src/main/util/marketplace-tree-hash';

const ENGINE = 'resources/guardrail/skill-declaration-core';
const PIN = 'resources/guardrail/skill-declaration-core.INTEGRITY';

describe('skill-declaration-adapter › declarationVerdictFromExitCode', () => {
  it('maps success codes', () => {
    expect(declarationVerdictFromExitCode(0)).toBe('pass');
    expect(declarationVerdictFromExitCode(10)).toBe('pass_with_warnings');
  });

  it('maps actionable codes to needs_input rather than blocked', () => {
    // NOT_READY / NEEDS_INPUT mean "the author has something to fill in", not
    // "this content is dangerous". Collapsing them into `blocked` would report a
    // missing field as a threat.
    expect(declarationVerdictFromExitCode(11)).toBe('needs_input');
    expect(declarationVerdictFromExitCode(12)).toBe('needs_input');
  });

  it('maps validation and security failures to blocked', () => {
    for (const code of [20, 21, 22, 23, 31, 32, 33, 34]) {
      expect(declarationVerdictFromExitCode(code), `exit ${code}`).toBe('blocked');
    }
  });

  it('maps execution error to unknown, never blocked', () => {
    // An infrastructure failure is "we could not check", not "it is unsafe".
    expect(declarationVerdictFromExitCode(40)).toBe('unknown');
  });

  it('maps the phase-2 range to unknown rather than silently admitting it', () => {
    // 35-39 are EXPIRED / ATTESTATION_INVALID / SIGNATURE_INVALID /
    // KEY_STATUS_INVALID / GATE_DENIED. Today's engine cannot emit them; a future
    // one that does must not read as `pass` by failing to match a case.
    for (const code of [35, 36, 37, 38, 39]) {
      expect(declarationVerdictFromExitCode(code), `exit ${code}`).toBe('unknown');
    }
  });

  it('maps unrecognised and null codes to unknown', () => {
    expect(declarationVerdictFromExitCode(99)).toBe('unknown');
    expect(declarationVerdictFromExitCode(null)).toBe('unknown');
    expect(declarationVerdictFromExitCode(-1)).toBe('unknown');
  });

  it('never returns pass for any code other than 0', () => {
    // The property that matters: admitting content must require an explicit 0.
    for (let code = 1; code <= 60; code++) {
      expect(declarationVerdictFromExitCode(code), `exit ${code}`).not.toBe('pass');
    }
  });
});

describe('skill-declaration-adapter › report parsing', () => {
  it('parses a JSON report and rejects empty or malformed output', () => {
    expect(parseDeclarationReport('')).toBeNull();
    expect(parseDeclarationReport('   ')).toBeNull();
    expect(parseDeclarationReport('not-json')).toBeNull();
    expect(parseDeclarationReport('{"subject":{"worktree_digest":"sha256:abc"}}'))
      .toEqual({ subject: { worktree_digest: 'sha256:abc' } });
  });

  it('never turns a missing report into pass, even when the exit code is 0', () => {
    const result = declarationResultFromExitCodeAndReport(0, null);
    expect(result.verdict).toBe('unknown');
    expect(result.unavailableReason).toBe('unparseable_report');
    expect(result.exitCode).toBe(0);
  });

  it('maps a parsed report with exit code 0 to pass', () => {
    const report = {
      subject: { worktree_digest: 'sha256:abc', subject_digest: null },
      validation: { result: 'PASS', findings: [] },
    };
    const result = declarationResultFromExitCodeAndReport(0, report);
    expect(result.verdict).toBe('pass');
    expect(result.engineResult).toBe('PASS');
    expect(result.worktreeDigest).toBe('sha256:abc');
    expect(result.subjectDigest).toBeNull();
  });
});

describe('skill-declaration-adapter › packaged engine', () => {
  it('resolves the engine directory from packaged resources', () => {
    expect(declarationEngineDir()).toBeTruthy();
  });

  it('vendors PyYAML as pure Python with no compiled extension', () => {
    // The bundled CPython payload carries only pip, and the engine hard-imports
    // yaml in five modules with no fallback. Vendoring the pure-Python lib is
    // what makes the engine runnable without a compiler or per-platform wheel.
    const vendor = path.join(ENGINE, 'vendor', 'yaml', '__init__.py');
    expect(fs.existsSync(vendor)).toBe(true);
    expect(fs.existsSync(path.join(ENGINE, 'vendor', 'yaml', 'parser.py'))).toBe(true);
  });

  it('does not ship __pycache__ or .pyc artifacts', () => {
    const stack = [ENGINE];
    const junk: string[] = [];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__pycache__') junk.push(p);
          else stack.push(p);
        } else if (e.name.endsWith('.pyc')) junk.push(p);
      }
    }
    expect(junk).toEqual([]);
  });
});

describe('skill-declaration-adapter › integrity pin', () => {
  it('stores the pin beside the tree, not inside it', () => {
    // Inside would be self-defeating: the tree hash covers every file in the
    // directory, so writing the pin would change the value it records and the
    // comparison could never match.
    expect(fs.existsSync(PIN)).toBe(true);
    expect(path.dirname(PIN)).toBe(path.dirname(ENGINE));
  });

  it('matches the current engine tree', () => {
    const pinned = fs.readFileSync(PIN, 'utf8').trim();
    expect(pinned).toMatch(/^[0-9a-f]{64}$/);
    expect(marketplaceContentTreeHash(ENGINE)).toBe(pinned);
  });

  it('detects a modified engine tree', () => {
    const pinned = fs.readFileSync(PIN, 'utf8').trim();
    const probe = path.join(ENGINE, 'security_core', '_integrity_probe.py');
    fs.writeFileSync(probe, '# probe\n');
    try {
      expect(marketplaceContentTreeHash(ENGINE)).not.toBe(pinned);
    } finally {
      fs.unlinkSync(probe);
    }
    expect(marketplaceContentTreeHash(ENGINE)).toBe(pinned);
  });

  it('reports the packaged engine as verified at runtime', () => {
    const dir = declarationEngineDir();
    expect(dir).toBeTruthy();
    expect(verifyDeclarationCoreIntegrity(dir!).status).toBe('verified');
  });

  it('reports tampered when a file inside the engine changes', () => {
    const dir = declarationEngineDir()!;
    const probe = path.join(dir, 'security_core', '_integrity_probe.py');
    fs.writeFileSync(probe, '# probe\n');
    try {
      expect(verifyDeclarationCoreIntegrity(dir).status).toBe('tampered');
    } finally {
      fs.unlinkSync(probe);
    }
    expect(verifyDeclarationCoreIntegrity(dir).status).toBe('verified');
  });

  it('reports unpinned when the pin file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declaration-integrity-'));
    fs.writeFileSync(path.join(dir, 'probe.txt'), 'probe');
    try {
      expect(verifyDeclarationCoreIntegrity(dir).status).toBe('unpinned');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skill-declaration-adapter › engine run', () => {
  beforeEach(() => { _resetPythonChoiceForTest(); });

  /** Skip when no interpreter on this machine can load the vendored payload. */
  function pythonUsable(): boolean {
    const dir = declarationEngineDir();
    if (!dir) return false;
    for (const p of [process.platform === 'win32' ? 'python' : 'python3']) {
      try {
        const r = spawnSync(p, ['-c', 'import yaml'], {
          stdio: 'ignore', timeout: 10_000,
          env: {
            ...process.env,
            PYTHONPATH: path.join(dir, 'vendor'),
            PYTHONDONTWRITEBYTECODE: '1',
          },
        });
        if (r.status === 0) return true;
      } catch { /* next */ }
    }
    return false;
  }

  it('returns unknown with a reason for a nonexistent skill root', async () => {
    if (!pythonUsable()) return;
    const missing = path.join(os.tmpdir(), `declaration-absent-${Date.now()}`);
    const r = await validateSkillDeclaration(missing, 'PREVALIDATION');
    // Cannot load the manifest → EXECUTION_ERROR → unknown. Never `blocked`:
    // a missing directory is not evidence that content is dangerous.
    expect(r.verdict).toBe('unknown');
  });

  it('validates the engine fixture and records a non-authoritative digest', async () => {
    if (!pythonUsable()) return;
    const fixture = path.resolve(ENGINE, 'fixtures', 'sample-skill');
    if (!fs.existsSync(fixture)) return; // fixtures are optional in packaged builds
    const r = await validateSkillDeclaration(fixture, 'PREVALIDATION');
    expect(['pass', 'pass_with_warnings']).toContain(r.verdict);
    // PREVALIDATION must never claim an authoritative subject digest.
    expect(r.subjectDigest).toBeNull();
    expect(r.worktreeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('leaves no bytecode in the engine tree, so the pin still matches', async () => {
    if (!pythonUsable()) return;
    const fixture = path.resolve(ENGINE, 'fixtures', 'sample-skill');
    if (!fs.existsSync(fixture)) return;
    const pinned = fs.readFileSync(PIN, 'utf8').trim();
    await validateSkillDeclaration(fixture, 'PREVALIDATION');
    // Running the engine must not change its own tree hash: Python would
    // otherwise write __pycache__ into it and the integrity pin would report
    // `tampered` from the second run onward.
    expect(marketplaceContentTreeHash(ENGINE)).toBe(pinned);
  });
});
