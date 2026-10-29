import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('CogSeed source-run branding', () => {
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

  it('launches the prepared integration-specific macOS bundle', () => {
    // 启动逻辑收口到共享脚本：变体名由 source-launch.cjs 解析，bundle 路径随之拼装。
    const source = read('run.sh');
    const launch = read('scripts/lib/source-launch.sh');
    expect(source).toContain('scripts/lib/source-launch.sh');
    expect(launch).toContain('APP_NAME="${LAUNCH_FIELDS[1]}"');
    expect(launch).toContain('APP_BUNDLE="$APP_DIR/node_modules/electron/dist/$APP_NAME.app"');
  });

  it('uses CogSeed in cross-platform launcher output', () => {
    const cmd = read('run.cmd');
    const ensureDeps = read('scripts/ensure-deps.cjs');
    expect(cmd).toContain('[CogSeed]');
    expect(cmd).toContain('Starting source runtime');
    expect(ensureDeps).toContain('CogSeed');
  });
});
