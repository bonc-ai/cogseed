#!/usr/bin/env node
/**
 * Strip the optional deep-scanner components from a checkout, producing a
 * slim build that ships without them. skill-sentry is Apache-2.0 and is
 * normally distributed with the product; this script exists for builds that
 * intentionally leave the engine out (payload size, or a deployment that
 * installs the scanner separately).
 *
 * Stripped components:
 *   - `resources/guardrail/skill-sentry` — scanner rules and scoring weights.
 *   - `resources/guardrail/skill-declaration-core` — the declaration engine
 *     (implementation + ontologies).
 *   - `resources/guardrail/SYNC.md` — internal sync provenance (upstream
 *     workstation paths and vendor records) must not ship.
 *   - `resources/test/skill-sentry` — scanner test assets, which carry the
 *     same provenance.
 *
 * Removing the scanner alone is not enough: a missing scanner is
 * indistinguishable from a broken install, and the code treats a broken
 * install as a failure that refuses every skill install. So this also writes
 * the `SCANNER_ABSENT` marker that declares the omission intentional, which is
 * what makes the build report `scanner_absent` (installs allowed, local red
 * lines still enforced) instead of `unknown` (everything refused).
 *
 * The declaration engine has no equivalent marker: when it is absent the
 * status pipeline degrades to `unreadable`/`unavailable` (advisory paths
 * only — a missing engine never blocks a skill and never breaks the settings
 * page), which is the designed behaviour for stripped builds.
 *
 * What remains in the open-source tree:
 *   - `scan_gate.py` — the driver. Reads an engine's report and applies the
 *     documented thresholds; contains no rules.
 *   - `SCANNER_ABSENT` — the marker described above.
 *
 * A build stripped this way still performs a full deep scan when an operator
 * installs the scanner separately (see security/scan-orchestrator).
 *
 * Usage:
 *   node scripts/strip-closed-source-scanner.mjs [--root <dir>] [--check] [--force]
 *
 *   --root   Checkout to strip. Defaults to this repository.
 *   --check  Report what would happen; write nothing. Non-zero if not stripped.
 *   --force  Strip even when the target looks like the primary working tree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const MARKER_BODY = [
  'This build intentionally ships without the bundled deep scanner.',
  '',
  'Its presence makes the app report `scanner_absent` rather than `unknown`:',
  'skill installs are allowed and local red lines are still enforced, but deep',
  'scanning is unavailable until a scanner is installed separately.',
  '',
  'Do not delete this file to "fix" a missing scanner — without it the app treats',
  'the absence as a malfunction and refuses every skill install.',
  '',
].join('\n');

function parseArgs(argv) {
  const out = { root: REPO, check: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--root') { out.root = path.resolve(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'usage: strip-closed-source-scanner.mjs [--root <dir>] [--check] [--force]\n'
    + '  --root   checkout to strip (default: this repository)\n'
    + '  --check  report only, write nothing; non-zero if not stripped\n'
    + '  --force  allow stripping the primary working tree\n',
  );
  process.exit(0);
}

const guardrail = path.join(args.root, 'resources', 'guardrail');
const scanner = path.join(guardrail, 'skill-sentry');
// The declaration engine lives at one canonical name in current checkouts.
const declarationNames = ['skill-declaration-core']
  .map((name) => path.join(guardrail, name));
const declarationCores = declarationNames.filter((dir) => fs.existsSync(dir));
const scannerPin = path.join(guardrail, 'skill-sentry.INTEGRITY');
const declarationPins = declarationNames.map((dir) => `${dir}.INTEGRITY`)
  .filter((pinPath) => fs.existsSync(pinPath));
const syncDoc = path.join(guardrail, 'SYNC.md');
const testTree = path.join(args.root, 'resources', 'test', 'skill-sentry');
const marker = path.join(guardrail, 'SCANNER_ABSENT');

if (!fs.existsSync(guardrail)) {
  process.stderr.write(`no guardrail directory at ${guardrail}\n`);
  process.exit(2);
}

const hasScanner = fs.existsSync(scanner);
const hasDeclarationCore = declarationCores.length > 0;
const hasSyncDoc = fs.existsSync(syncDoc);
const hasTestTree = fs.existsSync(testTree);
const hasMarker = fs.existsSync(marker);

if (args.check) {
  process.stdout.write(
    `scanner present:            ${hasScanner}\n`
    + `declaration engine present: ${hasDeclarationCore} (${declarationCores.map((d) => path.relative(guardrail, d)).join(', ') || 'none'})\n`
    + `sync doc present:           ${hasSyncDoc}\n`
    + `test assets present:        ${hasTestTree}\n`
    + `marker present:             ${hasMarker}\n`,
  );
  if (hasScanner || hasDeclarationCore || hasSyncDoc || hasTestTree || !hasMarker) {
    process.stderr.write('not stripped for open-source distribution\n');
    process.exit(1);
  }
  process.stdout.write('stripped: optional scanner components absent, omission declared\n');
  process.exit(0);
}

// Refuse the primary working tree by default. Running this in place deletes the
// engines from a developer's checkout, and the mistake is quiet: everything keeps
// working, just with weaker scanning, which is exactly the state nobody notices.
if (path.resolve(args.root) === REPO && !args.force) {
  process.stderr.write(
    'refusing to strip the primary working tree (this would delete your local engine copies).\n'
    + 'Run against a distribution copy, or pass --force if that is really intended.\n',
  );
  process.exit(2);
}

if (hasScanner) fs.rmSync(scanner, { recursive: true, force: true });
// The pin describes a tree that is no longer here; leaving it would invite a
// mismatch against whatever scanner gets installed later.
if (fs.existsSync(scannerPin)) fs.rmSync(scannerPin, { force: true });
for (const core of declarationCores) fs.rmSync(core, { recursive: true, force: true });
for (const pinPath of declarationPins) fs.rmSync(pinPath, { force: true });
if (hasSyncDoc) fs.rmSync(syncDoc, { force: true });
if (hasTestTree) fs.rmSync(testTree, { recursive: true, force: true });
fs.writeFileSync(marker, MARKER_BODY);

const removed = [
  'scanner', ...declarationCores.map((d) => path.relative(guardrail, d)),
  'syncDoc', 'testTree',
].filter(Boolean);
process.stdout.write(
  'stripped optional scanner components\n'
  + `  removed: ${scanner}\n`
  + `  removed: ${declarationCores.join(', ') || '(none)'}\n`
  + `  removed: ${syncDoc}\n`
  + `  removed: ${testTree}\n`
  + `  marker:  ${marker}\n`,
);
