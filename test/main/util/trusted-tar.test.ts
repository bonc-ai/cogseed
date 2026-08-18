import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Header, type HeaderData } from 'tar';

import {
  assertTrustedTarTree,
  extractTrustedTarGzip,
} from '../../../src/main/util/trusted-tar';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-trusted-tar-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface FixtureEntry extends HeaderData {
  data?: Buffer;
}

function writeTarGzip(name: string, entries: readonly FixtureEntry[]): string {
  const blocks: Buffer[] = [];
  for (const fixture of entries) {
    const data = fixture.data || Buffer.alloc(0);
    const header = new Header({
      mode: fixture.type === 'Directory' ? 0o755 : 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
      ...fixture,
      size: fixture.type === 'File' || fixture.type === 'OldFile' ? data.length : 0,
    });
    const headerBlock = Buffer.alloc(512);
    if (header.encode(headerBlock)) throw new Error(`fixture header requires PAX: ${fixture.path}`);
    blocks.push(headerBlock);
    if (data.length) {
      blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  const archive = path.join(tmpDir, name);
  fs.writeFileSync(archive, zlib.gzipSync(Buffer.concat(blocks)));
  return archive;
}

function destination(name: string): string {
  const result = path.join(tmpDir, name);
  fs.mkdirSync(result);
  return result;
}

describe('trusted tar extraction', () => {
  it('extracts a closed regular-file tree and verifies every extracted byte', () => {
    const archive = writeTarGzip('safe.tar.gz', [
      { path: 'python/', type: 'Directory' },
      { path: 'python/bin/', type: 'Directory' },
      { path: 'python/bin/python3.12', type: 'File', mode: 0o755, data: Buffer.from('runtime') },
      { path: 'python/bin/python3', type: 'SymbolicLink', linkpath: 'python3.12' },
      { path: 'python/lib/os.py', type: 'File', data: Buffer.from('stdlib') },
    ]);
    const output = destination('safe-output');

    const tree = extractTrustedTarGzip(archive, output);

    expect(fs.readFileSync(path.join(output, 'python/bin/python3'), 'utf8')).toBe('runtime');
    expect(fs.readlinkSync(path.join(output, 'python/bin/python3'))).toBe('python3.12');
    expect(() => assertTrustedTarTree(output, tree, { verifyContent: true })).not.toThrow();
    fs.writeFileSync(path.join(output, 'python/lib/os.py'), 'tamper');
    expect(() => assertTrustedTarTree(output, tree, { verifyContent: true })).toThrow(/digest mismatch/);
  });

  it.each([
    ['parent traversal', [{ path: '../outside', type: 'File', data: Buffer.from('x') }]],
    ['absolute path', [{ path: '/outside', type: 'File', data: Buffer.from('x') }]],
    ['escaping symlink', [{ path: 'python', type: 'SymbolicLink', linkpath: '../../outside' }]],
    ['hard link', [
      { path: 'python', type: 'File', data: Buffer.from('x') },
      { path: 'python-hardlink', type: 'Link', linkpath: 'python' },
    ]],
    ['file used as a directory', [
      { path: 'python', type: 'File', data: Buffer.from('x') },
      { path: 'python/bin', type: 'File', data: Buffer.from('y') },
    ]],
  ] as const)('rejects %s entries before extraction', (_label, entries) => {
    const archive = writeTarGzip('unsafe.tar.gz', entries);
    const output = destination('unsafe-output');

    expect(() => extractTrustedTarGzip(archive, output)).toThrow(/Unsafe trusted runtime archive/);
    expect(fs.readdirSync(output)).toEqual([]);
  });

  it('rejects duplicate archive paths before extraction', () => {
    const archive = writeTarGzip('duplicate.tar.gz', [
      { path: 'python', type: 'File', data: Buffer.from('first') },
      { path: 'python', type: 'File', data: Buffer.from('second') },
    ]);
    const output = destination('duplicate-output');

    expect(() => extractTrustedTarGzip(archive, output)).toThrow(/duplicate entry path/);
    expect(fs.readdirSync(output)).toEqual([]);
  });
});
