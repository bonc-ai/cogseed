/**
 * anchor-resolver (COGSEED-39 ② P1) — citation anchor → char-level position.
 *
 * Hermetic tests with a temp workspace root: insert a Library text file,
 * then resolve an anchor and assert exact char ranges, fuzzy locating,
 * out-of-scope rejection, and cache-less rich-doc degradation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'anchor';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-anchor-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const kb = await import('../../../../src/main/features/kb_vector');
    kb.closeAllKb();
  } catch { /* ignore */ }
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Stage a plain-text Library file and vectorize it (ready status). */
async function stageLibraryFile(relPath: string, content: string) {
  const { userContextsDir } = await import('../../../../src/main/paths');
  const dir = userContextsDir(TEST_UID);
  fs.mkdirSync(path.join(dir, path.dirname(relPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, relPath), content);
  const kb = await import('../../../../src/main/features/kb_vector');
  const chunks = [{
    title: 'c1',
    content: 'alpha one two three',
    embedding: new Array(512).fill(0),
  }, {
    title: 'c2',
    content: 'beta four five six',
    embedding: new Array(512).fill(0),
  }];
  await kb.upsertFile(TEST_UID, {
    relPath,
    kind: 'text',
    bytes: content.length,
    mtime: 1,
    sha1: relPath,
    chunks,
  });
}

describe('anchor_resolver', () => {
  it('resolves a library chunk anchor to the exact char range', async () => {
    const mod = await import('../../../../src/main/model/core-agent/anchor-resolver');
    // "alpha one two three" appears verbatim in the file.
    await stageLibraryFile('notes/a.md', 'prefix text\n\nalpha one two three\nsuffix text');

    const res = await mod.resolveAnchor({
      userId: TEST_UID,
      source: 'library',
      scope: 'global',
      path: 'notes/a.md',
      chunkIdx: 1,
    });

    expect(res.resolved).toBe(true);
    const expected = 'prefix text\n\nalpha one two three\nsuffix text'.indexOf('alpha one two three');
    expect(res.charStart).toBe(expected);
    expect(res.charEnd).toBe(expected + 'alpha one two three'.length);
    expect(res.text).toContain('alpha one two three');
    expect(res.totalChars).toBeGreaterThan(0);
  });

  it('locates via quote when the chunk text is not verbatim (whitespace/approx)', async () => {
    const mod = await import('../../../../src/main/model/core-agent/anchor-resolver');
    await stageLibraryFile('notes/b.md', 'intro\n\nbeta four five six\noutro');

    const res = await mod.resolveAnchor({
      userId: TEST_UID,
      source: 'library',
      scope: 'global',
      path: 'notes/b.md',
      chunkIdx: 2,
      quote: 'beta four',
    });

    expect(res.resolved).toBe(true);
    expect(res.charStart).toBe('intro\n\nbeta four five six\noutro'.indexOf('beta four'));
  });

  it('rejects an out-of-scope path', async () => {
    const mod = await import('../../../../src/main/model/core-agent/anchor-resolver');
    await stageLibraryFile('notes/a.md', 'alpha one two three');

    const res = await mod.resolveAnchor({
      userId: TEST_UID,
      source: 'library',
      scope: 'global',
      path: '../outside.md',
      chunkIdx: 1,
    });

    expect(res.resolved).toBe(false);
    expect(res.reason).toBe('out_of_scope'); // path traversal escapes the contexts root
  });

  it('returns no_cache for a rich doc without a file-indexer cache entry', async () => {
    const mod = await import('../../../../src/main/model/core-agent/anchor-resolver');
    const { userContextsDir } = await import('../../../../src/main/paths');
    const dir = userContextsDir(TEST_UID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'doc.pdf'), '%PDF-1.4 not really a pdf');
    // No file-indexer cache for the pdf → no_cache, not an error.
    const res = await mod.resolveAnchor({
      userId: TEST_UID,
      source: 'library',
      scope: 'global',
      path: 'doc.pdf',
      chunkIdx: 1,
      quote: 'anything',
    });
    expect(res.resolved).toBe(false);
    expect(res.reason).toBe('no_cache');
  });

  it('returns bad_input for an attachment without a cid', async () => {
    const mod = await import('../../../../src/main/model/core-agent/anchor-resolver');
    const res = await mod.resolveAnchor({
      userId: TEST_UID,
      source: 'attachment',
      scope: 'conversation',
      path: 'notes.txt',
      chunkIdx: 0,
      quote: 'x',
    });
    expect(res.resolved).toBe(false);
    expect(res.reason).toBe('bad_input');
  });
});
