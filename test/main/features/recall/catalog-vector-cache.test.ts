import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const embeds = vi.hoisted(() => ({ texts: [] as string[], gates: new Map<string, Promise<void>>() }));
vi.mock('../../../../src/main/features/recall/similarity', () => ({
  embedForDedup: async (_userId: string, text: string) => {
    embeds.texts.push(text);
    const gate = embeds.gates.get(text);
    if (gate) await gate;
    return [text.length, text.charCodeAt(0) || 0];
  },
}));

let root: string;
let previous: string | undefined;

beforeEach(() => {
  vi.resetModules();
  embeds.texts = [];
  embeds.gates.clear();
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
  it('six-node closure: invalidates a changed tail and keeps full task and boundary profiles in catalog lookup', async () => {
    const { catalogAssetProfile, catalogMatches } = await import('../../../../src/main/features/recall/catalog-relevance');
    const cache = await import('../../../../src/main/features/recall/catalog-vector-cache');
    const prefix = 'shared introduction '.repeat(160);
    const profile = catalogAssetProfile({ id: 'aa-long', title: 'Project guidance', statement: prefix + 'retain the last exception',
      applicableWhen: ['a', 'b', 'c', 'last applicable condition'], forbiddenWhen: ['x', 'y', 'last forbidden condition'] });
    expect(profile).toContain('last applicable condition'); expect(profile).toContain('last forbidden condition');
    await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-long', text: profile }]);
    await cache.drainCatalogEmbeddingsForTest();
    const changed = profile.replace('last exception', 'corrected final exception');
    await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-long', text: changed }]);
    await cache.drainCatalogEmbeddingsForTest();
    expect(embeds.texts).toContain(changed);
    const query = prefix + 'corrected final exception';
    await catalogMatches('vectoruser', query, [{ id: 'aa-long', title: 'Project guidance', statement: changed }]);
    expect(embeds.texts).toContain(query);
    await cache.drainCatalogEmbeddingsForTest();
  });
  it('reuses unchanged asset vectors, invalidates changed profiles, and prunes deleted assets', async () => {
    const cache = await import('../../../../src/main/features/recall/catalog-vector-cache');
    const first = await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-one', text: 'first private profile' }]);
    expect(first.byId.size).toBe(0);
    await cache.drainCatalogEmbeddingsForTest();
    const second = await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-one', text: 'first private profile' }]);
    expect(second.byId.get('aa-one')).toEqual([21, 102]);
    expect(embeds.texts.filter((text) => text === 'first private profile')).toHaveLength(1);
    await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-one', text: 'changed private profile' }]);
    await cache.drainCatalogEmbeddingsForTest();
    expect(embeds.texts.filter((text) => text === 'changed private profile')).toHaveLength(1);
    const file = path.join(root, 'vectoruser', 'local', 'cache', 'recall', 'catalog-vectors.json');
    const persisted = fs.readFileSync(file, 'utf8');
    expect(persisted).not.toContain('private profile');
    expect(JSON.parse(persisted).entries['aa-one']).toBeTruthy();
    await cache.pruneCatalogVectors('vectoruser', new Set());
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries['aa-one']).toBeUndefined();
  });
  it('returns cached hits without waiting for missing asset embeddings and persists them after the background drain', async () => {
    const cache = await import('../../../../src/main/features/recall/catalog-vector-cache');
    let release!: () => void;
    embeds.gates.set('slow private profile', new Promise<void>((resolve) => { release = resolve; }));
    const outcome = await Promise.race([
      cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-slow', text: 'slow private profile' }]).then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(outcome).toBe('resolved');
    release();
    await cache.drainCatalogEmbeddingsForTest();
    const warmed = await cache.catalogVectors('vectoruser', 'query', [{ id: 'aa-slow', text: 'slow private profile' }]);
    expect(warmed.byId.get('aa-slow')).toEqual([20, 115]);
    expect(embeds.texts.filter((text) => text === 'slow private profile')).toHaveLength(1);
  });
});
