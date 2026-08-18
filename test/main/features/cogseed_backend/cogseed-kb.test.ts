import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const USER_A = 'cogseed-kb-user-a';
const USER_B = 'cogseed-kb-user-b';
let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-kb-'));
  previousWorkspaceRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousWorkspaceRoot;
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
    const kb = await import('../../../../src/main/features/cogseed_backend/cogseed-kb-store');
    const paths = await import('../../../../src/main/features/cogseed_backend/paths');
    const vector = fakeVectorStore();
    const vectors = new Map<string, ReturnType<typeof fakeVectorStore>>();
    const manager = kb.createCogSeedKbManager({ vectorStoreFactory: (uid) => { const existing = vectors.get(uid); if (existing) return existing; const created = uid === USER_A ? vector : fakeVectorStore(); vectors.set(uid, created); return created; } });

    const source = await manager.indexText(USER_A, { sourceId: 'cogseed-source-notes', title: 'Notes', content: 'CogSeed-only connector notes' });
    expect(source).toMatchObject({ sourceId: 'cogseed-source-notes', title: 'Notes', bytes: Buffer.byteLength('CogSeed-only connector notes', 'utf8') });
    expect(paths.cogseedKbSourceFile(USER_A, source.sourceId)).toContain(`${path.sep}cloud${path.sep}cogseed${path.sep}kb${path.sep}`);
    expect(paths.cogseedKbVectorDir(USER_A)).toContain(`${path.sep}local${path.sep}cogseed${path.sep}kb${path.sep}`);
    await expect(manager.search(USER_A, 'connector')).resolves.toEqual([expect.objectContaining({ rel_path: 'cogseed-source-notes', content: 'CogSeed-only connector notes' })]);
    await expect(manager.search(USER_B, 'connector')).resolves.toEqual([]);
  });

  it('does not expose CogSeed KB source paths or accept unsafe source ids', async () => {
    const kb = await import('../../../../src/main/features/cogseed_backend/cogseed-kb-store');
    const manager = kb.createCogSeedKbManager({ vectorStoreFactory: () => fakeVectorStore() });
    await expect(manager.indexText(USER_A, { sourceId: '../escape', title: 'bad', content: 'bad' })).rejects.toThrow(/source/i);
  });
});
