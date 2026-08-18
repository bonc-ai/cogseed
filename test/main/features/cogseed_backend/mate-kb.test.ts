import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'mate-kb-user-a';
const USER_B = 'mate-kb-user-b';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-kb-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeVectorStore() {
  const indexed = new Map<string, string>();
  return {
    indexed,
    async vectorize(id: string, input: { buf: Buffer }) { indexed.set(id, input.buf.toString('utf8')); return 1; },
    async searchByQuery(query: string) {
      return Array.from(indexed.entries()).filter(([, content]) => content.includes(query)).map(([rel_path, content]) => ({ file_id: 1, rel_path, kind: 'text', chunk_idx: 0, title: rel_path, content, score: 1, distance: 0 }));
    },
    close() {},
  };
}

describe('CogSeed-owned KB adapter', () => {
  it('indexes and searches CogSeed sources under CogSeed-only cloud/local paths', async () => {
    const kb = await import('../../../../src/main/features/cogseed_backend/mate-kb-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const vector = fakeVectorStore();
    const vectors = new Map<string, ReturnType<typeof fakeVectorStore>>();
    const manager = kb.createMateKbManager({ vectorStoreFactory: (uid) => { const existing = vectors.get(uid); if (existing) return existing; const created = uid === USER_A ? vector : fakeVectorStore(); vectors.set(uid, created); return created; } });

    const source = await manager.indexText(USER_A, { sourceId: 'mate-source-notes', title: 'Notes', content: 'CogSeed-only connector notes' });
    expect(source).toMatchObject({ sourceId: 'mate-source-notes', title: 'Notes', bytes: Buffer.byteLength('CogSeed-only connector notes', 'utf8') });
    expect(paths.mateKbSourceFile(USER_A, source.sourceId)).toContain(`${path.sep}cloud${path.sep}mate_agent${path.sep}kb${path.sep}`);
    expect(paths.mateKbVectorDir(USER_A)).toContain(`${path.sep}local${path.sep}mate_agent${path.sep}kb${path.sep}`);
    await expect(manager.search(USER_A, 'connector')).resolves.toEqual([expect.objectContaining({ rel_path: 'mate-source-notes', content: 'CogSeed-only connector notes' })]);
    await expect(manager.search(USER_B, 'connector')).resolves.toEqual([]);
  });

  it('does not expose Orkas KB source paths or accept unsafe source ids', async () => {
    const kb = await import('../../../../src/main/features/cogseed_backend/mate-kb-store');
    const manager = kb.createMateKbManager({ vectorStoreFactory: () => fakeVectorStore() });
    await expect(manager.indexText(USER_A, { sourceId: '../escape', title: 'bad', content: 'bad' })).rejects.toThrow(/source/i);
  });
});
