import { listSkillVersions } from '../evolution/versions-store';
import { rollbackSkillToVersion } from '../evolution/patch-service';
import { listCognitionCandidates } from './candidates-adapter';
import { listCognitionReuseReceipts } from './receipts-adapter';
import type { SkillCognitionSummary } from './types';

export async function getSkillCognitionSummary(userId: string, skillId: string): Promise<SkillCognitionSummary> {
  const [versions, candidates, receipts] = await Promise.all([
    listSkillVersions(userId, skillId),
    listCognitionCandidates(userId, { skillId, status: 'pending' }),
    listCognitionReuseReceipts(userId, { skillId, limit: 5 }),
  ]);
  return {
    skillId,
    version: versions[0]?.version,
    baselineStatus: versions.length ? 'available' : 'unversioned',
    pendingCandidateCount: candidates.length,
    recentReceipts: receipts,
    versions: versions.map((item) => ({
      version: item.version,
      at: item.at,
      note: item.note,
      runId: item.runId,
      canRollback: item.canRollback === true,
    })),
  };
}

export async function rollbackSkillCognitionVersion(userId: string, skillId: string, version: string): Promise<{ ok: boolean; skillId: string; version: string }> {
  return rollbackSkillToVersion(userId, { skillId, version });
}
