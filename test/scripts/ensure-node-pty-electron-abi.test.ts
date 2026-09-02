import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const PREBUILD_DIR = path.join(
  ROOT,
  'node_modules',
  'node-pty',
  'prebuilds',
  `${process.platform}-${process.arch}`,
);
const REBUILD_META = path.join(
  ROOT,
  'node_modules',
  'node-pty',
  'build',
  'Release',
  '.forge-meta',
);

describe('ensure-node-pty-electron-abi', () => {
  it('runs native ABI probes before building the Windows package', () => {
    const packageJson = require('../../package.json') as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['prebuild:win']).toBe(
      'node scripts/ensure-sqlite-electron-abi.mjs && node scripts/ensure-node-pty-electron-abi.mjs',
    );
  });

  it.skipIf(!existsSync(PREBUILD_DIR))('accepts loadable platform prebuilds without compiling node-pty from source', () => {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'ensure-node-pty-electron-abi.mjs'),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });

    expect({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({ status: 0 });
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('Building modules: node-pty');
  }, 70_000);

  it.skipIf(!existsSync(PREBUILD_DIR))('marks a verified prebuild so Electron Builder does not rebuild it', () => {
    const previousMeta = existsSync(REBUILD_META) ? readFileSync(REBUILD_META) : null;
    rmSync(REBUILD_META, { force: true });
    try {
      const result = spawnSync(process.execPath, [
        path.join(ROOT, 'scripts', 'ensure-node-pty-electron-abi.mjs'),
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      const { getAbi } = require('node-abi') as {
        getAbi: (version: string, runtime: string) => string;
      };
      const electronVersion = (require('../../node_modules/electron/package.json') as { version: string }).version;

      expect(result.status).toBe(0);
      expect(readFileSync(REBUILD_META, 'utf8')).toBe(`${process.arch}--${getAbi(electronVersion, 'electron')}`);
    } finally {
      if (previousMeta) writeFileSync(REBUILD_META, previousMeta);
      else rmSync(REBUILD_META, { force: true });
    }
  }, 70_000);
});
