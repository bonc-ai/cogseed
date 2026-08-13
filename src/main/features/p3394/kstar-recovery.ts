/**
 * kstar-recovery.ts — Boot-time KSTAR health check: pending evidence replay
 * and degraded-schema detection.
 *
 * Runs once per boot (deferred, idle-preferred, see index.ts) for the
 * active user, and again after every successful CAS transaction in
 * kstar-adapter.ts once the Engine is confirmed reachable. Non-fatal: a
 * failure here must never block app startup, a transaction, or corrupt
 * on-disk state.
 *
 * Degraded-schema detection:
 *   `kstar-migration.ts` stamps `legacy_schema_version` at migration time.
 *   If a stamp names a schema this build doesn't recognize, PC assumes a
 *   newer build already touched the Engine snapshot and stays degraded
 *   (no evidence replay) rather than risk writing stale-shaped data on
 *   top of it.
 *
 * Pending evidence replay:
 *   `kstar-adapter.ts::recordEvidence()` appends to `pending-evidence.jsonl`
 *   (via kstar-store.ts) whenever the Engine is unavailable. Replay is a
 *   read-snapshot / call-out / filter-by-id three-phase sequence rather
 *   than a single `compactPendingEvidence` pass, because the fold callback
 *   there is synchronous and evidence delivery is not: we cannot await the
 *   Engine call from inside it. Records without a stable `id` are left
 *   queued forever (can't be deduped/acked) rather than being dropped.
 */

import { createLogger } from '../../logger';
import { checkMigrationStatus, type MigrationStamp } from './kstar-migration';
import { compactPendingEvidence } from './kstar-store';

const log = createLogger('p3394.kstar-recovery');

/** Schema versions this build knows how to interpret. Bump when the
 * Engine snapshot envelope (see kstar-migration.ts::transformLegacyToSnapshot)
 * gains a breaking field. */
const KNOWN_SCHEMA_VERSIONS = new Set(['1', '1.0.0']);

export interface KstarBootHealth {
  migrated: boolean;
  degraded: boolean;
  degradedReason?: string;
  replayed: number;
  remaining: number;
}

export interface KstarDegradedCheck {
  degraded: boolean;
  reason?: string;
  stamp?: MigrationStamp;
}

function isNewerSchema(stamp: MigrationStamp | undefined): boolean {
  const version = stamp?.legacy_schema_version;
  if (!version) return false;
  return !KNOWN_SCHEMA_VERSIONS.has(String(version));
}

/**
 * Check whether the user's migration stamp names a schema version newer
 * than this build understands. Read-only; never mutates the stamp.
 */
export async function checkKstarDegraded(uid: string): Promise<KstarDegradedCheck> {
  const { stamp } = await checkMigrationStatus(uid);
  if (isNewerSchema(stamp)) {
    return { degraded: true, reason: 'newer schema detected', stamp };
  }
  return { degraded: false, stamp };
}

/**
 * Replay pending evidence accumulated while the Engine adapter was
 * unavailable. `recordEvidence` should be bound to a live, available
 * adapter — callers decide whether the Engine is reachable before calling
 * this; if it isn't, skip the call entirely rather than passing a no-op
 * (a no-op would just report every record as unresolved for no benefit).
 *
 * Only records whose delivery is confirmed successful are dropped from the
 * log. Anything that throws or reports failure stays queued for the next
 * attempt — this function never discards evidence it isn't sure landed.
 */
export async function replayPendingEvidence(
  uid: string,
  recordEvidence: (evidence: Record<string, unknown>) => Promise<{ success: boolean }>,
): Promise<{ replayed: number; remaining: number }> {
  // Phase 1: snapshot pending records without mutating the log (no-op fold).
  let pending: Array<Record<string, unknown>> = [];
  await compactPendingEvidence(uid, (records) => {
    pending = records as Array<Record<string, unknown>>;
    return records;
  });

  if (!pending.length) {
    return { replayed: 0, remaining: 0 };
  }

  // Phase 2: attempt replay outside the store's mutex — recordEvidence may
  // call out to the Engine over stdio/network and must never hold a file
  // lock while doing so.
  const succeededIds = new Set<string>();
  for (const record of pending) {
    const id = typeof record.id === 'string' ? record.id : '';
    if (!id) continue; // no stable id to dedupe/ack against; leave queued
    try {
      const result = await recordEvidence(record);
      if (result.success) succeededIds.add(id);
    } catch (err) {
      log.warn('evidence replay failed', {
        uid,
        evidenceId: id,
        error: (err as Error).message,
      });
    }
  }

  // Phase 3: drop only the records confirmed accepted. Anything appended
  // between phase 1 and here (different id) is preserved automatically.
  let remaining = 0;
  await compactPendingEvidence(uid, (records) => {
    const retained = (records as Array<Record<string, unknown>>).filter((record) => {
      const id = typeof record.id === 'string' ? record.id : '';
      return !id || !succeededIds.has(id);
    });
    remaining = retained.length;
    return retained;
  });

  if (succeededIds.size) {
    log.info('replayed pending kstar evidence', { uid, replayed: succeededIds.size, remaining });
  }

  return { replayed: succeededIds.size, remaining };
}

/**
 * Boot-time composition: check degraded state, then (if not degraded)
 * replay pending evidence through the given callback. `getRecordEvidence`
 * is called lazily and only once we know we're not degraded, so callers
 * can defer acquiring/spawning the Engine adapter until it's actually
 * needed.
 */
export async function runKstarBootRecovery(
  uid: string,
  getRecordEvidence: () => Promise<((evidence: Record<string, unknown>) => Promise<{ success: boolean }>) | null>,
): Promise<KstarBootHealth> {
  const { migrated, stamp } = await checkMigrationStatus(uid);

  if (isNewerSchema(stamp)) {
    log.warn('kstar boot health: newer schema detected, staying degraded', {
      uid,
      schemaVersion: stamp?.legacy_schema_version,
    });
    return { migrated, degraded: true, degradedReason: 'newer schema detected', replayed: 0, remaining: -1 };
  }

  let recordEvidence: ((evidence: Record<string, unknown>) => Promise<{ success: boolean }>) | null = null;
  try {
    recordEvidence = await getRecordEvidence();
  } catch (err) {
    log.warn('kstar boot health: failed to acquire evidence sink', { uid, error: (err as Error).message });
  }

  if (!recordEvidence) {
    // Engine unavailable this boot — leave the pending log untouched; it
    // is the durable queue for the next successful adapter connection.
    return { migrated, degraded: false, replayed: 0, remaining: 0 };
  }

  const { replayed, remaining } = await replayPendingEvidence(uid, recordEvidence);
  return { migrated, degraded: false, replayed, remaining };
}
