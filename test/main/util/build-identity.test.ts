import { describe, expect, it } from 'vitest';
import {
  formatBuildIdentityLabel,
  resolveBuildIdentity,
} from '../../../src/main/util/build-identity';

describe('build identity', () => {
  it('prefers launch environment values over packaged metadata', () => {
    const identity = resolveBuildIdentity({
      env: {
        ORKAS_BUILD_CHANNEL: 'dev',
        ORKAS_BUILD_COMMIT: 'abcdef123456',
        ORKAS_BUILD_DIRTY: '1',
        ORKAS_BUILD_TIME: '2026-07-30T10:00:00.000Z',
      },
      packagedInfoPath: '/pack/build-info.json',
      readFile: () => JSON.stringify({ channel: 'release', commit: 'ignored' }),
    });
    expect(identity).toEqual({ channel: 'dev', commit: 'abcdef123456', dirty: true, builtAt: '2026-07-30T10:00:00.000Z' });
    expect(formatBuildIdentityLabel('2026.7.21', identity)).toBe('v2026.7.21 · dev · abcdef1-dirty');
  });

  it('falls back to packaged build-info and release labels stay compact', () => {
    const identity = resolveBuildIdentity({
      env: {}, packagedInfoPath: '/pack/build-info.json',
      readFile: () => JSON.stringify({ channel: 'packaged-dev', commit: '242541ba27f0', dirty: false, builtAt: '2026-07-30T11:00:00.000Z' }),
    });
    expect(identity.channel).toBe('packaged-dev');
    expect(formatBuildIdentityLabel('2026.7.21', identity)).toBe('v2026.7.21 · packaged-dev · 242541b');
    expect(formatBuildIdentityLabel('2026.7.21', { ...identity, channel: 'release' })).toBe('v2026.7.21');
  });

  it('degrades malformed or missing metadata to unknown without throwing', () => {
    expect(resolveBuildIdentity({ env: {}, packagedInfoPath: '/bad', readFile: () => '{bad' })).toEqual({
      channel: 'unknown', commit: '', dirty: null, builtAt: '',
    });
    expect(resolveBuildIdentity({ env: {}, packagedInfoPath: '/missing', readFile: () => { throw new Error('missing'); } })).toEqual({
      channel: 'unknown', commit: '', dirty: null, builtAt: '',
    });
  });
});
