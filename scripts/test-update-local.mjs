#!/usr/bin/env node
/**
 * Local end-to-end driver for the in-app update feature — walks the whole
 * "release" flow on one machine, without GitHub or the production server:
 *
 *   v1 reminder channel  (GET /updates/latest → dmg download → sha256)
 *   v2 auto-update       (GET /updates/feed/mac-<arch> → Squirrel.Mac zip)
 *
 * What it does (all macOS-only, arm64):
 *
 *   1. packages the current tree as the "old" client via
 *      `npm run package:dev:mac` (dist-dev/mac-arm64/CogSeed Dev.app,
 *      channel packaged-dev, ad-hoc signed) — skip with --skip-package;
 *   2. derives the "new" version (patch bump of package.json, or
 *      --new-version) and builds both artifacts from a copied app bundle
 *      whose Info.plist version was bumped and re-signed ad-hoc:
 *        - <new>-mac-arm64.dmg  (hdiutil) → v1 reminder channel
 *        - <new>-mac-arm64.zip  (ditto, app at zip root) → auto-update feed
 *   3. publishes both into a throwaway catalog under
 *      updates-server/.local-verify/ (git-ignored scratch, never the
 *      repo's releases.json);
 *   4. provisions local TLS: mkcert when installed, otherwise an openssl
 *      self-signed cert (trusted via NODE_EXTRA_CA_CERTS for Node fetch;
 *      keychain trust is attempted so Squirrel.Mac's NSURLSession accepts
 *      it too — use mkcert for the smoothest v2 run);
 *   5. starts updates-server/server.cjs on https://127.0.0.1:<port> as a
 *      detached child (pid file + log under .local-verify/);
 *   6. asserts the server contract exactly as the client will consume it
 *      (/healthz, /updates/latest, /updates/feed/mac-arm64, catalog↔artifact
 *      sha256) and prints the launch command for the old client.
 *
 * The app-side clicking (check → download → restart-and-install) is a
 * manual step, exercised with this script end to end.
 *
 * Usage:
 *   node scripts/test-update-local.mjs [--new-version 0.0.6] [--port 4870]
 *       [--skip-package] [--notes "..."] [--foreground] [--stop] [--status]
 */

'use strict';

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createDevBuilderConfig, resolveLocalElectronDist } = require('./package-dev-mac.cjs');
import { adhocSealBundle } from './adhoc-seal-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_DIR = path.join(ROOT, 'updates-server', '.local-verify');
const DOWNLOADS_DIR = path.join(VERIFY_DIR, 'downloads');
const NEW_BUILD_DIR = path.join(VERIFY_DIR, 'new-build');
const CATALOG_PATH = path.join(VERIFY_DIR, 'releases.json');
const TLS_DIR = path.join(VERIFY_DIR, 'tls');
const PID_FILE = path.join(VERIFY_DIR, 'server.pid');
const SERVER_LOG = path.join(VERIFY_DIR, 'server.log');

const APP_NAME = 'CogSeed Dev';
const APP_PATH = path.join(ROOT, 'dist-dev', 'mac-arm64', `${APP_NAME}.app`);
const SERVER_PATH = path.join(ROOT, 'updates-server', 'server.cjs');
const PUBLISH_PATH = path.join(ROOT, 'updates-server', 'publish.cjs');
const GITIGNORE_PATH = path.join(VERIFY_DIR, '.gitignore');
// Bundle identifier for the packaged-dev app — the outer designated
// requirement references it (see scripts/adhoc-seal-bundle.mjs).
const DEV_APP_IDENTIFIER = 'com.cogseed.desktop.dev';

function die(message) {
  console.error(`[test-update-local] ${message}`);
  process.exit(1);
}

/** Thin wrapper over the shared seal recipe with dev-bundle naming. */
function sealBundle(appPath) {
  const failed = adhocSealBundle(appPath, DEV_APP_IDENTIFIER, 'CogSeed Dev');
  if (failed.length) {
    console.warn(`[test-update-local] ad-hoc seal issues: ${failed.join(', ')}`);
    console.warn('[test-update-local] Squirrel.Mac may reject the bundle at install-time validation');
    return false;
  }
  return true;
}

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) die(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) die(`${command} exited with status ${result.status}`);
  return result;
}

function shQuiet(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) die(`cannot bump version "${version}" — pass --new-version explicitly`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function parseArgs(argv) {
  const args = { port: 4870 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--new-version': args.newVersion = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--notes': args.notes = next(); break;
      case '--skip-package': args.skipPackage = true; break;
      case '--foreground': args.foreground = true; break;
      case '--stop': args.stop = true; break;
      case '--status': args.status = true; break;
      default: die(`unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    die(`invalid --port: ${args.port}`);
  }
  return args;
}

function stopServer() {
  if (!fs.existsSync(PID_FILE)) {
    console.log('[test-update-local] no running server (pid file missing)');
    return false;
  }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  fs.rmSync(PID_FILE, { force: true });
  console.log(`[test-update-local] stopped server pid ${pid}`);
  return true;
}

function ensureVerifyDir() {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  fs.mkdirSync(NEW_BUILD_DIR, { recursive: true });
  fs.mkdirSync(TLS_DIR, { recursive: true });
  // Keep the throwaway catalog out of git regardless of repo config.
  fs.writeFileSync(GITIGNORE_PATH, '*\n');
}

function wipeScratch() {
  for (const entry of [CATALOG_PATH, SERVER_LOG]) fs.rmSync(entry, { force: true });
  fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
  fs.rmSync(NEW_BUILD_DIR, { recursive: true, force: true });
}

function packageOldApp(skipPackage) {
  if (skipPackage) {
    if (!fs.existsSync(APP_PATH)) die(`--skip-package but app not found at ${APP_PATH}`);
    // If ShipIt already replaced dist-dev with the new version, the "old
    // client" is gone — a reused bundle would just report up-to-date.
    const plistVersion = shQuiet('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(APP_PATH, 'Contents', 'Info.plist')]).stdout;
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    if (plistVersion && plistVersion !== pkgVersion) {
      die(`dist-dev app is ${plistVersion} but package.json is ${pkgVersion} (ShipIt upgraded it) — run without --skip-package to rebuild the old client`);
    }
    console.log('[test-update-local] using existing packaged app (--skip-package)');
    return;
  }
  // A running instance holds the bundle open — kill it before rebuilding.
  shQuiet('pkill', ['-9', '-f', 'CogSeed Dev.app/Contents/MacOS/CogSeed Dev']);
  console.log('[test-update-local] packaging current tree as the "old" client (npm run package:dev:mac) …');
  // Skip the afterPack deep ad-hoc re-sign: it breaks the official Electron
  // seals on nested frameworks (Squirrel.Mac validates them at install time).
  // Nested components keep their original signatures and we bottom-up
  // ad-hoc seal the bundle ourselves.
  sh('npm', ['run', 'package:dev:mac'], { env: { ...process.env, COGSEED_SKIP_ADHOC_CODESIGN: '1' } });
  sealBundle(APP_PATH);
}

/**
 * Real second build at `version`: bumps package.json (electron-builder writes
 * both the bundle plist and the asar package.json from it, so the built app
 * consistently self-reports `version`), builds into a scratch output dir, and
 * restores package.json afterwards. Patching only the plist of a copy would
 * leave the asar at the old version — app.getVersion() prefers it and the
 * "upgraded" app would keep seeing itself as old (update loop).
 */
function packageNewApp(version) {
  shQuiet('pkill', ['-9', '-f', 'CogSeed Dev.app/Contents/MacOS/CogSeed Dev']);
  const pkgPath = path.join(ROOT, 'package.json');
  const original = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(original);
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    sh(process.execPath, [path.join(ROOT, 'scripts', 'write-build-info.cjs'), '--channel=packaged-dev']);
    const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
    const electronDist = resolveLocalElectronDist({ electronVersion });
    if (!electronDist) {
      throw new Error(`Electron ${electronVersion} arm64 zip is not cached (run the normal dependency setup once)`);
    }
    const config = createDevBuilderConfig(pkg.build, { channel: 'packaged-dev' }, { electronDist, outputDir: 'dist-dev-new' });
    const configPath = path.join(ROOT, '.build', 'electron-builder-dev-new.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    const builderCli = require.resolve('electron-builder/out/cli/cli.js');
    sh(process.execPath, [builderCli, '--config', configPath, '--mac', 'dir', '--arm64', '--publish', 'never'], { env: { ...process.env, COGSEED_SKIP_ADHOC_CODESIGN: '1' } });
    return path.join(ROOT, 'dist-dev-new', 'mac-arm64', `${APP_NAME}.app`);
  } finally {
    fs.writeFileSync(pkgPath, original);
  }
}

function buildNewArtifacts(newVersion, notes) {
  const oldVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  console.log(`[test-update-local] current version ${oldVersion} → new version ${newVersion}`);
  if (newVersion === oldVersion) die(`--new-version must differ from package.json version (${oldVersion})`);

  // Real second build (consistent plist + asar version), not a plist patch:
  // app.getVersion() prefers the asar package.json, so a patched copy would
  // still self-report the old version after ShipIt installs it (update loop).
  console.log(`[test-update-local] building the "new" client ${newVersion} (real second build) …`);
  const builtApp = packageNewApp(newVersion);

  const newAppPath = path.join(NEW_BUILD_DIR, `${APP_NAME}.app`);
  fs.rmSync(NEW_BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(NEW_BUILD_DIR, { recursive: true });
  sh('ditto', [builtApp, newAppPath]);
  fs.rmSync(path.join(ROOT, 'dist-dev-new'), { recursive: true, force: true });

  // Bottom-up ad-hoc seal (see adhocSealBundle): the second build is
  // unsigned (COGSEED_SKIP_ADHOC_CODESIGN=1) and Electron's upstream nested
  // seals are inconsistent, so every component is re-sealed before the
  // outer bundle.
  sealBundle(newAppPath);

  const zipPath = path.join(DOWNLOADS_DIR, `CogSeed-${newVersion}-mac-arm64.zip`);
  const dmgPath = path.join(DOWNLOADS_DIR, `CogSeed-${newVersion}-mac-arm64.dmg`);
  fs.rmSync(zipPath, { force: true });
  fs.rmSync(dmgPath, { force: true });

  console.log(`[test-update-local] building zip (auto-update artifact) → ${zipPath}`);
  sh('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', `${APP_NAME}.app`, zipPath], { cwd: NEW_BUILD_DIR });

  console.log(`[test-update-local] building dmg (reminder-channel artifact) → ${dmgPath}`);
  sh('hdiutil', ['create', '-volname', 'CogSeed', '-srcfolder', `${APP_NAME}.app`, '-ov', '-format', 'UDZO', dmgPath], { cwd: NEW_BUILD_DIR });

  console.log('[test-update-local] publishing both artifacts into the local catalog …');
  const publish = (artifact) => sh(process.execPath, [
    PUBLISH_PATH, artifact,
    '--version', newVersion,
    '--platform', 'darwin',
    '--arch', 'arm64',
    ...(notes ? ['--notes', notes] : []),
    '--catalog', CATALOG_PATH,
    '--no-copy',
  ]);
  publish(dmgPath);
  publish(zipPath);
  return { oldVersion, newVersion, zipPath, dmgPath };
}

function ensureTls() {
  const keyPath = path.join(TLS_DIR, 'key.pem');
  const certPath = path.join(TLS_DIR, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('[test-update-local] reusing TLS certs in .local-verify/tls/');
    return { keyPath, certPath, caPath: path.join(TLS_DIR, 'rootCA.pem') };
  }
  const mkcert = shQuiet('mkcert', ['-CAROOT']);
  if (mkcert.ok) {
    console.log('[test-update-local] mkcert found — provisioning locally-trusted certs …');
    const install = shQuiet('mkcert', ['-install']);
    if (!install.ok) console.warn(`[test-update-local] mkcert -install reported issues: ${install.stderr || install.stdout}`);
    const gen = shQuiet('mkcert', ['-cert-file', certPath, '-key-file', keyPath, '127.0.0.1', 'localhost'], { cwd: TLS_DIR });
    if (!gen.ok) die(`mkcert cert generation failed: ${gen.stderr || gen.stdout}`);
    const caPath = path.join(mkcert.stdout, 'rootCA.pem');
    if (fs.existsSync(caPath)) {
      fs.copyFileSync(caPath, path.join(TLS_DIR, 'rootCA.pem'));
      return { keyPath, certPath, caPath: path.join(TLS_DIR, 'rootCA.pem') };
    }
    console.warn('[test-update-local] mkcert root CA not found — Node-fetch trust needs manual NODE_EXTRA_CA_CERTS');
    return { keyPath, certPath, caPath: null };
  }
  console.log('[test-update-local] mkcert not installed — falling back to openssl self-signed …');
  const gen = shQuiet('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '30',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ]);
  if (!gen.ok) die(`openssl failed: ${gen.stderr || gen.stdout}`);
  const trust = shQuiet('security', [
    'add-trusted-cert', '-d', '-r', 'trustRoot',
    '-k', path.join(process.env.HOME || '', 'Library', 'Keychains', 'login.keychain-db'),
    certPath,
  ]);
  if (trust.ok) {
    console.log('[test-update-local] self-signed cert added to the login keychain (Squirrel.Mac can trust it)');
  } else {
    console.warn('[test-update-local] could not add the cert to the keychain — v2 feed fetch may fail; install mkcert for the full flow');
  }
  return { keyPath, certPath, caPath: certPath };
}

function startServer({ port }) {
  const logFd = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: String(port),
      UPDATES_CATALOG: CATALOG_PATH,
      UPDATES_SERVER_PUBLIC_BASE: `https://127.0.0.1:${port}`,
      TLS_KEY: path.join(TLS_DIR, 'key.pem'),
      TLS_CERT: path.join(TLS_DIR, 'cert.pem'),
    },
  });
  child.unref();
  fs.writeFileSync(PID_FILE, `${child.pid}\n`);
  return child.pid;
}

function httpsJson(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: 'GET',
      rejectUnauthorized: false, // local-verification transport only
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitHealthy(port) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await httpsJson(port, '/healthz');
      if (res.status === 200 && res.body?.ok === true) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  die(`server did not become healthy on https://127.0.0.1:${port} — see ${SERVER_LOG}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

let failures = 0;
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function runAssertions({ port, oldVersion, newVersion, zipPath, dmgPath }) {
  console.log(`[test-update-local] asserting server contract on https://127.0.0.1:${port} …`);
  const clientHeaders = {
    'CogSeed-App-Version': oldVersion,
    'CogSeed-Platform': 'darwin',
    'CogSeed-Arch': 'arm64',
    'CogSeed-Channel': 'open',
  };

  const latest = await httpsJson(port, '/updates/latest', clientHeaders);
  check('v1 /updates/latest offers the new installer', latest.status === 200 && latest.body?.code === 0
    && latest.body?.data?.latest_version === newVersion,
    JSON.stringify(latest.body));
  check('v1 download url is an https dmg', typeof latest.body?.data?.url === 'string'
    && latest.body.data.url.startsWith('https://') && latest.body.data.url.endsWith('.dmg'),
    latest.body?.data?.url || '');

  const uptodate = await httpsJson(port, '/updates/latest', { ...clientHeaders, 'CogSeed-App-Version': newVersion });
  check('v1 already-latest returns data:null', uptodate.status === 200 && uptodate.body?.code === 0
    && uptodate.body?.data === null, JSON.stringify(uptodate.body));

  const feed = await httpsJson(port, '/updates/feed/mac-arm64');
  check('v2 feed is raw Squirrel JSON (url/name/notes/pub_date)', feed.status === 200
    && typeof feed.body?.url === 'string' && typeof feed.body?.name === 'string'
    && typeof feed.body?.notes === 'string' && typeof feed.body?.pub_date === 'string',
    JSON.stringify(feed.body));
  check('v2 feed points at the new zip and version', feed.body?.name === newVersion
    && feed.body?.url?.endsWith('.zip') && feed.body?.url?.startsWith('https://'),
    feed.body?.url || '');

  // Squirrel carries the caller version in its CFNetwork user-agent; the
  // server answers 204 when the caller is already on the newest zip.
  const feedUptodate = await httpsJson(port, '/updates/feed/mac-arm64', {
    'User-Agent': `CogSeed Dev/${newVersion} CFNetwork/3860.600.21 Darwin/25.5.0`,
  });
  check('v2 feed gates by user-agent version (204 = up to date)', feedUptodate.status === 204,
    `status=${feedUptodate.status}`);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const zipEntry = catalog.releases.find((r) => r.file.endsWith('.zip'));
  const dmgEntry = catalog.releases.find((r) => r.file.endsWith('.dmg'));
  check('catalog has separate dmg + zip entries for the release', Boolean(zipEntry && dmgEntry));
  check('zip sha256 matches the catalog', zipEntry && sha256File(zipPath) === zipEntry.sha256);
  check('dmg sha256 matches the catalog', dmgEntry && sha256File(dmgPath) === dmgEntry.sha256);
  check('feed url downloads over https', feed.body?.url ? await (async () => {
    const dl = await new Promise((resolve) => {
      const req = https.request({ host: '127.0.0.1', port, path: `/downloads/${zipEntry.file}`, method: 'GET', rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
    return dl === 200;
  })() : false);
}

function printNextSteps({ port, oldVersion, newVersion, caPath }) {
  console.log('\n[test-update-local] ── next steps (app-side, manual) ──────────────────────────');
  const home = '/tmp/cogseed-update-e2e-home';
  console.log(`  1. isolated home (keeps real data untouched):`);
  console.log(`       rm -rf ${home} && mkdir -p ${home}`);
  console.log(`  2. launch the OLD client (${oldVersion}) against the local server:`);
  const envPrefix = caPath ? `NODE_EXTRA_CA_CERTS="${caPath}" ` : '';
  console.log(`       HOME=${home} ${envPrefix}COGSEED_API_BASE_URL=https://127.0.0.1:${port} \\`);
  console.log(`         "${APP_PATH}/Contents/MacOS/${APP_NAME}" --ignore-certificate-errors`);
  console.log(`       (--ignore-certificate-errors: Electron 41's main-process fetch uses the`);
  console.log(`        Chromium trust store, which does not read the login keychain — the flag`);
  console.log(`        lets the v1 check talk to the local mkcert-signed server)`);
  console.log(`  3. v1 channel: 设置 → 检查更新 → 应提示 ${newVersion} → 下载 → 校验通过 → 打开 DMG`);
  console.log(`  4. v2 channel: 启动后后台自动下载（无需点击）→ 设置页出现「重启并安装」→ 点击`);
  console.log(`  5. stop the server afterwards:  node scripts/test-update-local.mjs --stop`);
  console.log(`     server log: ${SERVER_LOG}`);
  console.log('───────────────────────────────────────────────────────────────────────────────');
}

async function main() {
  if (process.platform !== 'darwin') die('local update verification is macOS-only');
  if (process.arch !== 'arm64') die('local update verification currently targets arm64 only');

  const args = parseArgs(process.argv.slice(2));
  if (args.stop) { stopServer(); return; }

  if (args.status) {
    if (!fs.existsSync(PID_FILE)) die('no running server (run the driver first)');
    const oldVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const health = await httpsJson(args.port, '/healthz');
    const latest = await httpsJson(args.port, '/updates/latest', {
      'CogSeed-App-Version': oldVersion,
      'CogSeed-Platform': 'darwin',
      'CogSeed-Arch': 'arm64',
    });
    const feed = await httpsJson(args.port, '/updates/feed/mac-arm64');
    console.log(JSON.stringify({ health, latest, feed }, null, 2));
    return;
  }

  ensureVerifyDir();
  stopServer();
  wipeScratch();
  ensureVerifyDir();
  packageOldApp(args.skipPackage);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const newVersion = args.newVersion || bumpPatch(pkg.version);
  const artifacts = buildNewArtifacts(newVersion, args.notes || '本地验证发布');
  const tls = ensureTls();

  if (args.foreground) {
    console.log(`[test-update-local] running server in foreground (Ctrl-C to stop)`);
    const result = spawnSync(process.execPath, [SERVER_PATH], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: String(args.port),
        UPDATES_CATALOG: CATALOG_PATH,
        UPDATES_SERVER_PUBLIC_BASE: `https://127.0.0.1:${args.port}`,
        TLS_KEY: tls.keyPath,
        TLS_CERT: tls.certPath,
      },
    });
    process.exit(result.status ?? 1);
  }

  const pid = startServer({ port: args.port });
  console.log(`[test-update-local] updates server started (pid ${pid}) → https://127.0.0.1:${args.port}`);
  await waitHealthy(args.port);
  await runAssertions({ port: args.port, ...artifacts, newVersion, oldVersion: artifacts.oldVersion });
  if (failures > 0) {
    console.error(`[test-update-local] ${failures} assertion(s) failed — see above`);
    process.exit(1);
  }
  console.log(`[test-update-local] all contract assertions passed (old ${artifacts.oldVersion} → new ${newVersion})`);
  printNextSteps({ port: args.port, oldVersion: artifacts.oldVersion, newVersion, caPath: tls.caPath });
}

main().catch((error) => {
  console.error(`[test-update-local] ${error.stack || error.message || error}`);
  process.exit(1);
});
