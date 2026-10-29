/**
 * AI 提出的资产实质变化须经用户审批。
 *
 * AI 提出的方法正文 / 事实判断 / 适用范围实质变化**不直接生效**，
 * 而是落成一条提议 + 对话内审批卡片，由用户三态处置：
 *   - 确认更新 → 重检版本后生效；版本不一致时作废，基于新版本重提
 *   - 稍后处理 → 保持待处理、进待确认清单，不丢失
 *   - 拒绝 → 关闭并留档，同一变更不再重复提交
 *
 * 三条不变量：
 *   ① `pending`/`deferred` 期间**资产内容不变**（提议不是锁，也不提前动手）；
 *   ② 有待处理提议**不阻塞**该资产的正常使用；
 *   ③ 实质变化的字段判定**复用** `SUBSTANTIAL_FIELDS`（工具层那一份）——两处各写
 *      一份字段清单就是下一个漂移源。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import { fileEditLock } from '../../util/locks';
import { recallJsonRecordPath } from './paths';
import { appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord, updateRecallJsonRecord } from './store';
import { contentPurgedError, purgedOrganizationRecord } from './organization-content-lifecycle';
import type { RecallJsonRecord } from './types';
import { listAbilityAssetVersions, readAbilityAsset, readAbilityAssetVersionSnapshot, updateAbilityAsset, type UpdateAbilityAssetInput } from './asset-service';

const log = createLogger('recall.asset-approval');

/** `superseded`（「冲突即作废重提」）：提议基于的 baseline 版本已被
 *  后来的改动顶掉（或资产本身已撤回/删除/清除），confirm 对这条提议**永久
 *  不可达**——与其让卡片停在「重新看一眼再决定」的死路上，不如作废关闭。
 *  作废不算「已经提过」（不进去重拦截）：AI 基于最新版本重新提议是合法的新提议。 */
export type AssetApprovalState = 'pending' | 'confirmed' | 'rejected' | 'deferred' | 'superseded';

/** 已处置终态：状态迁移类 patch 的锁内 CAS 一律拒绝从这些状态再迁出。 */
const DECIDED_STATES: ReadonlySet<AssetApprovalState> = new Set(['confirmed', 'rejected', 'superseded']);
/** 可处置状态（decide 三态的合法起点）。 */
const OPEN_STATES: ReadonlySet<AssetApprovalState> = new Set(['pending', 'deferred']);

/** 锁内 CAS 复核抛出：decide 开头的终态预检在锁外，并发交错时真正
 *  拦住重复处置的是 patch 状态迁移里的这道锁内复核。 */
class ProposalAlreadyDecidedError extends Error {
  constructor(readonly decidedState: AssetApprovalState) {
    super(`asset change proposal already decided: ${decidedState}`);
  }
}

export interface AssetChangeProposal extends RecallJsonRecord {
  id: string;
  contentPurgedAt?: string;
  assetId: string;
  /** 提出时的资产版本：确认时拿它做重检（不一致 → 不静默覆盖）。 */
  baselineVersion: string;
  /** Selected content at proposal time; absent on legacy proposals. */
  baselineActiveVersion?: string;
  /** 变更前后的**摘要**（与台账同口径，不落受限正文全文）。 */
  before: string;
  after: string;
  /** 变更涉及的字段（与 SUBSTANTIAL_FIELDS 同源）。 */
  fields: string[];
  /** 拟生效的字段值。用户可在卡片上编辑——编辑后的值走同一条生效路径。 */
  payload: Record<string, unknown>;
  /** 提出时这几个字段**当前**的值。卡片要能让用户对比"当前 → 拟生效"，
   *  只给摘要（字数 + 前缀）用户没法判断要不要批——审批卡的用处就在这。
   *  老提议可能没有这个字段（实现期补），卡片如实降级为"当前值不可用"。 */
  beforeValues?: Record<string, unknown>;
  /** AI 的依据。 */
  reason: string;
  state: AssetApprovalState;
  /** 同资产同变更去重键：已有待处理/已拒绝的同一变更不再重复提交。 */
  dedupeKey?: string;
  createdAt: string;
  decidedAt?: string;
  appliedVersion?: string;
  /** 用户编辑过卡片内容时记下编辑前的 payload（编辑本身也要进台账）。 */
  editedFrom?: Record<string, unknown>;
  /** 卡片消息 id：回执与定位用。 */
  cardMessageId?: string;
  /** 并发冲突后的补偿结果；失败时保留 appliedVersion 供人工/后续重试。 */
  rollback?: {
    status: 'full' | 'partial' | 'failed';
    failedFields: string[];
    appliedVersion: string;
    at: string;
  };
}

export interface CreateAssetChangeProposalInput {
  assetId: string;
  baselineVersion: string;
  /** Selected content at proposal time; absent on legacy proposals. */
  baselineActiveVersion?: string;
  fields: string[];
  payload: Record<string, unknown>;
  beforeValues?: Record<string, unknown>;
  before: string;
  after: string;
  reason: string;
}

export type AssetApprovalDecision = 'confirm' | 'defer' | 'reject';

export interface AssetApprovalDecisionResult {
  ok: boolean;
  state: AssetApprovalState;
  /** 确认时：版本重检不一致——卡片保持待处理，**不得**静默覆盖。 */
  versionConflict?: { baselineVersion: string; currentVersion: string };
  /** 标签基线在提议后被改动：整组替换会静默覆盖期间新增的标签，提议作废。 */
  tagConflict?: { baselineTags: string[]; currentTags: string[] };
  /** 生效后的资产版本（确认成功时）。 */
  appliedVersion?: string;
  /** 确认与并发处置冲突时的补偿结果；失败时让界面如实提示，不谎称已恢复。 */
  rollback?: {
    status: 'full' | 'partial' | 'failed';
    failedFields: string[];
    appliedFields: string[];
    appliedVersion: string;
    rolledBackVersion?: string;
  };
  /** 拒绝/稍后时不适用；如实说明为什么没生效。 */
  message?: string;
}

function approvalsDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, 'asset-approvals', 'placeholder'));
}

function proposalIdFor(dedupeKey: string): string {
  return `ap-${dedupeKey.slice(0, 24)}`;
}

/** 去重键：同资产 + 同字段集 + 同取值 = 同一次变更。
 *
 *  取值按字段名排序后序列化，所以"字段顺序不同但内容相同"算同一次变更——
 *  否则模型换个顺序提交就能绕过去重。 */
export function assetChangeDedupeKey(assetId: string, payload: Record<string, unknown>): string {
  const normalized = Object.keys(payload).sort().map((key) => [key, payload[key]]);
  return crypto.createHash('sha256').update(JSON.stringify([assetId, normalized])).digest('hex');
}

function asProposal(value: RecallJsonRecord): AssetChangeProposal {
  if (
    typeof value.assetId !== 'string' || !safeId(value.assetId)
    || typeof value.baselineVersion !== 'string' || !value.baselineVersion.trim()
    || (value.contentPurgedAt !== undefined && (typeof value.contentPurgedAt !== 'string' || !Number.isFinite(Date.parse(value.contentPurgedAt))))
    || (!value.contentPurgedAt && (typeof value.dedupeKey !== 'string' || !value.dedupeKey))
    || typeof value.reason !== 'string'
    || !['pending', 'confirmed', 'rejected', 'deferred', 'superseded'].includes(String(value.state))
    || !Array.isArray(value.fields)
    || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)
  ) throw new Error('malformed asset change proposal');
  return value as AssetChangeProposal;
}

async function readableProposal(userId: string, raw: RecallJsonRecord): Promise<AssetChangeProposal> {
  const proposal = asProposal(raw);
  const asset = await readAbilityAsset(userId, proposal.assetId);
  return proposal.contentPurgedAt || asset?.status === 'purged'
    ? asProposal(purgedOrganizationRecord('asset-approvals', raw, proposal.contentPurgedAt || asset!.purgedAt || new Date().toISOString()))
    : proposal;
}

export async function listAssetChangeProposals(
  userId: string,
  filter: { assetId?: string; state?: AssetApprovalState } = {},
): Promise<AssetChangeProposal[]> {
  let names: string[];
  try {
    names = await fs.readdir(approvalsDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map((name) => readRecallJsonRecord(userId, 'asset-approvals', name.slice(0, -5))));
  const proposals: AssetChangeProposal[] = [];
  for (const raw of records) {
    if (!raw) continue;
    try {
      const proposal = await readableProposal(userId, raw);
      if (filter.assetId && proposal.assetId !== filter.assetId) continue;
      if (filter.state && proposal.state !== filter.state) continue;
      proposals.push(proposal);
    } catch (error) {
      log.warn('skipping malformed asset change proposal', { id: String(raw.id), error: (error as Error).message });
    }
  }
  return proposals.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readAssetChangeProposal(
  userId: string,
  proposalId: string,
): Promise<AssetChangeProposal | undefined> {
  if (!safeId(proposalId)) throw new Error('invalid asset change proposal id');
  const raw = await readRecallJsonRecord(userId, 'asset-approvals', proposalId);
  return raw ? readableProposal(userId, raw) : undefined;
}

/** 同一次变更是否已经提过（待处理/稍后/已拒绝都算"已经提过"）。
 *
 *  已确认的不算：那次已经生效，资产随后可能被改回，同一变更再提一次是合理的
 *  新提议（去重键相同但 baselineVersion 不同，是另一件事）。
 *  已作废（superseded）同样不算：版本冲突作废后，AI 基于最新版本重提同一
 *  变更正是「冲突即作废重提」要放的行。 */
const DEDUPE_BLOCKING_STATES: ReadonlySet<AssetApprovalState> = new Set(['pending', 'deferred', 'rejected']);

export async function findExistingAssetChangeProposal(
  userId: string,
  dedupeKey: string,
): Promise<AssetChangeProposal | undefined> {
  const all = await listAssetChangeProposals(userId);
  return all.find((proposal) => proposal.dedupeKey === dedupeKey && DEDUPE_BLOCKING_STATES.has(proposal.state));
}

/** 建一条提议（幂等：同一变更已有待处理/稍后/已拒绝的，返回那一条，不新建）。 */
export async function createAssetChangeProposal(
  userId: string,
  input: CreateAssetChangeProposalInput,
): Promise<{ proposal: AssetChangeProposal; created: boolean }> {
  if (!safeId(input.assetId)) throw new Error('invalid ability asset id');
  if (!input.reason.trim()) throw new Error('asset change proposal requires a reason');
  if ((await readAbilityAsset(userId, input.assetId))?.status === 'purged') throw contentPurgedError();
  const dedupeKey = assetChangeDedupeKey(input.assetId, input.payload);
  const existing = await findExistingAssetChangeProposal(userId, dedupeKey);
  if (existing) return { proposal: existing, created: false };

  const id = proposalIdFor(dedupeKey);
  const record: AssetChangeProposal = {
    schemaVersion: 1,
    ownerId: userId,
    id,
    assetId: input.assetId,
    baselineVersion: input.baselineVersion,
    ...(input.baselineActiveVersion ? { baselineActiveVersion: input.baselineActiveVersion } : {}),
    before: input.before,
    after: input.after,
    fields: [...input.fields],
    payload: input.payload,
    ...(input.beforeValues ? { beforeValues: input.beforeValues } : {}),
    reason: input.reason,
    state: 'pending',
    dedupeKey,
    createdAt: new Date().toISOString(),
  };
  const { writeRecallJsonRecord } = await import('./store');
  await writeRecallJsonRecord(userId, 'asset-approvals', id, record);
  // 「AI 提出过什么」必须留痕，且**在实体创建这一处**写：放在调用方写就会漏
  // （谁忘了谁漏，而漏掉的恰是"AI 想改但没改"这个最关键的事实）。
  await appendApprovalAudit(userId, record.assetId, 'approval_proposed', {
    actor: 'ai',
    reason: `AI 自主提出实质变化，转审批卡片：${record.reason}`,
    note: `proposal=${id}；涉及 ${record.fields.join(' / ')}`,
  });
  return { proposal: record, created: true };
}

async function patchProposal(
  userId: string,
  proposalId: string,
  patch: Partial<AssetChangeProposal>,
): Promise<AssetChangeProposal> {
  const updated = await updateRecallJsonRecord(userId, 'asset-approvals', proposalId, (raw) => {
    if (!raw) throw new Error('asset change proposal not found');
    return { ...raw, ...patch } as RecallJsonRecord;
  });
  return asProposal(updated);
}

/** 状态迁移类 patch（锁内 CAS）：期望状态集与写入在同一条文件锁内复核。
 *
 *  decide 开头的终态预检是锁外直读，并发 reject/confirm 交错时形同虚设——
 *  真正拦住「已处置再处置」的是这里：updater 在 fileEditLock 内先比对当前
 *  state ∈ expected 才落 patch，否则抛 `ProposalAlreadyDecidedError` 交调用方
 *  翻译成「已经处置过」回执。对齐 asset-service updateAbilityAsset 的
 *  expectedVersion 锁内比对先例。 */
async function patchProposalTransition(
  userId: string,
  proposalId: string,
  patch: Partial<AssetChangeProposal>,
  expected: ReadonlySet<AssetApprovalState> = OPEN_STATES,
): Promise<AssetChangeProposal> {
  const updated = await updateRecallJsonRecord(userId, 'asset-approvals', proposalId, (raw) => {
    if (!raw) throw new Error('asset change proposal not found');
    const state = String(raw.state) as AssetApprovalState;
    if (!expected.has(state)) {
      throw new ProposalAlreadyDecidedError(DECIDED_STATES.has(state) ? state : 'confirmed');
    }
    return { ...raw, ...patch } as RecallJsonRecord;
  });
  return asProposal(updated);
}

/** 「已经处置过」的统一回执（decide 三分支共用）。 */
function alreadyDecided(decidedState: AssetApprovalState): AssetApprovalDecisionResult {
  return { ok: false, state: decidedState, message: '这条提议已经处置过了。' };
}

/** 提议自己的台账行（挂在目标资产上，与写操作的台账同一处可查）。
 *  `approval_superseded`：版本冲突/资产不可达后的作废动作留痕。 */
async function appendApprovalAudit(
  userId: string,
  assetId: string,
  action: 'approval_proposed' | 'approval_confirmed' | 'approval_rejected' | 'approval_deferred' | 'approval_edited' | 'approval_superseded',
  metadata: { reason: string; actor: 'ai' | 'user'; note?: string },
): Promise<void> {
  await appendRecallJsonlRecord(userId, 'ability-asset-audit', assetId, {
    schemaVersion: 1,
    ownerId: userId,
    id: `${assetId}-${action}-${new Date().toISOString().replace(/[^A-Za-z0-9]/g, '')}`,
    assetId,
    action,
    at: new Date().toISOString(),
    actor: metadata.actor,
    ...(metadata.note ? { note: metadata.note } : {}),
    reason: metadata.reason,
  } satisfies RecallJsonRecord);
}

/** 卡片载荷（main → renderer）：按 contracts/ipc-and-cards.md 的形状。 */
export interface AssetChangeApprovalCard {
  kind: 'asset_change_approval';
  proposalId: string;
  assetId: string;
  assetTitle: string;
  baselineVersion: string;
  diff: { before: string; after: string; fields: string[] };
  reason: string;
  actions: Array<'confirm' | 'defer' | 'reject'>;
}

export function buildAssetChangeApprovalCard(
  proposal: AssetChangeProposal,
  assetTitle: string,
): AssetChangeApprovalCard {
  return {
    kind: 'asset_change_approval',
    proposalId: proposal.id,
    assetId: proposal.assetId,
    assetTitle: String(assetTitle || '').slice(0, 200),
    baselineVersion: proposal.baselineVersion,
    diff: { before: proposal.before, after: proposal.after, fields: [...proposal.fields] },
    reason: proposal.reason.slice(0, 1_000),
    actions: proposal.contentPurgedAt ? [] : ['confirm', 'defer', 'reject'],
  };
}

/** 用户编辑卡片内容：编辑本身进台账（actor='user'），但不改提议状态。 */
export async function editAssetChangeProposal(
  userId: string,
  proposalId: string,
  payload: Record<string, unknown>,
): Promise<AssetChangeProposal> {
  const current = await readAssetChangeProposal(userId, proposalId);
  if (!current) throw new Error('asset change proposal not found');
  if (current.contentPurgedAt) throw contentPurgedError();
  if (current.state !== 'pending') throw new Error('asset change proposal is not pending');
  // 锁内复核仍 pending：外层检查与写入之间提议可能已被处置。
  const edited = await patchProposalTransition(userId, proposalId, {
    payload,
    editedFrom: current.editedFrom || current.payload,
  }, new Set<AssetApprovalState>(['pending']));
  await appendApprovalAudit(userId, current.assetId, 'approval_edited', {
    actor: 'user',
    reason: '用户编辑了审批卡片上的拟生效内容',
    note: `proposal=${proposalId}`,
  });
  return edited;
}

/**
 * 三态处置。**确认时的版本重检走 `updateAbilityAsset` 的 `expectedVersion`**——
 * 重检与写入在同一把锁内完成，不存在"检查通过之后、写入之前被改掉"的窗口。
 * 版本不一致时 `updateAbilityAsset` 抛 `version conflict`，
 * 把提议置 superseded：baseline 不刷新，confirm 对这条
 * 提议永久不可达，留在 pending 只是死路；作废后 AI 可基于最新版本重提。
 *
 * 并发纪律：终态预检在锁外只做快速路径，真正的互斥由三道锁内
 * 复核保证——①写资产前的 CAS 复核（拦主窗口）、②patch 状态迁移的 CAS
 * （拦"资产已改、提议被并发处置"的交错）、③撞②时的补偿回滚（被拒绝的
 * 内容不留在资产上，回滚到提议前的值；版本号会再 bump，补偿≠抹掉历史）。
 *
 * 半提交对账：confirm 是"改资产 + 改提议"两段写，中途断在两段
 * 之间会让提议永远卡 pending、重试必撞版本冲突死循环——对账口径是资产
 * 版本流里带 `proposal=<id>` 标记的版本行，找到即说明已生效过，补状态即可。
 */
export async function decideAssetChangeProposal(
  userId: string,
  proposalId: string,
  decision: AssetApprovalDecision,
  options: { payload?: Record<string, unknown> } = {},
): Promise<AssetApprovalDecisionResult> {
  const proposal = await readAssetChangeProposal(userId, proposalId);
  if (!proposal) throw new Error('asset change proposal not found');
  if (proposal.contentPurgedAt) throw contentPurgedError();
  if (DECIDED_STATES.has(proposal.state)) {
    return alreadyDecided(proposal.state);
  }
  const decidedAt = new Date().toISOString();

  if (decision === 'defer') {
    try {
      const deferred = await patchProposalTransition(userId, proposalId, { state: 'deferred', decidedAt });
      await appendApprovalAudit(userId, proposal.assetId, 'approval_deferred', {
        actor: 'user',
        reason: '用户选择稍后处理',
        note: `proposal=${proposalId}`,
      });
      return { ok: true, state: deferred.state, message: '已放进待确认清单，不会丢。' };
    } catch (error) {
      if (error instanceof ProposalAlreadyDecidedError) return alreadyDecided(error.decidedState);
      throw error;
    }
  }
  if (decision === 'reject') {
    try {
      const rejected = await patchProposalTransition(userId, proposalId, { state: 'rejected', decidedAt });
      await appendApprovalAudit(userId, proposal.assetId, 'approval_rejected', {
        actor: 'user',
        reason: '用户拒绝了这次变更',
        note: `proposal=${proposalId}`,
      });
      return { ok: true, state: rejected.state, message: '已留档；同一变更不会再重复提交。' };
    } catch (error) {
      if (error instanceof ProposalAlreadyDecidedError) return alreadyDecided(error.decidedState);
      throw error;
    }
  }

  // confirm：可带编辑后的 payload（用户在卡片上改过的内容按改后生效）。
  const payload = options.payload && Object.keys(options.payload).length ? options.payload : proposal.payload;
  const edited = payload !== proposal.payload;

  // 键集过滤：payload 此前整对象直达资产更新（title/type/evidenceRefs
  // 等全部可写——治理键若混入还能覆盖 actor/reason/expectedVersion）。这里
  // 只放行内容字段；治理键（actor/reason/expectedVersion/review 系）由下方
  // update 显式设置，绝不允许 payload 染指。type 经白名单放行后仍有
  // updateAbilityAsset 的五枚举闸兜底。
  const APPROVAL_PAYLOAD_KEYS = new Set([
    'title', 'statement', 'value', 'scope', 'scopePolicy', 'type',
    'evidenceRefs', 'ontologyRefs', 'relations', 'derivedFrom',
    'applicableWhen', 'forbiddenWhen', 'tags',
  ]);
  const sanitizedPayload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (APPROVAL_PAYLOAD_KEYS.has(key)) sanitizedPayload[key] = value;
  }

  // 半提交对账：上次 confirm 若已把内容写进资产（版本流的 reason
  // 带 proposal 标记）但提议状态没落盘，重试会永远撞版本冲突——补 confirmed。
  // 只认**比 baseline 更新**的版本行：同变更重提会复用同一个提议 id，上一轮
  // 确认留下的旧行版本号 ≤ 本次 baseline，那不是本次的半提交残留。
  try {
    const versions = await listAbilityAssetVersions(userId, proposal.assetId);
    const appliedRecord = versions.find((row) => String(row.reason || '').includes(`proposal=${proposalId}`)
      && Number(row.version) > Number(proposal.baselineVersion));
    if (appliedRecord) {
      const confirmed = await patchProposalTransition(userId, proposalId, { state: 'confirmed', decidedAt, appliedVersion: appliedRecord.version });
      await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
        actor: 'user',
        reason: '对账补记：上一次确认已生效，但提议状态未落盘',
        note: `proposal=${proposalId} → v${appliedRecord.version}`,
      });
      return { ok: true, state: confirmed.state, appliedVersion: appliedRecord.version };
    }
  } catch (error) {
    if (error instanceof ProposalAlreadyDecidedError) return alreadyDecided(error.decidedState);
    // 对账读失败（资产流不可读等）不拦正常路径：正常 confirm 会撞到同样的错。
    log.warn('approval confirm reconciliation skipped', { proposalId, error: (error as Error).message });
  }

  // 写资产前的锁内 CAS 复核：拦住「confirm 排队期间 reject/作废已
  // 落盘」的主窗口——拦得住就不用走补偿回滚（补偿是兜底，不是主路径）。
  try {
    await updateRecallJsonRecord(userId, 'asset-approvals', proposalId, (raw) => {
      if (!raw) throw new Error('asset change proposal not found');
      const state = String(raw.state) as AssetApprovalState;
      if (DECIDED_STATES.has(state)) throw new ProposalAlreadyDecidedError(state);
      return raw; // 原样写回：只为在锁内确认仍可处置（同 updateAbilityAsset 幂等先例）。
    });
  } catch (error) {
    if (error instanceof ProposalAlreadyDecidedError) return alreadyDecided(error.decidedState);
    throw error;
  }

  // Queue on the asset file alone. Holding the cognition transition while
  // that file is busy blocks the rejection that should win this race.
  const assetPath = recallJsonRecordPath(userId, 'ability-assets', proposal.assetId);
  let preempted: AssetApprovalState | undefined;
  await fileEditLock(assetPath).runExclusive(async () => {
    const latest = await readAssetChangeProposal(userId, proposalId);
    if (latest && DECIDED_STATES.has(latest.state)) preempted = latest.state;
  });
  if (preempted) return alreadyDecided(preempted);

  // 标签是整组替换，但标签更新不 bump 内容版本：只靠 expectedVersion 时，
  // 提议后有人改了标签也发现不了。把提议时的标签作为写锁内的 CAS 基线；
  // 内容类提议没有 tags 字段，不传 expectedTags，避免被无关的标签编辑误伤。
  const expectedTags = Array.isArray(sanitizedPayload.tags)
    ? (Array.isArray(proposal.beforeValues?.tags)
      ? proposal.beforeValues.tags.filter((tag): tag is string => typeof tag === 'string')
      : [])
    : undefined;
  const update: UpdateAbilityAssetInput = {
    ...(sanitizedPayload as unknown as UpdateAbilityAssetInput),
    ...(expectedTags !== undefined ? { expectedTags } : {}),
    // 生效的 actor 是**用户**：AI 只是提议，是用户点了"确认更新"才落地的。
    // AI 的作者身份留在提议记录与 approval_proposed 台账行里，两件事都如实记。
    actor: 'user',
    reason: `用户确认了 AI 提议的变更（proposal=${proposalId}）：${proposal.reason}`,
    expectedVersion: proposal.baselineVersion,
    expectedActiveVersion: proposal.baselineActiveVersion || proposal.baselineVersion,
  };
  try {
    const applied = await updateAbilityAsset(userId, proposal.assetId, update);
    let confirmed: AssetChangeProposal;
    try {
      confirmed = await patchProposalTransition(userId, proposalId, {
        state: 'confirmed',
        decidedAt,
        appliedVersion: applied.version,
        payload,
        ...(edited ? { editedFrom: proposal.editedFrom || proposal.payload } : {}),
      });
    } catch (error) {
      if (!(error instanceof ProposalAlreadyDecidedError)) throw error;
      // 补偿回滚：并发处置（reject/superseded）赢在了「资产已改、
      // 提议状态未写」的窗口里——被拒绝的内容不能留在资产上，按提议前的值
      // 回滚（beforeValues 记着提出时这几个字段的当前值）。
      const rollback = await rollbackConfirmedApply(userId, proposal, sanitizedPayload, applied.version, error.decidedState);
      try {
        await updateRecallJsonRecord(userId, 'asset-approvals', proposalId, current => current ? {
          ...current,
          rollback: {
            status: rollback.status,
            failedFields: rollback.failedFields,
            appliedVersion: rollback.appliedVersion,
            at: new Date().toISOString(),
          },
        } : current);
      } catch (persistError) {
        log.warn('approval rollback recovery state could not be persisted', {
          userId, proposalId, status: rollback.status, error: (persistError as Error).message,
        });
      }
      const decidedLabel = error.decidedState === 'rejected' ? '拒绝' : '作废';
      return {
        ok: false,
        state: error.decidedState,
        rollback,
        message: rollback.status === 'full'
          ? `这条提议在你确认的同时已被${decidedLabel}，刚应用的内容已按提议前的值回滚。`
          : rollback.status === 'partial'
            ? `这条提议在你确认的同时已被${decidedLabel}，已回滚可恢复字段；${rollback.failedFields.join('、')} 缺少提议前取值，未能回滚，请核对这条资产的最新内容。`
            : `这条提议在你确认的同时已被${decidedLabel}，自动回滚失败，资产可能仍保留被拒绝的修改，请核对这条资产的最新内容。`,
      };
    }
    await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
      actor: 'user',
      reason: `用户确认更新${edited ? '（按编辑后的内容生效）' : ''}`,
      note: `proposal=${proposalId} → v${applied.version}`,
    });
    return { ok: true, state: confirmed.state, appliedVersion: applied.version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('version conflict')) {
      // 资产记录才是版本号的权威：不把 updateAbilityAsset 的英文错误措辞
      // 当作契约（措辞漂移会让渲染层拿到「v3 → v」的残缺提示）。读不到记录
      // （已撤回/清除）时才退回错误文案里的数字，最后才是空串。
      let current = '';
      try {
        current = (await readAbilityAsset(userId, proposal.assetId)).version;
      } catch (readError) {
        current = message.match(/current v(\d+)/)?.[1] || '';
        log.warn('version conflict current version reread failed', {
          proposalId, assetId: proposal.assetId, error: (readError as Error).message,
        });
      }
      // 冲突即作废：baseline 版本永不刷新，让用户「重新看一眼再
      // 决定」是永远再冲突的死路。作废关闭这条提议；作废态不进去重拦截，
      // AI 会基于最新版本重新提议。
      try {
        await patchProposalTransition(userId, proposalId, { state: 'superseded', decidedAt });
      } catch (decidedError) {
        if (decidedError instanceof ProposalAlreadyDecidedError) return alreadyDecided(decidedError.decidedState);
        throw decidedError;
      }
      await appendApprovalAudit(userId, proposal.assetId, 'approval_superseded', {
        actor: 'user',
        reason: '用户点了确认更新，但资产已被改动，提议作废（AI 将基于最新版本重新提议）',
        note: `proposal=${proposalId} baseline=v${proposal.baselineVersion} current=v${current}`,
      });
      return {
        ok: false,
        state: 'superseded',
        versionConflict: { baselineVersion: proposal.baselineVersion, currentVersion: current },
        message: `这条资产在你看卡片之后被改过（v${proposal.baselineVersion} → v${current}），这条提议已作废；AI 会基于最新内容重新提议。`,
      };
    }
    // 标签基线冲突：标签不 bump 版本，expectedVersion 拦不住期间的手动打标；
    // 写入在 CAS 处已失败，不需要补偿回滚。与版本冲突同口径作废重提。
    if (message.includes('ability asset tags conflict')) {
      const baselineTags = Array.isArray(proposal.beforeValues?.tags)
        ? proposal.beforeValues.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
      let currentTags: string[] = [];
      try {
        const latest = await readAbilityAsset(userId, proposal.assetId);
        currentTags = Array.isArray(latest?.tags) ? latest.tags : [];
      } catch (readError) {
        log.warn('tag conflict current tags reread failed', {
          proposalId, assetId: proposal.assetId, error: (readError as Error).message,
        });
      }
      try {
        await patchProposalTransition(userId, proposalId, { state: 'superseded', decidedAt });
      } catch (decidedError) {
        if (decidedError instanceof ProposalAlreadyDecidedError) return alreadyDecided(decidedError.decidedState);
        throw decidedError;
      }
      await appendApprovalAudit(userId, proposal.assetId, 'approval_superseded', {
        actor: 'user',
        reason: '用户点了确认更新，但资产标签已被改动，提议作废（AI 将基于最新标签重新提议）',
        note: `proposal=${proposalId} tags=${baselineTags.join('、') || '（无）'} → ${currentTags.join('、') || '（无）'}`,
      });
      return {
        ok: false,
        state: 'superseded',
        tagConflict: { baselineTags, currentTags },
        message: '这条资产的标签在你看卡片之后被改过，这条提议已作废；AI 会基于最新内容重新提议。',
      };
    }
    // 生效对象已不可达（资产被撤回/软删除/物理清除）：
    // confirm 永远无法达成，pending 只会误导；作废收口（AI 也不会再对不存在的
    // 资产重提）。严格相等匹配这四个文案，防误伤其他同缀错误。
    if (
      message === 'recall ability asset not found'
      || message === 'revoked ability asset cannot be changed'
      || message === 'deleted ability asset cannot be changed'
      || message === 'ability asset has been purged'
    ) {
      try {
        await patchProposalTransition(userId, proposalId, { state: 'superseded', decidedAt });
      } catch (decidedError) {
        if (decidedError instanceof ProposalAlreadyDecidedError) return alreadyDecided(decidedError.decidedState);
        throw decidedError;
      }
      await appendApprovalAudit(userId, proposal.assetId, 'approval_superseded', {
        actor: 'user',
        reason: `确认时发现资产已不可用（${message}），提议作废`,
        note: `proposal=${proposalId}`,
      });
      return { ok: false, state: 'superseded', message: '这条资产已被撤回或删除，提议已作废。' };
    }
    throw error;
  }
}

/** 补偿回滚：confirm 的资产写入已生效、但提议被并发处置抢先落了
 *  终态——把刚应用的字段按「提议前的值」写回去。取值优先级：①版本流里
 *  baseline 版本的完整快照（生效时刻冻结的，最可靠）；②提议的 beforeValues
 *  （提出时记录的当前值，老提议可能缺失）。
 *  版本号会再 bump 一次，这是补偿的常态（补偿≠抹掉版本历史）；回滚本身失败
 *  或两处取值都拿不到时不吞，记审计如实说明，让账上看得见。 */
async function rollbackConfirmedApply(
  userId: string,
  proposal: AssetChangeProposal,
  payload: Record<string, unknown>,
  appliedVersion: string,
  decidedState: AssetApprovalState,
): Promise<{
  status: 'full' | 'partial' | 'failed';
  failedFields: string[];
  appliedFields: string[];
  appliedVersion: string;
  rolledBackVersion?: string;
}> {
  const fieldKeys = Object.keys(payload);
  const rollbackPayload: Record<string, unknown> = {};
  const missingFields: string[] = [];
  let baselineSnapshot: Record<string, unknown> | null = null;
  try {
    baselineSnapshot = await readAbilityAssetVersionSnapshot(userId, proposal.assetId, proposal.baselineActiveVersion || proposal.baselineVersion) as Record<string, unknown> | null;
  } catch {
    // 版本流不可读（资产已物理清除等）——落到 beforeValues。
  }
  for (const key of fieldKeys) {
    // 逐键取值：快照缺的键（如 tags——版本快照有意不含标签元数据）从
    // beforeValues 补，两处都没有的键只能留着不回滚（审计里如实说明）。
    if (baselineSnapshot && key in baselineSnapshot) rollbackPayload[key] = baselineSnapshot[key];
    else if (baselineSnapshot && key === 'value') rollbackPayload[key] = '';
    else if (proposal.beforeValues && key in proposal.beforeValues) rollbackPayload[key] = proposal.beforeValues[key];
    else missingFields.push(key);
  }
  const conflictNote = `proposal=${proposal.id} 与并发的${decidedState === 'rejected' ? '拒绝' : '作废'}冲突（已应用到 v${appliedVersion}）`;
  const appliedFields = fieldKeys.filter(key => key in rollbackPayload);
  if (!appliedFields.length) {
    await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
      actor: 'user',
      reason: '确认与并发处置冲突，但提议前取值不可得（版本流与 beforeValues 均缺），无法自动回滚，请人工核对这条资产的最新内容',
      note: conflictNote,
    });
    return { status: 'failed', failedFields: fieldKeys, appliedFields: [], appliedVersion };
  }
  try {
    const rolledBack = await updateAbilityAsset(userId, proposal.assetId, {
      ...(rollbackPayload as unknown as UpdateAbilityAssetInput),
      actor: 'user',
      reason: `审批确认与并发处置冲突，回滚刚应用的内容（proposal=${proposal.id}）`,
      expectedVersion: appliedVersion,
    });
    const status = missingFields.length ? 'partial' : 'full';
    await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
      actor: 'user',
      reason: status === 'full'
        ? `确认与并发处置冲突，刚应用的内容已按提议前的值回滚（v${appliedVersion} → v${rolledBack.version}）`
        : `确认与并发处置冲突，已回滚可恢复字段；以下字段缺少提议前取值，未能回滚：${missingFields.join('、')}（v${appliedVersion} → v${rolledBack.version}）`,
      note: conflictNote,
    });
    return { status, failedFields: missingFields, appliedFields, appliedVersion, rolledBackVersion: rolledBack.version };
  } catch (error) {
    await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
      actor: 'user',
      reason: '确认与并发处置冲突，且回滚失败，请人工核对这条资产的最新内容',
      note: `${conflictNote}；rollback error=${(error as Error).message}`,
    });
    return { status: 'failed', failedFields: fieldKeys, appliedFields: [], appliedVersion };
  }
}

/** 把待处理的提议挂到卡片消息 id 上（下发成功后回填，回执定位用）。 */
export async function attachAssetChangeProposalCard(
  userId: string,
  proposalId: string,
  cardMessageId: string,
): Promise<void> {
  await patchProposal(userId, proposalId, { cardMessageId });
}
