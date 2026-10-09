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
    expect(identity).toEqual({
      channel: 'dev',
      commit: 'abcdef123456',
      dirty: true,
      builtAt: '2026-07-30T10:00:00.000Z',
      hubApiBase: '',
    });
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
      channel: 'unknown', commit: '', dirty: null, builtAt: '', hubApiBase: '',
    });
    expect(resolveBuildIdentity({ env: {}, packagedInfoPath: '/missing', readFile: () => { throw new Error('missing'); } })).toEqual({
      channel: 'unknown', commit: '', dirty: null, builtAt: '', hubApiBase: '',
    });
  });

  it('reads the build-time injected service origin from packaged build-info', () => {
    // 源码树只带开源占位符；真实地址由打包环节写进 build-info.json，
    // 这是打包产物拿到服务地址的唯一通道（双击启动的 .app 不继承环境变量）。
    const identity = resolveBuildIdentity({
      env: {},
      packagedInfoPath: '/pack/build-info.json',
      readFile: () => JSON.stringify({
        channel: 'release',
        commit: '242541ba27f0',
        builtAt: '2026-07-30T11:00:00.000Z',
        hubApiBase: 'https://hub.example.test',
      }),
    });
    expect(identity.hubApiBase).toBe('https://hub.example.test');
  });

  it('reports an empty injected origin when the build carried none', () => {
    // 源码运行（run.sh 导出了 COGSEED_BUILD_*）时不存在注入值，
    // 调用方应回落到各自的通道默认值。
    const identity = resolveBuildIdentity({
      env: { COGSEED_BUILD_CHANNEL: 'dev' },
      packagedInfoPath: '/pack/build-info.json',
      readFile: () => JSON.stringify({ channel: 'release', hubApiBase: 'https://hub.example.test' }),
    });
    expect(identity.hubApiBase).toBe('');
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
