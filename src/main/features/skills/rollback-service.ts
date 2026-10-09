import { getCustomSkill, writeSkillFileForEdit } from '../skills';
import { refreshBindingsForSkill } from '../recall/skill-binding-service';
import { applySkillTreeVersion } from './version-mutation-service';
import {
  appendSkillVersion,
  listSkillVersions,
  readSkillVersionEnvelope,
  type SkillVersionRecord,
} from './version-store';
import { captureSkillTree } from './snapshot-service';

type WriteFn = (skillId: string, file: string, content: string) => Promise<boolean>;
type AppendVersionFn = (uid: string, skillId: string, entry: { version: string; note?: string; runId?: string; content?: string }) => Promise<unknown>;

export interface RollbackSkillResult {
  ok: boolean;
  skillId: string;
  /** The newly-created current version after the rollback. */
  version: string;
  restoredFromVersion?: string;
  revisionId?: string;
  rollbackScope?: 'full_tree' | 'skill_md_only';
}

export interface RollbackSkillInput {
  skillId: string;
  version: string;
  writeFn?: WriteFn;
  appendVersionFn?: AppendVersionFn;
  listVersionsFn?: (uid: string, skillId: string) => Promise<Array<{ version: string; at: string; note?: string; runId?: string; content?: string; canRollback?: boolean }>>;
  expectedManifestHash?: string;
  expectedCurrentRevisionId?: string;
  /** Legacy V1 records only contain SKILL.md. Require an explicit second
   * confirmation before allowing that limited compatibility rollback. */
  allowPartialLegacy?: boolean;
}

export async function rollbackSkillToVersion(
  uid: string,
  input: RollbackSkillInput,
): Promise<RollbackSkillResult> {
  const skillId = input.skillId;
  const version = String(input.version || '').trim();
  if (!skillId || !version) throw new Error('missing skill rollback target');
  const listVersions = input.listVersionsFn ?? listSkillVersions;
  const write = input.writeFn ?? ((id, file, content) => writeSkillFileForEdit(id, file, content));
  const appendVersion = input.appendVersionFn ?? appendSkillVersion;
  const versions = await listVersions(uid, skillId);
  const target = versions.find((item) => item.version === version || (item as { revisionId?: string }).revisionId === version);
  if (!target || target.canRollback === false) throw new Error('skill version is not rollbackable');

  // New V2 records carry a complete, immutable file tree. The mutation service
  // owns staging, security admission, atomic directory replacement, version
  // append, and cache invalidation. A rollback therefore never rewrites the
  // selected historical record; it creates a new current record instead.
  const fullTarget = target as SkillVersionRecord;
  if (Array.isArray(fullTarget.files) && fullTarget.rollbackScope === 'full_tree') {
    const currentSkill = await getCustomSkill(skillId);
    if (!currentSkill?.dir) throw new Error('skill is not installed');
    let current = await captureSkillTree(currentSkill.dir);
    let currentRevisionId = (versions[0] as { revisionId?: string } | undefined)?.revisionId;
    let rollbackRevisionId = input.expectedCurrentRevisionId ?? currentRevisionId;
    const currentVersion = versions[0] as SkillVersionRecord | undefined;

    // Do not silently destroy files edited after the last recorded version.
    // First materialize the live tree as a manual-edit recovery point, then
    // make the rollback a child of that point.
    if (currentVersion?.manifestHash && current.manifestHash !== currentVersion.manifestHash) {
      if (input.expectedManifestHash !== undefined && current.manifestHash !== input.expectedManifestHash) {
        throw new Error('skill changed; generate the rollback preview again');
      }
      if (input.expectedCurrentRevisionId !== undefined && currentRevisionId !== input.expectedCurrentRevisionId) {
        throw new Error('skill version changed; refresh the rollback history');
      }
      const manual = await applySkillTreeVersion({
        userId: uid,
        skillId,
        files: current.files,
        operation: 'manual_edit',
        source: { kind: 'manual_edit' },
        note: 'Capture unversioned tree before rollback',
        expectedManifestHash: current.manifestHash,
        ...(currentRevisionId ? { expectedCurrentRevisionId: currentRevisionId } : {}),
        onVersionCommitted: async (record) => {
          await refreshBindingsForSkill(uid, skillId, record.version, record.revisionId, record.manifestHash || '');
        },
      });
      currentRevisionId = manual.record.revisionId;
      rollbackRevisionId = manual.record.revisionId;
      current = await captureSkillTree(currentSkill.dir);
    }
    const committed = await applySkillTreeVersion({
      userId: uid,
      skillId,
      files: fullTarget.files,
      operation: 'rollback',
      source: {
        kind: 'rollback',
        restoredFromVersion: fullTarget.version,
      },
      note: `Rollback to ${fullTarget.version}`,
      expectedManifestHash: input.expectedManifestHash ?? current.manifestHash,
      ...(rollbackRevisionId ? { expectedCurrentRevisionId: rollbackRevisionId } : {}),
      onVersionCommitted: async (record) => {
        await refreshBindingsForSkill(uid, skillId, record.version, record.revisionId, record.manifestHash);
      },
    });
    return {
      ok: true,
      skillId,
      version: committed.record.version,
      restoredFromVersion: fullTarget.version,
      revisionId: committed.record.revisionId,
      rollbackScope: 'full_tree',
    };
  }

  // A legacy record only tells us what its SKILL.md contained. In production,
  // preserve every other file in the currently-installed tree, replace only
  // SKILL.md, and commit that resulting tree through the V2 transaction. This
  // makes the new current record a complete snapshot while the result still
  // reports the limited scope of what was actually restored from legacy data.
  // The injected seams below remain intentionally isolated for older callers
  // and tests that exercise the pre-versioned single-file contract.
  const hasInjectedLegacySeam = input.writeFn !== undefined
    || input.appendVersionFn !== undefined
    || input.listVersionsFn !== undefined;
  if (!hasInjectedLegacySeam && typeof target.content === 'string') {
    const currentSkill = await getCustomSkill(skillId);
    if (!currentSkill?.dir) throw new Error('skill is not installed');
    const current = await captureSkillTree(currentSkill.dir);
    const files = current.files.map((file) => (
      file.path === 'SKILL.md' ? { path: file.path, content: target.content! } : file
    ));
    const envelope = await readSkillVersionEnvelope(uid, skillId);
    const committed = await applySkillTreeVersion({
      userId: uid,
      skillId,
      files,
      operation: 'rollback',
      source: {
        kind: 'rollback',
        restoredFromVersion: target.version,
      },
      note: `Rollback legacy SKILL.md to ${target.version}`,
      expectedManifestHash: current.manifestHash,
      ...(envelope.currentRevisionId ? { expectedCurrentRevisionId: envelope.currentRevisionId } : {}),
      onVersionCommitted: async (record) => {
        await refreshBindingsForSkill(uid, skillId, record.version, record.revisionId, record.manifestHash || '');
      },
    });
    return {
      ok: true,
      skillId,
      version: committed.record.version,
      restoredFromVersion: target.version,
      revisionId: committed.record.revisionId,
      rollbackScope: 'skill_md_only',
    };
  }

  // Compatibility path for V1 history. It intentionally keeps the old
  // single-file behavior and its original test seam; callers can see the
  // limited scope through the result instead of being misled into assuming a
  // full-tree restore.
  if (input.allowPartialLegacy !== true) {
    throw new Error('legacy skill history only supports SKILL.md rollback; confirm the limited rollback explicitly');
  }
  if (typeof target.content !== 'string') throw new Error('skill version is not rollbackable');
  const ok = await write(skillId, 'SKILL.md', target.content);
  if (!ok) return { ok: false, skillId, version, rollbackScope: 'skill_md_only' };
  await appendVersion(uid, skillId, {
    version,
    note: `Rollback to ${version}`,
    runId: target.runId,
    content: target.content,
  });
  return { ok: true, skillId, version, rollbackScope: 'skill_md_only' };
}
