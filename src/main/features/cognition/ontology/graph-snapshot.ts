/** Per-ontology-version graph snapshots. The ontology remains the only source
 * of truth; this sidecar stores model-chosen grouping and layout plus the
 * formal node/edge versions it was generated from. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nowIso, readJson, writeJson } from '../../../storage';
import { fileEditLock } from '../../../util/locks';
import { userCognitionDir } from '../../../paths';
import { OntologyError, type OntologyAssertion, type OntologyRecord } from './model';

export type OntologyGraphScope =
  | { kind: 'global' }
  | { kind: 'module'; moduleId: string };

export interface OntologyGraphSnapshotNode {
  id: string;
  recordId: string;
  version: number;
  label: string;
  kind: string;
  moduleId?: string;
  group?: string;
  x: number;
  y: number;
  source?: OntologyRecord['source'];
}

export interface OntologyGraphSnapshotEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: string;
  recordId: string;
  version: number;
  group?: string;
  source?: OntologyRecord['source'];
  validity?: OntologyAssertion['validity'];
}

export interface OntologyGraphSuggestion {
  id: string;
  from: string;
  to: string;
  label: string;
  reason: string;
  status: 'pending_review';
}

export interface OntologyGraphSnapshot {
  schemaVersion: 1;
  ownerId: string;
  scope: 'global' | 'module';
  moduleId?: string;
  ontologyRevision: number;
  at: string;
  contentScale: 'schema' | 'instances';
  nodes: OntologyGraphSnapshotNode[];
  edges: OntologyGraphSnapshotEdge[];
  suggestions: OntologyGraphSuggestion[];
  generatedAt: string;
  generator: { kind: 'model'; provider?: string; model?: string; promptVersion: string };
  validation: { valid: true; checkedRecordVersions: Record<string, number> };
}

export interface OntologyGraphSnapshotEntry {
  status: 'running' | 'ready' | 'failed';
  ontologyRevision: number;
  updatedAt: string;
  error?: string;
  snapshot?: OntologyGraphSnapshot;
}

interface OntologyGraphSnapshotStore {
  schemaVersion: 1;
  ownerId: string;
  entries: Record<string, OntologyGraphSnapshotEntry>;
}

const STORE_SCHEMA_VERSION = 1 as const;

export function graphScopeKey(scope: OntologyGraphScope): string {
  return scope.kind === 'global' ? 'global' : `module:${scope.moduleId}`;
}

function storePath(userId: string): string {
  return path.join(userCognitionDir(userId), 'ontology-graph-snapshots.json');
}

function emptyStore(userId: string): OntologyGraphSnapshotStore {
  return { schemaVersion: STORE_SCHEMA_VERSION, ownerId: userId, entries: {} };
}

function validEntry(value: unknown): value is OntologyGraphSnapshotEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['running', 'ready', 'failed'].includes(String(entry.status))
    && Number.isSafeInteger(entry.ontologyRevision) && Number(entry.ontologyRevision) >= 0
    && typeof entry.updatedAt === 'string'
    && (entry.error === undefined || typeof entry.error === 'string');
}

async function readStore(userId: string): Promise<OntologyGraphSnapshotStore> {
  const file = storePath(userId);
  if (!fs.existsSync(file)) return emptyStore(userId);
  let raw: unknown;
  try {
    raw = await readJson(file);
  } catch {
    throw new OntologyError('graph_snapshot_store_corrupt', 'ontology graph snapshot store is unreadable');
  }
  if (!raw || typeof raw !== 'object') throw new OntologyError('graph_snapshot_store_corrupt', 'invalid ontology graph snapshot store');
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== STORE_SCHEMA_VERSION || value.ownerId !== userId
    || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw new OntologyError('graph_snapshot_store_corrupt', 'invalid ontology graph snapshot store');
  }
  const entries: Record<string, OntologyGraphSnapshotEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    if (validEntry(entry)) entries[key] = entry;
  }
  return { schemaVersion: STORE_SCHEMA_VERSION, ownerId: userId, entries };
}

async function mutateStore(
  userId: string,
  mutate: (store: OntologyGraphSnapshotStore) => void,
): Promise<void> {
  const file = storePath(userId);
  await fileEditLock(file).runExclusive(async () => {
    const store = await readStore(userId);
    mutate(store);
    await writeJson(file, store);
  });
}

export async function readGraphSnapshotEntry(
  userId: string,
  scope: OntologyGraphScope,
): Promise<OntologyGraphSnapshotEntry | null> {
  const store = await readStore(userId);
  return store.entries[graphScopeKey(scope)] ?? null;
}

export async function listGraphSnapshotEntries(userId: string): Promise<Record<string, OntologyGraphSnapshotEntry>> {
  return (await readStore(userId)).entries;
}

export async function beginGraphSnapshotGeneration(
  userId: string,
  scope: OntologyGraphScope,
  ontologyRevision: number,
): Promise<void> {
  const key = graphScopeKey(scope);
  await mutateStore(userId, (store) => {
    const previous = store.entries[key];
    store.entries[key] = {
      status: 'running',
      ontologyRevision,
      updatedAt: nowIso(),
      ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
      ...(previous?.error ? { error: previous.error } : {}),
    };
  });
}

export async function failGraphSnapshotGeneration(
  userId: string,
  scope: OntologyGraphScope,
  ontologyRevision: number,
  error: string,
): Promise<void> {
  const key = graphScopeKey(scope);
  await mutateStore(userId, (store) => {
    const previous = store.entries[key];
    store.entries[key] = {
      status: 'failed',
      ontologyRevision,
      updatedAt: nowIso(),
      error: error.slice(0, 800),
      ...(previous?.snapshot ? { snapshot: previous.snapshot } : {}),
    };
  });
}

export async function saveGraphSnapshot(
  userId: string,
  snapshot: OntologyGraphSnapshot,
): Promise<OntologyGraphSnapshotEntry> {
  if (snapshot.ownerId !== userId) throw new OntologyError('not_authorized', 'graph snapshot owner mismatch');
  const scope: OntologyGraphScope = snapshot.scope === 'module'
    ? { kind: 'module', moduleId: snapshot.moduleId! }
    : { kind: 'global' };
  const key = graphScopeKey(scope);
  let saved: OntologyGraphSnapshotEntry | undefined;
  await mutateStore(userId, (store) => {
    const previous = store.entries[key];
    if (previous?.snapshot && previous.snapshot.ontologyRevision > snapshot.ontologyRevision) return;
    saved = { status: 'ready', ontologyRevision: snapshot.ontologyRevision, updatedAt: nowIso(), snapshot };
    store.entries[key] = saved;
  });
  if (!saved) {
    return (await readStore(userId)).entries[key];
  }
  return saved;
}

export function graphSnapshotStorePath(userId: string): string {
  return storePath(userId);
}
