import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
  searchAll: vi.fn(),
  getContextIndexEntries: vi.fn(() => []),
}));

import { collectImportableFilesFromDir } from '../../../src/main/features/contexts';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-folder-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectImportableFilesFromDir', () => {
  it('collects whitelisted files recursively, skipping hidden/ignored/unsupported', async () => {
    const src = path.join(tmpDir, '素材');
    fs.mkdirSync(path.join(src, '子目录'), { recursive: true });
    fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true });
    const files = [
      ['a.md', '文本'],
      ['b.pdf', '%PDF-fake'],
      ['c.exe', 'binary'],
      ['.hidden.md', 'hidden'],
      ['node_modules/y.md', 'ignored'],
      ['子目录/x.ts', 'code'],
      ['子目录/.h.ts', 'hidden'],
    ];
    for (const [rel, content] of files) {
      fs.writeFileSync(path.join(src, rel), content, 'utf8');
    }

    const got = await collectImportableFilesFromDir(src);
    expect(got.map((f) => f.rel)).toEqual(['a.md', 'b.pdf', '子目录/x.ts']);
    expect(got[0].abs).toBe(path.join(src, 'a.md'));
    expect(got[2].abs).toBe(path.join(src, '子目录', 'x.ts'));
  });

  it('handles an empty or missing directory gracefully', async () => {
    const empty = path.join(tmpDir, 'empty');
    fs.mkdirSync(empty);
    expect(await collectImportableFilesFromDir(empty)).toEqual([]);
    expect(await collectImportableFilesFromDir(path.join(tmpDir, 'missing'))).toEqual([]);
  });
});
