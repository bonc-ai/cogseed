/**
 * KSTAR state — the snapshot the PC round-trips through the Engine.
 *
 * The PC treats this snapshot as opaque (`unknown`): it reads it from
 * `<uid>/local/kstar/snapshot.json`, hands it to `snapshot_import`, lets the
 * Engine mutate it, then writes back whatever `snapshot_export` returns. So the
 * shape is owned here, and the only cross-process contract is that an exported
 * snapshot must import cleanly on the next cycle.
 *
 * This is deliberately separate from `snapshot-state.ts`. That module models a
 * *skill* snapshot, whose episodes require `task_description` + `outcome`. PC
 * evidence is execution-scoped instead (tool cycles, agent runs, contributions)
 * and carries an open field set, so forcing it into `Episode` would drop data.
 *
 * Integrity uses sha256 rather than `canonical-json.ts::stableHash`. The CAS
 * cycle relies on the hash to tell a good snapshot from a corrupted one, and
 * stableHash is a 32-bit non-cryptographic hash whose collision odds are far
 * too high for that job. Canonical key ordering is still shared, so the digest
 * stays deterministic across processes.
 */
import { createHash } from 'node:crypto';
import { canonicalStringify } from './canonical-json.js';

export const KSTAR_SCHEMA_VERSION = 1;

export interface KstarEvidenceRecord {
  /** Stable id minted by the PC; the deduplication key. */
  id: string;
  recorded_at: string;
  [key: string]: unknown;
}

export interface KstarStateSnapshot {
  schema_version: number;
  generation: number;
  snapshot_hash: string;
  evidence: KstarEvidenceRecord[];
  created_at: string;
  updated_at: string;
}

export class KstarStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KstarStateError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Digest every field except the digest itself. */
export function computeStateHash(snapshot: KstarStateSnapshot): string {
  const { snapshot_hash, ...hashable } = snapshot;
  return createHash('sha256').update(canonicalStringify(hashable)).digest('hex');
}

export function createEmptyState(): KstarStateSnapshot {
  const now = nowIso();
  const snapshot: KstarStateSnapshot = {
    schema_version: KSTAR_SCHEMA_VERSION,
    generation: 0,
    snapshot_hash: '',
    evidence: [],
    created_at: now,
    updated_at: now,
  };
  snapshot.snapshot_hash = computeStateHash(snapshot);
  return snapshot;
}

/**
 * Validate an inbound snapshot and return a defensive copy.
 *
 * Throws rather than repairing: a snapshot that fails its own digest means the
 * file was truncated or hand-edited, and silently continuing would fold corrupt
 * history into the next export. The PC surfaces this as an aborted CAS
 * transaction and keeps its evidence in the pending log.
 */
export function parseState(input: unknown): KstarStateSnapshot {
  if (input === null || input === undefined) {
    throw new KstarStateError('snapshot is empty');
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new KstarStateError('snapshot must be an object');
  }

  const raw = input as Record<string, unknown>;

  if (raw.schema_version !== KSTAR_SCHEMA_VERSION) {
    throw new KstarStateError(
      `unsupported schema_version ${String(raw.schema_version)}, expected ${KSTAR_SCHEMA_VERSION}`,
    );
  }
  if (typeof raw.generation !== 'number' || !Number.isInteger(raw.generation) || raw.generation < 0) {
    throw new KstarStateError('generation must be a non-negative integer');
  }
  if (!Array.isArray(raw.evidence)) {
    throw new KstarStateError('evidence must be an array');
  }

  const evidence: KstarEvidenceRecord[] = raw.evidence.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new KstarStateError(`evidence[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id === '') {
      throw new KstarStateError(`evidence[${index}] is missing a string id`);
    }
    return { ...record, id: record.id, recorded_at: String(record.recorded_at ?? '') };
  });

  const snapshot: KstarStateSnapshot = {
    schema_version: KSTAR_SCHEMA_VERSION,
    generation: raw.generation,
    snapshot_hash: typeof raw.snapshot_hash === 'string' ? raw.snapshot_hash : '',
    evidence,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : nowIso(),
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
  };

  const expected = computeStateHash(snapshot);
  if (snapshot.snapshot_hash !== expected) {
    throw new KstarStateError(
      `snapshot_hash mismatch: stored ${snapshot.snapshot_hash || '(empty)'}, computed ${expected}`,
    );
  }

  return snapshot;
}

/**
 * Holds the state for one Engine process. The PC drives the lifecycle: import
 * before a transaction, mutate, export after. Absent an import, the process
 * starts from an empty state so a first-ever run still works.
 */
export class KstarState {
  private state: KstarStateSnapshot = createEmptyState();

  /** Replace in-memory state with the PC's snapshot. */
  import(input: unknown): { generation: number; evidence_count: number } {
    this.state = parseState(input);
    return { generation: this.state.generation, evidence_count: this.state.evidence.length };
  }

  /** Drop back to an empty state (fresh install, or PC has no snapshot yet). */
  reset(): void {
    this.state = createEmptyState();
  }

  export(): KstarStateSnapshot {
    return structuredClone(this.state);
  }

  /**
   * Append one evidence record, keyed by `id`.
   *
   * A repeat id is a no-op that reports `deduplicated`. It deliberately does not
   * bump the generation: the PC replays its pending-evidence log after an outage,
   * so re-recording is routine, and bumping on a write that changed nothing would
   * churn `snapshot.json` on every replay.
   */
  recordEvidence(input: unknown): { deduplicated: boolean; generation: number } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new KstarStateError('evidence must be an object');
    }
    const record = input as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id === '') {
      throw new KstarStateError('evidence.id is required');
    }

    if (this.state.evidence.some((e) => e.id === record.id)) {
      return { deduplicated: true, generation: this.state.generation };
    }

    const stored: KstarEvidenceRecord = {
      ...record,
      id: record.id,
      recorded_at: typeof record.recorded_at === 'string' ? record.recorded_at : nowIso(),
    };

    const next: KstarStateSnapshot = {
      ...this.state,
      evidence: [...this.state.evidence, stored],
      generation: this.state.generation + 1,
      updated_at: nowIso(),
      snapshot_hash: '',
    };
    next.snapshot_hash = computeStateHash(next);
    this.state = next;

    return { deduplicated: false, generation: next.generation };
  }
}
