/**
 * experience-reference.ts — 经验集引用（specs/016 T026 / 契约 E9~E10 / data-model §6）。
 *
 * 「@ 历史任务」把该任务沉淀的经验集带进新任务：
 *   - sourceTasks：只列**有经验**的来源任务（episode 维度聚合自经验目录——
 *     不是全部会话，会话列表与「有没有可带的经验」是两件事）；
 *   - attachToTask：**准入在主进程跑**（同一个 evaluateExperienceRuntimeEligibility，
 *     用户主动选择路径——非静默注入），通过者写进 conversation.task_references
 *     （kind:'experience_set'，含冻结快照），被拦者不写入但逐条回报规则名；
 *   - 挂载集读取（listExperienceSetReferences）：经验清单构建的 mounted 数据源
 *     与 E10 omissions 的查询基础——撤销（既有 taskRefs.remove）后自然为空，
 *     「下一轮不再带入」不需要任何新状态。
 *
 * 与 data-model §6 的两条硬边界：
 *   1. 快照冻结：引用生效后即使条目被改/被暂停/被归档，带入的仍是写入时点的
 *      version/title/body/类型（正文按单条上限截断，与 read_task_experience 的
 *      ≤2000 字分批同口径）；
 *   2. 防双注入：该 kind **不进** _mergeTaskReferences 的 modelText 合并（那里
 *      只认 artifact/asset）——经验内容只由经验清单构建器带入，引用里再合一遍
 *      同一批内容就是双注入。本文件到头都不 import group_chat。
 *
 * 撤销不新增通道：复用既有 conversations.taskRefs.remove（按 index 删）。
 */

import { safeId } from '../../storage';
import { catalogTruncate } from './asset-catalog';
import {
  evaluateExperienceRuntimeEligibility,
  listExperiences,
  readExperience,
  type ExperienceRecord,
} from './experience-service';
import {
  assetRuntimeBlockRule,
  type AssetRuntimeBlockReason,
  type AssetRuntimeContext,
} from './formal-assets/runtime';
import { listInjectionReceipts } from './injection-receipt';
import type { TaskReference } from '../chats';

/** task_references 里的经验集引用 kind（data-model §6）。 */
export const EXPERIENCE_SET_KIND = 'experience_set';
/** 快照正文单条上限：与模型工具 read_task_experience 的分批口径同值。 */
export const EXPERIENCE_SET_SNAPSHOT_BODY_MAX = 2_000;
/** 来源任务 goal 的展示截断（E9：既有 IPC 的 200 字先例同量级）。 */
const SOURCE_TASK_GOAL_MAX = 200;
/** 引用名上限（chats 的 task_reference.name 同为 200）。 */
const REFERENCE_NAME_MAX = 200;
/** sourceTasks 上限（E9 契约：limit ≤100、缺省 50）。 */
export const EXPERIENCE_SOURCE_TASKS_LIMIT_MAX = 100;
export const EXPERIENCE_SOURCE_TASKS_LIMIT_DEFAULT = 50;
/** omissions 上限（E10 契约：limit ≤100、缺省 20）。 */
export const EXPERIENCE_OMISSIONS_LIMIT_MAX = 100;
export const EXPERIENCE_OMISSIONS_LIMIT_DEFAULT = 20;
/** 单会话引用上限（与 conversations.taskRefs.add 的 20 条同口径）。 */
const TASK_REFERENCES_MAX = 20;

/** E9 sourceTasks 的行（episode 维度聚合；不含正文）。 */
export interface ExperienceSourceTaskRow {
  episodeId: string;
  goal: string;
  taskType: ExperienceRecord['source']['taskType'];
  taskStatus: string;
  experienceCount: number;
  activeCount: number;
  updatedAt: string;
}

/** 被拦条目的逐条回报：code=理由码（AssetRuntimeBlockReason）、rule=稳定规则标识
 *  （AssetRuntimeBlockRule）——界面按 rule 翻四语规则名，不上屏 code 原文。 */
export interface ExperienceAttachBlocked {
  experienceId: string;
  title: string;
  code: string;
  rule: string;
}

/** 快照单条（AC2 冻结口径：version=updatedAt 派生，同清单条目的 version 字段）。 */
export interface ExperienceSetSnapshotEntry {
  version: string;
  title: string;
  body: string;
  experienceType: string;
  taskType: string;
}

/** task_references 里的经验集引用形态（data-model §6 字段表）。 */
export interface ExperienceSetReference extends TaskReference {
  kind: 'experience_set';
  name: string;
  episode_id: string;
  requirement_id?: string;
  experienceIds: string[];
  snapshots: Record<string, ExperienceSetSnapshotEntry>;
  addedAt: string;
}

/** E10 omissions 的行：只回标题与规则码（无正文）。 */
export interface ExperienceOmissionRow {
  experienceId: string;
  title: string;
  reason: string;
  stage: 'experience_hint';
  createdAt: string;
}

function isExperienceSetReference(value: unknown): value is ExperienceSetReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as { kind?: unknown; episode_id?: unknown };
  return ref.kind === EXPERIENCE_SET_KIND && typeof ref.episode_id === 'string' && ref.episode_id !== '';
}

/** 闸门状态映射：merged 是经验特有终态，映射到同为终态的 archived（与
 *  experienceRuntimeCandidate 同一映射，rule 计算保持同源）。 */
function gateStatusOf(exp: ExperienceRecord): string {
  return exp.status === 'merged' ? 'archived' : exp.status;
}

/**
 * E9 · sourceTasks：episode 维度聚合经验目录。
 *
 * 排序 updatedAt 降序（listExperiences 已降序，按插入序聚合天然保持）；不按
 * active 过滤——全暂停的任务照样列出（activeCount=0），选中时才被拦并说明，
 * 与 @ 资产页签「藏起来等于原因不可见」同一 UX 哲学。
 */
export async function listExperienceSourceTasks(
  userId: string,
  options: { query?: string; limit?: number } = {},
): Promise<{ tasks: ExperienceSourceTaskRow[] }> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  const all = await listExperiences(userId);
  const byEpisode = new Map<string, ExperienceRecord[]>();
  for (const exp of all) {
    const key = exp.source.episodeId;
    const bucket = byEpisode.get(key);
    if (bucket) bucket.push(exp);
    else byEpisode.set(key, [exp]);
  }
  const query = String(options.query || '').trim().toLowerCase();
  const rows: ExperienceSourceTaskRow[] = [];
  for (const [episodeId, exps] of byEpisode) {
    const row: ExperienceSourceTaskRow = {
      episodeId,
      goal: catalogTruncate(String(exps[0].source.taskGoal || ''), SOURCE_TASK_GOAL_MAX),
      taskType: exps[0].source.taskType,
      taskStatus: String(exps[0].source.taskStatus || ''),
      experienceCount: exps.length,
      activeCount: exps.filter((exp) => exp.status === 'active').length,
      // 组内第一条是最新（listExperiences 降序）。
      updatedAt: exps[0].updatedAt,
    };
    if (query && !`${row.goal}\n${row.taskType}\n${row.episodeId}`.toLowerCase().includes(query)) continue;
    rows.push(row);
  }
  const limit = options.limit ?? EXPERIENCE_SOURCE_TASKS_LIMIT_DEFAULT;
  return { tasks: rows.slice(0, limit) };
}

export type AttachExperienceSetResult =
  | {
      ok: true;
      attached: {
        referenceKey: string;
        experienceIds: string[];
        available: string[];
        blocked: ExperienceAttachBlocked[];
      };
    }
  | {
      ok: false;
      code: 'experience_attach_blocked' | 'episode_has_no_experiences';
      blocked: ExperienceAttachBlocked[];
    };

/**
 * E9 · attachToTask：主进程跑准入 → 通过者写 task_references（含快照）。
 *
 * 全被拦 → ok:false 且**一条引用都不写**（不写半截）；部分被拦 → 通过者写入、
 * 被拦者逐条回报（标题 + code + rule，正文不出现在响应里）。同 episode 重复
 * 挂载 = 整体替换该条引用（幂等刷新快照，不产生重复 chip）。
 */
export async function attachExperienceSetToTask(
  userId: string,
  conversationId: string,
  episodeId: string,
  options: { agentId?: string } = {},
): Promise<AttachExperienceSetResult> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  if (!safeId(conversationId)) throw new Error('invalid cid');
  if (typeof episodeId !== 'string' || !safeId(episodeId) || !episodeId.startsWith('kse-')) {
    throw new Error('invalid experience episode');
  }
  if (options.agentId !== undefined && (typeof options.agentId !== 'string' || !safeId(options.agentId))) {
    throw new Error('invalid experience attach agent');
  }

  const { getConversation, updateConversation } = await import('../chats');
  const conv = await getConversation(userId, conversationId);
  if (!conv) throw new Error('conversation not found');

  const all = await listExperiences(userId);
  const exps = all.filter((exp) => exp.source.episodeId === episodeId);
  if (!exps.length) {
    // 没有经验的 episode 不可挂载（sourceTasks 本来也不会列出）——稳定码，界面翻人话。
    return { ok: false, code: 'episode_has_no_experiences', blocked: [] };
  }

  // 准入：用户主动选择路径（非静默）——applicableWhen 声明不拦人工挑选，
  // 与 @ 资产挂载（attachToConversation）同一语义。agentId 已知就一并判，
  // 目标 Agent 白名单当场生效；会话空间也用于限制仅空间可见的经验。
  const context: AssetRuntimeContext = {
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(conv.space_id ? { workspaceId: conv.space_id } : {}),
  };
  const available: ExperienceRecord[] = [];
  const blocked: ExperienceAttachBlocked[] = [];
  for (const exp of exps) {
    const eligibility = evaluateExperienceRuntimeEligibility(userId, exp, context);
    if (eligibility.eligible) {
      available.push(exp);
      continue;
    }
    blocked.push({
      experienceId: exp.id,
      title: String(exp.title || ''),
      code: eligibility.reasons[0] || 'status_not_active',
      rule: assetRuntimeBlockRule(gateStatusOf(exp), eligibility.reasons as AssetRuntimeBlockReason[]),
    });
  }
  if (!available.length) {
    return { ok: false, code: 'experience_attach_blocked', blocked };
  }

  // 快照冻结（AC2）：通过者的 version/title/body（单条截断）/类型全量进引用。
  const snapshots: Record<string, ExperienceSetSnapshotEntry> = {};
  for (const exp of available) {
    snapshots[exp.id] = {
      version: String(exp.updatedAt || ''),
      title: String(exp.title || ''),
      body: String(exp.body || '').slice(0, EXPERIENCE_SET_SNAPSHOT_BODY_MAX),
      experienceType: exp.experienceType,
      taskType: exp.source.taskType,
    };
  }
  const item: ExperienceSetReference = {
    kind: EXPERIENCE_SET_KIND,
    name: catalogTruncate(String(exps[0].source.taskGoal || episodeId), REFERENCE_NAME_MAX),
    episode_id: episodeId,
    ...(exps[0].source.requirementId ? { requirement_id: exps[0].source.requirementId } : {}),
    experienceIds: available.map((exp) => exp.id),
    snapshots,
    addedAt: new Date().toISOString(),
  };

  // 同 episode 整体替换（幂等）；上限沿用 taskRefs 的 20 条。
  const refs = (conv.task_references || []).filter(
    (ref) => !(isExperienceSetReference(ref) && ref.episode_id === episodeId),
  );
  if (refs.length >= TASK_REFERENCES_MAX) throw new Error('too many references');
  await updateConversation(userId, conversationId, { task_references: [...refs, item] });

  return {
    ok: true,
    attached: {
      referenceKey: `${EXPERIENCE_SET_KIND}:${episodeId}`,
      experienceIds: item.experienceIds,
      available: item.experienceIds,
      blocked,
    },
  };
}

/** 会话上的经验集引用（挂载集的唯一事实来源；撤销后自然为空）。 */
export async function listExperienceSetReferences(
  userId: string,
  cid: string,
): Promise<ExperienceSetReference[]> {
  if (!safeId(userId) || !safeId(cid)) throw new Error('invalid cid');
  const { getConversation } = await import('../chats');
  const conv = await getConversation(userId, cid);
  return (conv?.task_references || []).filter(isExperienceSetReference);
}

/**
 * E10 · omissions：已在会话里挂过、但最近一轮被准入拦下的经验。
 *
 * 数据源是清单构建写的 omitted 回执（channel='experience'）∩ 当前挂载集——
 * 撤销（taskRefs.remove）后挂载集为空，即使盘上有旧回执也不再回报（「下一轮
 * 不再带入」的读取面）。同一条目多轮回执只回最新一条；条目已删除时标题留空
 * （渲染层显示「来源记录不可用」，不编造）。**只回标题与规则码，无正文。**
 */
export async function listExperienceOmissions(
  userId: string,
  cid: string,
  limit: number = EXPERIENCE_OMISSIONS_LIMIT_DEFAULT,
): Promise<ExperienceOmissionRow[]> {
  if (!safeId(userId)) throw new Error('invalid experience user');
  if (!safeId(cid)) throw new Error('invalid cid');
  const mounted = await listExperienceSetReferences(userId, cid);
  const mountedIds = new Set(mounted.flatMap((ref) => ref.experienceIds || []));
  if (!mountedIds.size) return [];

  const receipts = (await listInjectionReceipts(userId))
    .filter((receipt) => receipt.channel === 'experience' && receipt.status === 'omitted' && mountedIds.has(receipt.assetId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const rows: ExperienceOmissionRow[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (seen.has(receipt.assetId)) continue;
    seen.add(receipt.assetId);
    const exp = await readExperience(userId, receipt.assetId);
    rows.push({
      experienceId: receipt.assetId,
      title: exp ? String(exp.title || '') : '',
      reason: String(receipt.reason || 'unknown'),
      stage: 'experience_hint',
      createdAt: receipt.createdAt,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}
