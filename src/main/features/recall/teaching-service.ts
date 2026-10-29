import { getRecallCandidateCapabilities } from './candidate-capabilities';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { safeId } from '../../storage';
import { createLogger } from '../../logger';
import {
  readRecallCandidate,
  rejectRecallCandidate,
} from './candidate-service';
import { removeCognitionSource } from './source-control';
import { recallJsonRecordPath } from './paths';
import { updateRecallJsonRecord, readRecallJsonRecord } from './store';
import type { RecallJsonRecord } from './types';

const TEACHING_COLLECTION = 'teaching-signals';
const log = createLogger('recall.teaching');

export type UserTeachingIntent = 'remember' | 'prefer' | 'avoid' | 'correct';
export type UserTeachingScope = 'personal' | 'project' | 'agent';
export type UserTeachingStatus = 'active' | 'revoked';

export interface UserTeachingSignalRecord extends RecallJsonRecord {
  taxonomyVersion: 2;
  conversationId: string;
  messageId: string;
  intent: UserTeachingIntent;
  scope: UserTeachingScope;
  status: UserTeachingStatus;
  summary: string;
  memoryRef?: string;
  candidateIds: string[];
  createdAt: string;
  revokedAt?: string;
}

function teachingDirectory(userId: string): string {
  return path.dirname(recallJsonRecordPath(userId, TEACHING_COLLECTION, 'placeholder'));
}

function compact(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`invalid teaching ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max) throw new Error(`invalid teaching ${field}`);
  return text;
}

function requireSafeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid teaching ${field}`);
  return value;
}

function requireIntent(value: unknown): UserTeachingIntent {
  if (value === 'remember' || value === 'prefer' || value === 'avoid' || value === 'correct') return value;
  throw new Error('invalid teaching intent');
}

function requireScope(value: unknown): UserTeachingScope {
  if (value === 'personal' || value === 'project' || value === 'agent') return value;
  throw new Error('invalid teaching scope');
}

function requireStatus(value: unknown): UserTeachingStatus {
  if (value === 'active' || value === 'revoked') return value;
  throw new Error('invalid teaching status');
}

function asTeachingSignal(value: RecallJsonRecord): UserTeachingSignalRecord {
  const conversationId = requireSafeId(value.conversationId, 'conversation id');
  const messageId = requireSafeId(value.messageId, 'message id');
  const intent = requireIntent(value.intent);
  const scope = requireScope(value.scope);
  const status = requireStatus(value.status);
  const summary = compact(value.summary, 'summary', 240);
  if (
    !Array.isArray(value.candidateIds)
    || value.candidateIds.some((id) => typeof id !== 'string' || !safeId(id))
    || typeof value.createdAt !== 'string'
    || (value.memoryRef !== undefined && (typeof value.memoryRef !== 'string' || !safeId(value.memoryRef)))
    || (value.revokedAt !== undefined && typeof value.revokedAt !== 'string')
  ) throw new Error('malformed teaching signal');
  return {
    ...value,
    taxonomyVersion: 2,
    conversationId,
    messageId,
    intent,
    scope,
    status,
    summary,
    candidateIds: [...new Set(value.candidateIds as string[])],
  } as UserTeachingSignalRecord;
}

export async function readUserTeachingSignal(userId: string, signalId: string): Promise<UserTeachingSignalRecord> {
  if (!safeId(signalId)) throw new Error('invalid teaching signal id');
  const record = await readRecallJsonRecord(userId, TEACHING_COLLECTION, signalId);
  if (!record) throw new Error('teaching signal not found');
  return asTeachingSignal(record);
}

export interface ListUserTeachingSignalsQuery {
  conversationId?: string;
  status?: UserTeachingStatus;
  limit?: number;
}

export interface UserTeachingSignalPage {
  items: UserTeachingSignalRecord[];
  /** 满足查询条件的**真实**条数，不受 limit 影响。
   *
   *  「待我处理」的「教学回执」指标此前取的是 `list(...).length`，而 list 的
   *  limit 默认 20、上限 100——超过 20 条时那个数字就是错的，且错得不可见。
   *  计数必须来自截断之前。 */
  total: number;
}

/** 读 + 过滤 + 排序，**不截断**。两个出口共用，避免 total 与 items 走两套过滤
 *  条件——那样 total 会和列表对不上，比没有 total 更难查。 */
async function readSortedTeachingSignals(
  userId: string,
  query: ListUserTeachingSignalsQuery,
): Promise<UserTeachingSignalRecord[]> {
  const conversationId = query.conversationId === undefined
    ? undefined
    : requireSafeId(query.conversationId, 'conversation id');
  const status = query.status === undefined ? undefined : requireStatus(query.status);
  let names: string[];
  try {
    names = await fs.readdir(teachingDirectory(userId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  // 逐条降级，而不是让一条坏记录把整份教学回执列表读失败（照抄 listExperiences
  // 的既有口径）：记录形状的不变量分布在 store 的 validateRecallRecord 和这里的
  // asTeachingSignal 两层，任一层一抛，`recall.teaching.list` 就整体失败，好记录
  // 也列不出。只降级记录形状的错；真正的 IO 故障（带 errno code）照旧上抛——
  // 静默少几条等于把磁盘问题伪装成「教学信号变少了」。
  const reads = await Promise.all(names
    .filter((name) => name.endsWith('.json') && safeId(name.slice(0, -5)))
    .map(async (name) => {
      const id = name.slice(0, -5);
      try {
        return { id, record: await readRecallJsonRecord(userId, TEACHING_COLLECTION, id) };
      } catch (error) {
        if (typeof (error as NodeJS.ErrnoException).code === 'string') throw error;
        return { id, error: error as Error };
      }
    }));
  const signals: UserTeachingSignalRecord[] = [];
  for (const read of reads) {
    if (read.error) {
      log.warn('skipped an unreadable teaching signal', { teachingId: read.id, error: read.error.message });
      continue;
    }
    if (!read.record) continue;
    try {
      signals.push(asTeachingSignal(read.record));
    } catch (error) {
      log.warn('skipped a malformed teaching signal', { teachingId: read.id, error: (error as Error).message });
    }
  }
  return signals
    .filter((signal) => !conversationId || signal.conversationId === conversationId)
    .filter((signal) => !status || signal.status === status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function listUserTeachingSignals(
  userId: string,
  query: ListUserTeachingSignalsQuery = {},
): Promise<UserTeachingSignalRecord[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  return (await readSortedTeachingSignals(userId, query)).slice(0, limit);
}

/** 同一批数据的分页读口：`items` 受 limit 截断，`total` 不受。 */
export async function listUserTeachingSignalPage(
  userId: string,
  query: ListUserTeachingSignalsQuery = {},
): Promise<UserTeachingSignalPage> {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 20)));
  const all = await readSortedTeachingSignals(userId, query);
  return { items: all.slice(0, limit), total: all.length };
}

export async function revokeUserTeachingSignal(userId: string, signalId: string): Promise<UserTeachingSignalRecord> {
  if (!safeId(signalId)) throw new Error('invalid teaching signal id');
  const updated = asTeachingSignal(await updateRecallJsonRecord(userId, TEACHING_COLLECTION, signalId, (raw) => {
    if (!raw) throw new Error('teaching signal not found');
    const current = asTeachingSignal(raw);
    if (current.status === 'revoked') return current;
    return {
      ...current,
      status: 'revoked',
      revokedAt: new Date().toISOString(),
    };
  }));
  await Promise.all(updated.candidateIds.map(async (candidateId) => {
    try {
      const candidate = await readRecallCandidate(userId, candidateId);
      // 教学信号被撤回时，凡是用户还能拒绝的候选都一并拒绝——判据取 capability，
      // 否则 weak_observation 候选会被留在池子里，来源却已经没了。
      if (getRecallCandidateCapabilities(candidate).canReject) {
        await rejectRecallCandidate(userId, candidateId, 'teaching_signal_revoked');
      }
    } catch {
      // Revocation remains authoritative even if a legacy candidate is missing.
    }
  }));
  await removeCognitionSource(userId, {
    kind: 'user_teaching_signal',
    id: updated.id,
    taxonomyVersion: 2,
    subtype: 'teaching',
    scope: updated.scope,
    title: updated.summary,
  }, false);
  return updated;
}
