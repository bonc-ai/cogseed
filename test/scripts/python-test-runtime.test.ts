import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildPythonCandidates,
  formatPythonResolutionFailure,
  resolvePytestPython,
} from '../../scripts/python-test-runtime.mjs';

describe('python test runtime resolver', () => {
  it('orders explicit override, repo venv, bundled runtime, then PATH candidates without duplicates', () => {
    expect(buildPythonCandidates({
      appRoot: '/repo',
      platform: 'darwin',
      arch: 'arm64',
      env: { COGSEED_TEST_PYTHON: '/custom/python' },
    })).toEqual([
      '/custom/python',
      '/repo/venv/bin/python',
      '/repo/resources/runtime/python/darwin-arm64/python/bin/python3',
      'python3',
      'python',
    ]);

    expect(buildPythonCandidates({
      appRoot: 'C:\\repo',
      platform: 'win32',
      arch: 'x64',
      env: { COGSEED_TEST_PYTHON: 'python' },
      pathApi: path.win32,
    })).toEqual([
      'python',
      'C:\\repo\\venv\\Scripts\\python.exe',
      'C:\\repo\\resources\\runtime\\python\\win32-x64\\python\\python.exe',
      'python3',
    ]);
  });

  it('rejects executable Python candidates that cannot import pytest', () => {
    const result = resolvePytestPython({
      candidates: ['/no-file', 'python3', '/good/python'],
      exists: (candidate) => candidate !== '/no-file',
      probe: (candidate, args) => {
        if (candidate === 'python3' && args.includes('pytest')) return { ok: false, detail: 'No module named pytest' };
        return { ok: true, detail: 'ok' };
      },
    });

    expect(result.selected).toBe('/good/python');
    expect(result.attempts).toEqual([
      expect.objectContaining({ candidate: '/no-file', exists: false, pythonOk: false, pytestOk: false }),
      expect.objectContaining({ candidate: 'python3', pythonOk: true, pytestOk: false, reason: 'pytest unavailable: No module named pytest' }),
      expect.objectContaining({ candidate: '/good/python', pythonOk: true, pytestOk: true, reason: 'selected' }),
    ]);
  });

  it('preserves the explicit override precedence when it has pytest', () => {
    const result = resolvePytestPython({
      candidates: ['/override', '/repo/venv/bin/python'],
      exists: () => true,
      probe: () => ({ ok: true, detail: 'ok' }),
    });
    expect(result.selected).toBe('/override');
    expect(result.attempts).toHaveLength(1);
  });

  it('prints bounded diagnostics and a platform-specific setup command', () => {
    const text = formatPythonResolutionFailure({
      selected: null,
      attempts: [
        { candidate: 'python3', exists: null, pythonOk: true, pytestOk: false, reason: 'pytest unavailable: missing' },
      ],
    }, { appRoot: '/repo', platform: 'darwin' });
    expect(text).toContain('python3');
    expect(text).toContain('pytest unavailable');
    expect(text).toContain('npm run test:resources:setup');
    expect(text).not.toContain('undefined');
  });
});
