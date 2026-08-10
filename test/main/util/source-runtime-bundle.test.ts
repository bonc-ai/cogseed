import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const mutableFs = require('node:fs') as typeof fs;
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
  copyRuntimeBundle(source: string, destination: string): void;
  parseVariant(argv: readonly string[]): string;
  parseMateWorktreeVariant(argv: readonly string[]): string;
};

const temporaryRoots: string[] = [];
const ELECTRON_VERSION = '41.7.1';
const REQUIRED_RUNTIME_EXECUTABLES = [
  path.join('Contents', 'MacOS', 'Electron'),
  path.join('Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
  path.join('Contents', 'Frameworks', 'Electron Helper.app', 'Contents', 'MacOS', 'Electron Helper'),
  path.join('Contents', 'Frameworks', 'Electron Helper (GPU).app', 'Contents', 'MacOS', 'Electron Helper (GPU)'),
  path.join('Contents', 'Frameworks', 'Electron Helper (Plugin).app', 'Contents', 'MacOS', 'Electron Helper (Plugin)'),
  path.join('Contents', 'Frameworks', 'Electron Helper (Renderer).app', 'Contents', 'MacOS', 'Electron Helper (Renderer)'),
] as const;

function createCurrentBundleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-bundle-'));
  temporaryRoots.push(root);
  const destination = path.join(root, 'CogSeed.app');
  const identity = sourceRuntime.sourceRuntimeBundleSpec('mate');

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
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('macOS source runtime bundle contract', () => {
  it('assigns unique bundle names and identifiers to every source variant', () => {
    const variants = ['main', 'cognition', 'expense', 'mate', 'optimization'];
    const specs = variants.map((variant) => sourceRuntime.sourceRuntimeBundleSpec(variant));

    expect(new Set(specs.map((spec) => spec.appName)).size).toBe(variants.length);
    expect(new Set(specs.map((spec) => spec.appId)).size).toBe(variants.length);
    expect(specs.map((spec) => spec.appId)).toEqual([
      'com.mateagent.desktop.source.main',
      'com.mateagent.desktop.source.cognition',
      'com.mateagent.desktop.source.expense',
      'com.mateagent.desktop.source.mate',
      'com.mateagent.desktop.source.optimization',
    ]);
  });

  it('declares connector schemes only for mate', () => {
    for (const variant of ['main', 'cognition', 'expense', 'optimization']) {
      expect(sourceRuntime.sourceRuntimeBundleSpec(variant).protocolSchemes).toEqual([]);
    }
    expect(sourceRuntime.sourceRuntimeBundleSpec('mate').protocolSchemes)
      .toEqual(['mateagent', 'orkas']);
  });

  it('preserves relative framework symlinks when copying the Electron app', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-copy-'));
    temporaryRoots.push(root);
    const distDir = path.join(root, 'dist');
    const source = path.join(distDir, 'Electron.app');
    const destination = path.join(distDir, 'CogSeed.app');
    const frameworkVersions = path.join(
      source,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
    );
    fs.mkdirSync(path.join(source, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(frameworkVersions, 'A'), { recursive: true });
    fs.writeFileSync(path.join(source, 'Contents', 'MacOS', 'Electron'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(frameworkVersions, 'A', 'Electron Framework'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync('A', path.join(frameworkVersions, 'Current'));
    fs.symlinkSync(
      path.join('Versions', 'Current', 'Electron Framework'),
      path.join(source, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
    );
    for (const helper of ['Electron Helper', 'Electron Helper (GPU)', 'Electron Helper (Plugin)', 'Electron Helper (Renderer)']) {
      const executable = path.join(source, 'Contents', 'Frameworks', `${helper}.app`, 'Contents', 'MacOS', helper);
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
    }
    sourceRuntime.copyRuntimeBundle(source, destination);
    const copiedLink = path.join(
      destination,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'Current',
    );
    expect(fs.readlinkSync(copiedLink)).toBe('A');
    fs.rmSync(source, { recursive: true, force: true });
    expect(fs.statSync(path.join(copiedLink, 'Electron Framework')).isFile()).toBe(true);
  });

  it('removes a partial destination when runtime copying fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-copy-failure-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'missing.app');
    const destination = path.join(root, 'CogSeed.app');
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'partial'), 'stale', 'utf8');

    expect(() => sourceRuntime.copyRuntimeBundle(source, destination)).toThrow();
    expect(fs.existsSync(destination)).toBe(false);
  });

  it('preserves both the copy and cleanup errors when fail-closed cleanup fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-copy-cleanup-failure-'));
    temporaryRoots.push(root);
    const source = path.join(root, 'missing.app');
    const destination = path.join(root, 'CogSeed.app');
    fs.mkdirSync(destination);
    const cleanupError = new Error('simulated cleanup failure');
    const realRmSync = mutableFs.rmSync.bind(mutableFs);
    vi.spyOn(mutableFs, 'rmSync').mockImplementation((target, options) => {
      if (path.resolve(String(target)) === destination) throw cleanupError;
      return realRmSync(target, options);
    });

    let thrown: unknown;
    try {
      sourceRuntime.copyRuntimeBundle(source, destination);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.message).toContain('cleanup failed');
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toMatchObject({ code: 'ENOENT' });
    expect(aggregate.errors[1]).toBe(cleanupError);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
  });

  it('requires exactly one canonical, case-sensitive preparation variant', () => {
    expect(sourceRuntime.parseVariant(['--variant=mate'])).toBe('mate');
    expect(sourceRuntime.parseVariant(['--variant', 'cognition'])).toBe('cognition');
    expect(() => sourceRuntime.parseVariant([])).toThrow('exactly one');
    expect(() => sourceRuntime.parseVariant(['--variant=Mate'])).toThrow('invalid');
    expect(() => sourceRuntime.parseVariant(['--variant=main', '--variant=mate']))
      .toThrow('exactly one');
  });

  it('locks the executable bundle-preparation entry to mate', () => {
    expect(sourceRuntime.parseMateWorktreeVariant(['--variant=mate']))
      .toBe('mate');
    expect(() => sourceRuntime.parseMateWorktreeVariant(['--variant=cognition']))
      .toThrow('locked to the mate runtime');
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

  it.runIf(process.platform === 'darwin')('rejects framework executables that resolve outside the bundle', () => {
    const fixture = createCurrentBundleFixture();
    const framework = path.join(
      fixture.destination,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Electron Framework',
    );
    fs.rmSync(framework);
    fs.symlinkSync('/bin/sh', framework);

    expect(sourceRuntime.bundleIsCurrent(fixture.destination, fixture.identity, ELECTRON_VERSION)).toBe(false);
  });

  it.runIf(process.platform === 'darwin').each([
    'Electron Helper',
    'Electron Helper (GPU)',
    'Electron Helper (Plugin)',
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
