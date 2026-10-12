import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const verifier = require('../../scripts/verify-packaged-build-info.cjs') as {
  PLACEHOLDER_ORIGIN: string;
  resolvePackagedAsar: (options: Record<string, unknown>) => string;
  verifyPackagedBuildInfo: (asarPath: string, options?: Record<string, unknown>) => {
    ok: boolean;
    errors: string[];
  };
};

function verify(identity: Record<string, unknown>, expectedChannel = 'release') {
  return verifier.verifyPackagedBuildInfo('/repo/app.asar', {
    expectedChannel,
    exists: () => true,
    readAsarFile: () => Buffer.from(JSON.stringify(identity)),
  });
}

describe('verify-packaged-build-info', () => {
  it('resolves the Windows unpacked app and both macOS layouts', () => {
    const root = path.resolve('/repo');
    expect(verifier.resolvePackagedAsar({
      root, platform: 'win32', exists: (candidate: string) => candidate.endsWith('app.asar'),
    })).toBe(path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'));
    expect(verifier.resolvePackagedAsar({
      root, platform: 'darwin', arch: 'arm64', appPath: 'dist/mac-arm64/CogSeed.app',
    })).toBe(path.join(root, 'dist', 'mac-arm64', 'CogSeed.app', 'Contents', 'Resources', 'app.asar'));
  });

  it('accepts a release identity with a real HTTPS origin', () => {
    expect(verify({
      channel: 'release', commit: 'abc123', hubApiBase: 'https://hub.internal.test/',
    }).ok).toBe(true);
  });

  it.each([
    [{ channel: 'release', commit: 'abc123' }, /missing the injected hubApiBase/],
    [{ channel: 'release', commit: 'abc123', hubApiBase: verifier.PLACEHOLDER_ORIGIN }, /public placeholder/],
    [{ channel: 'release', commit: 'abc123', hubApiBase: 'http://hub.internal.test' }, /valid HTTPS origin/],
    [{ channel: 'ci', commit: 'abc123', hubApiBase: 'https://hub.internal.test' }, /channel must be release/],
    [{ channel: 'release', commit: '' , hubApiBase: 'https://hub.internal.test' }, /commit is missing/],
  ])('rejects invalid packaged identity %#', (identity, error) => {
    const result = verify(identity);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(error);
  });

  it('allows a CI identity without a service origin', () => {
    expect(verify({ channel: 'ci', commit: 'abc123' }, 'ci').ok).toBe(true);
  });
});
