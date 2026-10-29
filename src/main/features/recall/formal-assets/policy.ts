/**
 * 正式资产策略的统一定义，供运行时、界面和证明链共用。
 *
 * lifecycleStatus 表示来源：用户确认、会话自动抽取或 KStar 自动沉淀。
 * maturity 表示已有证据：尚未验证、真实带入验证或可比结果的效果验证。
 * status 表示当前治理状态，只有 active 可以使用。
 * 来源、成熟度和治理状态相互独立；自动来源本身不构成带入或效果证据。
 */

import type { RecallAbilityAssetLifecycleStatus } from '../candidate-service';
import {
  applyCrossScopeConfirmation,
  resolveDefaultUsePolicy,
  type AbilityAssetUsePolicy,
} from '../asset-semantics';
import type { FormalAssetMaturity, FormalAssetStatus } from './types';

/** 策略判断需要的最小资产形状。用结构类型而不是完整记录，
 *  这样 runtime / UI / 证明链都能直接喂进来。 */
export interface AssetPolicyInput {
  /** 主进程核对真实个人记忆确认回执后提供；不是由模型或资产字段直接声明。 */
  defaultUseAuthorized?: boolean;
  status: FormalAssetStatus;
  maturity: FormalAssetMaturity;
  lifecycleStatus?: RecallAbilityAssetLifecycleStatus;
  /** 用户显式确认过「可跨作用域使用」的时间。 */
  crossScopeConfirmedAt?: string;
}

/** 来源轴：谁写进来的。缺失按会话自动抽取线处理（最保守的可解释来源）。 */
export function resolveAssetLifecycle(
  asset: Pick<AssetPolicyInput, 'lifecycleStatus'>,
): RecallAbilityAssetLifecycleStatus {
  return asset.lifecycleStatus || 'automatically_extracted_unverified';
}

/** 验证轴：被验证到哪一步。这里只做读取与归一，推进由 Receipt + TransferProof
 *  证明链驱动，任何调用方都不得自行升档。 */
export function resolveAssetMaturity(
  asset: Pick<AssetPolicyInput, 'maturity'>,
): FormalAssetMaturity {
  return asset.maturity;
}

/** 用户确认是否真的发生过。lifecycleStatus 是唯一判据——
 *  maturity 到了 bud 不代表有人确认过（系统线也能到）。 */
export function isUserConfirmed(asset: Pick<AssetPolicyInput, 'lifecycleStatus'>): boolean {
  return resolveAssetLifecycle(asset) === 'user_confirmed_unverified';
}

/** 是否已有"被正确带入"的证明。 */
export function isTransferVerified(asset: Pick<AssetPolicyInput, 'maturity'>): boolean {
  return asset.maturity === 'transfer_validated' || asset.maturity === 'effectiveness_validated';
}

/**
 * 默认使用契约：
 * 成熟度 → 基础档位，再叠加跨作用域确认。
 *
 * 返回值语义：
 *   never    不得自动注入（按需查阅／明确选用由 runtime 的操作契约判定）
 *   confirm  需要用户逐次确认
 *   prompt   可以提示，但不静默默认注入
 *   auto     可在同作用域权限内默认注入
 */
export function resolveAssetUsePolicy(
  asset: AssetPolicyInput,
  sameScope: boolean,
): AbilityAssetUsePolicy {
  // The host verifies the complete human decision before supplying this flag.
  // Its narrow edit-root route may authorize a seed without promoting it;
  // an unreviewed seed and the historical personal-memory path remain blocked.
  if (asset.defaultUseAuthorized && isUserConfirmed(asset) && asset.status === 'active') {
    return sameScope ? 'auto' : asset.crossScopeConfirmedAt ? 'prompt' : 'confirm';
  }
  const base = resolveDefaultUsePolicy(
    { status: asset.status, maturity: asset.maturity },
    sameScope,
  );
  const crossScopeConfirmed = !sameScope && Boolean(asset.crossScopeConfirmedAt);
  return applyCrossScopeConfirmation(base, crossScopeConfirmed);
}

/** 是否允许无需本轮主动选用的默认注入，统一由 resolveAssetUsePolicy 判定。 */
export function allowsSilentDefaultInjection(
  asset: AssetPolicyInput,
  sameScope: boolean,
): boolean {
  return resolveAssetUsePolicy(asset, sameScope) === 'auto';
}

/** 迁移证明的结论 → 它把成熟度推到哪一档。
 *
 *  推进规则只在这里定义。调用方（proof-service）不再自己写死档位名，
 *  否则同一个概念会像 `transfer_verified` / `transfer_validated` 那样
 *  在系统里长出第二种拼法。
 *
 *  注意：这里只回答"这个结论对应哪一档"，**不回答"够不够格推进"**。
 *  真实带入验证还要求 ContextReuseReceipt 落库；调用方必须
 *  在推进成熟度前验证 receiptId，不能只凭任务成功状态升档。 */
export function maturityForTransferOutcome(status: string): FormalAssetMaturity | undefined {
  return status === 'succeeded' ? 'transfer_validated' : undefined;
}

/** 效果证明的结论 → 成熟度档位。只有"确实更好"才升到顶档；
 *  无差异 / 更差 / 证据不足都不升。 */
export function maturityForEffectivenessOutcome(
  outcome: string,
  valid: boolean,
): FormalAssetMaturity | undefined {
  if (!valid) return undefined;
  return outcome === 'better' ? 'effectiveness_validated' : undefined;
}

export type { AbilityAssetUsePolicy };
