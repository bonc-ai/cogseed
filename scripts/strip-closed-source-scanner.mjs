#!/usr/bin/env node
/**
 * Strip the closed-source security scanner from a checkout, for open-source
 * distribution.
 *
 * The scanner (`resources/guardrail/skill-sentry`) carries rules and scoring
 * weights that are not published. Removing it is not enough on its own: a missing
 * scanner is indistinguishable from a broken install, and the code treats a broken
 * install as a failure that refuses every skill install. So this also writes the
 * `SCANNER_ABSENT` marker that declares the omission intentional, which is what
 * makes the build report `scanner_absent` (installs allowed, local red lines still
 * enforced) instead of `unknown` (everything refused).
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
  'This build intentionally ships without the closed-source deep scanner.',
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
// 闭源引擎树：skill-sentry（深度扫描器）+ nseap-security-core / 其品牌分支
// 重命名后的 skill-declaration-core（NSEAP 核心）。沿用旧名是为了兼容
// 不同 checkout 阶段的名字——任一存在即剥离。
const CLOSED_SOURCE_TREES = [
  'skill-sentry',
  'nseap-security-core',
  'skill-declaration-core',
];
const marker = path.join(guardrail, 'SCANNER_ABSENT');

if (!fs.existsSync(guardrail)) {
  process.stderr.write(`no guardrail directory at ${guardrail}\n`);
  process.exit(2);
}

const presentTrees = CLOSED_SOURCE_TREES.filter((tree) => fs.existsSync(path.join(guardrail, tree)));
const hasMarker = fs.existsSync(marker);

if (args.check) {
  process.stdout.write(
    `closed-source trees present: ${presentTrees.length ? presentTrees.join(', ') : '(none)'}\nmarker present:  ${hasMarker}\n`,
  );
  if (presentTrees.length || !hasMarker) {
    process.stderr.write('not stripped for open-source distribution\n');
    process.exit(1);
  }
  process.stdout.write('stripped: closed-source engines absent, omission declared\n');
  process.exit(0);
}

// Refuse the primary working tree by default. Running this in place deletes the
// engines from a developer's checkout, and the mistake is quiet: everything keeps
// working, just with weaker scanning, which is exactly the state nobody notices.
if (path.resolve(args.root) === REPO && !args.force) {
  process.stderr.write(
    'refusing to strip the primary working tree (this would delete your local closed-source engines).\n'
    + 'Run against a distribution copy, or pass --force if that is really intended.\n',
  );
  process.exit(2);
}

const removedTrees = [];
for (const tree of CLOSED_SOURCE_TREES) {
  const dir = path.join(guardrail, tree);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // The integrity pin describes a tree that is no longer here; leaving it would
  // invite a mismatch against whatever engine gets installed later.
  const treePin = path.join(guardrail, `${tree}.INTEGRITY`);
  if (fs.existsSync(treePin)) fs.rmSync(treePin, { force: true });
  if (!fs.existsSync(dir) && !fs.existsSync(treePin)) {
    removedTrees.push(`${tree}/ + ${path.basename(treePin)}`);
  }
}
fs.writeFileSync(marker, MARKER_BODY);

process.stdout.write(
  `stripped closed-source engines\n  removed: ${removedTrees.join(', ') || '(none)'}\n  marker:  ${marker}\n`,
);
