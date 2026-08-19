import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function unique(values) {
  return values.filter((value, index, all) => value && all.indexOf(value) === index);
}

export function buildPythonCandidates({ appRoot, platform = process.platform, arch = process.arch, env = process.env, pathApi = path }) {
  const venvPython = platform === 'win32'
    ? pathApi.resolve(appRoot, 'venv', 'Scripts', 'python.exe')
    : pathApi.resolve(appRoot, 'venv', 'bin', 'python');
  const runtimeRoot = pathApi.resolve(appRoot, 'resources', 'runtime', 'python', `${platform}-${arch}`, 'python');
  const bundledPython = platform === 'win32'
    ? pathApi.resolve(runtimeRoot, 'python.exe')
    : pathApi.resolve(runtimeRoot, 'bin', 'python3');
  return unique([env.COGSEED_TEST_PYTHON, venvPython, bundledPython, 'python3', 'python']);
}

export function defaultExists(candidate) {
  if (candidate.includes('/') || candidate.includes('\\')) return existsSync(candidate);
  return null;
}

export function defaultProbe(candidate, args) {
  const result = spawnSync(candidate, args, { encoding: 'utf8' });
  const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().split('\n').slice(0, 2).join(' ');
  return { ok: result.status === 0, detail };
}

export function resolvePytestPython({ candidates, exists = defaultExists, probe = defaultProbe }) {
  const attempts = [];
  for (const candidate of candidates) {
    const present = exists(candidate);
    if (present === false) {
      attempts.push({ candidate, exists: false, pythonOk: false, pytestOk: false, reason: 'path does not exist' });
      continue;
    }
    const pythonProbe = probe(candidate, ['--version']);
    if (!pythonProbe.ok) {
      attempts.push({ candidate, exists: present, pythonOk: false, pytestOk: false, reason: `Python unavailable${pythonProbe.detail ? `: ${pythonProbe.detail}` : ''}` });
      continue;
    }
    const pytestProbe = probe(candidate, ['-m', 'pytest', '--version']);
    if (!pytestProbe.ok) {
      attempts.push({ candidate, exists: present, pythonOk: true, pytestOk: false, reason: `pytest unavailable${pytestProbe.detail ? `: ${pytestProbe.detail}` : ''}` });
      continue;
    }
    attempts.push({ candidate, exists: present, pythonOk: true, pytestOk: true, reason: 'selected' });
    return { selected: candidate, attempts };
  }
  return { selected: null, attempts };
}

export function formatPythonResolutionFailure(result, { appRoot, platform = process.platform }) {
  const lines = ['[run-python-tests] No pytest-capable Python runtime was found.', '[run-python-tests] Attempts:'];
  for (const attempt of result.attempts.slice(0, 12)) {
    lines.push(`  - ${attempt.candidate}: ${attempt.reason}`);
  }
  const venv = platform === 'win32'
    ? path.win32.resolve(appRoot, 'venv', 'Scripts', 'python.exe')
    : path.resolve(appRoot, 'venv', 'bin', 'python');
  lines.push('[run-python-tests] Create the repository test environment with:');
  lines.push('  npm run test:resources:setup');
  lines.push(`[run-python-tests] Expected interpreter: ${venv}`);
  return lines.join('\n');
}
