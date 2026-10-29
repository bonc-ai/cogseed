import { createHash } from 'node:crypto';

import { appendRecallJsonlRecord, listRecallJsonlRecords } from './store';
import type { RecallJsonRecord } from './types';
import { safeId } from '../../storage';
import { validDispatchBinding, type DispatchBinding } from './execution-result-content';

export interface InjectionReceipt extends RecallJsonRecord {
  schemaVersion: 1;
  taskRunId: string;
  projectionId?: string;
  assetId: string;
  assetVersion: string;
  boundary: 'real' | 'degraded' | 'test-double';
  status: 'injected' | 'dispatched' | 'omitted' | 'failed';
  /** 注入通道：projection 为投影授权资产；profile_memory 为个人背景记忆，
   * 不表达投影授权；agent_read 为模型主动读取资产；catalog_hint 为目录相关提示
   * 但本轮未取用；experience 为经验目录准入遗漏（assetId 存 exp-* id，reason 存规则码）。
   * 模型主动读入上下文计为真实带入。旧回执未指定通道时按 projection 读取。 */
  /** runtime binds a supplied body to its host task/result anchor, not a UI message. */
  channel?: 'projection' | 'profile_memory' | 'agent_read' | 'catalog_hint' | 'experience' | 'runtime';
  messageId?: string;
  /** Host coordinates for a supplied delegated turn; never a source grant. */
  dispatchBinding?: DispatchBinding;
  /** 被拦原因：status='omitted' 时带上
   *  `formal-assets/runtime.ts::assetRuntimeBlockRule` 的稳定规则标识，界面据此
   *  说明"本轮未带入 + 哪条规则"。只存标识——不存原因码原文、不存资产正文。
   *  旧回执没有该字段，读取侧按「原因未知」呈现，不编造。 */
  reason?: string;
  /** 「为什么排前」因子拆解：
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
const INJECTION_CHANNELS = new Set<InjectionReceipt['channel']>(['projection', 'profile_memory', 'agent_read', 'catalog_hint', 'experience', 'runtime']);
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
    || (value.dispatchBinding !== undefined && !validDispatchBinding(value.dispatchBinding, String(value.taskRunId)))
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
    dispatchBinding?: DispatchBinding;
    /** 被拦原因标识（status='omitted' 时用）：规则标识，不是原因码原文。 */
    reason?: string;
    /** 「为什么排前」拆解：因子名 + 数值；不进幂等键。 */
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
    || (input.dispatchBinding !== undefined && (!validDispatchBinding(input.dispatchBinding, input.taskRunId) || input.status !== 'dispatched'))
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
    ...(input.dispatchBinding ? { dispatchBinding: input.dispatchBinding } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.ranking ? { ranking: input.ranking } : {}),
    createdAt: new Date().toISOString(),
  };
  const existing = await findExistingReceiptById(userId, record.id);
  if (existing) return existing;
  await appendRecallJsonlRecord(userId, 'injection-receipts', 'events', record);
  noteReceiptIdIndexed(userId, record.id);
  return record;
}

/** 回执 id 的进程内索引：一轮 K 条注入此前要做 K 次全流读幂等检查，
 *  现在只有进程内首次（建索引）付一次全读，之后 O(1) 判存在；本模块是这条
 *  append-only 流的唯一写入方，append 后同步登记即可保持索引准确。purge
 *  清空流后旧 id 仍留在索引里——方向是 fail-closed（拒绝重写已删除的回执），
 *  可接受。极端量级设熔断：超限丢弃索引，下一次调用重建（多付一次全读）。 */
const RECEIPT_ID_INDEX_LIMIT = 100_000;
const receiptIdIndex = new Map<string, { ids: Set<string>; loading?: Promise<InjectionReceipt[]> }>();

export function resetInjectionReceiptIdIndexForTest(): void {
  receiptIdIndex.clear();
}

async function findExistingReceiptById(userId: string, receiptId: string): Promise<InjectionReceipt | undefined> {
  let entry = receiptIdIndex.get(userId);
  if (!entry) {
    // 首次：一次全读同时建索引并完成本次查找（并发调用共享同一次读）。
    entry = { ids: new Set() };
    receiptIdIndex.set(userId, entry);
    const bootstrap = listInjectionReceipts(userId).then((records) => {
      for (const record of records) entry!.ids.add(record.id);
      return records;
    });
    entry.loading = bootstrap.finally(() => { entry!.loading = undefined; });
    const records = await bootstrap;
    return records.find((item) => item.id === receiptId);
  }
  if (entry.loading) {
    const records = await entry.loading;
    return records.find((item) => item.id === receiptId);
  }
  if (!entry.ids.has(receiptId)) return undefined;
  // 索引命中（同轮重试等罕见路径）：按需从流里取回完整记录，保持返回契约。
  return (await listInjectionReceipts(userId)).find((item) => item.id === receiptId);
}

function noteReceiptIdIndexed(userId: string, receiptId: string): void {
  const entry = receiptIdIndex.get(userId);
  if (!entry) return;
  if (entry.ids.size >= RECEIPT_ID_INDEX_LIMIT) entry.ids.clear();
  entry.ids.add(receiptId);
}

export async function listInjectionReceipts(userId: string, taskRunId?: string): Promise<InjectionReceipt[]> {
  if (!safeId(userId) || (taskRunId !== undefined && !safeId(taskRunId))) {
    throw new Error('invalid injection receipt reference');
  }
  const records = (await listRecallJsonlRecords(userId, 'injection-receipts', 'events', 0))
    .map((record) => asInjectionReceipt(userId, record));
  return records.filter((record) => !taskRunId || record.taskRunId === taskRunId);
}

/** 个人背景通道每项均写 profile_memory 注入回执，不表达投影授权。
 * 正式资产镜像同时写 usage-records，保持带入统计与投影、派发和主动读取一致；
 * onto-* 兼容镜像没有正式资产身份，不写正式资产使用记录。 */
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
