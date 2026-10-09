import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensurePrivateDirectoryWithin } from '../../../src/main/util/private-directory';

let trustedRoot = '';
let outsideRoot = '';

beforeEach(() => {
  trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-private-root-'));
  outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-private-outside-'));
});

afterEach(() => {
  fs.rmSync(trustedRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
});

describe('ensurePrivateDirectoryWithin', () => {
  it('creates and revalidates every private directory below the trusted root', () => {
    const requested = path.join(trustedRoot, 'user-1', 'local', 'expense-workbench');

    expect(ensurePrivateDirectoryWithin(trustedRoot, requested, 'private data'))
      .toBe(fs.realpathSync(requested));
    expect(ensurePrivateDirectoryWithin(trustedRoot, requested, 'private data'))
      .toBe(fs.realpathSync(requested));

    if (process.platform !== 'win32') {
      for (const directory of [
        trustedRoot,
        path.join(trustedRoot, 'user-1'),
        path.join(trustedRoot, 'user-1', 'local'),
        requested,
      ]) {
        expect(fs.statSync(directory).mode & 0o777, directory).toBe(0o700);
      }
    }
  });

  it('rejects the trusted root itself and directories outside that root', () => {
    expect(() => ensurePrivateDirectoryWithin(trustedRoot, trustedRoot, 'private data'))
      .toThrow('outside the trusted data root');
    expect(() => ensurePrivateDirectoryWithin(
      trustedRoot,
      path.join(outsideRoot, 'escape'),
      'private data',
    )).toThrow('outside the trusted data root');
  });

  it('validates exported API arguments before touching the filesystem', () => {
    expect(() => ensurePrivateDirectoryWithin(
      'relative-root',
      path.join(trustedRoot, 'private'),
      'private data',
    )).toThrow('absolute paths');
    expect(() => ensurePrivateDirectoryWithin(
      trustedRoot,
      path.join(trustedRoot, 'private'),
      '',
    )).toThrow('label is required');
  });

  it('rejects a regular file in the requested directory chain', () => {
    const blockingFile = path.join(trustedRoot, 'user-1');
    fs.writeFileSync(blockingFile, 'not a directory');

    expect(() => ensurePrivateDirectoryWithin(
      trustedRoot,
      path.join(blockingFile, 'local', 'expense-workbench'),
      'private data',
    )).toThrow('non-directory entries');
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink used as the trusted root itself', () => {
    const linkedRoot = `${trustedRoot}-link`;
    fs.symlinkSync(trustedRoot, linkedRoot, 'dir');
    try {
      expect(() => ensurePrivateDirectoryWithin(
        linkedRoot,
        path.join(linkedRoot, 'private'),
        'private data',
      )).toThrow('symbolic links');
    } finally {
      fs.unlinkSync(linkedRoot);
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked parent before writing through it', () => {
    const plantedParent = path.join(trustedRoot, 'user-1');
    fs.symlinkSync(outsideRoot, plantedParent, 'dir');

    expect(() => ensurePrivateDirectoryWithin(
      trustedRoot,
      path.join(plantedParent, 'local', 'expense-workbench'),
      'private data',
    )).toThrow('symbolic links');
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink at the requested directory', () => {
    const parent = path.join(trustedRoot, 'user-1', 'local');
    fs.mkdirSync(parent, { recursive: true });
    const requested = path.join(parent, 'expense-workbench');
    fs.symlinkSync(outsideRoot, requested, 'dir');

    expect(() => ensurePrivateDirectoryWithin(trustedRoot, requested, 'private data'))
      .toThrow('symbolic links');
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('rechecks a path that was replaced after an earlier safe use', () => {
    const parent = path.join(trustedRoot, 'user-1', 'local');
    const requested = path.join(parent, 'expense-workbench');
    ensurePrivateDirectoryWithin(trustedRoot, requested, 'private data');
    fs.rmSync(parent, { recursive: true });
    fs.symlinkSync(outsideRoot, parent, 'dir');

    expect(() => ensurePrivateDirectoryWithin(trustedRoot, requested, 'private data'))
      .toThrow('symbolic links');
    expect(fs.readdirSync(outsideRoot)).toEqual([]);
  });
});
