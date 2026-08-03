import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Mate Agent source-run branding', () => {
  it('prepares one variant-specific macOS bundle after dependency repair', () => {
    const source = read('scripts/prepare-source-runtime.cjs');
    expect(source).toContain('CFBundleIdentifier');
    expect(source).toContain('CFBundleName');
    expect(source).toContain('CFBundleDisplayName');
    expect(source).toContain('`${brand.appId}.source.${value}`');
    expect(source).toContain('`${brand.appName} [${LABELS[value]}]`');
    expect(source).toContain('CFBundleURLSchemes: schemes');
    expect(read('run.sh')).toContain('scripts/prepare-source-runtime.cjs');
    expect(read('run.cmd')).toContain('scripts\\prepare-source-runtime.cjs');
    expect(fs.existsSync(path.join(root, 'scripts/prepare-source-protocol.cjs'))).toBe(false);
  });

  it('launches the prepared variant-specific macOS bundle', () => {
    const source = read('run.sh');
    expect(source).toContain('Mate Agent [$VARIANT_LABEL].app');
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
