/** Local, rebuildable embeddings for catalog retrieval. No asset text is stored here. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { userLocalCacheDir } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { embedForDedup } from './similarity';

const log = createLogger('recall.catalog-vectors');
const EMBED_CONCURRENCY = 4;

const CACHE_VERSION = 1;
// The KB embedding model is fixed by the app. Bump this when its model or the
// catalog profile recipe changes, so vectors from different spaces never mix.
const MODEL_TAG = 'kb-embedding:catalog-profile-v3-full-content';
const MAX_MEMORY_USERS = 4;

interface CachedVector { hash: string; vector: number[] }
interface VectorFile {
  version: number;
  modelTag: string;
  entries: Record<string, CachedVector>;
}

const memory = new Map<string, VectorFile>();

function cacheFile(userId: string): string {
  if (!safeId(userId)) throw new Error('invalid catalog vector owner');
  return path.join(userLocalCacheDir(userId), 'recall', 'catalog-vectors.json');
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

async function load(userId: string): Promise<VectorFile> {
  const cached = memory.get(userId);
  if (cached) return cached;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(cacheFile(userId), 'utf8')) as unknown;
  } catch {
    parsed = null;
  }
  const source = parsed && typeof parsed === 'object' ? parsed as Partial<VectorFile> : null;
  const entries: Record<string, CachedVector> = {};
  if (source?.version === CACHE_VERSION && source.modelTag === MODEL_TAG && source.entries) {
    for (const [id, row] of Object.entries(source.entries)) {
      if (safeId(id) && typeof row?.hash === 'string' && validVector(row.vector)) entries[id] = row;
    }
  }
  const result: VectorFile = { version: CACHE_VERSION, modelTag: MODEL_TAG, entries };
  memory.set(userId, result);
  if (memory.size > MAX_MEMORY_USERS) memory.delete(memory.keys().next().value!);
  return result;
}

/** Return query and asset vectors. A missing embedder degrades to lexical retrieval.
 * Asset vectors are warmed in the background with bounded concurrency so prompt
 * assembly never waits for a full-library embedding pass; an unwarmed asset
 * simply has no semantic channel until a later turn. */
export async function catalogVectors(
  userId: string,
  queryText: string,
  assets: readonly { id: string; text: string }[],
): Promise<{ query: number[] | null; byId: Map<string, number[]> }> {
  const query = await embedForDedup(userId, queryText);
  if (!query) return { query: null, byId: new Map() };
  const cache = await load(userId);
  const byId = new Map<string, number[]>();
  const missing: Array<{ id: string; text: string; hash: string }> = [];
  for (const asset of assets) {
    if (!safeId(asset.id)) continue;
    const hash = contentHash(asset.text);
    const existing = cache.entries[asset.id];
    if (existing?.hash === hash && existing.vector.length === query.length) {
      byId.set(asset.id, existing.vector);
      continue;
    }
    missing.push({ id: asset.id, text: asset.text, hash });
  }
  if (missing.length) scheduleEmbeddings(userId, query.length, missing);
  return { query, byId };
}

const background = new Map<string, Promise<void>>();

async function mapWithConcurrency<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(EMBED_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

async function embedMissing(userId: string, dimensions: number, items: readonly { id: string; text: string; hash: string }[]): Promise<void> {
  const cache = await load(userId);
  let changed = false;
  await mapWithConcurrency(items, async (item) => {
    const existing = cache.entries[item.id];
    if (existing?.hash === item.hash && existing.vector.length === dimensions) return;
    const vector = await embedForDedup(userId, item.text);
    if (!vector || vector.length !== dimensions) return;
    cache.entries[item.id] = { hash: item.hash, vector };
    changed = true;
  });
  if (!changed) return;
  const file = cacheFile(userId);
  await fileEditLock(file).runExclusive(() => writeJson(file, cache));
}

function scheduleEmbeddings(userId: string, dimensions: number, items: readonly { id: string; text: string; hash: string }[]): void {
  const previous = background.get(userId) || Promise.resolve();
  const work = previous
    .then(() => embedMissing(userId, dimensions, items))
    .catch((error: unknown) => log.warn('catalog vector prewarm degraded', { error: (error as Error).message }))
    .finally(() => { if (background.get(userId) === work) background.delete(userId); });
  background.set(userId, work);
}

/** Await queued prewarm work; the only caller is a test that asserts the
 * background contract instead of the prompt-latency contract. */
export async function drainCatalogEmbeddingsForTest(userId?: string): Promise<void> {
  for (;;) {
    const pending = [...background.entries()].filter(([owner]) => !userId || owner === userId).map(([, work]) => work);
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }
}

/** Run only from the full catalog build, never from a filtered search page. */
export async function pruneCatalogVectors(userId: string, activeIds: ReadonlySet<string>): Promise<void> {
  const cache = await load(userId);
  let changed = false;
  for (const id of Object.keys(cache.entries)) {
    if (!activeIds.has(id)) { delete cache.entries[id]; changed = true; }
  }
  if (changed) {
    const file = cacheFile(userId);
    await fileEditLock(file).runExclusive(() => writeJson(file, cache));
  }
}

export function resetCatalogVectorCacheForTest(): void { memory.clear(); }
