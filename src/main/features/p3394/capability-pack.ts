/** MinimumCapabilityPack：把用户已确认的认知资产，冻结成一份可交给执行端的最小能力包。
 *
 *  链路位置：Conversation/Episode → Candidate → Asset → **Capability Pack** → Reuse。
 *  上游（candidate-service / asset-service）负责「这条判断成不成立」，
 *  这里只负责「这次任务带哪几条、带的是哪个版本、什么时候过期」。
 *
 *  三条不可让步的约束：
 *
 *  1. **版本冻结**：包里记的是资产在冻结那一刻的 `version` 与内容摘要。资产事后被
 *     改动或撤销，已发出的包内容不变——回执要能说清「当时用的是第几版」。
 *  2. **排除项显式化**：被过滤掉的资产不是静默丢弃，而是带 reason 记进 `excluded`。
 *     用户要能看到「这次没带什么、为什么没带」，否则最小投影就成了黑箱。
 *  3. **内容哈希**：`contentHash` 覆盖所有影响执行的字段。执行端回传同一个 hash 才算
 *     「确实读到了这一份」——这是 delivered → acknowledged 的唯一凭据，
 *     文件复制或模型自述都不算。
 *
 *  本模块是纯函数，不碰磁盘、不认识 userId。授权、有效期校验与撤销检查由调用方
 *  在上层完成；这里只提供 `isPackExpired` / `assertPackIntegrity` 两个判定原语。
 */

import { createHash } from 'node:crypto';

import type { RecallAbilityAssetRecord } from '../recall/candidate-service';

const MAX_PACK_ASSETS = 64;
const MAX_PURPOSE_LENGTH = 500;
const MAX_TARGET_LENGTH = 160;

/** 资产没进包的原因。全部是「客观可判定」的——不含模型判断，
 *  这样用户看到排除项时能自己复核。 */
export type PackExclusionReason =
  | 'status_not_active'
  | 'revoked'
  | 'scope_mismatch'
  | 'forbidden_here'
  | 'not_for_this_agent'
  | 'missing_evidence'
  | 'superseded'
  | 'user_excluded';

export interface PackExcludedAsset {
  assetId: string;
  reason: PackExclusionReason;
  /** 面向用户的一句话说明，直接展示。 */
  detail?: string;
}

/** 包内资产引用。冻结的是 id + version + statementHash 三元组：
 *  id 说明是哪条，version 说明是第几版，statementHash 让执行端能验内容没被换过。 */
export interface PackAssetRef {
  assetId: string;
  version: string;
  type: RecallAbilityAssetRecord['type'];
  title: string;
  statement: string;
  statementHash: string;
  scope: string;
  applicableWhen?: string[];
  forbiddenWhen?: string[];
}

export interface MinimumCapabilityPack {
  packId: string;
  /** 这次任务要干什么——决定投影范围，也写进回执。 */
  purpose: string;
  /** 目标执行端标识（如 'workbuddy'）。包与目标绑定，换目标必须重新签发。 */
  targetAgent: string;
  /** 冻结时刻。 */
  frozenAt: string;
  /** 过期时刻。能力包必须有有效期——没有永久授权。 */
  expiresAt: string;
  assets: PackAssetRef[];
  excluded: PackExcludedAsset[];
  /** 覆盖上述所有字段的内容摘要，签发后不可变。 */
  contentHash: string;
}

export interface BuildCapabilityPackInput {
  packId: string;
  purpose: string;
  targetAgent: string;
  frozenAt: string;
  expiresAt: string;
  assets: RecallAbilityAssetRecord[];
  /** 用户手动勾掉的资产 id。显式排除也要记进 excluded。 */
  userExcludedAssetIds?: string[];
  /** 当前任务场景标签，用来比对 forbiddenWhen。留空表示不做场景过滤。 */
  situation?: string[];
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid capability pack ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`invalid capability pack ${field}`);
  if (text.length > max) throw new Error(`capability pack ${field} is too long`);
  return text;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid capability pack ${field}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid capability pack ${field}`);
  return value;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 规范化序列化：字段顺序固定，不依赖对象字面量的书写顺序或 JSON.stringify 的
 *  实现细节。同样内容在任何机器上必须产出同一个 hash，否则 acknowledged 无从判定。 */
function canonicalAssetRef(ref: PackAssetRef): string {
  return [
    ref.assetId,
    ref.version,
    ref.type,
    ref.title,
    // 从 statement 现算，而非读 ref.statementHash：否则把执行端真正读的 statement
    // 换掉、同时保留旧 statementHash，就能绕过完整性校验。
    sha256(ref.statement),
    ref.scope,
    (ref.applicableWhen ?? []).join(''),
    (ref.forbiddenWhen ?? []).join(''),
  ].join('');
}

/** 内容哈希只覆盖「影响执行结果」的字段。
 *  故意不含 packId 与 frozenAt：同样一组资产在不同时刻发两次，内容 hash 相同，
 *  这样能识别出「重复投影」；要区分具体某一次用 packId。 */
export function computePackContentHash(
  pack: Pick<MinimumCapabilityPack, 'purpose' | 'targetAgent' | 'expiresAt' | 'assets' | 'excluded'>,
): string {
  const parts = [
    pack.purpose,
    pack.targetAgent,
    pack.expiresAt,
    pack.assets.map(canonicalAssetRef).join(''),
    pack.excluded.map((entry) => `${entry.assetId}${entry.reason}`).join(''),
  ];
  return sha256(parts.join(''));
}

function excludeReasonFor(
  asset: RecallAbilityAssetRecord,
  userExcluded: Set<string>,
  situation: string[],
  targetAgent: string,
): { reason: PackExclusionReason; detail?: string } | null {
  if (userExcluded.has(asset.id)) {
    return { reason: 'user_excluded', detail: '本次由你手动移除' };
  }
  if (asset.status === 'revoked') {
    return { reason: 'revoked', detail: '资产已撤销' };
  }
  if (asset.status !== 'active') {
    return { reason: 'status_not_active', detail: `资产当前为 ${asset.status}` };
  }
  if (!asset.evidenceRefs.length) {
    return { reason: 'missing_evidence', detail: '缺少来源证据，不进能力包' };
  }
  // 限定了接收方就必须按它过滤，否则这个字段只是装饰。
  // 缺失 = 不限定（放行）；空数组 = 谁都不给（拦死）——两者含义不同。
  if (asset.targetAgentIds !== undefined && !asset.targetAgentIds.includes(targetAgent)) {
    return { reason: 'not_for_this_agent', detail: '未授权给这个智能体' };
  }
  // forbiddenWhen 命中即排除。空数组只代表没写过禁用条件，不构成放行理由。
  if (asset.forbiddenWhen?.length && situation.length) {
    const hit = asset.forbiddenWhen.find((condition) => situation.some(
      (tag) => condition.toLocaleLowerCase().includes(tag.toLocaleLowerCase()),
    ));
    if (hit) return { reason: 'forbidden_here', detail: `命中禁用条件：${hit}` };
  }
  return null;
}

/** 被 replaces 关系指向的资产要让位给新版本，避免包里同时带着新旧两条互相矛盾的判断。 */
function supersededAssetIds(assets: RecallAbilityAssetRecord[]): Set<string> {
  const superseded = new Set<string>();
  const present = new Set(assets.map((asset) => asset.id));
  for (const asset of assets) {
    if (asset.status !== 'active') continue;
    for (const relation of asset.relations ?? []) {
      if (relation.kind === 'replaces' && present.has(relation.assetId)) {
        superseded.add(relation.assetId);
      }
    }
  }
  return superseded;
}

function toAssetRef(asset: RecallAbilityAssetRecord): PackAssetRef {
  return {
    assetId: asset.id,
    version: asset.version,
    type: asset.type,
    title: asset.title,
    statement: asset.statement,
    statementHash: sha256(asset.statement),
    scope: asset.scope,
    ...(asset.applicableWhen?.length ? { applicableWhen: [...asset.applicableWhen] } : {}),
    ...(asset.forbiddenWhen?.length ? { forbiddenWhen: [...asset.forbiddenWhen] } : {}),
  };
}

/** 构建能力包。资产按 id 排序后冻结，保证同一组资产的 contentHash 稳定，
 *  不受 listAbilityAssets 返回顺序（按 updatedAt 排）影响。 */
export function buildCapabilityPack(input: BuildCapabilityPackInput): MinimumCapabilityPack {
  const packId = requireText(input.packId, 'pack id', 160);
  if (!/^[A-Za-z0-9_-]+$/.test(packId)) throw new Error('invalid capability pack id');
  const purpose = requireText(input.purpose, 'purpose', MAX_PURPOSE_LENGTH);
  const targetAgent = requireText(input.targetAgent, 'target agent', MAX_TARGET_LENGTH);
  const frozenAt = requireIsoTimestamp(input.frozenAt, 'frozen at');
  const expiresAt = requireIsoTimestamp(input.expiresAt, 'expires at');
  if (Date.parse(expiresAt) <= Date.parse(frozenAt)) {
    throw new Error('capability pack must expire after it is frozen');
  }
  if (!Array.isArray(input.assets)) throw new Error('invalid capability pack assets');

  const userExcluded = new Set(input.userExcludedAssetIds ?? []);
  const situation = input.situation ?? [];
  const superseded = supersededAssetIds(input.assets);

  const assets: PackAssetRef[] = [];
  const excluded: PackExcludedAsset[] = [];

  for (const asset of [...input.assets].sort((a, b) => a.id.localeCompare(b.id))) {
    const exclusion = excludeReasonFor(asset, userExcluded, situation, targetAgent);
    if (exclusion) {
      excluded.push({ assetId: asset.id, reason: exclusion.reason, ...(exclusion.detail ? { detail: exclusion.detail } : {}) });
      continue;
    }
    if (superseded.has(asset.id)) {
      excluded.push({ assetId: asset.id, reason: 'superseded', detail: '已被更新的资产取代' });
      continue;
    }
    assets.push(toAssetRef(asset));
  }

  if (assets.length > MAX_PACK_ASSETS) {
    throw new Error('capability pack exceeds the maximum asset count');
  }

  const body = { purpose, targetAgent, expiresAt, assets, excluded };
  return { packId, frozenAt, ...body, contentHash: computePackContentHash(body) };
}

export function isPackExpired(pack: MinimumCapabilityPack, at: string | number = Date.now()): boolean {
  const now = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(now)) throw new Error('invalid capability pack clock reading');
  return now >= Date.parse(pack.expiresAt);
}

/** 重算内容哈希并与包内记录比对。任何字段被改动过都会在这里暴露。
 *  失败即拒绝——不做「尽力而为」的降级读取。 */
export function assertPackIntegrity(pack: MinimumCapabilityPack): void {
  // 先逐条核对 statementHash 与 statement 是否自洽，再核对整包。
  // 分两步是为了让错误信息指得出是哪一条资产被动过。
  for (const ref of pack.assets) {
    if (sha256(ref.statement) !== ref.statementHash) {
      throw new Error(`capability pack statement hash mismatch for ${ref.assetId}`);
    }
  }
  const recomputed = computePackContentHash(pack);
  if (recomputed !== pack.contentHash) {
    throw new Error('capability pack content hash mismatch');
  }
}
