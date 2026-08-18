/**
 * 复用证明（Reuse Proof）—— M-7 的可同步那一半。
 *
 * ## 为什么要分成两半
 *
 * `ContextReuseReceipt` 存在 `local/kstar/executions/<id>/`，是**设备级执行日志**：
 * 会话 id、上下文 id、允许的作用域、被略过的引用、权限模式——它记录的是
 * "这台机器上那一次运行发生了什么"。资产存在 `cloud/recall/`，会跟着账号走。
 * 于是换机之后「使用与证明」页为空，成熟度无法复核（M-7）。
 *
 * 直接把整张回执搬进同步域可以关掉 M-7，但会顺手扩大隐私同步面——那是不能接受的
 * 代价。所以这里拆成两层：
 *
 *   - **设备级执行日志**（留在 local，不同步）：`reusedRefs` / `omittedRefs` 原文、
 *     `sourceSessionId` / `targetSessionId` / `sourceContextId` / `targetContextId`、
 *     `permissionMode` / `allowedScopes`、baseline/treatment 执行 id，以及回执目录里
 *     的 `record.json` / `events.jsonl`（提示词、完整上下文、原始执行轨迹）。
 *   - **用户级可同步证明**（本模块，进 cloud）：**只放复核"这条资产确实被复用过"
 *     所必需的字段**。
 *
 * ## 最小字段是怎么定出来的
 *
 * 不是拍脑袋选的，是照着现有复核谓词 `proof-service.receiptProvesTransfer` 反推的。
 * 它只用到四件事：
 *
 *   1. `receipt.receiptId === proof.receiptId`  → `receiptId`
 *   2. `receipt.boundary === 'real'`            → `boundary`
 *   3. `receipt.status !== 'rejected'`          → `status`
 *   4. `reusedRefs` 至少命中一条证明资产        → `provenAssets`
 *
 * 第 4 条**不搬 `reusedRefs` 原文**，只落"这张回执确实证明了哪几条资产的哪一版"
 * 这个交集结果。原始引用列表可能带上被略过的、与本次证明无关的条目，属于执行痕迹。
 *
 * `reusedAt` 用于履历排序与人工复核；`schemaVersion` 让以后加字段时旧读者能降级。
 *
 * ## 纪律
 *
 * - **只写不改语义**：本模块不参与升档判定，只是让判定在换机后**仍然读得到依据**。
 *   复核逻辑仍在 `proof-service`，回执仍是本机的权威源，cloud proof 是回落。
 * - **不得往这里加字段来"顺便解决别的问题"**。任何新字段都要先回答：
 *   复核资产复用**必须**有它吗？答不出就不加。
 */

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { readRecallJsonRecord, writeRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const log = createLogger('recall.reuse-proof');

export const REUSE_PROOF_SCHEMA_VERSION = 1;

/** 这张回执证明了哪条资产的哪一版被带入过。 */
export interface ReuseProvenAsset {
  assetId: string;
  version: string;
}

/**
 * 可同步的最小复用证明。**字段集合是封闭的**——见文件头的取舍说明。
 * 刻意不含：会话/上下文 id、reusedRefs/omittedRefs 原文、权限模式、允许作用域。
 */
export interface ReuseProofRecord extends RecallJsonRecord {
  schemaVersion: number;
  /** = executionId，满足 recall 记录的通用形状。 */
  id: string;
  ownerId: string;
  /** 与 TransferProofRecord.receiptId 对齐，用于复核是不是同一张回执。 */
  receiptId: string;
  /** 回执的定位键（= 本记录的 id）。 */
  executionId: string;
  /** 复用发生的时间（回执 completedAt，缺失时回退 createdAt）。 */
  reusedAt: string;
  /** 回执状态。复核只关心它不是 'rejected'。 */
  status: string;
  /** 复用边界。复核要求 'real'。 */
  boundary: string;
  /** 被证明复用的资产版本对（reusedRefs ∩ 证明资产，不是 reusedRefs 原文）。 */
  provenAssets: ReuseProvenAsset[];
}

const COLLECTION = 'reuse-proofs';

function isProvenAsset(value: unknown): value is ReuseProvenAsset {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.assetId === 'string' && !!item.assetId
    && typeof item.version === 'string' && !!item.version;
}

function asReuseProof(raw: unknown): ReuseProofRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.receiptId !== 'string' || !record.receiptId) return undefined;
  if (typeof record.executionId !== 'string' || !record.executionId) return undefined;
  const provenAssets = Array.isArray(record.provenAssets)
    ? record.provenAssets.filter(isProvenAsset)
    : [];
  return {
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 0,
    id: typeof record.id === 'string' ? record.id : record.executionId,
    ownerId: typeof record.ownerId === 'string' ? record.ownerId : '',
    receiptId: record.receiptId,
    executionId: record.executionId,
    reusedAt: typeof record.reusedAt === 'string' ? record.reusedAt : '',
    status: typeof record.status === 'string' ? record.status : '',
    boundary: typeof record.boundary === 'string' ? record.boundary : '',
    provenAssets,
  };
}

/**
 * 落一条可同步复用证明。
 *
 * 幂等：同一个 `executionId` 重复写覆盖同值。调用方在迁移证明成立时调用，
 * **失败只告警不抛**——cloud proof 是换机后的回落依据，写不成不该让本机的
 * 证明流程失败（本机仍有回执，复核照常走）。
 */
export async function recordReuseProof(
  userId: string,
  input: {
    receiptId: string;
    executionId: string;
    reusedAt: string;
    status: string;
    boundary: string;
    provenAssets: readonly ReuseProvenAsset[];
  },
): Promise<void> {
  if (!safeId(input.executionId)) return;
  if (!input.receiptId || !input.provenAssets.length) return;
  const record: ReuseProofRecord = {
    schemaVersion: REUSE_PROOF_SCHEMA_VERSION,
    id: input.executionId,
    ownerId: userId,
    receiptId: input.receiptId,
    executionId: input.executionId,
    reusedAt: input.reusedAt,
    status: input.status,
    boundary: input.boundary,
    // 去重后落盘，避免同一资产多次注入把记录撑大。
    provenAssets: [...new Map(input.provenAssets.map((item) => [
      `${item.assetId}@${item.version}`, { assetId: item.assetId, version: item.version },
    ])).values()],
  };
  try {
    await writeRecallJsonRecord(userId, COLLECTION, input.executionId, record);
  } catch (error) {
    log.warn('record reuse proof degraded', {
      executionId: input.executionId,
      error: (error as Error).message,
    });
  }
}

/** 读一条可同步复用证明。读不到返回 undefined（换机前的历史回执没有对应记录）。 */
export async function readReuseProof(
  userId: string,
  executionId: string,
): Promise<ReuseProofRecord | undefined> {
  if (!safeId(executionId)) return undefined;
  try {
    return asReuseProof(await readRecallJsonRecord(userId, COLLECTION, executionId));
  } catch {
    return undefined;
  }
}

/**
 * 换机后的复核：这条 cloud proof 能不能证明这批资产被复用过。
 *
 * 判据与 `proof-service.receiptProvesTransfer` **逐条对齐**——两边必须同进同退，
 * 否则同一条资产在本机和换机后会得到不同的成熟度结论。
 */
export function reuseProofProvesTransfer(
  proof: ReuseProofRecord,
  receiptId: string | undefined,
  assetVersions: readonly { assetId: string; version: string }[],
): boolean {
  if (!receiptId || proof.receiptId !== receiptId) return false;
  if (proof.boundary !== 'real') return false;
  if (proof.status === 'rejected') return false;
  return proof.provenAssets.some((proven) => assetVersions.some((asset) => (
    proven.assetId === asset.assetId && (!proven.version || proven.version === asset.version)
  )));
}
