import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { verifyPackagedDevBundle, verifySmokeMarker } = require('../../scripts/verify-packaged-dev.cjs');
const roots: string[] = [];
function fakeBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-agent-dev-bundle-'));
  roots.push(root);
  const appPath = path.join(root, 'Mate Agent Dev.app');
  const resources = path.join(appPath, 'Contents', 'Resources');
  fs.mkdirSync(path.join(resources, 'builtin'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'officecli'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'packages', 'nseap-meta-skill-engine', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'fake');
  fs.writeFileSync(path.join(resources, 'builtin', '_manifest.json'), '{}');
  fs.writeFileSync(path.join(resources, 'runtime', 'manifest.json'), '{}');
  fs.writeFileSync(path.join(resources, 'officecli', 'officecli-mac-arm64'), '');
  fs.writeFileSync(path.join(resources, 'packages', 'nseap-meta-skill-engine', 'dist', 'index.js'), '');
  return appPath;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('packaged-dev verifier', () => {
  it('accepts a bundle containing identity, provider UI, builtin, runtime, OfficeCLI, and engine resources', () => {
    const appPath = fakeBundle();
    const result = verifyPackagedDevBundle(appPath, {
      listAsar: () => [
        '/package.json', '/bootstrap.cjs', '/.build/build-info.json',
        '/src/main/index.ts', '/src/renderer/modules/agents.js',
      ],
      readAsarFile: () => Buffer.from(JSON.stringify({ channel: 'packaged-dev', commit: 'abc123', dirty: false })),
      exists: (candidate: string) => candidate.endsWith('app.asar') || fs.existsSync(candidate),
    });
    expect(result.ok).toBe(true);
    expect(result.identity).toMatchObject({ channel: 'packaged-dev', commit: 'abc123' });
  });

  it('reports all missing bundle contracts instead of failing at the first one', () => {
    const appPath = fakeBundle();
    fs.rmSync(path.join(appPath, 'Contents', 'Resources', 'runtime'), { recursive: true });
    const result = verifyPackagedDevBundle(appPath, {
      listAsar: () => ['/package.json'],
      readAsarFile: () => Buffer.from('{}'),
      exists: (candidate: string) => candidate.endsWith('app.asar') || fs.existsSync(candidate),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('runtime/manifest.json');
    expect(result.errors.join('\n')).toContain('.build/build-info.json');
    expect(result.errors.join('\n')).toContain('src/renderer/modules/agents.js');
    expect(result.errors.join('\n')).toContain('packaged-dev');
  });

  it('validates the packaged launch ready marker', () => {
    expect(verifySmokeMarker({ status: 'ready', appIsPackaged: true, appAsar: true, preloadLoaded: true, rendererLoaded: true, ipcPing: 'pong' })).toEqual([]);
    expect(verifySmokeMarker({ status: 'failed', appIsPackaged: false }).join('\n')).toContain('status=ready');
  });
});
