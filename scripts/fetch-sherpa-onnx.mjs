#!/usr/bin/env node
/**
 * Ensure the sherpa-onnx streaming Zipformer (zh-14M) ASR model is present at
 * `resources/sherpa-onnx/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/`.
 * Downloads the official release tarball and extracts in place. Idempotent:
 * if the expected files already exist, exit 0.
 *
 * The binary is gitignored (~55MB, too big for git); this script is wired
 * into `ensure-dev-dependencies.cjs` so clone → `npm install` → dev-ready.
 * Offline-tolerant: a download failure is OK when the files are already there.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '..');

const MODEL_ID = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
const destDir = path.join(pcRoot, 'resources', 'sherpa-onnx');
const modelDir = path.join(destDir, MODEL_ID);
const REQUIRED = [
  'encoder-epoch-99-avg-1.onnx',
  'decoder-epoch-99-avg-1.onnx',
  'joiner-epoch-99-avg-1.onnx',
  'tokens.txt',
];
// 官方 GitHub release（GitHub 慢时可把此 URL 换成 hf-mirror.com 镜像）。
const tarballUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ID}.tar.bz2`;
const tarballPath = path.join(destDir, `${MODEL_ID}.tar.bz2`);

function allFilesPresent() {
  return REQUIRED.every((f) => fs.existsSync(path.join(modelDir, f)));
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    const req = https.get(url, { headers: { 'User-Agent': 'cogseed-postinstall' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close();
        fs.rmSync(outPath, { force: true });
        download(res.headers.location, outPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        fs.rmSync(outPath, { force: true });
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let done = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        done += chunk.length;
        if (total) {
          const pct = Math.floor((done / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`\r  ${MODEL_ID}: ${pct}% (${(done / 1024 / 1024).toFixed(1)}MB)`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
      file.on('error', (err) => { file.close(); fs.rmSync(outPath, { force: true }); reject(err); });
    });
    req.on('error', (err) => {
      file.close();
      fs.rmSync(outPath, { force: true });
      reject(err);
    });
    req.setTimeout(120_000, () => { req.destroy(new Error('timeout')); });
  });
}

function extract(tarball, dstDir) {
  // .tar.bz2 — 系统 tar（macOS / Linux / WSL / 现代 Windows 都有）。
  const r = spawnSync('tar', ['-xjf', tarball, '-C', dstDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar extraction failed (exit ${r.status})`);
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });

  if (allFilesPresent()) {
    console.log(`[sherpa-onnx] already present at ${modelDir}, skipping`);
    return;
  }

  console.log(`[sherpa-onnx] fetching ${tarballUrl}`);
  try {
    await download(tarballUrl, tarballPath);
    fs.rmSync(modelDir, { recursive: true, force: true });
    extract(tarballPath, destDir);
    fs.rmSync(tarballPath, { force: true });
  } catch (err) {
    fs.rmSync(tarballPath, { force: true });
    if (allFilesPresent()) {
      console.warn(`[sherpa-onnx] download failed but files already present: ${err.message}`);
      return;
    }
    throw err;
  }

  if (!allFilesPresent()) throw new Error(`extraction did not produce expected files in ${modelDir}`);
  console.log(`[sherpa-onnx] ready at ${modelDir}`);
}

main().catch((err) => {
  console.error(`[sherpa-onnx] ERROR: ${err.message}`);
  process.exit(1);
});
