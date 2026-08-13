#!/usr/bin/env node
/**
 * Pin the security scanner's tree hash, or verify an existing pin.
 *
 * Run at release time for the closed-source scanner package. The pin is what lets
 * `features/scanner_trust` verify the scanner without content-scanning it — the
 * scanner's own rule files contain the patterns it detects, so scanning it returns
 * `blocked` and content scanning is simply the wrong instrument.
 *
 * The pin is written BESIDE the scanner directory, never inside it: the tree hash
 * covers every file in the directory, so an inside pin would change the value it
 * records and no freshly pinned tree could verify.
 *
 * Usage:
 *   node scripts/pin-scanner-integrity.mjs [--dir <scanner-dir>] [--check]
 *
 *   --dir    Scanner tree to pin. Defaults to resources/guardrail/skill-sentry.
 *   --check  Verify without writing. Exits non-zero on mismatch, for CI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = { dir: path.join(REPO, 'resources', 'guardrail', 'skill-sentry'), check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--dir') { out.dir = path.resolve(argv[i + 1] || ''); i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    'usage: pin-scanner-integrity.mjs [--dir <scanner-dir>] [--check]\n'
    + '  --dir    scanner tree to pin (default resources/guardrail/skill-sentry)\n'
    + '  --check  verify without writing; non-zero exit on mismatch\n',
  );
  process.exit(0);
}

if (!fs.existsSync(path.join(args.dir, 'SKILL.md'))) {
  process.stderr.write(`not a scanner tree (no SKILL.md): ${args.dir}\n`);
  process.exit(2);
}

// Imported through tsx so the hash comes from the same implementation the runtime
// verifies with. A reimplementation here would drift, and a drifted pin generator
// produces pins that never verify.
//
// Run this script with `node --import tsx`, matching how the repo's other
// TS-importing scripts are invoked; without the loader the import below fails.
const { marketplaceContentTreeHash } = await import(
  path.join(REPO, 'src', 'main', 'util', 'marketplace-tree-hash.ts')
);

const pinFile = path.join(path.dirname(args.dir), 'skill-sentry.INTEGRITY');
const actual = marketplaceContentTreeHash(args.dir);

if (args.check) {
  const expected = fs.existsSync(pinFile) ? fs.readFileSync(pinFile, 'utf8').trim() : '';
  if (!expected) {
    process.stderr.write(`no pin recorded at ${pinFile}\n`);
    process.exit(1);
  }
  if (expected !== actual) {
    process.stderr.write(`scanner integrity MISMATCH\n  pinned: ${expected}\n  actual: ${actual}\n`);
    process.exit(1);
  }
  process.stdout.write(`scanner integrity verified: ${actual}\n`);
  process.exit(0);
}

fs.writeFileSync(pinFile, `${actual}\n`);
process.stdout.write(
  `pinned scanner integrity\n  tree: ${args.dir}\n  hash: ${actual}\n  pin:  ${pinFile}\n`,
);
