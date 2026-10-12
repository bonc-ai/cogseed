import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const zipBinary = require('7zip-bin').path7za;
const archiveFixture = 'QlpoOTFBWSZTWQOdcqQAAVV9gMqgDABEA/+gAAJv/99QSAgwARgBgZBkABiNBkMgMMDIMgAMRoMhkBgVKTU0TT02ooeU8kfpNRoD2qemU8dpntKyhT8yglL0kjj8+PHR1LjAXmJ5mkRQKDoU9D7z2OZkXTnMZ0N5caj1mfmfUsJiUEZZZNAcyhui6TI1FxQUKVkcOJyixShor5F3opSm+a5eXmZyOZfM5XP2qnIfqK9dUq05nqeDYe8vO5nOhbWaD/FtG43H4PsV7RfJdsktMDF78O04G0sbDCWKSdzyLFS3jvRpMDrwN9C424HgxmElbGsZEP+LuSKcKEgBzrlSAA==';
const roots: string[] = [];
const model = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23';
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function run(mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-fetch-sherpa-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync('scripts/fetch-sherpa-onnx.mjs', path.join(root, 'scripts/fetch-sherpa-onnx.mjs'));
  const fixtureZip = path.join(root, process.platform === 'win32' ? '7za.exe' : '7za');
  if (mode === 'windows-real') {
    fs.copyFileSync(zipBinary, fixtureZip);
    fs.chmodSync(fixtureZip, 0o755);
  }
  const preload = path.join(root, 'boundaries.cjs');
  // Real output streams retain their close lifecycle. The tar boundary enforces
  // Windows' requirement that the writer has released the archive before use.
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const https = require('node:https');
    const cp = require('node:child_process');
    const { EventEmitter } = require('node:events');
    const { Readable } = require('node:stream');
    const mode = process.env.COGSEED_SHERPA_TEST_MODE;
    const windows = mode.startsWith('windows-') || process.platform === 'win32';
    const real = mode === 'windows-real';
    const realSpawn = cp.spawnSync;
    const nativeTarOnHost = process.platform === 'win32'
      ? path.win32.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(id, ...args) {
      if (id === '7zip-bin') return { path7za: real ? ${JSON.stringify(fixtureZip)} : 'fixture-7za' };
      return load.call(this, id, ...args);
    };
    let openWriters = 0;
    const createWriteStream = fs.createWriteStream;
    fs.createWriteStream = (...args) => {
      openWriters++;
      const stream = createWriteStream(...args);
      stream.once('close', () => openWriters--);
      return stream;
    };
    https.get = (url, options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = error => req.emit('error', error);
      setImmediate(() => {
        let response;
        if (mode === 'redirect' && !String(url).endsWith('/archive')) {
          if (openWriters) throw new Error('redirect must not open the destination');
          response = Readable.from([]);
          response.statusCode = 302;
          response.headers = { location: '/archive' };
        } else if (mode === 'interrupted') {
          response = new Readable({ read() { this.destroy(new Error('connection reset')); } });
          response.statusCode = 200;
          response.headers = {};
        } else {
          response = Readable.from([real ? Buffer.from(${JSON.stringify(archiveFixture)}, 'base64') : 'fixture archive']);
          response.statusCode = mode === 'http-error' ? 403 : 200;
          response.headers = {};
        }
        callback(response);
      });
      return req;
    };
    cp.spawnSync = (command, args, options) => {
      if (openWriters) throw new Error('archive writer is still open at extraction');
      if (windows && (command === 'fixture-7za' || command === ${JSON.stringify(fixtureZip)})) {
        if (mode === 'windows-bzip-error') return { status: 2 };
        if (real) return realSpawn(command, args, options);
        const out = args.find(arg => arg.startsWith('-o')).slice(2);
        fs.writeFileSync(path.join(out, path.basename(args[1], '.bz2')), 'plain tar');
        return { status: 0 };
      }
      if (windows) {
        const nativeTar = path.win32.join(process.env.SystemRoot, 'System32', 'tar.exe');
        if (!args[1].endsWith('.tar')) throw new Error('Windows tar must only receive uncompressed tar');
        if (command !== nativeTar) throw new Error('Windows tar must not resolve through PATH');
        if (path.isAbsolute(args[1]) || args[1].includes(':')) throw new Error('archive must use a local relative name');
        if (!fs.existsSync(path.join(options.cwd, args[1]))) throw new Error('archive cwd is incorrect');
        if (options.stdio[0] !== 'ignore') throw new Error('tar stdin must be closed');
        if (!(options.timeout > 0)) throw new Error('tar must have a bounded timeout');
      }
      if (mode === 'extract-timeout') return { status: null, error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
      if (mode === 'extract-error' || mode === 'windows-tar-error') return { status: 2 };
      if (real) return realSpawn(nativeTarOnHost, args, options);
      const dir = path.join(args[args.indexOf('-C') + 1], ${JSON.stringify(model)});
      fs.mkdirSync(dir, { recursive: true });
      for (const name of ['encoder-epoch-99-avg-1.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.onnx', 'tokens.txt']) {
        fs.writeFileSync(path.join(dir, name), 'fixture model');
      }
      return { status: 0 };
    };
    if (windows) {
      process.env.SystemRoot = 'C:\\Windows';
      Object.defineProperty(process, 'platform', { value: 'win32' });
    }
  `);
  const result = spawnSync(process.env.COGSEED_TEST_NODE || process.execPath, [
    '--require', preload, path.join(root, 'scripts/fetch-sherpa-onnx.mjs'),
  ], { cwd: root, env: { ...process.env, COGSEED_SHERPA_TEST_MODE: mode }, encoding: 'utf8', timeout: 15000 });
  return { result, resourceRoot: path.join(root, 'resources/sherpa-onnx') };
}

describe('fetch-sherpa-onnx CLI', () => {
  it.each(['direct', 'redirect', 'windows-tar', 'windows-real'])('closes the archive before extracting after a %s download', (mode) => {
    const { result, resourceRoot } = run(mode);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ready at');
    expect(fs.readdirSync(resourceRoot)).toEqual([model]);
  });

  it.each([
    ['interrupted', /connection reset/],
    ['http-error', /HTTP 403/],
    ['extract-error', /tar extraction failed/],
    ['extract-timeout', /ETIMEDOUT/],
    ['windows-bzip-error', /7zip extraction failed/],
    ['windows-tar-error', /tar extraction failed/],
  ])('fails and removes the partial archive after %s', (mode, error) => {
    const { result, resourceRoot } = run(String(mode));
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(error);
    expect(fs.readdirSync(resourceRoot)).toEqual([]);
  });
});
