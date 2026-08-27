/**
 * Release catalog logic for the updates server.
 *
 * Pure functions over `releases.json` so the HTTP layer stays thin and the
 * publish tool reuses the exact same read/write/select semantics.
 *
 * Catalog shape (releases.json):
 *   {
 *     "releases": [
 *       {
 *         "version": "0.0.6",
 *         "platform": "darwin",          // "darwin" | "win32" | "linux" | omitted = any
 *         "arch": "arm64",               // "arm64" | "x64" | omitted = any
 *         "file": "CogSeed-0.0.6-mac-arm64.dmg",   // filename under downloads/
 *         "sha256": "<64 hex>",
 *         "size": 381344829,
 *         "notes": "…",
 *         "released_at": "2026-08-21T00:00:00Z",
 *         "mandatory": false
 *       }
 *     ]
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');
const { compareVersions } = require('./compare-versions.cjs');

function emptyCatalog() {
  return { releases: [] };
}

function readCatalog(catalogPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (raw && Array.isArray(raw.releases)) return { releases: raw.releases };
  } catch { /* missing/corrupt → empty */ }
  return emptyCatalog();
}

function writeCatalog(catalogPath, catalog) {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  const tmp = `${catalogPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, catalogPath);
}

/**
 * Pick the newest release matching the caller's platform/arch whose version
 * is strictly greater than the caller's current version. Returns null when
 * there is no update.
 *
 * `ext` restricts matches to one file extension (e.g. '.zip' for the
 * auto-update feed); `excludeExt` drops one extension (e.g. '.zip' for the
 * v1 reminder channel, which serves installers). Both default to no filter.
 */
function selectLatest({ releases, platform, arch, currentVersion, ext, excludeExt }) {
  const matches = releases.filter((r) => {
    if (!r || typeof r.version !== 'string') return false;
    if (platform && r.platform && r.platform !== platform) return false;
    if (arch && r.arch && r.arch !== arch) return false;
    const fileExt = typeof r.file === 'string' ? path.extname(r.file).toLowerCase() : '';
    if (ext && fileExt !== ext.toLowerCase()) return false;
    if (excludeExt && fileExt === excludeExt.toLowerCase()) return false;
    return true;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => compareVersions(b.version, a.version));
  const latest = matches[0];
  // An absent caller version is treated as "unknown" → advertise the newest.
  // An empty string would otherwise compare equal to everything (compareVersions
  // returns 0 for empty input) and wrongly suppress the update.
  if (currentVersion && compareVersions(latest.version, currentVersion) <= 0) return null;
  return latest;
}

/**
 * Build the client-facing `data` payload for a release. `publicBase` is the
 * externally reachable origin the server is served from (env
 * UPDATES_SERVER_PUBLIC_BASE); the client requires an https download URL.
 */
function releaseToData(release, publicBase) {
  const url = `${String(publicBase).replace(/\/+$/, '')}/downloads/${encodeURIComponent(release.file)}`;
  const data = {
    latest_version: release.version,
    url,
    sha256: release.sha256,
  };
  if (typeof release.size === 'number') data.size = release.size;
  if (typeof release.notes === 'string') data.notes = release.notes;
  if (typeof release.min_app_version === 'string') data.min_app_version = release.min_app_version;
  if (typeof release.released_at === 'string') data.released_at = release.released_at;
  if (typeof release.mandatory === 'boolean') data.mandatory = release.mandatory;
  return data;
}

/**
 * Add or replace a release in the catalog. Replacements match on
 * version+platform+arch+file extension, so re-publishing the same artifact
 * (e.g. fixing the dmg) updates in place instead of stacking duplicates,
 * while the dmg and zip of the same release (reminder vs auto-update
 * channels) coexist as separate entries.
 */
function upsertRelease(catalog, release) {
  const fileExt = typeof release.file === 'string' ? path.extname(release.file).toLowerCase() : '';
  const key = (r) => {
    const rExt = typeof r.file === 'string' ? path.extname(r.file).toLowerCase() : '';
    return `${r.version}|${r.platform || ''}|${r.arch || ''}|${rExt}`;
  };
  const target = `${release.version}|${release.platform || ''}|${release.arch || ''}|${fileExt}`;
  const without = catalog.releases.filter((r) => key(r) !== target);
  return { releases: [...without, release] };
}

module.exports = {
  emptyCatalog,
  readCatalog,
  writeCatalog,
  selectLatest,
  releaseToData,
  upsertRelease,
};
