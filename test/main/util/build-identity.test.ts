import { describe, expect, it, vi } from 'vitest';
import {
  formatBuildIdentityLabel,
  resolveBuildIdentity,
} from '../../../src/main/util/build-identity';

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: () => '/app.asar' },
}));

vi.mock('electron', () => ({ app: electronMock.app }));

describe('build identity', () => {
  it('prefers launch environment values over packaged metadata', () => {
    const identity = resolveBuildIdentity({
      env: {
        COGSEED_BUILD_CHANNEL: 'dev',
        COGSEED_BUILD_COMMIT: 'abcdef123456',
        COGSEED_BUILD_DIRTY: '1',
        COGSEED_BUILD_TIME: '2026-07-30T10:00:00.000Z',
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

  it('falls back to the packaged package.json cogseedBuildChannel when build-info is absent (self-built bundles)', () => {
    // 源码用户自行 electron-builder 打包时不会写 .build/build-info.json；
    // 渠道应能从包内 package.json 的 extraMetadata 注入字段兜底解析，
    // 否则更新/市场等请求会落回 localhost:3000。
    const identity = resolveBuildIdentity({
      env: {},
      readFile: (filePath) => {
        if (String(filePath).endsWith('build-info.json')) throw new Error('missing build-info');
        if (String(filePath).endsWith('package.json')) {
          return JSON.stringify({ name: 'cogseed', cogseedBuildChannel: 'release' });
        }
        throw new Error(`unexpected read: ${String(filePath)}`);
      },
    });
    expect(identity.channel).toBe('release');
    expect(formatBuildIdentityLabel('0.6.0', identity)).toBe('v0.6.0');
  });
});
