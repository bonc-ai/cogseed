/**
 * ontology-backflow — 资产晋升 → 个人本体候选池的回流（2026-09-19 本体增强）。
 *
 * 对应 Richard R13 evolution_policy：学习成果（正式资产）反哺个人本体——
 * 但只「提议」不「写入」：投进本体候选池等用户确认（update change set 的
 * 提议半段），未确认候选不可被用是硬红线。
 *
 * 映射照 personal_ontology_candidates 的 mapOnboardingType 先例（onboarding
 * 抽取 → 候选池的同一条路），保证两条来源线的候选形状一致：
 *   personal → preference / user   （个人偏好与画像，A-Box 断言形状）
 *   rule     → rule       / shared （操作规则，R-Box 规则形状）
 *   template → instance   / user   （实例化信息，A-Box 断言形状）
 *   skill_method → 不回流。Richard T-Box 里 Skill/MetaSkill 是独立概念族，
 *   技能的家是认知资产库本身，不进个人本体断言（拍板 2026-09-19）。
 *
 * 幂等：candidate_id 恒为 `asset-backflow-<assetId>`，addCandidate 同 id
 * 覆盖 → 池内永远只保留该资产的最新版，融合/更新不堆积新条目。
 * 防洪：池内回流条数超上限即停止投放（记日志），资产库大时不能刷爆候选池。
 * 本模块任何失败都不阻断晋升主流程（调用方 try/catch 兜底）。
 */

import { createLogger } from '../../logger';
import type { RecallAbilityAssetRecord } from './candidate-service';

const log = createLogger('ontology-backflow');

export const ASSET_BACKFLOW_PREFIX = 'asset-backflow-';
export const MAX_BACKFLOW_POOL = 20;

interface BackflowTypeMapping {
  kind: 'preference' | 'instance' | 'rule';
  scope: 'user' | 'shared';
}

/** 白名单单点：null = 该类型不回流。键覆盖 AbilityAssetType 全枚举。 */
const BACKFLOW_TYPES: Record<string, BackflowTypeMapping | null> = {
  personal: { kind: 'preference', scope: 'user' },
  rule: { kind: 'rule', scope: 'shared' },
  template: { kind: 'instance', scope: 'user' },
  skill_method: null,
};

export interface BackflowOutcome {
  offered: boolean;
  reason?: string;
  candidateId?: string;
}

export function backflowCandidateIdFor(assetId: string): string {
  // 连字符形态：候选池的 candidate_id 走 safeId 白名单（字母数字连字符），
  // 冒号分隔会被 addCandidate 拒收。
  return `${ASSET_BACKFLOW_PREFIX}${assetId}`;
}

/**
 * 把一条新诞生的正式资产投进本体候选池。返回 offered=false 时带原因：
 * type_not_whitelisted（技能等）/ empty_statement / pool_full（防洪）。
 * 调用方必须吞异常——回流是增强，不是晋升链路的一环。
 */
export async function backflowAssetToOntologyPool(
  userId: string,
  asset: Pick<RecallAbilityAssetRecord, 'id' | 'type' | 'statement' | 'title'>,
): Promise<BackflowOutcome> {
  const mapping = asset && BACKFLOW_TYPES[asset.type] !== undefined
    ? BACKFLOW_TYPES[asset.type]
    : null;
  if (!mapping) return { offered: false, reason: 'type_not_whitelisted' };
  const statement = String(asset?.statement || '').trim();
  if (!statement) return { offered: false, reason: 'empty_statement' };

  const { addCandidate, listCandidates } = await import('../personal_ontology_candidates');
  const pool = await listCandidates(userId);
  const backflowCount = (pool?.candidate_updates || [])
    .filter((item) => typeof item?.candidate_id === 'string'
      && item.candidate_id.startsWith(ASSET_BACKFLOW_PREFIX))
    .length;
  if (backflowCount >= MAX_BACKFLOW_POOL) {
    log.warn('ontology backflow pool full, skipping offer', {
      userId, assetId: asset.id, size: backflowCount, cap: MAX_BACKFLOW_POOL,
    });
    return { offered: false, reason: 'pool_full' };
  }

  const candidateId = backflowCandidateIdFor(asset.id);
  // confidence low / write_actor llm：照 onboarding 先例——回流内容未经用户
  // 核对，进池等确认，不冒充高置信。
  await addCandidate(userId, {
    candidate_id: candidateId,
    kind: mapping.kind,
    memory_scope: mapping.scope,
    summary: String(asset.title || statement).slice(0, 120),
    memory_text: statement,
    confidence: 'low',
    write_actor: 'llm',
  });
  log.info('asset offered to ontology candidate pool', {
    userId, assetId: asset.id, type: asset.type, candidateId,
  });
  return { offered: true, candidateId };
}
