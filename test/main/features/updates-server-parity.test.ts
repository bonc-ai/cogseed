/**
 * Parity: the updates-server version comparator (updates-server/lib/
 * compare-versions.cjs) must agree with the client-side comparator
 * (src/main/util/app-version-compat.ts) on every ordering — otherwise the
 * server could advertise an "update" the client ignores, or vice versa.
 */

import { describe, expect, it } from 'vitest';

import { compareVersions as clientCompare } from '../../../src/main/util/app-version-compat';
import { compareVersions as serverCompare } from '../../../updates-server/lib/compare-versions.cjs';
import { selectLatest } from '../../../updates-server/lib/catalog.cjs';

const PAIRS: Array<[string, string]> = [
  ['0.0.5', '0.0.6'],
  ['0.0.6', '0.0.5'],
  ['0.0.6', '0.0.6'],
  ['0.0.6', '0.0.6-beta.1'],
  ['0.0.6-beta.1', '0.0.6'],
  ['0.0.6-beta.1', '0.0.6-beta.2'],
  ['1.0.0', '0.9.9'],
  ['0.10.0', '0.9.0'],
  ['v0.0.7', '0.0.6'],
  ['0.0.5', '0.0.5+build.7'],
  ['2.1.0-rc.1', '2.1.0'],
];

describe('updates-server ↔ client version parity', () => {
  it('orders every pair identically', () => {
    for (const [a, b] of PAIRS) {
      const client = Math.sign(clientCompare(a, b));
      const server = Math.sign(serverCompare(a, b));
      expect(server, `${a} vs ${b}`).toBe(client);
    }
  });

  it('matches on the update boundary the client checks (strictly greater)', () => {
    const hasUpdate = (current: string, latest: string) => clientCompare(latest, current) > 0;
    for (const [current, latest] of [['0.0.5', '0.0.6'], ['0.0.6', '0.0.6-beta.1'], ['0.0.6-beta.1', '0.0.6']]) {
      expect(hasUpdate(current, latest)).toBe(serverCompare(latest, current) > 0);
    }
  });
});

/**
 * The server advertises exactly what the client can install. The update channel
 * always declares its platform (`updaterRequestHeaders()` in
 * src/main/features/updater/client.ts), so the catalog must never hand a
 * Windows exe to a mac caller (and vice versa), and the v1 reminder channel
 * must keep serving the installer (never the auto-update zip).
 */
describe('updates-server ↔ client platform selection', () => {
  const MAC_DMG = {
    version: '0.0.6', platform: 'darwin', arch: 'arm64',
    file: 'CogSeed-0.0.6-mac-arm64.dmg', sha256: 'a'.repeat(64), size: 1,
  };
  const WIN_EXE = {
    version: '0.0.6', platform: 'win32', arch: 'x64',
    file: 'CogSeed-0.0.6-win-x64.exe', sha256: 'b'.repeat(64), size: 1,
  };

  it('serves a win32 exe to a win32 caller and never to a darwin caller', () => {
    const releases = [MAC_DMG, WIN_EXE];
    const win = selectLatest({ releases, platform: 'win32', arch: 'x64', currentVersion: '0.0.5' });
    const mac = selectLatest({ releases, platform: 'darwin', arch: 'arm64', currentVersion: '0.0.5' });

    expect(win?.file).toBe('CogSeed-0.0.6-win-x64.exe');
    expect(mac?.file).toBe('CogSeed-0.0.6-mac-arm64.dmg');
  });

  it('keeps the exe visible to the v1 reminder channel', () => {
    const picked = selectLatest({
      releases: [WIN_EXE], platform: 'win32', arch: 'x64', currentVersion: '0.0.5', excludeExt: '.zip',
    });
    expect(picked?.file).toBe('CogSeed-0.0.6-win-x64.exe');
  });

  // Legacy releases predate the `platform` field while the client has always
  // sent the header, so a platform-less record must be matched by file
  // extension for the caller's platform instead of matching every caller.
  const legacy = (file: string, arch: string) => ({ version: '0.0.6', arch, file, sha256: 'c'.repeat(64), size: 1 });

  it('never serves a platform-less dmg to a win32 caller', () => {
    const picked = selectLatest({
      releases: [legacy('CogSeed-0.0.6-mac-arm64.dmg', 'arm64')],
      platform: 'win32', arch: 'arm64', currentVersion: '0.0.5',
    });
    expect(picked).toBeNull();
  });

  it('still serves a platform-less dmg to a darwin caller', () => {
    const picked = selectLatest({
      releases: [legacy('CogSeed-0.0.6-mac-arm64.dmg', 'arm64')],
      platform: 'darwin', arch: 'arm64', currentVersion: '0.0.5',
    });
    expect(picked?.file).toBe('CogSeed-0.0.6-mac-arm64.dmg');
  });

  it('serves a platform-less exe to a win32 caller', () => {
    const picked = selectLatest({
      releases: [legacy('CogSeed-0.0.6-win-x64.exe', 'x64')],
      platform: 'win32', arch: 'x64', currentVersion: '0.0.5',
    });
    expect(picked?.file).toBe('CogSeed-0.0.6-win-x64.exe');
  });

  it('keeps the platform-less fallback for a caller that declares no platform', () => {
    const picked = selectLatest({
      releases: [legacy('CogSeed-0.0.6-mac-arm64.dmg', 'arm64')],
      arch: 'arm64', currentVersion: '0.0.5',
    });
    expect(picked?.file).toBe('CogSeed-0.0.6-mac-arm64.dmg');
  });
});
