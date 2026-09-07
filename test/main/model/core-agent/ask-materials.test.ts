/**
 * ask-materials (知识库问答 ① Phase 4a) — evidence service thresholds.
 *
 * Uses the same hermetic setup as material-search tests: fake embeddings,
 * mocked embedder, temp workspace root.
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

vi.mock('../../../../src/main/features/kb_embed', () => {
  const q = new Array(512).fill(0);
  q[0] = 1;
  return {
    embedQuery: async () => q,
    embed: async () => [] as number[],
  };
});

function fakeVec(a: number, b = 0, c = 0): number[] {
  const v = new Array(512).fill(0);
  v[0] = a;
  v[1] = b;
  v[2] = c;
  return v;
}

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'askmat';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ask-'));
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

describe('ask_materials', () => {
  it('returns an evidence package with anchors when material matches', async () => {
    const mod = await import('../../../../src/main/model/core-agent/ask-materials');
    await insertFile('notes/alpha.md', [
      { title: 'a1', content: 'The alpha protocol handles authentication tokens for the service.', embedding: fakeVec(1) },
    ]);

    const res = await mod.askMaterials({ userId: TEST_UID, query: 'alpha protocol', k: 5 });

    expect(res.hasEvidence).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].path).toBe('notes/alpha.md');
    const out = mod.formatEvidence(res);
    expect(out).toContain('notes/alpha.md#chunk 1');
    expect(out).toContain('Cite each claim');
  });

  it('marks no_material when nothing matches (empty store)', async () => {
    const mod = await import('../../../../src/main/model/core-agent/ask-materials');
    const res = await mod.askMaterials({ userId: TEST_UID, query: 'anything' });
    expect(res.hasEvidence).toBe(false);
    expect(res.reason).toBe('no_material');
    expect(res.hits).toEqual([]);
    expect(mod.formatEvidence(res)).toContain('No relevant material found');
  });

  it('marks low_confidence when best score is below the threshold but keeps weak hits', async () => {
    const mod = await import('../../../../src/main/model/core-agent/ask-materials');
    await insertFile('notes/alpha.md', [
      { title: 'a1', content: 'The alpha protocol handles authentication tokens for the service.', embedding: fakeVec(1) },
    ]);

    const res = await mod.askMaterials({ userId: TEST_UID, query: 'alpha protocol', k: 5, minScore: 1.0 });

    expect(res.hasEvidence).toBe(false);
    expect(res.reason).toBe('low_confidence');
    expect(res.hits.length).toBeGreaterThan(0);
    expect(mod.formatEvidence(res)).toContain('weak');
  });

  it('includes conversation attachments in the evidence when cid + attachments are set', async () => {
    const mod = await import('../../../../src/main/model/core-agent/ask-materials');
    const { attachmentDirForCid } = await import('../../../../src/main/features/chat_attachments');
    const dir = attachmentDirForCid(TEST_UID, 'conv-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meeting.txt'), 'Standup notes: the ZQX-ATT adapter landed.');

    const res = await mod.askMaterials({
      userId: TEST_UID,
      cid: 'conv-a',
      attachments: true,
      query: 'ZQX-ATT',
      k: 5,
    });

    expect(res.hasEvidence).toBe(true);
    const att = res.hits.find((h) => h.source === 'attachment');
    expect(att).toBeTruthy();
    expect(att!.path).toBe('meeting.txt');
    expect(mod.formatEvidence(res)).toContain('meeting.txt#chunk 0');
  });
});
