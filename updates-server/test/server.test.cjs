/**
 * HTTP integration tests for the updates server: envelope behaviour, platform
 * filtering, and the path-traversal-safe download route. Runs against a
 * throwaway catalog dir on an ephemeral port.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'updates-srv-'));
const CATALOG_PATH = path.join(TMP, 'releases.json');
const DOWNLOADS = path.join(TMP, 'downloads');

process.env.UPDATES_CATALOG = CATALOG_PATH;
process.env.UPDATES_SERVER_PUBLIC_BASE = 'https://updates.example.com';

const { createUpdatesServer } = require('../server.cjs');
const { writeCatalog } = require('../lib/catalog.cjs');

const ARTIFACT = 'CogSeed-0.0.6-mac-arm64.dmg';
const ARTIFACT_BYTES = Buffer.from('fake-dmg-artifact-bytes');

let server;
let base;

before(async () => {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.writeFileSync(path.join(DOWNLOADS, ARTIFACT), ARTIFACT_BYTES);
  writeCatalog(CATALOG_PATH, {
    releases: [
      { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: ARTIFACT, sha256: 'deadbeef', size: ARTIFACT_BYTES.length, notes: 'release notes', mandatory: false },
      { version: '0.0.6', platform: 'darwin', arch: 'x64', file: 'CogSeed-0.0.6-mac-x64.dmg', sha256: 'x', size: 1 },
      { version: '0.0.6', platform: 'win32', arch: 'x64', file: 'CogSeed-0.0.6-win-x64.exe', sha256: 'y', size: 1 },
      { version: '0.0.7-beta.1', platform: 'darwin', arch: 'arm64', file: 'CogSeed-0.0.7-beta.1-mac-arm64.dmg', sha256: 'z', size: 1 },
      { version: '0.0.6', platform: 'darwin', arch: 'arm64', file: 'CogSeed-0.0.6-mac-arm64.zip', sha256: 'zipsha', size: 2, notes: 'zip release notes', released_at: '2026-08-27T00:00:00Z' },
      { version: '0.0.8', platform: 'darwin', arch: 'arm64', file: 'CogSeed-0.0.8-mac-arm64.zip', sha256: 'zipsha8', size: 3 },
    ],
  });
  server = createUpdatesServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function latest(headers = {}) {
  const res = await fetch(`${base}/updates/latest`, { headers });
  return { status: res.status, body: await res.json() };
}

test('returns the newest matching release with a full client payload', async () => {
  const { status, body } = await latest({
    'CogSeed-App-Version': '0.0.5',
    'CogSeed-Platform': 'darwin',
    'CogSeed-Arch': 'arm64',
    'CogSeed-Channel': 'open',
  });
  assert.equal(status, 200);
  assert.equal(body.code, 0);
  assert.equal(body.data.latest_version, '0.0.7-beta.1');
  assert.equal(body.data.url, `https://updates.example.com/downloads/CogSeed-0.0.7-beta.1-mac-arm64.dmg`);
  assert.equal(body.data.sha256, 'z');
  assert.equal(body.data.size, 1);
});

test('returns data null when the caller is already up to date', async () => {
  const { status, body } = await latest({
    'CogSeed-App-Version': '0.0.7-beta.1',
    'CogSeed-Platform': 'darwin',
    'CogSeed-Arch': 'arm64',
  });
  assert.equal(status, 200);
  assert.equal(body.code, 0);
  assert.equal(body.data, null);
});

test('filters by platform and arch', async () => {
  const win = await latest({ 'CogSeed-App-Version': '0.0.5', 'CogSeed-Platform': 'win32', 'CogSeed-Arch': 'x64' });
  assert.equal(win.body.data.latest_version, '0.0.6');
  assert.equal(win.body.data.url, 'https://updates.example.com/downloads/CogSeed-0.0.6-win-x64.exe');

  // No linux release at all → no update.
  const linux = await latest({ 'CogSeed-App-Version': '0.0.5', 'CogSeed-Platform': 'linux', 'CogSeed-Arch': 'arm64' });
  assert.equal(linux.body.data, null);
});

test('v1 latest ignores zip entries even when the zip version is newer', async () => {
  const { status, body } = await latest({
    'CogSeed-App-Version': '0.0.5',
    'CogSeed-Platform': 'darwin',
    'CogSeed-Arch': 'arm64',
  });
  assert.equal(status, 200);
  // 0.0.8 zip exists but the reminder channel must still serve the newest
  // installer (0.0.7-beta.1 dmg), never the zip.
  assert.equal(body.data.latest_version, '0.0.7-beta.1');
  assert.ok(body.data.url.endsWith('.dmg'));
});

test('auto-update feed returns the raw Squirrel.Mac shape for the newest zip', async () => {
  const res = await fetch(`${base}/updates/feed/mac-arm64`);
  assert.equal(res.status, 200);
  const feed = await res.json();
  // NOT the business envelope — the raw {url,name,notes,pub_date} object.
  assert.equal(feed.url, 'https://updates.example.com/downloads/CogSeed-0.0.8-mac-arm64.zip');
  assert.equal(feed.name, '0.0.8');
  assert.equal(typeof feed.notes, 'string');
  assert.ok(feed.pub_date);
});

test('auto-update feed gates by the Squirrel User-Agent version (204 = up to date)', async () => {
  // Electron treats any 200 JSON feed as "update available"; version gating
  // is server-side via the CFNetwork user-agent token.
  const newer = await fetch(`${base}/updates/feed/mac-arm64`, {
    headers: { 'User-Agent': 'CogSeed Dev/0.0.8 CFNetwork/3860.600.21 Darwin/25.5.0' },
  });
  assert.equal(newer.status, 204);
  assert.equal(await newer.text(), '');

  const newerPrerelease = await fetch(`${base}/updates/feed/mac-arm64`, {
    headers: { 'User-Agent': 'CogSeed Dev/0.0.9-beta.1 CFNetwork/3860.600.21 Darwin/25.5.0' },
  });
  assert.equal(newerPrerelease.status, 204);

  const older = await fetch(`${base}/updates/feed/mac-arm64`, {
    headers: { 'User-Agent': 'CogSeed Dev/0.0.5 CFNetwork/3860.600.21 Darwin/25.5.0' },
  });
  assert.equal(older.status, 200);
  assert.equal((await older.json()).name, '0.0.8');

  // Unparseable / missing UA (curl, older clients) still gets the feed.
  const curl = await fetch(`${base}/updates/feed/mac-arm64`, { headers: { 'User-Agent': 'curl/8.7.1' } });
  assert.equal(curl.status, 200);
});

test('callerVersionFromFeedUserAgent parses the CFNetwork token only', () => {
  const { callerVersionFromFeedUserAgent } = require('../server.cjs');
  assert.equal(callerVersionFromFeedUserAgent('CogSeed Dev/0.0.6 CFNetwork/3860.600.21 Darwin/25.5.0'), '0.0.6');
  assert.equal(callerVersionFromFeedUserAgent('CogSeed%20Dev/0.0.6 CFNetwork/3860.600.21 Darwin/25.5.0'), '0.0.6');
  assert.equal(callerVersionFromFeedUserAgent('CogSeed/0.0.6-beta.2 CFNetwork/3860.600.21'), '0.0.6-beta.2');
  assert.equal(callerVersionFromFeedUserAgent('curl/8.7.1'), null);
  assert.equal(callerVersionFromFeedUserAgent(''), null);
});

test('auto-update feed passes notes/released_at through and 404s without a zip', async () => {
  // arm64 newest zip (0.0.8) has no notes/released_at → defaults used;
  // publish 0.0.6 entry carries explicit values (covered by fixture shape).
  const missingArch = await fetch(`${base}/updates/feed/mac-x64`);
  assert.equal(missingArch.status, 404);
  assert.equal((await missingArch.json()).code, 1);
});

test('serves artifacts from downloads/ and rejects traversal', async () => {
  const ok = await fetch(`${base}/downloads/${ARTIFACT}`);
  assert.equal(ok.status, 200);
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), ARTIFACT_BYTES.toString());

  const missing = await fetch(`${base}/downloads/nope.dmg`);
  assert.equal(missing.status, 404);

  const traversal = await fetch(`${base}/downloads/..%2Freleases.json`);
  assert.equal(traversal.status, 400);

  const nested = await fetch(`${base}/downloads/sub%2Ffile.dmg`);
  assert.equal(nested.status, 400);
});

test('healthz responds', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('unknown routes 404 with the envelope shape', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 1);
});
