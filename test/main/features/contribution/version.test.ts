import { describe, expect, it } from 'vitest';
import { compareSemVer, isHigherSemVer, parseSemVer } from '../../../../src/main/features/contribution/version';

describe('contribution SemVer preflight', () => {
  it.each(['1.0.0', '0.1.0', '1.0.0-alpha.1', '1.0.0+build.7'])('accepts strict SemVer %s', (value) => {
    expect(parseSemVer(value)).not.toBeNull();
  });

  it.each(['1', '1.0', '01.0.0', '1.0.0-', 'v1.0.0', '1.0.0.0'])('rejects malformed version %s', (value) => {
    expect(parseSemVer(value)).toBeNull();
  });

  it('compares prerelease and release using SemVer precedence', () => {
    expect(compareSemVer('1.0.0-alpha.2', '1.0.0-alpha.10')).toBeLessThan(0);
    expect(compareSemVer('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemVer('1.0.0+one', '1.0.0+two')).toBe(0);
  });

  it('allows only a strictly higher new version', () => {
    expect(isHigherSemVer('1.1.0', '1.0.9')).toBe(true);
    expect(isHigherSemVer('1.0.0', '1.0.0')).toBe(false);
    expect(isHigherSemVer('0.9.9', '1.0.0')).toBe(false);
  });
});
