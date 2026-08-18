/**
 * 「待我处理」的读适配器。
 *
 * 只做一件事：把 canonical 层的资产、统一候选池、来源目录读出来，喂给
 * `buildCognitionInbox`。判断"什么算待办"的规则一条都不在这里——那些在
 * formal-assets/inbox.ts，与晋升 gate、Runtime gate 复用同一批函数。
 * 这里如果自己加一句 if，待办就会和 gate 分叉，用户看到的和系统执行的
 * 就不是同一套标准了。
 */

import { createLogger } from '../../logger';
import { listAbilityAssetVersions } from '../recall/asset-service';
import { listRecallCandidates } from '../recall/candidate-service';
import { listFormalAssets } from '../recall/formal-assets';
import { buildCognitionInbox, type CognitionInboxItem } from '../recall/formal-assets/inbox';
import { latestAssetVersionDiff, type AssetVersionDiff } from '../recall/formal-assets/version-diff';
import { readInstalledSkillForAsset } from '../recall/skill-draft-service';
import { bindingHasDecision, bindingIsStale, readSkillBinding } from '../recall/skill-binding-service';
import { listCognitionSources } from '../recall/source-catalog';

const log = createLogger('cognition.inbox');

/** 来源目录里"已经用不了"的两档。pending/processing 只是还没好，不是坏了。 */
const UNAVAILABLE_SOURCE_STATUSES = new Set(['failed', 'paused']);

export async function listCognitionInbox(userId: string): Promise<CognitionInboxItem[]> {
  const [assets, candidates, sourceGroups] = await Promise.all([
    listFormalAssets(userId),
    listRecallCandidates(userId).catch((error) => {
      log.warn('inbox candidate read degraded', { userId, error: (error as Error).message });
      return [];
    }),
    listCognitionSources(userId).catch((error) => {
      log.warn('inbox source read degraded', { userId, error: (error as Error).message });
      return [];
    }),
  ]);

  // skill_method 的 generatedSkillId 不在资产记录上，得问一次已安装 Skill。
  // 读失败时不能当成"还没生成"，否则会给用户一个可能重复创建 Skill 的假建议。
  // 资产本身仍保留给来源失效、敏感级等其他治理检查。
  const skillStateUnknownAssetIds = new Set<string>();
  const skillUpgradeCurrentAssetIds = new Set<string>();
  const skillUpgradeRejectedAssetIds = new Set<string>();
  const withSkillState = await Promise.all(assets.map(async (asset) => {
    if (asset.assetType !== 'skill_method' || asset.payload.kind !== 'skill_method') return asset;
    let generatedSkillId: string | undefined;
    try { generatedSkillId = await readInstalledSkillForAsset(userId, asset.assetId); }
    catch (error) {
      log.warn('inbox installed skill read degraded', {
        userId, assetId: asset.assetId, error: (error as Error).message,
      });
      skillStateUnknownAssetIds.add(asset.assetId);
      return asset;
    }
    try {
      const binding = await readSkillBinding(userId, asset.assetId);
      if (binding && !bindingIsStale(binding, asset.version)) {
        skillUpgradeCurrentAssetIds.add(asset.assetId);
      }
      if (binding && bindingHasDecision(binding, asset.version, ['rejected'])) {
        skillUpgradeRejectedAssetIds.add(asset.assetId);
      }
    } catch (error) {
      log.warn('inbox skill binding read degraded', {
        userId, assetId: asset.assetId, error: (error as Error).message,
      });
    }
    return generatedSkillId
      ? { ...asset, payload: { ...asset.payload, generatedSkillId } }
      : asset;
  }));

  // 变更类待办要知道"最近一次改了什么"。版本快照本来就存着全量内容，这里
  // 只是把相邻两版比一遍；读失败按"没有版本历史"处理——宁可少报一条变更，
  // 也不要凭空断言资产没变过。
  const latestDiffs = new Map<string, AssetVersionDiff>();
  await Promise.all(withSkillState.map(async (asset) => {
    try {
      const diff = latestAssetVersionDiff(asset.assetId, await listAbilityAssetVersions(userId, asset.assetId));
      if (diff) latestDiffs.set(asset.assetId, diff);
    } catch (error) {
      log.warn('inbox version history read degraded', {
        userId, assetId: asset.assetId, error: (error as Error).message,
      });
    }
  }));

  const unavailableSourceIds = new Set(sourceGroups
    .flatMap((group) => group.items)
    .filter((item) => UNAVAILABLE_SOURCE_STATUSES.has(item.status))
    .map((item) => item.id));

  return buildCognitionInbox({
    assets: withSkillState,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      ...(candidate.judgment ? { judgment: candidate.judgment } : {}),
      ...(candidate.suggestedType ? { suggestedType: candidate.suggestedType } : {}),
      ...(candidate.evidenceRefs ? { evidenceRefs: candidate.evidenceRefs } : {}),
    })),
    unavailableSourceIds,
    latestDiffs,
    skillStateUnknownAssetIds,
    skillUpgradeCurrentAssetIds,
    skillUpgradeRejectedAssetIds,
  });
}
