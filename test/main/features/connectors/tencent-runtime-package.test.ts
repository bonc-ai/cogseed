import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const requireCjs = createRequire(import.meta.url);
const { provision, verify, assetFor } = requireCjs('../../../../scripts/fetch-tmeet.cjs');
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmeet-runtime-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('bundled Tencent Meeting runtime gate', () => {
  it('maps macOS and Windows targets to the official native executables', () => {
    expect(assetFor('darwin-arm64').name).toBe('tmeet-macOS-AppleSilicon');
    expect(assetFor('darwin-x64').name).toBe('tmeet-macOS-Intel');
    expect(assetFor('win32-x64').name).toBe('tmeet-Windows-x86_64.exe');
    expect(() => assetFor('win32-arm64')).toThrow(/does not ship/);
  });
  it('fails packaging for absent or corrupt runtime instead of shipping an unusable connector', async () => {
    const root = temp();
    await expect(provision({ root, keys: ['darwin-arm64'], check: true })).rejects.toThrow(/missing or corrupt/);
    fs.writeFileSync(path.join(root, assetFor('darwin-arm64').name), 'not an executable');
    fs.writeFileSync(path.join(root, 'LICENSE'), 'license');
    expect(() => verify(root, 'darwin-arm64')).toThrow(/missing or corrupt/);
  });
  it('rejects an untrusted archive before extracting or replacing files', async () => {
    const root = temp();
    const archive = path.join(root, 'tampered.tgz');
    fs.writeFileSync(archive, 'corrupt');
    await expect(provision({ root, keys: ['win32-x64'], archive })).rejects.toThrow(/integrity mismatch/);
    expect(fs.readdirSync(root)).toEqual(['tampered.tgz']);
  });
});
