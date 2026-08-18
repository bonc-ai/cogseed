#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const forbidden = [
  /\bORKAS_[A-Z0-9_]+\b/g,
  /\bOrkas\b/g,
  /\borkas(?:[.:_/-]|\b)/g,
  /\bMATE_AGENT[A-Z0-9_]*\b/g,
  /\bMateAgent[A-Za-z0-9_]*\b/g,
  /\bmateAgent[A-Za-z0-9_]*\b/g,
  /\bmate_agent(?:[.:_/-]|\b)/g,
  /\bmate-agent(?:[.:_/-]|\b)/g,
  /\bmateagent(?:[.:_/-]|\b)/g,
  /\bMATE_RUNTIME[A-Z0-9_]*\b/g,
  /\bMateRuntime[A-Za-z0-9_]*\b/g,
  /\bmateRuntime[A-Za-z0-9_]*\b/g,
  /\bmate-runtime(?:[.:_/-]|\b)/g,
];

const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const findings = [];
for (const rel of files) {
  const abs = path.join(root, rel);
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch { continue; }
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of forbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        findings.push(`${rel}:${index + 1}: ${line.trim().slice(0, 240)}`);
        break;
      }
    }
  });
}
if (findings.length) {
  console.error(`[cogseed-only] forbidden legacy identifiers: ${findings.length}`);
  for (const item of findings.slice(0, 500)) console.error(item);
  if (findings.length > 500) console.error(`... ${findings.length - 500} more`);
  process.exit(1);
}
console.log('[cogseed-only] no legacy product identifiers found');
