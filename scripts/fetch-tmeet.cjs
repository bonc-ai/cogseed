#!/usr/bin/env node
'use strict';

// Build/dev provisioning only: no npm install, postinstall script, or global PATH change.
// Extract native binaries from Tencent's pinned official npm archive after SHA-512 verification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tar = require('tar');
const manifest = require('../bin/tencent-meeting-runtime.cjs');
const defaultRoot = path.resolve(__dirname, '../resources/tencent-meeting');
const hash = (file, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

function assetFor(key) {
  const asset = manifest.assets[key];
  if (!asset) throw new Error(`Tencent Meeting does not ship a CLI for ${key}`);
  return asset;
}
function verify(root, key) {
  const asset = assetFor(key);
  const file = path.join(root, asset.name);
  if (!fs.existsSync(file) || hash(file) !== asset.sha256) throw new Error(`Tencent Meeting ${key}: missing or corrupt binary`);
  if (!fs.existsSync(path.join(root, 'LICENSE'))) throw new Error('Tencent Meeting LICENSE is missing');
  if (!key.startsWith('win32')) fs.accessSync(file, fs.constants.X_OK);
  return file;
}
async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok || !response.body) throw new Error(`Tencent Meeting download HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 30_000_000) throw new Error('Tencent Meeting archive exceeds size limit');
    chunks.push(chunk);
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}
async function provision({ root = defaultRoot, keys = [`${process.platform}-${process.arch}`], archive, check = false, prune = false } = {}) {
  keys.forEach(assetFor);
  const missing = keys.filter((key) => { try { verify(root, key); return false; } catch { return true; } });
  if (check) { keys.forEach((key) => verify(root, key)); return; }
  fs.mkdirSync(root, { recursive: true });
  if (missing.length) {
    const stage = fs.mkdtempSync(path.join(root, '.prepare-'));
    try {
      const source = archive || path.join(stage, 'package.tgz');
      if (!archive) {
        console.log(`[tmeet] preparing official CLI ${manifest.version}`);
        try { await download(manifest.url, source); }
        catch { await download(manifest.mirror, source); }
      }
      if (`sha512-${hash(source, 'sha512', 'base64')}` !== manifest.integrity) throw new Error('Tencent Meeting archive integrity mismatch');
      const allow = new Set(['package/LICENSE', ...missing.map((key) => `package/dist/${assetFor(key).name}`)]);
      await tar.x({ file: source, cwd: stage, strict: true, filter: (name, entry) => allow.has(name) && entry.type === 'File' });
      const packageRoot = path.join(stage, 'package');
      for (const key of missing) {
        const asset = assetFor(key);
        const file = path.join(packageRoot, 'dist', asset.name);
        if (hash(file) !== asset.sha256) throw new Error(`Tencent Meeting ${key}: extracted binary integrity mismatch`);
        fs.chmodSync(file, 0o755);
        fs.rmSync(path.join(root, asset.name), { force: true });
        fs.renameSync(file, path.join(root, asset.name));
      }
      fs.copyFileSync(path.join(packageRoot, 'LICENSE'), path.join(root, 'LICENSE'));
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  keys.forEach((key) => verify(root, key));
  if (prune) {
    const keep = new Set(keys.map((key) => assetFor(key).name));
    for (const asset of Object.values(manifest.assets)) if (!keep.has(asset.name)) fs.rmSync(path.join(root, asset.name), { force: true });
  }
  console.log(`[tmeet] ${manifest.version} verified: ${keys.join(', ')}`);
}
module.exports = { provision, verify, assetFor };
if (require.main === module) {
  const options = { keys: [] };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--platform=')) options.keys.push(arg.slice(11));
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice(7));
    else if (arg.startsWith('--archive=')) options.archive = path.resolve(arg.slice(10));
    else if (arg === '--check') options.check = true;
    else if (arg === '--prune') options.prune = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!options.keys.length) delete options.keys;
  provision(options).catch((error) => { console.error(`[tmeet] ${error.message}`); process.exitCode = 1; });
}
