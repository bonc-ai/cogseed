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
    expect(RELEASE_API_BASE).toBe('https://hub.example.com');
    expect(requireCogSeedApiBase({ COGSEED_BUILD_CHANNEL: 'release' } as NodeJS.ProcessEnv))
      .toBe('https://hub.example.com');
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

  // 打包产物拿到真实服务地址的唯一通道：源码树只保留开源占位符，
  // 真实 origin 由打包环节写进 .build/build-info.json。
  it('uses the origin baked in at package time for release builds', () => {
    expect(resolveCogSeedApiBase(undefined, 'release', 'https://hub.example.test/'))
      .toBe('https://hub.example.test');
  });

  it('keeps the env override ahead of the packaged origin', () => {
    expect(resolveCogSeedApiBase('https://override.example.test', 'release', 'https://hub.example.test'))
      .toBe('https://override.example.test');
  });

  it('ignores the packaged origin outside the release channel', () => {
    // packaged-dev 固定指向本机验收服务，dev/unknown 走本地后端；
    // 注入值不得把这两个通道也带走。
    expect(resolveCogSeedApiBase(undefined, 'packaged-dev', 'https://hub.example.test'))
      .toBe(PACKAGED_DEV_API_BASE);
    expect(resolveCogSeedApiBase(undefined, 'dev', 'https://hub.example.test'))
      .toBe(DEFAULT_API_BASE);
  });

  it.each([
    'http://hub.example.test',
    'https://user:pass@hub.example.test',
    'https://hub.example.test/?query=1',
    'https://hub.example.test/#fragment',
    'not-a-url',
  ])('falls back to the placeholder when the packaged origin is unusable: %s', (value) => {
    // 打包环节对同样的规则直接失败；运行期只是最后一道防线——
    // 宁可回落占位符，也不能让应用启动即崩溃。
    expect(resolveCogSeedApiBase(undefined, 'release', value)).toBe(RELEASE_API_BASE);
  });
});
