import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Mate Agent source-run branding', () => {
  it('migrates Electron.app and legacy Orkas.app to Mate Agent.app', () => {
    const source = read('scripts/ensure-deps.cjs');
    expect(source).toContain("const legacyApp = path.join(distDir, 'Orkas.app');");
    expect(source).toContain("const brandedApp = path.join(distDir, `${APP_NAME}.app`);");
    expect(source).toContain("`${APP_NAME}.app/Contents/MacOS/Electron`");
    expect(source).toContain("['CFBundleIdentifier', APP_ID]");
  });

  it('retains the legacy source protocol patcher but launchers do not invoke it', () => {
    const source = read('scripts/prepare-source-protocol.cjs');
    expect(source).toContain("const brand = require('../src/resources/brand.json');");
    expect(source).toContain('CFBundleURLSchemes: [brand.protocolScheme, brand.legacyConnectorScheme]');
    expect(source).toContain("CFBundleURLName: 'com.mateagent.connectors'");
    expect(read('run.sh')).not.toContain('prepare-source-protocol.cjs');
    expect(read('run.cmd')).not.toContain('prepare-source-protocol.cjs');
  });

  it('launches the renamed macOS bundle', () => {
    const source = read('run.sh');
    expect(source).toContain('Mate Agent.app');
    expect(source).not.toContain('APP_BUNDLE="$APP_DIR/node_modules/electron/dist/Orkas.app"');
  });
  it('uses Mate Agent in cross-platform launcher output', () => {
    const cmd = read('run.cmd');
    const ensureDeps = read('scripts/ensure-deps.cjs');
    expect(cmd).not.toContain('[Orkas]');
    expect(cmd).not.toContain('Starting Orkas');
    expect(ensureDeps).not.toContain('rerun Orkas');
  });

});
