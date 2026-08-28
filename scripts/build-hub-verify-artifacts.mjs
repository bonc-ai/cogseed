#!/usr/bin/env node
/**
 * Build LOCAL release-verify artifacts for the real hub integration test —
 * no GitHub involved:
 *
 *   .hub-verify/old/CogSeed.app                    old-version test client
 *                                                  (real product config:
 *                                                   appId com.cogseed.desktop,
 *                                                   productName CogSeed,
 *                                                   channel release → defaults
 *                                                   to the production API base)
 *   .hub-verify/artifacts/CogSeed-<new>-mac-arm64.dmg   v1 reminder channel
 *   .hub-verify/artifacts/CogSeed-<new>-mac-arm64.zip   v2 auto-update channel
 *   .hub-verify/manifest.json                           sha256/size for the
 *                                                       hub admin check
 *
 * Both bundles are ad-hoc sealed bottom-up (scripts/adhoc-seal-bundle.mjs)
 * with an identifier-based designated requirement so Squirrel.Mac's update
 * validation passes on this certificate-free machine — production builds
 * (GitHub Actions + Developer ID) do not need any of this.
 *
 * Usage:
 *   node scripts/build-hub-verify-artifacts.mjs [--new-version 0.0.6]
 *       [--skip-old-build]
 *
 * After the build, the human steps are:
 *   1. upload both artifacts as GitLab Release assets (internal GitLab,
 *      hub project) and copy the two direct download URLs;
 *   2. GitLab: Run pipeline (main) with INSTALLER_URL=<dmg url> and
 *      AUTO_UPDATE_ZIP_URL=<zip url> → release:installer registers a draft;
 *   3. hub admin (admin/updates): check version/filename/sha256 against
 *      manifest.json → 发布;
 *   4. desktop verification (old client pointed at the production API base)
 *      → 下线 the test entry when done.
 */

'use strict';

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { adhocSealBundle, verifyBundleDeep } from './adhoc-seal-bundle.mjs';

const require = createRequire(import.meta.url);
const { resolveLocalElectronDist } = require('./package-dev-mac.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(ROOT, '.hub-verify');
const OLD_APP_OUT = path.join(OUT_ROOT, 'old', 'CogSeed.app');
const ARTIFACTS_DIR = path.join(OUT_ROOT, 'artifacts');
const MANIFEST_PATH = path.join(OUT_ROOT, 'manifest.json');
const PRODUCT_IDENTIFIER = 'com.cogseed.desktop';
const APP_NAME = 'CogSeed';

function die(message) {
  console.error(`[build-hub-verify] ${message}`);
  process.exit(1);
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) die(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) die(`${command} exited with status ${result.status}`);
  return result;
}

function shQuiet(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  return { ok: !result.error && result.status === 0, stdout: String(result.stdout || '').trim() };
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) die(`cannot bump version "${version}" — pass --new-version explicitly`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--new-version') args.newVersion = next();
    else if (arg === '--skip-old-build') args.skipOldBuild = true;
    else die(`unknown option: ${arg}`);
  }
  return args;
}

/**
 * electron-builder config for the verification build: real product identity
 * (appId/productName/artifact naming), but certificate-free — builder signing
 * off (identity null) and the afterPack hook's ad-hoc fallback skipped; the
 * bundle is sealed by adhocSealBundle afterwards.
 */
function releaseVerifyConfig(baseConfig, outputDir, electronDist) {
  const config = JSON.parse(JSON.stringify(baseConfig));
  config.directories = { ...(config.directories || {}), output: outputDir };
  delete config.protocols; // do not register URL schemes on the dev machine
  const files = Array.isArray(config.files) ? [...config.files] : [];
  if (!files.includes('.build/build-info.json')) files.push('.build/build-info.json');
  config.files = files;
  config.extraMetadata = {
    ...(config.extraMetadata || {}),
    cogseedBuildChannel: 'release',
  };
  config.mac = {
    ...(config.mac || {}),
    forceCodeSigning: false,
    identity: null,
    notarize: false,
    target: [{ target: 'dir', arch: ['arm64'] }],
  };
  config.electronDist = electronDist;
  return config;
}

/** One certificate-free build at the CURRENT package.json version. */
function buildApp(outputDir) {
  sh(process.execPath, [path.join(ROOT, 'scripts', 'write-build-info.cjs'), '--channel=release']);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  const electronDist = resolveLocalElectronDist({ electronVersion });
  if (!electronDist) {
    die(`Electron ${electronVersion} arm64 zip is not cached (run the normal dependency setup once)`);
  }
  const config = releaseVerifyConfig(pkg.build, outputDir, electronDist);
  const configPath = path.join(ROOT, '.build', `electron-builder-hub-verify-${outputDir}.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');
  sh(process.execPath, [builderCli, '--config', configPath, '--mac', 'dir', '--arm64', '--publish', 'never'], {
    env: { ...process.env, COGSEED_SKIP_ADHOC_CODESIGN: '1' },
  });
  return path.join(ROOT, outputDir, 'mac-arm64', `${APP_NAME}.app`);
}

function sealChecked(appPath, label) {
  const failed = adhocSealBundle(appPath, PRODUCT_IDENTIFIER);
  if (failed.length) die(`ad-hoc seal failed for ${label}: ${failed.join(', ')}`);
  const verify = verifyBundleDeep(appPath);
  if (!verify.ok) die(`deep verify failed for ${label}: ${verify.stderr}`);
  console.log(`[build-hub-verify] ${label} sealed + deep-verified ✓`);
}

function makeDmg(appPath, dmgPath) {
  console.log(`[build-hub-verify] building dmg → ${dmgPath}`);
  sh('hdiutil', ['create', '-volname', 'CogSeed', '-srcfolder', appPath, '-ov', '-format', 'UDZO', dmgPath]);
}

function makeZip(appDir, zipPath) {
  console.log(`[build-hub-verify] building zip → ${zipPath}`);
  sh('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', `${APP_NAME}.app`, zipPath], { cwd: appDir });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function main() {
  if (process.platform !== 'darwin') die('macOS only');
  const args = parseArgs(process.argv.slice(2));
  const pkgPath = path.join(ROOT, 'package.json');
  const originalPkg = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(originalPkg);
  const oldVersion = pkg.version;
  const newVersion = args.newVersion || bumpPatch(oldVersion);
  if (newVersion === oldVersion) die(`--new-version must differ from package.json version (${oldVersion})`);

  fs.rmSync(OUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(OUT_ROOT, '.gitignore'), '*\n');

  console.log(`[build-hub-verify] old ${oldVersion} → new ${newVersion}`);
  let oldAppPath = null;
  if (!args.skipOldBuild) {
    console.log(`[build-hub-verify] building old client ${oldVersion} …`);
    oldAppPath = buildApp('.hub-verify-build-old');
    sealChecked(oldAppPath, `old ${oldVersion}`);
    fs.mkdirSync(path.dirname(OLD_APP_OUT), { recursive: true });
    sh('ditto', [oldAppPath, OLD_APP_OUT]);
    fs.rmSync(path.join(ROOT, '.hub-verify-build-old'), { recursive: true, force: true });
  }

  console.log(`[build-hub-verify] building new release ${newVersion} (temporary package.json bump) …`);
  const bumped = JSON.parse(originalPkg);
  bumped.version = newVersion;
  fs.writeFileSync(pkgPath, `${JSON.stringify(bumped, null, 2)}\n`);
  let newAppPath;
  try {
    newAppPath = buildApp('.hub-verify-build-new');
  } finally {
    fs.writeFileSync(pkgPath, originalPkg);
  }
  sealChecked(newAppPath, `new ${newVersion}`);

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const dmgPath = path.join(ARTIFACTS_DIR, `CogSeed-${newVersion}-mac-arm64.dmg`);
  const zipPath = path.join(ARTIFACTS_DIR, `CogSeed-${newVersion}-mac-arm64.zip`);
  makeDmg(newAppPath, dmgPath);
  makeZip(path.dirname(newAppPath), zipPath);
  fs.rmSync(path.join(ROOT, '.hub-verify-build-new'), { recursive: true, force: true });

  const manifest = {
    old_client: { version: oldVersion, app: path.relative(ROOT, OLD_APP_OUT) },
    release: {
      version: newVersion,
      platform: 'darwin',
      arch: 'arm64',
      dmg: { file: path.basename(dmgPath), sha256: sha256File(dmgPath), size: fs.statSync(dmgPath).size },
      zip: { file: path.basename(zipPath), sha256: sha256File(zipPath), size: fs.statSync(zipPath).size },
    },
    built_at: new Date().toISOString(),
    note: 'ad-hoc sealed, certificate-free — verification only, 验证完必须下线',
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n[build-hub-verify] done:\n${JSON.stringify(manifest, null, 2)}`);
}

main();
