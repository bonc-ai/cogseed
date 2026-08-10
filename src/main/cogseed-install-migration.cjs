'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IDENTITY } = require('./identity-contract.cjs');

const MIGRATION_FILENAME = '.migrate.json';
const MIGRATION_NAME = 'legacy-orkas-to-cogseed';

function resolveCanonicalContainer({ platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA, env = process.env } = {}) {
  return resolveContainer({
    platform,
    home,
    localAppData,
    env,
    dataRootName: IDENTITY.dataRootName,
    devDataRootName: IDENTITY.devDataRootName,
    pinDirName: 'CogSeed',
  });
}

function resolveLegacyContainer({ platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA, env = process.env } = {}) {
  return resolveContainer({
    platform,
    home,
    localAppData,
    env,
    dataRootName: IDENTITY.legacyDataRootNames[0],
    devDataRootName: IDENTITY.legacyDevDataRootNames[0],
    pinDirName: 'Orkas',
  });
}

function resolveContainer({ platform, home, localAppData, env, dataRootName, devDataRootName, pinDirName }) {
  const buildChannel = String(env.COGSEED_BUILD_CHANNEL || env.ORKAS_BUILD_CHANNEL || '').trim();
  const rootName = buildChannel === 'packaged-dev' ? devDataRootName : dataRootName;
  if (platform === 'win32') {
    const pin = readWindowsPin({ localAppData, pinDirName });
    const drive = pin?.container ? path.parse(pin.container).root || 'C:\\' : 'C:\\';
    return path.win32.join(drive, rootName);
  }
  return path.join(home, rootName);
}

function readWindowsPin({ localAppData, pinDirName }) {
  const pinPath = path.join(localAppData || path.join(os.homedir(), 'AppData', 'Local'), pinDirName, 'install-pin.json');
  try {
    const raw = fs.readFileSync(pinPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.container === 'string' && parsed.container) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function planMigration({ canonicalRoot, legacyRoot, markerPath }) {
  const canonicalExists = existsDir(canonicalRoot);
  const legacyExists = existsDir(legacyRoot);
  const markerExists = existsFile(markerPath);

  if (markerExists) {
    return { kind: 'ready', canonicalRoot, legacyRoot, markerPath };
  }
  if (canonicalExists && legacyExists) {
    return { kind: 'conflict', canonicalRoot, legacyRoot, markerPath };
  }
  if (!canonicalExists && legacyExists) {
    return { kind: 'migrate', canonicalRoot, legacyRoot, markerPath };
  }
  return { kind: 'ready', canonicalRoot, legacyRoot, markerPath };
}

function copyAndVerifyMigration({ sourceRoot, destinationRoot, progress = () => {}, fsImpl = fs }) {
  if (!fsImpl.existsSync(sourceRoot)) {
    throw new Error(`missing migration source root: ${sourceRoot}`);
  }
  fsImpl.mkdirSync(path.dirname(destinationRoot), { recursive: true });
  const tempRoot = `${destinationRoot}.tmp-${process.pid}`;
  fsImpl.rmSync(tempRoot, { recursive: true, force: true });
  const manifest = buildManifest(sourceRoot, fsImpl);
  progress({ stage: 'copy', fileCount: manifest.fileCount });
  fsImpl.cpSync(sourceRoot, tempRoot, { recursive: true, force: true });
  const copied = buildManifest(tempRoot, fsImpl);
  if (copied.fileCount !== manifest.fileCount || copied.criticalManifestHash !== manifest.criticalManifestHash) {
    fsImpl.rmSync(tempRoot, { recursive: true, force: true });
    throw new Error('migration verification failed');
  }
  fsImpl.renameSync(tempRoot, destinationRoot);
  const markerPath = writeMigrationMarker({ canonicalRoot: destinationRoot, manifest, sourceKind: sourceKindFor(sourceRoot) });
  return { ...manifest, destinationRoot, markerPath };
}

function writeMigrationMarker({ canonicalRoot, manifest, sourceKind }) {
  const markerPath = path.join(canonicalRoot, MIGRATION_FILENAME);
  fs.mkdirSync(canonicalRoot, { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    schema_version: 1,
    migration: MIGRATION_NAME,
    source_kind: sourceKind,
    completed_at: new Date().toISOString(),
    file_count: manifest.fileCount,
    critical_manifest_hash: manifest.criticalManifestHash,
    legacy_root_retained: true,
  }, null, 2), 'utf8');
  return markerPath;
}

function migrateLegacyInstallRoots({ platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA, env = process.env, fsImpl = fs, canonicalRoot: canonicalRootOverride, legacyRoot: legacyRootOverride } = {}) {
  const canonicalRoot = canonicalRootOverride || resolveCanonicalContainer({ platform, home, localAppData, env });
  const legacyRoot = legacyRootOverride || resolveLegacyContainer({ platform, home, localAppData, env });
  const markerPath = path.join(canonicalRoot, MIGRATION_FILENAME);
  const plan = planMigration({ canonicalRoot, legacyRoot, markerPath });
  if (plan.kind === 'conflict') {
    throw new Error('legacy and canonical CogSeed roots both exist without a migration marker');
  }
  if (plan.kind === 'migrate') {
    return copyAndVerifyMigration({ sourceRoot: legacyRoot, destinationRoot: canonicalRoot, fsImpl });
  }
  return {
    canonicalRoot,
    legacyRoot,
    markerPath,
    fileCount: 0,
    criticalManifestHash: 'noop',
    destinationRoot: canonicalRoot,
  };
}

function buildManifest(root, fsImpl) {
  const entries = [];
  walk(root, root, entries, fsImpl);
  entries.sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.relative);
    hash.update('\0');
    hash.update(String(entry.size));
    hash.update('\0');
    hash.update(entry.hash);
    hash.update('\n');
  }
  return { fileCount: entries.length, criticalManifestHash: hash.digest('hex') };
}

function walk(root, current, entries, fsImpl) {
  const stat = fsImpl.statSync(current);
  if (stat.isDirectory()) {
    for (const name of fsImpl.readdirSync(current)) {
      walk(root, path.join(current, name), entries, fsImpl);
    }
    return;
  }
  if (!stat.isFile()) return;
  const relative = path.relative(root, current).split(path.sep).join('/');
  const data = fsImpl.readFileSync(current);
  entries.push({
    relative,
    size: stat.size,
    hash: crypto.createHash('sha256').update(data).digest('hex'),
  });
}

function sourceKindFor(sourceRoot) {
  return String(sourceRoot).endsWith(IDENTITY.legacyDevDataRootNames[0]) ? 'orkas-dev' : 'orkas';
}

function existsDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  resolveCanonicalContainer,
  resolveLegacyContainer,
  planMigration,
  copyAndVerifyMigration,
  writeMigrationMarker,
  migrateLegacyInstallRoots,
};
