#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const oldA = ['or', 'kas'].join('');
const oldB = ['ma', 'te'].join('');
const upperA = oldA.toUpperCase();
const titleA = oldA[0].toUpperCase() + oldA.slice(1);
const upperB = oldB.toUpperCase();
const titleB = oldB[0].toUpperCase() + oldB.slice(1);
const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oldProductPatterns = [
  new RegExp(`\\b${esc(upperA)}_[A-Z0-9_]+\\b`, 'g'),
  new RegExp(`\\b${esc(titleA)}\\b`, 'g'),
  new RegExp(`\\b${esc(oldA)}(?:[.:_/-]|\\b)`, 'g'),
];
const oldRuntimePatterns = [
  new RegExp(`\\b${esc(upperB)}_AGENT[A-Z0-9_]*\\b`, 'g'),
  new RegExp(`${esc(titleB)}Agent[A-Za-z0-9_]*`, 'g'),
  new RegExp(`${esc(oldB)}Agent[A-Za-z0-9_]*`, 'g'),
  new RegExp(`\\b${esc(oldB)}_agent(?:[.:_/-]|\\b)`, 'g'),
  new RegExp(`\\b${esc(oldB)}-agent(?:[.:_/-]|\\b)`, 'g'),
  new RegExp(`\\b${esc(oldB)}agent(?:[.:_/-]|\\b)`, 'g'),
  new RegExp(`\\b${esc(upperB)}_RUNTIME[A-Z0-9_]*\\b`, 'g'),
  new RegExp(`${esc(titleB)}Runtime[A-Za-z0-9_]*`, 'g'),
  new RegExp(`${esc(oldB)}Runtime[A-Za-z0-9_]*`, 'g'),
  new RegExp(`\\b${esc(oldB)}-runtime(?:[.:_/-]|\\b)`, 'g'),
];
const patterns = [...oldProductPatterns, ...oldRuntimePatterns];

// These public files must retain upstream provenance to satisfy copyright and
// license obligations. The exception applies only to the original product
// family, never to old runtime identifiers or executable source.
const provenanceFiles = new Set([
  'NOTICE',
  'README.md',
  'README.zh-CN.md',
  'THIRD_PARTY_NOTICES.md',
  'p3394-gateway/NOTICE',
  'publiccode.yml',
]);
const negativeAssertionFiles = new Set(['test/main/cogseed-residual-identifiers.test.ts']);

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const findings = [];
for (const rel of files) {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(rel)) { findings.push(`${rel}: tracked path contains a legacy product identifier`); break; }
  }
  let bytes;
  try { bytes = fs.readFileSync(path.join(root, rel)); } catch { continue; }
  if (bytes.includes(0)) continue;
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (!pattern.test(line)) continue;
      if (provenanceFiles.has(rel) && oldProductPatterns.includes(pattern)) continue;
      if (negativeAssertionFiles.has(rel) && /\.not\.toContain\s*\(/.test(line)) continue;
      findings.push(`${rel}:${index + 1}: ${line.trim().slice(0, 240)}`);
      break;
    }
  }
}
if (findings.length) {
  console.error(`[cogseed-only] forbidden legacy identifiers: ${findings.length}`);
  for (const item of findings.slice(0, 500)) console.error(item);
  if (findings.length > 500) console.error(`... ${findings.length - 500} more`);
  process.exit(1);
}
console.log('[cogseed-only] no legacy product identifiers found');
