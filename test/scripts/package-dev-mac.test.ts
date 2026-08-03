import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createDevBuilderConfig,
  expectedDevAppPath,
  resolveLocalElectronDist,
} = require('../../scripts/package-dev-mac.cjs');

describe('isolated mac development packaging', () => {
  it('derives a packaged-dev builder config without mutating production config', () => {
    const base = {
      appId: 'com.mateagent.desktop',
      productName: 'Mate Agent',
      protocols: [{ schemes: ['mateagent', 'orkas'] }],
      directories: { output: 'dist' },
      files: ['bootstrap.cjs'],
      extraMetadata: { retained: true },
      mac: { category: 'public.app-category.productivity', target: ['dmg'] },
    };
    const snapshot = structuredClone(base);
    const config = createDevBuilderConfig(base, { channel: 'packaged-dev' }, { electronDist: '/cache/electron.zip' });

    expect(base).toEqual(snapshot);
    expect(config).toMatchObject({
      appId: 'com.mateagent.desktop.dev',
      productName: 'Mate Agent Dev',
      electronDist: '/cache/electron.zip',
      directories: { output: 'dist-dev' },
      extraMetadata: { retained: true, orkasBuildChannel: 'packaged-dev' },
      mac: {
        category: 'public.app-category.productivity',
        forceCodeSigning: false,
        identity: null,
        target: [{ target: 'dir', arch: ['arm64'] }],
      },
    });
    expect(config.protocols).toBeUndefined();
    expect(config.files).toEqual(expect.arrayContaining(['bootstrap.cjs', '.build/build-info.json']));
  });

  it('computes the isolated app bundle path', () => {
    expect(expectedDevAppPath('/repo')).toBe(path.join('/repo', 'dist-dev', 'mac-arm64', 'Mate Agent Dev.app'));
  });

  it('uses a cached Electron zip and rejects a renamed source bundle', () => {
    expect(resolveLocalElectronDist({
      electronVersion: '41.7.1',
      cacheRoot: '/cache',
      exists: (candidate: string) => candidate === '/cache' || candidate === '/cache/hash/electron-v41.7.1-darwin-arm64.zip',
      listDirs: () => ['hash'],
    })).toBe('/cache/hash/electron-v41.7.1-darwin-arm64.zip');
    expect(resolveLocalElectronDist({ electronVersion: '41.7.1', cacheRoot: '/cache', exists: () => false, listDirs: () => [] })).toBe('');
  });
});
