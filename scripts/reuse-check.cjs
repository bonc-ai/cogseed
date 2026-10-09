#!/usr/bin/env node
/**
 * REUSE compliance check for the CogSeed repository.
 *
 * Mirrors the decision logic of the official `reuse lint` tool so it can run
 * without downloading anything:
 *
 *   1. Every git-tracked file must carry a license + copyright declaration,
 *      either as inline SPDX headers (SPDX-FileCopyrightText /
 *      SPDX-License-Identifier) or via a matching rule in `.reuse/dep5`.
 *   2. Every referenced license id must have a corresponding license text
 *      under `LICENSES/` (SPDX canonical file name, e.g. `LICENSES/MIT.txt`).
 *   3. `.reuse/` and `LICENSES/` contents themselves are exempt, matching the
 *      official tool.
 *
 * Usage:
 *   node scripts/reuse-check.cjs
 *
 * Exits non-zero on any violation. Intended for local `npm run reuse:check`
 * and CI (P7 gate). When network access is available the official
 * `reuse lint` may be used instead; this script must stay compatible with it.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function parseDep5(file) {
  const rules = [];
  const text = fs.readFileSync(file, 'utf8');
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'Files') {
      current = { files: value, copyright: [], license: null };
      rules.push(current);
    } else if (current && key === 'Copyright') {
      current.copyright.push(value);
    } else if (current && key === 'License') {
      current.license = value;
    }
  }
  return rules;
}

function globToRegExp(glob) {
  const escaped = glob
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function inlineSpdx(file) {
  const out = { copyright: [], licenses: [] };
  try {
    const buf = fs.readFileSync(file);
    // Only inspect text-looking files (no NUL byte in the first 8 KiB).
    const head = buf.subarray(0, 8192);
    if (head.includes(0)) return out;
    // REUSE headers live at the top of a file; scanning deeper risks picking
    // up "SPDX-License-Identifier:" strings inside code or docs. The checker
    // itself is skipped because it contains the patterns as regex source.
    if (file.endsWith('reuse-check.cjs')) return out;
    const text = head.toString('utf8').split(/\r?\n/).slice(0, 64).join('\n');
    for (const m of text.matchAll(/SPDX-FileCopyrightText:\s*(.+)/g)) {
      out.copyright.push(m[1].trim());
    }
    for (const m of text.matchAll(/SPDX-License-Identifier:\s*(\S+)/g)) {
      out.licenses.push(m[1].trim());
    }
  } catch {
    /* unreadable files are handled by the caller's dep5 fallback */
  }
  return out;
}

function licenseTextName(license) {
  return license.endsWith('.txt') ? license : `${license}.txt`;
}

function main() {
  const dep5Path = path.join(REPO, '.reuse', 'dep5');
  if (!fs.existsSync(dep5Path)) {
    console.error('[reuse-check] missing .reuse/dep5');
    process.exit(1);
  }
  const rules = parseDep5(dep5Path);
  if (!rules.length) {
    console.error('[reuse-check] .reuse/dep5 contains no Files: rules');
    process.exit(1);
  }

  const violations = [];
  const referencedLicenses = new Set();
  const files = trackedFiles().filter((f) => !f.startsWith('.reuse/') && !f.startsWith('LICENSES/'));

  for (const file of files) {
    const inline = inlineSpdx(file);
    if (inline.licenses.length || inline.copyright.length) {
      if (!inline.licenses.length || !inline.copyright.length) {
        violations.push(`${file}: partial inline SPDX (needs both copyright and license)`);
      }
      for (const lic of inline.licenses) referencedLicenses.add(lic);
      continue;
    }
    const matched = rules.filter((r) => globToRegExp(r.files).test(file));
    if (!matched.length) {
      violations.push(`${file}: no license/copyright declaration (not covered by .reuse/dep5)`);
      continue;
    }
    const rule = matched[matched.length - 1];
    if (!rule.license || !rule.copyright.length) {
      violations.push(`${file}: .reuse/dep5 rule lacks License/Copyright`);
      continue;
    }
    referencedLicenses.add(rule.license);
  }

  const licensesDir = path.join(REPO, 'LICENSES');
  for (const lic of [...referencedLicenses].sort()) {
    const textFile = path.join(licensesDir, licenseTextName(lic));
    if (!fs.existsSync(textFile)) {
      violations.push(`LICENSES/${licenseTextName(lic)} missing for referenced license ${lic}`);
    }
  }

  if (violations.length) {
    console.error(`[reuse-check] ${violations.length} violation(s):`);
    for (const v of violations.slice(0, 100)) console.error(`  - ${v}`);
    if (violations.length > 100) console.error(`  ... and ${violations.length - 100} more`);
    process.exit(1);
  }
  console.log(`[reuse-check] OK: ${files.length} tracked files covered by .reuse/dep5 (${referencedLicenses.size} license(s) referenced)`);
}

main();
