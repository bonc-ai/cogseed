#!/usr/bin/env node
/**
 * CogSeed updates server — standalone, zero-dependency release catalog API.
 *
 * Routes:
 *   GET /updates/latest          → envelope for the newest installer matching
 *                                  the caller's version/platform/arch headers
 *   GET /updates/feed/mac-<arch> → Squirrel.Mac generic JSON ({url,name,notes,
 *                                  pub_date}) for the newest zip release;
 *                                  drives the client's built-in autoUpdater
 *   GET /downloads/<file>        → static installer artifacts (path-traversal
 *                                  safe)
 *   GET /healthz                 → { ok: true }
 *
 * Env:
 *   PORT                    listen port (default 4870)
 *   UPDATES_SERVER_PUBLIC_BASE  externally reachable origin used to build
 *                           download URLs (production MUST be https, e.g.
 *                           https://updates.example.com; default
 *                           http://127.0.0.1:{PORT} for local runs)
 *   UPDATES_CATALOG         releases.json path (default: this dir)
 *   TLS_KEY / TLS_CERT      optional PEM paths — serve over https (required
 *                           for local verification: the client refuses
 *                           non-https download URLs and COGSEED_API_BASE_URL
 *                           must be https)
 *
 * Response follows the CogSeed envelope contract (see
 * docs/design/updates-api.md): `{ code: 0, data: {...} }` on success,
 * `{ code: 0, data: null }` when the caller is already up to date,
 * `{ code: 1, msg }` on failure. The auto-update feed route is the one
 * exception: Squirrel.Mac expects the raw feed object, not the envelope.
 *
 * The client-side implementation is src/main/features/updater/client.ts
 * (v1 reminder) and src/main/features/updater/auto.ts (auto-update).
 * Version semantics live in lib/compare-versions.cjs and MUST stay in sync
 * with the client comparator.
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const { readCatalog, selectLatest, releaseToData } = require('./lib/catalog.cjs');
const { compareVersions } = require('./lib/compare-versions.cjs');

const PORT = Number(process.env.PORT) || 4870;
const PUBLIC_BASE = (process.env.UPDATES_SERVER_PUBLIC_BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const CATALOG_PATH = process.env.UPDATES_CATALOG || path.join(__dirname, 'releases.json');
const DOWNLOADS_DIR = path.join(path.dirname(CATALOG_PATH), 'downloads');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function handleLatest(req, res) {
  const platform = String(req.headers['cogseed-platform'] || '').trim() || undefined;
  const arch = String(req.headers['cogseed-arch'] || '').trim() || undefined;
  const currentVersion = String(req.headers['cogseed-app-version'] || '').trim();

  let catalog;
  try {
    catalog = readCatalog(CATALOG_PATH);
  } catch (err) {
    json(res, 500, { code: 1, msg: `catalog read failed: ${err.message}` });
    return;
  }
  // v1 reminder channel serves installers; zip entries belong to the
  // auto-update feed so a dmg+zip release pair never collides here.
  const release = selectLatest({ releases: catalog.releases, platform, arch, currentVersion, excludeExt: '.zip' });
  if (!release) {
    json(res, 200, { code: 0, data: null });
    return;
  }
  json(res, 200, { code: 0, data: releaseToData(release, PUBLIC_BASE) });
}

/**
 * Squirrel.Mac feed: raw `{ url, name, notes, pub_date }` for the newest zip
 * release matching darwin/<arch> — the shape electron's autoUpdater parses
 * (NOT the business envelope).
 *
 * Version gating is server-side: Squirrel's feed request carries no
 * CogSeed-* headers — the caller version rides in the User-Agent
 * (`<AppName>/<version> CFNetwork/...`). Electron treats any 200 JSON feed
 * as "update available" and 204 as "update not available", so when the
 * caller is already on the newest zip version we answer 204 (parity with the
 * production hub behaviour; see docs/design/auto-update-local-verify.md).
 * Requests without a parseable version (curl, older clients) get the feed.
 */
function handleFeed(req, res, arch) {
  let catalog;
  try {
    catalog = readCatalog(CATALOG_PATH);
  } catch (err) {
    json(res, 500, { code: 1, msg: `catalog read failed: ${err.message}` });
    return;
  }
  const release = selectLatest({
    releases: catalog.releases,
    platform: 'darwin',
    arch,
    currentVersion: undefined,
    ext: '.zip',
  });
  if (!release) {
    json(res, 404, { code: 1, msg: `no auto-update artifact for mac-${arch}` });
    return;
  }
  const callerVersion = callerVersionFromFeedUserAgent(String(req.headers['user-agent'] || ''));
  if (callerVersion && compareVersions(release.version, callerVersion) <= 0) {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = `${PUBLIC_BASE}/downloads/${encodeURIComponent(release.file)}`;
  json(res, 200, {
    url,
    name: release.version,
    notes: typeof release.notes === 'string' ? release.notes : '',
    pub_date: typeof release.released_at === 'string' ? release.released_at : new Date().toISOString(),
  });
}

/** Extract the caller version from Squirrel's CFNetwork user-agent token. */
function callerVersionFromFeedUserAgent(userAgent) {
  const match = String(userAgent || '').match(/\/(\d+\.\d+\.\d+(?:[0-9A-Za-z.\-+]*)?)\s+CFNetwork/i);
  return match ? match[1] : null;
}

function handleDownload(req, res, url) {
  // Path-traversal guard: serve only files inside downloads/.
  const decoded = decodeURIComponent(url.pathname);
  const relative = decoded.replace(/^\/downloads\//, '');
  if (!relative || relative.includes('..') || relative.includes('/') || path.basename(relative) !== relative) {
    json(res, 400, { code: 1, msg: 'invalid download path' });
    return;
  }
  const filePath = path.join(DOWNLOADS_DIR, relative);
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      json(res, 404, { code: 1, msg: 'artifact not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${relative}"`,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/**
 * Create the server without binding a port (tests bind their own). Pass
 * `tls: { key, cert }` (PEM buffers/strings) to serve https — required for
 * local client verification, where the app refuses http API/download URLs.
 */
function createUpdatesServer({ tls } = {}) {
  const handler = (req, res) => {
    let url;
    try {
      url = new URL(req.url, PUBLIC_BASE);
    } catch {
      json(res, 400, { code: 1, msg: 'bad request' });
      return;
    }
    // One-line request trace — makes local/client integration visible
    // (client metadata travels in headers, not query params).
    // eslint-disable-next-line no-console
    console.log(`[updates-server] ${req.method} ${url.pathname}${url.search || ''} app=${req.headers['cogseed-app-version'] || '-'} platform=${req.headers['cogseed-platform'] || '-'} arch=${req.headers['cogseed-arch'] || '-'} channel=${req.headers['cogseed-channel'] || '-'}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/updates/latest') {
      handleLatest(req, res);
      return;
    }
    const feedMatch = url.pathname.match(/^\/updates\/feed\/mac-(arm64|x64)$/);
    if (req.method === 'GET' && feedMatch) {
      handleFeed(req, res, feedMatch[1]);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/downloads/')) {
      handleDownload(req, res, url);
      return;
    }
    json(res, 404, { code: 1, msg: 'not found' });
  };
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

function resolveTlsOptions() {
  const keyPath = process.env.TLS_KEY;
  const certPath = process.env.TLS_CERT;
  if (!keyPath && !certPath) return null;
  if (!keyPath || !certPath) {
    throw new Error('TLS_KEY and TLS_CERT must be set together');
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

if (require.main === module) {
  const tls = resolveTlsOptions();
  const server = createUpdatesServer({ tls });
  const scheme = tls ? 'https' : 'http';
  server.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`[updates-server] listening on ${scheme}://127.0.0.1:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[updates-server] catalog: ${CATALOG_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`[updates-server] public base (download urls): ${PUBLIC_BASE}`);
  });
}

module.exports = { createUpdatesServer, resolveTlsOptions, callerVersionFromFeedUserAgent, PUBLIC_BASE, CATALOG_PATH, DOWNLOADS_DIR };
