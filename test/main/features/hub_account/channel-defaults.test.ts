import { describe, it, expect, vi } from 'vitest';

// gate.ts 的模块级 clientConfig.registerDefault 需要轻量替身，
// 避免拉入 system_info/electron 等运行时依赖。
vi.mock('../../../../src/main/features/client_config', () => ({
  clientConfig: {
    registerDefault: vi.fn(),
    get: () => undefined,
  },
}));

import {
  resolveHubApiBase,
  DEFAULT_HUB_API_BASE,
  PACKAGED_DEV_HUB_API_BASE,
  RELEASE_HUB_API_BASE,
} from '../../../../src/main/features/hub_account/client';
import { hubReleaseDefaultEnabled } from '../../../../src/main/features/hub_account/gate';

describe('hub channel-aware defaults', () => {
  it('resolves API base per channel', () => {
    expect(resolveHubApiBase(undefined, 'dev')).toBe(DEFAULT_HUB_API_BASE);
    expect(resolveHubApiBase(undefined, 'unknown')).toBe(DEFAULT_HUB_API_BASE);
    expect(resolveHubApiBase(undefined, 'packaged-dev')).toBe(PACKAGED_DEV_HUB_API_BASE);
    expect(resolveHubApiBase(undefined, 'packaged-dev')).toBe('http://127.0.0.1:4180');
    expect(resolveHubApiBase(undefined, 'release')).toBe(RELEASE_HUB_API_BASE);
    expect(resolveHubApiBase(undefined, 'release')).toBe('https://hub.example.com');
  });

  it('prefers the environment override over channel defaults', () => {
    expect(resolveHubApiBase('http://override.test', 'release')).toBe('http://override.test');
    expect(resolveHubApiBase('  http://padded.test  ', 'packaged-dev')).toBe('http://padded.test');
    expect(resolveHubApiBase('', 'release')).toBe(RELEASE_HUB_API_BASE);
  });

  // 打包产物拿到真实 Hub 地址的唯一通道（见 docs/release-scan-remediation-20260923.md #5）。
  it('uses the origin baked in at package time for release builds', () => {
    expect(resolveHubApiBase(undefined, 'release', 'https://hub.example.test/'))
      .toBe('https://hub.example.test');
  });

  it('keeps the env override ahead of the packaged origin', () => {
    expect(resolveHubApiBase('https://override.test', 'release', 'https://hub.example.test'))
      .toBe('https://override.test');
  });

  it('ignores the packaged origin outside the release channel', () => {
    // packaged-dev 的验收包必须继续指向本机 Hub 测试服务。
    expect(resolveHubApiBase(undefined, 'packaged-dev', 'https://hub.example.test'))
      .toBe(PACKAGED_DEV_HUB_API_BASE);
    expect(resolveHubApiBase(undefined, 'dev', 'https://hub.example.test'))
      .toBe(DEFAULT_HUB_API_BASE);
  });

  it.each([
    'http://hub.example.test',
    'https://user:pass@hub.example.test',
    'https://hub.example.test/?query=1',
    'https://hub.example.test/#fragment',
    'not-a-url',
  ])('falls back to the placeholder when the packaged origin is unusable: %s', (value) => {
    expect(resolveHubApiBase(undefined, 'release', value)).toBe(RELEASE_HUB_API_BASE);
  });

  it('enables the release gate by default for every channel', () => {
    expect(hubReleaseDefaultEnabled('packaged-dev')).toBe(true);
    expect(hubReleaseDefaultEnabled('dev')).toBe(true);
    expect(hubReleaseDefaultEnabled('release')).toBe(true);
    expect(hubReleaseDefaultEnabled('unknown')).toBe(true);
  });
});
