import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { openVecStore, type VecSearchHit, type VecSearchOpts, type VecStore } from '../vec_store';
import { nowIso, writeJson } from '../../storage';
import {
  assertMateKbSourceId,
  assertMateUserId,
  mateKbSourceFile,
  mateKbSourceMetadataFile,
  mateKbVectorDir,
} from './paths';
import { canAccessKbSource, type MateCapabilityScope } from './capability-scope';
import { capCapabilityText } from './capability-result';

export const MATE_KB_SCHEMA_VERSION = 1 as const;
const MAX_KB_RESULT_CHARS = 24_000;
const MAX_KB_READ_CHARS = 120_000;

export interface MateKbSourceRecord {
  schemaVersion: typeof MATE_KB_SCHEMA_VERSION;
  sourceId: string;
  title: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

export interface MateKbManagerOptions {
  vectorStoreFactory?: (userId: string) => Pick<VecStore, 'vectorize' | 'searchByQuery' | 'close'>;
}

export interface MateKbScope extends MateCapabilityScope {}
export interface MateKbListRow {
  scope: 'mate';
  path: string;
  kind: 'text';
  status: 'ready';
  bytes: number;
  title: string;
  updatedAt: string;
}

export interface MateKbSearchRow {
  scope: 'mate';
  path: string;
  chunk: number;
  title: string;
  content: string;
  score: number;
}

export interface MateKbReadRow {
  scope: 'mate';
  path: string;
  chunk: number;
  totalChunks: number;
  title: string;
  content: string;
}

function defaultVectorStore(userId: string): Pick<VecStore, 'vectorize' | 'searchByQuery' | 'close'> {
  return openVecStore(mateKbVectorDir(userId));
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function chunks(content: string, maxChars: number): string[] {
  const size = Math.max(1, Math.floor(maxChars));
  const out: string[] = [];
  for (let cursor = 0; cursor < content.length; cursor += size) out.push(content.slice(cursor, cursor + size));
  return out.length ? out : [''];
}

export function createMateKbManager(options: MateKbManagerOptions = {}) {
  const vectorStoreFactory = options.vectorStoreFactory ?? defaultVectorStore;
  const stores = new Map<string, Pick<VecStore, 'vectorize' | 'searchByQuery' | 'close'>>();

  function store(userId: string) {
    assertMateUserId(userId);
    const existing = stores.get(userId);
    if (existing) return existing;
    const created = vectorStoreFactory(userId);
    stores.set(userId, created);
    return created;
  }

  async function readRecord(userId: string, sourceId: string): Promise<MateKbSourceRecord> {
    try { return JSON.parse(await fs.readFile(mateKbSourceMetadataFile(userId, sourceId), 'utf8')); }
    catch (error) { if (isEnoent(error)) throw new Error('CogSeed KB source not found'); throw error; }
  }

  async function readContent(userId: string, sourceId: string): Promise<string> {
    return fs.readFile(mateKbSourceFile(userId, sourceId), 'utf8');
  }

  return {
    async indexText(userId: string, input: { sourceId: string; title: string; content: string }): Promise<MateKbSourceRecord> {
      assertMateUserId(userId);
      const sourceId = assertMateKbSourceId(input.sourceId);
      const title = String(input.title || '').trim();
      const content = String(input.content || '');
      if (!title || title.length > 500) throw new Error('invalid CogSeed KB source title');
      if (!content || content.length > 5_000_000) throw new Error('invalid CogSeed KB source content');
      const bytes = Buffer.byteLength(content, 'utf8');
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');
      const now = nowIso();
      let createdAt = now;
      try { createdAt = JSON.parse(await fs.readFile(mateKbSourceMetadataFile(userId, sourceId), 'utf8')).createdAt || now; } catch (error) { if (!isEnoent(error)) throw error; }
      await fs.mkdir(path.dirname(mateKbSourceFile(userId, sourceId)), { recursive: true });
      await fs.writeFile(mateKbSourceFile(userId, sourceId), content, 'utf8');
      const record: MateKbSourceRecord = { schemaVersion: MATE_KB_SCHEMA_VERSION, sourceId, title, bytes, sha256, createdAt, updatedAt: now };
      await writeJson(mateKbSourceMetadataFile(userId, sourceId), record);
      await store(userId).vectorize(sourceId, { kind: 'text', buf: Buffer.from(content, 'utf8'), bytes, mtime: Date.now() / 1000, sha1: sha256.slice(0, 40) });
      return record;
    },

    async search(userId: string, query: string, opts: VecSearchOpts = {}): Promise<VecSearchHit[]> {
      assertMateUserId(userId);
      const text = String(query || '').trim();
      if (!text || text.length > 2_000) throw new Error('invalid CogSeed KB query');
      return store(userId).searchByQuery(text, { ...opts, k: Math.max(1, Math.min(Math.floor(opts.k || 10), 50)) });
    },

    async readSource(userId: string, sourceId: string): Promise<{ record: MateKbSourceRecord; content: string }> {
      assertMateUserId(userId);
      const id = assertMateKbSourceId(sourceId);
      const record = await readRecord(userId, id);
      return { record, content: await readContent(userId, id) };
    },

    async listSources(userId: string): Promise<MateKbSourceRecord[]> {
      assertMateUserId(userId);
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(path.dirname(mateKbSourceMetadataFile(userId, 'mate-source-placeholder')), { withFileTypes: true }); }
      catch (error) { if (isEnoent(error)) return []; throw error; }
      const out: MateKbSourceRecord[] = [];
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.json')) out.push(JSON.parse(await fs.readFile(mateKbSourceMetadataFile(userId, entry.name.slice(0, -5)), 'utf8')));
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async list(userId: string, opts: { scope?: MateKbScope } = {}): Promise<MateKbListRow[]> {
      const scope = opts.scope;
      if (scope) {
        if (scope.userId !== userId) throw new Error('CogSeed KB scope belongs to a different user');
      }
      const rows = await this.listSources(userId);
      return rows.filter((row) => canAccessKbSource(scope, row.sourceId)).map((row) => ({ scope: 'mate', path: row.sourceId, kind: 'text', status: 'ready', bytes: row.bytes, title: row.title, updatedAt: row.updatedAt }));
    },

    async searchCompatible(userId: string, input: { query: string; scope?: MateKbScope; maxChars?: number; k?: number }): Promise<MateKbSearchRow[]> {
      const scope = input.scope;
      if (scope) {
        if (scope.userId !== userId) throw new Error('CogSeed KB scope belongs to a different user');
      }
      const maxChars = Math.max(1, Math.min(Math.floor(input.maxChars || MAX_KB_RESULT_CHARS), MAX_KB_RESULT_CHARS));
      const hits = await this.search(userId, input.query, { k: input.k });
      return hits
        .filter((hit) => canAccessKbSource(scope, String(hit.rel_path)))
        .map((hit) => ({ scope: 'mate', path: String(hit.rel_path), chunk: Number(hit.chunk_idx || 0), title: String(hit.title || hit.rel_path), content: capCapabilityText(String(hit.content || ''), maxChars), score: Number(hit.score || 0) }));
    },

    async readCompatible(userId: string, input: { path: string; chunk?: number; scope?: MateKbScope; maxChars?: number }): Promise<MateKbReadRow> {
      const scope = input.scope;
      if (scope) {
        if (scope.userId !== userId) throw new Error('CogSeed KB scope belongs to a different user');
      }
      const id = assertMateKbSourceId(input.path);
      if (!canAccessKbSource(scope, id)) throw new Error('CogSeed KB source is outside the current capability scope');
      const record = await readRecord(userId, id);
      const content = await readContent(userId, id);
      const totalChunks = chunks(content, Math.max(1, Math.min(Math.floor(input.maxChars || MAX_KB_READ_CHARS), MAX_KB_READ_CHARS)));
      const chunkIndex = Math.max(0, Math.min(Math.floor(input.chunk || 0), Math.max(0, totalChunks.length - 1)));
      return { scope: 'mate', path: id, chunk: chunkIndex, totalChunks: totalChunks.length, title: record.title, content: capCapabilityText(totalChunks[chunkIndex] || '', input.maxChars || MAX_KB_READ_CHARS) };
    },

    close(userId: string): void {
      const existing = stores.get(userId);
      stores.delete(userId);
      existing?.close();
    },
  };
}

export type MateKbManager = ReturnType<typeof createMateKbManager>;
export const mateKbManager = createMateKbManager();
