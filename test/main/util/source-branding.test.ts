import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('messaging source branding', () => {
  it('retains the legacy Electron bundle migration before preparing the isolated runtime', () => {
    const source = read('scripts/ensure-deps.cjs');
    expect(source).toContain("const legacyApp = path.join(distDir, 'Orkas.app');");
    expect(source).toContain("const brandedApp = path.join(distDir, `${APP_NAME}.app`);");
    expect(source).toContain("`${APP_NAME}.app/Contents/MacOS/Electron`");
    expect(source).toContain("['CFBundleIdentifier', APP_ID]");
  });

  it('keeps the connector plist helper available for packaged compatibility', () => {
    const source = read('scripts/prepare-source-protocol.cjs');
    expect(source).toContain("const brand = require('../src/resources/brand.json');");
    expect(source).toContain('CFBundleURLSchemes: [brand.protocolScheme, brand.legacyConnectorScheme]');
    expect(source).toContain("CFBundleURLName: 'com.mateagent.connectors'");
  });

  it('prepares a variant-specific bundle and leaves connector schemes to integration', () => {
    const source = read('scripts/prepare-source-runtime.cjs');
    expect(source).toContain('CFBundleIdentifier');
    expect(source).toContain('CFBundleName');
    expect(source).toContain('CFBundleDisplayName');
    expect(source).toContain('protocolOwner: value === \'integration\'');
    expect(source).toContain('CFBundleURLSchemes: schemes');
    expect(read('run.sh')).toContain('scripts/prepare-source-runtime.cjs');
    expect(read('run.cmd')).toContain('scripts\\prepare-source-runtime.cjs');
    expect(read('src/main/index.ts')).toContain('RUNTIME_IDENTITY.protocolOwner');
  });

  it('uses Mate Agent branding in the cross-platform launcher output', () => {
    const shell = read('run.sh');
    const cmd = read('run.cmd');
    const ensureDeps = read('scripts/ensure-deps.cjs');
    expect(shell).toContain('Mate Agent [Messaging].app');
    expect(shell).not.toContain('APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Orkas.app"');
    expect(cmd).not.toContain('[Orkas]');
    expect(cmd).not.toContain('Starting Orkas');
    expect(ensureDeps).not.toContain('rerun Orkas');
  });
});
