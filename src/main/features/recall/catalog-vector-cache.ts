/** Local, rebuildable embeddings for catalog retrieval. No asset text is stored here. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalCacheDir } from '../../paths';
import { safeId, writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { embedForDedup } from './similarity';

const CACHE_VERSION = 1;
// The KB embedding model is fixed by the app. Bump this when its model or the
// catalog profile recipe changes, so vectors from different spaces never mix.
const MODEL_TAG = 'kb-embedding:catalog-profile-v2';
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
  return createHash('sha256').update(text.slice(0, 2_000)).digest('hex');
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

/** Return query and asset vectors. A missing embedder degrades to lexical retrieval. */
export async function catalogVectors(
  userId: string,
  queryText: string,
  assets: readonly { id: string; text: string }[],
): Promise<{ query: number[] | null; byId: Map<string, number[]> }> {
  const query = await embedForDedup(userId, queryText);
  if (!query) return { query: null, byId: new Map() };
  const cache = await load(userId);
  const byId = new Map<string, number[]>();
  let changed = false;
  for (const asset of assets) {
    if (!safeId(asset.id)) continue;
    const hash = contentHash(asset.text);
    const existing = cache.entries[asset.id];
    if (existing?.hash === hash && existing.vector.length === query.length) {
      byId.set(asset.id, existing.vector);
      continue;
    }
    const vector = await embedForDedup(userId, asset.text);
    if (!vector || vector.length !== query.length) continue;
    cache.entries[asset.id] = { hash, vector };
    byId.set(asset.id, vector);
    changed = true;
  }
  if (changed) {
    const file = cacheFile(userId);
    await fileEditLock(file).runExclusive(() => writeJson(file, cache));
  }
  return { query, byId };
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
