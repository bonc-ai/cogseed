#!/usr/bin/env node
/**
 * CogSeed updates server — standalone, zero-dependency release catalog API.
 *
 * Routes:
 *   GET /updates/latest   → envelope for the newest release matching the
 *                           caller's version/platform/arch headers
 *   GET /downloads/<file> → static installer artifacts (path-traversal safe)
 *   GET /healthz          → { ok: true }
 *
 * Env:
 *   PORT                    listen port (default 4870)
 *   UPDATES_SERVER_PUBLIC_BASE  externally reachable origin used to build
 *                           download URLs (production MUST be https, e.g.
 *                           https://updates.example.com; default
 *                           http://127.0.0.1:{PORT} for local runs)
 *   UPDATES_CATALOG         releases.json path (default: this dir)
 *
 * Response follows the CogSeed envelope contract (see
 * docs/design/updates-api.md): `{ code: 0, data: {...} }` on success,
 * `{ code: 0, data: null }` when the caller is already up to date,
 * `{ code: 1, msg }` on failure.
 *
 * The client-side implementation is src/main/features/updater/client.ts.
 * Version semantics live in lib/compare-versions.cjs and MUST stay in sync
 * with the client comparator.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { readCatalog, selectLatest, releaseToData } = require('./lib/catalog.cjs');

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
  const release = selectLatest({ releases: catalog.releases, platform, arch, currentVersion });
  if (!release) {
    json(res, 200, { code: 0, data: null });
    return;
  }
  json(res, 200, { code: 0, data: releaseToData(release, PUBLIC_BASE) });
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

/** Create the HTTP server without binding a port (tests bind their own). */
function createUpdatesServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, PUBLIC_BASE);
    } catch {
      json(res, 400, { code: 1, msg: 'bad request' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/updates/latest') {
      handleLatest(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/downloads/')) {
      handleDownload(req, res, url);
      return;
    }
    json(res, 404, { code: 1, msg: 'not found' });
  });
}

if (require.main === module) {
  const server = createUpdatesServer();
  server.listen(PORT, '127.0.0.1', () => {
    // eslint-disable-next-line no-console
    console.log(`[updates-server] listening on http://127.0.0.1:${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[updates-server] catalog: ${CATALOG_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`[updates-server] public base (download urls): ${PUBLIC_BASE}`);
  });
}

module.exports = { createUpdatesServer, PUBLIC_BASE, CATALOG_PATH, DOWNLOADS_DIR };
