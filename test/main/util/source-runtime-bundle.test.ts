import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const sourceRuntime = require('../../../scripts/prepare-source-runtime.cjs') as {
  sourceRuntimeBundleSpec(variant: string): {
    variant: string;
    appName: string;
    appId: string;
    protocolOwner: boolean;
    protocolSchemes: readonly string[];
  };
  currentAppFromPathFile(distDir: string, pathFile: string): string;
  bundleIsCurrent(
    destination: string,
    identity: ReturnType<typeof sourceRuntime.sourceRuntimeBundleSpec>,
    electronVersion: string,
  ): boolean;
  parseVariant(argv: readonly string[]): string;
  parseIntegrationWorktreeVariant(argv: readonly string[]): string;
};

const temporaryRoots: string[] = [];
const ELECTRON_VERSION = '41.7.1';
const REQUIRED_RUNTIME_EXECUTABLES = [
  path.join('Contents', 'MacOS', 'Electron'),
  path.join('Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  path.join('Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper'),
  path.join('Contents', 'Frameworks', 'Electron Helper (GPU).app', 'Contents', 'MacOS', 'Electron Helper (GPU)'),
  path.join('Contents', 'Frameworks', 'Electron Helper (Renderer).app', 'Contents', 'MacOS', 'Electron Helper (Renderer)'),
] as const;

function createCurrentBundleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-bundle-'));
  temporaryRoots.push(root);
  const destination = path.join(root, 'Mate Agent [Integration].app');
  const identity = sourceRuntime.sourceRuntimeBundleSpec('integration');

  for (const relative of REQUIRED_RUNTIME_EXECUTABLES) {
    const executable = path.join(destination, relative);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  fs.writeFileSync(path.join(destination, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${identity.appId}</string>
  <key>CFBundleName</key>
  <string>${identity.appName}</string>
  <key>CFBundleDisplayName</key>
  <string>${identity.appName}</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>com.mateagent.desktop.connectors</string>
      <key>CFBundleURLSchemes</key>
      <array><string>mateagent</string><string>orkas</string></array>
    </dict>
  </array>
</dict>
</plist>
`, 'utf8');
  fs.writeFileSync(`${destination}.runtime.json`, JSON.stringify({
    schema_version: 1,
    variant: identity.variant,
    electron_version: ELECTRON_VERSION,
  }), 'utf8');

  return { destination, identity };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('macOS source runtime bundle contract', () => {
  it('assigns unique bundle names and identifiers to every source variant', () => {
    const variants = ['main', 'cognition', 'expense', 'integration'];
    const specs = variants.map((variant) => sourceRuntime.sourceRuntimeBundleSpec(variant));

    expect(new Set(specs.map((spec) => spec.appName)).size).toBe(variants.length);
    expect(new Set(specs.map((spec) => spec.appId)).size).toBe(variants.length);
    expect(specs.map((spec) => spec.appId)).toEqual([
      'com.mateagent.desktop.source.main',
      'com.mateagent.desktop.source.cognition',
      'com.mateagent.desktop.source.expense',
      'com.mateagent.desktop.source.integration',
    ]);
  });

  it('declares connector schemes only for integration', () => {
    for (const variant of ['main', 'cognition', 'expense']) {
      expect(sourceRuntime.sourceRuntimeBundleSpec(variant).protocolSchemes).toEqual([]);
    }
    expect(sourceRuntime.sourceRuntimeBundleSpec('integration').protocolSchemes)
      .toEqual(['mateagent', 'orkas']);
  });

  it('requires exactly one canonical, case-sensitive preparation variant', () => {
    expect(sourceRuntime.parseVariant(['--variant=integration'])).toBe('integration');
    expect(sourceRuntime.parseVariant(['--variant', 'cognition'])).toBe('cognition');
    expect(() => sourceRuntime.parseVariant([])).toThrow('exactly one');
    expect(() => sourceRuntime.parseVariant(['--variant=Integration'])).toThrow('invalid');
    expect(() => sourceRuntime.parseVariant(['--variant=main', '--variant=integration']))
      .toThrow('exactly one');
  });

  it('locks the executable bundle-preparation entry to integration', () => {
    expect(sourceRuntime.parseIntegrationWorktreeVariant(['--variant=integration']))
      .toBe('integration');
    expect(() => sourceRuntime.parseIntegrationWorktreeVariant(['--variant=cognition']))
      .toThrow('locked to the integration runtime');
  });

  it('rejects a missing path file rather than guessing outside Electron dist', () => {
    const dist = path.resolve('/tmp/electron/dist');
    expect(sourceRuntime.currentAppFromPathFile(dist, '/definitely/missing/path.txt')).toBe('');
  });

  it.runIf(process.platform === 'darwin')('rejects a cached bundle whose primary executable is missing, indirect, or not executable', () => {
    const fixture = createCurrentBundleFixture();
    const executable = path.join(fixture.destination, 'Contents', 'MacOS', 'Electron');
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(true);

    fs.chmodSync(executable, 0o644);
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(false);

    fs.chmodSync(executable, 0o755);
    fs.rmSync(executable);
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(false);

    fs.symlinkSync('/bin/sh', executable);
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(false);
  });

  it.runIf(process.platform === 'darwin')('rejects a cached bundle whose Electron Framework executable is missing', () => {
    const fixture = createCurrentBundleFixture();
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(true);

    fs.rmSync(path.join(
      fixture.destination,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    ));
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(false);
  });

  it.runIf(process.platform === 'darwin').each([
    'Electron Helper',
    'Electron Helper (GPU)',
    'Electron Helper (Renderer)',
  ])('rejects a cached bundle whose %s executable is missing', (helperName) => {
    const fixture = createCurrentBundleFixture();
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(true);

    fs.rmSync(path.join(
      fixture.destination,
      'Contents',
      'Frameworks',
      `${helperName}.app`,
      'Contents',
      'MacOS',
      helperName,
    ));
    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(false);
  });
});
