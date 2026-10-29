import { listSkillVersions, nextVersion } from '../skills/version-store';
import { listSkillBindings } from '../recall/skill-binding-service';
import { rollbackSkillToVersion } from '../skills/rollback-service';
import { diffSkillTrees } from '../skills/version-diff';
import type { SkillTreeDiff } from '../skills/version-diff';
import type { SkillVersionRecord } from '../skills/version-store';
import { listCognitionReuseReceipts } from './receipts-adapter';
import type { CognitionSkillRollbackPreview, SkillCognitionSummary } from './types';

// 候选列表适配器（{ skillId, status: 'pending' }）不能用于 pendingCandidateCount：
// 候选源不携带 skill 归因，过滤恒空、计数恒 0，且渲染层没有消费方。
export async function getSkillCognitionSummary(userId: string, skillId: string): Promise<SkillCognitionSummary> {
  const [versions, receipts, bindings] = await Promise.all([
    listSkillVersions(userId, skillId),
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

// 2026-10-01 组12·退役（P-r3-3/P-r1-20，预审决策卡拍板）：getSkillVersionMigrationAudit
// 随 cognition.skills.audit 通道一并删除。该函数的 legacy 计数对 v2/legacy 两个目录
// 都调 v2 读口 listSkillVersions——双目录共存时双重计数、真 legacy 目录零读取，
// 且唯一消费者就是这条渲染零调用的死通道，无修复后接线的价值。类型
// CognitionSkillMigrationAudit（types.ts）与基线 fixture 同步删除。

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
    nextVersion: nextVersion(versions),
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
