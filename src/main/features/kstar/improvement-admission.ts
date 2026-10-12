import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { listAppliedUsageReceipts, type AppliedUsageReceipt } from '../recall/asset-usage-receipt';
import type { CognitionSourceRef } from '../recall/source-service';
import {
  KSTAR_IMPROVEMENT_OUTCOME_REASON_MAX,
  recordKstarImprovementOutcome,
  type KstarAdoptedAssetRef,
  type KstarImprovementConclusion,
  type KstarImprovementOutcomeRecord,
} from './improvement-outcome';
import type { KstarCandidateProposal } from './types';

/**
 * improvement-admission.ts — 改进提案准入**唯一处**（specs/015 D1/D2，任务 T007）。
 *
 * 为什么要有这道门：改进提案说的是「把既有方法改成更好」——改的前提是**确实用过它**。
 * 只被带进上下文（injection receipt `injected`/`dispatched`）不等于用过；本模块只认
 * 「实际采用」的唯一权威口径 = usage 回执 `status='applied' && boundary='real'`
 * （specs/011 定稿，读取一律走 `listAppliedUsageReceipts`，**不在这里重判状态**）。
 *
 * 本模块只做两件事：
 *  ① **纯决策**：逐条决定提案能否进入候选（不写候选、不改资产、不碰候选状态）；
 *  ② **结论落档**：拦下或"无法核对"时，用 `kio-<episodeId>` 派生 id 落一条
 *     `insufficient_evidence` / `analysis_failed` 结论（同 episode 覆盖同一条 → 幂等）。
 *
 * 两条沉淀线（`task-level-precipitation.ts` 需求级 / `direct-experience-assets.ts` 直通线）
 * 都必须经这里，不得各自再写一套采用判定。
 *
 * 隐私：`reason` 与日志只出现 id、版本号与固定措辞——受限资产正文一律不进记录。
 */

const log = createLogger('kstar.improvement-admission');

/** 受此门约束的动作：这三类都在**改既有对象**（update=更新 / limit_scope=限缩适用范围 /
 *  pause=停用），改错对象的代价最高。`create` 型提案没有旧版可改，**不受此门影响**。 */
export const KSTAR_ADMISSION_GATED_ACTIONS = ['update', 'limit_scope', 'pause'] as const;
export type KstarAdmissionGatedAction = (typeof KSTAR_ADMISSION_GATED_ACTIONS)[number];

/** 两条沉淀线（D1/D2）：调用方必须声明自己来自哪条线，用于结论措辞与日志归因。 */
export const KSTAR_ADMISSION_SOURCES = ['requirement_level', 'direct_experience'] as const;
export type KstarAdmissionSource = (typeof KSTAR_ADMISSION_SOURCES)[number];

/** 每条提案的判定码（一次调用里每条提案有且只有一个）。 */
export type KstarAdmissionCode =
  /** 门不适用（新建型/无目标），或证据齐备后放行。 */
  | 'admitted'
  /** 存量数据：提案没记录任务当时用的版本 → 不拦，但如实记「无法核对改进对象」。 */
  | 'admitted_unverifiable_target'
  /** 有目标与版本，但查无同 assetId 同版本的 `applied` 回执（含版本不一致）。 */
  | 'blocked_no_applied_evidence'
  /** 采用证据读取失败 → fail-closed（不猜），按 `analysis_failed` 记结论。 */
  | 'blocked_evidence_unavailable';

export type KstarAdmissionBlockedCode = Extract<KstarAdmissionCode, `blocked_${string}`>;

/** `appliedAdoption` 的查询形态：本次分析覆盖的任务运行 id（任务 B 及其同需求的其他 episode）。 */
export interface KstarAppliedAdoptionQuery {
  taskRunIds: string[];
}

/**
 * 采用证据的两种传法（**读取口径必须来自 `listAppliedUsageReceipts`**）：
 *  - `readonly AppliedUsageReceipt[]`：调用方已按 T003 取好（数组即唯一权威口径的结果）；
 *  - `{ taskRunIds }`：本模块内部调 `listAppliedUsageReceipts` 取（避免调用方各写一遍判定）。
 * 两种形态都不会重判 `status`/`boundary`——那是 `asset-usage-receipt.ts` 的职责。
 */
export type KstarAppliedAdoption = readonly AppliedUsageReceipt[] | KstarAppliedAdoptionQuery;

export interface KstarAdmissionContext {
  source: KstarAdmissionSource;
  appliedAdoption: KstarAppliedAdoption;
  /** 结论回指复盘（`cloud/kstar/reviews/<reviewId>.json`）。 */
  reviewId: string;
  /** 结论 id 由此派生（`kio-<episodeId>`）：需求级分析取主 episode，直通线取该 episode。 */
  episodeId: string;
  requirementId?: string;
}

export interface KstarAdmissionDecision {
  proposal: KstarCandidateProposal;
  admitted: boolean;
  code: KstarAdmissionCode;
  /** 人话短句（≤240 字，只含 id 与版本号）：被拦时说清缺哪一项；放行时说明依据。 */
  reason: string;
  /** 放行且核对通过时：命中的采用回执 id。 */
  appliedReceiptId?: string;
}

export interface KstarAdmissionBlockedProposal {
  proposal: KstarCandidateProposal;
  code: KstarAdmissionBlockedCode;
  reason: string;
}

export interface KstarAdmissionResult {
  /** 放行（可进入候选）的提案，顺序与入参一致。 */
  admitted: KstarCandidateProposal[];
  /** 被拦下的提案（带原因）——调用方**不得**把它们送进候选。 */
  blocked: KstarAdmissionBlockedProposal[];
  /** 逐条判定明细（含放行的理由），供调用方记账/日志。 */
  decisions: KstarAdmissionDecision[];
  /** 已落档的结论 id（`kio-<episodeId>`）；本次无需落档时为 `null`。 */
  outcomeId: string | null;
  /** 已落档的结论记录本体（读回校验后的形状），无落档时为 `null`。 */
  outcome: KstarImprovementOutcomeRecord | null;
}

interface GatedTarget {
  assetId: string;
  /** 任务当时用的版本；空串 = 存量数据（提案没记版本）。 */
  version: string;
}

const GATED_ACTIONS = new Set<string>(KSTAR_ADMISSION_GATED_ACTIONS);
const SOURCES = new Set<string>(KSTAR_ADMISSION_SOURCES);
const SOURCE_LABELS: Record<KstarAdmissionSource, string> = {
  requirement_level: '需求级改进分析',
  direct_experience: '任务级改进分析',
};
/** 结论里最多带几条采用摘要 / 证据引用（记录只存摘要，不堆量）。 */
const ADOPTED_REFS_MAX = 20;
const EVIDENCE_REFS_MAX = 10;
const VERSION_LIST_MAX = 3;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 受门约束的提案 → 目标；不受门约束（新建型、或没指定目标方法）返回 `null`。
 * 「受门」= `suggestedAction ∈ {update, limit_scope, pause}` **且**带合法 `targetAssetId`。
 */
function gatedTarget(proposal: KstarCandidateProposal): GatedTarget | null {
  if (!isPlainObject(proposal)) return null;
  const action = typeof proposal.suggestedAction === 'string' ? proposal.suggestedAction : '';
  if (!GATED_ACTIONS.has(action)) return null;
  const assetId = typeof proposal.targetAssetId === 'string' ? proposal.targetAssetId : '';
  if (!safeId(assetId)) return null;
  const version = typeof proposal.targetVersionUsed === 'string' ? proposal.targetVersionUsed.trim() : '';
  return { assetId, version };
}

/** 数组形态鉴定（`readonly AppliedUsageReceipt[]` 与查询对象区分；`Array.isArray` 直接收窄不可靠）。 */
function isAppliedReceiptList(value: KstarAppliedAdoption): value is readonly AppliedUsageReceipt[] {
  return Array.isArray(value);
}

/** 形状校验（**不判 `status`/`boundary`**：那是权威口径的职责，见文件头注释）。 */
function isAppliedReceiptLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const receipt = value as unknown as AppliedUsageReceipt;
  return typeof receipt.id === 'string' && safeId(receipt.id)
    && typeof receipt.assetId === 'string' && safeId(receipt.assetId)
    && typeof receipt.assetVersion === 'string' && !!receipt.assetVersion
    && typeof receipt.taskRunId === 'string' && safeId(receipt.taskRunId);
}

function isValidAppliedAdoption(value: KstarAppliedAdoption): boolean {
  if (!value || typeof value !== 'object') return false;
  if (isAppliedReceiptList(value)) return value.every(isAppliedReceiptLike);
  const query = value as KstarAppliedAdoptionQuery;
  return Array.isArray(query.taskRunIds)
    && query.taskRunIds.every((taskRunId) => typeof taskRunId === 'string' && safeId(taskRunId));
}

function assertAdmissionInput(
  userId: string,
  proposals: KstarCandidateProposal[],
  context: KstarAdmissionContext,
): void {
  if (
    !safeId(userId)
    || !Array.isArray(proposals)
    || !proposals.every(isPlainObject)
    || !isPlainObject(context)
    || !SOURCES.has(String(context.source))
    || !safeId(context.reviewId)
    || !safeId(context.episodeId)
    || (context.requirementId !== undefined && !safeId(context.requirementId))
    || !isValidAppliedAdoption(context.appliedAdoption)
  ) throw new Error('invalid kstar improvement admission reference');
}

/** 版本号列表的可读写法：`「1」「2」`（超过 3 个只列前 3 个）。 */
function versionLabel(versions: readonly string[]): string {
  const unique = [...new Set(versions.filter((version) => !!version))];
  const shown = unique.slice(0, VERSION_LIST_MAX);
  const suffix = unique.length > shown.length ? ` 等 ${unique.length} 个版本` : '';
  return `${shown.map((version) => `「${version}」`).join('')}${suffix}`;
}

/** 有界拼接：结论 `reason` 封顶 240 字，超出时截断并显式说明"其余未逐条列出"。 */
function boundedJoin(parts: readonly string[], max: number = KSTAR_IMPROVEMENT_OUTCOME_REASON_MAX): string {
  const joined = parts.join('；');
  if (joined.length <= max) return joined;
  const tail = '…（其余未逐条列出）';
  if (max <= tail.length + 1) return joined.slice(0, Math.max(1, max));
  return `${joined.slice(0, max - tail.length)}${tail}`;
}

/** 本次分析「看到的实际采用」摘要：只含本门涉及的目标资产，只存标识与版本。 */
function adoptedAssetRefsFor(
  applied: readonly AppliedUsageReceipt[],
  assetIds: ReadonlySet<string>,
): KstarAdoptedAssetRef[] {
  const out: KstarAdoptedAssetRef[] = [];
  const seen = new Set<string>();
  for (const receipt of applied) {
    if (!assetIds.has(receipt.assetId)) continue;
    const key = `${receipt.assetId}:${receipt.assetVersion}:${receipt.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ assetId: receipt.assetId, assetVersion: receipt.assetVersion, usageReceiptId: receipt.id });
    if (out.length >= ADOPTED_REFS_MAX) break;
  }
  return out;
}

/** 证据引用取自回执自身的 `evidenceRefs`（只留元数据，`recordKstarImprovementOutcome` 再脱敏去重）。 */
function evidenceRefsFor(
  applied: readonly AppliedUsageReceipt[],
  assetIds: ReadonlySet<string>,
): CognitionSourceRef[] {
  const out: CognitionSourceRef[] = [];
  for (const receipt of applied) {
    if (!assetIds.has(receipt.assetId)) continue;
    for (const ref of receipt.evidenceRefs) {
      out.push(ref);
      if (out.length >= EVIDENCE_REFS_MAX) return out;
    }
  }
  return out;
}

/**
 * 提案准入（**纯决策 + 结论落档**，T007）。
 *
 * 规则（逐条）：
 *  1. `suggestedAction ∈ {update, limit_scope, pause}` 且带 `targetAssetId` →
 *     **必须**存在 `assetId === targetAssetId` 且 `assetVersion === targetVersionUsed`
 *     的「实际采用」记录（`listAppliedUsageReceipts` 口径）；版本不一致同样**拦下**
 *     （改错版本等于改错对象）。
 *  2. 这类提案缺 `targetVersionUsed`（存量候选）→ **不拦**，但记
 *     `insufficient_evidence` 如实说明「无法核对改进对象」。
 *  3. 其余提案（`create` 等）不受此门影响，原样放行。
 *  4. 被拦提案不进入候选；证据读取失败时 fail-closed（不猜），按 `analysis_failed` 记结论。
 *  5. 结论幂等：id 由 `kio-<episodeId>` 派生，同 episode 反复决策仍只有一条记录。
 *
 * **不写候选、不改资产、不改候选状态**——本函数只读回执、只写结论记录。
 */
export async function admitKstarProposals(
  userId: string,
  proposals: KstarCandidateProposal[],
  context: KstarAdmissionContext,
): Promise<KstarAdmissionResult> {
  assertAdmissionInput(userId, proposals, context);

  const targets = new Map<KstarCandidateProposal, GatedTarget>();
  for (const proposal of proposals) {
    const target = gatedTarget(proposal);
    if (target) targets.set(proposal, target);
  }
  // 只有"需要核对版本"的提案才需要证据：存量提案（无版本）与新建型都不查。
  const needsEvidence = [...targets.values()].some((target) => target.version !== '');
  let applied: AppliedUsageReceipt[] = [];
  let readFailed = false;
  if (needsEvidence) {
    try {
      applied = isAppliedReceiptList(context.appliedAdoption)
        ? [...context.appliedAdoption]
        : await listAppliedUsageReceipts(userId, { taskRunIds: [...context.appliedAdoption.taskRunIds] });
    } catch (error) {
      readFailed = true;
      log.warn('kstar improvement admission evidence read failed', {
        userId,
        source: context.source,
        episodeId: context.episodeId,
        error: (error as Error).message,
      });
    }
  }

  const decisions: KstarAdmissionDecision[] = [];
  for (const proposal of proposals) {
    const target = targets.get(proposal);
    if (!target) {
      decisions.push({
        proposal, admitted: true, code: 'admitted',
        reason: '新建型（或没有指定目标方法）的提议不受采用门限制。',
      });
      continue;
    }
    if (!target.version) {
      decisions.push({
        proposal, admitted: true, code: 'admitted_unverifiable_target',
        reason: `这条改进提议没有记录任务当时用的版本（存量数据），无法核对改进对象「${target.assetId}」；`
          + '照常进入候选，请人工确认改的是不是那一版。',
      });
      continue;
    }
    if (readFailed) {
      decisions.push({
        proposal, admitted: false, code: 'blocked_evidence_unavailable',
        reason: `读取「实际采用」证据失败，无法核对改进对象「${target.assetId}」；为避免改错对象，这条改进提议没有进入候选。`,
      });
      continue;
    }
    const matched = applied.find(
      (receipt) => receipt.assetId === target.assetId && receipt.assetVersion === target.version,
    );
    if (matched) {
      decisions.push({
        proposal, admitted: true, code: 'admitted', appliedReceiptId: matched.id,
        reason: `已核对：任务里存在「${target.assetId}」v${target.version} 的实际采用记录，改进对象成立。`,
      });
      continue;
    }
    const adoptedVersions = applied
      .filter((receipt) => receipt.assetId === target.assetId)
      .map((receipt) => receipt.assetVersion);
    decisions.push({
      proposal, admitted: false, code: 'blocked_no_applied_evidence',
      reason: adoptedVersions.length
        ? `方法「${target.assetId}」被实际采用的版本是${versionLabel(adoptedVersions)}，`
          + `与本提议依据的「${target.version}」不一致，无法确认改的就是当年那一版；这条改进提议没有进入候选。`
        : `没有找到方法「${target.assetId}」v${target.version} 被实际采用的记录`
          + `（只被带入不算采用）；这条改进提议没有进入候选。`,
    });
  }

  const admitted = decisions.filter((decision) => decision.admitted).map((decision) => decision.proposal);
  const blocked: KstarAdmissionBlockedProposal[] = decisions
    .filter((decision): decision is KstarAdmissionDecision & { code: KstarAdmissionBlockedCode } => (
      !decision.admitted
    ))
    .map((decision) => ({ proposal: decision.proposal, code: decision.code, reason: decision.reason }));

  // 落档：拦下过、或有"无法核对"的放行 → 一条结论（同一 episode 覆盖同一条）。
  const notes = decisions.filter((decision) => decision.code !== 'admitted');
  let outcome: KstarImprovementOutcomeRecord | null = null;
  let outcomeId: string | null = null;
  if (notes.length) {
    const conclusion: KstarImprovementConclusion = readFailed ? 'analysis_failed' : 'insufficient_evidence';
    const label = SOURCE_LABELS[context.source];
    const reason = readFailed
      ? `${label}：读取「实际采用」证据失败，${notes.length} 条改进提议因无法核对改进对象而没有进入候选。`
      : `${label}：${boundedJoin(notes.map((note) => note.reason), KSTAR_IMPROVEMENT_OUTCOME_REASON_MAX - label.length - 1)}`;
    const assetIds = new Set([...targets.values()].map((target) => target.assetId));
    outcome = await recordKstarImprovementOutcome(userId, {
      episodeId: context.episodeId,
      reviewId: context.reviewId,
      conclusion,
      reason,
      ...(context.requirementId ? { requirementId: context.requirementId } : {}),
      evidenceRefs: readFailed ? [] : evidenceRefsFor(applied, assetIds),
      adoptedAssetRefs: readFailed ? undefined : adoptedAssetRefsFor(applied, assetIds),
      ...(conclusion === 'analysis_failed' ? { failureCategory: 'evidence' as const } : {}),
    });
    outcomeId = outcome.id;
  }
  if (blocked.length || readFailed) {
    log.warn('kstar improvement admission blocked proposals', {
      userId,
      source: context.source,
      episodeId: context.episodeId,
      admitted: admitted.length,
      blocked: blocked.length,
      evidenceReadFailed: readFailed,
    });
  }
  return { admitted, blocked, decisions, outcomeId, outcome };
}
