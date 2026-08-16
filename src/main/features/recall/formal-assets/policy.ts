/**
 * 正式资产策略的唯一真相源（PRD 3.6）。
 *
 * 收口理由：此前三个概念散在各处、还互相串。`candidate-service` 决定写哪个
 * lifecycleStatus，`proof-service` 决定何时推进 maturity，`asset-semantics`
 * 决定能不能默认带入，`p3394/asset-events` 又自立了第三套状态词汇
 * （asset_user_confirmed / asset_transfer_verified / ...），
 * `context-projection` 干脆一个都不查。
 *
 * 这里把三条轴钉死，并且**只在这里**解释它们：
 *
 *   lifecycleStatus  这条资产是谁写进来的（来源/provenance）
 *                    user_confirmed_unverified          用户真的审过
 *                    automatically_extracted_unverified 会话自动抽取线
 *                    system_precipitated_unverified     KStar 自进化线
 *
 *   maturity         被验证到哪一步
 *                    seed / bud                  尚未证明被正确带入过
 *                    transfer_validated          真实加载 + Receipt
 *                    effectiveness_validated     可比评价证明结果更好
 *
 *   status           现在还允不允许用（治理态）
 *                    active 之外一律停用
 *
 * 关键：来源不决定成熟度。KStar 沉淀的资产 lifecycleStatus 是
 * system_precipitated_unverified，但它**不因为"是 KStar 来的"就更成熟**——
 * 没人确认过就仍在 seed 档。
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

/** 验证轴：被验证到哪一步。这里只做读取与归一，**推进**由证明链驱动
 *  （PR-E：Receipt + TransferProof），任何调用方都不得自行升档。 */
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
 * 默认使用契约（PRD 3.6）。合并了原来分散的两步：
 * 成熟度 → 基础档位，再叠加跨作用域确认。
 *
 * 返回值语义：
 *   never    不得注入
 *   confirm  需要用户逐次确认
 *   prompt   可以提示，但不静默默认注入
 *   auto     可在同作用域权限内默认注入
 */
export function resolveAssetUsePolicy(
  asset: AssetPolicyInput,
  sameScope: boolean,
): AbilityAssetUsePolicy {
  const base = resolveDefaultUsePolicy(
    { status: asset.status, maturity: asset.maturity },
    sameScope,
  );
  const crossScopeConfirmed = !sameScope && Boolean(asset.crossScopeConfirmedAt);
  return applyCrossScopeConfirmation(base, crossScopeConfirmed);
}

/** 「静默默认注入」的唯一判据。PRD 3.6：User Confirmed / Unverified
 *  仅在用户主动选择时使用，不得静默默认注入；Transfer Verified 起才可以。
 *
 *  注意这与 `resolveAssetUsePolicy` 不同：那个回答"能用到什么程度"，
 *  这个回答"能不能在用户没挑的情况下自己进去"。 */
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
 *  PRD 3.6 的 Transfer Verified 还要求 ContextReuseReceipt 落库，
 *  那道闸门在 PR-E 补上（当前 terminal-proof 不传 receiptId）。 */
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
