#!/usr/bin/env node
/**
 * Publish an installer artifact to the updates catalog.
 *
 * Usage:
 *   node updates-server/publish.cjs <installer-file> [options]
 *
 * Options:
 *   --version <v>          version (default: inferred from the filename,
 *                          e.g. CogSeed-0.0.6-mac-arm64.dmg → 0.0.6)
 *   --platform <p>         darwin | win32 | linux (default: inferred)
 *   --arch <a>             arm64 | x64 (default: inferred)
 *   --notes "<text>"       release notes shown in the client
 *   --mandatory            mark the release as mandatory (informational)
 *   --min-app-version <v>  minimum app version this release requires
 *   --catalog <path>       releases.json path (default: updates-server/releases.json)
 *   --no-copy              do not copy the artifact into downloads/
 *
 * The installer is copied into <catalog-dir>/downloads/ (unless --no-copy),
 * its sha256 + size are computed, and the catalog is updated atomically
 * (same version+platform+arch replaces the previous entry in place).
 *
 * The catalog is served by updates-server/server.cjs; the client contract is
 * docs/design/updates-api.md. Remember to commit releases.json after
 * publishing and to make the artifact reachable at
 * {UPDATES_SERVER_PUBLIC_BASE}/downloads/<file>.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { readCatalog, writeCatalog, upsertRelease } = require('./lib/catalog.cjs');

const OS_MAP = { mac: 'darwin', win: 'win32', linux: 'linux' };

function parseArgs(argv) {
  const args = { positional: [], notes: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--version': args.version = next(); break;
      case '--platform': args.platform = next(); break;
      case '--arch': args.arch = next(); break;
      case '--notes': args.notes = next(); break;
      case '--min-app-version': args.minAppVersion = next(); break;
      case '--catalog': args.catalog = next(); break;
      case '--mandatory': args.mandatory = true; break;
      case '--no-copy': args.noCopy = true; break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
        args.positional.push(arg);
    }
  }
  return args;
}

/** Infer {version, platform, arch} from `CogSeed-<version>-<os>-<arch>.<ext>`. */
function inferFromFilename(filename) {
  const base = path.basename(filename).replace(/\.(dmg|zip|exe|AppImage)$/i, '');
  const parts = base.split('-');
  if (parts.length >= 4 && parts[0].toLowerCase() === 'cogseed') {
    const version = parts.slice(1, -2).join('-');
    const osPart = parts[parts.length - 2].toLowerCase();
    const arch = parts[parts.length - 1].toLowerCase();
    const platform = OS_MAP[osPart];
    if (version && platform && arch) return { version, platform, arch };
  }
  return null;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.positional.length !== 1) {
    throw new Error('usage: node updates-server/publish.cjs <installer-file> [--version v] [--platform p] [--arch a] [--notes "..."] [--mandatory] [--min-app-version v] [--catalog path] [--no-copy]');
  }
  const installer = path.resolve(args.positional[0]);
  if (!fs.existsSync(installer)) throw new Error(`installer not found: ${installer}`);

  const inferred = inferFromFilename(path.basename(installer));
  const version = args.version || (inferred && inferred.version);
  const platform = args.platform || (inferred && inferred.platform);
  const arch = args.arch || (inferred && inferred.arch);
  if (!version) throw new Error('cannot infer version — pass --version');
  if (!platform) throw new Error('cannot infer platform — pass --platform');
  if (!arch) throw new Error('cannot infer arch — pass --arch');

  const catalogPath = path.resolve(args.catalog || path.join(__dirname, 'releases.json'));
  const downloadsDir = path.join(path.dirname(catalogPath), 'downloads');
  const filename = path.basename(installer);
  if (!args.noCopy) {
    fs.mkdirSync(downloadsDir, { recursive: true });
    fs.copyFileSync(installer, path.join(downloadsDir, filename));
  }

  const sha256 = sha256File(installer);
  const size = fs.statSync(installer).size;
  const release = {
    version,
    platform,
    arch,
    file: filename,
    sha256,
    size,
    notes: args.notes || undefined,
    min_app_version: args.minAppVersion || undefined,
    released_at: new Date().toISOString(),
    mandatory: !!args.mandatory,
  };
  // Drop undefined fields so the catalog stays clean.
  for (const key of ['notes', 'min_app_version']) {
    if (release[key] === undefined) delete release[key];
  }

  const catalog = readCatalog(catalogPath);
  const next = upsertRelease(catalog, release);
  writeCatalog(catalogPath, next);

  // eslint-disable-next-line no-console
  console.log('[updates-server] published:');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(release, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[updates-server] catalog: ${catalogPath} (${next.releases.length} release(s))`);
  if (!args.noCopy) {
    // eslint-disable-next-line no-console
    console.log(`[updates-server] artifact copied to ${path.join(downloadsDir, filename)}`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[updates-server] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { inferFromFilename, sha256File, parseArgs };
