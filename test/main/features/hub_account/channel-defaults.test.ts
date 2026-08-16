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
    expect(resolveHubApiBase(undefined, 'release')).toBe(RELEASE_HUB_API_BASE);
  });

  it('prefers the environment override over channel defaults', () => {
    expect(resolveHubApiBase('http://override.test', 'release')).toBe('http://override.test');
    expect(resolveHubApiBase('  http://padded.test  ', 'packaged-dev')).toBe('http://padded.test');
    expect(resolveHubApiBase('', 'release')).toBe(RELEASE_HUB_API_BASE);
  });

  it('enables the release gate only for packaged-dev builds', () => {
    expect(hubReleaseDefaultEnabled('packaged-dev')).toBe(true);
    expect(hubReleaseDefaultEnabled('dev')).toBe(false);
    expect(hubReleaseDefaultEnabled('release')).toBe(false);
    expect(hubReleaseDefaultEnabled('unknown')).toBe(false);
  });
});
