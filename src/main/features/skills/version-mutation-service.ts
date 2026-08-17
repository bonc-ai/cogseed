import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { userLocalRoot, userSkillsDir } from '../../paths';
import { writeJson } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { createLogger } from '../../logger';
import { validateSkillDir } from '../../quality';
import { scanSkillDir, scanVerdictBlocksInstall } from '../security/sentry-adapter';
import { admitCustomSkill } from '../security/custom-skill-admission';
import * as skills from '../skills';
import { captureSkillTree, materializeSkillTree, snapshotSkillFiles, type SkillSnapshotFile } from './snapshot-service';
import {
  appendFullSkillVersion,
  readSkillVersionEnvelope,
  skillVersionsPath,
  type SkillVersionEnvelope,
  type SkillVersionRecord,
  type SkillVersionSecurity,
  type SkillVersionSource,
} from './version-store';

const log = createLogger('skills.version-mutation');

interface SkillMutationJournal {
  schemaVersion: 1;
  userId: string;
  skillId: string;
  phase: 'staging' | 'staged' | 'backed_up' | 'swapped' | 'version_committed' | 'metadata_pending' | 'metadata_committed';
  finalDir: string;
  stageDir: string;
  backupDir: string;
  hadOriginal: boolean;
  previousEnvelope: SkillVersionEnvelope;
  nextRevisionId?: string;
  nextManifestHash?: string;
}

function mutationJournalDir(userId: string): string {
  return path.join(userLocalRoot(userId), 'skills', 'version-journals');
}

function mutationJournalPath(userId: string, skillId: string): string {
  return path.join(mutationJournalDir(userId), `${skillId}.json`);
}

export function skillMutationJournalFile(userId: string, skillId: string): string {
  return mutationJournalPath(userId, skillId);
}

async function writeMutationJournal(journal: SkillMutationJournal): Promise<void> {
  await fs.mkdir(path.dirname(mutationJournalPath(journal.userId, journal.skillId)), { recursive: true });
  await writeJson(mutationJournalPath(journal.userId, journal.skillId), journal);
}

async function removeMutationJournal(userId: string, skillId: string): Promise<void> {
  await fs.rm(mutationJournalPath(userId, skillId), { force: true });
}

export interface ApplySkillTreeInput {
  userId: string;
  skillId: string;
  files: ReadonlyArray<{ path: string; content: string; contentHash?: string }>;
  operation: 'install' | 'upgrade' | 'manual_edit' | 'rollback';
  source: SkillVersionSource;
  note?: string;
  expectedManifestHash?: string;
  expectedCurrentRevisionId?: string;
  onVersionCommitted?: (record: SkillVersionRecord) => Promise<void>;
}

export interface ApplySkillTreeResult {
  ok: true;
  skillId: string;
  record: SkillVersionRecord;
  previousManifestHash?: string;
}

function finalSkillDir(userId: string, skillId: string): string {
  return path.join(userSkillsDir(userId), skillId);
}

function securityFromAdmission(
  admission: Awaited<ReturnType<typeof admitCustomSkill>>,
  payloadHash: string,
): SkillVersionSecurity {
  return {
    outcome: admission.outcome === 'restricted' ? 'restricted' : 'pass',
    payloadHash,
    ...(admission.scan?.scannerVersion ? { scannerVersion: admission.scan.scannerVersion } : {}),
    ...(admission.scan?.rulesetVersion ? { rulesetVersion: admission.scan.rulesetVersion } : {}),
    findingCount: admission.report?.violations?.length || 0,
    scannedAt: new Date().toISOString(),
  };
}

async function copyIgnoredMetadata(fromDir: string, toDir: string): Promise<void> {
  for (const name of ['_meta.json']) {
    const source = path.join(fromDir, name);
    try {
      await fs.copyFile(source, path.join(toDir, name));
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}

async function scanStagedTree(userId: string, skillId: string, dir: string): Promise<void> {
  const local = validateSkillDir(dir, { enforceSkillRunner: false });
  if (!local.ok) throw new Error('skill version failed structural validation');
  const deep = await scanSkillDir(dir, 'community');
  if (scanVerdictBlocksInstall(deep.outcome)) {
    throw new Error(deep.outcome === 'unknown'
      ? 'skill security scan unavailable'
      : 'skill security scan rejected the version');
  }
  void userId;
  void skillId;
}

async function restoreTree(finalDir: string, backupDir: string, hadOriginal: boolean): Promise<void> {
  await fs.rm(finalDir, { recursive: true, force: true });
  if (hadOriginal) await fs.rename(backupDir, finalDir);
}

/**
 * Install or replace a custom Skill tree as one versioned transaction. The
 * directory swap is deliberately kept here instead of in Renderer/IPC so
 * every caller gets the same hash check, security gate, rollback, and cache
 * invalidation behavior.
 */
export async function applySkillTreeVersion(input: ApplySkillTreeInput): Promise<ApplySkillTreeResult> {
  const finalDir = finalSkillDir(input.userId, input.skillId);
  const lockKey = path.join(finalDir, '.cogseed-version-lock');
  return fileEditLock(lockKey).runExclusive(async () => {
    const target = snapshotSkillFiles(input.files);
    const existingSkill = await skills.getCustomSkill(input.skillId);
    const current = existingSkill?.dir ? await captureSkillTree(existingSkill.dir) : undefined;
    if (input.expectedManifestHash !== undefined
      && current?.manifestHash !== input.expectedManifestHash) {
      throw new Error('skill changed; generate the draft again');
    }
    if (input.expectedManifestHash !== undefined && !current) {
      throw new Error('skill changed; generate the draft again');
    }
    const previousEnvelope = await readSkillVersionEnvelope(input.userId, input.skillId);
    if (input.expectedCurrentRevisionId !== undefined
      && previousEnvelope.currentRevisionId !== input.expectedCurrentRevisionId) {
      throw new Error('skill version changed; refresh the history');
    }

    const parent = path.dirname(finalDir);
    const token = randomUUID();
    const stageDir = path.join(parent, `.cogseed-stage-${input.skillId}-${token}`);
    const backupDir = path.join(parent, `.cogseed-backup-${input.skillId}-${token}`);
    const hadOriginal = Boolean(existingSkill?.dir);
    const journal: SkillMutationJournal = {
      schemaVersion: 1,
      userId: input.userId,
      skillId: input.skillId,
      phase: 'staging',
      finalDir,
      stageDir,
      backupDir,
      hadOriginal,
      previousEnvelope,
    };
    await writeMutationJournal(journal);
    let swapped = false;
    try {
      await fs.rm(stageDir, { recursive: true, force: true });
      await fs.mkdir(stageDir, { recursive: true });
      await materializeSkillTree(stageDir, target.files);
      if (existingSkill?.dir) await copyIgnoredMetadata(existingSkill.dir, stageDir);
      await scanStagedTree(input.userId, input.skillId, stageDir);
      journal.phase = 'staged';
      await writeMutationJournal(journal);

      if (hadOriginal) await fs.rename(finalDir, backupDir);
      journal.phase = 'backed_up';
      await writeMutationJournal(journal);
      await fs.rename(stageDir, finalDir);
      swapped = true;
      journal.phase = 'swapped';
      journal.nextManifestHash = target.manifestHash;
      await writeMutationJournal(journal);

      const admission = await admitCustomSkill(input.userId, input.skillId);
      if (admission.outcome === 'blocked' || admission.outcome === 'unknown' || !admission.receipt) {
        throw new Error(admission.outcome === 'unknown'
          ? 'skill security receipt unavailable'
          : 'skill security admission rejected the version');
      }
      const finalSnapshot = await captureSkillTree(finalDir);
      const record = await appendFullSkillVersion(input.userId, input.skillId, {
        operation: input.operation,
        files: finalSnapshot.files,
        note: input.note,
        source: input.source,
        security: securityFromAdmission(admission, finalSnapshot.manifestHash),
        expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      });
      journal.phase = 'version_committed';
      journal.nextRevisionId = record.revisionId;
      journal.nextManifestHash = record.manifestHash;
      await writeMutationJournal(journal);
      journal.phase = 'metadata_pending';
      await writeMutationJournal(journal);
      try {
        await input.onVersionCommitted?.(record);
      } catch (error) {
        await writeJson(skillVersionsPath(input.userId, input.skillId), previousEnvelope);
        throw error;
      }
      journal.phase = 'metadata_committed';
      await writeMutationJournal(journal);
      await fs.rm(backupDir, { recursive: true, force: true });
      skills.invalidateSkillCachesForEdit();
      await removeMutationJournal(input.userId, input.skillId);
      log.info(`skill.version.${input.operation}`, {
        skill_id: input.skillId,
        version: record.version,
        file_count: record.files?.length || 0,
        result: 'success',
      });
      return {
        ok: true,
        skillId: input.skillId,
        record,
        ...(current ? { previousManifestHash: current.manifestHash } : {}),
      };
    } catch (error) {
      if (swapped) {
        await restoreTree(finalDir, backupDir, hadOriginal).catch(() => {});
        if (hadOriginal) {
          try { await admitCustomSkill(input.userId, input.skillId); } catch { /* restore is best effort */ }
        }
      }
      await writeJson(skillVersionsPath(input.userId, input.skillId), previousEnvelope).catch(() => {});
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
      await removeMutationJournal(input.userId, input.skillId).catch(() => {});
      log.warn('skill version mutation failed', {
        skill_id: input.skillId,
        operation: input.operation,
        result: 'failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw error;
    }
  });
}

function isOwnedMutationPath(parent: string, candidate: string, prefix: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative)
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && path.basename(candidate).startsWith(prefix);
}

async function readMutationJournal(file: string): Promise<SkillMutationJournal | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SkillMutationJournal>;
    if (parsed.schemaVersion !== 1 || typeof parsed.userId !== 'string' || typeof parsed.skillId !== 'string'
      || typeof parsed.finalDir !== 'string' || typeof parsed.stageDir !== 'string' || typeof parsed.backupDir !== 'string'
      || !parsed.previousEnvelope || typeof parsed.previousEnvelope !== 'object') return undefined;
    return parsed as SkillMutationJournal;
  } catch {
    return undefined;
  }
}

/** Recover only journals and staging directories created by this mutation
 * service. Recovery is idempotent: a committed tree is finalized; anything
 * else is restored from its validated backup and prior version envelope. */
export async function recoverSkillVersionMutations(userId: string): Promise<{ finalized: number; restored: number; removed: number }> {
  const dir = mutationJournalDir(userId);
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { finalized: 0, restored: 0, removed: 0 };
    throw error;
  }
  let finalized = 0;
  let restored = 0;
  let removed = 0;
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const file = path.join(dir, name);
    const journal = await readMutationJournal(file);
    if (!journal || journal.userId !== userId || journal.skillId !== name.slice(0, -5)) {
      await fs.rm(file, { force: true });
      removed += 1;
      continue;
    }
    const finalDir = finalSkillDir(userId, journal.skillId);
    const parent = path.dirname(finalDir);
    if (journal.finalDir !== finalDir
      || !isOwnedMutationPath(parent, journal.stageDir, `.cogseed-stage-${journal.skillId}-`)
      || !isOwnedMutationPath(parent, journal.backupDir, `.cogseed-backup-${journal.skillId}-`)) {
      await fs.rm(file, { force: true });
      removed += 1;
      continue;
    }
    await fileEditLock(path.join(finalDir, '.cogseed-version-lock')).runExclusive(async () => {
      let committed = false;
      if (journal.nextManifestHash && journal.nextRevisionId) {
        try {
          const current = await captureSkillTree(finalDir);
          const envelope = await readSkillVersionEnvelope(userId, journal.skillId);
          committed = current.manifestHash === journal.nextManifestHash
            && envelope.currentRevisionId === journal.nextRevisionId;
        } catch { committed = false; }
      }
      if (committed) {
        await fs.rm(journal.stageDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(journal.backupDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(file, { force: true });
        try {
          const bindings = await import('../recall/skill-binding-service');
          const record = (await readSkillVersionEnvelope(userId, journal.skillId)).records[0];
          if (record?.manifestHash) await bindings.refreshBindingsForSkill(userId, journal.skillId, record.version, record.revisionId, record.manifestHash);
        } catch { /* binding repair is best effort; next asset read can retry */ }
        finalized += 1;
        return;
      }
      const backupExists = await fs.stat(journal.backupDir).then(() => true).catch(() => false);
      if (backupExists) {
        await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
        await fs.rename(journal.backupDir, finalDir);
      } else if (!journal.hadOriginal) {
        await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
      }
      await writeJson(skillVersionsPath(userId, journal.skillId), journal.previousEnvelope).catch(() => {});
      await fs.rm(journal.stageDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(journal.backupDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(file, { force: true });
      restored += 1;
    });
  }
  return { finalized, restored, removed };
}
