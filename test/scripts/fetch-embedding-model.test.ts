import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { verifyEmbeddingModelRoot } = require('../../bin/packaged-resource-gate.cjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-fetch-model-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.copyFileSync('scripts/fetch-embedding-model.mjs', path.join(root, 'scripts/fetch-embedding-model.mjs'));
  for (const file of ['packaged-resource-gate.cjs', 'runtime-gate.cjs']) {
    fs.copyFileSync(path.join('bin', file), path.join(root, 'bin', file));
  }
  const preload = path.join(root, 'network.cjs');
  // Replace only the HTTPS boundary. Real pinned bytes and production verifiers
  // exercise the CLI's installation and integrity behavior without live HTTP.
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const https = require('node:https');
    const { EventEmitter } = require('node:events');
    const { Readable } = require('node:stream');
    https.get = (url, options, callback) => {
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = error => req.emit('error', error);
      setImmediate(() => {
        const redirectTarget = String(url) === 'https://huggingface.co/pinned-config.json';
        const isFallback = redirectTarget || String(url).startsWith(
          'https://huggingface.co/Qdrant/bge-small-zh-v1.5/resolve/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59/'
        );
        const name = redirectTarget ? 'config.json' : path.basename(new URL(url).pathname);
        const source = path.join(process.env.COGSEED_MODEL_FIXTURE_DIR, name);
        let response;
        if (name === 'config.json' && !redirectTarget && process.env.COGSEED_MODEL_TEST_MODE === 'redirect') {
          response = Readable.from([]);
          response.statusCode = 302;
          response.headers = { location: '/pinned-config.json' };
        } else if (!isFallback || (process.env.COGSEED_MODEL_TEST_MODE === 'missing' && name === 'vocab.txt')) {
          const badArchive = !isFallback && process.env.COGSEED_MODEL_TEST_MODE === 'bad-archive';
          response = Readable.from([badArchive ? 'not the pinned archive' : 'AccessDenied']);
          response.statusCode = badArchive ? 200 : 403;
          response.headers = {};
        } else if (name === 'config.json' && process.env.COGSEED_MODEL_TEST_MODE === 'corrupt') {
          const bytes = fs.readFileSync(source);
          bytes[0] ^= 1;
          response = Readable.from([bytes]);
          response.statusCode = 200;
          response.headers = { 'content-length': bytes.length };
        } else if (name === 'config.json' && process.env.COGSEED_MODEL_TEST_MODE === 'interrupted') {
          response = new Readable({ read() { this.destroy(new Error('connection reset')); } });
          response.statusCode = 200;
          response.headers = {};
        } else {
          response = fs.createReadStream(source);
          response.statusCode = 200;
          response.headers = { 'content-length': fs.statSync(source).size };
        }
        callback(response);
      });
      return req;
    };
  `);
  return { root, preload, resourceRoot: path.join(root, 'resources/embedding-model') };
}

function run(root: string, preload: string, mode = '') {
  return spawnSync(process.env.COGSEED_TEST_NODE || process.execPath, [
    '--require', preload, path.join(root, 'scripts/fetch-embedding-model.mjs'),
  ], {
    cwd: root,
    env: {
      ...process.env,
      COGSEED_MODEL_FIXTURE_DIR: path.resolve('resources/embedding-model/fast-bge-small-zh-v1.5'),
      COGSEED_MODEL_TEST_MODE: mode,
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('fetch-embedding-model CLI', () => {
  it('installs the same pinned model when the archive source returns 403', () => {
    const { root, preload, resourceRoot } = fixture();
    const result = run(root, preload);
    expect(result.status, result.stderr).toBe(0);
    expect(verifyEmbeddingModelRoot(resourceRoot))
      .toBe('resource:embedding-model:fast-bge-small-zh-v1.5');
  });

  it('follows a relative redirect from the pinned fallback source', () => {
    const { root, preload, resourceRoot } = fixture();
    const result = run(root, preload, 'redirect');
    expect(result.status, result.stderr).toBe(0);
    expect(verifyEmbeddingModelRoot(resourceRoot))
      .toBe('resource:embedding-model:fast-bge-small-zh-v1.5');
  });

  it.each<[string, RegExp]>([
    ['corrupt', /sha256 mismatch/],
    ['missing', /HTTP 403/],
    ['interrupted', /connection reset/],
  ])('preserves existing files and removes partial staging after a %s fallback', (mode, error) => {
    const { root, preload, resourceRoot } = fixture();
    const oldFile = path.join(resourceRoot, 'fast-bge-small-zh-v1.5/config.json');
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, 'previous incomplete payload');

    const result = run(root, preload, mode);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(error);
    expect(fs.readFileSync(oldFile, 'utf8')).toBe('previous incomplete payload');
    expect(fs.readdirSync(path.join(root, 'resources'))).toEqual(['embedding-model']);
    expect(fs.readdirSync(resourceRoot)).toEqual(['fast-bge-small-zh-v1.5']);
  });

  it('rejects a bad archive instead of concealing the integrity failure with a fallback', () => {
    const { root, preload, resourceRoot } = fixture();
    const result = run(root, preload, 'bad-archive');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/size mismatch/);
    expect(fs.readdirSync(resourceRoot)).toEqual([]);
  });

  it('reuses a verified installation without downloading any files', () => {
    const { root, preload, resourceRoot } = fixture();
    fs.cpSync(path.resolve('resources/embedding-model'), resourceRoot, { recursive: true });
    const result = run(root, preload, 'corrupt');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('already present');
    expect(verifyEmbeddingModelRoot(resourceRoot))
      .toBe('resource:embedding-model:fast-bge-small-zh-v1.5');
  });
});
