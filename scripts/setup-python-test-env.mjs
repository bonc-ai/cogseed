#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPythonCandidates, defaultProbe } from './python-test-runtime.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const venvDir = path.resolve(appRoot, 'venv');
const venvPython = process.platform === 'win32'
  ? path.resolve(venvDir, 'Scripts', 'python.exe')
  : path.resolve(venvDir, 'bin', 'python');

const setupCandidates = [
  process.env.ORKAS_TEST_SETUP_PYTHON,
  ...buildPythonCandidates({ appRoot }).filter((candidate) => path.resolve(candidate) !== venvPython),
].filter((value, index, all) => value && all.indexOf(value) === index);
const basePython = setupCandidates.find((candidate) => {
  if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) return false;
  return defaultProbe(candidate, ['--version']).ok;
});
if (!basePython && !existsSync(venvPython)) {
  console.error(`[setup-python-test-env] No Python runtime found; tried: ${setupCandidates.join(', ')}`);
  process.exit(2);
}

console.log(`[setup-python-test-env] target: ${venvDir}`);
if (!existsSync(venvPython)) {
  console.log(`[setup-python-test-env] creating with: ${basePython}`);
  const create = spawnSync(basePython, ['-m', 'venv', venvDir], { cwd: appRoot, stdio: 'inherit' });
  if (create.status !== 0) process.exit(create.status ?? 1);
}
console.log(`[setup-python-test-env] installing pytest + requests with: ${venvPython}`);
const install = spawnSync(venvPython, ['-m', 'pip', 'install', 'pytest==9.1.1', 'requests==2.34.2'], {
  cwd: appRoot,
  stdio: 'inherit',
});
process.exit(install.status ?? 1);
