import { listSkillVersions } from '../skills/version-store';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { userLocalRoot } from '../../paths';
import { listSkillBindings } from '../recall/skill-binding-service';
import { rollbackSkillToVersion } from '../skills/rollback-service';
import { diffSkillTrees } from '../skills/version-diff';
import type { SkillTreeDiff } from '../skills/version-diff';
import type { SkillVersionRecord } from '../skills/version-store';
import { listCognitionCandidates } from './candidates-adapter';
import { listCognitionReuseReceipts } from './receipts-adapter';
import type { CognitionSkillMigrationAudit, CognitionSkillRollbackPreview, SkillCognitionSummary } from './types';

export async function getSkillCognitionSummary(userId: string, skillId: string): Promise<SkillCognitionSummary> {
  const [versions, candidates, receipts, bindings] = await Promise.all([
    listSkillVersions(userId, skillId),
    listCognitionCandidates(userId, { skillId, status: 'pending' }),
    listCognitionReuseReceipts(userId, { skillId, limit: 5 }),
    listSkillBindings(userId),
  ]);
  const binding = bindings.find((item) => item.skillId === skillId);
  return {
    skillId,
    version: versions[0]?.version,
    ...(binding?.currentRevisionId ? { currentRevisionId: binding.currentRevisionId } : {}),
    ...(binding?.currentManifestHash ? { currentManifestHash: binding.currentManifestHash } : {}),
    ...(binding?.installedAssetVersion ? { installedAssetVersion: binding.installedAssetVersion } : {}),
    ...(binding?.assetId ? { sourceAssetId: binding.assetId } : {}),
    baselineStatus: versions.length ? 'available' : 'unversioned',
    pendingCandidateCount: candidates.length,
    recentReceipts: receipts,
    versions: versions.map((item) => ({
      version: item.version,
      ...(item.revisionId ? { revisionId: item.revisionId } : {}),
      ...(item.parentRevisionId ? { parentRevisionId: item.parentRevisionId } : {}),
      at: item.at,
      note: item.note,
      runId: item.runId,
      operation: item.operation,
      manifestHash: item.manifestHash,
      rollbackScope: item.rollbackScope,
      ...(item.source?.restoredFromVersion ? { restoredFromVersion: item.source.restoredFromVersion } : {}),
      ...(item.source?.assetId ? { sourceAssetId: item.source.assetId } : {}),
      ...(item.source?.assetVersion ? { sourceAssetVersion: item.source.assetVersion } : {}),
      ...(item.security?.outcome ? { securityOutcome: item.security.outcome } : {}),
      canRollback: item.canRollback === true,
    })),
  };
}

/** Read-only migration inventory. It never infers ownership from display
 * names and never deletes or rewrites an orphaned Skill. */
export async function getSkillVersionMigrationAudit(userId: string): Promise<CognitionSkillMigrationAudit> {
  const bindings = await listSkillBindings(userId);
  const boundSkillIds = new Set(bindings.map((binding) => binding.skillId));
  const versionRoot = path.join(userLocalRoot(userId), 'skills', 'versions');
  const legacyRoot = path.join(userLocalRoot(userId), 'kstar', 'versions');
  const ids = new Set<string>();
  let fullTreeVersionCount = 0;
  let legacyVersionCount = 0;
  for (const [root, legacy] of [[versionRoot, false], [legacyRoot, true]] as const) {
    let names: string[] = [];
    try { names = await fs.readdir(root); } catch { continue; }
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      const skillId = name.slice(0, -5);
      ids.add(skillId);
      const versions = await listSkillVersions(userId, skillId);
      if (legacy) legacyVersionCount += versions.length;
      else fullTreeVersionCount += versions.filter((item) => item.rollbackScope === 'full_tree').length;
    }
  }
  return {
    boundSkillCount: bindings.length,
    fullTreeVersionCount,
    legacyVersionCount,
    legacyOrphanSkillCount: Array.from(ids).filter((skillId) => !boundSkillIds.has(skillId)).length,
    unversionedBoundSkillCount: bindings.filter((binding) => !binding.currentRevisionId || !binding.currentManifestHash).length,
  };
}

function findSkillVersion(versions: SkillVersionRecord[], value: string): SkillVersionRecord | undefined {
  return versions.find((item) => item.version === value || item.revisionId === value);
}

export async function previewSkillCognitionRollback(
  userId: string,
  skillId: string,
  version: string,
): Promise<CognitionSkillRollbackPreview> {
  const versions = await listSkillVersions(userId, skillId);
  const target = findSkillVersion(versions, version);
  if (!target || target.canRollback !== true) throw new Error('skill version is not rollbackable');
  const current = versions[0];
  const nextVersion = String(versions.reduce((max, item) => {
    const number = /^\d+$/.test(item.version) ? Number(item.version) : 0;
    return Number.isSafeInteger(number) ? Math.max(max, number) : max;
  }, 0) + 1);
  let diff: SkillTreeDiff | undefined;
  if (current?.files && target.files) {
    diff = diffSkillTrees(current.files, target.files);
  }
  return {
    skillId,
    ...(current ? { currentVersion: current.version } : {}),
    ...(current?.revisionId ? { currentRevisionId: current.revisionId } : {}),
    ...(current?.manifestHash ? { currentManifestHash: current.manifestHash } : {}),
    targetVersion: target.version,
    ...(target.revisionId ? { targetRevisionId: target.revisionId } : {}),
    ...(target.manifestHash ? { targetManifestHash: target.manifestHash } : {}),
    nextVersion,
    rollbackScope: target.rollbackScope,
    ...(diff ? { diff } : {}),
  };
}

export async function diffSkillCognitionVersions(
  userId: string,
  skillId: string,
  fromVersion: string,
  toVersion: string,
): Promise<SkillTreeDiff> {
  const versions = await listSkillVersions(userId, skillId);
  const from = findSkillVersion(versions, fromVersion);
  const to = findSkillVersion(versions, toVersion);
  if (!from || !to || !from.files || !to.files) {
    throw new Error('skill versions do not contain complete snapshots');
  }
  return diffSkillTrees(from.files, to.files);
}

export async function rollbackSkillCognitionVersion(
  userId: string,
  skillId: string,
  version: string,
  expected?: { manifestHash?: string; revisionId?: string; allowPartialLegacy?: boolean },
) {
  return rollbackSkillToVersion(userId, {
    skillId,
    version,
    ...(expected?.manifestHash ? { expectedManifestHash: expected.manifestHash } : {}),
    ...(expected?.revisionId ? { expectedCurrentRevisionId: expected.revisionId } : {}),
    ...(expected?.allowPartialLegacy ? { allowPartialLegacy: true } : {}),
  });
}
