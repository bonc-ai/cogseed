import { createHash } from 'node:crypto';

import { appendRecallJsonlRecord, listRecallJsonlRecords } from './store';
import type { RecallJsonRecord } from './types';
import { safeId } from '../../storage';

export interface InjectionReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  projectionId?: string;
  assetId: string;
  assetVersion: string;
  boundary: 'real' | 'degraded' | 'test-double';
  status: 'injected' | 'dispatched' | 'omitted' | 'failed';
  /** 注入通道（2026-09-13 通道显式化）：projection=投影授权的正式资产；
   *  profile_memory=USER.md/MEMORY.md 派生的背景记忆（无投影授权）；
   *  agent_read=模型通过 search_ability_assets 目录/正文模式自己取用的资产
   *  catalog_hint=目录标了★提示相关但本回合未被使用（漏取审计，2026-09-19）
   *  （2026-09-18：模型主动读进上下文也算一次真实带入，否则自选资产
   *  永远进不了使用统计与升档链）。
   *  experience=经验目录（specs/016，2026-09-25）：经验清单构建时对「已挂载
   *  但本轮被准入拦下」的经验记 omitted 留痕（与资产隔离，只借回执载体：
   *  assetId 字段存 exp-… 条目 id，reason 存准入理由码）。
   *  缺省视为 projection（存量收据与新正式资产收据一致）。 */
  channel?: 'projection' | 'profile_memory' | 'agent_read' | 'catalog_hint' | 'experience';
  messageId?: string;
  /** 被拦原因（2026-09-25 验收修复 US-604 AC4/AC7）：status='omitted' 时带上
   *  `formal-assets/runtime.ts::assetRuntimeBlockRule` 的稳定规则标识，界面据此
   *  说明"本轮未带入 + 哪条规则"。只存标识——不存原因码原文、不存资产正文。
   *  旧回执没有该字段，读取侧按「原因未知」呈现，不编造。 */
  reason?: string;
  /** 「为什么排前」因子拆解（specs/012 T019，contracts/ipc.md §3.3）：
   *  只存因子名 + 数值 + 总分与权重来源，**不含**资产正文/任务文本/路径。
   *  幂等键不变（不进 recordInjectionReceipt 的 key）；旧回执没有该字段 →
   *  读取侧（IPC `recall.catalog.ranking`）回 explainable:false，如实说
   *  「没有记录」，不编造。 */
  ranking?: {
    score: number;
    factors: Array<{ name: 'relevance' | 'adoption' | 'scene' | 'maturity'; raw: number; weight: number; contribution: number }>;
    excluded: Array<'relevance' | 'adoption' | 'scene' | 'maturity'>;
    /** 场景缺席原因的无标识类别；不记录项目/空间 id。 */
    sceneExcludedReason?: 'no_scene_context' | 'no_matching_association';
    weightsSource?: 'configured' | 'default' | 'invalid-fallback';
  };
  createdAt: string;
}

const INJECTION_BOUNDARIES = new Set<InjectionReceipt['boundary']>(['real', 'degraded', 'test-double']);
const INJECTION_STATUSES = new Set<InjectionReceipt['status']>(['injected', 'dispatched', 'omitted', 'failed']);
const INJECTION_CHANNELS = new Set<InjectionReceipt['channel']>(['projection', 'profile_memory', 'agent_read', 'catalog_hint', 'experience']);
const RANKING_FACTORS: ReadonlySet<NonNullable<InjectionReceipt['ranking']>['factors'][number]['name']>
  = new Set(['relevance', 'adoption', 'scene', 'maturity']);
const RANKING_WEIGHTS_SOURCES = new Set<NonNullable<InjectionReceipt['ranking']>['weightsSource']>(['configured', 'default', 'invalid-fallback']);

/** ranking 拆解的形状校验（只认因子名闭集与有限数；**不存任何正文**）。 */
function isValidRanking(value: unknown): value is NonNullable<InjectionReceipt['ranking']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ranking = value as NonNullable<InjectionReceipt['ranking']>;
  if (typeof ranking.score !== 'number' || !Number.isFinite(ranking.score)) return false;
  if (!Array.isArray(ranking.factors) || !ranking.factors.every((factor) => (
    factor && typeof factor === 'object'
    && RANKING_FACTORS.has(factor.name)
    && typeof factor.raw === 'number' && Number.isFinite(factor.raw)
    && typeof factor.weight === 'number' && Number.isFinite(factor.weight)
    && typeof factor.contribution === 'number' && Number.isFinite(factor.contribution)
  ))) return false;
  if (!Array.isArray(ranking.excluded) || !ranking.excluded.every((name) => RANKING_FACTORS.has(name))) return false;
  if (ranking.sceneExcludedReason !== undefined && (
    !['no_scene_context', 'no_matching_association'].includes(ranking.sceneExcludedReason)
    || !ranking.excluded.includes('scene')
  )) return false;
  if (ranking.weightsSource !== undefined && !RANKING_WEIGHTS_SOURCES.has(ranking.weightsSource)) return false;
  return true;
}

function asInjectionReceipt(userId: string, value: RecallJsonRecord): InjectionReceipt {
  if (
    value.schemaVersion !== 1
    || value.ownerId !== userId
    || !safeId(value.id)
    || !safeId(value.taskRunId)
    || (value.projectionId !== undefined && !safeId(value.projectionId))
    || !safeId(value.assetId)
    || typeof value.assetVersion !== 'string'
    || !value.assetVersion.trim()
    || !INJECTION_BOUNDARIES.has(value.boundary as InjectionReceipt['boundary'])
    || !INJECTION_STATUSES.has(value.status as InjectionReceipt['status'])
    || (value.channel !== undefined && !INJECTION_CHANNELS.has(value.channel as InjectionReceipt['channel']))
    || (value.messageId !== undefined && !safeId(value.messageId))
    || (value.reason !== undefined && typeof value.reason !== 'string')
    || (value.ranking !== undefined && !isValidRanking(value.ranking))
    || typeof value.createdAt !== 'string'
  ) throw new Error('malformed injection receipt');
  return value as InjectionReceipt;
}

export async function recordInjectionReceipt(
  userId: string,
  input: {
    taskRunId: string; projectionId?: string; assetId: string; assetVersion: string;
    boundary: InjectionReceipt['boundary']; status: InjectionReceipt['status']; messageId?: string;
    channel?: InjectionReceipt['channel'];
    /** 被拦原因标识（status='omitted' 时用）：规则标识，不是原因码原文。 */
    reason?: string;
    /** 「为什么排前」拆解（specs/012 T019）：因子名 + 数值；不进幂等键。 */
    ranking?: InjectionReceipt['ranking'];
  },
): Promise<InjectionReceipt> {
  if (
    !safeId(userId)
    || !safeId(input.taskRunId)
    || (input.projectionId !== undefined && !safeId(input.projectionId))
    || !safeId(input.assetId)
    || typeof input.assetVersion !== 'string'
    || !input.assetVersion.trim()
    || !INJECTION_BOUNDARIES.has(input.boundary)
    || !INJECTION_STATUSES.has(input.status)
    || (input.channel !== undefined && !INJECTION_CHANNELS.has(input.channel))
    || (input.messageId !== undefined && !safeId(input.messageId))
    || (input.reason !== undefined && typeof input.reason !== 'string')
    || (input.ranking !== undefined && !isValidRanking(input.ranking))
  ) throw new Error('invalid injection receipt reference');
  // reason / ranking 刻意不进幂等键：同一轮同一资产被拦多次仍是同一条留痕，
  // 排序拆解也只随首条落形（重写不产生第二条回执）。
  const key = `${input.taskRunId}:${input.assetId}:${input.assetVersion}:${input.status}:${input.messageId || ''}`;
  const record: InjectionReceipt = {
    schemaVersion: 1, ownerId: userId,
    id: `inj-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
    taskRunId: input.taskRunId, ...(input.projectionId ? { projectionId: input.projectionId } : {}),
    assetId: input.assetId, assetVersion: input.assetVersion, boundary: input.boundary,
    status: input.status,
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.ranking ? { ranking: input.ranking } : {}),
    createdAt: new Date().toISOString(),
  };
  const existing = (await listInjectionReceipts(userId))
    .find((item) => item.id === record.id);
  if (existing) return existing;
  await appendRecallJsonlRecord(userId, 'injection-receipts', 'events', record);
  return record;
}

export async function listInjectionReceipts(userId: string, taskRunId?: string): Promise<InjectionReceipt[]> {
  if (!safeId(userId) || (taskRunId !== undefined && !safeId(taskRunId))) {
    throw new Error('invalid injection receipt reference');
  }
  const records = (await listRecallJsonlRecords(userId, 'injection-receipts', 'events', 0))
    .map((record) => asInjectionReceipt(userId, record));
  return records.filter((record) => !taskRunId || record.taskRunId === taskRunId);
}

/** 画像通道统一落账（2026-09-30 修2）：每条都留 InjectionReceipt（channel=
 *  profile_memory，无投影授权语义），其中**正式资产镜像**（id 非 onto-
 *  前缀——onto-<sha> 全仓只有 ontologyAssetFromEntry 一处生成，正式资产
 *  系统侧恒为 aa-<sha>）再按「带入即计一次使用」写 usage-records，对齐
 *  投影注入 / Commander 派发 / 模型自取的记账口径。
 *  2026-09-13「画像不是资产、不写 usage」的口径成立于画像块还渲染
 *  USER/MEMORY 文件的年代；通道显式化后画像渲染的已是过闸门的正式资产，
 *  不记账则个人偏好每轮真实生效、用量永远为零、成熟度证据链断。 */
export async function recordProfileMemoryInjection(
  userId: string,
  entries: ReadonlyArray<{ id: string; source: string; version: string }>,
  context: { taskRunId: string; messageId?: string },
): Promise<void> {
  const { recordRecallUsage } = await import('./usage-service');
  for (const entry of entries) {
    await recordInjectionReceipt(userId, {
      assetId: entry.id,
      assetVersion: entry.version,
      taskRunId: context.taskRunId,
      ...(context.messageId ? { messageId: context.messageId } : {}),
      boundary: 'real',
      status: 'injected',
      channel: 'profile_memory',
    });
    if (!entry.id.startsWith('onto-')) {
      await recordRecallUsage(userId, {
        assetId: entry.id,
        assetVersion: entry.version,
        taskRunId: context.taskRunId,
        ...(context.messageId ? { messageId: context.messageId } : {}),
        boundary: 'real',
        outcome: 'injected',
      });
    }
  }
}

/** Exact host-side lookup. Receipt ids are validated before the JSONL stream
 * is touched so callers cannot turn a lookup into a path/reference probe. */
export async function readInjectionReceipt(userId: string, receiptId: string): Promise<InjectionReceipt | undefined> {
  if (!safeId(userId) || !safeId(receiptId)) throw new Error('invalid injection receipt reference');
  return (await listInjectionReceipts(userId)).find((record) => record.id === receiptId);
}
