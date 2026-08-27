/**
 * material-search (COGSEED-39 ① Phase 2) — hybrid vector + BM25 fusion.
 *
 * Inserts Library files with known fake embeddings (no real embedder), mocks
 * the query embedder to a fixed vector, then asserts:
 *   - fusion: keyword-only term matches still surface (keywordScore set)
 *   - ranking: fused score beats vector-only for an exact-term query
 *   - anchors: scope/path/chunkIdx are populated and correct
 *   - guards: empty query, empty store, k limit
 *
 * Space-scoped retrieval follows the same code path as kb_search (production
 * covered); this unit test keeps global scope to stay hermetic.
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

// Deterministic embedder: the query always embeds to vec(1,0,0), which is
// closest to the "alpha" file's embedding (see fakeVec below).
vi.mock('../../../../src/main/features/kb_embed', () => {
  const q = new Array(512).fill(0);
  q[0] = 1;
  return {
    embedQuery: async () => q,
    embed: async () => [] as number[],
  };
});

// 512-dim vector aligned with `seed` in the first 3 dims (sqlite-vec uses L2).
function fakeVec(a: number, b = 0, c = 0): number[] {
  const v = new Array(512).fill(0);
  v[0] = a;
  v[1] = b;
  v[2] = c;
  return v;
}

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'matsearch';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mat-'));
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

async function insertFile(relPath: string, chunks: Array<{ title: string; content: string; embedding: number[] }>) {
  const kb = await import('../../../../src/main/features/kb_vector');
  await kb.upsertFile(TEST_UID, {
    relPath,
    kind: 'text',
    bytes: 100,
    mtime: 1,
    sha1: relPath,
    chunks,
  });
}

describe('material_search › hybrid fusion', () => {
  it('surfaces an exact-term match (keyword side) that pure vector ranking would miss', async () => {
    const mod = await import('../../../../src/main/model/core-agent/material-search');
    // alpha: vector-closest to the query embedding, but lacks the exact term.
    await insertFile('notes/alpha.md', [
      { title: 'a1', content: 'The alpha protocol handles authentication tokens for the service.', embedding: fakeVec(1) },
    ]);
    // beta: vector-far, but the only file containing the exact term ZQX-4421.
    await insertFile('notes/beta.md', [
      { title: 'b1', content: 'Beta covers the ZQX-4421 revision of the parser grammar end to end.', embedding: fakeVec(9) },
    ]);

    const res = await mod.searchMaterials({ userId: TEST_UID, query: 'ZQX-4421', k: 10 });

    const alpha = res.hits.find((h) => h.path === 'notes/alpha.md');
    const beta = res.hits.find((h) => h.path === 'notes/beta.md');
    expect(alpha).toBeTruthy();
    expect(alpha!.vectorScore).toBeDefined();
    expect(beta).toBeTruthy();
    expect(beta!.keywordScore).toBeDefined();
    // RRF: beta (keyword rank 1 + vector rank 2) outranks alpha (vector rank 1 only).
    expect(beta!.score).toBeGreaterThan(alpha!.score);
  });

  it('populates citation anchors (scope/path/chunkIdx) on every hit', async () => {
    const mod = await import('../../../../src/main/model/core-agent/material-search');
    await insertFile('notes/alpha.md', [
      { title: 'a1', content: 'alpha one', embedding: fakeVec(1) },
      { title: 'a2', content: 'alpha two', embedding: fakeVec(0, 1) },
    ]);

    const res = await mod.searchMaterials({ userId: TEST_UID, query: 'alpha', k: 5 });

    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) {
      expect(h.source).toBe('library');
      expect(h.scope).toBe('global');
      expect(h.path).toMatch(/^notes\/.+\.md$/);
      expect(typeof h.chunkIdx).toBe('number');
      expect(h.snippet.length).toBeGreaterThan(0);
    }
    expect(res.summary.join(' ')).toContain('global total=1 ready=1');
  });

  it('honours the k limit', async () => {
    const mod = await import('../../../../src/main/model/core-agent/material-search');
    await insertFile('notes/alpha.md', [
      { title: 'a1', content: 'alpha one protocol', embedding: fakeVec(1) },
      { title: 'a2', content: 'alpha two protocol', embedding: fakeVec(0, 1) },
    ]);

    const res = await mod.searchMaterials({ userId: TEST_UID, query: 'protocol', k: 1 });
    expect(res.hits.length).toBe(1);
  });

  it('returns no hits for an empty query', async () => {
    const mod = await import('../../../../src/main/model/core-agent/material-search');
    await insertFile('notes/alpha.md', [
      { title: 'a1', content: 'alpha one', embedding: fakeVec(1) },
    ]);

    const res = await mod.searchMaterials({ userId: TEST_UID, query: '   ' });
    expect(res.hits).toEqual([]);
    expect(res.summary.join(' ')).toContain('required');
  });

  it('returns empty hits on an empty store', async () => {
    const mod = await import('../../../../src/main/model/core-agent/material-search');
    const res = await mod.searchMaterials({ userId: TEST_UID, query: 'anything' });
    expect(res.hits).toEqual([]);
    expect(res.summary.join(' ')).toContain('total=0');
  });
});
