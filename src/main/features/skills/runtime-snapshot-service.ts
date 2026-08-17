import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { userLocalRoot } from '../../paths';
import { safeId } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { captureSkillTree, materializeSkillTree } from './snapshot-service';
import type { SkillVersionRecord } from './version-store';

function assertSegment(value: string, label: string): string {
  if (!safeId(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function skillRuntimeSnapshotsRoot(userId: string): string {
  assertSegment(userId, 'runtime snapshot user');
  return path.join(userLocalRoot(userId), 'skills', 'runtime-snapshots');
}

export function skillRuntimeSnapshotDir(userId: string, skillId: string, revisionId: string): string {
  return path.join(
    skillRuntimeSnapshotsRoot(userId),
    assertSegment(skillId, 'runtime snapshot skill'),
    assertSegment(revisionId, 'runtime snapshot revision'),
  );
}

async function readMatchingSnapshot(dir: string, manifestHash: string): Promise<boolean> {
  try {
    return (await captureSkillTree(dir)).manifestHash === manifestHash;
  } catch {
    return false;
  }
}

/** Materialize one admitted immutable version for TaskRun execution. The
 * snapshot is derived local state: a missing or corrupt copy is rebuilt from
 * the version envelope, while the immutable version record remains canonical. */
export async function ensureSkillRuntimeSnapshot(
  userId: string,
  skillId: string,
  record: SkillVersionRecord,
): Promise<string> {
  if (!record.revisionId || !record.manifestHash || !record.files || record.rollbackScope !== 'full_tree') {
    throw new Error('skill version cannot be pinned');
  }
  const target = skillRuntimeSnapshotDir(userId, skillId, record.revisionId);
  const lock = `${target}.lock`;
  return fileEditLock(lock).runExclusive(async () => {
    if (await readMatchingSnapshot(target, record.manifestHash)) return target;
    const parent = path.dirname(target);
    const stage = path.join(parent, `.cogseed-runtime-stage-${record.revisionId}-${randomUUID()}`);
    await fs.mkdir(parent, { recursive: true });
    try {
      await fs.rm(stage, { recursive: true, force: true });
      await materializeSkillTree(stage, record.files);
      const captured = await captureSkillTree(stage);
      if (captured.manifestHash !== record.manifestHash) throw new Error('runtime skill snapshot hash mismatch');
      await fs.rm(target, { recursive: true, force: true });
      await fs.rename(stage, target);
      return target;
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Resolve an already-materialized TaskRun pin without rebuilding it from
 * mutable input inside the Runtime worker. */
export async function verifySkillRuntimeSnapshot(
  userId: string,
  skillId: string,
  revisionId: string,
  manifestHash: string,
): Promise<string | undefined> {
  const target = skillRuntimeSnapshotDir(userId, skillId, revisionId);
  return await readMatchingSnapshot(target, manifestHash) ? target : undefined;
}
