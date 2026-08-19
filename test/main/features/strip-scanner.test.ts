/**
 * Stripping the closed-source scanner for open-source distribution.
 *
 * The subtle requirement is that removing the scanner is NOT sufficient. A missing
 * scanner is indistinguishable from a broken install, and the code treats a broken
 * install as a failure that refuses every skill install — so a strip that forgot
 * the marker would produce a build that silently cannot install anything. That is
 * what the marker assertions here exist to catch.
 *
 * These drive the real script against temp copies. It deletes directories, so a
 * mocked filesystem would be testing something other than the risky part.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO, 'scripts', 'strip-closed-source-scanner.mjs');
const REAL_SCANNER = path.join(REPO, 'resources', 'guardrail', 'skill-sentry');
const REAL_DECLARATION = path.join(REPO, 'resources', 'guardrail', 'skill-declaration-core');

let tmp = '';

/** A minimal checkout copy: guardrail dir with both engines and the driver. */
function stageCheckout(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-'));
  const guardrail = path.join(tmp, 'resources', 'guardrail');
  fs.mkdirSync(guardrail, { recursive: true });
  fs.cpSync(REAL_SCANNER, path.join(guardrail, 'skill-sentry'), { recursive: true });
  fs.cpSync(REAL_DECLARATION, path.join(guardrail, 'skill-declaration-core'), { recursive: true });
  fs.writeFileSync(path.join(guardrail, 'scan_gate.py'), '# driver, no rules\n');
  fs.writeFileSync(path.join(guardrail, 'skill-sentry.INTEGRITY'), 'deadbeef\n');
  fs.writeFileSync(path.join(guardrail, 'skill-declaration-core.INTEGRITY'), 'deadbeef\n');
  return tmp;
}

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('strip closed-source scanner', () => {
  it('removes the scanner tree', () => {
    const root = stageCheckout();

    expect(run(['--root', root]).code).toBe(0);

    expect(fs.existsSync(path.join(root, 'resources', 'guardrail', 'skill-sentry'))).toBe(false);
  }, 60_000);

  it('removes the skill-declaration-core tree', () => {
    const root = stageCheckout();

    expect(run(['--root', root]).code).toBe(0);

    expect(fs.existsSync(path.join(root, 'resources', 'guardrail', 'skill-declaration-core'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'resources', 'guardrail', 'skill-declaration-core.INTEGRITY'))).toBe(false);
  }, 60_000);

  // THE load-bearing assertion. Without the marker the app reads the absence as a
  // malfunction and refuses every skill install — a stripped build that cannot
  // install anything, failing for a reason no user could diagnose.
  it('declares the omission so installs still work', () => {
    const root = stageCheckout();

    run(['--root', root]);

    expect(fs.existsSync(path.join(root, 'resources', 'guardrail', 'SCANNER_ABSENT'))).toBe(true);
  }, 60_000);

  // The driver contains no rules and the open-source build needs it to interpret
  // an externally installed engine's report.
  it('keeps the rule-free driver script', () => {
    const root = stageCheckout();

    run(['--root', root]);

    expect(fs.existsSync(path.join(root, 'resources', 'guardrail', 'scan_gate.py'))).toBe(true);
  }, 60_000);

  // The pin describes a tree that is no longer present; keeping it would mismatch
  // against whatever scanner the operator installs later.
  it('drops the integrity pin for the removed tree', () => {
    const root = stageCheckout();

    run(['--root', root]);

    expect(fs.existsSync(path.join(root, 'resources', 'guardrail', 'skill-sentry.INTEGRITY')))
      .toBe(false);
  }, 60_000);

  // Running in place would delete a developer's scanner, and the mistake is quiet:
  // everything keeps working, just with weaker scanning.
  it('refuses to strip the primary working tree without --force', () => {
    const r = run([]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refusing to strip the primary working tree');
    expect(fs.existsSync(REAL_SCANNER)).toBe(true);
  }, 60_000);

  it('reports non-zero from --check on an unstripped tree', () => {
    const root = stageCheckout();

    expect(run(['--root', root, '--check']).code).not.toBe(0);
  }, 60_000);

  it('reports zero from --check once stripped', () => {
    const root = stageCheckout();
    run(['--root', root]);

    expect(run(['--root', root, '--check']).code).toBe(0);
  }, 60_000);
});
