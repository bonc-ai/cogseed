import { describe, expect, it } from 'vitest';
import {
  DEFAULT_API_BASE,
  PACKAGED_DEV_API_BASE,
  RELEASE_API_BASE,
  requireCogSeedApiBase,
  resolveCogSeedApiBase,
} from '../../../src/main/features/api_base';

describe('CogSeed API base', () => {
  it('prefers an explicit HTTPS env override in every channel', () => {
    expect(requireCogSeedApiBase({
      COGSEED_API_BASE_URL: 'https://api.example.test/root/',
      COGSEED_BUILD_CHANNEL: 'release',
    } as NodeJS.ProcessEnv)).toBe('https://api.example.test/root');
  });

  it('defaults to the production origin for packaged builds', () => {
    expect(resolveCogSeedApiBase(undefined, 'release')).toBe(RELEASE_API_BASE);
    expect(resolveCogSeedApiBase(undefined, 'packaged-dev')).toBe(PACKAGED_DEV_API_BASE);
    expect(RELEASE_API_BASE).toBe('https://cogseed-open.bonc.com.cn');
    expect(requireCogSeedApiBase({ COGSEED_BUILD_CHANNEL: 'release' } as NodeJS.ProcessEnv))
      .toBe('https://cogseed-open.bonc.com.cn');
  });

  it('defaults to the local backend for dev/unknown channels', () => {
    expect(resolveCogSeedApiBase(undefined, 'dev')).toBe(DEFAULT_API_BASE);
    expect(resolveCogSeedApiBase(undefined, 'unknown')).toBe(DEFAULT_API_BASE);
    expect(requireCogSeedApiBase({} as NodeJS.ProcessEnv)).toBe('http://localhost:3000');
  });

  it('an empty env override falls through to the channel default', () => {
    expect(resolveCogSeedApiBase('   ', 'release')).toBe(RELEASE_API_BASE);
  });

  it.each([
    'http://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/path?query=1',
    'https://api.example.test/path#fragment',
  ])('rejects unsafe API base %s', (value) => {
    expect(() => requireCogSeedApiBase({ COGSEED_API_BASE_URL: value } as NodeJS.ProcessEnv))
      .toThrow(/HTTPS origin\/path/);
  });
});
