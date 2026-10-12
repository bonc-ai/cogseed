/**
 * AI 自主实质变化的审批提议（specs/008 US-406）。
 *
 * 分级②的落地件：AI 自主提出的方法正文 / 事实判断 / 适用范围实质变化**不直接生效**，
 * 而是落成一条提议 + 对话内审批卡片，由用户三态处置：
 *   - 确认更新 → 当场生效（**重检版本**，不一致则保持待处理、不静默覆盖）
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
import { recallJsonRecordPath } from './paths';
import { appendRecallJsonlRecord, listRecallJsonlRecords, readRecallJsonRecord, updateRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';
import { updateAbilityAsset, type UpdateAbilityAssetInput } from './asset-service';

const log = createLogger('recall.asset-approval');

export type AssetApprovalState = 'pending' | 'confirmed' | 'rejected' | 'deferred';

export interface AssetChangeProposal extends RecallJsonRecord {
  id: string;
  assetId: string;
  /** 提出时的资产版本：确认时拿它做重检（不一致 → 不静默覆盖）。 */
  baselineVersion: string;
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
  dedupeKey: string;
  createdAt: string;
  decidedAt?: string;
  /** 用户编辑过卡片内容时记下编辑前的 payload（编辑本身也要进台账）。 */
  editedFrom?: Record<string, unknown>;
  /** 卡片消息 id：回执与定位用。 */
  cardMessageId?: string;
}

export interface CreateAssetChangeProposalInput {
  assetId: string;
  baselineVersion: string;
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
  /** 生效后的资产版本（确认成功时）。 */
  appliedVersion?: string;
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
    || typeof value.dedupeKey !== 'string' || !value.dedupeKey
    || typeof value.reason !== 'string'
    || !['pending', 'confirmed', 'rejected', 'deferred'].includes(String(value.state))
    || !Array.isArray(value.fields)
    || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)
  ) throw new Error('malformed asset change proposal');
  return value as AssetChangeProposal;
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
      const proposal = asProposal(raw);
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
  return raw ? asProposal(raw) : undefined;
}

/** 同一次变更是否已经提过（待处理/稍后/已拒绝都算"已经提过"）。
 *
 *  已确认的不算：那次已经生效，资产随后可能被改回，同一变更再提一次是合理的
 *  新提议（去重键相同但 baselineVersion 不同，是另一件事）。 */
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

/** 提议自己的台账行（挂在目标资产上，与写操作的台账同一处可查）。 */
async function appendApprovalAudit(
  userId: string,
  assetId: string,
  action: 'approval_proposed' | 'approval_confirmed' | 'approval_rejected' | 'approval_deferred' | 'approval_edited',
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
    actions: ['confirm', 'defer', 'reject'],
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
  if (current.state !== 'pending') throw new Error('asset change proposal is not pending');
  const edited = await patchProposal(userId, proposalId, {
    payload,
    editedFrom: current.editedFrom || current.payload,
  });
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
 * 版本不一致时 `updateAbilityAsset` 抛 `version conflict`，这里把它翻译成
 * "保持待处理 + 如实回执"，**绝不静默覆盖**。
 */
export async function decideAssetChangeProposal(
  userId: string,
  proposalId: string,
  decision: AssetApprovalDecision,
  options: { payload?: Record<string, unknown> } = {},
): Promise<AssetApprovalDecisionResult> {
  const proposal = await readAssetChangeProposal(userId, proposalId);
  if (!proposal) throw new Error('asset change proposal not found');
  if (proposal.state === 'confirmed' || proposal.state === 'rejected') {
    return { ok: false, state: proposal.state, message: '这条提议已经处置过了。' };
  }
  const decidedAt = new Date().toISOString();

  if (decision === 'defer') {
    const deferred = await patchProposal(userId, proposalId, { state: 'deferred', decidedAt });
    await appendApprovalAudit(userId, proposal.assetId, 'approval_deferred', {
      actor: 'user',
      reason: '用户选择稍后处理',
      note: `proposal=${proposalId}`,
    });
    return { ok: true, state: deferred.state, message: '已放进待确认清单，不会丢。' };
  }
  if (decision === 'reject') {
    const rejected = await patchProposal(userId, proposalId, { state: 'rejected', decidedAt });
    await appendApprovalAudit(userId, proposal.assetId, 'approval_rejected', {
      actor: 'user',
      reason: '用户拒绝了这次变更',
      note: `proposal=${proposalId}`,
    });
    return { ok: true, state: rejected.state, message: '已留档；同一变更不会再重复提交。' };
  }

  // confirm：可带编辑后的 payload（用户在卡片上改过的内容按改后生效）。
  const payload = options.payload && Object.keys(options.payload).length ? options.payload : proposal.payload;
  const edited = payload !== proposal.payload;
  const update: UpdateAbilityAssetInput = {
    ...(payload as unknown as UpdateAbilityAssetInput),
    // 生效的 actor 是**用户**：AI 只是提议，是用户点了"确认更新"才落地的。
    // AI 的作者身份留在提议记录与 approval_proposed 台账行里，两件事都如实记。
    actor: 'user',
    reason: `用户确认了 AI 提议的变更（proposal=${proposalId}）：${proposal.reason}`,
    expectedVersion: proposal.baselineVersion,
  };
  try {
    const applied = await updateAbilityAsset(userId, proposal.assetId, update);
    const confirmed = await patchProposal(userId, proposalId, {
      state: 'confirmed',
      decidedAt,
      payload,
      ...(edited ? { editedFrom: proposal.editedFrom || proposal.payload } : {}),
    });
    await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
      actor: 'user',
      reason: `用户确认更新${edited ? '（按编辑后的内容生效）' : ''}`,
      note: `proposal=${proposalId} → v${applied.version}`,
    });
    return { ok: true, state: confirmed.state, appliedVersion: applied.version };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('version conflict')) {
      const current = message.match(/current v(\d+)/)?.[1] || '';
      // 卡片**保持待处理**：用户没做错什么，只是资产在他看卡片的时候被改过。
      await appendApprovalAudit(userId, proposal.assetId, 'approval_confirmed', {
        actor: 'user',
        reason: '用户点了确认更新，但资产已被改动，未生效',
        note: `proposal=${proposalId} baseline=v${proposal.baselineVersion} current=v${current}`,
      });
      return {
        ok: false,
        state: 'pending',
        versionConflict: { baselineVersion: proposal.baselineVersion, currentVersion: current },
        message: `这条资产在你看卡片之后被改过（v${proposal.baselineVersion} → v${current}），所以这次没有生效。请重新看一眼内容再决定。`,
      };
    }
    throw error;
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
