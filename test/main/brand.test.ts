import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('CogSeed brand contract', () => {
  it('defines the approved public identity', () => {
    expect(readJson('src/resources/brand.json')).toEqual({
      appName: 'CogSeed',
      zhName: 'CogSeed',
      appId: 'com.cogseed.desktop',
      protocolScheme: 'cogseed',
      taglineZh: '跨 Agent 的个人能力资产层',
    });
  });

  it('keeps electron-builder identity aligned with the contract', () => {
    const brand = readJson('src/resources/brand.json');
    const pkg = readJson('package.json');
    expect(pkg.description).toContain('CogSeed');
    expect(pkg.build.productName).toBe(brand.appName);
    expect(pkg.build.appId).toBe(brand.appId);
    expect(pkg.build.artifactName).toBe('CogSeed-${version}-${os}-${arch}.${ext}');
    expect(pkg.build.protocols).toEqual([
      expect.objectContaining({ name: 'CogSeed Connector Callback', schemes: [brand.protocolScheme] }),
    ]);
    expect(pkg.build.files).toContain('src/resources/brand.json');
  });

  it('uses only canonical CogSeed storage and bridge identifiers', () => {
    expect(read('src/main/paths.ts')).toContain('COGSEED_WORKSPACE_ROOT');
    expect(read('src/main/preload.js')).toContain('cogseed');
    expect(read('src/main/install-data-root.cjs')).toContain("'.cogseed'");
  });

  it('uses the shared App ID for system notification settings', () => {
    const source = read('src/main/features/notification_permissions.ts');
    expect(source).toContain("import { APP_BRAND } from '../brand';");
    expect(source).toContain('return APP_BRAND.appId;');
  });

  it('exposes CogSeed in public product surfaces', () => {
    for (const file of [
      'src/renderer/index.html',
      'src/renderer/locales/zh.json',
      'src/renderer/locales/en.json',
      'src/renderer/locales/ja.json',
      'src/renderer/locales/pt.json',
      'src/main/data/commander.json',
      'src/main/data/oss-projects.json',
    ]) {
      expect(read(file), file).toContain('CogSeed');
    }
  });

  it('exposes exactly one renderer bridge', () => {
    const preload = read('src/main/preload.js');
    expect(preload.match(/exposeInMainWorld\('cogseed'/g)).toHaveLength(1);
    expect(read('src/renderer/modules/ipc-shim.js')).toContain('window.cogseed');
    expect(read('src/renderer/modules/artifact-security.js')).toContain('CogSeedArtifactSecurity');
  });
});
