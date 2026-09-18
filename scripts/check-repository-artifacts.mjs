#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbiddenArtifactName = /(?:checklist|audit|scan-report|扫描报告|审计报告)/i;
const documentFile = /(?:^|\/)(?:[^/]+\.(?:md|txt|rst)|CHANGELOG(?:\.[^/]*)?)$/i;
const localPath = /(?:\/Users\/[^\s`'"<>]+|\/private\/tmp\/[^\s`'"<>]+|[A-Za-z]:\\Users\\[^\s`'"<>]+|[A-Za-z]:\\(?:a|b)\\[^\s`'"<>]+)/;
const findings = [];

for (const relativePath of trackedFiles) {
  const isTemplate = relativePath === '.specify/templates/checklist-template.md';
  const isDocument = /\.(?:md|txt|json)$/i.test(relativePath);
  if (!isTemplate && isDocument && forbiddenArtifactName.test(path.basename(relativePath))) {
    findings.push(`${relativePath}: release/audit result artifact is not allowed in the repository`);
    continue;
  }
  if (!documentFile.test(relativePath)) continue;
  const absolutePath = path.join(root, relativePath);
  let content;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    findings.push(`${relativePath}: unable to read tracked document (${error.message || error})`);
    continue;
  }
  if (localPath.test(content)) {
    findings.push(`${relativePath}: document contains a machine-specific absolute path`);
  }
}

if (findings.length > 0) {
  process.stderr.write('[repository-artifact-check] forbidden repository artifacts found:\n');
  for (const finding of findings) process.stderr.write(`- ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`[repository-artifact-check] checked ${trackedFiles.length} tracked files; no forbidden artifacts found\n`);
}
