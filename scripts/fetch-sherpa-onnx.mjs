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
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

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
    const req = https.get(url, { headers: { 'User-Agent': 'cogseed-postinstall' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(new URL(res.headers.location, url).href, outPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
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
      // Wait for close, not just finish: synchronous tar must not run while
      // Windows still holds the archive writer. pipeline also propagates a
      // response abort and closes both streams before partial-file cleanup.
      pipeline(res, fs.createWriteStream(outPath)).then(() => {
        process.stdout.write('\n');
        resolve();
      }, (err) => {
        fs.rmSync(outPath, { force: true });
        reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => { req.destroy(new Error('timeout')); });
  });
}

function runExtraction(command, args, cwd, label) {
  const r = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 120_000,
  });
  if (r.error) throw new Error(`${label} extraction failed (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`${label} extraction failed (exit ${r.status}, signal ${r.signal || 'none'})`);
}

function extract(tarball, dstDir) {
  console.log(`[sherpa-onnx] extracting ${path.basename(tarball)}`);
  if (process.platform !== 'win32') {
    runExtraction('tar', ['-xf', path.basename(tarball), '-C', dstDir], path.dirname(tarball), 'tar');
    return;
  }

  // Windows bsdtar's external bzip2 pipe can stall even after the archive is
  // closed. Reuse the existing 7zip-bin build dependency to decompress first;
  // native tar then reads an ordinary local tar file without a filter process.
  const staging = fs.mkdtempSync(path.join(dstDir, '.sherpa-extract-'));
  try {
    const { path7za } = createRequire(import.meta.url)('7zip-bin');
    runExtraction(path7za, ['e', path.basename(tarball), `-o${staging}`, '-y', '-bd'], path.dirname(tarball), '7zip');
    const plainTar = path.basename(tarball, '.bz2');
    if (!fs.existsSync(path.join(staging, plainTar))) throw new Error('7zip extraction did not produce the tar archive');
    const tar = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    runExtraction(tar, ['-xf', plainTar, '-C', dstDir], staging, 'tar');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
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
