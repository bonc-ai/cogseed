import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const embeds = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock('../../../../src/main/features/recall/similarity', () => ({
  embedForDedup: async (_userId: string, text: string) => {
    embeds.texts.push(text);
    return [text.length, text.charCodeAt(0) || 0];
  },
}));

let root: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  embeds.texts = [];
  previous = process.env.COGSEED_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-catalog-vectors-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('catalog vector cache', () => {
  it('reuses unchanged asset vectors, invalidates changed profiles, and prunes deleted assets', async () => {
    const cache = await import('../../../../src/main/features/recall/catalog-vector-cache');
    const first = await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-one', text: 'first private profile' }]);
    expect(first.byId.get('aa-one')).toEqual([21, 102]);
    await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-one', text: 'first private profile' }]);
    expect(embeds.texts.filter((text) => text === 'first private profile')).toHaveLength(1);
    await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-one', text: 'changed private profile' }]);
    expect(embeds.texts.filter((text) => text === 'changed private profile')).toHaveLength(1);
    const file = path.join(root, 'vectoruser', 'local', 'cache', 'recall', 'catalog-vectors.json');
    const persisted = fs.readFileSync(file, 'utf8');
    expect(persisted).not.toContain('private profile');
    expect(JSON.parse(persisted).entries['aa-one']).toBeTruthy();
    await cache.pruneCatalogVectors('vectoruser', new Set());
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries['aa-one']).toBeUndefined();
  });
});
