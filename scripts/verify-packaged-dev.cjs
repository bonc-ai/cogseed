#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listPackage, extractFile } = require('@electron/asar');
const { expectedDevAppPath } = require('./package-dev-mac.cjs');
const { launchPackagedSmoke, verifySmokeMarker } = require('./verify-packaged-launch.cjs');

const ROOT = path.resolve(__dirname, '..');
const ASAR_REQUIRED = Object.freeze([
  'package.json',
  'bootstrap.cjs',
  'src/main/install-data-root.cjs',
  '.build/build-info.json',
  'src/main/index.ts',
  'src/main/util/image-transform.ts',
  'src/renderer/modules/agents.js',
  // 飞书图片链（G-17）的 webp 解码器 wasm：asarUnpack 后 asar 头中仍保留
  // 条目（内容指向 unpacked 树）——缺失=发布版图片功能必坏，打包校验必须拦下。
  'node_modules/@jsquash/webp/codec/dec/webp_dec.wasm',
]);
const RESOURCE_REQUIRED = Object.freeze([
  ['builtin', '_manifest.json'],
  ['runtime', 'manifest.json'],
  ['officecli', 'officecli-mac-arm64'],
]);

function normalizeAsarEntry(entry) {
  return String(entry || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function verifyPackagedDevBundle(appPath, options = {}) {
  const errors = [];
  const exists = options.exists || fs.existsSync;
  const resources = path.join(appPath, 'Contents', 'Resources');
  const asarPath = path.join(resources, 'app.asar');
  if (!exists(appPath)) errors.push(`missing app bundle: ${appPath}`);
  if (!exists(asarPath)) errors.push(`missing app.asar: ${asarPath}`);

  let entries = new Set();
  const listAsar = options.listAsar || listPackage;
  if (exists(asarPath)) {
    try { entries = new Set(listAsar(asarPath).map(normalizeAsarEntry)); }
    catch (error) { errors.push(`cannot list app.asar: ${error.message || error}`); }
  }
  for (const required of ASAR_REQUIRED) {
    if (!entries.has(required)) errors.push(`missing app.asar entry: ${required}`);
  }
  // PR209 评审 M11：wasm 校验升级——asar 头条目存在不等于打包态可加载。
  // ①校验 asarUnpack 后的物理文件真实存在于 app.asar.unpacked 树；
  // ②用 new WebAssembly.Module 真编译字节（坏的/被裁剪的 wasm 立刻暴露）。
  for (const wasmEntry of ASAR_REQUIRED.filter((e) => e.endsWith('.wasm'))) {
    const unpackedPath = path.join(resources, 'app.asar.unpacked', wasmEntry);
    if (!exists(unpackedPath)) {
      errors.push(`missing unpacked wasm file: ${wasmEntry}`);
      continue;
    }
    try {
      const wasmBytes = (options.readUnpackedFile || ((p) => fs.readFileSync(p)))(unpackedPath);
      new WebAssembly.Module(wasmBytes);
    } catch (error) {
      errors.push(`uncompilable wasm (packaged corrupt?): ${wasmEntry}: ${error.message || error}`);
    }
  }
  for (const parts of RESOURCE_REQUIRED) {
    const requiredPath = path.join(resources, ...parts);
    if (!exists(requiredPath)) errors.push(`missing packaged resource: ${parts.join('/')}`);
  }

  let identity = null;
  if (entries.has('.build/build-info.json')) {
    try {
      const readAsarFile = options.readAsarFile || extractFile;
      identity = JSON.parse(Buffer.from(readAsarFile(asarPath, '.build/build-info.json')).toString('utf8'));
    } catch (error) { errors.push(`invalid .build/build-info.json: ${error.message || error}`); }
  }
  if (!identity || identity.channel !== 'packaged-dev') errors.push('build identity channel must be packaged-dev');
  if (!identity || !String(identity.commit || '').trim()) errors.push('build identity commit is missing');
  return { ok: errors.length === 0, errors, appPath, asarPath, identity };
}

async function launchSmoke(appPath) {
  const executable = path.join(appPath, 'Contents', 'MacOS', 'CogSeed Dev');
  if (!fs.existsSync(executable)) throw new Error(`missing packaged executable: ${executable}`);
  return launchPackagedSmoke(executable, { cwd: ROOT });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('verify:package:dev:mac is supported only on macOS');
  const appPath = process.argv[2] ? path.resolve(process.argv[2]) : expectedDevAppPath(ROOT);
  const bundle = verifyPackagedDevBundle(appPath);
  if (!bundle.ok) throw new Error(bundle.errors.join('\n'));
  const marker = await launchSmoke(appPath);
  process.stdout.write(`${JSON.stringify({ ok: true, appPath, identity: bundle.identity, smoke: marker }, null, 2)}\n`);
}

module.exports = { ASAR_REQUIRED, RESOURCE_REQUIRED, verifyPackagedDevBundle, verifySmokeMarker };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[verify-packaged-dev] ${error.message || error}`);
    process.exit(1);
  });
}
