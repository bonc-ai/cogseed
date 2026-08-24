/**
 * Trust for the security scanner itself.
 *
 * The premise test is the first one: scanning the scanner's own tree returns
 * `blocked`, because its rule files contain the patterns it detects. That is why
 * the exemption exists, and if it ever stops being true the exemption should be
 * revisited rather than kept out of habit — so it is asserted, not assumed.
 *
 * The load-bearing test is that tampering is still caught. An exemption that
 * skipped the check outright would pass every other test here while removing the
 * only thing protecting a security component from silent modification.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  isScannerSkill, verifyScannerIntegrity, scannerTrustedForLoad, SCANNER_SKILL_ID,
} from '../../../src/main/features/scanner_trust';
import { skillPayloadHash } from '../../../src/main/features/skill_trust';
import { scanSkillDir } from '../../../src/main/features/security/sentry-adapter';

const REAL_SCANNER = path.resolve(__dirname, '../../../resources/guardrail/skill-sentry');
// The open-source tree ships without the scanner; pinning and self-scan
// behaviours can only run where the scanner is actually present.
const HAS_SCANNER = fs.existsSync(REAL_SCANNER);

let root = '';

/** Copy the real scanner into a temp parent, so the pin can sit beside it. */
function stageScanner(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-trust-'));
  const dir = path.join(root, 'skill-sentry');
  fs.cpSync(REAL_SCANNER, dir, { recursive: true });
  return dir;
}

function pin(scannerDir: string, value?: string): void {
  fs.writeFileSync(
    path.join(path.dirname(scannerDir), 'skill-sentry.INTEGRITY'),
    value ?? skillPayloadHash(scannerDir),
  );
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('scanner trust › why content scanning cannot be used', () => {
  // The premise. If this ever passes clean, the exemption has lost its
  // justification and should be reconsidered.
  it.skipIf(!HAS_SCANNER)('blocks itself when content-scanned, because its rules contain what it detects', async () => {
    const dir = stageScanner();

    const scan = await scanSkillDir(dir, 'thirdparty');

    expect(scan.outcome).toBe('blocked');
    expect(scan.localRedLines?.length).toBeGreaterThan(0);
  }, 180_000);
});

describe('scanner trust › pinned tree hash', () => {
  it.skipIf(!HAS_SCANNER)('verifies an untouched tree against its pin', () => {
    const dir = stageScanner();
    pin(dir);

    expect(verifyScannerIntegrity(dir).status).toBe('verified');
    expect(scannerTrustedForLoad(dir).trusted).toBe(true);
  });

  // The reason this mechanism exists at all: a modified rule file must not load.
  it.skipIf(!HAS_SCANNER)('detects a modified rule file and withholds the scanner', () => {
    const dir = stageScanner();
    pin(dir);

    fs.appendFileSync(
      path.join(dir, 'engine', 'rulesets', 'v1.0.0', 'text-rules.yaml'),
      '\n# an attacker weakens a rule\n',
    );

    expect(verifyScannerIntegrity(dir).status).toBe('tampered');
    expect(scannerTrustedForLoad(dir).trusted).toBe(false);
  });

  it.skipIf(!HAS_SCANNER)('detects an added file, not only edits to existing ones', () => {
    const dir = stageScanner();
    pin(dir);

    fs.writeFileSync(path.join(dir, 'extra.py'), 'print("smuggled in")\n');

    expect(verifyScannerIntegrity(dir).status).toBe('tampered');
  });

  // The pin lives beside the tree, not inside it: the tree hash covers every file
  // in the directory, so an inside pin would change the value it records and no
  // freshly pinned tree could ever verify.
  it.skipIf(!HAS_SCANNER)('keeps the pin outside the hashed tree', () => {
    const dir = stageScanner();
    pin(dir);

    expect(fs.existsSync(path.join(path.dirname(dir), 'skill-sentry.INTEGRITY'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skill-sentry.INTEGRITY'))).toBe(false);
    // Verifying twice must be stable — an inside pin would flip to `tampered`.
    expect(verifyScannerIntegrity(dir).status).toBe('verified');
    expect(verifyScannerIntegrity(dir).status).toBe('verified');
  });

  // Not shown intact, not shown modified. Folding this into `verified` would make
  // an unsigned drop-in look checked.
  it.skipIf(!HAS_SCANNER)('reports an unpinned tree as neither verified nor tampered', () => {
    const dir = stageScanner();

    expect(verifyScannerIntegrity(dir).status).toBe('unpinned');
  });

  // Deliberate fail-open: refusing an unverifiable scanner would disable scanning
  // for every other skill, turning a missing pin into an outage of the whole
  // security path. Only a real mismatch withholds it.
  it.skipIf(!HAS_SCANNER)('still loads an unpinned scanner rather than disabling all scanning', () => {
    const dir = stageScanner();

    expect(scannerTrustedForLoad(dir)).toEqual({ trusted: true, integrity: 'unpinned' });
  });

  it('makes no claim about an unreadable tree', () => {
    expect(verifyScannerIntegrity(path.join(os.tmpdir(), 'definitely-not-here')).status)
      .toBe('unreadable');
  });
});

describe('scanner trust › exemption scope', () => {
  // A configurable exemption would let whatever can write settings nominate its
  // own payload as the trusted scanner, which inverts the gate.
  it('exempts only the one hardcoded scanner id', () => {
    expect(isScannerSkill(SCANNER_SKILL_ID)).toBe(true);

    for (const other of ['skill-sentry-2', 'my-skill', 'SKILL-SENTRY', '', 'skill sentry']) {
      expect(isScannerSkill(other)).toBe(false);
    }
  });
});
