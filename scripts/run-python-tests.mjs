#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildPythonCandidates,
  formatPythonResolutionFailure,
  resolvePytestPython,
} from './python-test-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const candidates = buildPythonCandidates({ appRoot });
const resolution = resolvePytestPython({ candidates });
if (!resolution.selected) {
  console.error(formatPythonResolutionFailure(resolution, { appRoot }));
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) args.push('resources/builtin');
const result = spawnSync(resolution.selected, ['-m', 'pytest', ...args], {
  cwd: appRoot,
  stdio: 'inherit',
});
if (result.error) {
  console.error(`[run-python-tests] failed to start pytest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
