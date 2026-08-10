/**
 * Trust for the security scanner itself.
 *
 * WHY THE SCANNER CANNOT BE SCANNED
 * The scanner's own rule files contain the patterns it detects — credential-path
 * reads, `eval` of external input, download-then-execute — because that is what a
 * rule for those things looks like. Scanning the scanner therefore returns
 * `blocked` with a wall of red lines. Measured, not assumed: installing it as a
 * user skill and running the deep re-verification returns `blocked` in 262ms with
 * 11 red lines and a reported attack surface of 20 egress points.
 *
 * So content scanning is the wrong instrument here, and the exemption is not a
 * convenience. What the scanner needs verified is not "do its bytes look
 * dangerous" but "are its bytes the ones we shipped".
 *
 * WHAT REPLACES IT
 * A pinned tree hash. `expectedScannerHash()` is the hash recorded at release
 * time; `verifyScannerIntegrity()` recomputes it from disk. Tampering still fails
 * — a modified rule file, a swapped engine, an added script all change the tree
 * hash — while the false positive disappears.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not exempt anything but one hardcoded skill id. A configurable
 * exemption list would let whatever can write settings nominate its own payload
 * as the trusted scanner, which inverts the gate: the component doing the
 * checking would be chosen by the thing being checked.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { skillPayloadHash } from './skill_trust';
import { createLogger } from '../logger';

const log = createLogger('scanner-trust');

/**
 * The one exempt skill id. Hardcoded, never read from configuration.
 *
 * Kept in sync with `SENTRY_SKILL_ID` in security/scan-orchestrator by having
 * both spell the same literal; importing across the boundary would pull the
 * orchestrator's lazy `paths` handling into the trust path for no benefit.
 */
export const SCANNER_SKILL_ID = 'skill-sentry';

/**
 * Name of the pinned-hash file, stored BESIDE the scanner tree, not inside it.
 *
 * Inside would be self-defeating: the tree hash covers every file in the
 * directory, so writing the pin changes the value it is meant to record and the
 * comparison can never match. Measured the hard way — the first version put it
 * inside and reported `tampered` on a freshly pinned, untouched tree.
 */
const PIN_FILE = 'skill-sentry.INTEGRITY';

/** Path of the pin for a given scanner tree: a sibling of the tree itself. */
function pinPath(scannerDir: string): string {
  return path.join(path.dirname(scannerDir), PIN_FILE);
}

export type ScannerIntegrity =
  /** Recomputed hash matches the pinned one. */
  | 'verified'
  /** Hash differs: the tree on disk is not what was pinned. */
  | 'tampered'
  /** No pin recorded, so there is nothing to compare against. */
  | 'unpinned'
  /** Tree unreadable, so no claim either way. */
  | 'unreadable';

/** Whether an id refers to the security scanner. */
export function isScannerSkill(skillId: string): boolean {
  return skillId === SCANNER_SKILL_ID;
}

/**
 * The hash recorded for this scanner tree at release time, if any.
 *
 * Read from a file beside the tree rather than compiled into the app: the scanner
 * ships and versions separately once it lives outside this repository, so a
 * constant here would have to be updated in lockstep with a component the build
 * no longer contains.
 *
 * That the pin travels with the tree it describes is a real limitation, recorded
 * plainly: it detects accidental drift and third-party modification, not an
 * attacker who edits the tree and rewrites the pin. Closing that needs a
 * signature checked against a key the scanner does not carry, which is a
 * different mechanism from this one.
 */
export function expectedScannerHash(scannerDir: string): string | null {
  try {
    const raw = fs.readFileSync(pinPath(scannerDir), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Compare the scanner tree on disk against its pinned hash.
 *
 * `unpinned` is reported rather than folded into `verified` or `tampered`: a
 * scanner with no pin has not been shown to be intact, and has not been shown to
 * be modified either. Callers decide what to do with that; conflating it with
 * `verified` would make an unsigned drop-in look checked.
 */
export function verifyScannerIntegrity(scannerDir: string): {
  status: ScannerIntegrity;
  expected?: string;
  actual?: string;
} {
  const expected = expectedScannerHash(scannerDir);
  const actual = skillPayloadHash(scannerDir);
  if (!actual) return { status: 'unreadable' };
  if (!expected) return { status: 'unpinned', actual };
  if (expected !== actual) {
    // Logged at warn because a mismatch is either a tampered security component
    // or a release that forgot to refresh the pin, and both need a human.
    log.warn('scanner integrity mismatch', { scannerDir, expected, actual });
    return { status: 'tampered', expected, actual };
  }
  return { status: 'verified', expected, actual };
}

/**
 * Whether the scanner may be loaded and run.
 *
 * Only `tampered` withholds it. `unpinned` and `unreadable` do not, and that is a
 * deliberate fail-open: refusing the scanner would disable scanning for every
 * other skill, so an unverifiable scanner must not become a self-inflicted outage
 * of the whole security path. The mismatch case — the one that indicates actual
 * modification — still refuses.
 */
export function scannerTrustedForLoad(scannerDir: string): {
  trusted: boolean;
  integrity: ScannerIntegrity;
} {
  const { status } = verifyScannerIntegrity(scannerDir);
  return { trusted: status !== 'tampered', integrity: status };
}
