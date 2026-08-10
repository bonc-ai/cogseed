import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('CogSeed brand contract', () => {
  it('defines the approved public identity', () => {
    const brand = readJson('src/resources/brand.json');
    expect(brand).toEqual({
      appName: 'CogSeed',
      zhName: 'CogSeed',
      appId: 'com.cogseed.desktop',
      protocolScheme: 'cogseed',
      legacyConnectorSchemes: ['mateagent', 'orkas'],
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
      expect.objectContaining({
        name: 'CogSeed Connector Callback',
        schemes: [brand.protocolScheme, ...brand.legacyConnectorSchemes],
      }),
    ]);
    expect(pkg.build.files).toContain('src/resources/brand.json');
  });

  it('does not rename compatibility storage and bridge identifiers', () => {
    expect(read('src/main/paths.ts')).toContain('ORKAS_WORKSPACE_ROOT');
    expect(read('src/main/preload.js')).toContain('orkas');
    expect(read('src/main/install-data-root.cjs')).toContain("'.orkas'");
  });
  it('uses an isolated runtime identity in the Electron main process', () => {
    const main = read('src/main/index.ts');
    expect(main).toContain("import { resolveRuntimeIdentity } from './brand';");
    expect(main).toContain('app.setName(RUNTIME_IDENTITY.appName);');
    expect(main).toContain('app.setAppUserModelId(RUNTIME_IDENTITY.appId);');
    expect(main).not.toContain("const APP_USER_MODEL_ID = 'com.orkas.desktop'");
  });

  it('uses the shared App ID for system notification settings', () => {
    const source = read('src/main/features/notification_permissions.ts');
    expect(source).toContain("import { APP_BRAND } from '../brand';");
    expect(source).toContain('return APP_BRAND.appId;');
    expect(source).not.toContain("return 'com.orkas.desktop';");
  });

  it('removes Orkas from user-visible product surfaces', () => {
    const publicFiles = [
      'src/renderer/index.html',
      'src/renderer/locales/zh.json',
      'src/renderer/locales/en.json',
      'src/renderer/locales/ja.json',
      'src/renderer/locales/pt.json',
      'src/main/data/commander.json',
      'src/main/data/oss-projects.json',
    ];
    for (const file of publicFiles) {
      expect(read(file), file).not.toContain('Orkas');
    }
    expect(read('src/renderer/modules/settings.js')).not.toContain("badge.textContent = 'Orkas'");
  });

  it('removes the retired Mate Agent name from current public surfaces', () => {
    const publicFiles = [
      'src/renderer/index.html',
      'src/renderer/locales/zh.json',
      'src/renderer/locales/en.json',
      'src/renderer/locales/ja.json',
      'src/renderer/locales/pt.json',
      'src/main/data/commander.json',
      'src/main/data/oss-projects.json',
    ];
    for (const file of publicFiles) {
      expect(read(file), file).not.toContain('Mate Agent');
      expect(read(file), file).not.toContain('Mate 智伴');
    }
  });

  it('keeps approved internal compatibility symbols', () => {
    expect(read('src/main/preload.js')).toContain("contextBridge.exposeInMainWorld('orkas'");
    expect(read('src/renderer/modules/ipc-shim.js')).toContain('window.cogseed');
    expect(read('src/renderer/modules/artifact-security.js')).toContain('OrkasArtifactSecurity');
  });

});
