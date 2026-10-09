/**
 * Catalog logic tests: version comparison semantics, release selection, and
 * upsert behaviour. Run with `node --test updates-server/test/` or
 * `npm run test:updates-server`.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { compareVersions } = require('../lib/compare-versions.cjs');
const { selectLatest, releaseToData, upsertRelease, emptyCatalog } = require('../lib/catalog.cjs');

test('compareVersions matches the client comparator semantics', () => {
  assert.equal(compareVersions('0.0.5', '0.0.6'), -1);
  assert.equal(compareVersions('0.0.6', '0.0.5'), 1);
  assert.equal(compareVersions('0.0.6', '0.0.6'), 0);
  // Client-side token semantics: prerelease tokens sort above a bare release
  // (0.0.6 < 0.0.6-beta.1) — the server must agree with the client.
  assert.equal(compareVersions('0.0.6', '0.0.6-beta.1'), -1);
  assert.equal(compareVersions('0.0.6-beta.1', '0.0.6'), 1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('v0.0.7', '0.0.6'), 1);
});

const RELEASES = [
  { version: '0.0.5', platform: 'darwin', arch: 'arm64', file: 'a.dmg' },
  { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'b.dmg' },
  { version: '0.0.6', platform: 'darwin', arch: 'x64', file: 'c.dmg' },
  { version: '0.0.6', platform: 'win32', arch: 'x64', file: 'd.exe' },
  { version: '0.0.7-beta.1', platform: 'darwin', arch: 'arm64', file: 'e.dmg' },
];

test('selectLatest picks the highest version for the caller platform/arch', () => {
  const pick = (opts) => selectLatest({ releases: RELEASES, ...opts });

  // Highest matching darwin/arm64 release (prerelease counts as newer, same
  // semantics as the client).
  assert.equal(pick({ platform: 'darwin', arch: 'arm64', currentVersion: '0.0.5' }).version, '0.0.7-beta.1');
  assert.equal(pick({ platform: 'darwin', arch: 'x64', currentVersion: '0.0.5' }).version, '0.0.6');
  assert.equal(pick({ platform: 'win32', arch: 'x64', currentVersion: '0.0.5' }).version, '0.0.6');

  // Already on the newest → no update.
  assert.equal(pick({ platform: 'darwin', arch: 'arm64', currentVersion: '0.0.7-beta.1' }), null);
  // Newer release exists for another platform only → no update.
  assert.equal(pick({ platform: 'linux', arch: 'arm64', currentVersion: '0.0.5' }), null);
  // Unknown current version still returns the newest (caller decides).
  assert.equal(pick({ platform: 'darwin', arch: 'arm64', currentVersion: '' }).version, '0.0.7-beta.1');
  // Empty catalog → null.
  assert.equal(selectLatest({ releases: [], platform: 'darwin', arch: 'arm64', currentVersion: '0.0.5' }), null);
  // Missing platform/arch filters match anything.
  const any = selectLatest({ releases: [{ version: '0.0.6', file: 'f.dmg' }], currentVersion: '0.0.5' });
  assert.equal(any.version, '0.0.6');
});

test('selectLatest filters by ext and excludeExt (feed vs reminder channels)', () => {
  const pair = [
    { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'CogSeed-0.0.6-mac-arm64.dmg' },
    { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'CogSeed-0.0.6-mac-arm64.zip' },
    { version: '0.0.7', platform: 'darwin', arch: 'arm64', file: 'CogSeed-0.0.7-mac-arm64.zip' },
  ];

  // ext: only the newest zip (auto-update feed).
  const zip = selectLatest({ releases: pair, platform: 'darwin', arch: 'arm64', ext: '.zip' });
  assert.equal(zip.version, '0.0.7');
  assert.equal(zip.file, 'CogSeed-0.0.7-mac-arm64.zip');

  // excludeExt: zip never leaks into the v1 reminder channel, even when a
  // newer zip exists — the newest installer dmg wins.
  const dmg = selectLatest({ releases: pair, platform: 'darwin', arch: 'arm64', currentVersion: '0.0.5', excludeExt: '.zip' });
  assert.equal(dmg.version, '0.0.6');
  assert.equal(dmg.file, 'CogSeed-0.0.6-mac-arm64.dmg');

  // No zip for the platform → null.
  assert.equal(selectLatest({ releases: pair, platform: 'linux', arch: 'x64', ext: '.zip' }), null);
});

test('upsertRelease keeps dmg and zip of the same release as separate entries', () => {
  let catalog = upsertRelease(emptyCatalog(), { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'a.dmg', sha256: 'dmg-sha' });
  catalog = upsertRelease(catalog, { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'a.zip', sha256: 'zip-sha' });
  assert.equal(catalog.releases.length, 2);

  // Re-publishing the same extension still replaces in place.
  catalog = upsertRelease(catalog, { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'b.zip', sha256: 'zip-sha-v2' });
  assert.equal(catalog.releases.length, 2);
  const files = catalog.releases.map((r) => r.file).sort();
  assert.deepEqual(files, ['a.dmg', 'b.zip']);
});

test('releaseToData builds the client payload with https download url', () => {
  const data = releaseToData({
    version: '0.0.6',
    platform: 'darwin',
    arch: 'arm64',
    file: 'CogSeed-0.0.6-mac-arm64.dmg',
    sha256: 'abc',
    size: 1024,
    notes: 'notes',
    released_at: '2026-08-21T00:00:00Z',
    mandatory: true,
  }, 'https://updates.example.com');
  assert.deepEqual(data, {
    latest_version: '0.0.6',
    url: 'https://updates.example.com/downloads/CogSeed-0.0.6-mac-arm64.dmg',
    sha256: 'abc',
    size: 1024,
    notes: 'notes',
    released_at: '2026-08-21T00:00:00Z',
    mandatory: true,
  });

  // Optional fields omitted.
  const minimal = releaseToData({ version: '0.0.6', file: 'x.dmg', sha256: 'abc' }, 'https://updates.example.com');
  assert.deepEqual(minimal, {
    latest_version: '0.0.6',
    url: 'https://updates.example.com/downloads/x.dmg',
    sha256: 'abc',
  });
});

test('upsertRelease adds new entries and replaces same version+platform+arch', () => {
  const first = upsertRelease(emptyCatalog(), { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'a.dmg' });
  assert.equal(first.releases.length, 1);

  // Same key → replace (e.g. re-published fixed dmg).
  const replaced = upsertRelease(first, { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'b.dmg', sha256: 'new' });
  assert.equal(replaced.releases.length, 1);
  assert.equal(replaced.releases[0].file, 'b.dmg');

  // Different arch or platform → separate entries.
  const withX64 = upsertRelease(replaced, { version: '0.0.6', platform: 'darwin', arch: 'x64', file: 'c.dmg' });
  assert.equal(withX64.releases.length, 2);
  const withWin = upsertRelease(withX64, { version: '0.0.6', platform: 'win32', arch: 'x64', file: 'd.exe' });
  assert.equal(withWin.releases.length, 3);

  // New version → additional entry.
  const withNext = upsertRelease(withWin, { version: '0.0.7', platform: 'darwin', arch: 'arm64', file: 'e.dmg' });
  assert.equal(withNext.releases.length, 4);
});
